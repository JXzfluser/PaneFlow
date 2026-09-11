import type { DagGraph, NodeRunRecord, RunRecord } from '@paneflow/shared';

const BASE = '';

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

/** Raw JSON request with the current space context skipped (for non-space endpoints). */
const rawJson = <T>(method: string, path: string, body?: unknown): Promise<T> =>
  fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`);
    return (await r.json()) as T;
  });

export const api = {
  request: rawJson,
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
  stopRun: (runId: string) => json<{ stopping: boolean }>('POST', `/api/runs/${runId}/stop`),
  getRun: (runId: string) => json<RunRecord>('GET', `/api/runs/${runId}`),
  listRuns: () => json<{ runs: RunRecord[] }>('GET', '/api/runs'),
  approve: (runId: string, nodeId: string, body: { action: 'approve' | 'reject' | 'input'; keys?: string[]; text?: string }) =>
    json<{ delivered: boolean }>('POST', `/api/runs/${runId}/nodes/${nodeId}/approve`, body),
  nodeLog: (runId: string, nodeId: string, lines = 200) =>
    json<{ text: string }>('GET', `/api/runs/${runId}/nodes/${nodeId}/log?lines=${lines}`),
  nodeKeys: (runId: string, nodeId: string, keys: string[]) =>
    json<{ sent: string[] }>('POST', `/api/runs/${runId}/nodes/${nodeId}/keys`, { keys }),
  nodeInput: (runId: string, nodeId: string, text: string) =>
    json<{ sent: boolean }>('POST', `/api/runs/${runId}/nodes/${nodeId}/input`, { text }),
  syncStatus: () => json<{ configured: boolean; repo: string | null }>('GET', '/api/sync/status'),
  syncPush: () => json<{ started: boolean }>('POST', '/api/sync/push'),
  syncPull: () => json<{ imported: string[]; failed: { file: string; error: string }[] }>('POST', '/api/sync/pull'),
  dryRun: (graph: DagGraph, cwd: string, variables?: Record<string, string>) =>
    json<{
      nodes: { id: string; type: string; label: string; role: string | null; agentKind: string | null; cwd: string | null; promptPreview: string | null; checks: string[]; conventions: string | null }[];
      edges: { id: string; source: string; target: string; condition: string | null }[];
      warnings: string[];
    }>('POST', '/api/dry-run', { graph, cwd, ...(variables ? { variables } : {}) }),
  listSpaces: () => json<{ spaces: { id: string; name: string }[] }>('GET', '/api/spaces', undefined, { raw: true }),
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

export type { NodeRunRecord, RunRecord, DagGraph };
