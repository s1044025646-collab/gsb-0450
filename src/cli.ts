import { readFileSync } from "node:fs";
import { Store, defaultDbPath } from "./db";
import { schedule, runnerAt } from "./scheduler";
import { validateJobs, parseTimeParam } from "./validate";
import { verifySchedule } from "./verify";
import { startServer } from "./server";
import { toErrorPayload, SchedError } from "./errors";
import { JobInput, RULES_VERSION } from "./types";

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - displayWidth(s)));
}

function printTable(headers: string[], rows: (string | number)[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(String(r[i]))))
  );
  const line = (cells: (string | number)[]) => cells.map((c, i) => pad(String(c), widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

function parseJobsFile(file: string): unknown {
  const text = readFileSync(file, "utf8").trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return Array.isArray(parsed) ? parsed : parsed.jobs;
    } catch {
      throw new SchedError("E_BAD_JSON", `文件不是合法 JSON: ${file}`);
    }
  }
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return rows
    .filter((_, i) => !(i === 0 && /id/i.test(rows[0]) && /arrival|burst/i.test(rows[0])))
    .map((l) => {
      const [id, arrival, burst] = l.split(/[,\s]+/);
      return { id, arrival: Number(arrival), burst: Number(burst) };
    });
}

function printResult(result: ReturnType<typeof schedule>): void {
  console.log("\n执行片段（左闭右开，IDLE 表示空闲）:");
  printTable(
    ["作业", "开始", "结束"],
    result.segments.map((s) => [s.jobId ?? "IDLE", s.start, s.end])
  );
  console.log("\n统计:");
  printTable(
    ["作业", "到达", "需求", "首次开始", "完成", "周转", "等待", "响应"],
    result.stats.map((s) => [s.id, s.arrival, s.burst, s.firstStart, s.completion, s.turnaround, s.waiting, s.response])
  );
  console.log(`\nmakespan = ${result.makespan}`);
}

const DEMO_JOBS: JobInput[] = [
  { id: "A", arrival: 0, burst: 8 },
  { id: "B", arrival: 1, burst: 4 },
  { id: "C", arrival: 2, burst: 2 },
];

function usage(): void {
  console.log(`SRTF 调度后端 CLI
用法: node dist/cli.js <命令> [参数]
  serve [--port N]          启动 HTTP API（默认端口 0，自动选择空闲端口）
  import <file> [--name X]  导入作业集（JSON 数组/{jobs:[...]} 或 CSV: id,arrival,burst）
  list                      列出作业集与运行
  preview <jobsetId>        预览输入（保留原始顺序）
  run <jobsetId>            执行完整调度（重复请求返回冻结结果）
  report <runId>            查看汇总报告
  events <runId>            导出调度事件
  at <runId> <time>         查询指定时刻运行者（左闭右开）
  job <runId> <jobId>       查看单作业经历
  verify <runId>            逐时间单位独立核验
  demo                      运行内置样例 A(0,8) B(1,4) C(2,2) 并核验
环境变量: SRTF_DB 指定数据库路径（默认 ./data/srtf.db），PORT 指定服务端口`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    usage();
    return;
  }
  const store = new Store(process.env.SRTF_DB ?? defaultDbPath());
  try {
    switch (cmd) {
      case "serve": {
        const pi = args.indexOf("--port");
        const port = pi >= 0 ? parseTimeParam(args[pi + 1], "端口") : Number(process.env.PORT ?? 0);
        const actual = await startServer(store, port);
        console.log(`SRTF API 已启动: http://127.0.0.1:${actual}/api/health`);
        return;
      }
      case "import": {
        const file = args[1];
        if (!file) throw new SchedError("E_BAD_REQUEST", "缺少文件参数");
        const ni = args.indexOf("--name");
        const name = ni >= 0 ? args[ni + 1] : file;
        const jobs = validateJobs(parseJobsFile(file));
        const { jobsetId, reused } = store.importJobset(name, jobs, RULES_VERSION);
        console.log(JSON.stringify({ jobsetId, reused, jobCount: jobs.length }));
        break;
      }
      case "list": {
        console.log("作业集:", JSON.stringify(store.listJobsets(), null, 2));
        console.log("运行:", JSON.stringify(store.listRuns(), null, 2));
        break;
      }
      case "preview": {
        const { jobset, jobs } = store.getJobset(Number(args[1]));
        console.log(JSON.stringify({ jobset, jobs }, null, 2));
        break;
      }
      case "run": {
        const { runId, result, frozen } = store.runSchedule(Number(args[1]), schedule);
        console.log(`runId=${runId} frozen=${frozen}`);
        printResult(result);
        break;
      }
      case "report": {
        printResult(store.loadReport(Number(args[1])));
        break;
      }
      case "events": {
        console.log(JSON.stringify(store.loadEvents(Number(args[1])), null, 2));
        break;
      }
      case "at": {
        const segs = store.loadSegments(Number(args[1]));
        const time = parseTimeParam(args[2]);
        console.log(JSON.stringify({ time, runner: runnerAt(segs, time) }));
        break;
      }
      case "job": {
        const report = store.loadReport(Number(args[1]));
        const stat = report.stats.find((s) => s.id === args[2]);
        if (!stat) throw new SchedError("E_JOB_NOT_FOUND", `作业不存在: ${args[2]}`);
        const slices = report.segments.filter((s) => s.jobId === args[2]);
        console.log(JSON.stringify({ job: stat, slices }, null, 2));
        break;
      }
      case "verify": {
        const runId = Number(args[1]);
        const report = store.loadReport(runId);
        const runs = store.listRuns() as { id: number; jobsetId: number }[];
        const run = runs.find((r) => r.id === runId)!;
        const { jobs } = store.getJobset(run.jobsetId);
        const v = verifySchedule(jobs, report);
        console.log(v.ok ? "核验通过" : `核验失败:\n${v.problems.join("\n")}`);
        if (!v.ok) process.exitCode = 1;
        break;
      }
      case "demo": {
        console.log("样例: A(到达0,需求8) B(到达1,需求4) C(到达2,需求2)");
        const result = schedule(DEMO_JOBS);
        printResult(result);
        console.log("\n事件解释:");
        for (const e of result.events) {
          console.log(`  [t=${e.time}] ${e.kind}: ${e.reason}`);
        }
        const v = verifySchedule(DEMO_JOBS, result);
        console.log(v.ok ? "\n独立逐单位核验: 通过" : `\n核验失败: ${v.problems.join("; ")}`);
        break;
      }
      default:
        throw new SchedError("E_BAD_REQUEST", `未知命令: ${cmd}`);
    }
  } finally {
    if (args[0] !== "serve") store.close();
  }
}

main().catch((err) => {
  const payload = toErrorPayload(err);
  console.error(`错误 [${payload.code}] ${payload.message}`);
  process.exitCode = 1;
});
