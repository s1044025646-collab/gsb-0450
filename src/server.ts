import http from 'node:http';
import { SchedError, ERR } from './errors.js';
import {
  createJobset,
  getJobset,
  listJobsets,
  runSchedule,
  getRun,
  runnerAt,
  jobTimeline,
} from './db.js';

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendError(res: http.ServerResponse, e: unknown) {
  if (e instanceof SchedError) {
    const status =
      e.code === ERR.NOT_FOUND ? 404 : e.code === ERR.BAD_JSON || e.code === ERR.BAD_REQUEST ? 400 : 422;
    send(res, status, { error: { code: e.code, message: e.message, details: e.details ?? null } });
  } else {
    send(res, 500, { error: { code: 'INTERNAL', message: String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SchedError(ERR.BAD_JSON, '请求体不是合法 JSON');
  }
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (parts[0] !== 'api') {
        return send(res, 200, {
          service: 'srtf-scheduler',
          endpoints: [
            'POST /api/jobsets {name?, jobs:[{id,arrival,burst}]}',
            'GET /api/jobsets',
            'GET /api/jobsets/:id',
            'POST /api/jobsets/:id/run',
            'GET /api/runs/:id',
            'GET /api/runs/:id/events',
            'GET /api/runs/:id/at?t=',
            'GET /api/runs/:id/jobs/:jobId',
          ],
        });
      }

      if (parts[1] === 'jobsets' && parts.length === 2 && method === 'POST') {
        const body = (await readBody(req)) as { name?: string; jobs?: unknown };
        return send(res, 201, createJobset(body.name ?? '', body.jobs));
      }
      if (parts[1] === 'jobsets' && parts.length === 2 && method === 'GET') {
        return send(res, 200, listJobsets());
      }
      if (parts[1] === 'jobsets' && parts.length === 3 && method === 'GET') {
        return send(res, 200, getJobset(Number(parts[2])));
      }
      if (parts[1] === 'jobsets' && parts.length === 4 && parts[3] === 'run' && method === 'POST') {
        const { runId, reused, result } = runSchedule(Number(parts[2]));
        return send(res, reused ? 200 : 201, { runId, reused, ...result });
      }
      if (parts[1] === 'runs' && parts.length === 3 && method === 'GET') {
        const { run, result } = getRun(Number(parts[2]));
        return send(res, 200, { run, ...result });
      }
      if (parts[1] === 'runs' && parts.length === 4 && parts[3] === 'events' && method === 'GET') {
        const { result } = getRun(Number(parts[2]));
        return send(res, 200, result.events);
      }
      if (parts[1] === 'runs' && parts.length === 4 && parts[3] === 'at' && method === 'GET') {
        const t = Number(url.searchParams.get('t'));
        const runner = runnerAt(Number(parts[2]), t);
        return send(res, 200, { t, runner });
      }
      if (parts[1] === 'runs' && parts.length === 5 && parts[3] === 'jobs' && method === 'GET') {
        return send(res, 200, jobTimeline(Number(parts[2]), parts[4]));
      }
      throw new SchedError(ERR.NOT_FOUND, `未知路由: ${method} ${url.pathname}`);
    } catch (e) {
      sendError(res, e);
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口
  const server = createServer();
  server.listen(port, () => {
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`SRTF 调度服务已启动: http://127.0.0.1:${actual}`);
  });
}
