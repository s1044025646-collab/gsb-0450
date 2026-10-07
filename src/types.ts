export interface JobInput {
  id: string;
  arrival: number;
  burst: number;
}

export interface ReadyEntry {
  id: string;
  remaining: number;
  arrival: number;
}

export interface SchedEvent {
  seq: number;
  time: number;
  /** 事件类型 */
  kind: "start" | "preempt" | "complete" | "idle" | "arrival";
  /** 事件结算前就绪集合剩余量（含在运行作业） */
  readyBefore: ReadyEntry[];
  /** 事件结算后就绪集合剩余量 */
  readyAfter: ReadyEntry[];
  /** 本事件后被选中的作业，空闲时为 null */
  chosen: string | null;
  /** 比较与选择理由（含未抢占原因） */
  reason: string;
}

export interface Segment {
  jobId: string | null; // null 表示空闲
  start: number;
  end: number;
}

export interface JobStats {
  id: string;
  arrival: number;
  burst: number;
  firstStart: number;
  completion: number;
  turnaround: number; // completion - arrival
  waiting: number; // turnaround - burst
  response: number; // firstStart - arrival
}

export interface ScheduleResult {
  rulesVersion: string;
  segments: Segment[]; // 相邻同作业已合并，含空闲区间
  events: SchedEvent[];
  stats: JobStats[];
  makespan: number;
}

export const RULES_VERSION = "srtf/1.0";
