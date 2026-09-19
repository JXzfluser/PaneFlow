import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { applyVariables, renderPromptTemplate, topoSort, validateDag } from '@paneflow/shared';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import type { Engine, ApprovalAction } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import { Store } from '../orchestrate/store.js';
import type { SpaceProfile } from '../orchestrate/store.js';
import { GithubSync, loadSyncConfig, syncUnavailableReason } from './github-sync.js';
import { loadContractLibrary, matchContractTemplate, renderContractTemplateBlock } from '../orchestrate/contract-templates.js';
import { detectInstalledAgents } from './env-check.js';
import {
  dispatchChannels,
  readChannels,
  sendChannel,
  writeChannels,
  type Channel,
} from './channels.js';
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
import { buildDispatchGraph, extractAcceptance, parseIssueRef, type IssueView } from './dispatch.js';
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
  'gemini',
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
  /** G2：CORS / 跨站 Origin 白名单（空数组 = 默认拒绝跨站） */
  corsOrigins?: string[];
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * G2 跨站 Origin 校验（纯函数便于单测）。放行：
 * ①无 Origin 头——curl/脚本/CLI/服务端代理等非浏览器来源；
 * ②同源——Origin 的 host 与请求 Host 相同（生产静态托管与 vite proxy 均落此列）；
 * ③白名单精确匹配（scheme+host+port）。其余拒绝；Origin 解析失败即拒。
 * 注：origin:false 挡不住 simple request（无 preflight 直达服务器），故写方法必须服务端自查。
 */
export function isAllowedOrigin(opts: {
  origin: string | undefined;
  host: string | undefined;
  allowed: readonly string[];
}): boolean {
  if (!opts.origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(opts.origin);
  } catch {
    return false;
  }
  if (opts.host && parsed.host === opts.host) return true;
  return opts.allowed.includes(parsed.origin);
}

const DEFAULT_SPACE = 'default';

/** PUT /api/spaces/:id 可编辑字段白名单（与 SettingsView 表单一一对应；rules=M3 配置文件面） */
const PROFILE_EDITABLE_KEYS = ['rootCwd', 'description', 'conventionFiles', 'rules', 'skills', 'repos', 'defaultAgentKind'] as const;

function spaceStore(deps: HttpDeps, spaceQuery: unknown): Store {
  const space = typeof spaceQuery === 'string' && spaceQuery ? spaceQuery : DEFAULT_SPACE;
  return new Store(deps.dataDir, space);
}

export async function buildHttpServer(deps: HttpDeps) {
  const app = Fastify({ logger: false });
  // G2：不再全反射 Origin。白名单为空时不回 CORS 头（浏览器跨站读取全部失败）；
  // 写方法的硬拦截见下方 onRequest 钩子（simple request 不触发 preflight，只能服务端自查）。
  const corsOrigins = deps.corsOrigins ?? [];
  await app.register(cors, { origin: corsOrigins.length > 0 ? corsOrigins : false });

  app.addHook('onRequest', async (req, reply) => {
    if (!MUTATING_METHODS.has(req.method)) return;
    const url = ((req.url || '') as string).split('?')[0] ?? '';
    if (!url.startsWith('/api')) return;
    if (!isAllowedOrigin({ origin: req.headers.origin, host: req.headers.host, allowed: corsOrigins })) {
      return reply.code(403).send({ error: '跨站请求被拒绝（同源之外需配置 PF_CORS_ORIGINS）' });
    }
  });

  await app.register(fastifyWebsocket);

  // R6.2 一键启动：服务端托管前端构建产物（生产模式无需 vite/proxy）
  const candidates = [
    path.join(process.cwd(), 'packages/web/dist'),
    path.join(process.cwd(), 'dist'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      await app.register(fastifyStatic, { root: candidate, prefix: '/' });
      // SPA 回退：非 /api //ws 路径回 index.html
      app.setNotFoundHandler((req, reply) => {
        const url = ((req.url || '') as string).split('?')[0] ?? '';
        if (url.startsWith('/api') || url.startsWith('/ws')) {
          return reply.code(404).send({ error: 'not found' });
        }
        return reply.type('text/html').send(fs.readFileSync(path.join(candidate, 'index.html')));
      });
      break;
    }
  }

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

  // v8-M6 契约模板与断言语式库：空间资产是文本文件（改文件即改约定，不建编辑器）
  app.get<{ Querystring: { space?: string } }>('/api/contract-templates', async (req) => {
    const s = spaceStore(deps, req.query.space);
    const lib = loadContractLibrary(path.join(s.root, 'spaces', s.spaceId));
    return {
      dir: lib.dir,
      templates: lib.templates.map((lt) => ({
        id: lt.template.id,
        title: lt.template.title,
        sha: lt.sha,
        source: lt.source,
        keywords: lt.template.matchKeywords,
        assertions: lt.template.assertions.length,
        questions: lt.template.questions.length,
        file: lt.file ?? null,
      })),
      assertionPatterns: lib.assertionPatterns,
      clarifyQuestions: lib.clarifyQuestions,
    };
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

  // -- G1 Issue 读取器：真实需求载体的读侧（写侧见 create-issue/update-issue） ----

  /** 拉取 issue 正文+评论（REST 直调，凭据走既有 GH_TOKEN→dataDir 回退链）；失败抛错由调用方降级 */
  const fetchGithubIssue = async (number: number, repoOverride?: string): Promise<IssueView> => {
    const gh = readGithubSettings(deps.dataDir);
    if (!gh.token) throw new Error('未配置 GitHub 凭据（设置页 → GitHub 凭据）');
    const repo = repoOverride?.trim() || gh.defaultRepo;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repo 非法或缺少（收到：${repo ?? '空'}）`);
    const headers = { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json' };
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, { headers, signal: AbortSignal.timeout(15_000) });
    const data = (await res.json()) as {
      number?: number; title?: string; body?: string | null; state?: string; html_url?: string;
      labels?: { name?: string }[]; message?: string;
    };
    if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
    let comments: { author: string; body: string }[] = [];
    try {
      const cres = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments?per_page=30`, { headers, signal: AbortSignal.timeout(15_000) });
      if (cres.ok) {
        const clist = (await cres.json()) as { user?: { login?: string }; body?: string | null }[];
        comments = clist.map((c) => ({ author: c.user?.login ?? '?', body: String(c.body ?? '') }));
      }
    } catch {
      // 评论读取失败不阻断：正文已到手，评论是增强
    }
    return {
      number: data.number ?? number,
      repo,
      title: data.title ?? '',
      body: data.body ?? '',
      state: data.state ?? 'open',
      url: data.html_url ?? '',
      labels: (data.labels ?? []).map((l) => String(l.name ?? '')).filter(Boolean),
      comments,
    };
  };

  app.get<{ Params: { number: string }; Querystring: { repo?: string } }>(
    '/api/issues/:number',
    async (req, reply) => {
      const number = Number(req.params.number);
      if (!Number.isInteger(number) || number <= 0) return reply.code(400).send({ error: 'issue 编号非法' });
      try {
        return await fetchGithubIssue(number, req.query.repo);
      } catch (err) {
        const msg = (err as Error).message;
        if (/not found/i.test(msg)) return reply.code(404).send({ error: msg });
        if (/HTTP 4\d\d/.test(msg) || msg.includes('凭据') || msg.includes('repo')) return reply.code(400).send({ error: msg });
        return reply.code(502).send({ error: msg });
      }
    },
  );

  // -- outbound channels ----------------------------------------------------

  /** 出参脱敏：加签密钥不回传明文，'(已配置)' 作为"保留原值"的标记。 */
  const mask = (list: Channel[]): Channel[] =>
    list.map((c) => ({ ...c, secret: c.secret ? '(已配置)' : undefined }));

  app.get('/api/channels', async () => ({ channels: mask(readChannels(deps.dataDir)) }));

  app.put<{ Body: { channels: Channel[] } }>('/api/channels', async (req, reply) => {
    const next = req.body?.channels;
    if (!Array.isArray(next)) return reply.code(400).send({ error: 'channels 必须是数组' });
    const prev = readChannels(deps.dataDir);
    const prevById = new Map(prev.map((c) => [c.id, c]));
    const merged: Channel[] = next.map((c) => {
      const old = prevById.get(c.id);
      // 前端拿不到明文密钥；'(已配置)' 或缺失都表示沿用原值
      const secret = c.secret && c.secret !== '(已配置)' ? c.secret : old?.secret;
      return { ...c, ...(secret ? { secret } : { secret: undefined }) };
    });
    writeChannels(deps.dataDir, merged);
    return { saved: true, channels: mask(merged) };
  });

  app.post<{ Body: { channel: Channel } }>('/api/channels/test', async (req, reply) => {
    const ch = req.body?.channel;
    if (!ch?.url) return reply.code(400).send({ error: '通道缺少接收地址' });
    const prev = readChannels(deps.dataDir).find((c) => c.id === ch.id);
    const secret = ch.secret && ch.secret !== '(已配置)' ? ch.secret : prev?.secret;
    const r = await sendChannel({ ...ch, ...(secret ? { secret } : {}) }, {
      event: 'blocked',
      title: 'PaneFlow 通道测试',
      body: `这是一条来自「${ch.name || ch.type}」的测试消息，收到即表示通道配置正确。`,
      dagName: '(test)',
    });
    if (!r.ok) return reply.code(502).send({ error: r.error ?? '发送失败' });
    return { sent: true };
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
      // M3：rules 无编辑器（配置文件为主），但经 API 写脏形状会让作用域匹配静默失效——机检一把
      const rules = (req.body as Record<string, unknown> | undefined)?.rules;
      if (
        rules !== undefined &&
        (!Array.isArray(rules) ||
          rules.some((x) => !x || typeof x !== 'object' || typeof (x as { file?: unknown }).file !== 'string'))
      ) {
        return reply.code(400).send({ error: 'rules 必须是 {file, repo?, pathsGlob?, note?} 条目数组' });
      }
      // 白名单：只接受可编辑字段，id/name/createdAt 等身份字段不可经 body 注入
      const patch: Partial<SpaceProfile> = {};
      for (const key of PROFILE_EDITABLE_KEYS) {
        if (req.body && key in req.body) Object.assign(patch, { [key]: req.body[key] });
      }
      const next = { ...profile, ...patch, id: req.params.id };
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

  app.post<{ Body: { task: string; issueId?: string; cwd?: string; preview?: boolean }; Querystring: { space?: string } }>(
    '/api/dispatch',
    async (req, reply) => {
      const task = String(req.body?.task ?? '').trim();
      if (!task) return reply.code(400).send({ error: '缺少任务描述' });
      const store0 = spaceStore(deps, req.query.space);
      let rootCwd: string | undefined;
      let plannerAgentKind: string | undefined;
      try {
        const profile = store0.readProfile();
        rootCwd = profile.rootCwd;
        // E'：Planner agent 取空间档案默认值；非法值回落缺省（buildDispatchGraph 内兜底）
        plannerAgentKind = profile.defaultAgentKind && (AGENT_KINDS as readonly string[]).includes(profile.defaultAgentKind)
          ? profile.defaultAgentKind
          : undefined;
      } catch {
        rootCwd = undefined;
      }
      const cwd = String(req.body.cwd ?? '').trim() || rootCwd;
      if (!cwd) return reply.code(400).send({ error: '缺少工作目录（空间未配置 rootCwd 且未指定）' });
      // G1：任务文本里贴了 issue URL/#123 即自动识别编号与 repo
      let issueId = typeof req.body.issueId === 'string' ? req.body.issueId.trim() : '';
      let issueRepo: string | undefined;
      if (!issueId) {
        const ref = parseIssueRef(task);
        if (ref) {
          issueId = String(ref.number);
          issueRepo = ref.repo;
        }
      }
      let issueContext: IssueView | undefined;
      let issueNote: string | undefined;
      if (issueId && /^\d+$/.test(issueId)) {
        try {
          issueContext = await fetchGithubIssue(Number(issueId), issueRepo);
        } catch (err) {
          issueNote = `Issue #${issueId} 正文读取失败（${(err as Error).message}），本次仅按任务描述执行`;
        }
      }
      const templateList = store0
        .listGraphs()
        .filter((g) => g.name !== 'builtin-issue-triage')
        .map((g) => ({ name: g.name, description: g.metadata.description }));
      // M1 接单门：先机检 DoR——任务/Issue 正文里有「验收标准」小节就直接当契约用，
      // 没有则由 Planner 立约 + 引擎契约门拦住（契约未确认下游不派）。
      const contractAssertions = extractAcceptance(
        issueContext ? `${task}\n\n${issueContext.body}` : task,
      );
      // M6：无机检契约时按关键词择契约骨架模板实例化（留痕戳进门的 check 里带走）
      const contractLib = loadContractLibrary(path.join(store0.root, 'spaces', store0.spaceId));
      const tplHit = contractAssertions.length
        ? null
        : matchContractTemplate(
            `${task}\n${issueContext?.title ?? ''}\n${issueContext?.body ?? ''}`,
            contractLib,
          );
      const graph = buildDispatchGraph({
        task,
        issueId: issueId || undefined,
        cwd,
        templateList,
        rootCwd,
        preview: req.body.preview === true,
        plannerAgentKind,
        issueContext,
        contractAssertions,
        contractTemplate: tplHit
          ? { stamp: `${tplHit.template.id}@${tplHit.sha}`, block: renderContractTemplateBlock(tplHit, contractLib) }
          : undefined,
      });
      const run = await deps.engine.startRun(
        graph,
        cwd,
        req.query.space,
        { task },
        issueId || undefined,
        undefined,
        // M2：机检契约随单落册（run 的首个结构化产物）；无契约模式由契约门谈定后落
        contractAssertions.length
          ? {
              contract: {
                assertions: contractAssertions.map((a, i) => ({
                  id: `AC-${i + 1}`,
                  assertion: a,
                  verify_method: '',
                })),
                questions: [],
                source: 'input' as const,
              },
            }
          : undefined,
      );
      return {
        runId: run.runId,
        issueId: issueId || undefined,
        issueFetched: Boolean(issueContext),
        note: issueNote,
        contract: contractAssertions.length
          ? { mode: 'extracted' as const, assertions: contractAssertions.length }
          : { mode: 'gate' as const, template: tplHit ? `${tplHit.template.id}@${tplHit.sha}` : undefined },
      };
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
        const agentKind = n.config.agentKind ?? role?.agentKind;
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

  app.post<{ Body: { graph?: DagGraph; graphId?: string; cwd: string; variables?: Record<string, string>; issueId?: string; resumeOf?: string }; Querystring: { space?: string } }>(
    '/api/runs',
    async (req, reply) => {
      const { graph: inlineGraph, graphId, cwd } = req.body;
      const store = spaceStore(deps, req.query.space);
      const graph = inlineGraph ?? (graphId ? store.getGraph(graphId) : undefined);
      if (!graph) return reply.code(400).send({ error: '缺少 graph 或 graphId' });
      try {
        const run = await deps.engine.startRun(graph, cwd, req.query.space, req.body.variables, req.body.issueId, req.body.resumeOf);
        return reply.code(201).send({ runId: run.runId, run });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Querystring: { archived?: string } }>('/api/runs', async (req) => {
    if (req.query.archived === '1') {
      // v7-A2：跨空间收集归档记录
      const runs = Store.listSpaces(deps.dataDir)
        .flatMap((sp) => new Store(deps.dataDir, sp.id).listArchivedRuns())
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return { runs };
    }
    return { runs: deps.engine.listRuns() };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = deps.engine.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    return run;
  });

  // R5.3 事件时间线
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (req, reply) => {
    const run = deps.engine.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    return { runId: run.runId, events: run.events ?? [] };
  });

  // R5.1 归档（记录保留、移出主列表）——落盘必须走 run 所属空间的 store，否则非默认空间的记录会被复制而非移动
  app.post<{ Params: { id: string } }>('/api/runs/:id/archive', async (req, reply) => {
    const run = deps.engine.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.state === 'running') return reply.code(409).send({ error: '运行中的流水线不能归档，请先停止' });
    run.archived = true;
    const store = run.spaceId ? new Store(deps.dataDir, run.spaceId) : deps.store;
    store.saveRun(run);
    deps.engine.evictRun(run.runId);
    return { archived: true };
  });

  // v7-A2 反归档：archive/ → 主列表，并回注引擎内存
  app.post<{ Params: { id: string } }>('/api/runs/:id/unarchive', async (req, reply) => {
    for (const sp of Store.listSpaces(deps.dataDir)) {
      const rec = new Store(deps.dataDir, sp.id).unarchiveRun(req.params.id);
      if (rec) {
        deps.engine.restoreRun(rec);
        return { restored: true, run: rec };
      }
    }
    return reply.code(404).send({ error: '未找到归档记录' });
  });

  // v7-A2 真删除：仅作用于已归档记录（主列表记录须先归档）。
  // v8-H2 联动：purgeArtifacts=1 时一并清理本 run 节点的产物文件（默认不清——留痕优先）
  app.delete<{ Params: { id: string }; Querystring: { purgeArtifacts?: string } }>('/api/runs/:id/archive', async (req, reply) => {
    for (const sp of Store.listSpaces(deps.dataDir)) {
      const spaceStore = new Store(deps.dataDir, sp.id);
      const rec = spaceStore.getArchivedRun(req.params.id);
      if (!rec || !spaceStore.deleteArchivedRun(req.params.id)) continue;
      let purgedArtifacts = 0;
      if (req.query.purgeArtifacts === '1') {
        const artDir = path.join(rec.cwd, '.herdr', 'artifacts');
        const names = new Set((rec.graph?.nodes ?? []).map((n) => `${n.id}.json`));
        try {
          for (const f of fs.readdirSync(artDir)) {
            if (!names.has(f)) continue;
            try {
              if (fs.statSync(path.join(artDir, f)).isFile()) {
                fs.unlinkSync(path.join(artDir, f));
                purgedArtifacts += 1;
              }
            } catch {
              // 单个文件清不掉不阻断删除
            }
          }
        } catch {
          // 无产物目录 = 无可清理
        }
      }
      return { deleted: true, purgedArtifacts };
    }
    return reply.code(404).send({ error: '未找到归档记录（真删除只对已归档记录生效）' });
  });

  /** v8-H2：run 记录寻址——内存 → 当前空间盘 → 各空间归档（导出/货架共用） */
  const findRunRecord = (runId: string): RunRecord | undefined => {
    const live = deps.engine.getRun(runId) ?? deps.store.getRun(runId);
    if (live) return live;
    for (const sp of Store.listSpaces(deps.dataDir)) {
      const rec = new Store(deps.dataDir, sp.id).getArchivedRun(runId);
      if (rec) return rec;
    }
    return undefined;
  };

  // R5.1 导出单次 run 完整记录（v7-A2：归档记录跨空间可寻）
  app.get<{ Params: { id: string } }>('/api/runs/:id/export', async (req, reply) => {
    const run = findRunRecord(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', `attachment; filename="${run.runId}.json"`);
    return run;
  });

  // v8-H2 产物货架：列 <run.cwd>/.herdr/artifacts 下的产物文件（文件名能对上节点 ID 的挂上节点信息）
  app.get<{ Params: { id: string } }>('/api/runs/:id/artifacts', async (req, reply) => {
    const run = findRunRecord(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    const dir = path.join(run.cwd, '.herdr', 'artifacts');
    type Entry = {
      name: string;
      size: number;
      mtime: string;
      nodeId?: string;
      nodeLabel?: string;
      nodeState?: string;
      unverified?: boolean;
    };
    const files: Entry[] = [];
    const walk = (d: string, rel: string) => {
      if (files.length >= 300) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        const relName = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          walk(path.join(d, ent.name), relName);
        } else if (ent.isFile()) {
          try {
            const st = fs.statSync(path.join(d, ent.name));
            const e: Entry = { name: relName, size: st.size, mtime: st.mtime.toISOString() };
            const m = relName.match(/^([^/]+)\.json$/);
            const nodeId = m ? run.graph?.nodes.find((n) => n.id === m[1])?.id : undefined;
            if (nodeId) {
              e.nodeId = nodeId;
              e.nodeLabel = run.graph?.nodes.find((n) => n.id === nodeId)?.label;
              e.nodeState = run.nodes[nodeId]?.state;
              e.unverified = run.nodes[nodeId]?.unverified;
            }
            files.push(e);
          } catch {
            // 竞态删除等：跳过
          }
          if (files.length >= 300) return;
        }
      }
    };
    walk(dir, '');
    files.sort((a, b) => a.mtime < b.mtime ? -1 : 1);
    return { runId: run.runId, dir, exists: fs.existsSync(dir), files };
  });

  // v8-H2 产物单文件读取：路径严格锁在产物目录内（防穿越）；raw=1 作下载
  app.get<{ Params: { id: string }; Querystring: { path?: string; raw?: string } }>(
    '/api/runs/:id/artifacts/file',
    async (req, reply) => {
      const run = findRunRecord(req.params.id);
      if (!run) return reply.code(404).send({ error: 'not found' });
      const dir = path.join(run.cwd, '.herdr', 'artifacts');
      const rel = req.query.path ?? '';
      if (!rel) return reply.code(400).send({ error: '缺少 path 参数' });
      const full = path.resolve(dir, rel);
      if (full !== dir && !full.startsWith(dir + path.sep)) {
        return reply.code(400).send({ error: '路径非法（只允许读取产物目录内文件）' });
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        return reply.code(404).send({ error: '文件不存在' });
      }
      if (!st.isFile()) return reply.code(400).send({ error: '不是文件' });
      if (st.size > 5_000_000) return reply.code(413).send({ error: '产物文件过大（>5MB），请走导出或磁盘直读' });
      if (req.query.raw === '1') {
        const ext = path.extname(full).toLowerCase();
        const type = ext === '.json' ? 'application/json' : ext === '.md' ? 'text/markdown' : 'text/plain';
        reply.header('Content-Disposition', `attachment; filename="${path.basename(full)}"`);
        return reply.type(`${type}; charset=utf-8`).send(fs.readFileSync(full));
      }
      const buf = fs.readFileSync(full);
      const head = buf.subarray(0, 1024);
      if (head.includes(0)) return reply.code(415).send({ error: '二进制文件，不内联预览（可下载）' });
      const cap = 1_000_000;
      return {
        path: rel,
        size: st.size,
        truncated: st.size > cap,
        content: buf.subarray(0, cap).toString('utf8'),
      };
    },
  );


  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (req, reply) => {
    const ok = deps.engine.stopRun(req.params.id);
    if (!ok) return reply.code(409).send({ error: '流水线未在运行' });
    return { stopping: true };
  });

  app.post<{ Params: { id: string; nodeId: string }; Body: ApprovalAction }>(
    '/api/runs/:id/nodes/:nodeId/approve',
    async (req, reply) => {
      const ok = await deps.engine.approve(req.params.id, req.params.nodeId, req.body);
      if (!ok) {
        const rec = deps.engine.getRun(req.params.id)?.nodes[req.params.nodeId];
        return reply.code(409).send({
          error:
            rec?.state === 'paused'
              ? '服务重启后该审批已暂停，无法原位追认：请在运行中心点「⤴ 续跑」，重跑到该节点会再次弹出审批'
              : '该节点当前未在等待审批',
        });
      }
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
    const cfg = loadSyncConfig(process.env, deps.dataDir);
    return { configured: cfg !== null, repo: cfg?.repo ?? null, dir: cfg?.dir ?? null };
  });

  app.post('/api/sync/push', async (req, reply) => {
    const cfg = loadSyncConfig(process.env, deps.dataDir);
    if (!cfg) return reply.code(400).send({ error: syncUnavailableReason(process.env, deps.dataDir) });
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
    const cfg = loadSyncConfig(process.env, deps.dataDir);
    if (!cfg) return reply.code(400).send({ error: syncUnavailableReason(process.env, deps.dataDir) });
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
  // 去重记录按 runId 分组，run 到终态即整组释放
  // （旧实现是一个全局 Set 只增不清，长跑服务会一直涨且重启后失效）
  const notified = new Map<string, Set<string>>();
  deps.engine.onChange((run) => {
    // outbound notifications on state transitions (deduped per run+event)
    const events: ('blocked' | 'completed' | 'failed')[] = [];
    if (Object.values(run.nodes).some((n) => n.state === 'blocked')) events.push('blocked');
    if (run.state === 'completed') events.push('completed');
    if (run.state === 'failed') events.push('failed');

    const seen = notified.get(run.runId) ?? new Set<string>();
    notified.set(run.runId, seen);
    const blocked = Object.values(run.nodes).filter((n) => n.state === 'blocked').map((n) => n.nodeId);

    for (const ev of events) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      dispatchChannels(deps.dataDir, {
        event: ev,
        title: `PaneFlow ${ev === 'blocked' ? '⛔ 等待审批' : ev === 'completed' ? '✅ 已完成' : '❌ 失败'}`,
        body: `${run.dagName}（run ${run.runId}）${ev === 'blocked' ? `节点 ${blocked.join('、')} 等待人工审批` : ''}`,
        runId: run.runId,
        dagName: run.dagName,
        ...(ev === 'blocked' ? { nodeIds: blocked } : {}),
      });
    }
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') {
      notified.delete(run.runId);
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
