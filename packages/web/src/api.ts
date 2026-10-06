import type { DagGraph, NodeRunRecord, RunEvent, RunRecord } from '@paneflow/shared';
import type { DryRunResult } from './components/dry-run.js';
import type { RegistryAddPayload, RegistryCheckResponse, RegistryEntryView, RegistryHealthResponse, RegistryListResponse, RegistryProbeResponse } from './registry-view.js';

const BASE = '';

/** 出站通道：把运行事件推送到外部系统（与服务端 api/channels.ts 保持一致） */
export type ChannelType = 'webhook' | 'feishu' | 'dingtalk';
export type NotifyEvent = 'blocked' | 'completed' | 'failed';
export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  url: string;
  secret?: string;
  events: NotifyEvent[];
  template?: string;
}

let currentSpace = localStorage.getItem('pf-space') || 'default';

export function setSpace(id: string): void {
  currentSpace = id;
  localStorage.setItem('pf-space', id);
}

export function getSpace(): string {
  return currentSpace;
}

async function json<T>(method: string, path: string, body?: unknown, opts?: { raw?: boolean }): Promise<T> {
  if (!opts?.raw) {
    const sep = path.includes('?') ? '&' : '?';
    path += `${sep}space=${encodeURIComponent(currentSpace)}`;
  }
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `${method} ${path} → ${r.status}`);
  }
  return (await r.json()) as T;
}

/** 不带 space 上下文的原始 JSON 请求：非 2xx 抛错（错误体里的 error 优先作为消息）。 */
export const fetchJson = <T>(method: string, path: string, body?: unknown): Promise<T> =>
  fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `${method} ${path} → ${r.status}`);
    }
    return (await r.json()) as T;
  });

export type ProbeKind = 'repo' | 'doc' | 'skill' | 'rule' | 'check' | 'workflow' | 'worktree';

export interface EnvProbeItem {
  kind: ProbeKind;
  name: string;
  detail: string;
  evidence: string;
}

export interface EnvProbeResult {
  path: string;
  root?: string;
  summary?: string;
  items: EnvProbeItem[];
  missing: string[];
  agentsAvailable?: string[];
  error?: string;
}

export const api = {
  request: fetchJson,
  health: () => json<{
    ok: boolean;
    herdrOk: boolean;
    herdrVersion: string | null;
    herdrSocket: string;
    agentKinds: string[];
    recommendedAgentKind?: string | null;
    gatewayEnabled?: boolean;
    env: { nodeVersion: string; agentsInstalled: string[]; agentsMissing: string[]; recommendedAgentKind?: string | null; gatewayEnabled?: boolean };
  }>('GET', '/api/health'),
  listGraphs: () => json<{ graphs: DagGraph[] }>('GET', '/api/graphs'),
  saveGraph: (graph: DagGraph) => json<DagGraph>('POST', '/api/graphs', { graph }),
  deleteGraph: (id: string) => json<{ deleted: boolean }>('DELETE', `/api/graphs/${encodeURIComponent(id)}`),
  startRun: (graph: DagGraph, cwd: string, variables?: Record<string, string>, issueId?: string) =>
    json<{ runId: string; run: RunRecord }>('POST', '/api/runs', { graph, cwd, ...(variables ? { variables } : {}), ...(issueId ? { issueId } : {}) }),
  /** v7-A5 断点续跑：复用源 run 的已应用图，显式带回其所属空间（RunsCenter 跨空间列表不能依赖当前项目） */
  resumeRun: (source: RunRecord) =>
    json<{ runId: string; run: RunRecord }>(
      'POST',
      `/api/runs?space=${encodeURIComponent(source.spaceId || getSpace())}`,
      { graph: source.graph, cwd: source.cwd, ...(source.issueId ? { issueId: source.issueId } : {}), resumeOf: source.runId },
      { raw: true },
    ),
  stopRun: (runId: string) => json<{ stopping: boolean }>('POST', `/api/runs/${runId}/stop`),
  getRun: (runId: string) => json<RunRecord>('GET', `/api/runs/${runId}`),
  listRuns: () => json<{ runs: RunRecord[] }>('GET', '/api/runs'),
  /** R5.3 事件时间线（历史运行按需拉取；运行中的记录随 WS 实时到达） */
  runEvents: (runId: string) =>
    json<{ runId: string; events: RunEvent[] }>('GET', `/api/runs/${encodeURIComponent(runId)}/events`, undefined, { raw: true }),
  approve: (runId: string, nodeId: string, body: { action: 'approve' | 'reject' | 'input'; keys?: string[]; text?: string }) =>
    json<{ delivered: boolean }>('POST', `/api/runs/${runId}/nodes/${nodeId}/approve`, body),
  nodeLog: (runId: string, nodeId: string, lines = 200) =>
    json<{ text: string }>('GET', `/api/runs/${runId}/nodes/${nodeId}/log?lines=${lines}`),
  nodeKeys: (runId: string, nodeId: string, keys: string[]) =>
    json<{ sent: string[] }>('POST', `/api/runs/${runId}/nodes/${nodeId}/keys`, { keys }),
  nodeInput: (runId: string, nodeId: string, text: string) =>
    json<{ sent: boolean }>('POST', `/api/runs/${runId}/nodes/${nodeId}/input`, { text }),
  syncStatus: () => json<{ configured: boolean; repo: string | null }>('GET', '/api/sync/status'),
  // -- 出站通道（自动化跟踪：把运行事件推到你选的地方） --
  listChannels: () => json<{ channels: Channel[] }>('GET', '/api/channels', undefined, { raw: true }),
  saveChannels: (channels: Channel[]) =>
    json<{ saved: boolean; channels: Channel[] }>('PUT', '/api/channels', { channels }, { raw: true }),
  testChannel: (channel: Channel) => json<{ sent: boolean }>('POST', '/api/channels/test', { channel }, { raw: true }),
  syncPush: () => json<{ started: boolean }>('POST', '/api/sync/push'),
  syncPull: () => json<{ imported: string[]; failed: { file: string; error: string }[] }>('POST', '/api/sync/pull'),
  // 预演结果的形状只有一份（components/dry-run.ts）：这里曾自己抄了一遍，
  // 于是 server 加一个键就得改两处——漏改的那处让调用方以为字段不存在。
  dryRun: (graph: DagGraph, cwd: string, variables?: Record<string, string>) =>
    json<DryRunResult>('POST', '/api/dry-run', { graph, cwd, ...(variables ? { variables } : {}) }),
  dispatch: (task: string, cwd: string, issueId?: string, preview = false, permMode?: string) =>
    json<{
      runId: string;
      issueId?: string;
      issueFetched?: boolean;
      note?: string;
      /** M1 接单门：extracted=输入自带验收标准；gate=无契约，run 会停在契约确认门（M6 template=命中的骨架戳 id@sha）；N2 autofilled=AI 已补出契约草案，仍停在确认门等人工过目 */
      contract?: { mode: 'extracted' | 'gate' | 'autofilled'; assertions?: number; template?: string };
      /** v18-R2 档位回执（normal=键省略） */
      permMode?: string;
    }>('POST', '/api/dispatch', {
      task,
      cwd,
      ...(issueId ? { issueId } : {}),
      ...(preview ? { preview: true } : {}),
      ...(permMode && permMode !== 'normal' ? { permMode } : {}),
    }),
  /**
   * v18-R3 产物架清单与原文读取（从 RunsCenter 的两刀 fetchJson 提升为公共 api；
   * BoardView 审阅卡的 diff 摘要同吃这两个端点——判据全在 server，这里只取数）。
   */
  runArtifacts: (runId: string) =>
    json<{ runId: string; dir: string; exists: boolean; files: { name: string; size: number; mtime?: string; source: 'workspace' | 'shelf'; nodeId?: string; sha?: string; shelved?: boolean; shelfError?: string }[] }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/artifacts`,
      undefined,
      { raw: true },
    ),
  runArtifactFile: (runId: string, path: string, src: 'workspace' | 'shelf' = 'workspace') =>
    json<{ content: string; truncated?: boolean }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/artifacts/file?path=${encodeURIComponent(path)}&src=${src}`,
      undefined,
      { raw: true },
    ),
  /** v18-R4 用量总览（跨项目/agent 聚合，窗口默认 30 天） */
  usage: (days = 30) =>
    json<{
      days: number;
      generatedAt: string;
      totals: { runs: number; tokensIn: number; tokensOut: number };
      byDay: { key: string; runs: number; tokensIn: number; tokensOut: number }[];
      bySpace: { key: string; runs: number; tokensIn: number; tokensOut: number }[];
      byKind: { key: string; runs: number; tokensIn: number; tokensOut: number }[];
      budget: { envMaxTokens: number | null; tripRuns: number };
    }>('GET', `/api/usage?days=${days}`, undefined, { raw: true }),
  /**
   * v18 MCP 自动发现（cc Switch 思路）：扫本机 Claude Code / Cursor 配置里的 mcpServers，
   * 抬出 command 型候选给页面一键登记；http/sse 型如实列 skipped（不是命令账，这版不收）。
   */
  /** v18 模型条目的运行时使用账（最近被哪些单当过 harness.model） */
  modelUsage: (id: string) =>
    json<{ modelId: string; recent: { runId: string; dagName: string; state: string; startedAt: string; tokens: { input: number; output: number } | null }[] }>(
      'GET',
      `/api/registry/${encodeURIComponent(id)}/model-usage`,
      undefined,
      { raw: true },
    ),
  mcpDiscovered: () =>
    json<{ candidates: { name: string; command: string; args?: string[]; source: string }[]; skipped: { name: string; source: string; why: string }[] }>(
      'GET',
      '/api/registry/mcp-discovered',
      undefined,
      { raw: true },
    ),
  /** v9-N3 排队全景：并发额度、占用者、排队位次（queued 卡片渲染等待原因） */
  queueStatus: () =>
    json<{
      cap: number;
      running: { runId: string; title: string }[];
      queued: { runId: string; title: string; position: number }[];
    }>('GET', '/api/queue'),
  /** N3：排队单提到队首（插队）；不在队列 409 */
  promoteRun: (runId: string) => json<{ promoted: true }>('POST', `/api/runs/${runId}/promote`),
  /** v9-N1 需求增强器：一句话 → 接近可开工的 issue 草稿（网关未启用时 400） */
  enhanceIssue: (text: string, cwd?: string, deep?: boolean) =>
    json<{
      ok: true;
      issue: { title: string; body: string; acceptance: string[]; openQuestions: string[] };
      candidates?: { title: string; body: string }[];
      /** v10-X：本次扩写带进上下文的 wiki 沉淀页数 */
      wikiPages?: number;
    }>('POST', '/api/issues/enhance', {
      text,
      ...(cwd ? { cwd } : {}),
      ...(deep ? { deep: true } : {}),
    }),
  /** G3 批量派发：一个模板 × 一列 issue 编号 → N 个 run（项目并发达上限自动排队） */
  dispatchBatch: (template: string, issues: string, cwd: string, repo?: string) =>
    json<{
      template: string;
      dispatched: number;
      queued: number;
      results: { issue: number; runId: string; state: string }[];
      failed: { issue: number; error: string }[];
    }>('POST', '/api/dispatch/batch', {
      template,
      issues,
      cwd,
      ...(repo ? { repo } : {}),
    }),
  /** G1 Issue 读取器：正文+评论（repo 缺省用服务端配置的默认仓库） */
  getIssue: (number: number, repo?: string) =>
    json<{
      number: number;
      repo: string;
      title: string;
      body: string;
      state: string;
      url: string;
      labels: string[];
      comments: { author: string; body: string }[];
    }>('GET', `/api/issues/${number}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, undefined, { raw: true }),
  listSpaces: () =>
    json<{ spaces: { id: string; name: string; rootCwd?: string; description?: string }[] }>(
      'GET',
      '/api/spaces',
      undefined,
      { raw: true },
    ),
  createSpace: (id: string, name: string) => json<unknown>('POST', '/api/spaces', { id, name }, { raw: true }),
  // -- v14 X1 注册中心：表 + 批量健康 + 单枚探针 + 四动词，都是 dataDir 级唯一事实源（不随项目空间走，一律 raw） --
  registryList: (kind?: string) =>
    fetchJson<RegistryListResponse>('GET', `/api/registry${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
  /**
   * R4 健康读数（逐条目实探 + 被引用数）：**单独一刀**，`registryList` 保持纯读盘——
   * 网关慢/挂掉只把健康点这一刀拖住，不许连带整张表读不出（?refresh=1 绕开 server 5min 缓存）。
   */
  registryHealth: (refresh = false) =>
    fetchJson<RegistryHealthResponse>('GET', `/api/registry/health${refresh ? '?refresh=1' : ''}`),
  registryAdd: (body: RegistryAddPayload) => fetchJson<{ entry: RegistryEntryView }>('POST', '/api/registry', body),
  /**
   * R4/X1 单枚探针（`paneflow registry probe <id>` 的同一落点）：只探这一条、吃同一份实探缓存。
   * server 不回 `health` 键＝这一类没有探针通道（不是不健康），这里不替它补一个读数。
   */
  registryProbe: (id: string, refresh = false) =>
    fetchJson<RegistryProbeResponse>('GET', `/api/registry/${encodeURIComponent(id)}/health${refresh ? '?refresh=1' : ''}`),
  /**
   * v14-T3 预检读数：一次拿全部在册模板的槽落点（模板卡不是一卡一发请求）。
   * 走带 `?space=` 的那枚 helper——预检的口径是「按当前项目解析」，项目名必须跟着走；
   * 上面几枚 registry 调用不带 space 是因为注册表本身是 dataDir 级唯一事实源。
   */
  registryCheck: () => json<RegistryCheckResponse>('GET', '/api/registry/check'),
  registryPatch: (id: string, body: { name?: string; spec?: unknown; enabled?: boolean }) =>
    fetchJson<{ entry: RegistryEntryView }>('PATCH', `/api/registry/${encodeURIComponent(id)}`, body),
  registryDelete: (id: string) =>
    fetchJson<{ deleted: RegistryEntryView }>('DELETE', `/api/registry/${encodeURIComponent(id)}`),
  /** 网关档清单（表单「归属网关档」下拉的选项源；apiKey 永不回显，这里只拿 id/name） */
  gatewayProfiles: () =>
    fetchJson<{ profiles: { id: string; name: string; baseUrl: string; isCurrent: boolean }[] }>('GET', '/api/gateway'),
  /** 每档实探的模型清单（登记表单的型号候选；?refresh=1 强刷，其余走 server 5min 缓存） */
  gatewayCatalog: (refresh = false) =>
    fetchJson<{
      profiles: { id: string; name: string; baseUrl: string; freeModel?: string; isCurrent: boolean; models: string[]; error?: string | null }[];
    }>('GET', `/api/gateway/catalog${refresh ? '?refresh=1' : ''}`),
  /** v14-E2 一次事务登记：probe → map → write 原子完成 */
  envRegister: (path: string, space: string, selected?: number[]) =>
    fetchJson<{ registered: number; profile: Record<string, unknown>; warnings: string[] }>(
      'POST', '/api/env/register', { path, space, ...(selected !== undefined ? { selected } : {}) },
    ),
  /** v14-E1 环境发现器（纯只读探测） */
  envProbe: (path: string) =>
    fetchJson<EnvProbeResult>('POST', '/api/env/probe', { path }),
};

export interface WsRunMessage {
  type: 'run';
  run: RunRecord;
}

export function connectWs(onRun: (run: RunRecord) => void, onStatus: (ok: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 1000;
  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retryMs = 1000;
      onStatus(true);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsRunMessage;
        if (msg.type === 'run') onRun(msg.run);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) {
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}

export type { NodeRunRecord, RunRecord, DagGraph, RunEvent };
