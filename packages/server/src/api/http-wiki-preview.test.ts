import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wiki-prev-'));
}

function greenRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-abc123',
    dagName: '修登录页样式',
    state: 'completed',
    cwd: '/work/app',
    spaceId: 'demo',
    startedAt: '2026-09-19T01:00:00.000Z',
    finishedAt: '2026-09-19T01:12:00.000Z',
    graph: { version: 1, name: 'g', nodes: [], edges: [] } as unknown as RunRecord['graph'],
    nodes: {
      impl: { nodeId: 'impl', state: 'done', attempts: 1, agentName: 'pi', artifact: { summary: '改了三处样式', extra: {} } },
      verify: {
        nodeId: 'verify',
        state: 'done',
        attempts: 1,
        agentName: 'claude',
        artifact: {
          summary: '全部通过',
          extra: {
            assertionResults: [
              { id: 'AC-1', status: 'ok', evidence: '截图比对无差' },
              { id: 'AC-2', status: 'ok', evidence: 'e2e 绿' },
            ],
          },
        },
      },
    },
    contract: {
      source: 'input',
      assertions: [
        { id: 'AC-1', assertion: '登录页在移动端不破版', verify_method: '截图' },
        { id: 'AC-2', assertion: 'e2e 登录用例绿', verify_method: '命令' },
      ],
    } as RunRecord['contract'],
    cost: { totalMs: 720_000, byNode: {}, retries: 0, tokens: null },
    ...over,
  } as unknown as RunRecord;
}

function buildServer(dataDir: string, run: RunRecord | undefined) {
  return buildHttpServer({
    engine: { onChange: () => {}, getRun: (id: string) => (id && id === run?.runId ? run : undefined) } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
    lookupGithubLogin: async () => null,
  });
}

/** 证明「零网络」的 fetch 桩：被调一次即失败（preview 只许读本地） */
function noNetworkFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('preview 不该发任何网络请求');
  }) as unknown as typeof fetch;
}

function seedGh(dataDir: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dataDir, 'github.json'), JSON.stringify({ token: 'ghp_t', defaultRepo: 'me/app', ...extra }));
}

describe('v11-C5 GET /api/wiki/preview（推前预览：只读零网络零 push）', () => {
  it('绿单过正门：gate.ok + kind=green + 完整将推 markdown 草稿；fetch 桩零调用（零网络零 push）', async () => {
    const dir = tmp();
    seedGh(dir);
    const spy = noNetworkFetch();
    vi.stubGlobal('fetch', spy);
    const { app } = await buildServer(dir, greenRun());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/wiki/preview?runId=run-abc123' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.gate).toEqual({ ok: true });
      expect(body.kind).toBe('green');
      expect(body.repo).toBe('me/app');
      expect(body.page.file).toBe('summaries/修登录页样式-abc123.md');
      expect(body.page.markdown).toContain('confidence: high');
      expect(body.page.markdown).toContain('| AC-1 | 登录页在移动端不破版 | ✅ ok | 截图比对无差 |');
      expect(body.page.markdown).toContain('pf-run: run-abc123');
      // 记账字段不外泄（预览只给 file+markdown），且没碰网络
      expect(Object.keys(body.page).sort()).toEqual(['file', 'markdown']);
      expect(body.visibility).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it('门不过也回 reason：completed 但断言 0 条 ok → gate.ok=false + page=null，仍零网络', async () => {
    const dir = tmp();
    seedGh(dir);
    const spy = noNetworkFetch();
    vi.stubGlobal('fetch', spy);
    const run = greenRun();
    for (const n of Object.values(run.nodes)) n.artifact!.extra = {};
    const { app } = await buildServer(dir, run);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/wiki/preview?runId=run-abc123' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.gate.ok).toBe(false);
      expect(body.gate.reason).toContain('断言');
      expect(body.page).toBeNull();
      expect(body.kind).toBe('green');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });

  it('kind 自动预选门：failed / completed-with-failures 默认走侧门（页带 ⚠ 警示）；显式 kind=green 则拒', async () => {
    const dir = tmp();
    seedGh(dir);
    for (const state of ['failed', 'completed-with-failures'] as const) {
      const { app } = await buildServer(dir, greenRun({ state }));
      try {
        const auto = await app.inject({ method: 'GET', url: '/api/wiki/preview?runId=run-abc123' });
        expect(auto.statusCode).toBe(200);
        expect(auto.json()).toMatchObject({ gate: { ok: true }, kind: 'counterexample' });
        expect(auto.json().page.markdown).toContain('⚠ 反面教材');
        expect(auto.json().page.markdown).toContain('confidence: low');
        const forced = await app.inject({ method: 'GET', url: '/api/wiki/preview?runId=run-abc123&kind=green' });
        expect(forced.json().gate.ok).toBe(false);
        expect(forced.json().page).toBeNull();
      } finally {
        await app.close();
      }
    }
  });

  it('绿单不许走侧门（两门互斥）：显式 kind=counterexample → gate.ok=false 且指路正门', async () => {
    const dir = tmp();
    seedGh(dir);
    const { app } = await buildServer(dir, greenRun());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/wiki/preview?runId=run-abc123&kind=counterexample' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ kind: 'counterexample', page: null });
      expect(res.json().gate.reason).toContain('正门');
    } finally {
      await app.close();
    }
  });

  it('入参门：缺 runId 400；找不到 run 404；非法 kind 400；缺默认仓库折进 gate.reason', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir, greenRun());
    try {
      expect((await app.inject({ method: 'GET', url: '/api/wiki/preview' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/wiki/preview?runId=nope' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/wiki/preview?runId=run-abc123&kind=bogus' })).statusCode).toBe(400);
      const noRepo = await app.inject({ method: 'GET', url: '/api/wiki/preview?runId=run-abc123' });
      expect(noRepo.statusCode).toBe(200);
      expect(noRepo.json()).toMatchObject({ gate: { ok: false }, page: null });
      expect(noRepo.json().gate.reason).toContain('默认仓库');
    } finally {
      await app.close();
    }
  });

  it('visibility 只读 publish 落下的本地缓存；publish 409 门语义不变且顺手把可见性写进缓存', async () => {
    const dir = tmp();
    seedGh(dir);
    // ① publish 对 public 仓未确认 → 409 needsConfirm（原语义原样），可见性入缓存
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ private: false }) })) as unknown as typeof fetch);
    const { app } = await buildServer(dir, greenRun());
    try {
      const r = await app.inject({ method: 'POST', url: '/api/wiki/publish', payload: { runId: 'run-abc123' } });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ needsConfirm: true, visibility: 'public' });
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
    // ② preview 零网络读到 public → 前端据此亮「我确认公开」勾选
    const spy = noNetworkFetch();
    vi.stubGlobal('fetch', spy);
    const { app: app2 } = await buildServer(dir, greenRun());
    try {
      const res = await app2.inject({ method: 'GET', url: '/api/wiki/preview?runId=run-abc123' });
      expect(res.json()).toMatchObject({ gate: { ok: true }, visibility: 'public' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await app2.close();
      vi.unstubAllGlobals();
    }
  });
});
