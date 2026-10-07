import type { JobInput } from './validate.js';

export interface Segment {
  jobId: string | null; // null 表示空闲
  start: number;
  end: number;
}

export interface ReadyEntry {
  id: string;
  remaining: number;
  arrival: number;
}

export interface SchedEvent {
  seq: number;
  time: number;
  readyBefore: ReadyEntry[];
  arrivals: string[];
  completed: string[];
  selected: string | null;
  preempted: boolean;
  reason: string;
  readyAfter: ReadyEntry[];
}

export interface JobStats {
  id: string;
  arrival: number;
  burst: number;
  firstStart: number;
  completion: number;
  turnaround: number;
  waiting: number;
  response: number;
}

export interface ScheduleResult {
  segments: Segment[]; // 已合并相邻同作业片段
  events: SchedEvent[];
  stats: JobStats[];
  makespan: number;
}

interface RunState {
  id: string;
  arrival: number;
  burst: number;
  remaining: number;
}

function snapshot(ready: Map<string, RunState>, current: RunState | null): ReadyEntry[] {
  const list: ReadyEntry[] = [];
  if (current) list.push({ id: current.id, remaining: current.remaining, arrival: current.arrival });
  for (const s of ready.values()) {
    list.push({ id: s.id, remaining: s.remaining, arrival: s.arrival });
  }
  list.sort((a, b) => a.remaining - b.remaining || a.arrival - b.arrival || (a.id < b.id ? -1 : 1));
  return list;
}

/** 从就绪集合中按固定平局规则选最小剩余者（不含当前运行作业）。 */
function pickMin(ready: Map<string, RunState>): RunState | null {
  let best: RunState | null = null;
  for (const s of ready.values()) {
    if (
      best === null ||
      s.remaining < best.remaining ||
      (s.remaining === best.remaining &&
        (s.arrival < best.arrival || (s.arrival === best.arrival && s.id < best.id)))
    ) {
      best = s;
    }
  }
  return best;
}

export function schedule(jobs: JobInput[]): ScheduleResult {
  // 排序仅用于事件扫描；平局不依赖输入顺序
  const pending = jobs
    .map((j) => ({ ...j, remaining: j.burst }))
    .sort((a, b) => a.arrival - b.arrival || (a.id < b.id ? -1 : 1));
  const ready = new Map<string, RunState>();
  const rawSegments: Segment[] = [];
  const events: SchedEvent[] = [];
  const firstStart = new Map<string, number>();
  const completion = new Map<string, number>();

  let t = 0;
  let idx = 0; // pending 游标
  let current: RunState | null = null;
  let segStart = 0;
  let seq = 0;

  const closeSegment = (end: number) => {
    if (end > segStart) {
      rawSegments.push({ jobId: current ? current.id : null, start: segStart, end });
    }
  };

  while (idx < pending.length || ready.size > 0 || current !== null) {
    // 空闲：直接跳到下一到达时刻
    if (current === null && ready.size === 0) {
      const nextArrival = pending[idx].arrival;
      if (nextArrival > t) {
        current = null;
        segStart = t;
        closeSegment(nextArrival); // 记录空闲区间
        t = nextArrival;
        segStart = t;
      }
    }
    const nextArrival = idx < pending.length ? pending[idx].arrival : Number.MAX_SAFE_INTEGER;
    const finishAt = current !== null ? t + current.remaining : Number.MAX_SAFE_INTEGER;
    const te = Math.min(nextArrival, finishAt);

    const readyBefore = snapshot(ready, current);

    // 结算当前作业从 t 到 te 的执行
    if (current !== null && te > t) {
      current.remaining -= te - t;
    }
    t = te;

    // 先记录本时刻完成的作业
    const completedNow: string[] = [];
    if (current !== null && current.remaining === 0) {
      completedNow.push(current.id);
      completion.set(current.id, t);
      closeSegment(t);
      current = null;
      segStart = t;
    }

    // 加入本时刻全部到达作业
    const arrivalsNow: string[] = [];
    while (idx < pending.length && pending[idx].arrival === t) {
      const j = pending[idx];
      ready.set(j.id, { id: j.id, arrival: j.arrival, burst: j.burst, remaining: j.burst });
      arrivalsNow.push(j.id);
      idx++;
    }

    // 重新选择
    let selected: RunState | null = current;
    let preempted = false;
    let reason: string;
    const challenger = pickMin(ready);
    if (current !== null) {
      if (challenger === null || challenger.remaining >= current.remaining) {
        reason =
          challenger === null
            ? `继续运行 ${current.id}（无其他就绪作业）`
            : `继续运行 ${current.id}（剩余 ${current.remaining} <= ${challenger.id} 的 ${challenger.remaining}，相等时保留当前作业）`;
      } else {
        ready.set(current.id, current);
        selected = challenger;
        ready.delete(challenger.id);
        preempted = true;
        reason = `${challenger.id} 剩余 ${challenger.remaining} < 当前 ${current.id} 剩余 ${current.remaining}，发生抢占`;
      }
    } else if (challenger !== null) {
      selected = challenger;
      ready.delete(challenger.id);
      reason = `选择 ${challenger.id}（剩余 ${challenger.remaining} 最小；平局按到达时刻再按 ID 字典序）`;
    } else {
      selected = null;
      reason = '无就绪作业，CPU 空闲';
    }

    if (selected !== current) {
      // 真正换作业
      closeSegment(t);
      current = selected;
      segStart = t;
      if (current !== null && !firstStart.has(current.id)) {
        firstStart.set(current.id, t);
      }
    } else if (current !== null && !firstStart.has(current.id)) {
      firstStart.set(current.id, t);
    }

    // 只在有内容可解释时记录事件（到达/完成/切换/空闲边界）
    if (arrivalsNow.length > 0 || completedNow.length > 0 || preempted || selected === null) {
      events.push({
        seq: seq++,
        time: t,
        readyBefore,
        arrivals: arrivalsNow,
        completed: completedNow,
        selected: selected ? selected.id : null,
        preempted,
        reason,
        readyAfter: snapshot(ready, selected),
      });
    }

    if (selected === null && ready.size === 0 && idx >= pending.length) break;
  }
  closeSegment(t);

  // 合并相邻同作业片段
  const segments: Segment[] = [];
  for (const s of rawSegments) {
    const last = segments[segments.length - 1];
    if (last && last.jobId === s.jobId && last.end === s.start) {
      last.end = s.end;
    } else {
      segments.push({ ...s });
    }
  }

  const stats: JobStats[] = jobs.map((j) => {
    const c = completion.get(j.id)!;
    const fs = firstStart.get(j.id)!;
    return {
      id: j.id,
      arrival: j.arrival,
      burst: j.burst,
      firstStart: fs,
      completion: c,
      turnaround: c - j.arrival,
      waiting: c - j.arrival - j.burst,
      response: fs - j.arrival,
    };
  });

  return { segments, events, stats, makespan: t };
}
