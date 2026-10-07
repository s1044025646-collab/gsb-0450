import { SchedError } from "./errors";
import { JobInput } from "./types";

export const MAX_JOBS = 10000;
export const MAX_TIME = Number.MAX_SAFE_INTEGER;

const ID_RE = /^[A-Za-z0-9_]+$/;

function assertSafeNonNegativeInt(v: unknown, field: string, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new SchedError("E_NON_INTEGER", `${what} 的 ${field} 必须是非负整数，收到: ${JSON.stringify(v)}`);
  }
  if (v < 0) {
    throw new SchedError("E_NEGATIVE_TIME", `${what} 的 ${field} 不能为负: ${v}`);
  }
  if (!Number.isSafeInteger(v)) {
    throw new SchedError("E_OVERFLOW", `${what} 的 ${field} 超出安全整数范围: ${v}`);
  }
  return v;
}

/** 校验并规范化作业集；保留输入顺序（seq）。失败抛错，不产生任何写入。 */
export function validateJobs(raw: unknown): JobInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SchedError("E_NO_JOBS", "作业集必须是非空数组");
  }
  if (raw.length > MAX_JOBS) {
    throw new SchedError("E_TOO_MANY_JOBS", `作业数 ${raw.length} 超过上限 ${MAX_JOBS}`);
  }
  const seen = new Set<string>();
  const jobs: JobInput[] = [];
  let maxArrival = 0;
  let totalBurst = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown>;
    const what = `第 ${i + 1} 个作业`;
    if (r === null || typeof r !== "object") {
      throw new SchedError("E_BAD_REQUEST", `${what} 不是对象`);
    }
    const id = r.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 64 || !ID_RE.test(id)) {
      throw new SchedError("E_INVALID_ID", `${what} 的 id 必须是 1-64 位可打印英文字母/数字/下划线: ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new SchedError("E_DUP_ID", `作业 id 重复: ${id}`);
    }
    seen.add(id);
    const arrival = assertSafeNonNegativeInt(r.arrival, "arrival", `作业 ${id}`);
    const burst = assertSafeNonNegativeInt(r.burst, "burst", `作业 ${id}`);
    if (burst <= 0) {
      throw new SchedError("E_NON_POSITIVE_BURST", `作业 ${id} 的 burst 必须为正整数: ${burst}`);
    }
    if (arrival > maxArrival) maxArrival = arrival;
    totalBurst += burst;
    if (totalBurst > MAX_TIME - maxArrival) {
      throw new SchedError("E_OVERFLOW", "到达时刻与需求求和将越过安全整数上限");
    }
    jobs.push({ id, arrival, burst });
  }
  return jobs;
}

export function parseTimeParam(raw: string, what = "时刻"): number {
  if (!/^\d+$/.test(raw)) {
    throw new SchedError("E_NON_INTEGER", `${what} 必须是非负整数字符串: ${raw}`);
  }
  const v = Number(raw);
  if (!Number.isSafeInteger(v)) {
    throw new SchedError("E_OVERFLOW", `${what} 超出安全整数范围: ${raw}`);
  }
  return v;
}
