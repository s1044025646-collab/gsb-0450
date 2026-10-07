import http from "node:http";
import { AddressInfo } from "node:net";
import { Store } from "./db";
import { schedule, runnerAt } from "./scheduler";
import { validateJobs, parseTimeParam } from "./validate";
import { toErrorPayload, SchedError } from "./errors";
import { RULES_VERSION } from "./types";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new SchedError("E_BAD_REQUEST", "请求体超过 10MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { ok: true, rulesVersion: RULES_VERSION });
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "jobsets") {
        return send(res, 200, { jobsets: store.listJobsets() });
      }
      if (method === "POST" && parts.length === 2 && parts[1] === "jobsets") {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          throw new SchedError("E_BAD_JSON", "请求体不是合法 JSON");
        }
        const obj = body as Record<string, unknown>;
        const jobs = validateJobs(obj.jobs);
        const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "未命名作业集";
        const { jobsetId, reused } = store.importJobset(name, jobs, RULES_VERSION);
        return send(res, reused ? 200 : 201, { jobsetId, reused, jobCount: jobs.length });
      }
      if (method === "GET" && parts.length === 3 && parts[1] === "jobsets") {
        const { jobset, jobs } = store.getJobset(Number(parts[2]));
        return send(res, 200, { jobset, jobs });
      }
      if (method === "POST" && parts.length === 4 && parts[1] === "jobsets" && parts[3] === "schedule") {
        const { runId, result, frozen } = store.runSchedule(Number(parts[2]), schedule);
        return send(res, frozen ? 200 : 201, { runId, frozen, makespan: result.makespan, stats: result.stats });
      }
      if (method === "GET" && parts.length === 2 && parts[1] === "runs") {
        return send(res, 200, { runs: store.listRuns() });
      }
      if (method === "GET" && parts.length === 3 && parts[1] === "runs") {
        const r = store.loadReport(Number(parts[2]));
        return send(res, 200, {
          runId: Number(parts[2]),
          makespan: r.makespan,
          rulesVersion: r.rulesVersion,
          stats: r.stats,
          segments: r.segments,
        });
      }
      if (method === "GET" && parts.length === 4 && parts[1] === "runs" && parts[3] === "events") {
        return send(res, 200, { runId: Number(parts[2]), events: store.loadEvents(Number(parts[2])) });
      }
      if (method === "GET" && parts.length === 5 && parts[1] === "runs" && parts[3] === "at") {
        const runId = Number(parts[2]);
        const time = parseTimeParam(parts[4]);
        const segs = store.loadSegments(runId);
        const runner = runnerAt(segs, time);
        const makespan = segs.length > 0 ? segs[segs.length - 1].end : 0;
        return send(res, 200, { runId, time, runner, idle: runner === null && time < makespan });
      }
      if (method === "GET" && parts.length === 5 && parts[1] === "runs" && parts[3] === "jobs") {
        const runId = Number(parts[2]);
        const jobId = parts[4];
        const report = store.loadReport(runId);
        const stat = report.stats.find((s) => s.id === jobId);
        if (!stat) throw new SchedError("E_JOB_NOT_FOUND", `运行 ${runId} 中不存在作业 ${jobId}`);
        const slices = report.segments.filter((s) => s.jobId === jobId);
        return send(res, 200, { runId, job: stat, slices });
      }
      throw new SchedError("E_BAD_REQUEST", `未知路由: ${method} ${url.pathname}`);
    } catch (err) {
      const payload = toErrorPayload(err);
      const notFound = payload.code === "E_JOBSET_NOT_FOUND" || payload.code === "E_RUN_NOT_FOUND" || payload.code === "E_JOB_NOT_FOUND";
      const status = notFound ? 404 : payload.code === "E_INTERNAL" ? 500 : 400;
      send(res, status, { error: payload });
    }
  });
}

export function startServer(store: Store, port: number): Promise<number> {
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
