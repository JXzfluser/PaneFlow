import type { DagGraph, NodeRunRecord, RunEvent, RunRecord } from '@paneflow/shared';

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

export const api = {
  request: fetchJson,
  health: () => json<{
    ok: boolean;
    herdrOk: boolean;
    herdrVersion: string | null;
    herdrSocket: string;
    agentKinds: string[];
    env: { nodeVersion: string; agentsInstalled: string[]; agentsMissing: string[] };
  }>('GET', '/api/health'),
  listGraphs: () => json<{ graphs: DagGraph[] }>('GET', '/api/graphs'),
  saveGraph: (graph: DagGraph) => json<DagGraph>('POST', '/api/graphs', { graph }),
  deleteGraph: (id: string) => json<{ deleted: boolean }>('DELETE', `/api/graphs/${encodeURIComponent(id)}`),
  startRun: (graph: DagGraph, cwd: string, variables?: Record<string, string>, issueId?: string) =>
    json<{ runId: string; run: RunRecord }>('POST', '/api/runs', { graph, cwd, ...(variables ? { variables } : {}), ...(issueId ? { issueId } : {}) }),
  /** v7-A5 断点续跑：复用源 run 的已应用图，显式带回其所属空间（RunsCenter 跨空间列表不能依赖当前空间） */
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
  dryRun: (graph: DagGraph, cwd: string, variables?: Record<string, string>) =>
    json<{
      nodes: { id: string; type: string; label: string; role: string | null; agentKind: string | null; cwd: string | null; promptPreview: string | null; checks: string[]; conventions: string | null }[];
      edges: { id: string; source: string; target: string; condition: string | null }[];
      warnings: string[];
    }>('POST', '/api/dry-run', { graph, cwd, ...(variables ? { variables } : {}) }),
  dispatch: (task: string, cwd: string, issueId?: string, preview = false) =>
    json<{
      runId: string;
      issueId?: string;
      issueFetched?: boolean;
      note?: string;
      /** M1 接单门：extracted=输入自带验收标准；gate=无契约，run 会停在契约确认门（M6 template=命中的骨架戳 id@sha） */
      contract?: { mode: 'extracted' | 'gate'; assertions?: number; template?: string };
    }>('POST', '/api/dispatch', {
      task,
      cwd,
      ...(issueId ? { issueId } : {}),
      ...(preview ? { preview: true } : {}),
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
