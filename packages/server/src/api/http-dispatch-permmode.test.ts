import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { Engine } from '../orchestrate/engine.js';
import { FakeHerdrOps } from '../orchestrate/fake-ops.js';
import { Store } from '../orchestrate/store.js';

/**
 * v18-R2 派发档位（POST /api/dispatch 的 permMode 体键）+ v18-R4 用量端点接线。
 * 全链路真路由 + 真 Engine + FakeHerdrOps（http-dispatch-experiment.test 同款替身）。
 */

const HOST = '127.0.0.1:4310';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dispatch-perm-'));

async function buildRealServer() {
  const dataDir = tmp();
  const root = tmp();
  const ops = new FakeHerdrOps();
  const store = new Store(dataDir);
  const engine = new Engine(ops, store, {
    workspaceLabelPrefix: 'paneflow-',
    promptConfirmWindowMs: 0,
    reconcileIntervalMs: 60_000,
    defaultNodeTimeoutMs: 1_200,
    agentStartTimeoutMs: 5_000,
    agentReadyTimeoutMs: 5_000,
    recommendAgentKind: async () => 'fake',
  });
  const { app } = await buildHttpServer({
    engine,
    store,
    ops,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
    recommendAgentKind: async () => 'fake',
  });
  await app.inject({
    method: 'PUT',
    url: '/api/spaces/exp',
    headers: { host: HOST },
    payload: { rootCwd: root },
  });
  return { app, engine, dataDir };
}

const dispatch = (app: { inject: (o: object) => Promise<{ statusCode: number; json(): any }> }, payload: object) =>
  app.inject({ method: 'POST', url: '/api/dispatch?space=exp', headers: { host: HOST }, payload });

describe('POST /api/dispatch 的 permMode 体键（v18-R2）', () => {
  it('合法档位落册 run.permMode 并回显；normal 不落键（缺省=常规，旧读数一字不变）', async () => {
    const { app } = await buildRealServer();
    try {
      const res = await dispatch(app, { task: '给导出模块加空值兜底', permMode: 'auto' });
      expect(res.statusCode).toBe(200);
      expect(res.json().permMode).toBe('auto');
      const rec = (await app.inject({ url: `/api/runs/${res.json().runId}` })).json();
      expect(rec.permMode).toBe('auto');
      await app.inject({ method: 'POST', url: `/api/runs/${rec.runId}/stop` });

      const plain = await dispatch(app, { task: '普通活' });
      expect(plain.statusCode).toBe(200);
      expect(plain.json().permMode).toBeUndefined();
      const rec2 = (await app.inject({ url: `/api/runs/${plain.json().runId}` })).json();
      expect('permMode' in rec2).toBe(false);
      await app.inject({ method: 'POST', url: `/api/runs/${rec2.runId}/stop` });
    } finally {
      await app.close();
    }
  });

  it('越界档位 400 一句指路、不起单；未知体键照旧 400（permMode 进白名单不豁免别的拼错）', async () => {
    const { app, engine } = await buildRealServer();
    try {
      const bad = await dispatch(app, { task: '活', permMode: 'aggressive' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toContain('permMode');
      expect(bad.json().error).toContain('readonly');

      const typo = await dispatch(app, { task: '活', permmodel: 'auto' });
      expect(typo.statusCode).toBe(400);
      expect(typo.json().error).toContain('permmodel');
      expect(engine.listRuns()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/usage（v18-R4 端点接线）', () => {
  it('跨项目聚合磁盘上的 run 账本（含归档），聚合判据在 usage.ts 纯函数', async () => {
    const { app, dataDir } = await buildRealServer();
    try {
      // 直接落一本账：default 项目下一单一归档（listRuns/listArchivedRuns 的读法原样吃）
      const mkRun = (id: string, tokens: { input: number; output: number }) => ({
        runId: id,
        dagName: 't',
        graph: { version: 1, name: 't', nodes: [], edges: [], metadata: { createdAt: '', updatedAt: '' } },
        state: 'completed',
        cwd: '/tmp',
        spaceId: 'default',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        nodes: {},
        cost: { totalMs: 1, byNode: {}, retries: 0, tokens },
      });
      const runsDir = path.join(dataDir, 'spaces', 'default', 'runs');
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(path.join(runsDir, 'u1.json'), JSON.stringify(mkRun('u1', { input: 111, output: 22 })));
      fs.mkdirSync(path.join(runsDir, 'archive'), { recursive: true });
      fs.writeFileSync(
        path.join(runsDir, 'archive', 'u2.json'),
        JSON.stringify(mkRun('u2', { input: 5, output: 1 })),
      );
      const res = await app.inject({ url: '/api/usage?days=30', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totals.runs).toBe(2);
      expect(body.totals.tokensIn).toBe(116);
      expect(body.bySpace[0].key).toBe('default');
      expect(typeof body.budget.tripRuns).toBe('number');
    } finally {
      await app.close();
    }
  });
});
