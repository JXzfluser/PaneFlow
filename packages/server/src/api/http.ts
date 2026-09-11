import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import type { DagGraph } from '@paneflow/shared';
import type { Engine, ApprovalAction } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import { Store } from '../orchestrate/store.js';
import type { SpaceProfile } from '../orchestrate/store.js';
import { GithubSync, loadSyncConfig, syncUnavailableReason } from './github-sync.js';
import { detectInstalledAgents } from './env-check.js';
import { notify, readNotifySettings, writeNotifySettings, type NotifySettings } from './notifier.js';

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
  /** dataDir root — Space stores are derived from it */
  dataDir: string;
}

const DEFAULT_SPACE = 'default';

function spaceStore(deps: HttpDeps, spaceQuery: unknown): Store {
  const space = typeof spaceQuery === 'string' && spaceQuery ? spaceQuery : DEFAULT_SPACE;
  return new Store(deps.dataDir, space);
}

export async function buildHttpServer(deps: HttpDeps) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(fastifyWebsocket);

  // -- notification settings -------------------------------------------------

  app.get('/api/notify/settings', async () => {
    const s = readNotifySettings(deps.dataDir);
    return { ...s, feishuWebhook: s.feishuWebhook ? '(已配置)' : '' };
  });

  app.put<{ Body: NotifySettings }>('/api/notify/settings', async (req, reply) => {
    const { feishuWebhook, notifyEvents } = req.body ?? {};
    if (feishuWebhook !== undefined && feishuWebhook !== '' && !/^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\//.test(feishuWebhook)) {
      return reply.code(400).send({ error: 'webhook 必须是飞书开放平台地址（open.feishu.cn / open.larksuite.com）' });
    }
    const next: NotifySettings = {
      ...(feishuWebhook ? { feishuWebhook } : {}),
      ...(notifyEvents ? { notifyEvents } : {}),
    };
    writeNotifySettings(deps.dataDir, next);
    return { saved: true };
  });

  // -- spaces ---------------------------------------------------------------

  app.get('/api/spaces', async () => ({ spaces: Store.listSpaces(deps.dataDir) }));

  app.post<{ Body: { id: string; name: string } }>('/api/spaces', async (req, reply) => {
    const { id, name } = req.body;
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id ?? '')) {
      return reply.code(400).send({ error: '空间 ID 只能包含字母/数字/-/_（≤32 字符）' });
    }
    if (!name?.trim()) return reply.code(400).send({ error: '缺少空间名称' });
    return reply.code(201).send(Store.createSpace(deps.dataDir, id, name.trim()));
  });

  app.get<{ Params: { id: string } }>('/api/spaces/:id', async (req, reply) => {
    const store = spaceStore(deps, req.params.id);
    return store.readProfile();
  });

  app.put<{ Params: { id: string }; Body: Partial<SpaceProfile> }>(
    '/api/spaces/:id',
    async (req, reply) => {
      const store = spaceStore(deps, req.params.id);
      const profile = store.readProfile();
      const next = { ...profile, ...req.body, id: req.params.id };
      store.writeProfile(next);
      return next;
    },
  );

  // -- health ---------------------------------------------------------------

  app.get('/api/health', async () => {
    let herdrOk = false;
    let herdrVersion: string | null = null;
    try {
      const pong = (await deps.ops.ping()) as { version?: string } | undefined;
      herdrOk = true;
      herdrVersion = pong?.version ?? null;
    } catch {
      herdrOk = false;
    }
    const agentsInstalled = herdrOk ? await detectInstalledAgents([...AGENT_KINDS]) : [];
    return {
      ok: true,
      herdrOk,
      herdrVersion,
      herdrSocket: deps.herdrSocketPath,
      agentKinds: AGENT_KINDS,
      env: {
        nodeVersion: process.version,
        agentsInstalled,
        agentsMissing: AGENT_KINDS.filter((k) => !agentsInstalled.includes(k)),
      },
    };
  });

  // -- graphs (templates) -----------------------------------------------------

  app.get<{ Querystring: { space?: string } }>('/api/graphs', async (req) => ({
    graphs: spaceStore(deps, req.query.space).listGraphs(),
  }));

  app.get<{ Params: { id: string }; Querystring: { space?: string } }>('/api/graphs/:id', async (req, reply) => {
    const g = spaceStore(deps, req.query.space).getGraph(req.params.id);
    if (!g) return reply.code(404).send({ error: 'not found' });
    return g;
  });

  app.post<{ Body: { graph: DagGraph }; Querystring: { space?: string } }>('/api/graphs', async (req, reply) => {
    const { graph } = req.body;
    spaceStore(deps, req.query.space).saveGraph(graph);
    return reply.code(201).send(graph);
  });

  app.put<{ Params: { id: string }; Body: { graph: DagGraph }; Querystring: { space?: string } }>(
    '/api/graphs/:id',
    async (req, reply) => {
      const { graph } = req.body;
      if (graph.name !== req.params.id) {
        return reply.code(400).send({ error: 'graph.name 与 URL id 不一致' });
      }
      spaceStore(deps, req.query.space).saveGraph(graph);
      return graph;
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { space?: string } }>('/api/graphs/:id', async (req, reply) => {
    const ok = spaceStore(deps, req.query.space).deleteGraph(req.params.id);
    return { deleted: ok };
  });

  // -- runs -------------------------------------------------------------------

  app.post<{ Body: { graph?: DagGraph; graphId?: string; cwd: string; variables?: Record<string, string> }; Querystring: { space?: string } }>(
    '/api/runs',
    async (req, reply) => {
      const { graph: inlineGraph, graphId, cwd } = req.body;
      const store = spaceStore(deps, req.query.space);
      const graph = inlineGraph ?? (graphId ? store.getGraph(graphId) : undefined);
      if (!graph) return reply.code(400).send({ error: '缺少 graph 或 graphId' });
      try {
        const run = await deps.engine.startRun(graph, cwd, req.query.space, req.body.variables);
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

  // -- GitHub 沉淀（可选，弱依赖，异步非阻塞） ---------------------------------

  app.get('/api/sync/status', async () => {
    const cfg = loadSyncConfig();
    return { configured: cfg !== null, repo: cfg?.repo ?? null, dir: cfg?.dir ?? null };
  });

  app.post('/api/sync/push', async (req, reply) => {
    const cfg = loadSyncConfig();
    if (!cfg) return reply.code(400).send({ error: syncUnavailableReason() });
    const sync = new GithubSync(cfg, spaceStore(deps, (req.query as { space?: string }).space));
    // async, non-blocking: return immediately, results land in the run log
    void sync
      .pushAll()
      .then((r) =>
        console.log(
          `[sync] push 完成: ${r.pushed.length} 个模板已沉淀${r.failed.length ? `，失败 ${r.failed.length}: ${r.failed.map((f) => `${f.file}(${f.error})`).join('；')}` : ''}`,
        ),
      )
      .catch((err) => console.error('[sync] push 异常:', (err as Error).message));
    return { started: true };
  });

  app.post('/api/sync/pull', async (req, reply) => {
    const cfg = loadSyncConfig();
    if (!cfg) return reply.code(400).send({ error: syncUnavailableReason() });
    try {
      const sync = new GithubSync(cfg, spaceStore(deps, (req.query as { space?: string }).space));
      const r = await sync.pullAll();
      return { imported: r.imported, failed: r.failed };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // -- websocket broadcast ------------------------------------------------------

  const clients = new Set<{ socket: { send: (s: string) => void } }>();
  const notified = new Set<string>();
  deps.engine.onChange((run) => {
    // outbound notifications on state transitions (deduped per run+event)
    const events: ('blocked' | 'completed' | 'failed')[] = [];
    if (Object.values(run.nodes).some((n) => n.state === 'blocked')) events.push('blocked');
    if (run.state === 'completed') events.push('completed');
    if (run.state === 'failed') events.push('failed');
    for (const ev of events) {
      const key = `${run.runId}:${ev}`;
      if (notified.has(key)) continue;
      notified.add(key);
      const blocked = Object.values(run.nodes).filter((n) => n.state === 'blocked').map((n) => n.nodeId);
      notify(
        deps.dataDir,
        ev,
        `${run.dagName}（run ${run.runId}）${ev === 'blocked' ? `节点 ${blocked.join('、')} 等待人工审批` : ''}`,
      );
    }
  });
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
