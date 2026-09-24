import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NodeRunRecord, NodeRunState, RunRecord } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v11-A1 CLI 的 server 只读扩字段回归：
 *  1) POST /api/dispatch 响应带 nodes 清单摘要（id/name/type/deps）——只加不改；
 *  2) GET /api/runs/:id 带 awaitingApproval 聚合（blocked/paused 显式审批门信号）。
 */
function buildServer(engine: Partial<Engine>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cli-'));
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

const nodeRec = (nodeId: string, state: NodeRunState): NodeRunRecord => ({ nodeId, state, attempts: 1 });

const fakeRun = (over: Partial<RunRecord>): RunRecord =>
  ({
    runId: 'r-1',
    dagName: 'dispatch-x',
    graph: { version: 1, name: 'dispatch-x', nodes: [], edges: [] },
    state: 'running',
    cwd: '/tmp',
    nodes: {},
    startedAt: new Date(0).toISOString(),
    ...over,
  }) as RunRecord;

describe('POST /api/dispatch 响应扩 nodes（v11-A1）', () => {
  it('返回派发图的节点清单摘要；既有字段原样在位', async () => {
    const { app } = await buildServer({
      startRun: async (graph: RunRecord['graph']) =>
        fakeRun({ runId: 'r-9', graph }),
    });
    try {
      // v13-E2 fail-closed：探测恒空的机器（如 CI）上派单必须显式有 Planner kind——钉进空间档案
      const put = await app.inject({
        method: 'PUT',
        url: '/api/spaces/e2cli',
        headers: { host: HOST },
        payload: { rootCwd: '/tmp', defaultAgentKind: 'pi' },
      });
      expect(put.statusCode).toBe(200);
      const res = await app.inject({
        method: 'POST',
        url: '/api/dispatch?space=e2cli',
        headers: { host: HOST },
        payload: { task: '把导出补上', cwd: '/tmp' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.runId).toBe('r-9');
      expect(body.issueFetched).toBe(false);
      expect(body.contract).toBeDefined(); // 既有字段不丢
      expect(body.nodes).toEqual([
        { id: 'start', name: '开始', type: 'start', dependsOn: [] },
        { id: 'planner', name: 'Planner · 下发规划', type: 'agent', dependsOn: ['start'] },
        { id: 'route', name: '路由执行', type: 'pipeline', dependsOn: ['planner'] },
        { id: 'end', name: '结束', type: 'end', dependsOn: ['route'] },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/runs/:id 响应扩 awaitingApproval（v11-A1）', () => {
  it('blocked 节点且无推进中节点 → waiting:true 并列出待批 id；paused 同样是门信号', async () => {
    const { app } = await buildServer({
      getRun: (id: string) =>
        id === 'r-block'
          ? fakeRun({ runId: 'r-block', nodes: { plan: nodeRec('plan', 'done'), contract: nodeRec('contract', 'blocked') } })
          : id === 'r-pause'
            ? fakeRun({ runId: 'r-pause', nodes: { a: nodeRec('a', 'paused') } })
            : undefined,
    });
    try {
      const r1 = await app.inject({ method: 'GET', url: '/api/runs/r-block', headers: { host: HOST } });
      expect(r1.statusCode).toBe(200);
      expect(r1.json().awaitingApproval).toEqual({ nodeIds: ['contract'], waiting: true });
      expect(r1.json().state).toBe('running'); // 既有字段不受影响
      const r2 = await app.inject({ method: 'GET', url: '/api/runs/r-pause', headers: { host: HOST } });
      expect(r2.json().awaitingApproval).toEqual({ nodeIds: ['a'], waiting: true });
    } finally {
      await app.close();
    }
  });

  it('并行分支还在推进（有 working 节点）→ nodeIds 照列但 waiting:false', async () => {
    const { app } = await buildServer({
      getRun: () =>
        fakeRun({
          nodes: {
            a: nodeRec('a', 'blocked'),
            b: nodeRec('b', 'working'),
          },
        }),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-1', headers: { host: HOST } });
      expect(res.json().awaitingApproval).toEqual({ nodeIds: ['a'], waiting: false });
    } finally {
      await app.close();
    }
  });

  it('终态 run：waiting 恒 false；404 行为不变', async () => {
    const { app } = await buildServer({
      getRun: (id: string) =>
        id === 'r-done'
          ? fakeRun({ runId: 'r-done', state: 'failed', nodes: { a: nodeRec('a', 'failed') } })
          : undefined,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-done', headers: { host: HOST } });
      expect(res.json().awaitingApproval).toEqual({ nodeIds: [], waiting: false });
      const nf = await app.inject({ method: 'GET', url: '/api/runs/nope', headers: { host: HOST } });
      expect(nf.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
