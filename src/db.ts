import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { JobInput, ScheduleResult } from "./types";
import { SchedError } from "./errors";

export interface JobsetRow {
  id: number;
  name: string;
  rules_version: string;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobsets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        jobset_id INTEGER NOT NULL REFERENCES jobsets(id),
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        arrival INTEGER NOT NULL,
        burst INTEGER NOT NULL,
        PRIMARY KEY (jobset_id, seq)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jobset_id INTEGER NOT NULL REFERENCES jobsets(id),
        rules_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS segments (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        job_id TEXT,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS reports (
        run_id INTEGER PRIMARY KEY REFERENCES runs(id),
        json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  static fingerprint(jobs: JobInput[], rulesVersion: string): string {
    // 与输入顺序无关：排序后哈希，保证打乱输入得到同一冻结结果
    const norm = [...jobs]
      .map((j) => `${j.id}:${j.arrival}:${j.burst}`)
      .sort()
      .join("|");
    return createHash("sha256").update(`${rulesVersion}\n${norm}`).digest("hex");
  }

  /** 导入作业集；内容完全相同的集合复用已有记录 */
  importJobset(name: string, jobs: JobInput[], rulesVersion: string): { jobsetId: number; reused: boolean } {
    const fp = Store.fingerprint(jobs, rulesVersion);
    const existing = this.db
      .prepare("SELECT id FROM jobsets WHERE fingerprint = ? AND rules_version = ?")
      .get(fp, rulesVersion) as { id: number } | undefined;
    if (existing) return { jobsetId: existing.id, reused: true };
    this.db.exec("BEGIN");
    try {
      const info = this.db
        .prepare("INSERT INTO jobsets (name, rules_version, fingerprint, created_at) VALUES (?, ?, ?, ?)")
        .run(name, rulesVersion, fp, new Date().toISOString());
      const jobsetId = Number(info.lastInsertRowid);
      const stmt = this.db.prepare("INSERT INTO jobs (jobset_id, seq, id, arrival, burst) VALUES (?, ?, ?, ?, ?)");
      jobs.forEach((j, i) => stmt.run(jobsetId, i, j.id, j.arrival, j.burst));
      this.db.exec("COMMIT");
      return { jobsetId, reused: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getJobset(jobsetId: number): { jobset: JobsetRow; jobs: JobInput[] } {
    const jobset = this.db.prepare("SELECT * FROM jobsets WHERE id = ?").get(jobsetId) as JobsetRow | undefined;
    if (!jobset) throw new SchedError("E_JOBSET_NOT_FOUND", `作业集不存在: ${jobsetId}`);
    const jobs = this.db
      .prepare("SELECT id, arrival, burst FROM jobs WHERE jobset_id = ? ORDER BY seq")
      .all(jobsetId) as unknown as JobInput[];
    return { jobset, jobs };
  }

  listJobsets(): JobsetRow[] {
    return this.db.prepare("SELECT * FROM jobsets ORDER BY id").all() as unknown as JobsetRow[];
  }

  /** 执行调度；同一作业集+规则版本重复请求返回同一冻结结果 */
  runSchedule(jobsetId: number, scheduleFn: (jobs: JobInput[]) => ScheduleResult): { runId: number; result: ScheduleResult; frozen: boolean } {
    const { jobset, jobs } = this.getJobset(jobsetId);
    const fp = Store.fingerprint(jobs, jobset.rules_version);
    const existing = this.db.prepare("SELECT id FROM runs WHERE fingerprint = ?").get(fp) as { id: number } | undefined;
    if (existing) {
      return { runId: existing.id, result: this.loadReport(existing.id), frozen: true };
    }
    const result = scheduleFn(jobs);
    this.db.exec("BEGIN");
    try {
      const info = this.db
        .prepare("INSERT INTO runs (jobset_id, rules_version, fingerprint, created_at) VALUES (?, ?, ?, ?)")
        .run(jobsetId, result.rulesVersion, fp, new Date().toISOString());
      const runId = Number(info.lastInsertRowid);
      const segStmt = this.db.prepare("INSERT INTO segments (run_id, seq, job_id, start, end) VALUES (?, ?, ?, ?, ?)");
      result.segments.forEach((s, i) => segStmt.run(runId, i, s.jobId, s.start, s.end));
      const evStmt = this.db.prepare("INSERT INTO events (run_id, seq, json) VALUES (?, ?, ?)");
      result.events.forEach((e, i) => evStmt.run(runId, i, JSON.stringify(e)));
      this.db
        .prepare("INSERT INTO reports (run_id, json) VALUES (?, ?)")
        .run(runId, JSON.stringify({ stats: result.stats, makespan: result.makespan, rulesVersion: result.rulesVersion }));
      this.db.exec("COMMIT");
      return { runId, result, frozen: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private ensureRun(runId: number): void {
    const r = this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
    if (!r) throw new SchedError("E_RUN_NOT_FOUND", `运行不存在: ${runId}`);
  }

  loadSegments(runId: number): { jobId: string | null; start: number; end: number }[] {
    this.ensureRun(runId);
    const rows = this.db
      .prepare("SELECT job_id AS jobId, start, end FROM segments WHERE run_id = ? ORDER BY seq")
      .all(runId) as unknown as { jobId: string | null; start: number; end: number }[];
    return rows;
  }

  loadEvents(runId: number): unknown[] {
    this.ensureRun(runId);
    const rows = this.db.prepare("SELECT json FROM events WHERE run_id = ? ORDER BY seq").all(runId) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json));
  }

  loadReport(runId: number): ScheduleResult {
    this.ensureRun(runId);
    const rep = this.db.prepare("SELECT json FROM reports WHERE run_id = ?").get(runId) as { json: string } | undefined;
    if (!rep) throw new SchedError("E_RUN_NOT_FOUND", `运行报告不存在: ${runId}`);
    const parsed = JSON.parse(rep.json) as { stats: ScheduleResult["stats"]; makespan: number; rulesVersion: string };
    return {
      rulesVersion: parsed.rulesVersion,
      segments: this.loadSegments(runId),
      events: this.loadEvents(runId) as ScheduleResult["events"],
      stats: parsed.stats,
      makespan: parsed.makespan,
    };
  }

  listRuns(): unknown[] {
    return this.db.prepare("SELECT id, jobset_id AS jobsetId, rules_version AS rulesVersion, created_at AS createdAt FROM runs ORDER BY id").all();
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "srtf.db");
}
