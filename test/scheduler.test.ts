import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/scheduler.js';
import { simulatePerUnit } from '../src/simulate.js';
import { validateJobs } from '../src/validate.js';
import { SchedError, ERR } from '../src/errors.js';

const SAMPLE = [
  { id: 'A', arrival: 0, burst: 8 },
  { id: 'B', arrival: 1, burst: 4 },
  { id: 'C', arrival: 2, burst: 2 },
];

test('已知样例 A/B/C', () => {
  const r = schedule(SAMPLE);
  const segs = r.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`);
  assert.deepEqual(segs, ['A:[0,1)', 'B:[1,2)', 'C:[2,4)', 'B:[4,7)', 'A:[7,14)']);
  const stat = Object.fromEntries(r.stats.map((s) => [s.id, s]));
  assert.equal(stat.A.completion, 14);
  assert.equal(stat.B.completion, 7);
  assert.equal(stat.C.completion, 4);
  assert.equal(stat.A.waiting, 6);
  assert.equal(stat.B.waiting, 2);
  assert.equal(stat.C.waiting, 0);
  assert.equal(stat.A.turnaround, 14);
  assert.equal(stat.B.response, 0);
});

test('新到作业与当前剩余相等时不抢占', () => {
  const r = schedule([
    { id: 'A', arrival: 0, burst: 3 },
    { id: 'B', arrival: 1, burst: 2 },
  ]);
  const segs = r.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`);
  assert.deepEqual(segs, ['A:[0,3)', 'B:[3,5)']);
  assert.ok(r.events.every((e) => !e.preempted));
});

test('多个同秒到达按剩余、到达、ID 选择', () => {
  const r = schedule([
    { id: 'B', arrival: 5, burst: 2 },
    { id: 'A', arrival: 5, burst: 2 },
    { id: 'C', arrival: 5, burst: 1 },
  ]);
  const segs = r.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`);
  assert.deepEqual(segs, ['null:[0,5)', 'C:[5,6)', 'A:[6,8)', 'B:[8,10)']);
});

test('完成与到达重合：先完成再选择', () => {
  const r = schedule([
    { id: 'A', arrival: 0, burst: 2 },
    { id: 'B', arrival: 2, burst: 1 },
  ]);
  const segs = r.segments.map((s) => `${s.jobId}:[${s.start},${s.end})`);
  assert.deepEqual(segs, ['A:[0,2)', 'B:[2,3)']);
  const ev = r.events.find((e) => e.time === 2)!;
  assert.deepEqual(ev.completed, ['A']);
  assert.deepEqual(ev.arrivals, ['B']);
});

test('开头空闲区间', () => {
  const r = schedule([{ id: 'A', arrival: 3, burst: 2 }]);
  assert.deepEqual(r.segments[0], { jobId: null, start: 0, end: 3 });
  assert.deepEqual(r.segments[1], { jobId: 'A', start: 3, end: 5 });
});

test('输入打乱后调度结果一致', () => {
  const jobs = [
    { id: 'A', arrival: 0, burst: 8 },
    { id: 'B', arrival: 1, burst: 4 },
    { id: 'C', arrival: 2, burst: 2 },
    { id: 'D', arrival: 3, burst: 1 },
    { id: 'E', arrival: 0, burst: 3 },
  ];
  const base = JSON.stringify(schedule(jobs).segments);
  const shuffled = JSON.stringify(schedule([...jobs].reverse()).segments);
  assert.equal(base, shuffled);
});

test('同秒到达不产生零长度片段', () => {
  const r = schedule([
    { id: 'A', arrival: 0, burst: 5 },
    { id: 'B', arrival: 2, burst: 9 },
    { id: 'C', arrival: 2, burst: 9 },
  ]);
  for (const s of r.segments) assert.ok(s.end > s.start, '存在零长度片段');
});

function checkInvariants(jobs: { id: string; arrival: number; burst: number }[]) {
  const r = schedule(jobs);
  // 每作业执行总长恰等于需求
  for (const j of jobs) {
    const total = r.segments.filter((s) => s.jobId === j.id).reduce((a, s) => a + (s.end - s.start), 0);
    assert.equal(total, j.burst, `${j.id} 执行总时长不等于需求`);
  }
  // 片段不重叠且递增
  for (let i = 1; i < r.segments.length; i++) {
    assert.ok(r.segments[i].start >= r.segments[i - 1].end, '片段重叠');
  }
  // 等待非负，统计口径一致
  for (const s of r.stats) {
    assert.ok(s.waiting >= 0);
    assert.equal(s.turnaround, s.completion - s.arrival);
    assert.equal(s.waiting, s.turnaround - s.burst);
    assert.equal(s.response, s.firstStart - s.arrival);
  }
  // 完成时刻不在片段内（左闭右开）
  for (const s of r.stats) {
    assert.ok(!r.segments.some((g) => g.jobId === s.id && g.start <= s.completion && s.completion < g.end));
  }
  return r;
}

test('随机小规模输入与逐单位模拟一致', () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let iter = 0; iter < 200; iter++) {
    const n = 1 + Math.floor(rand() * 6);
    const jobs = Array.from({ length: n }, (_, i) => ({
      id: `J${i}`,
      arrival: Math.floor(rand() * 10),
      burst: 1 + Math.floor(rand() * 8),
    }));
    const r = checkInvariants(jobs);
    const sim = simulatePerUnit(jobs);
    assert.deepEqual(
      r.segments.map((s) => [s.jobId, s.start, s.end]),
      sim.segments.map((s) => [s.jobId, s.start, s.end]),
      `与逐单位模拟不一致: ${JSON.stringify(jobs)}`,
    );
    for (const s of r.stats) assert.equal(sim.completion.get(s.id), s.completion);
  }
});

test('校验错误码稳定', () => {
  const expectErr = (jobs: unknown, code: string) => {
    assert.throws(() => validateJobs(jobs), (e: unknown) => e instanceof SchedError && e.code === code);
  };
  expectErr([{ id: 'a-b', arrival: 0, burst: 1 }], ERR.INVALID_ID);
  expectErr([{ id: '中文', arrival: 0, burst: 1 }], ERR.INVALID_ID);
  expectErr(
    [
      { id: 'A', arrival: 0, burst: 1 },
      { id: 'A', arrival: 1, burst: 1 },
    ],
    ERR.DUPLICATE_ID,
  );
  expectErr([{ id: 'A', arrival: -1, burst: 1 }], ERR.NEGATIVE_TIME);
  expectErr([{ id: 'A', arrival: 0, burst: 0 }], ERR.NON_POSITIVE_BURST);
  expectErr([{ id: 'A', arrival: 0.5, burst: 1 }], ERR.NON_INTEGER);
  expectErr([{ id: 'A', arrival: 1, burst: Number.MAX_SAFE_INTEGER }], ERR.UNSAFE_INTEGER);
  expectErr([], ERR.EMPTY_JOBSET);
});
