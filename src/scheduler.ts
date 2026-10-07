import { JobInput, ReadyEntry, SchedEvent, ScheduleResult, Segment, JobStats, RULES_VERSION } from "./types";
import { SchedError } from "./errors";

interface ReadyJob {
  id: string;
  arrival: number;
  burst: number;
  remaining: number;
}

function snapshot(ready: Map<string, ReadyJob>): ReadyEntry[] {
  return [...ready.values()]
    .map((j) => ({ id: j.id, remaining: j.remaining, arrival: j.arrival }))
    .sort((a, b) => a.remaining - b.remaining || a.arrival - b.arrival || (a.id < b.id ? -1 : 1));
}

/** 无可保留当前作业时的选择：剩余最少，再按到达时刻，再按 ID ASCII 字典序 */
function pickMin(ready: Map<string, ReadyJob>): ReadyJob {
  let best: ReadyJob | null = null;
  for (const j of ready.values()) {
    if (
      best === null ||
      j.remaining < best.remaining ||
      (j.remaining === best.remaining && j.arrival < best.arrival) ||
      (j.remaining === best.remaining && j.arrival === best.arrival && j.id < best.id)
    ) {
      best = j;
    }
  }
  return best!;
}

function cmpTie(a: ReadyJob, b: ReadyJob): string {
  if (a.arrival !== b.arrival) return `到达更早(${a.arrival}<${b.arrival})`;
  return `ID 字典序 ${a.id}<${b.id}`;
}

/**
 * 事件驱动 SRTF。
 * 不变式：任何时刻执行剩余需求最小者；新到作业先结算再入队再重选；
 * 当前作业剩余不严格更大时保留（相等不抢占）。
 */
export function schedule(inputJobs: JobInput[]): ScheduleResult {
  const arrivals = [...inputJobs].sort(
    (a, b) => a.arrival - b.arrival || (a.id < b.id ? -1 : 1)
  );
  const ready = new Map<string, ReadyJob>();
  const segments: Segment[] = [];
  const events: SchedEvent[] = [];
  const completion = new Map<string, number>();
  const firstStart = new Map<string, number>();

  let ai = 0; // 下一个未到达下标
  let t = 0;
  let current: ReadyJob | null = null;
  let seq = 0;

  const pushSegment = (jobId: string | null, start: number, end: number) => {
    if (end <= start) return; // 不制造零长度片段
    const last = segments[segments.length - 1];
    if (last && last.jobId === jobId && last.end === start) {
      last.end = end; // 相邻同作业合并
    } else {
      segments.push({ jobId, start, end });
    }
  };

  const addArrivalsAt = (time: number): ReadyJob[] => {
    const added: ReadyJob[] = [];
    while (ai < arrivals.length && arrivals[ai].arrival <= time) {
      const s = arrivals[ai++];
      const j: ReadyJob = { id: s.id, arrival: s.arrival, burst: s.burst, remaining: s.burst };
      ready.set(j.id, j);
      added.push(j);
    }
    return added;
  };

  const describePick = (cand: ReadyJob): string => {
    const ties = [...ready.values()].filter((j) => j !== cand && j.remaining === cand.remaining);
    let r = `选择剩余最少者 ${cand.id}(剩余 ${cand.remaining})`;
    if (ties.length > 0) r += `，与 ${ties.map((x) => x.id).join("/")} 剩余相同，按${cmpTie(cand, ties[0])}胜出`;
    return r;
  };

  // 起始空闲
  if (arrivals[0].arrival > 0) {
    pushSegment(null, 0, arrivals[0].arrival);
    events.push({
      seq: seq++,
      time: 0,
      kind: "idle",
      readyBefore: [],
      readyAfter: [],
      chosen: null,
      reason: `无可运行作业，空闲至下一到达时刻 ${arrivals[0].arrival}`,
    });
    t = arrivals[0].arrival;
  }
  addArrivalsAt(t);

  while (ready.size > 0) {
    // 选择（循环不变式：此处一定需要做出新选择或保留当前）
    if (current === null) {
      const pick = pickMin(ready);
      current = pick;
      if (!firstStart.has(pick.id)) firstStart.set(pick.id, t);
      events.push({
        seq: seq++,
        time: t,
        kind: "start",
        readyBefore: snapshot(ready),
        readyAfter: snapshot(ready),
        chosen: pick.id,
        reason: describePick(pick),
      });
    }

    const nextArrival = ai < arrivals.length ? arrivals[ai].arrival : Infinity;
    const finishAt = t + current.remaining;
    if (!Number.isSafeInteger(finishAt)) {
      throw new SchedError("E_OVERFLOW", "完成时刻越过安全整数上限");
    }
    const evT = Math.min(nextArrival, finishAt);

    // 结算 [t, evT)
    current.remaining -= evT - t;
    pushSegment(current.id, t, evT);
    t = evT;

    const readyBefore = snapshot(ready);
    const completedNow = current.remaining === 0;
    if (completedNow) {
      completion.set(current.id, t);
      ready.delete(current.id);
    }
    const added = addArrivalsAt(t);
    const readyAfter = snapshot(ready);

    if (completedNow) {
      const doneId = current.id;
      const completedAt = t;
      current = null;
      let chosen: string | null = null;
      let reason = `${doneId} 在时刻 ${t} 完成`;
      if (ready.size > 0) {
        const pick = pickMin(ready);
        current = pick;
        chosen = pick.id;
        if (!firstStart.has(pick.id)) firstStart.set(pick.id, t);
        reason += `；${describePick(pick)}`;
      } else if (ai < arrivals.length) {
        reason += `；就绪集合为空，空闲至下一到达时刻 ${arrivals[ai].arrival}`;
        pushSegment(null, t, arrivals[ai].arrival);
        t = arrivals[ai].arrival;
        addArrivalsAt(t);
      } else {
        reason += "；全部作业完成，调度结束";
      }
      events.push({
        seq: seq++,
        time: completedAt,
        kind: "complete",
        readyBefore,
        readyAfter: snapshot(ready),
        chosen,
        reason,
      });
      continue;
    }

    // 未完成作业遇到到达事件：决定是否抢占
    if (added.length > 0) {
      const challenger = added.reduce((m, j) => (j.remaining < m.remaining ? j : m), added[0]);
      if (challenger.remaining < current.remaining) {
        const prev = current;
        const pick = pickMin(ready);
        current = pick;
        if (!firstStart.has(pick.id)) firstStart.set(pick.id, t);
        events.push({
          seq: seq++,
          time: t,
          kind: "preempt",
          readyBefore,
          readyAfter: snapshot(ready),
          chosen: pick.id,
          reason: `${challenger.id} 剩余 ${challenger.remaining} < 当前 ${prev.id} 剩余 ${prev.remaining}，发生抢占；${describePick(pick)}`,
        });
      } else {
        events.push({
          seq: seq++,
          time: t,
          kind: "arrival",
          readyBefore,
          readyAfter: snapshot(ready),
          chosen: current.id,
          reason: `新到作业 ${added.map((j) => `${j.id}(剩余 ${j.remaining})`).join("、")} 不严格小于当前 ${current.id}(剩余 ${current.remaining})，不抢占，继续运行`,
        });
      }
    }
    // added.length === 0 且未完成不可能发生（evT 只能来自到达或完成）
  }

  const stats: JobStats[] = inputJobs.map((j) => {
    const c = completion.get(j.id)!;
    const fs = firstStart.get(j.id)!;
    const turnaround = c - j.arrival;
    const waiting = turnaround - j.burst;
    const s: JobStats = {
      id: j.id,
      arrival: j.arrival,
      burst: j.burst,
      firstStart: fs,
      completion: c,
      turnaround,
      waiting,
      response: fs - j.arrival,
    };
    if (s.waiting < 0) {
      throw new SchedError("E_OVERFLOW", `内部错误：作业 ${j.id} 等待时间为负`);
    }
    return s;
  });

  return {
    rulesVersion: RULES_VERSION,
    segments,
    events,
    stats,
    makespan: segments.length > 0 ? segments[segments.length - 1].end : 0,
  };
}

/** 查询时刻 t 的运行者（左闭右开）；最后完成之后返回 null */
export function runnerAt(segments: Segment[], time: number): string | null {
  for (const seg of segments) {
    if (time >= seg.start && time < seg.end) return seg.jobId;
  }
  return null;
}
