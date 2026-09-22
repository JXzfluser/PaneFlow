import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import type { RunRecord } from '@paneflow/shared';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sidefx-'));
}

/** 假 GitHub API fetch（照 github-cred.test.ts 同款姿势：stubGlobal 锁真实调用面） */
function stubGithubFetch(handler: (url: string, method: string) => { status: number; json: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      const r = handler(String(url), method);
      return new Response(JSON.stringify(r.json), { status: r.status });
    }),
  );
}

/**
 * v12-S1a 副作用归因接线端点级验证：engine 桩只留本片消费的三面
 * （recordIssueSideEffect 记账口 / getRun 读端透传 / replayRun 门禁错误透传）。
 */
function buildServer(opts: {
  dataDir: string;
  record?: (runId: string, kind: string, n: number) => boolean;
  run?: Partial<RunRecord>;
}) {
  const calls: { runId: string; kind: string; number: number }[] = [];
  const engine = {
    onChange: () => {},
    getRun: (id: string) => (opts.run && opts.run.runId === id ? ({ nodes: {}, ...opts.run } as RunRecord) : undefined),
    listRuns: () => [],
    replayRun: async (_id: string, _meta?: unknown, o?: { allowSideEffects?: boolean; fromFailed?: boolean }) => {
      if (opts.run?.sideEffects && !o?.allowSideEffects) {
        throw new Error(`源 run ${_id} 有副作用（建单#12）——直接重放会二次副作用\n显式穿透加 --allow-side-effects；只重跑失败/未执行节点加 --from-failed`);
      }
      return { runId: 'new-1', state: 'running' };
    },
    recordIssueSideEffect: vi.fn(async (runId: string, kind: 'created' | 'patched', number: number) => {
      calls.push({ runId, kind, number });
      return opts.record ? opts.record(runId, kind, number) : true;
    }),
  };
  return {
    engine,
    calls,
    ready: buildHttpServer({
      engine: engine as unknown as Engine,
      store: {} as unknown as Store,
      ops: {} as unknown as HerdrOps,
      herdrSocketPath: path.join(opts.dataDir, 'herdr.sock'),
      dataDir: opts.dataDir,
      readGhCliToken: async () => {
        throw new Error('test stub');
      },
      lookupGithubLogin: async () => null,
    }),
  };
}

async function withCred(app: { inject: (o: object) => Promise<{ json(): any; statusCode: number }> }) {
  await app.inject({ method: 'PUT', url: '/api/github/cred', payload: { token: 't', defaultRepo: 'owner/repo' } });
}

describe('v12-S1a 盲端点副作用归因（create-issue / update-issue 带 runId 落账，不带=行为与今天一致）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('create-issue 带 runId 且建单成功 → recordIssueSideEffect(created, number)；响应体零变化', async () => {
    const dir = tmp();
    const { engine, calls, ready } = buildServer({ dataDir: dir });
    const { app } = await ready;
    try {
      await withCred(app);
      stubGithubFetch(() => ({ status: 201, json: { number: 42, html_url: 'https://github.com/owner/repo/issues/42' } }));
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'x', runId: 'r-1' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ number: 42, url: 'https://github.com/owner/repo/issues/42', repo: 'owner/repo' });
      expect(calls).toEqual([{ runId: 'r-1', kind: 'created', number: 42 }]);
      expect(engine.recordIssueSideEffect).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('create-issue 不带 runId → 零归因调用（旧调用方行为一字不变）；GitHub 失败也不归因', async () => {
    const dir = tmp();
    const { calls, ready } = buildServer({ dataDir: dir });
    const { app } = await ready;
    try {
      await withCred(app);
      stubGithubFetch(() => ({ status: 201, json: { number: 7, html_url: 'u' } }));
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'x' } });
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(0);
      stubGithubFetch(() => ({ status: 403, json: { message: 'no perm' } }));
      const bad = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'x', runId: 'r-1' } });
      expect(bad.statusCode).toBe(403);
      expect(calls).toHaveLength(0); // 覆写/建单没成功就不许落账
    } finally {
      await app.close();
    }
  });

  it('update-issue 带 runId 且覆写成功 → patched；不带 runId 零破坏', async () => {
    const dir = tmp();
    const { calls, ready } = buildServer({ dataDir: dir });
    const { app } = await ready;
    try {
      await withCred(app);
      stubGithubFetch(() => ({ status: 200, json: { number: 7, html_url: 'https://github.com/owner/repo/issues/7' } }));
      const hit = await app.inject({ method: 'PATCH', url: '/api/github/update-issue', payload: { number: 7, body: '新正文', runId: 'r-2' } });
      expect(hit.statusCode).toBe(200);
      expect(calls).toEqual([{ runId: 'r-2', kind: 'patched', number: 7 }]);
      const legacy = await app.inject({ method: 'PATCH', url: '/api/github/update-issue', payload: { number: 7, body: 'x' } });
      expect(legacy.statusCode).toBe(200);
      expect(calls).toHaveLength(1); // 没有新增调用
    } finally {
      await app.close();
    }
  });

  it('runId 定位不到（engine 记 false）：端点照常 200——归因是旁账，绝不拦写操作', async () => {
    const dir = tmp();
    const { calls, ready } = buildServer({ dataDir: dir, record: () => false });
    const { app } = await ready;
    try {
      await withCred(app);
      stubGithubFetch(() => ({ status: 201, json: { number: 9, html_url: 'u' } }));
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'x', runId: 'ghost' } });
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('GET /api/runs/:id 零改动透传 sideEffects（只加不改既有聚合）', async () => {
    const dir = tmp();
    const { ready } = buildServer({
      dataDir: dir,
      run: {
        runId: 'r-9',
        dagName: 'g',
        state: 'running',
        cwd: '/tmp/x',
        startedAt: '2026-09-22T00:00:00.000Z',
        graph: { version: 1, name: 'g', nodes: [], edges: [], metadata: { createdAt: '', updatedAt: '' } },
        sideEffects: { issuesCreated: [12], issuePatched: [7], prUrl: 'https://github.com/o/r/pull/3' },
      },
    });
    const { app } = await ready;
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-9' });
      expect(res.statusCode).toBe(200);
      expect(res.json().sideEffects).toEqual({ issuesCreated: [12], issuePatched: [7], prUrl: 'https://github.com/o/r/pull/3' });
      expect(res.json().awaitingApproval).toEqual({ nodeIds: [], waiting: false });
    } finally {
      await app.close();
    }
  });
});
