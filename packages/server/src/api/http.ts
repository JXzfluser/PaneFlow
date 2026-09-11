import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import type { DagGraph } from '@paneflow/shared';
import type { Engine, ApprovalAction } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

export const AGENT_KINDS = [
  'opencode',
  'claude',
  'codex',
  'pi',
  'copilot',
  'devin',
  'droid',
  'kimi',
  'kilo',
  'hermes',
  'qwen',
  'qodercli',
  'cursor',
  'grok',
  'omp',
  'mastracode',
  'antigravity-cli',
] as const;

export interface HttpDeps {
  engine: Engine;
  store: Store;
  ops: HerdrOps;
  herdrSocketPath: string;
}

export async function buildHttpServer(deps: HttpDeps) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(fastifyWebsocket);

  // -- health ---------------------------------------------------------------

  app.get('/api/health', async () => {
    let herdrOk = false;
    try {
      await deps.ops.ping();
      herdrOk = true;
    } catch {
      herdrOk = false;
    }
    return { ok: true, herdrOk, herdrSocket: deps.herdrSocketPath, agentKinds: AGENT_KINDS };
  });

  // -- graphs (templates) -----------------------------------------------------

  app.get('/api/graphs', async () => ({ graphs: deps.store.listGraphs() }));

  app.get<{ Params: { id: string } }>('/api/graphs/:id', async (req, reply) => {
    const g = deps.store.getGraph(req.params.id);
    if (!g) return reply.code(404).send({ error: 'not found' });
    return g;
  });

  app.post<{ Body: { graph: DagGraph } }>('/api/graphs', async (req, reply) => {
    const { graph } = req.body;
    deps.store.saveGraph(graph);
    return reply.code(201).send(graph);
  });

  app.put<{ Params: { id: string }; Body: { graph: DagGraph } }>(
    '/api/graphs/:id',
    async (req, reply) => {
      const { graph } = req.body;
      if (graph.name !== req.params.id) {
        return reply.code(400).send({ error: 'graph.name 与 URL id 不一致' });
      }
      deps.store.saveGraph(graph);
      return graph;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/graphs/:id', async (req, reply) => {
    const ok = deps.store.deleteGraph(req.params.id);
    return { deleted: ok };
  });

  // -- runs -------------------------------------------------------------------

  app.post<{ Body: { graph?: DagGraph; graphId?: string; cwd: string } }>(
    '/api/runs',
    async (req, reply) => {
      const { graph: inlineGraph, graphId, cwd } = req.body;
      const graph = inlineGraph ?? (graphId ? deps.store.getGraph(graphId) : undefined);
      if (!graph) return reply.code(400).send({ error: '缺少 graph 或 graphId' });
      try {
        const run = await deps.engine.startRun(graph, cwd);
        return reply.code(201).send({ runId: run.runId, run });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get('/api/runs', async () => ({ runs: deps.engine.listRuns() }));

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = deps.engine.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    return run;
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (req, reply) => {
    const ok = deps.engine.stopRun(req.params.id);
    if (!ok) return reply.code(409).send({ error: '流水线未在运行' });
    return { stopping: true };
  });

  app.post<{ Params: { id: string; nodeId: string }; Body: ApprovalAction }>(
    '/api/runs/:id/nodes/:nodeId/approve',
    async (req, reply) => {
      const ok = await deps.engine.approve(req.params.id, req.params.nodeId, req.body);
      if (!ok) return reply.code(409).send({ error: '该节点当前未在等待审批' });
      return { delivered: true };
    },
  );

  app.post<{ Params: { id: string; nodeId: string }; Body: { keys: string[] } }>(
    '/api/runs/:id/nodes/:nodeId/keys',
    async (req, reply) => {
      const run = deps.engine.getRun(req.params.id);
      const rec = run?.nodes[req.params.nodeId];
      if (!run || !rec?.agentName) return reply.code(404).send({ error: '节点无活跃 agent' });
      const keys = Array.isArray(req.body.keys) ? req.body.keys.slice(0, 8).map(String) : [];
      if (!keys.length) return reply.code(400).send({ error: 'keys 不能为空' });
      await deps.ops.sendKeys(rec.agentName, keys);
      return { sent: keys };
    },
  );

  app.post<{ Params: { id: string; nodeId: string }; Body: { text: string } }>(
    '/api/runs/:id/nodes/:nodeId/input',
    async (req, reply) => {
      const run = deps.engine.getRun(req.params.id);
      const rec = run?.nodes[req.params.nodeId];
      if (!run || !rec?.agentName) return reply.code(404).send({ error: '节点无活跃 agent' });
      const text = String(req.body.text ?? '').slice(0, 20_000);
      if (!text.trim()) return reply.code(400).send({ error: 'text 不能为空' });
      if (!rec.paneId) return reply.code(409).send({ error: '节点无关联 pane' });
      await deps.ops.sendPaneText(rec.paneId, text);
      return { sent: true };
    },
  );

  app.get<{ Params: { id: string; nodeId: string }; Querystring: { lines?: string } }>(
    '/api/runs/:id/nodes/:nodeId/log',
    async (req, reply) => {
      const run = deps.engine.getRun(req.params.id);
      const rec = run?.nodes[req.params.nodeId];
      if (!run || !rec?.agentName) return reply.code(404).send({ error: '节点无终端输出' });
      const lines = Math.min(1000, Math.max(1, Number(req.query.lines ?? 200)));
      const text = await deps.ops.readOutput(rec.agentName, lines);
      return { text };
    },
  );

  // -- websocket broadcast ------------------------------------------------------

  const clients = new Set<{ socket: { send: (s: string) => void } }>();
  const push = (payload: unknown): void => {
    const line = JSON.stringify(payload);
    for (const c of clients) {
      try {
        c.socket.send(line);
      } catch {
        // dropped client — cleaned up on close
      }
    }
  };
  deps.engine.onChange((run) => push({ type: 'run', run }));

  app.get('/ws', { websocket: true }, (conn) => {
    const client = { socket: conn as unknown as { send: (s: string) => void } };
    clients.add(client);
    // initial snapshot
    for (const run of deps.engine.listRuns()) {
      client.socket.send(JSON.stringify({ type: 'run', run }));
    }
    (conn as unknown as { on: (ev: string, cb: () => void) => void }).on('close', () => clients.delete(client));
  });

  return { app, push };
}
