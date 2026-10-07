import { ERR, SchedError } from './errors.js';

export const MAX_JOBS = 10_000;
export const MAX_TIME_VALUE = Number.MAX_SAFE_INTEGER;
export const RULES_VERSION = 'srtf-1';

export interface JobInput {
  id: string;
  arrival: number;
  burst: number;
}

const ID_RE = /^[A-Za-z0-9_]+$/;

function checkInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SchedError(ERR.NON_INTEGER, `字段 ${field} 必须是非负安全整数`, { field, value });
  }
  if (!Number.isSafeInteger(value)) {
    throw new SchedError(ERR.UNSAFE_INTEGER, `字段 ${field} 超出安全整数范围`, { field, value });
  }
  return value;
}

export function validateJobs(raw: unknown): JobInput[] {
  if (!Array.isArray(raw)) {
    throw new SchedError(ERR.BAD_REQUEST, 'jobs 必须是数组');
  }
  if (raw.length === 0) {
    throw new SchedError(ERR.EMPTY_JOBSET, '作业集不能为空');
  }
  if (raw.length > MAX_JOBS) {
    throw new SchedError(ERR.LIMIT_EXCEEDED, `作业数超过上限 ${MAX_JOBS}`, { count: raw.length });
  }
  const seen = new Set<string>();
  const jobs: JobInput[] = [];
  let maxArrival = 0;
  let totalBurst = 0;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (item === null || typeof item !== 'object') {
      throw new SchedError(ERR.BAD_REQUEST, `第 ${i} 个作业不是对象`);
    }
    const id = item.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new SchedError(ERR.INVALID_ID, `作业 ID 只能包含英文字母、数字、下划线`, { index: i, id });
    }
    if (seen.has(id)) {
      throw new SchedError(ERR.DUPLICATE_ID, `作业 ID 重复: ${id}`, { id });
    }
    seen.add(id);
    const arrival = checkInt(item.arrival, `jobs[${i}].arrival`);
    if (arrival < 0) {
      throw new SchedError(ERR.NEGATIVE_TIME, `到达时刻不能为负: ${id}`, { id, arrival });
    }
    const burst = checkInt(item.burst, `jobs[${i}].burst`);
    if (burst <= 0) {
      throw new SchedError(ERR.NON_POSITIVE_BURST, `CPU 需求必须为正整数: ${id}`, { id, burst });
    }
    if (arrival > MAX_TIME_VALUE - totalBurst - burst) {
      throw new SchedError(ERR.UNSAFE_INTEGER, '到达时刻与总需求相加会越过安全整数上限', { id });
    }
    totalBurst += burst;
    if (arrival > maxArrival) maxArrival = arrival;
    jobs.push({ id, arrival, burst });
  }
  // 完成时刻上界 = maxArrival + totalBurst，必须保持安全整数
  if (maxArrival > MAX_TIME_VALUE - totalBurst) {
    throw new SchedError(ERR.UNSAFE_INTEGER, '最晚完成时刻会越过安全整数上限', {
      maxArrival,
      totalBurst,
    });
  }
  return jobs;
}
