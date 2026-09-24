import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { machineCheckTally } from '@paneflow/shared';
import type { DagGraph, NodeRunRecord, NodeRunState, RunRecord } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v13-V1 机检/自报双口径（纯读端）：machineCheckTally 从 graph 各节点 checks[]（机检类 =
 * file-exists/command/regex/delivery-branch/contract，manual 不算）× 节点 state 推导
 * 「done⇒机检全过」——机检成功历史上从没落过册，写端方案对旧 run 永远缺账，只能读时算。
 * 挂 GET /api/runs/:id 只读聚合字段（awaitingApproval 同款姿势），state 拿不到整键省略：
 * 0 是正断言（「一条机检都没过」），「不知道」不是 0。
 */

const graphOf = (checksByNode: Record<string, unknown[]>): DagGraph =>
  ({
    version: 1,
    name: 'g',
    nodes: Object.entries(checksByNode).map(([id, checks]) => ({
      id,
      type: 'agent',
      label: id,
      config: { prompt: '干活', checks },
    })),
    edges: [],
    metadata: { createdAt: '', updatedAt: '' },
  }) as unknown as DagGraph;

const rec = (nodeId: string, state: NodeRunState): NodeRunRecord => ({ nodeId, state, attempts: 1 });

function runOf(graph: DagGraph, nodes: Record<string, NodeRunRecord>): RunRecord {
  return {
    runId: 'r-mc1',
    dagName: 'tally-x',
    graph,
    state: 'completed',
    cwd: '/tmp',
    nodes,
    startedAt: new Date(0).toISOString(),
  } as RunRecord;
}

describe('v13-V1 machineCheckTally 纯函数：done⇒机检全过按 state 推导，manual 不进账', () => {
  it('机检节点全 done → verified=nodes、allPassed=true；manual 检查不计机检', () => {
    const g = graphOf({
      impl: [{ type: 'command', run: 'pnpm test' }, { type: 'manual', prompt: '人看一眼' }],
      deliver: [{ type: 'contract' }, { type: 'delivery-branch' }],
    });
    expect(machineCheckTally(runOf(g, { impl: rec('impl', 'done'), deliver: rec('deliver', 'done') }))).toEqual({
      items: 3, // command + contract + delivery-branch（manual 被剔）
      nodes: 2,
      verified: 2,
      allPassed: true,
    });
  });

  it('state 拿得到但没全 done → 如实计红（verified 缩水、allPassed=false），不整键省略', () => {
    const g = graphOf({ a: [{ type: 'file-exists', path: 'x.md' }], b: [{ type: 'regex', file: 'y', pattern: 'z' }] });
    expect(machineCheckTally(runOf(g, { a: rec('a', 'done'), b: rec('b', 'failed') }))).toEqual({
      items: 2,
      nodes: 2,
      verified: 1,
      allPassed: false,
    });
  });

  it('无机检的单（全 manual / 无 checks）：返回全 0 且 allPassed=false——「没有机检」第一次可见，绝不画 100%', () => {
    const g = graphOf({ a: [{ type: 'manual', prompt: '看看' }], b: [] });
    expect(machineCheckTally(runOf(g, { a: rec('a', 'done'), b: rec('b', 'done') }))).toEqual({
      items: 0,
      nodes: 0,
      verified: 0,
      allPassed: false,
    });
    // 未知 checks[].type（v13-V0 白名单前的旧图）不算机检：引擎当年对它是静默通过，没资格声称实跑过
    const legacy = graphOf({ a: [{ type: 'file-eksists', path: 'x' }] as unknown[] });
    expect(machineCheckTally(runOf(legacy, { a: rec('a', 'done') }))!.items).toBe(0);
  });

  it('state 拿不到（机检节点缺记录 / 无 graph / 空图）→ 返回 null，调用端整键省略，绝不画 0', () => {
    const g = graphOf({ a: [{ type: 'command', run: 't' }] });
    expect(machineCheckTally(runOf(g, {}))).toBeNull();
    expect(machineCheckTally(undefined)).toBeNull();
    expect(machineCheckTally(null)).toBeNull();
    expect(machineCheckTally({ runId: 'x', graph: { version: 1, name: 'g', nodes: [], edges: [] } as unknown as DagGraph, nodes: {} } as unknown as RunRecord)).toBeNull();
  });
});

// -- 路由面：GET /api/runs/:id 只读聚合字段 ---------------------------------------

function buildServer(engine: Partial<Engine>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tally-'));
  return buildHttpServer({
    engine: { onChange: () => {}, ...engine } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
  });
}

const HOST = '127.0.0.1:4310';

describe('GET /api/runs/:id 响应扩 machineCheckTally（v13-V1，只加不改）', () => {
  it('机检可推 → 带聚合字段；既有 run 字段与 awaitingApproval 原样在位', async () => {
    const { app } = await buildServer({
      getRun: () =>
        runOf(graphOf({ impl: [{ type: 'command', run: 'pnpm test' }], wrap: [{ type: 'manual', prompt: '确认' }] }), {
          impl: rec('impl', 'done'),
          wrap: rec('wrap', 'done'),
        }),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-mc1', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.machineCheckTally).toEqual({ items: 1, nodes: 1, verified: 1, allPassed: true });
      expect(body.runId).toBe('r-mc1');
      expect(body.awaitingApproval).toEqual({ nodeIds: [], waiting: false });
    } finally {
      await app.close();
    }
  });

  it('机检节点 state 拿不到（旧 run 图账对不上）→ 响应干脆没有 machineCheckTally 键，不画 0', async () => {
    const { app } = await buildServer({
      getRun: () => runOf(graphOf({ impl: [{ type: 'command', run: 'pnpm test' }] }), {}),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-mc1', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('machineCheckTally');
    } finally {
      await app.close();
    }
  });
});
