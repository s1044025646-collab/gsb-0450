import type { JobInput } from './validate.js';
import type { Segment } from './scheduler.js';

/**
 * 独立的逐时间单位模拟，用于交叉核对事件驱动调度结果。
 * 每单位时间重新选择：剩余最小优先；平局时保留当前，再按到达时刻，再按 ID。
 */
export function simulatePerUnit(jobs: JobInput[]): { segments: Segment[]; completion: Map<string, number> } {
  const states = jobs.map((j) => ({ ...j, remaining: j.burst }));
  const completion = new Map<string, number>();
  const segments: Segment[] = [];
  const total = states.reduce((a, s) => a + s.burst, 0);
  const maxArrival = Math.max(...states.map((s) => s.arrival));
  const horizon = maxArrival + total;
  let current: string | null = null;
  for (let t = 0; t < horizon; t++) {
    if (states.every((s) => s.remaining === 0)) break;
    const readyJobs = states.filter((s) => s.arrival <= t && s.remaining > 0);
    let pick: string | null = null;
    if (readyJobs.length > 0) {
      const cur = readyJobs.find((s) => s.id === current);
      const minRem = Math.min(...readyJobs.map((s) => s.remaining));
      if (cur && cur.remaining === minRem) {
        pick = cur.id;
      } else {
        const cands = readyJobs
          .filter((s) => s.remaining === minRem)
          .sort((a, b) => a.arrival - b.arrival || (a.id < b.id ? -1 : 1));
        pick = cands[0].id;
      }
    }
    const last = segments[segments.length - 1];
    if (last && last.jobId === pick && last.end === t) {
      last.end = t + 1;
    } else {
      segments.push({ jobId: pick, start: t, end: t + 1 });
    }
    if (pick !== null) {
      const s = states.find((x) => x.id === pick)!;
      s.remaining -= 1;
      if (s.remaining === 0) completion.set(pick, t + 1);
    }
    current = pick;
  }
  return { segments, completion };
}
