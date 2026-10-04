import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';
import { Engine } from './engine.js';
import type { EngineOptions } from './engine.js';
import { Store } from './store.js';
import { FakeHerdrOps } from './fake-ops.js';

/**
 * v18-R2 运行权限档位（engine 侧）：auto/readonly 两档的门自动放行（契约门豁免）、
 * 只读约束注入、replay 血缘继承。全链路真 Engine + FakeHerdrOps（engine.test 同款替身）。
 */

const OPTS: EngineOptions = {
  workspaceLabelPrefix: 'paneflow-',
  promptConfirmWindowMs: 0,
  reconcileIntervalMs: 60_000,
  defaultNodeTimeoutMs: 1_200,
  agentStartTimeoutMs: 5_000,
  agentReadyTimeoutMs: 5_000,
  recommendAgentKind: async () => 'reco',
};

function serialGraph(): DagGraph {
  return {
    version: 1,
    name: 'perm-serial-test',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      { id: 'impl', type: 'agent', label: '实现', config: { agentKind: 'fake', prompt: '实现功能' } },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'impl' },
      { id: 'e2', source: 'impl', target: 'end' },
    ],
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };
}

const writeImpl = (cwd: string, obj: unknown) => {
  fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify(obj));
};

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('condition not met in time'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('v18-R2 运行权限档位', () => {
  it('auto 档：人工检查门自动放行——单跑完、autoReleases=1、事件在册、attention 零账（自动放行不是人的决策）', async () => {
    const ops = new FakeHerdrOps();
    const engine = new Engine(ops, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-'))), OPTS);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [{ type: 'manual', prompt: '冒烟通过？' }];
    ops.onPrompt = () => writeImpl(cwd, { summary: '完成' });
    const started = await engine.startRun(graph, cwd, undefined, undefined, undefined, undefined, { permMode: 'auto' });
    await waitFor(() => engine.getRun(started.runId)!.state !== 'running');
    const run = engine.getRun(started.runId)!;
    expect(run.state).toBe('completed');
    expect(run.autoReleases).toBe(1);
    expect(run.nodes['impl']!.state).toBe('done');
    expect((run.events ?? []).some((e) => e.text.includes('权限档位自动放行') && e.text.includes('人工检查'))).toBe(true);
    // 自动放行绝不进人等分账（不结算 waitMs/计次）
    expect(run.attention).toBeUndefined();
  });

  it('缺省（normal）档：同一张图仍停在门上等人——今天的语义一字不变', async () => {
    const ops = new FakeHerdrOps();
    const engine = new Engine(ops, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-'))), OPTS);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [{ type: 'manual', prompt: '冒烟通过？' }];
    ops.onPrompt = () => writeImpl(cwd, { summary: '完成' });
    const started = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(started.runId, 'impl'));
    const mid = engine.getRun(started.runId)!;
    expect(mid.state).toBe('running');
    expect(mid.nodes['impl']!.state).toBe('blocked');
    expect(mid.permMode).toBeUndefined();
    await engine.approve(started.runId, 'impl', { action: 'reject' });
    await waitFor(() => engine.getRun(started.runId)!.state !== 'running');
    expect(engine.getRun(started.runId)!.state).toBe('failed');
  });

  it('auto 档契约门豁免：仍等人——「按什么约定干」的拍板权不随档位走；批过门才完成', async () => {
    const ops = new FakeHerdrOps();
    const engine = new Engine(ops, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-'))), OPTS);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [{ type: 'contract' }];
    ops.onPrompt = () =>
      writeImpl(cwd, {
        summary: '立约',
        extra: { contract: { assertions: [{ id: 'AC-1', assertion: '导出可用', verify_method: '' }], questions: [] } },
      });
    const started = await engine.startRun(graph, cwd, undefined, undefined, undefined, undefined, { permMode: 'auto' });
    await waitFor(() => engine.isBlocked(started.runId, 'impl'));
    // 档位不代批契约：门上等人、autoReleases 没有账
    expect(engine.getRun(started.runId)!.nodes['impl']!.blockedPrompt).toContain('契约接单门');
    expect(engine.getRun(started.runId)!.autoReleases).toBeUndefined();
    await engine.approve(started.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(started.runId)!.state !== 'running');
    const run = engine.getRun(started.runId)!;
    expect(run.state).toBe('completed');
    expect(run.contract?.confirmedAt).toBeTruthy();
    expect(run.permMode).toBe('auto');
  });

  it('readonly 档：只读约束块注入 prompt + 门自动放行', async () => {
    const ops = new FakeHerdrOps();
    const engine = new Engine(ops, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-'))), OPTS);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [{ type: 'manual', prompt: '结论可交？' }];
    ops.onPrompt = () => writeImpl(cwd, { summary: '调查结论' });
    const started = await engine.startRun(graph, cwd, undefined, undefined, undefined, undefined, { permMode: 'readonly' });
    await waitFor(() => engine.getRun(started.runId)!.state !== 'running');
    const run = engine.getRun(started.runId)!;
    expect(run.state).toBe('completed');
    expect(run.permMode).toBe('readonly');
    expect(ops.prompts.length).toBeGreaterThan(0);
    expect(ops.prompts.some((p) => p.text.includes('【只读档位】') && p.text.includes('禁止改动仓库文件'))).toBe(true);
  });

  it('replay 血缘继承档位：同契约复跑同档位，不 silently 落回常规', async () => {
    const ops = new FakeHerdrOps();
    const engine = new Engine(ops, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-'))), OPTS);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-perm-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [{ type: 'manual', prompt: '放行？' }];
    ops.onPrompt = () => writeImpl(cwd, { summary: '完成' });
    const started = await engine.startRun(graph, cwd, undefined, undefined, undefined, undefined, { permMode: 'auto' });
    await waitFor(() => engine.getRun(started.runId)!.state !== 'running');
    const replayed = await engine.replayRun(started.runId);
    await waitFor(() => engine.getRun(replayed.runId)!.state !== 'running');
    const run2 = engine.getRun(replayed.runId)!;
    expect(run2.permMode).toBe('auto');
    expect(run2.replayOf).toBe(started.runId);
  });
});
