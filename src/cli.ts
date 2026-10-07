import { readFileSync } from 'node:fs';
import {
  createJobset,
  getJobset,
  listJobsets,
  runSchedule,
  getRun,
  runnerAt,
  jobTimeline,
} from './db.js';
import { SchedError } from './errors.js';
import type { ScheduleResult } from './scheduler.js';

function printSegments(result: ScheduleResult) {
  console.log('执行片段（左闭右开）:');
  for (const s of result.segments) {
    console.log(`  ${s.jobId ?? '空闲'}: [${s.start}, ${s.end})`);
  }
}

function printStats(result: ScheduleResult) {
  console.log('统计:');
  console.log('  作业  到达  需求  首开始  完成  周转  等待  响应');
  for (const s of result.stats) {
    console.log(
      `  ${s.id.padEnd(4)} ${String(s.arrival).padStart(4)} ${String(s.burst).padStart(4)} ${String(
        s.firstStart,
      ).padStart(6)} ${String(s.completion).padStart(4)} ${String(s.turnaround).padStart(4)} ${String(
        s.waiting,
      ).padStart(4)} ${String(s.response).padStart(4)}`,
    );
  }
  console.log(`  完成时刻(makespan): ${result.makespan}`);
}

function usage() {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
  import <jobs.json> [名称]   导入作业集（JSON: [{id,arrival,burst}, ...]）
  list                        列出作业集
  preview <jobsetId>          预览输入（保留原输入顺序）
  run <jobsetId>              执行完整调度（相同输入返回冻结结果）
  summary <runId>             查看片段与统计
  events <runId>              导出调度事件
  at <runId> <t>              查询时刻 t 的运行者（左闭右开）
  job <runId> <jobId>         查看单作业经历
  demo                        运行内置样例 A/B/C`);
}

const DEMO_JOBS = [
  { id: 'A', arrival: 0, burst: 8 },
  { id: 'B', arrival: 1, burst: 4 },
  { id: 'C', arrival: 2, burst: 2 },
];

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'import': {
      const jobs = JSON.parse(readFileSync(args[0], 'utf8'));
      const r = createJobset(args[1] ?? '', jobs);
      console.log(`已导入作业集 #${r.jobsetId}，共 ${r.jobs.length} 个作业`);
      break;
    }
    case 'list':
      console.log(JSON.stringify(listJobsets(), null, 2));
      break;
    case 'preview': {
      const js = getJobset(Number(args[0]));
      console.log(`作业集 #${js.id} (${js.name || '未命名'}) 规则版本 ${js.rules_version}`);
      js.jobs.forEach((j, i) => console.log(`  [${i}] ${j.id} 到达=${j.arrival} 需求=${j.burst}`));
      break;
    }
    case 'run': {
      const { runId, reused, result } = runSchedule(Number(args[0]));
      console.log(`运行 #${runId}${reused ? '（复用冻结结果）' : ''}`);
      printSegments(result);
      printStats(result);
      break;
    }
    case 'summary': {
      const { result } = getRun(Number(args[0]));
      printSegments(result);
      printStats(result);
      break;
    }
    case 'events': {
      const { result } = getRun(Number(args[0]));
      console.log(JSON.stringify(result.events, null, 2));
      break;
    }
    case 'at': {
      const r = runnerAt(Number(args[0]), Number(args[1]));
      console.log(r ? `时刻 ${args[1]}: ${r.jobId ?? '空闲'} [${r.start}, ${r.end})` : `时刻 ${args[1]}: 无运行者`);
      break;
    }
    case 'job': {
      const { stat, segments } = jobTimeline(Number(args[0]), args[1]);
      console.log(JSON.stringify({ stat, segments }, null, 2));
      break;
    }
    case 'demo': {
      const { jobsetId } = createJobset('demo', DEMO_JOBS);
      const { runId, result } = runSchedule(jobsetId);
      console.log(`演示作业集 #${jobsetId} 运行 #${runId}`);
      printSegments(result);
      printStats(result);
      break;
    }
    default:
      usage();
  }
}

try {
  main();
} catch (e) {
  if (e instanceof SchedError) {
    console.error(`错误 [${e.code}] ${e.message}`);
    process.exit(2);
  }
  throw e;
}
