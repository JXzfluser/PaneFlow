import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { Store } from '../orchestrate/store.js';
import type { RunRecord } from '@paneflow/shared';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';

/** v7-A2：归档可出——归档/反归档/真删除全链路（含非默认空间串写守卫）。 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-archive-'));
}

const HOST = '127.0.0.1:4310';

function makeRun(runId: string, spaceId: string): RunRecord {
  return {
    runId,
    dagName: 'test-dag',
    graph: { id: runId, name: 'g', nodes: [], edges: [] } as unknown as RunRecord['graph'],
    state: 'completed',
    cwd: '/tmp',
    spaceId,
    nodes: {},
    startedAt: '2026-09-18T00:00:00.000Z',
    finishedAt: '2026-09-18T00:10:00.000Z',
  };
}

function buildServer(dataDir: string, engineOverrides: Partial<Engine> = {}) {
  const engine = {
    onChange: () => {},
    listRuns: () => [],
    getRun: () => undefined,
    evictRun: () => {},
    restoreRun: () => {},
    ...engineOverrides,
  } as unknown as Engine;
  return buildHttpServer({
    engine,
    store: new Store(dataDir),
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

describe('v7-A2 归档可出', () => {
  it('归档非默认空间的 run：记录移入该空间 archive/，主目录不再残留', async () => {
    const dir = tmp();
    const run = makeRun('r1', 'demo');
    const demoStore = new Store(dir, 'demo');
    demoStore.saveRun(run);
    const { app } = await buildServer(dir, {
      getRun: ((id: string) => (id === 'r1' ? run : undefined)) as Engine['getRun'],
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/runs/r1/archive', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(path.join(dir, 'spaces', 'demo', 'runs', 'r1.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'spaces', 'demo', 'runs', 'archive', 'r1.json'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /api/runs?archived=1 跨空间收集归档记录', async () => {
    const dir = tmp();
    const demoStore = new Store(dir, 'demo');
    demoStore.saveRun({ ...makeRun('a1', 'demo'), archived: true });
    demoStore.saveRun({ ...makeRun('a2', 'demo'), archived: true, startedAt: '2026-09-19T00:00:00.000Z' });
    new Store(dir).saveRun({ ...makeRun('a0', 'default'), archived: true, startedAt: '2026-09-17T00:00:00.000Z' });
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs?archived=1', headers: { host: HOST } });
      const ids = (res.json().runs as RunRecord[]).map((r) => r.runId);
      expect(ids).toEqual(['a2', 'a1', 'a0']); // 按开始时间倒序，跨空间合并
      const main = await app.inject({ method: 'GET', url: '/api/runs', headers: { host: HOST } });
      expect((main.json().runs as RunRecord[]).length).toBe(0); // 主列表不受影响
    } finally {
      await app.close();
    }
  });

  it('反归档：文件回到主目录、archived 清除、回注引擎内存', async () => {
    const dir = tmp();
    const demoStore = new Store(dir, 'demo');
    demoStore.saveRun({ ...makeRun('a1', 'demo'), archived: true });
    let restored: RunRecord | undefined;
    const { app } = await buildServer(dir, {
      restoreRun: ((r: RunRecord) => {
        restored = r;
      }) as Engine['restoreRun'],
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/runs/a1/unarchive', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(restored?.runId).toBe('a1');
      expect(restored?.archived).toBe(false);
      expect(fs.existsSync(path.join(dir, 'spaces', 'demo', 'runs', 'a1.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'spaces', 'demo', 'runs', 'archive', 'a1.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('反归档不存在的记录 → 404', async () => {
    const { app } = await buildServer(tmp());
    try {
      const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/unarchive', headers: { host: HOST } });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('真删除：只删归档记录；未归档的 run 拒绝（404 + 文案指向先归档）', async () => {
    const dir = tmp();
    const store = new Store(dir);
    store.saveRun({ ...makeRun('a1', 'default'), archived: true });
    store.saveRun(makeRun('live', 'default'));
    const { app } = await buildServer(dir);
    try {
      const del = await app.inject({ method: 'DELETE', url: '/api/runs/a1/archive', headers: { host: HOST } });
      expect(del.statusCode).toBe(200);
      expect(fs.existsSync(path.join(dir, 'spaces', 'default', 'runs', 'archive', 'a1.json'))).toBe(false);
      const delLive = await app.inject({ method: 'DELETE', url: '/api/runs/live/archive', headers: { host: HOST } });
      expect(delLive.statusCode).toBe(404);
      expect((delLive.json() as { error: string }).error).toContain('已归档');
      expect(fs.existsSync(path.join(dir, 'spaces', 'default', 'runs', 'live.json'))).toBe(true); // 主列表记录分动不得
    } finally {
      await app.close();
    }
  });
});
