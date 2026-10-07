import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/db";
import { schedule } from "../src/scheduler";
import { validateJobs } from "../src/validate";
import { SchedError } from "../src/errors";
import { JobInput, RULES_VERSION } from "../src/types";

const JOBS: JobInput[] = [
  { id: "A", arrival: 0, burst: 8 },
  { id: "B", arrival: 1, burst: 4 },
  { id: "C", arrival: 2, burst: 2 },
];

function withStore<T>(fn: (store: Store, dbPath: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "srtf-test-"));
  const dbPath = path.join(dir, "test.db");
  const store = new Store(dbPath);
  try {
    return fn(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("重复分析返回同一冻结结果", () => {
  withStore((store) => {
    const jobs = validateJobs(JOBS);
    const { jobsetId } = store.importJobset("样例", jobs, RULES_VERSION);
    const r1 = store.runSchedule(jobsetId, schedule);
    const r2 = store.runSchedule(jobsetId, schedule);
    assert.equal(r1.frozen, false);
    assert.equal(r2.frozen, true);
    assert.equal(r1.runId, r2.runId);
    assert.equal(JSON.stringify(r1.result.segments), JSON.stringify(r2.result.segments));
  });
});

test("乱序导入复用同一作业集与运行", () => {
  withStore((store) => {
    const a = store.importJobset("正序", validateJobs(JOBS), RULES_VERSION);
    const b = store.importJobset("乱序", validateJobs([JOBS[2], JOBS[0], JOBS[1]]), RULES_VERSION);
    assert.equal(a.jobsetId, b.jobsetId);
    assert.equal(b.reused, true);
  });
});

test("重启后读取报告无需重新调度", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "srtf-test-"));
  const dbPath = path.join(dir, "test.db");
  try {
    let runId = 0;
    {
      const store = new Store(dbPath);
      const { jobsetId } = store.importJobset("样例", validateJobs(JOBS), RULES_VERSION);
      runId = store.runSchedule(jobsetId, schedule).runId;
      store.close();
    }
    {
      const store = new Store(dbPath);
      const report = store.loadReport(runId);
      assert.equal(report.makespan, 14);
      assert.equal(report.stats.find((s) => s.id === "A")!.waiting, 6);
      assert.ok(report.events.length > 0);
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("修改需求产生新运行，不覆盖旧时间线", () => {
  withStore((store) => {
    const s1 = store.importJobset("v1", validateJobs(JOBS), RULES_VERSION);
    const run1 = store.runSchedule(s1.jobsetId, schedule);
    const changed = validateJobs([JOBS[0], JOBS[1], { id: "C", arrival: 2, burst: 3 }]);
    const s2 = store.importJobset("v2", changed, RULES_VERSION);
    assert.notEqual(s1.jobsetId, s2.jobsetId);
    const run2 = store.runSchedule(s2.jobsetId, schedule);
    assert.notEqual(run1.runId, run2.runId);
    assert.equal(store.loadReport(run1.runId).makespan, 14, "旧时间线保持不变");
    assert.equal(store.loadReport(run2.runId).makespan, 15);
  });
});

test("非法批次不写半份报告", () => {
  withStore((store) => {
    assert.throws(
      () => validateJobs([{ id: "A", arrival: 0, burst: 1 }, { id: "A", arrival: 0, burst: 2 }]),
      (e: unknown) => e instanceof SchedError && e.code === "E_DUP_ID"
    );
    assert.equal(store.listJobsets().length, 0);
    assert.equal(store.listRuns().length, 0);
  });
});

test("不同作业集互不影响", () => {
  withStore((store) => {
    const s1 = store.importJobset("一", validateJobs(JOBS), RULES_VERSION);
    const s2 = store.importJobset("二", validateJobs([{ id: "X", arrival: 3, burst: 5 }]), RULES_VERSION);
    const r1 = store.runSchedule(s1.jobsetId, schedule);
    const r2 = store.runSchedule(s2.jobsetId, schedule);
    assert.equal(store.loadReport(r1.runId).makespan, 14);
    assert.equal(store.loadReport(r2.runId).makespan, 8);
  });
});
