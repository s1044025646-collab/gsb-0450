import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { RULES_VERSION, validateJobs, type JobInput } from './validate.js';
import { schedule, type ScheduleResult, type Segment } from './scheduler.js';
import { ERR, SchedError } from './errors.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'srtf.db');

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) {
    mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobsets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        rules_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        jobset_id INTEGER NOT NULL REFERENCES jobsets(id),
        job_id TEXT NOT NULL,
        arrival INTEGER NOT NULL,
        burst INTEGER NOT NULL,
        input_order INTEGER NOT NULL,
        PRIMARY KEY (jobset_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jobset_id INTEGER NOT NULL REFERENCES jobsets(id),
        rules_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        makespan INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (jobset_id, rules_version, content_hash)
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
        time INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS stats (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        job_id TEXT NOT NULL,
        arrival INTEGER NOT NULL,
        burst INTEGER NOT NULL,
        first_start INTEGER NOT NULL,
        completion INTEGER NOT NULL,
        turnaround INTEGER NOT NULL,
        waiting INTEGER NOT NULL,
        response INTEGER NOT NULL,
        PRIMARY KEY (run_id, job_id)
      );
    `);
  }
  return db;
}

function hashJobs(jobs: JobInput[]): string {
  const norm = [...jobs]
    .map((j) => `${j.id}:${j.arrival}:${j.burst}`)
    .sort()
    .join('|');
  return createHash('sha256').update(norm).digest('hex');
}

export function createJobset(name: string, rawJobs: unknown): { jobsetId: number; jobs: JobInput[] } {
  const jobs = validateJobs(rawJobs); // 校验失败时不会写任何数据
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = d
      .prepare('INSERT INTO jobsets (name, rules_version, created_at) VALUES (?, ?, ?)')
      .run(name, RULES_VERSION, new Date().toISOString());
    const jobsetId = Number(r.lastInsertRowid);
    const stmt = d.prepare(
      'INSERT INTO jobs (jobset_id, job_id, arrival, burst, input_order) VALUES (?, ?, ?, ?, ?)',
    );
    jobs.forEach((j, i) => stmt.run(jobsetId, j.id, j.arrival, j.burst, i));
    d.exec('COMMIT');
    return { jobsetId, jobs };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function getJobset(jobsetId: number) {
  const d = getDb();
  const js = d.prepare('SELECT * FROM jobsets WHERE id = ?').get(jobsetId) as
    | { id: number; name: string; rules_version: string; created_at: string }
    | undefined;
  if (!js) throw new SchedError(ERR.NOT_FOUND, `作业集不存在: ${jobsetId}`);
  const jobs = d
    .prepare('SELECT job_id AS id, arrival, burst FROM jobs WHERE jobset_id = ? ORDER BY input_order')
    .all(jobsetId) as unknown as JobInput[];
  return { ...js, jobs };
}

export function listJobsets() {
  return getDb()
    .prepare(
      `SELECT j.id, j.name, j.rules_version, j.created_at, COUNT(jb.job_id) AS job_count
       FROM jobsets j LEFT JOIN jobs jb ON jb.jobset_id = j.id
       GROUP BY j.id ORDER BY j.id`,
    )
    .all();
}

export function runSchedule(jobsetId: number): { runId: number; reused: boolean; result: ScheduleResult } {
  const { jobs } = getJobset(jobsetId);
  const d = getDb();
  const hash = hashJobs(jobs);
  // 相同输入 + 相同规则版本 => 返回同一冻结结果
  const existing = d
    .prepare('SELECT id FROM runs WHERE jobset_id = ? AND rules_version = ? AND content_hash = ?')
    .get(jobsetId, RULES_VERSION, hash) as { id: number } | undefined;
  if (existing) {
    return { runId: existing.id, reused: true, result: loadResult(existing.id) };
  }
  const result = schedule(jobs);
  d.exec('BEGIN');
  try {
    const r = d
      .prepare(
        'INSERT INTO runs (jobset_id, rules_version, content_hash, makespan, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(jobsetId, RULES_VERSION, hash, result.makespan, new Date().toISOString());
    const runId = Number(r.lastInsertRowid);
    const segStmt = d.prepare('INSERT INTO segments (run_id, seq, job_id, start, end) VALUES (?, ?, ?, ?, ?)');
    result.segments.forEach((s, i) => segStmt.run(runId, i, s.jobId, s.start, s.end));
    const evStmt = d.prepare('INSERT INTO events (run_id, seq, time, json) VALUES (?, ?, ?, ?)');
    for (const e of result.events) evStmt.run(runId, e.seq, e.time, JSON.stringify(e));
    const stStmt = d.prepare(
      `INSERT INTO stats (run_id, job_id, arrival, burst, first_start, completion, turnaround, waiting, response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of result.stats) {
      stStmt.run(runId, s.id, s.arrival, s.burst, s.firstStart, s.completion, s.turnaround, s.waiting, s.response);
    }
    d.exec('COMMIT');
    return { runId, reused: false, result };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function loadResult(runId: number): ScheduleResult {
  const d = getDb();
  const segments = d
    .prepare('SELECT job_id AS jobId, start, end FROM segments WHERE run_id = ? ORDER BY seq')
    .all(runId) as unknown as Segment[];
  const events = (d
    .prepare('SELECT json FROM events WHERE run_id = ? ORDER BY seq')
    .all(runId) as unknown as { json: string }[]).map((r) => JSON.parse(r.json));
  const stats = d
    .prepare(
      `SELECT job_id AS id, arrival, burst, first_start AS firstStart, completion,
              turnaround, waiting, response
       FROM stats WHERE run_id = ? ORDER BY job_id`,
    )
    .all(runId) as unknown as ScheduleResult['stats'];
  const run = d.prepare('SELECT makespan FROM runs WHERE id = ?').get(runId) as { makespan: number };
  return { segments, events, stats, makespan: run.makespan };
}

export function getRun(runId: number) {
  const d = getDb();
  const run = d.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
    | { id: number; jobset_id: number; rules_version: string; makespan: number; created_at: string }
    | undefined;
  if (!run) throw new SchedError(ERR.NOT_FOUND, `运行不存在: ${runId}`);
  return { run, result: loadResult(runId) };
}

export function runnerAt(runId: number, t: number): { jobId: string | null; start: number; end: number } | null {
  const { result } = getRun(runId);
  if (!Number.isSafeInteger(t) || t < 0) {
    throw new SchedError(ERR.NEGATIVE_TIME, '查询时刻必须是非负安全整数', { t });
  }
  if (t >= result.makespan) return null; // 最后完成之后无运行者
  // 左闭右开
  const seg = result.segments.find((s) => s.start <= t && t < s.end);
  return seg ? { jobId: seg.jobId, start: seg.start, end: seg.end } : null;
}

export function jobTimeline(runId: number, jobId: string) {
  const { result } = getRun(runId);
  const stat = result.stats.find((s) => s.id === jobId);
  if (!stat) throw new SchedError(ERR.NOT_FOUND, `作业不存在于该运行: ${jobId}`);
  const segments = result.segments.filter((s) => s.jobId === jobId);
  return { stat, segments };
}
