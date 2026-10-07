import { JobInput, ScheduleResult } from "./types";
import { SchedError } from "./errors";

export const VERIFY_MAX_TIME = 1000000;

/**
 * 独立核验：逐时间单位模拟 SRTF，与事件驱动结果对照；
 * 并检查每作业执行总长等于需求、片段不重叠、等待非负。
 * 仅用于小规模输入（总时刻数不超过 VERIFY_MAX_TIME）。
 */
export function verifySchedule(jobs: JobInput[], result: ScheduleResult): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const totalBurst = jobs.reduce((s, j) => s + j.burst, 0);
  const maxArrival = Math.max(...jobs.map((j) => j.arrival));
  if (maxArrival + totalBurst > VERIFY_MAX_TIME) {
    throw new SchedError("E_OVERFLOW", `核验仅支持总时刻数 <= ${VERIFY_MAX_TIME} 的小规模输入`);
  }

  const remaining = new Map(jobs.map((j) => [j.id, j.burst]));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const expected: (string | null)[] = [];
  let done = 0;
  let t = 0;
  while (done < jobs.length) {
    let best: string | null = null;
    for (const j of jobs) {
      if (j.arrival > t || remaining.get(j.id)! === 0) continue;
      if (
        best === null ||
        remaining.get(j.id)! < remaining.get(best)! ||
        (remaining.get(j.id)! === remaining.get(best)! &&
          (j.arrival < byId.get(best)!.arrival ||
            (j.arrival === byId.get(best)!.arrival && j.id < best)))
      ) {
        best = j.id;
      }
    }
    if (best === null) {
      expected.push(null);
      t++;
      continue;
    }
    expected.push(best);
    remaining.set(best, remaining.get(best)! - 1);
    if (remaining.get(best) === 0) done++;
    t++;
  }

  const actual: (string | null)[] = [];
  let prevEnd = 0;
  for (const seg of result.segments) {
    if (seg.start < prevEnd) problems.push(`片段重叠: [${seg.start}, ${seg.end}) 与前一片段终点 ${prevEnd}`);
    if (seg.end <= seg.start) problems.push(`非法片段: [${seg.start}, ${seg.end})`);
    for (let i = prevEnd; i < seg.start; i++) actual.push(null);
    for (let i = seg.start; i < seg.end; i++) actual.push(seg.jobId);
    prevEnd = seg.end;
  }
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = i < expected.length ? expected[i] : null;
    const a = i < actual.length ? actual[i] : null;
    if (e !== a) {
      problems.push(`时刻 ${i} 不一致：逐单位模拟=${e ?? "空闲"}，事件驱动=${a ?? "空闲"}`);
      if (problems.length > 20) return { ok: false, problems };
    }
  }

  const executed = new Map<string, number>();
  for (const seg of result.segments) {
    if (seg.jobId === null) continue;
    executed.set(seg.jobId, (executed.get(seg.jobId) ?? 0) + (seg.end - seg.start));
  }
  for (const j of jobs) {
    const got = executed.get(j.id) ?? 0;
    if (got !== j.burst) problems.push(`作业 ${j.id} 执行总长 ${got} != 需求 ${j.burst}`);
  }

  for (const s of result.stats) {
    if (s.waiting < 0) problems.push(`作业 ${s.id} 等待时间为负: ${s.waiting}`);
    if (s.turnaround !== s.completion - s.arrival) problems.push(`作业 ${s.id} 周转时间口径错误`);
    if (s.waiting !== s.turnaround - s.burst) problems.push(`作业 ${s.id} 等待时间口径错误`);
    if (s.response !== s.firstStart - s.arrival) problems.push(`作业 ${s.id} 响应时间口径错误`);
  }

  return { ok: problems.length === 0, problems };
}
