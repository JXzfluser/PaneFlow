import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph, NodeEquip, NodeRunRecord, NodeRunState, RunRecord } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import { saveRoles } from '../orchestrate/roles.js';

/**
 * v13-W4 角色能力账：GET /api/roles/:id/profile —— 本版唯一新增端点，且是纯读。
 * 这里守的是三条口径（判据本身在 api/role-profile.ts 的注释里）：
 *  ①样本归属认「注入现场实绑」（W1 equip.role）优先于图里名义 config.role；
 *  ②按 roleSha 分组（W2 换装备=换指纹），没落指纹的旧单只进总账不进组；
 *  ③宁缺毋假——每个指标自带分母 n，没有支持样本的指标整键省略（0 是正断言，「不知道」不是 0）。
 * 跑法与 http-machine-check.test.ts 同款：把引擎会落册的 RunRecord 形状原样喂进 listRuns，
 * 打真路由（app.inject），不碰任何内部实现。
 */

const HOST = '127.0.0.1:4310';

function buildServer(runs: RunRecord[], roleIds: string[]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-roleprof-'));
  saveRoles(dataDir, roleIds.map((id) => ({ id, name: `岗-${id}` })));
  return buildHttpServer({
    engine: { onChange: () => {}, listRuns: () => runs } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
  });
}

/** 单岗/多岗图：每个 agent 节点可带名义 role 与机检项 */
function graphOf(nodes: { id: string; role?: string; checks?: unknown[] }[]): DagGraph {
  return {
    version: 1,
    name: 'g',
    nodes: nodes.map((n) => ({
      id: n.id,
      type: 'agent',
      label: n.id,
      config: { prompt: '干活', ...(n.role ? { role: n.role } : {}), ...(n.checks ? { checks: n.checks } : {}) },
    })),
    edges: [],
    metadata: { createdAt: '', updatedAt: '' },
  } as unknown as DagGraph;
}

function rec(state: NodeRunState, equip?: NodeEquip): NodeRunRecord {
  return { nodeId: 'x', state, attempts: 1, ...(equip ? { equip } : {}) } as NodeRunRecord;
}

const roleEquip = (role: string): NodeEquip => ({ scope: 'role', role, skills: ['skills/a.md'], rules: [] });

function runOf(o: {
  runId: string;
  graph: DagGraph;
  nodes: Record<string, NodeRunRecord>;
  state?: RunRecord['state'];
  roleSha?: string;
  attention?: { waitMs: number; gates: { approve: number; reject: number; input: number } };
  tokens?: { input: number; output: number } | null;
}): RunRecord {
  return {
    runId: o.runId,
    dagName: 'g',
    graph: o.graph,
    state: o.state ?? 'completed',
    cwd: '/tmp',
    nodes: o.nodes,
    startedAt: new Date(0).toISOString(),
    ...(o.roleSha || o.attention || o.tokens
      ? {
          harness: { graphSha: 'gs', agentKind: 'fake', readback: false, readbackOutcome: 'no-pages', ...(o.roleSha ? { roleSha: o.roleSha } : {}) },
        }
      : {}),
    ...(o.attention ? { attention: o.attention } : {}),
    ...(o.tokens !== undefined ? { cost: { totalMs: 1, byNode: {}, retries: 0, tokens: o.tokens } } : {}),
  } as unknown as RunRecord;
}

async function get(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }> }, id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/roles/${id}/profile`, headers: { host: HOST } });
  return { code: res.statusCode, body: res.json() };
}

describe('GET /api/roles/:id/profile（v13-W4 角色能力账，纯读端点）', () => {
  it('岗不存在 → 404 一句指路（指回 GET /api/roles，不猜也不给空账）', async () => {
    const { app } = await buildServer([], ['impl']);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/roles/ghost/profile', headers: { host: HOST } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toContain('GET /api/roles');
    } finally {
      await app.close();
    }
  });

  it('有岗无单 → 200 空账：runs:0 是正读数「这岗一次没上过」，且一个指标键都不造', async () => {
    const { app } = await buildServer([], ['impl']);
    try {
      const { code, body } = await get(app, 'impl');
      expect(code).toBe(200);
      expect(body.role).toEqual({ id: 'impl', name: '岗-impl' });
      expect(body.overall).toEqual({ runs: 0 });
      expect(body.overall).not.toHaveProperty('passRate');
      expect(body).not.toHaveProperty('byRoleSha');
    } finally {
      await app.close();
    }
  });

  it('样本归属：实绑（equip.role）压过图里名义 config.role——写的是 A 岗、吃的是 B 岗，账只记 B', async () => {
    const g = graphOf([{ id: 'a', role: 'alpha' }]);
    const runs = [runOf({ runId: 'r1', graph: g, nodes: { a: rec('done', roleEquip('beta')) } })];
    const { app } = await buildServer(runs, ['alpha', 'beta']);
    try {
      expect((await get(app, 'alpha')).body.overall).toEqual({ runs: 0 });
      const beta = (await get(app, 'beta')).body;
      expect(beta.overall.runs).toBe(1);
      expect(beta.overall.nodePassRate).toEqual({ n: 1, done: 1, failed: 0 });
    } finally {
      await app.close();
    }
  });

  it('没落 equip 的 pre-W1 旧单回落名义 config.role：账不因缺实绑而丢样本', async () => {
    const g = graphOf([{ id: 'a', role: 'alpha' }]);
    const { app } = await buildServer([runOf({ runId: 'old', graph: g, nodes: { a: rec('done') } })], ['alpha']);
    try {
      const { body } = await get(app, 'alpha');
      expect(body.overall.runs).toBe(1);
      expect(body.overall.passRate).toEqual({ n: 1, passed: 1 });
    } finally {
      await app.close();
    }
  });

  it('按 roleSha 分组：换装备=换指纹=换一行，组间对比让回退可见；总账含两组', async () => {
    const g = (role: string) => graphOf([{ id: 'a', role }]);
    const runs = [
      runOf({ runId: 'r1', graph: g('impl'), nodes: { impl: rec('done') }, roleSha: 'sha-b' }),
      runOf({ runId: 'r2', graph: g('impl'), nodes: { impl: rec('failed') }, state: 'failed', roleSha: 'sha-b' }),
      runOf({ runId: 'r3', graph: g('impl'), nodes: { impl: rec('done') }, roleSha: 'sha-a' }),
    ];
    const { app } = await buildServer(runs, ['impl']);
    try {
      const { body } = await get(app, 'impl');
      expect(body.overall).toMatchObject({ runs: 3, passRate: { n: 3, passed: 2 } });
      expect(body.byRoleSha.map((g2: { roleSha: string }) => g2.roleSha)).toEqual(['sha-b', 'sha-a']);
      expect(body.byRoleSha[0]).toMatchObject({ roleSha: 'sha-b', runs: 2, passRate: { n: 2, passed: 1 } });
      expect(body.byRoleSha[1]).toMatchObject({ roleSha: 'sha-a', runs: 1, passRate: { n: 1, passed: 1 } });
    } finally {
      await app.close();
    }
  });

  it('没落 roleSha 的单只进总账不进组：Σ 各组 runs < 总账 runs 是口径事实，绝不造假指纹键', async () => {
    const g = graphOf([{ id: 'a', role: 'impl' }]);
    const runs = [
      runOf({ runId: 'no-sha', graph: g, nodes: { a: rec('done') } }),
      runOf({ runId: 'with-sha', graph: g, nodes: { a: rec('done') }, roleSha: 'sha-x' }),
    ];
    const { app } = await buildServer(runs, ['impl']);
    try {
      const { body } = await get(app, 'impl');
      expect(body.overall.runs).toBe(2);
      expect(body.byRoleSha).toHaveLength(1);
      expect(body.byRoleSha[0].runs).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('宁缺毋假分母：attention/token 只在落了账的单上计入，缺账单进 runs 而不进该指标 n', async () => {
    const g = graphOf([{ id: 'a', role: 'impl' }]);
    const runs = [
      runOf({
        runId: 'r-full',
        graph: g,
        nodes: { a: rec('done') },
        attention: { waitMs: 60_000, gates: { approve: 2, reject: 1, input: 0 } },
        tokens: { input: 100, output: 50 },
      }),
      // 没批过门（无 attention 账）+ agent 没自报 usage（tokens=null）= 两个「不知道」
      runOf({ runId: 'r-empty', graph: g, nodes: { a: rec('done') }, attention: undefined, tokens: null }),
    ];
    const { app } = await buildServer(runs, ['impl']);
    try {
      const { body } = await get(app, 'impl');
      expect(body.overall.runs).toBe(2);
      expect(body.overall.attention).toEqual({ n: 1, waitMs: 60_000, gates: { approve: 2, reject: 1, input: 0 } });
      expect(body.overall.tokens).toEqual({ n: 1, input: 100, output: 50 });
    } finally {
      await app.close();
    }
  });

  it('指标全无支持样本 → 整键省略而不是画 0；机检 0 项是正读数（「这岗从没被机检过」）故保留', async () => {
    const g = graphOf([{ id: 'a', role: 'impl' }]);
    const { app } = await buildServer([runOf({ runId: 'r1', graph: g, nodes: { a: rec('done') } })], ['impl']);
    try {
      const { body } = await get(app, 'impl');
      expect(body.overall).not.toHaveProperty('attention');
      expect(body.overall).not.toHaveProperty('tokens');
      // 无 checks 的单：machineCheckTally 返回全 0（正断言），机检覆盖因此如实报 0 而不是缺键
      expect(body.overall.machineCheck).toMatchObject({ n: 1, items: 0, verified: 0, runsAllPassed: 0 });
    } finally {
      await app.close();
    }
  });

  it('cancelled 不入通过率分母（人停的单不是对岗位的裁决）：runs 有它、passRate 没它', async () => {
    const g = graphOf([{ id: 'a', role: 'impl' }]);
    const { app } = await buildServer([runOf({ runId: 'r1', graph: g, nodes: { a: rec('cancelled') }, state: 'cancelled' })], ['impl']);
    try {
      const { body } = await get(app, 'impl');
      expect(body.overall.runs).toBe(1);
      expect(body.overall).not.toHaveProperty('passRate');
      expect(body.overall).not.toHaveProperty('nodePassRate');
    } finally {
      await app.close();
    }
  });

  it('多岗单=上界归因：含该岗即整单入账，两岗各自看到同一份 run 级 attention', async () => {
    const g = graphOf([
      { id: 'a', role: 'alpha' },
      { id: 'b', role: 'beta' },
    ]);
    const run = runOf({
      runId: 'r1',
      graph: g,
      nodes: { a: rec('done', roleEquip('alpha')), b: rec('failed', roleEquip('beta')) },
      attention: { waitMs: 30_000, gates: { approve: 1, reject: 0, input: 1 } },
    });
    const { app } = await buildServer([run], ['alpha', 'beta']);
    try {
      const alpha = (await get(app, 'alpha')).body;
      const beta = (await get(app, 'beta')).body;
      // 岗级节点通过率不混账：各数各的终态节点
      expect(alpha.overall.nodePassRate).toEqual({ n: 1, done: 1, failed: 0 });
      expect(beta.overall.nodePassRate).toEqual({ n: 1, done: 0, failed: 1 });
      // run 级账则是上界归因（分母 n 如实暴露构成）
      expect(alpha.overall.attention).toEqual(beta.overall.attention);
      expect(alpha.overall.attention.n).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('机检覆盖读既有 tally：有 checks 且全 done 的单记 items/verified/runsAllPassed', async () => {
    const g = graphOf([{ id: 'a', role: 'impl', checks: [{ type: 'command', run: 'pnpm test' }] }]);
    const { app } = await buildServer([runOf({ runId: 'r1', graph: g, nodes: { a: rec('done') } })], ['impl']);
    try {
      const { body } = await get(app, 'impl');
      expect(body.overall.machineCheck).toEqual({ n: 1, items: 1, verified: 1, runsAllPassed: 1 });
    } finally {
      await app.close();
    }
  });
});
