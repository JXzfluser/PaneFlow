import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import { writeGithubSettings } from './github-cred.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/** v8-G3 批量派发路由：一列 issue → N 个 startRun（变量映射/契约机检/失败面） */
function tplGraph(name: string, vars: DagGraph['variables']): DagGraph {
  return {
    version: 1,
    name,
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      { id: 'impl', type: 'agent', label: '执行', config: { agentKind: 'fake', prompt: '干：{{task}}' } },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'impl' },
      { id: 'e2', source: 'impl', target: 'end' },
    ],
    metadata: { createdAt: '', updatedAt: '' },
    ...(vars ? { variables: vars } : {}),
  };
}

interface StartRunCall {
  graph: DagGraph;
  cwd: string;
  variables?: Record<string, string>;
  issueId?: string;
  opts?: { contract?: unknown };
}

function buildServer(dataDir: string, calls: StartRunCall[], state: 'running' | 'queued') {
  const engine = {
    onChange: () => {},
    startRun: async (
      graph: DagGraph,
      cwd: string,
      spaceId?: string,
      variables?: Record<string, string>,
      issueId?: string,
      resumeOf?: string,
      opts?: { contract?: unknown },
    ) => {
      calls.push({ graph, cwd, variables, issueId, opts });
      return { runId: `r-${calls.length}`, state } as unknown as RunRecord;
    },
  } as unknown as Engine;
  return buildHttpServer({
    engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    // U2：兜底探 gh 桩死，测试不碰本机钥匙串
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
  });
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-batch-'));
const HOST = '127.0.0.1:4310';

function issueStub(n: number) {
  const body = n === 13 ? '修导出\n\n## 验收标准\n- 导出文件非空' : '普通正文';
  return {
    ok: true,
    status: 200,
    json: async () => ({ number: n, title: `工单 ${n}`, body, state: 'open', html_url: `u/${n}`, labels: [] }),
  };
}

describe('POST /api/dispatch/batch（v8-G3）', () => {
  it('编号列（含 URL/重复）去重展开 → 每单一 run：issue 文本进 task/brief、AC 机检入契约、坏编号单列失败', async () => {
    const dataDir = tmp();
    writeGithubSettings(dataDir, { token: 'tok', defaultRepo: 'o/r' });
    const calls: StartRunCall[] = [];
    const { app } = await buildServer(dataDir, calls, 'queued');
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/comments')) return { ok: true, status: 200, json: async () => [] };
      const m = u.match(/\/issues\/(\d+)/);
      const n = Number(m?.[1] ?? 0);
      if (n === 14) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
      return issueStub(n);
    });
    try {
      await app.inject({ method: 'POST', url: '/api/graphs?space=demo', headers: { host: HOST }, payload: { graph: tplGraph('tpl-batch', [{ key: 'task', label: '任务', required: true }]) } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/dispatch/batch?space=demo',
        headers: { host: HOST },
        payload: { template: 'tpl-batch', issues: '12, 13\n12\nhttps://github.com/o/r/issues/14', cwd: '/w' },
      });
      expect(res.statusCode).toBe(200);
      const j = res.json();
      expect(j.dispatched).toBe(2);
      expect(j.queued).toBe(2); // 桩引擎恒报 queued → 计数如实透传
      expect(j.failed).toEqual([{ issue: 14, error: expect.stringContaining('Not Found') }]);
      expect(calls.map((c) => c.issueId)).toEqual(['12', '13']);
      expect(calls[0]!.variables!.task).toContain('Issue #12（o/r）：工单 12');
      expect(calls[0]!.variables!.brief).toBe(calls[0]!.variables!.task);
      expect(calls[0]!.cwd).toBe('/w');
      // 12 无验收锚点 → 不带契约；13 有 → AC-1 入册（M2 同款形状）
      expect(calls[0]!.opts).toBeUndefined();
      expect((calls[1]!.opts as { contract: { assertions: { id: string; assertion: string }[] } }).contract.assertions).toEqual([
        { id: 'AC-1', assertion: '导出文件非空', verify_method: '' },
      ]);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('必填变量无法由 issue 文本填充 → 整批 400 拒绝，不派一单', async () => {
    const dataDir = tmp();
    writeGithubSettings(dataDir, { token: 'tok', defaultRepo: 'o/r' });
    const calls: StartRunCall[] = [];
    const { app } = await buildServer(dataDir, calls, 'running');
    try {
      await app.inject({ method: 'POST', url: '/api/graphs?space=demo', headers: { host: HOST }, payload: { graph: tplGraph('tpl-hard', [{ key: 'feature', label: '目标功能', required: true }]) } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/dispatch/batch?space=demo',
        headers: { host: HOST },
        payload: { template: 'tpl-hard', issues: '12', cwd: '/w' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('目标功能');
      expect(calls).toHaveLength(0);
      // vars 补上即可派
      vi.stubGlobal('fetch', async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/comments')) return { ok: true, status: 200, json: async () => [] };
        return issueStub(12);
      });
      const ok = await app.inject({
        method: 'POST',
        url: '/api/dispatch/batch?space=demo',
        headers: { host: HOST },
        payload: { template: 'tpl-hard', issues: '12', cwd: '/w', vars: { feature: '导出中心' } },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().dispatched).toBe(1);
      expect(calls[0]!.variables!.feature).toBe('导出中心');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('形状守卫：无模板/未知模板/编号为空都挡在门口', async () => {
    const dataDir = tmp();
    const calls: StartRunCall[] = [];
    const { app } = await buildServer(dataDir, calls, 'running');
    try {
      const noTpl = await app.inject({ method: 'POST', url: '/api/dispatch/batch?space=demo', headers: { host: HOST }, payload: { issues: '1' } });
      expect(noTpl.statusCode).toBe(400);
      const ghost = await app.inject({ method: 'POST', url: '/api/dispatch/batch?space=demo', headers: { host: HOST }, payload: { template: 'nope', issues: '1', cwd: '/w' } });
      expect(ghost.statusCode).toBe(404);
      await app.inject({ method: 'POST', url: '/api/graphs?space=demo', headers: { host: HOST }, payload: { graph: tplGraph('tpl-x', []) } });
      const empty = await app.inject({ method: 'POST', url: '/api/dispatch/batch?space=demo', headers: { host: HOST }, payload: { template: 'tpl-x', issues: '没有数字', cwd: '/w' } });
      expect(empty.statusCode).toBe(400);
      const tooMany = await app.inject({
        method: 'POST',
        url: '/api/dispatch/batch?space=demo',
        headers: { host: HOST },
        payload: { template: 'tpl-x', issues: Array.from({ length: 25 }, (_, i) => i + 1).join(','), cwd: '/w' },
      });
      expect(tooMany.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
