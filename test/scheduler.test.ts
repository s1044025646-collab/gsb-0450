import { test } from "node:test";
import assert from "node:assert/strict";
import { schedule, runnerAt } from "../src/scheduler";
import { validateJobs } from "../src/validate";
import { verifySchedule } from "../src/verify";
import { SchedError } from "../src/errors";
import { JobInput } from "../src/types";

const ABC: JobInput[] = [
  { id: "A", arrival: 0, burst: 8 },
  { id: "B", arrival: 1, burst: 4 },
  { id: "C", arrival: 2, burst: 2 },
];

test("已知样例 A(0,8) B(1,4) C(2,2)", () => {
  const r = schedule(ABC);
  const segs = r.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`);
  assert.deepEqual(segs, ["A:[0,1)", "B:[1,2)", "C:[2,4)", "B:[4,7)", "A:[7,14)"]);
  const stat = (id: string) => r.stats.find((s) => s.id === id)!;
  assert.equal(stat("A").completion, 14);
  assert.equal(stat("B").completion, 7);
  assert.equal(stat("C").completion, 4);
  assert.equal(stat("A").waiting, 6);
  assert.equal(stat("B").waiting, 2);
  assert.equal(stat("C").waiting, 0);
  assert.equal(stat("A").turnaround, 14);
  assert.equal(stat("B").response, 0);
  assert.equal(verifySchedule(ABC, r).ok, true);
});

test("新到作业与当前剩余相等时不抢占", () => {
  const jobs: JobInput[] = [
    { id: "A", arrival: 0, burst: 4 },
    { id: "B", arrival: 2, burst: 2 },
  ];
  const r = schedule(jobs);
  assert.deepEqual(
    r.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`),
    ["A:[0,4)", "B:[4,6)"]
  );
  assert.equal(r.events.some((e) => e.kind === "preempt"), false);
  const arrival = r.events.find((e) => e.kind === "arrival");
  assert.ok(arrival && /不抢占/.test(arrival.reason), "应记录未抢占原因");
  assert.equal(verifySchedule(jobs, r).ok, true);
});

test("多个作业同秒到达", () => {
  const jobs: JobInput[] = [
    { id: "A", arrival: 0, burst: 10 },
    { id: "C", arrival: 5, burst: 2 },
    { id: "B", arrival: 5, burst: 1 },
  ];
  const r = schedule(jobs);
  assert.deepEqual(
    r.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`),
    ["A:[0,5)", "B:[5,6)", "C:[6,8)", "A:[8,13)"]
  );
  assert.equal(verifySchedule(jobs, r).ok, true);
});

test("完成与到达重合，不产生零长度片段", () => {
  const jobs: JobInput[] = [
    { id: "A", arrival: 0, burst: 2 },
    { id: "B", arrival: 2, burst: 3 },
  ];
  const r = schedule(jobs);
  assert.deepEqual(
    r.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`),
    ["A:[0,2)", "B:[2,5)"]
  );
  for (const s of r.segments) assert.ok(s.end > s.start, "不允许零长度片段");
  assert.equal(r.events.filter((e) => e.kind === "complete").length, 2);
  assert.equal(verifySchedule(jobs, r).ok, true);
});

test("开头空闲与中间空闲", () => {
  const jobs: JobInput[] = [
    { id: "A", arrival: 5, burst: 2 },
    { id: "B", arrival: 20, burst: 1 },
  ];
  const r = schedule(jobs);
  assert.deepEqual(
    r.segments.map((s) => `${s.jobId ?? "IDLE"}:[${s.start},${s.end})`),
    ["IDLE:[0,5)", "A:[5,7)", "IDLE:[7,20)", "B:[20,21)"]
  );
  assert.equal(r.events[0].kind, "idle");
  assert.equal(verifySchedule(jobs, r).ok, true);
});

test("输入顺序打乱后调度一致", () => {
  const a = schedule(ABC);
  const b = schedule([ABC[2], ABC[0], ABC[1]]);
  assert.deepEqual(
    a.segments.map((s) => [s.jobId, s.start, s.end]),
    b.segments.map((s) => [s.jobId, s.start, s.end])
  );
  const statsA = Object.fromEntries(a.stats.map((s) => [s.id, s]));
  const statsB = Object.fromEntries(b.stats.map((s) => [s.id, s]));
  assert.deepEqual(statsA, statsB);
});

test("同剩余按到达时刻再按 ID 字典序", () => {
  const jobs: JobInput[] = [
    { id: "Z", arrival: 0, burst: 2 },
    { id: "A", arrival: 0, burst: 2 },
  ];
  const r = schedule(jobs);
  assert.equal(r.segments[0].jobId, "A", "同到达同剩余时按 ID 字典序");
  const jobs2: JobInput[] = [
    { id: "B", arrival: 1, burst: 2 },
    { id: "A", arrival: 0, burst: 4 },
  ];
  const r2 = schedule(jobs2);
  assert.deepEqual(
    r2.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`),
    ["A:[0,1)", "B:[1,3)", "A:[3,6)"]
  );
});

test("runnerAt 左闭右开与结束后无运行者", () => {
  const r = schedule(ABC);
  assert.equal(runnerAt(r.segments, 0), "A");
  assert.equal(runnerAt(r.segments, 1), "B");
  assert.equal(runnerAt(r.segments, 3), "C");
  assert.equal(runnerAt(r.segments, 4), "B", "完成时刻 4 不再属于 C");
  assert.equal(runnerAt(r.segments, 13), "A");
  assert.equal(runnerAt(r.segments, 14), null, "最后完成之后无运行者");
  assert.equal(runnerAt(r.segments, 999), null);
});

test("参数校验错误码稳定", () => {
  const expectCode = (input: unknown, code: string) => {
    try {
      validateJobs(input);
      assert.fail("应抛错");
    } catch (e) {
      assert.ok(e instanceof SchedError);
      assert.equal(e.code, code, `${JSON.stringify(input)} 应得 ${code}，实际 ${(e as SchedError).code}`);
    }
  };
  expectCode([], "E_NO_JOBS");
  expectCode([{ id: "A", arrival: 0, burst: 1 }, { id: "A", arrival: 1, burst: 1 }], "E_DUP_ID");
  expectCode([{ id: "A", arrival: -1, burst: 1 }], "E_NEGATIVE_TIME");
  expectCode([{ id: "A", arrival: 0, burst: 0 }], "E_NON_POSITIVE_BURST");
  expectCode([{ id: "A", arrival: 0, burst: -3 }], "E_NEGATIVE_TIME");
  expectCode([{ id: "A", arrival: 0.5, burst: 1 }], "E_NON_INTEGER");
  expectCode([{ id: "A", arrival: 0, burst: "x" }], "E_NON_INTEGER");
  expectCode([{ id: "作业甲", arrival: 0, burst: 1 }], "E_INVALID_ID");
  expectCode([{ id: "a-b", arrival: 0, burst: 1 }], "E_INVALID_ID");
  expectCode([{ id: "", arrival: 0, burst: 1 }], "E_INVALID_ID");
  expectCode([{ id: "A", arrival: Number.MAX_SAFE_INTEGER, burst: 2 }], "E_OVERFLOW");
});

test("随机小规模输入交叉核验（事件驱动 vs 逐单位模拟）", () => {
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let iter = 0; iter < 200; iter++) {
    const count = 1 + rand(8);
    const jobs: JobInput[] = [];
    for (let i = 0; i < count; i++) {
      jobs.push({ id: `J${i}`, arrival: rand(30), burst: 1 + rand(15) });
    }
    const r = schedule(jobs);
    const v = verifySchedule(jobs, r);
    assert.ok(v.ok, `第 ${iter} 组核验失败: ${v.problems.join("; ")}; 输入 ${JSON.stringify(jobs)}`);
  }
});
