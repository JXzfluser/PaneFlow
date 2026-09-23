import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import type { RunRecord } from '@paneflow/shared';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-replay-'));
}

async function buildServer(opts: {
  dataDir: string;
  replayRun?: (
    id: string,
    meta?: unknown,
    /** v12-S1b/S3：路由把两旗标收进第三参原样透传（判据全在 engine） */
    opts?: { allowSideEffects?: boolean; fromFailed?: boolean },
  ) => Promise<Partial<RunRecord>>;
  listRuns?: () => unknown[];
}) {
  const replayRun = opts.replayRun ?? (async () => ({ runId: 'new-1', state: 'running' as const }));
  const engine = {
    onChange: () => {},
    getRun: () => undefined,
    listRuns: opts.listRuns ?? (() => []),
    replayRun: vi.fn(replayRun),
  };
  const { app } = await buildHttpServer({
    engine: engine as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(opts.dataDir, 'herdr.sock'),
    dataDir: opts.dataDir,
    readGhCliToken: async () => {
      throw new Error('test stub');
    },
    lookupGithubLogin: async () => null,
  });
  return { app, replayRun: engine.replayRun };
}

const post = (app: { inject: (o: object) => Promise<{ statusCode: number; json(): any }> }, id: string, payload?: unknown) =>
  app.inject({ method: 'POST', url: `/api/runs/${id}/replay`, payload: payload as object });

describe('v11-E1a POST /api/runs/:id/replay（同契约复跑端点）', () => {
  it('times 非 1~20 整数一律 400 指路；缺省=1 份', async () => {
    const { app } = await buildServer({ dataDir: tmp() });
    try {
      for (const bad of ['abc', 0, 21, -3, 2.5]) {
        const res = await post(app, 'r-1', { times: bad });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('1~20');
      }
      const def = await post(app, 'r-1', {});
      expect(def.statusCode).toBe(200);
      expect(def.json()).toEqual({ runs: [{ runId: 'new-1', state: 'running' }] });
    } finally {
      await app.close();
    }
  });

  it('实验元数据原样透传给 engine.replayRun；返回只回 runId/state 摘要', async () => {
    const { app, replayRun } = await buildServer({ dataDir: tmp() });
    try {
      const res = await post(app, 'src-9', { times: '2', suite: 'c4', arm: 'b', flag: 'readback=off' });
      expect(res.statusCode).toBe(200);
      expect(res.json().runs).toHaveLength(2);
      expect(replayRun).toHaveBeenCalledTimes(2);
      expect(replayRun.mock.calls[0]![0]).toBe('src-9');
      expect(replayRun.mock.calls[0]![1]).toEqual({ suite: 'c4', arm: 'b', flag: 'readback=off' });
    } finally {
      await app.close();
    }
  });

  it('第一份就失败：找不到→404，其余门（脏检查等）→400，error 原文指路', async () => {
    const miss = await buildServer({
      dataDir: tmp(),
      replayRun: async (id) => {
        throw new Error(`找不到要 replay 的原 run：${id}`);
      },
    });
    try {
      const res = await post(miss.app, 'zz', {});
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toContain('找不到要 replay 的原 run：zz');
    } finally {
      await miss.app.close();
    }
    const gated = await buildServer({
      dataDir: tmp(),
      replayRun: async () => {
        throw new Error('工作区有未提交改动，拒绝启动');
      },
    });
    try {
      const res = await post(gated.app, 'r-1', { times: 3 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('未提交改动');
    } finally {
      await gated.app.close();
    }
  });

  it('半路失败：已起单如实返回 + error 说明第几份断在哪（不吞已成的）', async () => {
    let n = 0;
    const { app } = await buildServer({
      dataDir: tmp(),
      replayRun: async () => {
        n++;
        if (n >= 2) throw new Error('Issue 7 已有运行中/排队中的流水线');
        return { runId: `ok-${n}`, state: 'running' as const };
      },
    });
    try {
      const res = await post(app, 'r-1', { times: 3 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        runs: [{ runId: 'ok-1', state: 'running' }],
        error: '第 2/3 份起单失败：Issue 7 已有运行中/排队中的流水线',
      });
    } finally {
      await app.close();
    }
  });
});

// -- v12-S1b/S3 replay 端点追加两体键：allowSideEffects / fromFailed（薄透传，判据在 engine） --
describe('v12-S1b/S3 POST /api/runs/:id/replay 两新体键透传与错误映射', () => {
  it('allowSideEffects/fromFailed 原样进 engine.replayRun 第三参；缺省双 false（旧调用零破坏）', async () => {
    const { app, replayRun } = await buildServer({ dataDir: tmp() });
    try {
      await post(app, 'r-1', { allowSideEffects: true });
      expect(replayRun.mock.calls[0]![2]).toEqual({ allowSideEffects: true, fromFailed: false });
      await post(app, 'r-1', { fromFailed: true, suite: 'c4' });
      expect(replayRun.mock.calls[1]![2]).toEqual({ allowSideEffects: false, fromFailed: true });
      await post(app, 'r-1', {});
      expect(replayRun.mock.calls[2]![2]).toEqual({ allowSideEffects: false, fromFailed: false });
      // meta 仍在第二参（既有语义不动）
      expect(replayRun.mock.calls[1]![1]).toEqual({ suite: 'c4' });
    } finally {
      await app.close();
    }
  });

  it('S1b 副作用拒绝 → 400 两行指路文案（含两旗标）；不含「找不到」不误伤 404', async () => {
    const { app } = await buildServer({
      dataDir: tmp(),
      replayRun: async (id) => {
        throw new Error(
          `源 run ${id} 有副作用（建单#12 · PR https://github.com/o/r/pull/3）——直接重放会二次副作用\n显式穿透加 --allow-side-effects；只重跑失败/未执行节点加 --from-failed`,
        );
      },
    });
    try {
      const res = await post(app, 'r-1', {});
      expect(res.statusCode).toBe(400);
      const err = res.json().error as string;
      expect(err).toContain('有副作用');
      expect(err).toContain('--allow-side-effects');
      expect(err).toContain('--from-failed');
    } finally {
      await app.close();
    }
  });
});

describe('v11-E1b GET /api/runs 实验过滤（?suite=&arm=，无参数语义不变）', () => {
  const run = (runId: string, experiment?: { suite?: string; arm?: string }) => ({ runId, experiment });

  it('无参全量；suite/arm 各自窄化且可叠用；非实验单不会命中过滤', async () => {
    const { app } = await buildServer({
      dataDir: tmp(),
      listRuns: () => [
        run('e1', { suite: 'c4', arm: 'a' }),
        run('e2', { suite: 'c4', arm: 'b' }),
        run('x1'),
      ],
    });
    try {
      expect((await app.inject({ url: '/api/runs' })).json().runs).toHaveLength(3);
      expect((await app.inject({ url: '/api/runs?suite=c4' })).json().runs.map((r: { runId: string }) => r.runId)).toEqual(['e1', 'e2']);
      expect((await app.inject({ url: '/api/runs?arm=b' })).json().runs.map((r: { runId: string }) => r.runId)).toEqual(['e2']);
      expect((await app.inject({ url: '/api/runs?suite=c4&arm=b' })).json().runs.map((r: { runId: string }) => r.runId)).toEqual(['e2']);
      expect((await app.inject({ url: '/api/runs?suite=nope' })).json().runs).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('v11-E1c GET /api/experiments（收数表只读直呈，零加工）', () => {
  function seed(dataDir: string, suite: string, day: string, rows: string[]) {
    const dir = path.join(dataDir, 'experiments', suite);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${day}.md`),
      ['# 实验收数 ·', suite, '', '| runId | arm | flag | state | 断言 pass/total | 重试 | 墙钟秒 | replayOf |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n') + '\n',
    );
  }

  it('缺目录=空表不抛；有表按 suite 目录列；?suite= 窄化；?runId= 只认行首前缀', async () => {
    const dir = tmp();
    const a = await buildServer({ dataDir: dir });
    try {
      expect((await a.app.inject({ url: '/api/experiments' })).json()).toEqual({ tables: [] });
    } finally {
      await a.app.close();
    }
    seed(dir, 'c4', '2026-09-21', ['| abc12345 | a | on | completed | 2/2 | 0 | 150 | src-9 |']);
    seed(dir, '其它', '2026-09-21', ['| zz000001 | - | - | failed | 0/1 | 1 | 90 | - |']);
    const { app } = await buildServer({ dataDir: dir });
    try {
      const all = (await app.inject({ url: '/api/experiments' })).json();
      expect(all.tables.map((t: { file: string }) => t.file)).toEqual(['experiments/c4/2026-09-21.md', 'experiments/其它/2026-09-21.md']);
      expect(all.tables[0].rows[0]).toContain('| runId |'); // 表头随行返回，CLI 读列名
      const one = (await app.inject({ url: '/api/experiments?suite=c4' })).json();
      expect(one.tables).toHaveLength(1);
      expect(one.tables[0].rows).toHaveLength(2); // 表头 + 1 数据行
      const byRun = (await app.inject({ url: '/api/experiments?runId=abc' })).json();
      expect(byRun.tables).toHaveLength(1);
      expect(byRun.tables[0].rows).toEqual(['| abc12345 | a | on | completed | 2/2 | 0 | 150 | src-9 |']);
      expect((await app.inject({ url: '/api/experiments?suite=nope' })).json()).toEqual({ tables: [] });
    } finally {
      await app.close();
    }
  });
});
