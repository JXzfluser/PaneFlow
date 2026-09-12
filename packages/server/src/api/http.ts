import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { applyVariables, renderPromptTemplate, topoSort, validateDag } from '@paneflow/shared';
import type { DagGraph } from '@paneflow/shared';
import type { Engine, ApprovalAction } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import { Store } from '../orchestrate/store.js';
import type { SpaceProfile } from '../orchestrate/store.js';
import { GithubSync, loadSyncConfig, syncUnavailableReason } from './github-sync.js';
import { detectInstalledAgents } from './env-check.js';
import { notify, readNotifySettings, writeNotifySettings, type NotifySettings } from './notifier.js';
import { readGateway, writeGateway, buildGatewayEnv, type ModelGatewaySettings } from './gateway.js';
import { readGithubSettings, writeGithubSettings, buildGithubEnv, type GithubSettings } from './github-cred.js';

interface CreateIssueBody {
  title: string;
  body?: string;
  repo?: string;
  /** 需求简述（无 title 时由 Agent 调用前的草稿生成） */
  labels?: string[];
}

interface UpdateIssueBody {
  /** GitHub issue number（仓库内编号） */
  number: number;
  repo?: string;
  /** 就地更新的完整正文（覆盖原正文） */
  body: string;
}
import { registerFsRoutes } from './fs-routes.js';
import { buildDispatchGraph } from './dispatch.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadRoles, saveRoles, type Role } from '../orchestrate/roles.js';

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
  /** R4.1 远程暴露模式下的访问令牌（127.0.0.1 信任模式为 null） */
  authToken?: string | null;
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

  // R4.1 访问令牌：仅远程暴露模式启用（本机信任模式跳过）
  if (deps.authToken) {
    app.addHook('onRequest', async (req, reply) => {
      const url = ((req.url || '') as string).split('?')[0] ?? '';
      if (url === '/api/health') return;
      if (!url.startsWith('/api') && !url.startsWith('/ws')) return;
      if ((req.headers.authorization ?? '') !== `Bearer ${deps.authToken}`) {
        return reply.code(401).send({ error: '需要访问令牌（Authorization: Bearer <token>）' });
      }
    });
  }

  // R4.3 注入类端点审计日志（who=令牌模式/when/what），JSONL 落盘
  const audit = (action: string, detail: unknown): void => {
    try {
      fs.appendFileSync(
        path.join(deps.dataDir, 'audit.log'),
        JSON.stringify({ at: new Date().toISOString(), action, detail }) + '\n',
      );
    } catch {
      // 审计失败不阻塞主流程
    }
  };
  const auditedKeysInput = (
    action: string,
    runId: string,
    nodeId: string,
    detail: Record<string, unknown>,
  ): void => {
    audit(`terminal:${action}`, { runId, nodeId, ...detail });
  };
  registerFsRoutes(app, (space) => {
    try {
      return spaceStore(deps, space).readProfile().rootCwd ?? null;
    } catch {
      return null;
    }
  });

  // -- global roles library ----------------------------------------------------

  app.get('/api/roles', async () => ({ roles: loadRoles(deps.dataDir) }));

  app.put<{ Body: { roles: Role[] } }>('/api/roles', async (req, reply) => {
    const roles = req.body?.roles;
    if (!Array.isArray(roles)) return reply.code(400).send({ error: 'roles 必须是数组' });
    const ids = new Set<string>();
    for (const r of roles) {
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(r.id ?? '')) {
        return reply.code(400).send({ error: `角色 ID 非法：${r.id}` });
      }
      if (ids.has(r.id)) return reply.code(400).send({ error: `角色 ID 重复：${r.id}` });
      ids.add(r.id);
    }
    saveRoles(deps.dataDir, roles);
    return { saved: roles.length };
  });

  // -- model gateway ----------------------------------------------------------

  app.get('/api/gateway', async () => {
    const g = readGateway(deps.dataDir);
    return {
      baseUrl: g.baseUrl ?? '',
      freeModel: g.freeModel ?? '',
      enabled: g.enabled ?? false,
      keyConfigured: Boolean(g.apiKey),
    };
  });

  app.put<{ Body: ModelGatewaySettings }>('/api/gateway', async (req, reply) => {
    const { baseUrl, apiKey, freeModel, enabled } = req.body ?? {};
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
      return reply.code(400).send({ error: 'baseUrl 必须以 http(s):// 开头' });
    }
    const cur = readGateway(deps.dataDir);
    const next: ModelGatewaySettings = {
      baseUrl: baseUrl ?? cur.baseUrl,
      // 空 key = 保留已存值（避免回显泄露）
      apiKey: apiKey || cur.apiKey,
      freeModel: freeModel ?? cur.freeModel,
      enabled: enabled ?? cur.enabled ?? Boolean(baseUrl && apiKey),
    };
    writeGateway(deps.dataDir, next);
    return { saved: true, enabled: next.enabled };
  });

  app.post('/api/gateway/test', async () => {
    const env = buildGatewayEnv(deps.dataDir);
    if (!env.OPENAI_API_BASE) return { ok: false, error: '网关未配置或未启用' };
    try {
      const res = await fetch(`${env.OPENAI_API_BASE}/models`, {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as { data?: unknown[] };
      return { ok: res.ok, models: body.data?.length ?? 0 };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // -- github credentials ------------------------------------------------------

  app.get('/api/github/cred', async () => {
    const g = readGithubSettings(deps.dataDir);
    return { tokenConfigured: Boolean(g.token), defaultRepo: g.defaultRepo ?? '' };
  });

  app.put<{ Body: GithubSettings }>('/api/github/cred', async (req, reply) => {
    const { token, defaultRepo } = req.body ?? {};
    const cur = readGithubSettings(deps.dataDir);
    const next: GithubSettings = {
      token: token || cur.token,
      defaultRepo: defaultRepo ?? cur.defaultRepo,
    };
    writeGithubSettings(deps.dataDir, next);
    return { saved: true, tokenConfigured: Boolean(next.token) };
  });

  // -- github deterministic actions（服务端用配置的 PAT 直调 API，Agent 只需 curl 本地） --

  app.post<{ Body: CreateIssueBody; Querystring: { space?: string } }>(
    '/api/github/create-issue',
    async (req, reply) => {
      const gh = readGithubSettings(deps.dataDir);
      if (!gh.token) return reply.code(400).send({ error: '未配置 GitHub 凭据（设置页 → GitHub 凭据）' });
      const repo = req.body.repo ?? gh.defaultRepo;
      if (!repo) return reply.code(400).send({ error: '缺少 repo（未配置默认仓库）' });
      const title = String(req.body.title ?? '').trim();
      if (!title) return reply.code(400).send({ error: '缺少 title' });
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${gh.token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, body: req.body.body ?? '', labels: req.body.labels ?? [] }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = (await res.json()) as { number?: number; html_url?: string; message?: string };
        if (!res.ok) return reply.code(res.status).send({ error: data.message ?? `HTTP ${res.status}` });
        return { number: data.number, url: data.html_url, repo };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  app.patch<{ Body: UpdateIssueBody }>('/api/github/update-issue', async (req, reply) => {
    const gh = readGithubSettings(deps.dataDir);
    if (!gh.token) return reply.code(400).send({ error: '未配置 GitHub 凭据' });
    const repo = req.body.repo ?? gh.defaultRepo;
    if (!repo) return reply.code(400).send({ error: '缺少 repo（未配置默认仓库）' });
    const number = Number(req.body.number);
    if (!Number.isInteger(number) || number <= 0) return reply.code(400).send({ error: '缺少 number' });
    if (req.body.body === undefined) return reply.code(400).send({ error: '缺少 body' });
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${gh.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: String(req.body.body) }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json()) as { number?: number; html_url?: string; message?: string };
      if (!res.ok) return reply.code(res.status).send({ error: data.message ?? `HTTP ${res.status}` });
      return { number: data.number, url: data.html_url, repo };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

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

  // -- 智能下发（Smart Dispatch） ----------------------------------------------

  app.post<{ Body: { task: string; issueId?: string; cwd?: string }; Querystring: { space?: string } }>(
    '/api/dispatch',
    async (req, reply) => {
      const task = String(req.body?.task ?? '').trim();
      if (!task) return reply.code(400).send({ error: '缺少任务描述' });
      const store0 = spaceStore(deps, req.query.space);
      let rootCwd: string | undefined;
      try {
        rootCwd = store0.readProfile().rootCwd;
      } catch {
        rootCwd = undefined;
      }
      const cwd = String(req.body.cwd ?? '').trim() || rootCwd;
      if (!cwd) return reply.code(400).send({ error: '缺少工作目录（空间未配置 rootCwd 且未指定）' });
      const templateList = store0
        .listGraphs()
        .filter((g) => g.name !== 'builtin-issue-triage')
        .map((g) => ({ name: g.name, description: g.metadata.description }));
      const graph = buildDispatchGraph({
        task,
        issueId: req.body.issueId,
        cwd,
        templateList,
        rootCwd,
      });
      const run = await deps.engine.startRun(graph, cwd, req.query.space, { task }, req.body.issueId);
      return { runId: run.runId };
    },
  );

  // -- dry-run（B12 预演：展开变量、静态评估条件边、输出最终拓扑） -------------

  app.post<{ Body: { graph: DagGraph; cwd: string; variables?: Record<string, string> } }>(
    '/api/dry-run',
    async (req, reply) => {
      const { graph: rawGraph, cwd, variables } = req.body;
      if (!rawGraph) return reply.code(400).send({ error: '缺少 graph' });
      const applied = applyVariables(rawGraph, variables);
      if (applied.missing.length) {
        return reply.code(400).send({ error: `缺少必填参数：${applied.missing.join('、')}` });
      }
      const graph = applied.graph;
      const issues = validateDag(graph).filter((i) => i.level === 'error');
      if (issues.length) return reply.code(400).send({ error: issues.map((i) => i.message).join('；') });
      const roles = loadRoles(deps.dataDir);
      let rootCwd: string | undefined;
      try {
        rootCwd = spaceStore(deps, (req.query as { space?: string }).space).readProfile().rootCwd;
      } catch {
        rootCwd = undefined;
      }
      const order = topoSort(graph.nodes.map((n) => n.id), graph.edges)!;
      const warnings: string[] = [];
      const nodes = order.map((id) => {
        const n = graph.nodes.find((x) => x.id === id)!;
        const role = n.config.role ? roles.find((r) => r.id === n.config.role) : undefined;
        if (n.config.role && !role) warnings.push(`节点 ${id} 引用的角色 ${n.config.role} 不存在`);
        const agentKind = n.config.agentKind ?? role?.agentKind ?? (n.type === 'agent' ? undefined : undefined);
        if (n.type === 'agent' && !agentKind) warnings.push(`节点 ${id}（${n.label}）未配置 Agent 类型（角色也未提供默认值）`);
        const nodeCwd = n.config.cwd ? `${cwd}/${n.config.cwd}` : cwd;
        const checks = n.config.checks ?? [];
        if (n.type === 'fanout' && n.config.expand) {
          warnings.push(`动态扇出 ${id}：运行时按 {{${n.config.expand.from}.${n.config.expand.field}}} 展开分支（预演无法确定实例数）`);
        }
        return {
          id,
          type: n.type,
          label: n.label,
          role: role?.name ?? null,
          agentKind: agentKind ?? null,
          cwd: n.type === 'agent' ? nodeCwd : null,
          promptPreview: n.config.prompt ? renderPromptTemplate(n.config.prompt, () => '（运行时注入）').slice(0, 200) : null,
          checks: checks.map((c) => (c.type === 'command' ? `command: ${c.run}` : c.type === 'regex' ? `regex: ${c.file} ~ /${c.pattern}/` : c.type === 'manual' ? `manual: ${c.prompt}` : `file: ${(c as { path: string }).path}`)),
          conventions: rootCwd ?? null,
        };
      });
      const edges = graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        condition: e.condition ? `${e.condition.field}${e.condition.equals !== undefined ? ` == ${e.condition.equals}` : ''}${e.condition.notEquals !== undefined ? ` != ${e.condition.notEquals}` : ''}${e.condition.exists !== undefined ? (e.condition.exists ? ' 存在' : ' 不存在') : ''}（运行时评估）` : null,
      }));
      return { nodes, edges, warnings, variables: applied.graph.variables ?? [] };
    },
  );

  // -- runs -------------------------------------------------------------------

  app.post<{ Body: { graph?: DagGraph; graphId?: string; cwd: string; variables?: Record<string, string>; issueId?: string }; Querystring: { space?: string } }>(
    '/api/runs',
    async (req, reply) => {
      const { graph: inlineGraph, graphId, cwd } = req.body;
      const store = spaceStore(deps, req.query.space);
      const graph = inlineGraph ?? (graphId ? store.getGraph(graphId) : undefined);
      if (!graph) return reply.code(400).send({ error: '缺少 graph 或 graphId' });
      try {
        const run = await deps.engine.startRun(graph, cwd, req.query.space, req.body.variables, req.body.issueId);
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
      auditedKeysInput('keys', req.params.id, req.params.nodeId, { keys });
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
      auditedKeysInput('input', req.params.id, req.params.nodeId, { text: text.slice(0, 80) });
      await deps.ops.sendPaneText(rec.paneId, text);
      return { sent: true };
    },
  );

  app.get<{ Params: { id: string; nodeId: string }; Querystring: { lines?: string } }>(
    '/api/runs/:id/nodes/:nodeId/log',
    async (req, reply) => {
      const run = deps.engine.getRun(req.params.id);
      const rec = run?.nodes[req.params.nodeId];
      if (!run || !rec) return reply.code(404).send({ error: '节点不存在' });
      const lines = Math.min(1000, Math.max(1, Number(req.query.lines ?? 200)));
      if (rec.agentName) {
        try {
          const text = await deps.ops.readOutput(rec.agentName, lines);
          if (text.trim()) return { text, source: 'live' };
        } catch {
          // agent gone (run finished) → fall through to snapshots
        }
      }
      const snaps = rec.outputSnapshots ?? [];
      if (snaps.length) {
        return { text: snaps.map((sn) => sn.text).join('\n…\n').split('\n').slice(-lines).join('\n'), source: 'history' };
      }
      return { text: '', source: 'none' };
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
