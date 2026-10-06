import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph, DagNodeConfig, RunRecord } from '@paneflow/shared';
import { execFileSync } from 'node:child_process';
import { Engine, gateTimeoutMessage, NODE_NO_AGENT_KIND_ERROR, resolveGateTimeoutMs } from './engine.js';
import type { ApprovalAction, EngineOptions } from './engine.js';
import { BUILTIN_TEMPLATES } from './builtin-templates.js';
import { computeCtxSha, computeRoleSha, contentSha } from './harness.js';
import { READBACK_HEADER } from './readback.js';
import { WIKI_ROOT, wikiCacheDir } from '../api/wiki.js';
import { upsertGatewayProfile } from '../api/gateway.js';
import { Store } from './store.js';
import { RegistryStore } from './registry.js';
import { productSha } from './products.js';
import type { SpaceProfile } from './store.js';
import type { DeliveryRule } from './delivery.js';
import { saveRoles } from './roles.js';

import { FakeHerdrOps } from './fake-ops.js';

const OPTS: EngineOptions = {
  workspaceLabelPrefix: 'paneflow-',
  promptConfirmWindowMs: 0,
  reconcileIntervalMs: 60_000, // effectively off in tests
  defaultNodeTimeoutMs: 1_200,
  agentStartTimeoutMs: 5_000,
  agentReadyTimeoutMs: 5_000,
  // AE：探针注入固定值，测试不依赖本机装了什么
  recommendAgentKind: async () => 'reco',
};

function serialGraph(): DagGraph {
  return {
    version: 1,
    name: 'serial-test',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      {
        id: 'impl',
        type: 'agent',
        label: '实现',
        config: { agentKind: 'fake', prompt: '实现功能。参考 {{design.artifact.summary}}' },
      },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'impl' },
      { id: 'e2', source: 'impl', target: 'end' },
    ],
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };
}

function twoNodeGraph(): DagGraph {
  return {
    version: 1,
    name: 'chain-test',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      {
        id: 'design',
        type: 'agent',
        label: '设计',
        config: {
          agentKind: 'fake',
          prompt: '设计',
          // agents write their artifact via the engine's file convention in real
          // life; here extraction falls back to output tail
        },
      },
      {
        id: 'impl',
        type: 'agent',
        label: '实现',
        config: { agentKind: 'fake', prompt: '根据 {{design.artifact.summary}} 实现' },
      },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'design' },
      { id: 'e2', source: 'design', target: 'impl' },
      { id: 'e3', source: 'impl', target: 'end' },
    ],
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };
}

function fanoutGraph(): DagGraph {
  const agent = (id: string, label: string): DagGraph['nodes'][number] => ({
    id,
    type: 'agent' as const,
    label,
    config: { agentKind: 'fake', prompt: `${label} 的任务` },
  });
  return {
    version: 1,
    name: 'fanout-test',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      { id: 'split', type: 'fanout', label: '并行', config: {} },
      agent('fa', '分支A'),
      agent('fb', '分支B'),
      agent('fc', '分支C'),
      { id: 'merge', type: 'fanin', label: '汇总', config: {} },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'split' },
      { id: 'e2', source: 'split', target: 'fa' },
      { id: 'e3', source: 'split', target: 'fb' },
      { id: 'e4', source: 'split', target: 'fc' },
      { id: 'e5', source: 'fa', target: 'merge' },
      { id: 'e6', source: 'fb', target: 'merge' },
      { id: 'e7', source: 'fc', target: 'merge' },
      { id: 'e8', source: 'merge', target: 'end' },
    ],
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };
}

function graph(name: string, _description: string, nodes: DagGraph['nodes'], edges: DagGraph['edges']): DagGraph {
  return { version: 1, name, nodes, edges, metadata: { createdAt: '', updatedAt: '' } };
}

let ops: FakeHerdrOps;
let store: Store;
let dataDir: string;
let engine: Engine;

beforeEach(() => {
  ops = new FakeHerdrOps();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-engine-'));
  store = new Store(dataDir);
  engine = new Engine(ops, store, OPTS);
});

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

async function runToCompletion(graph: DagGraph, cwd: string) {
  const run = await engine.startRun(graph, cwd);
  await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
  return engine.getRun(run.runId)!;
}

describe('Engine (serial DAG)', () => {
  it('runs a serial pipeline and cleans up the workspace', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    if (run.state !== 'completed') console.log('DEBUG impl err:', run.nodes['impl']!.error);
    expect(run.state).toBe('completed');
    expect(run.nodes['impl']!.state).toBe('done');
    expect(run.nodes['start']!.state).toBe('done');
    // workspace reclaimed
    expect(ops.closedWorkspaces).toHaveLength(1);
    expect(ops.workspaces.size).toBe(0);
    // exactly one prompt submitted
    expect(ops.prompts).toHaveLength(1);
  });

  it('passes upstream artifacts into downstream prompts via the blackboard', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    // design writes a result file (artifact convention) before settling
    const designDir = cwd;
    ops.onPrompt = (target) => {
      if (target.startsWith('pf-') && ops.prompts.length === 1) {
        fs.mkdirSync(path.join(designDir, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(
          path.join(designDir, '.herdr/artifacts/design.json'),
          JSON.stringify({ summary: '采用模块化设计' }),
        );
      }
    };
    const run = await runToCompletion(twoNodeGraph(), cwd);
    expect(run.state).toBe('completed');
    // downstream prompt got the upstream summary interpolated
    const implPrompt = ops.prompts.find((p) => p.text.includes('实现'));
    expect(implPrompt?.text).toContain('采用模块化设计');
    // upstream artifact came from the result file
    expect(run.nodes['design']!.artifact?.source).toBe('file');
    expect(run.nodes['design']!.artifact?.summary).toBe('采用模块化设计');
  });

  it('falls back to terminal output tail when no result file exists', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    const artifact = run.nodes['impl']!.artifact;
    expect(artifact?.source).toBe('output-fallback');
    expect(artifact?.outputTail).toContain('FAKE OUTPUT TAIL');
  });

  it('routes blocked agents through human approval and resumes on approve', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'blocked'), 10);
    };
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));

    const approved = await engine.approve(run.runId, 'impl', { action: 'approve' });
    expect(approved).toBe(true);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    // approve sent the default key
    expect(ops.sentKeys).toEqual([{ target: ops.agents.keys().next().value!, keys: ['enter'] }]);
  });

  it('marks the node failed when the human rejects the approval', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'blocked'), 10);
    };
    const run = await engine.startRun(serialGraph(), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('failed');
    expect(final.nodes['impl']!.state).toBe('failed');
  });

  it('retries a failing node up to retryCount then completes via onFail=continue', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.retryCount = 1;
    graph.nodes[1]!.config.onFail = 'continue';
    ops.onPrompt = (target) => {
      // agent errors out: working → unknown (unclearable) → treated as failure
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'unknown'), 10);
    };
    const run = await runToCompletion(graph, cwd);
    // two attempts made
    expect(run.nodes['impl']!.attempts).toBe(2);
    // v11-D3 语义修正：onFail=continue 带失败收口不再假装全绿——如实 completed-with-failures
    expect(run.state).toBe('completed-with-failures');
  });

  it('aborts remaining nodes when onFail=abort and the node fails', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = twoNodeGraph();
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'unknown'), 10);
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['design']!.state).toBe('failed');
    expect(run.nodes['impl']!.state).toBe('skipped');
  });

  it('stopRun cancels a running pipeline and reclaims the workspace', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = (target) => {
      // never settles: keep working until cancelled
      ops.setStatus(target, 'working');
    };
    const run = await engine.startRun(serialGraph(), cwd);
    await waitFor(() => run.nodes['impl']!.state === 'working');
    expect(engine.stopRun(run.runId)).toBe(true);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('cancelled');
    expect(ops.workspaces.size).toBe(0);
  });

  it('rejects invalid DAGs before touching Herdr', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const bad = serialGraph();
    bad.edges.push({ id: 'e9', source: 'impl', target: 'start' }); // cycle
    await expect(engine.startRun(bad, cwd)).rejects.toThrow(/DAG 校验失败/);
    expect(ops.workspaces.size).toBe(0);
  });

  it('rejects fanin nodes that carry onFail config', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const g = serialGraph();
    g.nodes.splice(1, 0, { id: 'fi', type: 'fanin', label: '汇总', config: { onFail: 'continue' } });
    g.edges.push({ id: 'e8', source: 'start', target: 'fi' });
    await expect(engine.startRun(g, cwd)).rejects.toThrow(/requireAll/);
  });

  it('runs fan-out branches truly in parallel and merges at fan-in', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = fanoutGraph();
    ops.promptDelayMs = 150; // observable overlap window
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    // all three branches actually ran concurrently
    expect(ops.maxConcurrent).toBe(3);
    expect(run.nodes['fa']!.state).toBe('done');
    expect(run.nodes['fb']!.state).toBe('done');
    expect(run.nodes['fc']!.state).toBe('done');
    expect(run.nodes['merge']!.state).toBe('done');
    expect(run.nodes['end']!.state).toBe('done');
  });

  it('respects the global pane concurrency cap', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = fanoutGraph();
    ops.promptDelayMs = 150;
    engine = new Engine(ops, store, { ...OPTS, maxConcurrentPanes: 2 });
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    expect(ops.maxConcurrent).toBe(2);
    // 被并发上限挡下的第三分支必须在槽位释放后补跑，不能凭空消失
    for (const id of ['fa', 'fb', 'fc', 'merge', 'end']) expect(run.nodes[id]!.state).toBe('done');
  });

  it('首驾-调度洞：ready 节点被并发上限挤出 pending 后仍会补跑，run 不带未跑节点「完成」', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = fanoutGraph();
    ops.promptDelayMs = 150;
    engine = new Engine(ops, store, { ...OPTS, maxConcurrentPanes: 1 });
    const run = await runToCompletion(graph, cwd);
    expect(ops.maxConcurrent).toBe(1); // 串行执行，未越窗
    for (const id of ['fa', 'fb', 'fc', 'merge', 'end']) expect(run.nodes[id]!.state).toBe('done');
    expect(run.state).toBe('completed');
  });

  it('strict fan-in fails the merge when a branch fails', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = fanoutGraph();
    graph.nodes.find((n) => n.id === 'fb')!.config.onFail = 'continue';
    ops.onPrompt = (target) => {
      if (target.includes('-fb-')) {
        ops.setStatus(target, 'working');
        setTimeout(() => ops.setStatus(target, 'unknown'), 10); // unresolvable → fail
      }
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['fb']!.state).toBe('failed');
    expect(run.nodes['merge']!.state).toBe('failed');
    expect(run.nodes['end']!.state).toBe('skipped');
    // healthy branch still completed its own work
    expect(run.nodes['fa']!.state).toBe('done');
  });

  it('lenient fan-in (requireAll=false) completes with a failed branch', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = fanoutGraph();
    graph.nodes.find((n) => n.id === 'fb')!.config.onFail = 'continue';
    graph.nodes.find((n) => n.id === 'merge')!.config.requireAll = false;
    ops.onPrompt = (target) => {
      if (target.includes('-fb-')) {
        ops.setStatus(target, 'working');
        setTimeout(() => ops.setStatus(target, 'unknown'), 10);
      }
    };
    const run = await runToCompletion(graph, cwd);
    // v11-D3 语义修正：宽松 fan-in 收口时有 failed 分支 → completed-with-failures（不再洗绿）
    expect(run.state).toBe('completed-with-failures');
    expect(run.nodes['fb']!.state).toBe('failed');
    expect(run.nodes['merge']!.state).toBe('done');
    expect(run.nodes['end']!.state).toBe('done');
  });

  it('skips downstream nodes of a failed branch while others continue', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = fanoutGraph();
    graph.nodes.push({ id: 'chain-a', type: 'agent', label: 'A下游', config: { agentKind: 'fake', prompt: '下游' } });
    graph.edges.push({ id: 'e20', source: 'fa', target: 'chain-a' });
    graph.edges.push({ id: 'e21', source: 'chain-a', target: 'merge' });
    graph.nodes.find((n) => n.id === 'fa')!.config.onFail = 'continue';
    ops.onPrompt = (target) => {
      if (target.includes('-fa-')) {
        ops.setStatus(target, 'working');
        setTimeout(() => ops.setStatus(target, 'unknown'), 10);
      }
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.nodes['chain-a']!.state).toBe('skipped');
    expect(run.nodes['fb']!.state).toBe('done');
  });

  it('appends the artifact convention to prompts that lack it', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.state).toBe('completed');
    expect(ops.prompts[0]!.text).toContain('.herdr/artifacts/impl.json');
    expect(ops.prompts[0]!.text).toContain('summary');
  });

  it('global pane pool caps across concurrent runs', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    engine = new Engine(ops, store, { ...OPTS, maxConcurrentPanes: 2 });
    ops.promptDelayMs = 150;
    const g = fanoutGraph();
    // two overlapping runs of the same 3-branch graph; per-run cap would allow 4 concurrent
    const r1 = await engine.startRun(g, cwd);
    const r2 = await engine.startRun(graph('fanout-test', 'second', g.nodes, g.edges), cwd);
    await waitFor(() =>
      engine.getRun(r1.runId)!.state !== 'running' && engine.getRun(r2.runId)!.state !== 'running',
    );
    expect(engine.getRun(r1.runId)!.state).toBe('completed');
    expect(engine.getRun(r2.runId)!.state).toBe('completed');
    expect(ops.maxConcurrent).toBe(2);
  });

  it('checks gate: file-exists and command pass on success, fail on violation', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [
      { type: 'file-exists', path: 'ok.txt' },
      { type: 'command', run: 'echo gate-ok | grep gate-ok' },
    ];
    // agent writes ok.txt as part of its "work"
    ops.onPrompt = () => fs.writeFileSync(path.join(cwd, 'ok.txt'), '1');
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    // now without the file → check fails → run failed
    fs.rmSync(path.join(cwd, 'ok.txt'));
    engine = new Engine(ops, store, OPTS);
    ops.onPrompt = () => {};
    const run2 = await runToCompletion(graph, cwd);
    expect(run2.state).toBe('failed');
    expect(run2.nodes['impl']!.error).toContain('文件不存在');
  });

  it('checks gate: regex match against a file', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [{ type: 'regex', file: 'report.md', pattern: 'PASS' }];
    ops.onPrompt = () => fs.writeFileSync(path.join(cwd, 'report.md'), 'result: PASS');
    const ok = await runToCompletion(graph, cwd);
    expect(ok.state).toBe('completed');
    fs.writeFileSync(path.join(cwd, 'report.md'), 'result: FAIL');
    engine = new Engine(ops, store, OPTS);
    ops.onPrompt = () => {}; // second run leaves the FAIL file in place
    const bad = await runToCompletion(graph, cwd);
    expect(bad.state).toBe('failed');
    expect(bad.nodes['impl']!.error).toContain('不匹配');
  });

  it('checks gate: manual check routes through the approval flow', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [{ type: 'manual', prompt: '冒烟通过？' }];
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    // reject → node fails
    await engine.approve(run.runId, 'impl', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(engine.getRun(run.runId)!.state).toBe('failed');
    expect(engine.getRun(run.runId)!.nodes['impl']!.error).toContain('人工检查未通过');
    // second run: approve → completes
    engine = new Engine(ops, store, OPTS);
    const run2 = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run2.runId, 'impl'));
    await engine.approve(run2.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run2.runId)!.state !== 'running');
    expect(engine.getRun(run2.runId)!.state).toBe('completed');
    expect(engine.getRun(run2.runId)!.nodes['impl']!.blockedPrompt).toBeUndefined();
  });

  it('conditional edges: unmatched condition prunes downstream without skip contagion', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = twoNodeGraph();
    // design writes aligned:false → impl edge pruned → impl skipped; end reachable? end's pred is impl (skipped) → skipped too
    graph.nodes[1]!.config.checks = [];
    ops.onPrompt = (target) => {
      if (target.startsWith('pf-') && ops.prompts.length === 1) {
        fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.herdr/artifacts/design.json'), JSON.stringify({ aligned: 'false' }));
      }
    };
    graph.edges.find((e) => e.source === 'design' && e.target === 'impl')!.condition = { field: 'aligned', equals: 'true' };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    expect(run.nodes['design']!.state).toBe('done');
    expect(run.nodes['impl']!.state).toBe('skipped');
    expect(run.nodes['impl']!.error).toContain('条件');
  });

  it('conditional edges: matched condition runs normally', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = twoNodeGraph();
    ops.onPrompt = (target) => {
      if (target.startsWith('pf-') && ops.prompts.length === 1) {
        fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.herdr/artifacts/design.json'), JSON.stringify({ aligned: 'true' }));
      }
    };
    graph.edges.find((e) => e.source === 'design' && e.target === 'impl')!.condition = { field: 'aligned', equals: 'true' };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    expect(run.nodes['impl']!.state).toBe('done');
  });

  it('clarify loop: unaligned artifact triggers Q&A, answer resolves it', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.clarify = { maxRounds: 3 };
    let round = 0;
    ops.onPrompt = (target, text) => {
      round += 1;
      fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
      if (round === 1) {
        // first turn: not aligned, asks questions
        fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify({ aligned: 'false', extra: { questions: ['验收标准是什么？'] } }));
        void text;
      } else {
        // answered turn: aligned
        fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify({ aligned: 'true', summary: `已按回答处理（第${round}轮）` }));
      }
    };
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    expect(run.nodes['impl']!.blockedPrompt).toContain('验收标准');
    // answer as input → agent reruns → aligned=true → completes
    await engine.approve(run.runId, 'impl', { action: 'input', text: '验收标准：修复后测试全绿' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect(ops.prompts.length).toBe(2); // original + answer turn
  });

  it('clarify loop: rounds exhaustion fails the node', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.clarify = { maxRounds: 1 };
    ops.onPrompt = () => {
      fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify({ aligned: 'false' }));
    };
    const run = await engine.startRun(graph, cwd);
    // round 1 blocked → approve as input (still unaligned) → exhausted
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'input', text: '再想想' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('failed');
    expect(final.nodes['impl']!.error).toContain('澄清循环');
  });

  it('dynamic fanout expands clones from upstream artifact array', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    // planner agent produces tasks array; then a fanout with expand clones dev per task
    const graph: DagGraph = {
      version: 1,
      name: 'expand-test',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        {
          id: 'plan',
          type: 'agent',
          label: '拆分',
          config: { agentKind: 'fake', prompt: '拆分任务' },
        },
        { id: 'fork', type: 'fanout', label: '动态展开', config: { expand: { from: 'plan', field: 'tasks' } } },
        {
          id: 'dev',
          type: 'agent',
          label: '开发 {{item.name}}',
          config: { agentKind: 'fake', prompt: '实现 {{item.name}}（{{item.brief}}），cwd 约定 {{item.repo}}' },
        },
        { id: 'merge', type: 'fanin', label: '汇总', config: {} },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'plan' },
        { id: 'e2', source: 'plan', target: 'fork' },
        { id: 'e3', source: 'fork', target: 'dev' },
        { id: 'e4', source: 'dev', target: 'merge' },
        { id: 'e5', source: 'merge', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    ops.onPrompt = (target, text) => {
      if (target.includes('plan')) {
        fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(
          path.join(cwd, '.herdr/artifacts/plan.json'),
          JSON.stringify({
            tasks: [
              { name: '接口改造', repo: 'service-order', brief: '订单接口' },
              { name: '页面改版', repo: 'web-portal', brief: '下单页' },
            ],
          }),
        );
      }
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    // two clones ran, original dev skipped as template
    expect(run.nodes['dev__1']!.state).toBe('done');
    expect(run.nodes['dev__2']!.state).toBe('done');
    expect(run.nodes['dev']!.state).toBe('skipped');
    // {{item.*}} injected into prompts
    const dev1 = ops.prompts.find((p) => p.target.includes('dev__1'))!;
    expect(dev1.text).toContain('接口改造');
    expect(dev1.text).toContain('service-order');
    // fanin waited for both clones
    expect(run.nodes['merge']!.state).toBe('done');
    expect(run.nodes['end']!.state).toBe('done');
  });

  it('动态扇出把分支模板上的条件边**原样**带给每个克隆（换 source 不换判据）', async () => {
    // 旧写法用三个字段重建克隆出边，判据在这一刻被洗成恒通过：画布上写着「只有 decision=go
    // 才往下走」，跑起来却什么都往下走——双口径。这里用「全停」这一侧做判别：判据若还活着，
    // 下游一条入边都不成立→skipped 且一次 prompt 不发；判据被洗掉则它照跑。
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-cond-'));
    const graph: DagGraph = {
      version: 1,
      name: 'expand-cond',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'plan', type: 'agent', label: '拆分', config: { agentKind: 'fake', prompt: '拆' } },
        { id: 'fork', type: 'fanout', label: '动态展开', config: { expand: { from: 'plan', field: 'tasks' } } },
        { id: 'dev', type: 'agent', label: '开发 {{item.name}}', config: { agentKind: 'fake', prompt: '做 {{item.name}}' } },
        { id: 'judge', type: 'agent', label: '放行', config: { agentKind: 'fake', prompt: '收' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'plan' },
        { id: 'e2', source: 'plan', target: 'fork' },
        { id: 'e3', source: 'fork', target: 'dev' },
        { id: 'e4', source: 'dev', target: 'judge', condition: { field: 'extra.decision', equals: 'go' } },
        { id: 'e5', source: 'judge', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    ops.onPrompt = (target) => {
      const dir = path.join(cwd, '.herdr/artifacts');
      if (target.includes('plan')) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'plan.json'),
          JSON.stringify({ tasks: [{ name: 'a' }, { name: 'b' }] }),
        );
        return;
      }
      const clone = target.match(/dev__(\d)/)?.[1];
      if (clone) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `dev__${clone}.json`), JSON.stringify({ extra: { decision: 'stop' } }));
      }
    };
    const run = await runToCompletion(graph, cwd);

    // 结构：克隆出边的 source 换成了克隆 id（挂在模板节点上=整条分支永不落定），判据仍在
    const out = run.graph.edges.filter((e) => e.source === 'dev__1');
    expect(out).toHaveLength(1);
    expect(out[0]!.target).toBe('judge');
    expect(out[0]!.condition).toEqual({ field: 'extra.decision', equals: 'go' });
    // 行为：两条入边都不成立 → judge 一条 prompt 都没收到，按「入边条件均未满足」跳过
    expect(ops.prompts.filter((p) => p.target.includes('judge'))).toHaveLength(0);
    expect(run.nodes['judge']!.state).toBe('skipped');
  });

  it('v13-V0 动态扇出有顶：项数超 expand.maxItems → 节点失败并指路，绝不静默截断分支（少交付还报完成）也不无界放大并发', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph: DagGraph = {
      version: 1,
      name: 'expand-over-cap',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'plan', type: 'agent', label: '拆分', config: { agentKind: 'fake', prompt: '拆' } },
        { id: 'fork', type: 'fanout', label: '动态展开', config: { expand: { from: 'plan', field: 'tasks', maxItems: 2 } } },
        { id: 'dev', type: 'agent', label: '开发 {{item.name}}', config: { agentKind: 'fake', prompt: '做 {{item.name}}' } },
        { id: 'merge', type: 'fanin', label: '汇总', config: {} },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'plan' },
        { id: 'e2', source: 'plan', target: 'fork' },
        { id: 'e3', source: 'fork', target: 'dev' },
        { id: 'e4', source: 'dev', target: 'merge' },
        { id: 'e5', source: 'merge', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    ops.onPrompt = (target) => {
      if (target.includes('plan')) {
        fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(
          path.join(cwd, '.herdr/artifacts/plan.json'),
          JSON.stringify({ tasks: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }),
        );
      }
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['fork']!.state).toBe('failed');
    expect(run.nodes['fork']!.error).toContain('动态扇出超限');
    expect(run.nodes['fork']!.error).toContain('3 项');
    expect(run.nodes['fork']!.error).toContain('上限 2');
    // 一个分支都没被克隆出来（既非截断跑掉两项，也非无界跑掉三项）
    expect(run.nodes['dev__1']).toBeUndefined();
    expect(ops.prompts.filter((p) => p.target.includes('dev'))).toHaveLength(0);
  });

  it('v13-V0 起单面 fail-closed 可达：未知 node.type 的图在 startRun 就被拒（校验器不是只给画布看的装饰）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const g = serialGraph();
    (g.nodes[1] as { type: string }).type = 'agenta'; // 打错字的 agent
    await expect(engine.startRun(g, cwd)).rejects.toThrow(/未知节点类型：agenta/);
  });

  it('dynamic fanout fails when upstream yields no array', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph: DagGraph = {
      version: 1,
      name: 'expand-fail',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'plan', type: 'agent', label: '拆分', config: { agentKind: 'fake', prompt: '拆' } },
        { id: 'fork', type: 'fanout', label: '动态展开', config: { expand: { from: 'plan', field: 'tasks', onEmpty: 'fail' } } },
        { id: 'dev', type: 'agent', label: '开发', config: { agentKind: 'fake', prompt: 'x' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'plan' },
        { id: 'e2', source: 'plan', target: 'fork' },
        { id: 'e3', source: 'fork', target: 'dev' },
        { id: 'e4', source: 'dev', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['fork']!.error).toContain('动态扇出');
  });

  it('terminal snapshots are captured per node and survive run completion', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    const rec = run.nodes['impl']!;
    expect(rec.state).toBe('done');
    // final snapshot captured before workspace cleanup
    expect(rec.outputSnapshots?.length).toBeGreaterThanOrEqual(1);
    expect(rec.outputSnapshots![rec.outputSnapshots!.length - 1]!.text).toContain('FAKE OUTPUT TAIL');
  });

  it('pipeline node routes to the suggested child template and waits', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    // child delivery template in the same space
    store.saveGraph({
      version: 1,
      name: 'delivery-child',
      // 被路由的模板必须声明它消费的参数（变量即契约）
      variables: [{ key: 'issue_id', label: '主 Issue', required: true }],
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'worker', type: 'agent', label: '交付', config: { agentKind: 'fake', prompt: '交付 {{issue_id}}' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'c1', source: 'start', target: 'worker' },
        { id: 'c2', source: 'worker', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    });
    // triage graph: writes suggestedTemplate + issue_id → pipeline routes
    const graph: DagGraph = {
      version: 1,
      name: 'triage-test',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'triage', type: 'agent', label: '受理', config: { agentKind: 'fake', prompt: '受理' } },
        { id: 'route', type: 'pipeline', label: '路由', config: { pipeline: {
          template: '{{triage.artifact.extra.suggestedTemplate}}',
          fallbackTemplate: 'fallback-tpl',
          params: { issue_id: '{{triage.artifact.extra.issue_id}}' },
          mode: 'wait',
        } } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'triage' },
        { id: 'e2', source: 'triage', target: 'route' },
        { id: 'e3', source: 'route', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    ops.onPrompt = (target, text) => {
      if (target.includes('triage')) {
        fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.herdr/artifacts/triage.json'), JSON.stringify({ extra: { suggestedTemplate: 'delivery-child', issue_id: '162' } }));
      }
      if (target.includes('worker')) expect(text).toContain('162');
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    expect(run.nodes['route']!.state).toBe('done');
    expect(run.nodes['route']!.error).toContain('delivery-child');
    // child template's worker got the interpolated issue id
    expect(ops.prompts.some((p) => p.text.includes('交付 162'))).toBe(true);
  });

  it('pipeline node falls back when suggested template is missing', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    store.saveGraph({
      version: 1,
      name: 'fallback-tpl',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'worker', type: 'agent', label: '兜底交付', config: { agentKind: 'fake', prompt: '兜底处理' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'c1', source: 'start', target: 'worker' },
        { id: 'c2', source: 'worker', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    });
    const graph: DagGraph = {
      version: 1,
      name: 'triage-fallback',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'triage', type: 'agent', label: '受理', config: { agentKind: 'fake', prompt: '受理' } },
        { id: 'route', type: 'pipeline', label: '路由', config: { pipeline: {
          template: '{{triage.artifact.extra.suggestedTemplate}}',
          fallbackTemplate: 'fallback-tpl',
          mode: 'wait',
        } } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'triage' },
        { id: 'e2', source: 'triage', target: 'route' },
        { id: 'e3', source: 'route', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    ops.onPrompt = (target) => {
      if (target.includes('triage')) {
        fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.herdr/artifacts/triage.json'), JSON.stringify({ extra: { suggestedTemplate: 'no-such-tpl' } }));
      }
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    expect(run.nodes['route']!.error).toContain('fallback-tpl');
  });

  it('dynamic fanout falls back to single branch when upstream yields no array', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph: DagGraph = {
      version: 1,
      name: 'expand-fallback',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'plan', type: 'agent', label: '拆分', config: { agentKind: 'fake', prompt: '拆' } },
        { id: 'fork', type: 'fanout', label: '动态展开', config: { expand: { from: 'plan', field: 'extra.tasks' } } },
        { id: 'dev', type: 'agent', label: '交付 {{item.name}}', config: { agentKind: 'fake', prompt: '交付 {{item.brief}}' } },
        { id: 'merge', type: 'fanin', label: '汇总', config: {} },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'plan' },
        { id: 'e2', source: 'plan', target: 'fork' },
        { id: 'e3', source: 'fork', target: 'dev' },
        { id: 'e4', source: 'dev', target: 'merge' },
        { id: 'e5', source: 'merge', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    // plan 不写 tasks 数组（弱模型现实），只写 summary
    ops.onPrompt = (target) => {
      if (target.includes('plan')) {
        fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.herdr/artifacts/plan.json'), JSON.stringify({ summary: '结论：按顺序完成全部工作' }));
      }
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    // 回退单分支：dev__1 执行，brief 注入上游 summary
    expect(run.nodes['dev__1']!.state).toBe('done');
    const devPrompt = ops.prompts.find((p) => p.target.includes('dev__1'))!;
    expect(devPrompt.text).toContain('结论：按顺序完成全部工作');
  });

  it('R3.4 same-issue idempotency: duplicate dispatch is rejected while running', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const g = serialGraph();
    ops.onPrompt = () => { /* 永不 settle：保持 working */ };
    const r1 = await engine.startRun(g, cwd, 'default', {}, '162');
    await expect(engine.startRun(g, cwd, 'default', {}, '162')).rejects.toThrow(/162/);
    // 不同 issue 不受限
    const r2 = await engine.startRun(g, cwd, 'default', {}, '163');
    expect(r2.issueId).toBe('163');
    engine.stopRun(r1.runId);
    engine.stopRun(r2.runId);
  });

  it('R3.3 dirty check rejects start when the repo has uncommitted changes', async () => {
    // 真实 git 仓库 + 未提交变更
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dirty-'));
    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t'], );
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'wip.txt'), '未提交的工作');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);
    fs.writeFileSync(path.join(repo, 'wip.txt'), '脏改动');
    const graph = serialGraph();
    graph.nodes[1]!.config.cwd = repo;
    await expect(engine.startRun(graph, repo, 'default', {}, '9')).rejects.toThrow(/未提交改动/);
    // 提交后可启动
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'wip']);
    const run = await engine.startRun(graph, repo, 'default', {}, '9');
    engine.stopRun(run.runId);
  });

  it('R3.1 same-run siblings on the same repo get isolated worktrees', async () => {
    // 真实 git 仓库：两个 agent 节点同仓并发 → 后到者自动 worktree 隔离
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wt-'));
    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);

    const graph: DagGraph = {
      version: 1,
      name: 'wt-test',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'fork', type: 'fanout', label: '展开', config: {} },
        { id: 'a', type: 'agent', label: '任务A', config: { agentKind: 'fake', prompt: 'A', cwd: repo } },
        { id: 'b', type: 'agent', label: '任务B', config: { agentKind: 'fake', prompt: 'B', cwd: repo } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fork' },
        { id: 'e2', source: 'fork', target: 'a' },
        { id: 'e3', source: 'fork', target: 'b' },
        { id: 'e4', source: 'a', target: 'end' },
        { id: 'e5', source: 'b', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    const run = await engine.startRun(graph, repo);
    // 运行中：后到者获得 worktree（目录存在、独立分支）
    await waitFor(() => (engine.getRun(run.runId)!.nodes['b']!.worktree ?? '') !== '');
    const wtPath = engine.getRun(run.runId)!.nodes['b']!.worktree!;
    // v13-B3：生产默认根 = <dataDir>/worktrees（证据链不再落 OS 扫荡区）
    expect(wtPath.startsWith(path.join(dataDir, 'worktrees') + path.sep)).toBe(true);
    // 运行结束：完成 + worktree 回收——v13-B3 起分支半笔也结清：目录删、已合并的引擎自建分支
    // 被 git branch -d 删掉、账进 events（fake 环境毫秒级完成，中途存在性断言有竞态）
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect(final.nodes['b']!.worktree).toBe(wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'paneflow/*']).toString();
    expect(branches).not.toContain('paneflow/');
    const reclaimEvents = (final.events ?? []).filter((e) => e.text.includes('worktree 回收'));
    expect(reclaimEvents).toHaveLength(1);
    expect(reclaimEvents[0]!.nodeId).toBe('b');
    expect(reclaimEvents[0]!.text).toContain('已删除');
    expect(reclaimEvents[0]!.text).toContain(`paneflow/${run.runId}-b`);
  });

  // 还账 #108：同仓并发的 worktree 隔离此前只走通到 pane 侧（splitPane 吃 nodeCwd）；
  // prompt 侧曾把同一个 nodeCwd 用另一枚 `const` 遮蔽回非隔离路径——结果 b 的 agent 在
  // 隔离目录里起、却被要求把 artifact.json 写到主检出下，回收时目录干净、账上却查无产物。
  it('R3.1 补账 · 同仓并发：worktree 隔离目录一路跟到 prompt 侧（artifact 交接绝对路径写向 wtPath 而非主仓）', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wt-prompt-'));
    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);

    const graph: DagGraph = {
      version: 1,
      name: 'wt-prompt-side',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'fork', type: 'fanout', label: '展开', config: {} },
        { id: 'a', type: 'agent', label: '任务A', config: { agentKind: 'fake', prompt: 'PROMPT-A', cwd: repo } },
        { id: 'b', type: 'agent', label: '任务B', config: { agentKind: 'fake', prompt: 'PROMPT-B', cwd: repo } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fork' },
        { id: 'e2', source: 'fork', target: 'a' },
        { id: 'e3', source: 'fork', target: 'b' },
        { id: 'e4', source: 'a', target: 'end' },
        { id: 'e5', source: 'b', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    const run = await engine.startRun(graph, repo);
    await waitFor(() => (engine.getRun(run.runId)!.nodes['b']!.worktree ?? '') !== '');
    const wtPath = engine.getRun(run.runId)!.nodes['b']!.worktree!;
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');

    const promptForB = ops.prompts.find((p) => p.text.includes('PROMPT-B'));
    const promptForA = ops.prompts.find((p) => p.text.includes('PROMPT-A'));
    expect(promptForB, 'b 的 prompt 应被发出').toBeTruthy();
    expect(promptForA, 'a 的 prompt 应被发出').toBeTruthy();
    // 交接约定行的绝对路径必须跟着走：b 落 wtPath、a 落主检出——两枚路径互斥才是「跟到了」
    expect(promptForB!.text).toContain(wtPath);
    expect(promptForB!.text).not.toContain(repo);
    expect(promptForA!.text).toContain(repo);
    expect(promptForA!.text).not.toContain(wtPath);
  });

  it('首驾-3 跨 run 软锁随节点尝试结束释放：run1 审批放行后，同仓排队等待的 run2 得以跑完（旧实现 claim 只写不还 → 等锁必至超时）', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-lock-'));
    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);

    const g1 = serialGraph();
    g1.name = 'lock-holder';
    g1.nodes[1]!.config.checks = [{ type: 'manual', prompt: '确认放行' }];
    // fake 节点会把结果文件写进仓库 → 同仓第二 run 会被脏检查挡（非本测试主题），借正式开关放行
    process.env.PF_DIRTY_CHECK = '0';
    try {
      const r1 = await engine.startRun(g1, repo);
      await waitFor(() => engine.getRun(r1.runId)!.nodes['impl']!.state === 'blocked');
      const g2 = serialGraph();
      g2.name = 'lock-waiter';
      const r2 = await engine.startRun(g2, repo);
      await waitFor(() => (engine.getRun(r2.runId)!.nodes['impl']!.error ?? '').includes('等待仓库锁'));
      await engine.approve(r1.runId, 'impl', { action: 'approve' });
      await waitFor(() => engine.getRun(r1.runId)!.state === 'completed');
      await waitFor(() => engine.getRun(r2.runId)!.state === 'completed');
    } finally {
      delete process.env.PF_DIRTY_CHECK;
    }
  });

  it('v13-S3 出闸判据=「锁是否还在」而非「锁是否还归旧 holder」：三家同仓串行，一家放行后只有一家门前让路，排队文案随锁转手刷新、拿到锁即清陈旧 error（旧判据下双等待者同刻出闸互相踩 set，fake 并发探针当场抓到重叠）', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-lock3-'));
    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);

    // 三家各一个 manual 门：run1 卡门持锁 → r2/r3 排队 → 放行 run1 后仅一家出闸（随即卡在自己的门上继续持锁），
    // 另一家必须改排在「新」holder 面前。旧判据拿已死的 run1 比对 → 两家同时出闸 = 同仓并发写。
    const gated = (name: string): DagGraph => {
      const g = serialGraph();
      g.name = name;
      g.nodes[1]!.config.checks = [{ type: 'manual', prompt: '放行' }];
      return g;
    };
    const errOf = (runId: string) => engine.getRun(runId)!.nodes['impl']!.error ?? '';
    const implState = (runId: string) => engine.getRun(runId)!.nodes['impl']!.state;

    process.env.PF_DIRTY_CHECK = '0';
    try {
      const r1 = await engine.startRun(gated('lock-holder'), repo);
      await waitFor(() => implState(r1.runId) === 'blocked');
      const r2 = await engine.startRun(gated('lock-waiter-b'), repo);
      const r3 = await engine.startRun(gated('lock-waiter-c'), repo);
      await waitFor(() => errOf(r2.runId).includes(r1.runId) && errOf(r3.runId).includes(r1.runId));
      ops.maxConcurrent = 0; // 探针只看过闸之后的两段执行是否重叠
      await engine.approve(r1.runId, 'impl', { action: 'approve' });
      await waitFor(() => engine.getRun(r1.runId)!.state === 'completed');
      // 只有一家出闸（随即卡在自己的门上、继续持锁），另一家把排队文案改指向这个新 holder
      await waitFor(() => errOf(r2.runId).includes(r3.runId) || errOf(r3.runId).includes(r2.runId), 12_000);
      const [winner, loser] = errOf(r2.runId).includes(r3.runId) ? [r3.runId, r2.runId] : [r2.runId, r3.runId];
      expect(implState(winner)).toBe('blocked');
      expect(errOf(winner)).toBe(''); // 拿到锁：排队文案不留陈缺（旧实现一路挂到节点结束）
      await engine.approve(winner, 'impl', { action: 'approve' });
      // 落闸者接手后同样要过自己的门——此刻它已出闸，陈旧排队文案必须清干净
      await waitFor(() => implState(loser) === 'blocked', 20_000);
      expect(errOf(loser)).toBe('');
      await engine.approve(loser, 'impl', { action: 'approve' });
      await waitFor(() => engine.getRun(loser)!.state === 'completed', 20_000);
      await waitFor(() => engine.getRun(winner)!.state === 'completed', 20_000);
      expect(ops.maxConcurrent).toBe(1); // fake 并发探针：整段从未两个节点同刻在跑
      expect(ops.prompts).toHaveLength(3); // 三家各一次提示 = 严格串行，无一被踩掉重跑
    } finally {
      delete process.env.PF_DIRTY_CHECK;
    }
  }, 45_000);

  it('R6.5 resume: done nodes inherited, failed node re-executes only', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = twoNodeGraph();
    // 首轮：design 成功、impl 失败（unknown 不可恢复）→ run failed
    let callCount = 0;
    ops.onPrompt = (target) => {
      callCount += 1;
      if (target.includes('impl')) {
        ops.setStatus(target, 'working');
        setTimeout(() => ops.setStatus(target, 'unknown'), 10);
      }
    };
    const run1 = await runToCompletion(graph, cwd);
    expect(run1.state).toBe('failed');
    expect(run1.nodes['design']!.state).toBe('done');
    expect(run1.nodes['impl']!.state).toBe('failed');
    const promptsAfterRun1 = ops.prompts.length;

    // 续跑：design（done）被继承不再执行，仅 impl 重跑且成功
    ops.onPrompt = () => {};
    const run2 = await engine.startRun(graph, cwd, 'default', {}, undefined, run1.runId);
    await waitFor(() => engine.getRun(run2.runId)!.state !== 'running');
    const final = engine.getRun(run2.runId)!;
    expect(final.state).toBe('completed');
    // design 未重新执行（提示词总数只增加 impl 的一次）
    expect(ops.prompts.length).toBe(promptsAfterRun1 + 1);
    expect(final.nodes['design']!.state).toBe('done');
    expect(final.nodes['impl']!.state).toBe('done');
  });

  it('recoverOrphans reclaims workspaces from previous dead runs', async () => {
    await ops.createWorkspace('paneflow-deadbeef', '/tmp');
    await ops.createWorkspace('unrelated', '/tmp');
    const reclaimed = await engine.recoverOrphans();
    expect(reclaimed).toHaveLength(1);
    expect(ops.workspaces.has('w2')).toBe(true);
    expect(ops.workspaces.has('w1')).toBe(false);
  });
});

describe('A.4 prompt confirm window', () => {
  const confirm = (agent: string, ms: number) =>
    (engine as unknown as { confirmPromptLanded(a: string, m: number): Promise<void> }).confirmPromptLanded(agent, ms);

  it('状态立即 working 时即刻放行', async () => {
    await ops.startAgent('w1:p0', 'a1');
    ops.setStatus('a1', 'working');
    await expect(confirm('a1', 5_000)).resolves.toBeUndefined();
  });

  it('始终 idle：窗口末判 stalled，错误信息含配置时长', async () => {
    await ops.startAgent('w1:p0', 'a1'); // 默认 status=idle
    const t0 = Date.now();
    await expect(confirm('a1', 1_500)).rejects.toThrow(/agent_prompt_stalled.*1500ms/);
    expect(Date.now() - t0).toBeLessThan(6_000);
  });

  it('v18 诊断升级：终端尾部有错误特征时，stalled 错误带上那句真话（归因从谜语变可行动）', async () => {
    await ops.startAgent('w1:p0', 'a1'); // 默认 status=idle
    const orig = ops.readOutput.bind(ops);
    ops.readOutput = async () => 'Error: 500 Internal Server Error\nError: Retry failed after 3 attempts';
    try {
      await expect(confirm('a1', 1_500)).rejects.toThrow(
        /agent_prompt_stalled.*终端尾部检出错误特征：「Error: Retry failed after 3 attempts」/,
      );
    } finally {
      ops.readOutput = orig;
    }
  });

  it('v18 诊断升级：终端无错误特征时，stalled 指路「可能在等交互确认」', async () => {
    await ops.startAgent('w1:p0', 'a1');
    await expect(confirm('a1', 1_500)).rejects.toThrow(/终端尾部无错误特征，可能是 agent 在等交互确认/);
  });

  it('getAgentStatus 抛错按无变化处理：窗口末判 stalled 而非冒泡', async () => {
    await ops.startAgent('w1:p0', 'a1');
    const orig = ops.getAgentStatus.bind(ops);
    ops.getAgentStatus = async () => {
      throw new Error('probe boom');
    };
    try {
      await expect(confirm('a1', 1_500)).rejects.toThrow(/agent_prompt_stalled/);
    } finally {
      ops.getAgentStatus = orig;
    }
  });

  it('OPTS 默认 confirmMs=0：跳过确认窗，prompt 后 idle 也算落地（全量既有测试的公共路径）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-confirm0-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.state).toBe('completed');
  });

  it('整跑集成：onPrompt 翻 working 再回 idle，确认窗放行且 run 完成', async () => {
    const e2 = new Engine(ops, store, { ...OPTS, promptConfirmWindowMs: 1_500 });
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'idle'), 150);
    };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-confirm1-'));
    const run = await e2.startRun(serialGraph(), cwd);
    await waitFor(() => e2.getRun(run.runId)!.state !== 'running');
    expect(e2.getRun(run.runId)!.state).toBe('completed');
  });
});

/** R4 Gate 0 骨架的 fake-ops 端到端：仿 expand 用例 + 断言终审 + 报告收口 */
describe('S5 batch-data-governance skeleton (fake-ops e2e)', () => {
  it('prepare 切批 → impl__1/impl__2 治理 → verify 断言终审 → wrapup 报告', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-batch-'));
    const tmpl = BUILTIN_TEMPLATES.find((t) => t.name === 'builtin-batch-data-governance')!;
    const art = (name: string, obj: unknown) => {
      fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
      fs.writeFileSync(path.join(cwd, `.herdr/artifacts/${name}.json`), JSON.stringify(obj));
    };
    const batchFile = (name: string, items: string[]) => {
      fs.mkdirSync(path.join(cwd, 'output/_batches'), { recursive: true });
      fs.writeFileSync(path.join(cwd, `output/_batches/${name}.json`), JSON.stringify(items));
      fs.mkdirSync(path.join(cwd, `output/${name}`), { recursive: true });
      fs.writeFileSync(path.join(cwd, `output/${name}/result.jsonl`), items.join('\n'));
    };
    ops.onPrompt = (target) => {
      if (target.includes('prepare')) {
        batchFile('batch-01', ['a', 'b']);
        batchFile('batch-02', ['c']);
        art('prepare', {
          summary: '共 3 条切为 2 批',
          extra: {
            batches: [
              { name: 'batch-01', brief: 'batch-01：第 1-2 条，共 2 条，清单文件 output/_batches/batch-01.json' },
              { name: 'batch-02', brief: 'batch-02：第 3 条，共 1 条，清单文件 output/_batches/batch-02.json' },
            ],
          },
        });
      } else if (target.includes('impl__1')) {
        art('impl__1', { summary: 'batch-01 处理 2 条', extra: { batch: 'batch-01', processed: 2, anomalies: [], usage: { input: 100, output: 200 } } });
      } else if (target.includes('impl__2')) {
        art('impl__2', { summary: 'batch-02 处理 1 条', extra: { batch: 'batch-02', processed: 1, anomalies: [] } });
      } else if (target.includes('verify')) {
        art('verify', {
          summary: '终审 PASS：4/4 断言过',
          extra: {
            assertionResults: [
              { id: 'AC-1', status: 'ok', evidence: 'processed 合计 3 = 清单 3' },
              { id: 'AC-2', status: 'ok', evidence: 'anomalies 均为空数组' },
              { id: 'AC-3', status: 'ok', evidence: '2+1=3 无重无漏' },
              { id: 'AC-4', status: 'ok', evidence: 'output/batch-01|02 各 1 产物文件' },
            ],
          },
        });
      } else if (target.includes('wrapup')) {
        fs.writeFileSync(path.join(cwd, 'output/batch-report.md'), '# 批次报告\n4/4 断言通过\n');
        art('wrapup', { summary: '报告已产出' });
      }
    };
    const run = await engine.startRun(tmpl, cwd, 'default', {
      batch_source: 'source.jsonl',
      batch_prompt: '把每条记录规范化字段后写入输出文件',
    });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running', 20_000);
    const final = engine.getRun(run.runId)!;
    expect(final.state, `state=${final.state} err=${JSON.stringify(final.nodes)}`).toBe('completed');
    expect(final.nodes['impl__1']!.state).toBe('done');
    expect(final.nodes['impl__2']!.state).toBe('done');
    expect(final.nodes['impl']!.state).toBe('skipped');
    // 变量与 item 真实插值（不再见占位符字面量）
    const p1 = ops.prompts.find((p) => p.target.includes('impl__1'))!;
    expect(p1.text).toContain('output/batch-01/');
    expect(p1.text).toContain('规范化字段');
    expect(p1.text).not.toContain('{{item.name}}');
    const pv = ops.prompts.find((p) => p.target.includes('verify'))!;
    expect(pv.text).toContain('AC-1'); // acceptance_template 默认值已注入
    // R6a 成本账：usage 只聚合自报的（impl__1 有、impl__2 无），skipped 分支不入账
    expect(final.cost).toBeTruthy();
    expect(final.cost!.tokens).toEqual({ input: 100, output: 200 });
    expect(final.cost!.byNode['impl__1']!.attempts).toBe(1);
    expect(final.cost!.byNode['impl']).toBeUndefined();
    expect(final.cost!.totalMs).toBeGreaterThan(0);
  });

  it('verify 断言有 fail 时 F1 机器门拦截：blocked 等人工，两次拒绝后 run 失败', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-batch-fail-'));
    const tmpl = BUILTIN_TEMPLATES.find((t) => t.name === 'builtin-batch-data-governance')!;
    const art = (name: string, obj: unknown) => {
      fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
      fs.writeFileSync(path.join(cwd, `.herdr/artifacts/${name}.json`), JSON.stringify(obj));
    };
    ops.onPrompt = (target) => {
      if (target.includes('prepare')) {
        art('prepare', { summary: '2 条 1 批', extra: { batches: [{ name: 'batch-01', brief: 'batch-01：第 1-2 条' }] } });
      } else if (target.includes('impl__1')) {
        art('impl__1', { summary: '处理 1 条（漏 1）', extra: { batch: 'batch-01', processed: 1, anomalies: [{ entry: 'b', reason: '未处理', advice: '补跑' }] } });
      } else if (target.includes('verify')) {
        art('verify', { summary: '终审 FAIL', extra: { assertionResults: [{ id: 'AC-3', status: 'fail', evidence: 'processed=1 < 2' }] } });
      } else if (target.includes('wrapup')) {
        fs.mkdirSync(path.join(cwd, 'output'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'output/batch-report.md'), '# 失败报告\n');
        art('wrapup', { summary: 'done' });
      }
    };
    const run = await engine.startRun(tmpl, cwd, 'default', { batch_source: 's.jsonl', batch_prompt: '处理' });
    await waitFor(() => engine.isBlocked(run.runId, 'verify'), 30_000);
    expect(run.nodes['verify']!.blockedPrompt).toContain('AC-3');
    // 拒绝 → 节点失败重试 → 产物仍 fail → 机器门再次拦截；再拒 → 重试耗尽
    await engine.approve(run.runId, 'verify', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.nodes['verify']!.attempts >= 2, 30_000);
    await waitFor(() => engine.isBlocked(run.runId, 'verify'), 30_000);
    await engine.approve(run.runId, 'verify', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running', 30_000);
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('failed'); // onFail:abort 的终审把整个 run 判死
    expect(final.nodes['verify']!.state).toBe('failed');
    expect(final.nodes['verify']!.error).toContain('验收断言未通过');
    // R6a：verify 重试过（retries≥1），全程无 usage 自报 → tokens=null（unknown，非 0）
    expect(final.cost!.retries).toBeGreaterThanOrEqual(1);
    expect(final.cost!.tokens).toBeNull();
  });
});

describe('v8-F1 验收机器门（assertionGate）', () => {
  const writeImpl = (cwd: string, obj: unknown) => {
    fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify(obj));
  };

  it('断言有 fail → blocked 列明未过项；approve 人工追认放行后 run 完成', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    ops.onPrompt = () =>
      writeImpl(cwd, {
        summary: '完成',
        extra: {
          assertionResults: [
            { id: 'AC-1', status: 'ok', evidence: '测试全绿' },
            { id: 'AC-2', status: 'fail', evidence: '未实现导出' },
          ],
        },
      });
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    const prompt = engine.getRun(run.runId)!.nodes['impl']!.blockedPrompt!;
    expect(prompt).toContain('AC-2');
    expect(prompt).toContain('未实现导出');
    expect(prompt).not.toContain('AC-1:'); // 只列未通过项
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect(final.nodes['impl']!.state).toBe('done');
    expect((final.events ?? []).some((e) => e.text.includes('验收机器门拦截') && e.text.includes('AC-2'))).toBe(true);
    expect((final.events ?? []).some((e) => e.text.includes('人工追认放行'))).toBe(true);
  });

  it('reject → 节点失败、错误含未过断言', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    ops.onPrompt = () =>
      writeImpl(cwd, { summary: 'x', extra: { assertionResults: [{ id: 'AC-9', status: 'fail', evidence: '证据不足' }] } });
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('failed');
    expect(final.nodes['impl']!.error).toContain('验收断言未通过：AC-9');
  });

  it('input 追问一轮 → agent 重写产物全过 → 无需再拦', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    let turn = 0;
    ops.onPrompt = () => {
      turn += 1;
      writeImpl(cwd, {
        summary: `第${turn}轮`,
        extra: {
          assertionResults:
            turn === 1
              ? [{ id: 'AC-1', status: 'fail', evidence: '缺测试' }]
              : [{ id: 'AC-1', status: 'ok', evidence: '已补测试' }],
        },
      });
    };
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'input', text: '请补齐 AC-1 的测试后重写产物' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect(ops.prompts.length).toBe(2);
  });

  it('status 缺失按 fail 拦、n/a 放行', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    ops.onPrompt = () =>
      writeImpl(cwd, {
        summary: 'x',
        extra: {
          assertionResults: [
            { id: 'AC-1', status: 'n/a', evidence: '本次不涉及' },
            { id: 'AC-2', evidence: '没写 status' },
          ] as unknown[],
        },
      });
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    const prompt = engine.getRun(run.runId)!.nodes['impl']!.blockedPrompt!;
    expect(prompt).toContain('AC-2');
    expect(prompt).toContain('1 条');
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(engine.getRun(run.runId)!.state).toBe('completed');
  });

  it('产物文件缺失走终端兜底 → 节点标 unverified 且有警示事件', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph(); // onPrompt 默认不写结果文件 → output-fallback
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('completed');
    expect(run.nodes['impl']!.unverified).toBe(true);
    expect((run.events ?? []).some((e) => e.text.includes('未经文件验证'))).toBe(true);
  });
});

describe('v8-M1 契约接单门（contractGate）', () => {
  const writeImpl = (cwd: string, obj: unknown) => {
    fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify(obj));
  };
  const contractArt = (assertion: string, question: string) => ({
    summary: '规划完毕',
    extra: {
      contract: {
        assertions: [{ id: 'AC-1', assertion, verify_method: '人工核对' }],
        questions: [question],
      },
    },
  });
  const gateGraph = () => {
    const g = serialGraph();
    g.nodes[1]!.config.checks = [{ type: 'contract' }];
    return g;
  };

  it('无 extra.contract → 契约门未过，节点失败（无从立约不放行）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = gateGraph();
    ops.onPrompt = () => writeImpl(cwd, { summary: '只写了个寂寞' });
    const run = await runToCompletion(graph, cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['impl']!.error).toContain('契约门未过');
  });

  it('拦：blocked 列出候选断言与提问清单；reject → 终止本单下游不派', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = gateGraph();
    ops.onPrompt = () => writeImpl(cwd, contractArt('导出函数可被调用', '目标分支是哪个？'));
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    const prompt = engine.getRun(run.runId)!.nodes['impl']!.blockedPrompt!;
    expect(prompt).toContain('契约接单门');
    expect(prompt).toContain('AC-1: 导出函数可被调用');
    expect(prompt).toContain('目标分支是哪个？');
    await engine.approve(run.runId, 'impl', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('failed');
    expect(final.nodes['impl']!.error).toContain('契约未确认');
  });

  it('放行：approve → 契约确认事件 + run 完成', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = gateGraph();
    ops.onPrompt = () => writeImpl(cwd, contractArt('页面在移动端不破版', ''));
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect((final.events ?? []).some((e) => e.text.includes('契约门拦截'))).toBe(true);
    expect((final.events ?? []).some((e) => e.text.includes('契约确认放行：AC-1'))).toBe(true);
  });

  it('谈：input 把答案发给 agent → 重出契约再复核一轮才放行', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = gateGraph();
    let turn = 0;
    ops.onPrompt = () => {
      turn += 1;
      writeImpl(
        cwd,
        turn === 1
          ? contractArt('第一版候选断言', '预算上限是多少？')
          : contractArt('修订后断言：10 万行 3 秒内', '（已由人工答复）'),
      );
    };
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'input', text: '预算按 3 秒内出结果执行' });
    await waitFor(() => engine.isBlocked(run.runId, 'impl')); // 第二版契约仍要过门
    const prompt = engine.getRun(run.runId)!.nodes['impl']!.blockedPrompt!;
    expect(prompt).toContain('修订后断言');
    expect(ops.prompts.length).toBe(2);
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(engine.getRun(run.runId)!.state).toBe('completed');
  });
});

describe('v8-M2 契约成为 run 一等公民', () => {
  const writeImpl = (cwd: string, obj: unknown) => {
    fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify(obj));
  };
  const contractObj = (assertion: string) => ({
    summary: '规划',
    extra: {
      contract: {
        assertions: [{ id: 'AC-1', assertion, verify_method: '人工核对' }],
        questions: [],
        scopeNotes: '不动 test/ 目录',
      },
    },
  });

  it('无门节点产物写 extra.contract → 完成前落册为 input 契约并带时间线事件', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    ops.onPrompt = () => writeImpl(cwd, contractObj('导出可被调用'));
    const run = await runToCompletion(graph, cwd);
    expect(run.contract).toBeTruthy();
    expect(run.contract!.source).toBe('input');
    expect(run.contract!.assertions[0]!.assertion).toBe('导出可被调用');
    expect(run.contract!.scopeNotes).toBe('不动 test/ 目录');
    expect(run.contract!.confirmedAt).toBeUndefined();
    expect((run.events ?? []).some((e) => e.text.includes('契约落册'))).toBe(true);
    // 持久化在盘上（store 读回一致）
    expect(store.getRun(run.runId)!.contract!.assertions.length).toBe(1);
  });

  it('契约门 approve → 契约定稿：source=generated 且 confirmedAt 盖时刻', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    graph.nodes[1]!.config.checks = [{ type: 'contract' }];
    ops.onPrompt = () => writeImpl(cwd, contractObj('按契约干'));
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const c = engine.getRun(run.runId)!.contract!;
    expect(c.source).toBe('generated');
    expect(c.confirmedAt).toBeTruthy();
  });

  it('startRun 显式契约随单落册；产物再写 contract 不覆盖（先到先得）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    ops.onPrompt = () => writeImpl(cwd, contractObj('后来的'));
    const run = await engine.startRun(graph, cwd, undefined, undefined, undefined, undefined, {
      contract: {
        assertions: [{ id: 'AC-1', assertion: '机检自带', verify_method: '' }],
        questions: [],
        source: 'input',
      },
    });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.contract!.assertions[0]!.assertion).toBe('机检自带');
  });

  it('F1 门判定回指契约：契约内正常列、契约外 id 标注出来', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    ops.onPrompt = () =>
      writeImpl(cwd, {
        summary: 'x',
        extra: {
          contract: { assertions: [{ id: 'AC-1', assertion: '契约内断言', verify_method: 'v' }], questions: [] },
          assertionResults: [
            { id: 'AC-1', status: 'fail', evidence: '没做到' },
            { id: 'AC-7', status: 'fail', evidence: '来路不明' },
          ],
        },
      });
    const run = await engine.startRun(graph, cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    const prompt = engine.getRun(run.runId)!.nodes['impl']!.blockedPrompt!;
    expect(prompt).toContain('按本单契约 1 条对照');
    expect(prompt).toContain('- AC-1: 没做到');
    expect(prompt).not.toContain('AC-1: 没做到（');
    expect(prompt).toContain('AC-7: 来路不明（此 id 不在契约内——执行方自增/写错）');
  });

  it('断点续跑继承源 run 的契约', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = serialGraph();
    ops.onPrompt = () => writeImpl(cwd, { summary: 'x' }); // impl 不写产物也能完成（兜底）
    const src = await runToCompletion(graph, cwd);
    const patched = structuredClone(src);
    patched.contract = {
      assertions: [{ id: 'AC-1', assertion: '源单契约', verify_method: '' }],
      questions: [],
      source: 'generated',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    };
    store.saveRun(patched);
    const run2 = await engine.startRun(graph, cwd, undefined, undefined, undefined, src.runId);
    expect(run2.contract!.assertions[0]!.assertion).toBe('源单契约');
    await waitFor(() => engine.getRun(run2.runId)!.state !== 'running');
  });
});

describe('v8-M6 契约留痕与判例回流（引擎侧）', () => {
  const writeImpl = (cwd: string, obj: unknown) => {
    fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify(obj));
  };
  const contractArt = (template?: string) => ({
    summary: '规划',
    extra: {
      contract: {
        assertions: [{ id: 'AC-1', assertion: '复现不再触发', verify_method: 'v' }],
        questions: ['期望行为？'],
        ...(template ? { template } : {}),
      },
    },
  });
  const gateGraph = (template?: string) => {
    const g = serialGraph();
    g.nodes[1]!.config.checks = [{ type: 'contract', ...(template ? { template } : {}) }];
    return g;
  };

  it('留痕红线：门带 id@sha 配置 → approve 定稿的契约盖上模板戳（事件也带）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = () => writeImpl(cwd, contractArt());
    const run = await engine.startRun(gateGraph('bugfix@deadbeef'), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.contract!.template).toBe('bugfix@deadbeef');
    expect((final.events ?? []).some((e) => e.text.includes('契约确认放行') && e.text.includes('按 bugfix@deadbeef'))).toBe(true);
  });

  it('留痕红线：门配置戳压过产物自述（不信任执行方）；无门直落才接自述戳', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = () => writeImpl(cwd, contractArt('made-up@ffffffff'));
    const run = await engine.startRun(gateGraph('bugfix@deadbeef'), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(engine.getRun(run.runId)!.contract!.template).toBe('bugfix@deadbeef');

    // 无门直落路径：captureContract 接自述戳（无权威源可比，留痕优先）
    const ops2 = new FakeHerdrOps();
    const engine2 = new Engine(ops2, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store6-'))), OPTS);
    const plain = serialGraph();
    ops2.onPrompt = () => writeImpl(cwd, contractArt('docs@12345678'));
    const run2 = await engine2.startRun(plain, cwd);
    await waitFor(() => engine2.getRun(run2.runId)!.state !== 'running');
    expect(engine2.getRun(run2.runId)!.contract!.template).toBe('docs@12345678');
  });

  it('判例回流：门里 input 追问与 reject 都落到空间 contract-feedback.jsonl', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = () => writeImpl(cwd, contractArt());
    const run = await engine.startRun(gateGraph('bugfix@deadbeef'), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'input', text: 'AC-1 太空泛，改成可执行的复现核对' });
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const feedback = fs
      .readFileSync(path.join(dataDir, 'spaces', 'default', 'contract-feedback.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; template: string; runId: string; note?: string });
    expect(feedback.map((f) => f.kind)).toEqual(['negotiate', 'reject']);
    expect(feedback[0]!.template).toBe('bugfix@deadbeef');
    expect(feedback[0]!.note).toContain('改成可执行的复现核对');
  });
});

describe('v8-H1 分支守卫 + pr_url 交付出口', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

  /** 干净可交付的本地 git 仓库：main 上有初始提交，.herdr/（产物目录）已忽略 */
  function makeRepo(branch?: string): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-repo-'));
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.email', 'pf@test.local');
    git(cwd, 'config', 'user.name', 'pf-test');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.herdr/\n');
    fs.writeFileSync(path.join(cwd, 'README.md'), '# t\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'init');
    if (branch) git(cwd, 'checkout', '-b', branch);
    return cwd;
  }

  const writeImpl = (cwd: string, obj: unknown) => {
    fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify(obj));
  };
  const guardGraph = (expectBranch?: string) => {
    const g = serialGraph();
    g.nodes[1]!.config.checks = [{ type: 'delivery-branch', ...(expectBranch ? { expectBranch } : {}) }];
    return g;
  };

  it('当前就在期望交付分支 → 直接通过并留事件', async () => {
    const cwd = makeRepo('pf/x');
    const run = await runToCompletion(guardGraph('pf/x'), cwd);
    expect(run.state).toBe('completed');
    expect((run.events ?? []).some((e) => e.text.includes('分支守卫通过：pf/x'))).toBe(true);
  });

  it('HEAD 在 main → 硬失败，无人工放行路径', async () => {
    const cwd = makeRepo();
    const run = await runToCompletion(guardGraph('pf/x'), cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['impl']!.error).toContain('当前在默认分支「main」');
  });

  it('expectBranch 配成 main → 直接拒绝交付路径', async () => {
    const cwd = makeRepo();
    const run = await runToCompletion(guardGraph('main'), cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['impl']!.error).toContain('即默认分支');
  });

  it('分支不符 → blocked 列明两分支；reject → 节点失败', async () => {
    const cwd = makeRepo('topic');
    const run = await engine.startRun(guardGraph('pf/x'), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    const prompt = engine.getRun(run.runId)!.nodes['impl']!.blockedPrompt!;
    expect(prompt).toContain('「topic」');
    expect(prompt).toContain('「pf/x」');
    await engine.approve(run.runId, 'impl', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(engine.getRun(run.runId)!.state).toBe('failed');
    expect(engine.getRun(run.runId)!.nodes['impl']!.error).toContain('分支守卫未通过');
  });

  it('分支不符 → approve 人工放行按当前分支继续', async () => {
    const cwd = makeRepo('topic');
    const run = await engine.startRun(guardGraph('pf/x'), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect((final.events ?? []).some((e) => e.text.includes('分支守卫人工放行：按「topic」继续'))).toBe(true);
  });

  it('分支不符 → input 让 agent 切分支后复核：HEAD 已是期望分支则放行', async () => {
    const cwd = makeRepo('topic');
    const run = await engine.startRun(guardGraph('pf/x'), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    git(cwd, 'checkout', '-b', 'pf/x'); // 模拟 agent 按补充指令切了交付分支
    await engine.approve(run.runId, 'impl', { action: 'input', text: '请切到 pf/x 分支再继续' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect((final.events ?? []).some((e) => e.text.includes('分支守卫通过：pf/x'))).toBe(true);
  });

  it('非 git 工作区 → 告警跳过不拦', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-nogit-'));
    const run = await runToCompletion(guardGraph('pf/x'), cwd);
    expect(run.state).toBe('completed');
    expect((run.events ?? []).some((e) => e.text.includes('跳过分支校验'))).toBe(true);
  });

  it('无 expectBranch 时默认期望 pf/<runId>（与内置变量 run_id 同源）', async () => {
    const cwd = makeRepo();
    const run = await engine.startRun(guardGraph(), cwd);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    // 在 main 上：默认分支硬失败路径即证明默认期望生效且未被误判通过
    expect(run.nodes['impl']!.error ?? engine.getRun(run.runId)!.nodes['impl']!.error).toContain('当前在默认分支');
  });

  it('extra.pr_url 合法 https → 落册 run.prUrl + 交付出口事件；非法字符串拒收', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const good = serialGraph();
    ops.onPrompt = () => writeImpl(cwd, { summary: 'x', extra: { pr_url: 'https://github.com/acme/app/pull/9' } });
    const run = await runToCompletion(good, cwd);
    expect(run.prUrl).toBe('https://github.com/acme/app/pull/9');
    expect((run.events ?? []).some((e) => e.text.includes('交付出口：PR 已开出'))).toBe(true);

    const ops2 = new FakeHerdrOps();
    const engine2 = new Engine(ops2, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store2-'))), OPTS);
    const bad = serialGraph();
    ops2.onPrompt = () => writeImpl(cwd, { summary: 'x', extra: { pr_url: '见聊天记录' } });
    const run2 = await engine2.startRun(bad, cwd);
    await waitFor(() => engine2.getRun(run2.runId)!.state !== 'running');
    expect(engine2.getRun(run2.runId)!.prUrl).toBeUndefined();
  });

  it('内置变量 run_id：startRun 注入实际运行编号；未声明则原样保留', async () => {
    const cwd = makeRepo();
    const g = serialGraph();
    g.variables = [{ key: 'run_id', label: '运行编号', required: false }];
    g.nodes[1]!.config.prompt = '在分支 pf/{{run_id}} 上完成交付';
    const run = await engine.startRun(g, cwd);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(ops.prompts[0]!.text).toContain(`在分支 pf/${run.runId} 上完成交付`);

    const ops2 = new FakeHerdrOps();
    const engine2 = new Engine(ops2, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store3-'))), OPTS);
    const undeclared = serialGraph();
    undeclared.nodes[1]!.config.prompt = '分支 pf/{{run_id}}';
    const run2 = await engine2.startRun(undeclared, cwd);
    await waitFor(() => engine2.getRun(run2.runId)!.state !== 'running');
    expect(ops2.prompts[0]!.text).toContain('pf/{{run_id}}'); // applyVariables 只替换已声明变量
  });
});

describe('v8-F2 审批等待重启可活（paused）', () => {
  it('boot：磁盘 running 记录里 blocked 节点转 paused 且审批上下文保留', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-boot-'));
    const s2 = new Store(dir);
    const g = serialGraph();
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: 'r-paused',
      dagName: g.name,
      graph: g,
      state: 'running',
      cwd: dir,
      spaceId: 'default',
      startedAt: now,
      nodes: {
        start: { nodeId: 'start', state: 'done', attempts: 1, finishedAt: now },
        impl: { nodeId: 'impl', state: 'blocked', attempts: 1, blockedPrompt: '验收断言未全过（1 条）：AC-2' },
        end: { nodeId: 'end', state: 'pending', attempts: 0 },
      },
    };
    s2.saveRun(run);
    const e2 = new Engine(new FakeHerdrOps(), s2, OPTS);
    const r = e2.getRun('r-paused')!;
    expect(r.state).toBe('failed'); // run 判死但……
    expect(r.nodes['impl']!.state).toBe('paused'); // ……审批节点不再被抹平成 failed
    expect(r.nodes['impl']!.blockedPrompt).toBe('验收断言未全过（1 条）：AC-2');
    expect(r.nodes['impl']!.error).toContain('续跑');
    expect(r.nodes['start']!.state).toBe('done');
    expect((r.events ?? []).some((ev) => ev.text.includes('审批等待转入暂停'))).toBe(true);
    // 落盘的也是 paused（重启幂等）
    expect(new Store(dir, 'default').getRun('r-paused')!.nodes['impl']!.state).toBe('paused');
    // 原位追认不可达 → approve 返回 false（HTTP 层给 409 + 续跑指引）
    await expect(e2.approve('r-paused', 'impl', { action: 'approve' })).resolves.toBe(false);
  });

  it('boot：无 blocked 的中断 run 维持原语义（节点全标 failed）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-boot2-'));
    const s2 = new Store(dir);
    const g = serialGraph();
    const now = new Date().toISOString();
    s2.saveRun({
      runId: 'r-killed',
      dagName: g.name,
      graph: g,
      state: 'running',
      cwd: dir,
      spaceId: 'default',
      startedAt: now,
      nodes: {
        start: { nodeId: 'start', state: 'done', attempts: 1 },
        impl: { nodeId: 'impl', state: 'working', attempts: 1 },
        end: { nodeId: 'end', state: 'pending', attempts: 0 },
      },
    } as RunRecord);
    const e2 = new Engine(new FakeHerdrOps(), s2, OPTS);
    const r = e2.getRun('r-killed')!;
    expect(r.nodes['impl']!.state).toBe('failed');
    expect(r.nodes['impl']!.error).toBe('服务重启，运行中断');
  });
});

describe('v7-A5 断点续跑（resumeOf）', () => {
  it('done 节点继承不重跑，失败节点在新 run 完成，黑板从源 run 载入', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    let phase = 1;
    ops.onPrompt = (target, text) => {
      if (phase === 1 && text.includes('实现')) {
        // 第一轮 impl 失败：working → unknown（不可澄清 → 判死）
        ops.setStatus(target, 'working');
        setTimeout(() => ops.setStatus(target, 'unknown'), 10);
      }
    };
    const run = await runToCompletion(twoNodeGraph(), cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['design']!.state).toBe('done');
    expect(run.nodes['impl']!.state).toBe('failed');

    phase = 2;
    const promptsBefore = ops.prompts.length;
    const resumed = await engine.startRun(run.graph, cwd, undefined, undefined, undefined, run.runId);
    await waitFor(() => engine.getRun(resumed.runId)!.state !== 'running');
    const r2 = engine.getRun(resumed.runId)!;
    expect(r2.state).toBe('completed');
    expect(r2.nodes['design']!.state).toBe('done');
    const newPrompts = ops.prompts.slice(promptsBefore);
    // design 未被再次 prompt；impl 被重放且 {{design.artifact.summary}} 已由继承的黑板解析
    expect(newPrompts.some((p) => p.text.includes('设计'))).toBe(false);
    const implPrompt = newPrompts.find((p) => p.text.includes('实现'))!;
    expect(implPrompt.text).not.toContain('{{');
    expect(implPrompt.text.length).toBeGreaterThan('根据  实现'.length);
    // 继承事件留痕
    expect((r2.events ?? []).some((e) => e.text.includes(`继承 ${run.runId}`))).toBe(true);
  });

  it('源 run 无效（不存在/模板不一致）→ 启动即抛错，不产生新 run', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    await expect(engine.startRun(serialGraph(), cwd, undefined, undefined, undefined, 'ghost')).rejects.toThrow('断点续跑源无效');
    expect(engine.listRuns().length).toBe(0);
  });
});

describe('v8-G2 引用未解析 warn（不拦跑，上时间线）', () => {
  it('未声明变量/坏节点引用 → run 照常启动且 warn 事件点名出处', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const g = serialGraph();
    g.nodes[1]!.config.prompt = '依据 {{nope}} 干活，参考 {{ghost.artifact.summary}}';
    const run = await engine.startRun(g, cwd);
    expect(run.state).toBe('running'); // 不拦跑
    const warn = (run.events ?? []).find((e) => e.text.includes('引用未解析'));
    expect(warn?.text).toContain('2 处');
    expect(warn?.text).toContain('{{nope}}');
    expect(warn?.text).toContain('ghost');
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
  });

  it('已声明变量注入后无 warn 事件', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const g = serialGraph();
    g.variables = [{ key: 'nope', label: '输入' }];
    g.nodes[1]!.config.prompt = '依据 {{nope}} 干活';
    const run = await engine.startRun(g, cwd, undefined, { nope: '值已填' });
    expect((run.events ?? []).some((e) => e.text.includes('引用未解析'))).toBe(false);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
  });
});

describe('v8-M3 作用域规范注入（rules）', () => {
  function scopedGraph(): DagGraph {
    return {
      version: 1,
      name: 'scoped-test',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'a', type: 'agent', label: '甲', config: { agentKind: 'fake', prompt: '做A', cwd: 'alpha/svc' } },
        { id: 'b', type: 'agent', label: '乙', config: { agentKind: 'fake', prompt: '做B', cwd: 'beta' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
  }

  function spaceRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-m3-root-'));
    fs.mkdirSync(path.join(root, 'alpha', 'svc'), { recursive: true });
    fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
    fs.writeFileSync(path.join(root, 'global.md'), '全局约定：所有节点可见');
    fs.writeFileSync(path.join(root, 'alpha', 'conv-a.md'), '甲仓专属规矩');
    return root;
  }

  it('repo 规则只进对应仓的节点，无作用域规则全进，note 上标签', async () => {
    const root = spaceRoot();
    store.writeProfile({
      id: 'default',
      name: 'default',
      createdAt: '',
      rootCwd: root,
      rules: [{ file: 'global.md' }, { repo: 'alpha', file: 'alpha/conv-a.md', note: '仅甲仓适用' }],
    });
    const run = await runToCompletion(scopedGraph(), root);
    expect(run.state).toBe('completed');
    const pA = ops.prompts.find((p) => p.text.includes('做A'))!;
    const pB = ops.prompts.find((p) => p.text.includes('做B'))!;
    expect(pA.text).toContain('全局约定');
    expect(pA.text).toContain('甲仓专属规矩');
    expect(pA.text).toContain('note="仅甲仓适用"');
    expect(pB.text).toContain('全局约定');
    expect(pB.text).not.toContain('甲仓专属规矩');
  });

  it('旧 conventionFiles 兼容：与 rules 合并注入（等价无作用域条目）', async () => {
    const root = spaceRoot();
    fs.writeFileSync(path.join(root, 'legacy.md'), '旧约定文档');
    store.writeProfile({
      id: 'default',
      name: 'default',
      createdAt: '',
      rootCwd: root,
      conventionFiles: ['legacy.md'],
      rules: [{ pathsGlob: 'beta', file: 'global.md', note: '乙目录专属' }],
    });
    const run = await runToCompletion(scopedGraph(), root);
    expect(run.state).toBe('completed');
    const pA = ops.prompts.find((p) => p.text.includes('做A'))!;
    const pB = ops.prompts.find((p) => p.text.includes('做B'))!;
    expect(pA.text).toContain('旧约定文档'); // 旧字段全节点可见
    expect(pB.text).toContain('旧约定文档');
    expect(pB.text).toContain('全局约定'); // glob 命中 beta
    expect(pA.text).not.toContain('全局约定'); // 未命中不注入
  });
});

describe('v8-I1 skills 死配置激活（节点注入通道）', () => {
  function twoNodeGraph(): DagGraph {
    return {
      version: 1,
      name: 'skills-test',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'a', type: 'agent', label: '甲', config: { agentKind: 'fake', prompt: '做A', cwd: 'alpha/svc' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
  }

  it('profile.skills 整篇进节点 prompt（技能库措辞 + 标签）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-i1-root-'));
    fs.mkdirSync(path.join(root, 'alpha', 'svc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'deploy-skill.md'), '技能做法：先跑门禁再发布');
    store.writeProfile({
      id: 'default',
      name: 'default',
      createdAt: '',
      rootCwd: root,
      skills: ['deploy-skill.md'],
    });
    const run = await runToCompletion(twoNodeGraph(), root);
    expect(run.state).toBe('completed');
    const pA = ops.prompts.find((p) => p.text.includes('做A'))!;
    expect(pA.text).toContain('技能库');
    expect(pA.text).toContain('技能做法：先跑门禁再发布');
    expect(pA.text).toContain('<技能文档 name="deploy-skill.md">');
  });

  it('同一文件既在 rules 又在 skills：只注入一次（去重防双份）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-i1-dedupe-'));
    fs.writeFileSync(path.join(root, 'shared.md'), '共享做法文档');
    store.writeProfile({
      id: 'default',
      name: 'default',
      createdAt: '',
      rootCwd: root,
      rules: [{ file: 'shared.md' }],
      skills: ['shared.md'],
    });
    const run = await runToCompletion(twoNodeGraph(), root);
    expect(run.state).toBe('completed');
    const pA = ops.prompts.find((p) => p.text.includes('做A'))!;
    expect(pA.text.match(/共享做法文档/g)).toHaveLength(1);
  });
});

describe('v8-G3 空间级轻队列', () => {
  /** impl 挂 manual 门：run 停在 blocked（state 仍是 running），占额度直到放行 */
  function gatedGraph(name = 'gated'): DagGraph {
    const g = serialGraph();
    g.name = name;
    g.nodes[1]!.config.checks = [{ type: 'manual', prompt: '确认执行' }];
    return g;
  }
  const setCap = (n: number) =>
    store.writeProfile({ id: 'default', name: 'default', createdAt: '', maxConcurrentRuns: n });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('并发满 → queued；前单终态后自动出队跑完', async () => {
    setCap(1);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-q-'));
    const r1 = await engine.startRun(gatedGraph('g1'), cwd);
    expect(r1.state).toBe('running');
    await waitFor(() => engine.getRun(r1.runId)!.nodes['impl']!.state === 'blocked');
    const r2 = await engine.startRun(serialGraph(), cwd);
    expect(r2.state).toBe('queued');
    expect(engine.getRun(r2.runId)!.state).toBe('queued');
    // 队列事件上了时间线（位次可见）
    expect((engine.getRun(r2.runId)!.events ?? []).some((e) => e.text.includes('排队中'))).toBe(true);

    await engine.approve(r1.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(r1.runId)!.state === 'completed');
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'queued');
    await waitFor(() => engine.getRun(r2.runId)!.state === 'completed');
    const run2 = engine.getRun(r2.runId)!;
    expect((run2.events ?? []).some((e) => e.text.includes('出队启动'))).toBe(true);
  });

  it('排队中可取消（stopRun 即终态 cancelled），放行前单后不会再启动它', async () => {
    setCap(1);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-q-'));
    const r1 = await engine.startRun(gatedGraph('g1'), cwd);
    await waitFor(() => engine.getRun(r1.runId)!.nodes['impl']!.state === 'blocked');
    const r2 = await engine.startRun(serialGraph(), cwd);
    expect(r2.state).toBe('queued');
    expect(engine.stopRun(r2.runId)).toBe(true);
    expect(engine.getRun(r2.runId)!.state).toBe('cancelled');
    await engine.approve(r1.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(r1.runId)!.state === 'completed');
    await sleep(150); // 给 pump 一个窗口：撤掉的排队项不能被复活
    expect(engine.getRun(r2.runId)!.state).toBe('cancelled');
  });

  it('同 issue 幂等锁覆盖排队中：queued 也拒重复下发', async () => {
    setCap(1);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-q-'));
    const r1 = await engine.startRun(gatedGraph('g1'), cwd, undefined, undefined, '55');
    await waitFor(() => engine.getRun(r1.runId)!.nodes['impl']!.state === 'blocked');
    const r2 = await engine.startRun(serialGraph(), cwd, undefined, undefined, '66');
    expect(r2.state).toBe('queued');
    await expect(engine.startRun(serialGraph(), cwd, undefined, undefined, '66')).rejects.toThrow(/已有运行中\/排队中/);
  });

  it('首驾-2 血缘豁免：父 run 带 issue 时，其 pipeline 子 run（parentRunId 指回父）同 issue 放行；无血缘的重复下发仍拒', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-lineage-'));
    const parent = await engine.startRun(gatedGraph('g77'), cwd, undefined, undefined, '77');
    await waitFor(() => engine.getRun(parent.runId)!.nodes['impl']!.state === 'blocked');
    const child = await engine.startRun(serialGraph(), cwd, undefined, undefined, '77', undefined, { parentRunId: parent.runId });
    expect(child.parentRunId).toBe(parent.runId);
    await expect(engine.startRun(serialGraph(), cwd, undefined, undefined, '77')).rejects.toThrow(/已有运行中\/排队中/);
  });

  // N3 排队可见即可动：queueStatus 给占用者与位次；promoteRun 提到队首（满额不点火，空额即启）
  it('queueStatus：running 占用者与 queued 位次可见；promoteRun 换序、非排队单返回 false', async () => {
    setCap(1);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-q-'));
    const r1 = await engine.startRun(gatedGraph('g1'), cwd);
    await waitFor(() => engine.getRun(r1.runId)!.nodes['impl']!.state === 'blocked');
    const g2 = serialGraph();
    g2.metadata.description = '第二条排队单';
    const r2 = await engine.startRun(g2, cwd);
    const r3 = await engine.startRun(serialGraph(), cwd);
    expect([r2.state, r3.state]).toEqual(['queued', 'queued']);

    const q = engine.queueStatus();
    expect(q.cap).toBe(1);
    expect(q.running.map((x) => x.runId)).toEqual([r1.runId]);
    expect(q.queued.map((x) => [x.runId, x.position])).toEqual([[r2.runId, 1], [r3.runId, 2]]);
    expect(q.queued[0]!.title).toBe('第二条排队单');

    expect(engine.promoteRun(r3.runId)).toBe(true);
    expect(engine.queueStatus().queued.map((x) => x.runId)).toEqual([r3.runId, r2.runId]);
    // 满额时提队首不越权点火：两条仍是 queued
    expect(engine.getRun(r3.runId)!.state).toBe('queued');
    expect((engine.getRun(r3.runId)!.events ?? []).some((e) => e.text.includes('提到队首'))).toBe(true);
    // 不在队列的单（running / 不存在）拒绝
    expect(engine.promoteRun(r1.runId)).toBe(false);
    expect(engine.promoteRun('nope')).toBe(false);

    await engine.approve(r1.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(r3.runId)!.state === 'completed');
    await waitFor(() => engine.getRun(r2.runId)!.state === 'completed');
  });

  it('重启复原：queued 记录重新入列并在额度内自动开跑', async () => {
    setCap(1);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-q-'));
    const r1 = await engine.startRun(gatedGraph('g1'), cwd);
    await waitFor(() => engine.getRun(r1.runId)!.nodes['impl']!.state === 'blocked');
    const r2 = await engine.startRun(serialGraph(), cwd);
    expect(r2.state).toBe('queued');
    // 模拟服务重启：新引擎读盘——running 的 g1 被清扫为 failed，queued 的 g2 复原并放行跑完
    const ops2 = new FakeHerdrOps();
    const engine2 = new Engine(ops2, new Store(dataDir), OPTS);
    await waitFor(() => engine2.getRun(r2.runId)!.state === 'completed');
    expect(engine2.getRun(r1.runId)!.state).toBe('failed');
  });
});

describe('v8-I2 上次经验自动注入 v0（仅变量层）', () => {
  async function greenRun(cwd: string, variables?: Record<string, string>) {
    const run = await engine.startRun(twoNodeGraph(), cwd, undefined, variables);
    await waitFor(() => engine.getRun(run.runId)!.state === 'completed');
    return engine.getRun(run.runId)!;
  }

  it('实填变量留档在册；同模板再有绿 run → 经验块进首个 agent 节点 + 注入事件上时间线', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-i2-'));
    const first = await greenRun(cwd, { 目标: '优化台账汇总' });
    expect(first.variables).toEqual({ 目标: '优化台账汇总' });

    const second = await greenRun(cwd);
    const designPrompt = second.graph.nodes.find((n) => n.id === 'design')!.config.prompt!;
    expect(designPrompt).toContain('【上次经验');
    expect(designPrompt).toContain(`绿 run ${first.runId}`);
    expect(designPrompt).toContain('目标=优化台账汇总');
    expect(designPrompt).toContain('（该单无在册契约）');
    expect(designPrompt).toContain('历史经验参考，不是本单需求');
    expect((second.events ?? []).some((e) => e.text.includes('经验注入') && e.text.includes(first.runId))).toBe(true);
    // 进的是真提示词通道：agent 实际收到的 prompt 也带经验块
    const sent = ops.prompts.filter((p) => p.text.includes('【上次经验'));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // 第二单自己也是绿 run：注入不应递归污染（run3 的经验块仍指向最新绿单且只有一块）
    const third = await greenRun(cwd);
    const p3 = third.graph.nodes.find((n) => n.id === 'design')!.config.prompt!;
    expect(p3.match(/【上次经验/g)).toHaveLength(1);
    expect(p3).toContain(`绿 run ${second.runId}`);
  });

  it('全局关：experienceInjection=false 不再注入，也不发事件', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-i2-off-'));
    await greenRun(cwd, { 目标: 'X' });
    store.writeProfile({ id: 'default', name: 'default', createdAt: '', experienceInjection: false });
    const second = await greenRun(cwd);
    expect(second.graph.nodes.find((n) => n.id === 'design')!.config.prompt).toBe('设计');
    expect((second.events ?? []).some((e) => e.text.includes('经验注入'))).toBe(false);
  });

  it('模板不同名 / 未完成的 run 都不算经验源；断言清单进块（本单契约优先措辞）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-i2-mix-'));
    // 绿 run 带契约
    const withContract = await engine.startRun(twoNodeGraph(), cwd, undefined, undefined, undefined, undefined, {
      contract: {
        assertions: [{ id: 'AC-1', assertion: '10 万行 3 秒出结果', verify_method: '人工' }],
        questions: [],
        source: 'input',
      },
    });
    await waitFor(() => engine.getRun(withContract.runId)!.state === 'completed');
    // 异名模板（gatedGraph 复制版改名 exp-other）→ 无注入
    const other = serialGraph();
    other.name = 'exp-other';
    const foreign = await runToCompletion(other, cwd);
    expect(foreign.graph.nodes.some((n) => (n.config.prompt ?? '').includes('【上次经验'))).toBe(false);
    // 同名 → 注入且断言在列
    const same = await greenRun(cwd);
    const designPrompt = same.graph.nodes.find((n) => n.id === 'design')!.config.prompt!;
    expect(designPrompt).toContain('AC-1：10 万行 3 秒出结果');
    expect(designPrompt).toContain('本单以自身契约为准');
  });
});

describe('v8-AE Agent 选择链与网关统一', () => {
  function aeGraph(name: string, kind?: string): DagGraph {
    return {
      version: 1,
      name,
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'w', type: 'agent', label: '甲', config: { ...(kind ? { agentKind: kind } : {}), prompt: '做A' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'w' },
        { id: 'e2', source: 'w', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
  }
  const profile = (patch: Partial<{ defaultAgentKind: string; agentOverride: boolean }>) =>
    store.writeProfile({ id: 'default', name: 'default', createdAt: '', ...patch });

  it('AE-1 节点/角色都没指定：先吃空间默认，再回落自动推荐（OPTS 注入 reco）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ae1-'));
    profile({ defaultAgentKind: 'pi' });
    await runToCompletion(aeGraph('ae1a'), cwd);
    expect(ops.starts.at(-1)!.kind).toBe('pi');
    // 清掉空间默认 → 自动推荐（本机真实探针被 OPTS 替成 reco，测试不依赖装了什么）
    profile({});
    await runToCompletion(aeGraph('ae1b'), cwd);
    expect(ops.starts.at(-1)!.kind).toBe('reco');
  });

  it('AE-2 统一覆盖开：空间默认压过节点里钉死的类型；关着则节点优先', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ae2-'));
    profile({ defaultAgentKind: 'pi', agentOverride: true });
    await runToCompletion(aeGraph('ae2-on', 'claude'), cwd);
    expect(ops.starts.at(-1)!.kind).toBe('pi');
    profile({ defaultAgentKind: 'pi', agentOverride: false });
    await runToCompletion(aeGraph('ae2-off', 'claude'), cwd);
    expect(ops.starts.at(-1)!.kind).toBe('claude');
  });

  it('AE-3 网关启用时 pi 自动带 --provider paneflow-gw --model，且 pane env 注入网关变量（统一走网关）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ae3-'));
    fs.writeFileSync(
      path.join(dataDir, 'gateway.json'),
      JSON.stringify({ baseUrl: 'http://gw.local:4444/', apiKey: 'sk-test', freeModel: 'auto/free', enabled: true }),
    );
    const run = await runToCompletion(aeGraph('ae3', 'pi'), cwd);
    const start = ops.starts.at(-1)!;
    expect(start.kind).toBe('pi');
    expect(start.args.slice(0, 4)).toEqual(['--provider', 'paneflow-gw', '--model', 'auto/free']);
    const paneEnv = ops.paneEnvs.get(run.nodes['w']!.paneId!)!;
    expect(paneEnv.OPENAI_BASE_URL).toBe('http://gw.local:4444/v1');
    expect(paneEnv.OPENAI_API_KEY).toBe('sk-test');
    expect(paneEnv.PANEFLOW_GW_KEY).toBe('sk-test');
  });

  it('AE-4 网关未启用：pi 不加路由参数（保持其自身缺省）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ae4-'));
    await runToCompletion(aeGraph('ae4', 'pi'), cwd);
    expect(ops.starts.at(-1)!.args).toEqual([]);
  });
});

/**
 * v13-#106：resolveAgentKind 末端从「硬猜 opencode」改成人话报错。
 * 猜出来的 kind 在这台机器上必起不来，只会走「启动超时（节点缺省 30 分钟硬顶）」的慢红路；
 * 现在 fail-closed 即时收 failed（与 E2 在 Planner 侧同款族），watch 照按红。
 */
describe('v13-#106 节点侧 agent 类型四级皆空 = 即时报错', () => {
  function noKindGraph(name: string): DagGraph {
    return {
      version: 1,
      name,
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'w', type: 'agent', label: '甲', config: { prompt: '做A' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'w' },
        { id: 'e2', source: 'w', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
  }
  /** 顶层 runToCompletion 吃的是 beforeEach 里的共享 engine，本组要自带 opts 故自带跑法 */
  async function selfRun(e2: Engine, graph: DagGraph, cwd: string): Promise<RunRecord> {
    const run = await e2.startRun(graph, cwd);
    await waitFor(() => e2.getRun(run.runId)!.state !== 'running');
    return e2.getRun(run.runId)!;
  }

  it('四级皆空 + 推荐实探空：节点秒败带二选一指路、一个 agent 都没起、harness 宁缺毋假', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-106-'));
    const e2 = new Engine(ops, store, { ...OPTS, recommendAgentKind: async () => null });
    const t0 = Date.now();
    const run = await selfRun(e2, noKindGraph('n106'), cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['w']!.state).toBe('failed');
    expect(run.nodes['w']!.error).toContain(NODE_NO_AGENT_KIND_ERROR);
    // 秒败而非等启动超时（OPTS 里 agentStartTimeoutMs=5s，慢红路会吃满它）
    expect(Date.now() - t0).toBeLessThan(2_000);
    // 没有派单能力就不该碰终端
    expect(ops.starts).toHaveLength(0);
    // harness 是旁账：算不出就整键缺（宁缺毋假），但不许把起跑挡下来——run 记录照样在册
    expect(run.harness).toBeUndefined();
    expect(store.getRun(run.runId)?.state).toBe('failed');
  });

  it('四级里任何一级有值就不报错：空间默认落地即照绿（报错只留给真没法派单的机器）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-106b-'));
    store.writeProfile({ id: 'default', name: 'default', createdAt: '', defaultAgentKind: 'pi' });
    const e2 = new Engine(ops, store, { ...OPTS, recommendAgentKind: async () => null });
    const run = await selfRun(e2, noKindGraph('n106b'), cwd);
    expect(run.state).toBe('completed');
    expect(ops.starts.at(-1)!.kind).toBe('pi');
    expect(run.harness?.agentKind).toBe('pi');
  });
});

/** v11-D2：节点异常失败（stalled 等）时错误信息尽力附带 agent 终端输出尾行 */
describe('v11-D2 失败信息带报错尾行', () => {
  /** 确认窗内 agent 始终 idle → promptAndSettle 抛 agent_prompt_stalled → 走异常失败路径 */
  async function stalledRun(tailOutput: () => Promise<string>): Promise<string | undefined> {
    const e2 = new Engine(ops, store, { ...OPTS, promptConfirmWindowMs: 1_500 });
    ops.readOutput = tailOutput;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d2-'));
    const run = await e2.startRun(serialGraph(), cwd);
    await waitFor(() => e2.getRun(run.runId)!.state !== 'running');
    const final = e2.getRun(run.runId)!;
    expect(final.state).toBe('failed');
    return final.nodes['impl']!.error;
  }

  it('失败且输出含报错行 → error 保留原 message 在最前、尾附输出末段（保尾截断 ~800 字符）', async () => {
    const output = `HEAD-MARKER${'x'.repeat(2000)}\nError: real boom in tail`;
    const err = await stalledRun(async () => output);
    expect(err).toBeDefined();
    expect(err!.startsWith('agent_prompt_stalled')).toBe(true);
    expect(err).toContain('（输出尾部：');
    expect(err).toContain('Error: real boom in tail');
    expect(err).not.toContain('HEAD-MARKER'); // 超长只保尾部
    const tailPart = err!.slice(err!.indexOf('（输出尾部：') + '（输出尾部：'.length, -'）'.length);
    expect(tailPart.length).toBeLessThanOrEqual(800);
    expect(tailPart.endsWith('Error: real boom in tail')).toBe(true);
  });

  it('输出短于 800 字符 → 原样尾附', async () => {
    const err = await stalledRun(async () => 'Error: tiny failure');
    expect(err).toContain('（输出尾部：Error: tiny failure）');
  });

  it('readOutput 抛错 → 静默降级，error 仍是原 message 不炸', async () => {
    const err = await stalledRun(async () => {
      throw new Error('probe boom');
    });
    expect(err).toMatch(/^agent_prompt_stalled/);
    expect(err).not.toContain('输出尾部');
  });

  it('readOutput 返回空/纯空白 → 静默降级为裸 message', async () => {
    expect(await stalledRun(async () => '')).not.toContain('输出尾部');
    expect(await stalledRun(async () => '  \n\t \n')).not.toContain('输出尾部');
  });
});

describe('v11-D3 run 状态分级（completed-with-failures）', () => {
  it('全绿收口：无失败节点 → completed', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.state).toBe('completed');
    expect(run.events?.some((e) => e.text.includes('运行结束：completed（'))).toBe(true);
  });

  it('onFail=continue 带一个失败节点收口 → completed-with-failures（不再洗绿）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const graph = twoNodeGraph();
    graph.nodes.find((n) => n.id === 'design')!.config.onFail = 'continue';
    ops.onPrompt = (target) => {
      if (target.includes('-design-')) {
        // agent errors out: working → unknown (unclearable) → treated as failure
        ops.setStatus(target, 'working');
        setTimeout(() => ops.setStatus(target, 'unknown'), 10);
      }
    };
    const run = await runToCompletion(graph, cwd);
    expect(run.nodes['design']!.state).toBe('failed');
    expect(run.nodes['impl']!.state).toBe('skipped'); // 上游失败，合法跳过不另计
    expect(run.nodes['end']!.state).toBe('done');
    expect(run.state).toBe('completed-with-failures');
    expect(run.events?.some((e) => e.text.includes('运行结束：completed-with-failures'))).toBe(true);
    expect(run.cost).toBeTruthy(); // R6a 成本记账照常（视同已结束）
    expect(engine.stopRun(run.runId)).toBe(false); // 已结束不可再停：与 completed 同路
  });
});

/**
 * v11-D1 网关感知限流（摩擦账 #10）：注入 503 的 mock 网关回归——
 * 排队（按主机闸串行）→ 错峰重放（收紧窗）→ 收口。
 */
describe('v11-D1 网关感知限流（闸 + 退避错峰）', () => {
  function enableFreeGateway() {
    fs.writeFileSync(
      path.join(dataDir, 'gateway.json'),
      JSON.stringify({ baseUrl: 'http://gw-limit.local:4444/', apiKey: 'sk-test', enabled: true }),
    );
  }
  /** 包一层 startAgent：记录每次起窗时刻；只对命中谓词的首次起窗注入 503（重试同名判定不可靠——agent 名带全局序号） */
  function spyStarts(throttleMatch?: (name: string) => boolean): { name: string; at: number }[] {
    const orig = ops.startAgent.bind(ops);
    const starts: { name: string; at: number }[] = [];
    let matched = 0;
    ops.startAgent = async (paneId, name, kind, args) => {
      starts.push({ name, at: Date.now() });
      if (throttleMatch?.(name) && ++matched === 1) {
        throw new Error('herdr: agent.start rejected: gateway responded HTTP 503 Service Unavailable');
      }
      await orig(paneId, name, kind, args);
    };
    return starts;
  }

  it('排队：网关闸 cap=1 时三分支并行节点串行起窗（与 pane 额度取交集）', async () => {
    enableFreeGateway();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d1-q-'));
    ops.promptDelayMs = 120;
    engine = new Engine(ops, store, { ...OPTS, maxConcurrentPanes: 8, gwMaxConcurrent: 1, gwPollMs: 10 });
    const run = await runToCompletion(fanoutGraph(), cwd);
    expect(run.state).toBe('completed');
    expect(ops.maxConcurrent).toBe(1); // pane 给到 8 也全走闸排队
    for (const id of ['fa', 'fb', 'fc']) expect(run.nodes[id]!.state).toBe('done');
    expect(engine.gwGateSnapshot()['gw-limit.local:4444']!.active).toBe(0); // 收口后无在途残留
  });

  it('免闸：未配网关的 run 不受主机闸影响', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d1-ngw-'));
    ops.promptDelayMs = 120;
    engine = new Engine(ops, store, { ...OPTS, maxConcurrentPanes: 8, gwMaxConcurrent: 1, gwPollMs: 10 });
    const run = await runToCompletion(fanoutGraph(), cwd);
    expect(run.state).toBe('completed');
    expect(ops.maxConcurrent).toBe(3);
  });

  it('退避重放：起窗即吃 503 → 限流专属额外重试 + 退避后成功收口', async () => {
    enableFreeGateway();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d1-bo-'));
    const starts = spyStarts((name) => name.includes('-impl-'));
    engine = new Engine(ops, store, {
      ...OPTS,
      gwMaxConcurrent: 2,
      gwPollMs: 10,
      gwBackoffBaseMs: 30,
      gwTightenMs: 60,
    });
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.state).toBe('completed');
    expect(run.nodes['impl']!.state).toBe('done');
    expect(run.nodes['impl']!.attempts).toBe(2); // retryCount=0 也吃限流专属预算
    expect(starts.filter((s) => s.name.includes('-impl-'))).toHaveLength(2);
    expect(run.events?.some((e) => e.text.includes('检测到网关限流（429/503）'))).toBe(true);
    expect(run.events?.some((e) => e.text.includes('第 1 次重试'))).toBe(true);
  });

  it('错峰：一次 503 后同网关后续起窗被收紧窗推迟（不挤在同一时刻重放）', async () => {
    enableFreeGateway();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d1-st-'));
    const starts = spyStarts((name) => name.includes('-fa-'));
    engine = new Engine(ops, store, {
      ...OPTS,
      maxConcurrentPanes: 8,
      gwMaxConcurrent: 2,
      gwPollMs: 10,
      gwBackoffBaseMs: 40,
      gwTightenMs: 400,
    });
    ops.promptDelayMs = 150;
    const run = await runToCompletion(fanoutGraph(), cwd);
    expect(run.state).toBe('completed');
    const t0 = starts.find((s) => s.name.includes('-fa-'))!.at;
    expect(starts).toHaveLength(4); // fa 两次起窗 + fb/fc 各一次
    // 闸 cap=2：与 fa 首批同窗的一个节点照常起，其余两次（fa 重放 + 被挡的）落在 400ms 收紧窗之后
    const late = starts.filter((s) => s.at - t0 >= 300);
    const early = starts.filter((s) => s.at - t0 < 300);
    expect(early).toHaveLength(2);
    expect(late).toHaveLength(2);
    for (const id of ['fa', 'fb', 'fc']) expect(run.nodes[id]!.state).toBe('done');
  });

  it('PF_GW_MAX_CONCURRENT=0：显式关闸，网关 run 不再被额外串行化', async () => {
    enableFreeGateway();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d1-off-'));
    process.env.PF_GW_MAX_CONCURRENT = '0';
    try {
      ops.promptDelayMs = 120;
      const e2 = new Engine(ops, store, { ...OPTS, maxConcurrentPanes: 8, gwPollMs: 10 });
      const run = await e2.startRun(fanoutGraph(), cwd);
      await waitFor(() => e2.getRun(run.runId)!.state !== 'running');
      expect(e2.getRun(run.runId)!.state).toBe('completed');
      expect(ops.maxConcurrent).toBe(3);
    } finally {
      delete process.env.PF_GW_MAX_CONCURRENT;
    }
  });
});

/**
 * v11-D5（摩擦账 #13）：run 草稿落点移出 cwd——引擎内置变量 draft_dir 解析为
 * <dataDir>/spaces/<space>/runs/drafts/<血缘根 runId>/（启动即建目录），
 * 父子 run 沿 parentRunId 血缘共享同一份；草稿永不落 run 的 working directory。
 */
describe('v11-D5 run 草稿落点（draft_dir 内置变量）', () => {
  /** 单 agent 节点图：prompt 用哨兵包住 {{draft_dir}}，解析后可精确捕获落点 */
  function draftGraph(name: string, marker: string): DagGraph {
    const g = serialGraph();
    g.name = name;
    g.variables = [{ key: 'draft_dir', label: '本 run 草稿目录', required: false }];
    g.nodes[1]!.config.prompt = `${marker}→{{draft_dir}}|end。参考 {{design.artifact.summary}}`;
    return g;
  }
  const re = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function draftDirOf(promptWithMarker: string | undefined, marker: string): string {
    expect(promptWithMarker, `prompt 应含标记 ${marker}`).toBeTruthy();
    const m = promptWithMarker!.match(new RegExp(`${re(marker)}→([^|]+)\\|`));
    expect(m, 'prompt 里 draft_dir 应已解析为绝对路径').not.toBeNull();
    return m![1]!;
  }
  function promptOf(marker: string): string {
    const p = ops.prompts.find((x) => x.text.includes(`${marker}→`));
    expect(p, `ops 应收到含标记 ${marker} 的 prompt`).toBeTruthy();
    return p!.text;
  }

  it('节点 prompt 的 {{draft_dir}} 解析为 dataDir 下真实存在的 run 草稿目录，无裸占位符残留', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d5-'));
    const run = await runToCompletion(draftGraph('d5-root', 'ROOT'), cwd);
    expect(run.state).toBe('completed');
    const dir = draftDirOf(promptOf('ROOT'), 'ROOT');
    expect(dir).toBe(path.join(dataDir, 'spaces', 'default', 'runs', 'drafts', run.runId));
    expect(fs.statSync(dir).isDirectory()).toBe(true); // 引擎启动即 mkdir，agent 落笔即可用
    expect(ops.prompts[0]!.text).not.toContain('{{draft_dir}}');
  });

  it('非默认空间：草稿目录落在该空间分区下', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d5-space-'));
    const run = await engine.startRun(draftGraph('d5-space', 'SP'), cwd, 'beta');
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(draftDirOf(promptOf('SP'), 'SP')).toBe(path.join(dataDir, 'spaces', 'beta', 'runs', 'drafts', run.runId));
  });

  it('父子血缘：带 parentRunId 的子 run（及其子）与血缘根共享同一草稿目录，父写的草稿文件子可见', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d5-lineage-'));
    const parent = await runToCompletion(draftGraph('d5-parent', 'PAR'), cwd);
    const parentDir = draftDirOf(promptOf('PAR'), 'PAR');
    // 模拟受理阶段落稿：issue-draft.json 写进血缘根草稿目录
    fs.writeFileSync(path.join(parentDir, 'issue-draft.json'), JSON.stringify({ title: '血缘草稿' }));

    const childRun = await engine.startRun(draftGraph('d5-child', 'CHI'), cwd, undefined, undefined, undefined, undefined, {
      parentRunId: parent.runId,
    });
    expect(childRun.parentRunId).toBe(parent.runId);
    await waitFor(() => engine.getRun(childRun.runId)!.state !== 'running');
    const childDir = draftDirOf(promptOf('CHI'), 'CHI');
    expect(childDir).toBe(parentDir); // 不是自己的目录：上溯到血缘根
    expect(fs.existsSync(path.join(childDir, 'issue-draft.json'))).toBe(true);

    // 孙辈继续上溯到同一血缘根
    const grand = await engine.startRun(draftGraph('d5-grand', 'GRA'), cwd, undefined, undefined, undefined, undefined, {
      parentRunId: childRun.runId,
    });
    expect(grand.parentRunId).toBe(childRun.runId);
    await waitFor(() => engine.getRun(grand.runId)!.state !== 'running');
    expect(draftDirOf(promptOf('GRA'), 'GRA')).toBe(parentDir);
  });

  it.each([
    { tag: 'plain', name: 'd5-inv-a', make: () => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d5-inv-')) },
    {
      tag: 'repo',
      name: 'd5-inv-b',
      make: () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d5-inv-repo-'));
        execFileSync('git', ['init', '-q', d]);
        return d;
      },
    },
  ])('核心不变式（#13）：draft_dir 永不落在 run 的 cwd 之内（$tag 工作目录）', async ({ name, make }) => {
    const cwd = make();
    await runToCompletion(draftGraph(name, 'INV'), cwd);
    const dir = draftDirOf(promptOf('INV'), 'INV');
    expect(dir).not.toBe(cwd);
    expect(dir.startsWith(cwd + path.sep)).toBe(false);
    expect(dir.startsWith(path.join(dataDir, 'spaces'))).toBe(true);
    // 草稿型 run 走完 cwd 无草稿产物（.gitignore 是既有运行卫生守护的写入，非草稿）
    expect(fs.readdirSync(cwd).filter((f) => !['.git', '.gitignore'].includes(f))).toEqual([]);
    if (name === 'd5-inv-b') {
      const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain']).toString().trim();
      expect(status === '' || status === '?? .gitignore').toBe(true);
    }
  });

  it('模板未声明 draft_dir：占位符原样保留（与 run_id 同机制）并挂 G2 未解析告警，不炸 run', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d5-und-'));
    const g = serialGraph();
    g.name = 'd5-undeclared';
    g.nodes[1]!.config.prompt = '草稿写进 {{draft_dir}}';
    const run = await runToCompletion(g, cwd);
    expect(run.state).toBe('completed');
    expect(ops.prompts[0]!.text).toContain('{{draft_dir}}'); // applyVariables 只替换已声明变量
    expect(run.events?.some((e) => e.text.includes('引用未解析') && e.text.includes('draft_dir'))).toBe(true);
  });

  it('内置模板口径：triage/align 声明并只准往 draft_dir 写草稿；其余模板不再出现 issue-draft 约定', () => {
    const triage = BUILTIN_TEMPLATES.find((t) => t.name === 'builtin-issue-triage')!;
    const delivery = BUILTIN_TEMPLATES.find((t) => t.name === 'builtin-generic-issue-delivery')!;
    for (const t of [triage, delivery]) {
      expect((t.variables ?? []).some((v) => v.key === 'draft_dir'), t.name).toBe(true);
    }
    const triagePrompt = triage.nodes.find((n) => n.id === 'triage')!.config.prompt!;
    const alignPrompt = delivery.nodes.find((n) => n.id === 'align')!.config.prompt!;
    expect(triagePrompt).toContain('只准写引擎注入的 run 草稿目录 {{draft_dir}}');
    expect(triagePrompt).toContain('{{draft_dir}}/issue-draft.json');
    expect(alignPrompt).toContain('只准写引擎注入的草稿目录 {{draft_dir}}');
    expect(alignPrompt).toContain('{{draft_dir}}/issue-draft.json');
    // 旧口径（草稿在工作目录）清零
    expect(alignPrompt).not.toContain('在工作目录');
    for (const t of BUILTIN_TEMPLATES) {
      if (t === triage || t === delivery) continue;
      expect(JSON.stringify(t.nodes), `${t.name} 不应再有 issue-draft 草稿约定`).not.toContain('issue-draft');
    }
  });

  it('真跑内置 generic-delivery：align 节点 prompt 带解析后的 draft_dir 绝对路径，工作目录零写入', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-d5-live-'));
    const tmpl = BUILTIN_TEMPLATES.find((t) => t.name === 'builtin-generic-issue-delivery')!;
    const run = await engine.startRun(tmpl, cwd, 'default', { task: '给导出模块加空值兜底' });
    await waitFor(() => ops.prompts.some((p) => p.target.includes('align')));
    const align = ops.prompts.find((p) => p.target.includes('align'))!;
    const dir = path.join(dataDir, 'spaces', 'default', 'runs', 'drafts', run.runId);
    expect(align.text).toContain(`只准写引擎注入的草稿目录 ${dir}（已创建）`);
    expect(align.text).toContain(`${dir}/issue-draft.json`);
    expect(align.text).not.toContain('{{draft_dir}}');
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.readdirSync(cwd).filter((f) => f !== '.gitignore')).toEqual([]); // cwd 只读：草稿全在 draft_dir
    engine.stopRun(run.runId);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
  });
});

// -- v11-C1 自动蒸挂点：绿收口后 fire-and-forget；默认 off；非绿不蒸；蒸炸不弄红收口 ----
describe('v11-C1 engine 收口后自动蒸馏挂点（注入 wikiDistillRun 以绝网络/git）', () => {
  afterEach(() => {
    delete process.env.PF_WIKI_DISTILL;
  });

  it('默认 off：env 未设时绿收口也不起蒸（自动推 main 未经用户点头，宁缺毋滥）', async () => {
    delete process.env.PF_WIKI_DISTILL;
    const spy = vi.fn(async (_run: RunRecord) => {});
    engine = new Engine(ops, store, { ...OPTS, wikiDistillRun: spy });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.state).toBe('completed');
    await new Promise((s) => setTimeout(s, 50));
    expect(spy).not.toHaveBeenCalled();
  });

  it('开关 on：绿收口后收到终态 run；执行体 reject 也只静默，收口状态不受影响（不阻塞证明）', async () => {
    const spy = vi.fn(async (_run: RunRecord) => {
      throw new Error('蒸馏炸了');
    });
    engine = new Engine(ops, store, { ...OPTS, wikiDistill: 'on', wikiDistillRun: spy });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    await waitFor(() => spy.mock.calls.length > 0);
    expect(run.state).toBe('completed');
    expect(spy.mock.calls[0]![0]!.runId).toBe(run.runId);
    // fire-and-forget：收口路径没 await 过它——终态持久化已完成、状态没被改回
    await new Promise((s) => setTimeout(s, 30));
    expect(engine.getRun(run.runId)!.state).toBe('completed');
  });

  it('非绿收口（failed）不触发自动蒸', async () => {
    const spy = vi.fn(async (_run: RunRecord) => {});
    engine = new Engine(ops, store, { ...OPTS, wikiDistill: 'on', wikiDistillRun: spy });
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'unknown'), 10);
    };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.state).toBe('failed');
    await new Promise((s) => setTimeout(s, 50));
    expect(spy).not.toHaveBeenCalled();
  });
});

// -- v11-E1 replay：同契约复跑 + R3.4 豁免口 + 实验元数据 + 收数表挂点 ----------------
describe('v11-E1 engine：replayRun 穿透同 issue 锁 / 实验元数据 / 收数表落盘', () => {
  it('普通下发撞 R3.4 锁照旧被拒；replayRun 显式穿透并留 replayOf+experiment+变量血缘+时间线事件', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e1-replay-'));
    const g = serialGraph();
    ops.onPrompt = () => {
      /* 永不 settle：让原单保持在跑，锁才真实生效 */
    };
    const r1 = await engine.startRun(g, cwd, 'default', { task: '甲' }, '170');
    await expect(engine.startRun(g, cwd, 'default', {}, '170')).rejects.toThrow(/170/);
    const r2 = await engine.replayRun(r1.runId, { suite: 'c4', arm: 'a', flag: 'readback=on' });
    expect(r2.runId).not.toBe(r1.runId);
    expect(r2.replayOf).toBe(r1.runId);
    expect(r2.experiment).toEqual({ suite: 'c4', arm: 'a', flag: 'readback=on' });
    expect(r2.issueId).toBe('170');
    expect(r2.dagName).toBe('serial-test');
    expect(r2.variables).toMatchObject({ task: '甲' });
    expect(
      (r2.events ?? []).some(
        (e) =>
          e.type === 'run' &&
          e.text.includes('复跑 replay（E1a）') &&
          e.text.includes(r1.runId) &&
          e.text.includes('c4') &&
          e.text.includes('臂 a'),
      ),
    ).toBe(true);
    // 豁免只对锁：replay 出来的单再被普通下发撞同 issue，依然拒
    await expect(engine.startRun(g, cwd, 'default', {}, '170')).rejects.toThrow(/170/);
    engine.stopRun(r1.runId);
    engine.stopRun(r2.runId);
    await waitFor(
      () => engine.getRun(r1.runId)!.state !== 'running' && engine.getRun(r2.runId)!.state !== 'running',
    );
  });

  it('replay 不存在的 run：报「找不到」指路；不带实验元数据的 replay 只标血缘不入实验册', async () => {
    await expect(engine.replayRun('nope1234')).rejects.toThrow(/找不到要 replay 的原 run：nope1234/);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e1-plain-'));
    const r1 = await runToCompletion(serialGraph(), cwd);
    const r2 = await engine.replayRun(r1.runId);
    expect(r2.replayOf).toBe(r1.runId);
    expect(r2.experiment).toBeUndefined();
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
    expect(fs.existsSync(path.join(dataDir, 'experiments'))).toBe(false); // 非实验单零落盘
  });

  it('带 suite 的 run 收口后 fire-and-forget 落收数表一行（含臂与终态）；非实验单不落', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e1-row-'));
    const run = await engine.startRun(serialGraph(), cwd, 'default', undefined, undefined, undefined, {
      experiment: { suite: 'c4', arm: 'b' },
    });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(run.state).toBe('completed');
    const file = path.join(dataDir, 'experiments', 'c4', `${engine.getRun(run.runId)!.finishedAt!.slice(0, 10)}.md`);
    // 等「这一行到位」而不是「文件存在」：落行是 fire-and-forget，慢机器上文件可先于
    // 本行出现（同日另一臂的表已建）——existsSync 判据在 CI 上是假绿/假红两用（v13 首推脆测试②）
    await waitFor(() => {
      try {
        return fs.readFileSync(file, 'utf8').includes(`| ${run.runId} |`);
      } catch {
        return false;
      }
    });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# 实验收数');
    expect(text).toContain(`| ${run.runId} | b | - | completed |`);
    // 同引擎再跑一单普通活：experiments 目录里不添乱
    const plain = await runToCompletion(serialGraph(), cwd);
    await new Promise((s) => setTimeout(s, 50));
    expect(plain.experiment).toBeUndefined();
    const rows = fs.readdirSync(path.join(dataDir, 'experiments', 'c4'));
    expect(rows).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir, 'experiments', 'c4', rows[0]!), 'utf8')).toContain(run.runId);
  });
});

// -- v12-V1 harness 披露：起单实发配置固化 + replay 漂移比对（只发事件不拦，R5） --------
describe('v12-V1 engine harness 固化（起单一次性写回）', () => {
  it('run 头带 harness：实发 graph 指纹可复算、kind=AE 链首 agent 节点结果；无网关时 model/gwProfile 键省略（绝不估算）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v1-h-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.harness).toBeDefined();
    // serial-test 执行序首个 agent 节点（impl）钉了 agentKind=fake → 链在节点级即出结果
    expect(run.harness!.agentKind).toBe('fake');
    expect(run.harness!.graphSha).toMatch(/^[0-9a-f]{8}$/);
    // 在册 graph 就是实发终态：对 run.graph 复算 sha 与落册一致（两次序列化同值）
    expect(run.harness!.graphSha).toBe(contentSha(run.graph));
    expect(contentSha(structuredClone(run.graph))).toBe(run.harness!.graphSha);
    // 网关没配：两闸口留缺省，不编值
    expect(run.harness!.model).toBeUndefined();
    expect(run.harness!.gwProfile).toBeUndefined();
  });

  it('graphSha 算的是注入完成后的终态：I2 经验注入改了 prompt → 两单指纹不同且各与在册 graph 一致', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v1-inj-'));
    const first = await engine.startRun(twoNodeGraph(), cwd, undefined, { 目标: '甲' });
    await waitFor(() => engine.getRun(first.runId)!.state === 'completed');
    const second = await engine.startRun(twoNodeGraph(), cwd);
    await waitFor(() => engine.getRun(second.runId)!.state === 'completed');
    const s2 = engine.getRun(second.runId)!;
    expect(s2.graph.nodes.find((n) => n.id === 'design')!.config.prompt).toContain('【上次经验');
    // 实发快照（含注入块）进指纹：注入单与未注入单 sha 必不同
    expect(s2.harness!.graphSha).not.toBe(engine.getRun(first.runId)!.harness!.graphSha);
    expect(s2.harness!.graphSha).toBe(contentSha(s2.graph));
  });

  it('旧记录兼容：v11 时代无 harness 字段的落册记录存取不炸，读回该键为 undefined', () => {
    const legacy = {
      runId: 'old12345',
      dagName: 'g',
      graph: serialGraph(),
      state: 'completed',
      cwd: '/tmp/x',
      nodes: {},
      startedAt: '2026-09-01T00:00:00.000Z',
      finishedAt: '2026-09-01T00:01:00.000Z',
    } as unknown as RunRecord;
    store.saveRun(legacy);
    const back = store.getRun('old12345');
    expect(back).not.toBeNull();
    expect(back!.harness).toBeUndefined();
  });
});

describe('v12-V1 engine replay 漂移比对（只落透明性事件，不拦起跑）', () => {
  const driftEvents = (r: RunRecord) => (r.events ?? []).filter((e) => e.text.includes('harness 漂移'));

  it('起单后档位/模型变了再 replay → 新单事件含「harness 漂移」与差异项；档位一致复跑不再发', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v1-drift-'));
    const r1 = await runToCompletion(serialGraph(), cwd); // 无网关期起单：model/gwProfile 均缺省
    upsertGatewayProfile(dataDir, { name: '档A', baseUrl: 'https://gw-a.example.com', apiKey: 'k', freeModel: 'free-m' });
    const r2 = await engine.replayRun(r1.runId);
    expect(r2.harness?.model).toBe('free-m'); // 新单起单现读到生效档模型
    const d2 = driftEvents(r2);
    expect(d2).toHaveLength(1);
    expect(d2[0]!.text).toContain('harness 漂移');
    expect(d2[0]!.text).toContain('model 未设→free-m');
    // R5：只发事件不拦——单照常起（replay 血缘事件都齐）
    expect(r2.replayOf).toBe(r1.runId);
    expect((r2.events ?? []).some((e) => e.text.includes('复跑 replay（E1a）'))).toBe(true);
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
    // 同档再复跑：harness 相等 → 零漂移事件
    const r3 = await engine.replayRun(r2.runId);
    expect(driftEvents(r3)).toHaveLength(0);
    await waitFor(() => engine.getRun(r3.runId)!.state !== 'running');
    // 换空间钉档（另一档另一模型）：钉档与 model 双漂移都进事件文案
    const p2 = upsertGatewayProfile(dataDir, { id: 'gwb', name: '档B', baseUrl: 'https://gw-b.example.com', apiKey: 'k2', freeModel: 'other-m' });
    store.writeProfile({ ...store.readProfile(), gatewayProfile: p2.id });
    const r4 = await engine.replayRun(r3.runId);
    expect(r4.harness).toMatchObject({ gwProfile: 'gwb', model: 'other-m' });
    const d4 = driftEvents(r4);
    expect(d4).toHaveLength(1);
    expect(d4[0]!.text).toContain('钉档 未钉→gwb');
    expect(d4[0]!.text).toContain('model free-m→other-m');
    await waitFor(() => engine.getRun(r4.runId)!.state !== 'running');
  });

  it('原单无 harness（v11 旧单）→ replay 无从比对，静默照常起', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v1-legacy-'));
    const r1 = await runToCompletion(serialGraph(), cwd);
    delete engine.getRun(r1.runId)!.harness; // 模拟旧落册记录
    upsertGatewayProfile(dataDir, { name: '档A', baseUrl: 'https://gw-a.example.com', apiKey: 'k', freeModel: 'free-m' });
    const r2 = await engine.replayRun(r1.runId);
    expect(r2.replayOf).toBe(r1.runId);
    expect(driftEvents(r2)).toHaveLength(0);
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
  });
});

// -- v13-V2 等臂机检：harness 三字段起单固化 + 骨架不受注入面扰动 --------------------------
const REPO_V2 = 'me/arm';

/** 种 wiki 缓存页（零网络零 git，姿势同 readback.test.ts）：让读回在生产数据形态下真注得上 */
function seedSummaryPage(repo: string, file: string, o: { title: string; body: string }): void {
  const abs = path.join(wikiCacheDir(dataDir, repo), WIKI_ROOT, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\ntitle: "${o.title}"\ntype: summary\nconfidence: high\n---\n\n${o.body}\n`);
}

/** 带契约（携 repo=读回认仓三路之一）把单跑到终态并回读在册记录 */
async function runWithContract(
  eng: Engine,
  cwd: string,
  opts: Parameters<Engine['startRun']>[6],
  graph = serialGraph(),
) {
  const started = await eng.startRun(graph, cwd, undefined, undefined, undefined, undefined, opts);
  await waitFor(() => eng.getRun(started.runId)!.state !== 'running');
  return eng.getRun(started.runId)!;
}

describe('v13-V2 engine 等臂三字段固化（readback / readbackOutcome / skeletonSha）', () => {
  it('普通单（无仓可读回）：readback=false、outcome=no-pages；graph 无注入块无 run_id 字面量时 skeletonSha=graphSha', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v2-plain-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.harness!.readback).toBe(false);
    expect(run.harness!.readbackOutcome).toBe('no-pages'); // tmp cwd 无 git remote、无契约/默认仓
    expect(run.harness!.skeletonSha).toMatch(/^[0-9a-f]{8}$/);
    // serial-test 未声明 run_id/draft_dir 变量、这单也没吃到任何注入块 → 剥/归一全是 no-op
    expect(run.harness!.skeletonSha).toBe(run.harness!.graphSha);
  });

  it('开关 off 的单：outcome=switch-off（与「on 但无页」不再塌同一读数）', async () => {
    const offEngine = new Engine(ops, store, { ...OPTS, wikiReadback: 'off' });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v2-off-'));
    const run = await offEngine.startRun(serialGraph(), cwd);
    await waitFor(() => offEngine.getRun(run.runId)!.state !== 'running');
    expect(run.harness!.readback).toBe(false);
    expect(run.harness!.readbackOutcome).toBe('switch-off');
  });

  it('fresh dispatch 两单只差 I2 经验注入：graphSha 必不同、skeletonSha 相等（命门的引擎端实跑）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v2-skel-'));
    const g1 = serialGraph();
    const first = await runToCompletion(g1, cwd);
    // 同模板绿 run 在前 → 第二单纯 fresh dispatch 会吃到 I2 经验注入（prompt 多一块）
    const second = await runToCompletion(structuredClone(g1), cwd);
    expect(JSON.stringify(second.graph.nodes)).toContain('【上次经验 · I2 自动注入');
    expect(second.harness!.graphSha).not.toBe(first.harness!.graphSha);
    expect(second.harness!.skeletonSha).toBe(first.harness!.skeletonSha);
  });

  it('replay 同契约：骨架与原单相等 → 不产「harness 漂移」事件（旧 run_id 字面量与二次注入都不假阳）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v2-replay-'));
    const r1 = await runToCompletion(serialGraph(), cwd);
    const r2 = await engine.replayRun(r1.runId, { suite: 'c4', arm: 'a' });
    expect(r2.harness!.skeletonSha).toBe(r1.harness!.skeletonSha);
    expect((r2.events ?? []).filter((e) => e.text.includes('harness 漂移'))).toHaveLength(0);
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
  });

  it('声明 run_id/draft_dir 的模板 replay：旧字面量烧在册 graph 里，血缘链同步归一 → 骨架仍等、零漂移事件', async () => {
    // 生产形态=内置模板同款：prompt 里 {{run_id}}/{{draft_dir}} 起单被真值替换（分支名 pf/<id> 等），
    // replay 复用在册 graph——旧真值不再是占位符、applyVariables 不触碰，全靠 skeletonLiteralsFor 上溯链归一
    const g = serialGraph();
    g.variables = [
      { key: 'run_id', label: '运行编号', required: false },
      { key: 'draft_dir', label: '草稿目录', required: false },
    ];
    g.nodes[1]!.config.prompt = `在分支 pf/{{run_id}} 交付，草稿落 {{draft_dir}}/issue-draft.json`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v2-lit-'));
    const r1 = await runToCompletion(structuredClone(g), cwd);
    expect(r1.graph.nodes[1]!.config.prompt).toContain(`pf/${r1.runId}`); // 真值确实烧进在册 graph
    const r2 = await engine.replayRun(r1.runId);
    expect(r2.runId).not.toBe(r1.runId);
    expect(r2.harness!.skeletonSha).toBe(r1.harness!.skeletonSha);
    expect((r2.events ?? []).filter((e) => e.text.includes('harness 漂移'))).toHaveLength(0);
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
  });

  //  Integrator 补（v13-V2 收口）：on 臂实注入与 inherited 是 C4 真正吃的两个读数，
  //  只有合成块的单测=假绿。以下三组走引擎实路（种 wiki-cache，零网络零 git）。
  it('命门·on 臂实注入 vs off 臂：readback 不等而 skeletonSha 相等，「两臂只差读回块」机器证成', async () => {
    seedSummaryPage(REPO_V2, 'summaries/export-null.md', {
      title: '实现功能与导出空值',
      body: '实现功能时先给导出模块加空值兜底，再补一条回归测试。',
    });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v2-arm-'));
    // 两臂同一份拓扑（各自 structuredClone）：serialGraph 每次盖创建时刻，共用同一份才排掉夹具噪声
    const g = serialGraph();
    const on = await runWithContract(
      engine,
      cwd,
      { contract: { source: 'input', assertions: [], questions: [], repo: REPO_V2 } },
      structuredClone(g),
    );
    expect(JSON.stringify(on.graph.nodes)).toContain(READBACK_HEADER);
    expect(on.harness!.readback).toBe(true);
    expect(on.harness!.readbackOutcome).toBe('injected');
    expect(on.wikiReadback?.nodes.length).toBeGreaterThan(0);

    const offEng = new Engine(ops, store, { ...OPTS, wikiReadback: 'off' });
    const off = await runWithContract(
      offEng,
      cwd,
      { contract: { source: 'input', assertions: [], questions: [], repo: REPO_V2 } },
      structuredClone(g),
    );
    expect(JSON.stringify(off.graph.nodes)).not.toContain(READBACK_HEADER);
    expect(off.harness!.readback).toBe(false);
    expect(off.harness!.readbackOutcome).toBe('switch-off');
    // 等臂判据本体：实发拓扑 sha 不等（注入块改了 prompt），骨架 sha 相等（剥净后逐字节同构）
    expect(on.harness!.graphSha).not.toBe(off.harness!.graphSha);
    expect(on.harness!.skeletonSha).toBe(off.harness!.skeletonSha);
  });

  it('inherited 态（replay 带旧块）：off 引擎 replay on 单 → 本次一克没注但 prompt 里有块，readback=true、outcome=inherited', async () => {
    seedSummaryPage(REPO_V2, 'summaries/replay-block.md', {
      title: '实现功能的旧沉淀',
      body: '实现功能前先读这条旧沉淀。',
    });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v2-inh-'));
    const src = await runWithContract(engine, cwd, {
      contract: { source: 'input', assertions: [], questions: [], repo: REPO_V2 },
    });
    expect(src.harness!.readbackOutcome).toBe('injected');
    // 新引擎=独立实例，boot 时从盘上复原 run 册；off 开关让本次一克不注
    const offEng = new Engine(ops, store, { ...OPTS, wikiReadback: 'off' });
    const re = await offEng.replayRun(src.runId);
    await waitFor(() => offEng.getRun(re.runId)!.state !== 'running');
    const back = offEng.getRun(re.runId)!;
    expect(back.harness!.readback).toBe(true); // 扫实态：旧块还在 prompt 里，不因开关是 off 就报「无」
    expect(back.harness!.readbackOutcome).toBe('inherited');
    expect(back.harness!.skeletonSha).toBe(src.harness!.skeletonSha); // 堆叠的旧块剥净后骨架仍等
  });

  it('not-injected 态：有页源但本单零目标节点（与「无页源」不再塌同一读数）', async () => {
    seedSummaryPage(REPO_V2, 'summaries/orphan.md', {
      title: '实现功能的沉淀',
      body: '实现功能的经验。',
    });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v2-noinj-'));
    // 把 impl 节点改名为纯核对节点（id/label 都不命中读回目标式）
    const g = serialGraph();
    const n = g.nodes[1]!;
    n.id = 'check';
    n.label = '核对';
    n.config.prompt = '核对产物';
    g.edges[0]!.target = 'check';
    g.edges[1]!.source = 'check';
    const run = await runWithContract(
      engine,
      cwd,
      { contract: { source: 'input', assertions: [], questions: [], repo: REPO_V2 } },
      g,
    );
    expect(run.state).toBe('completed');
    expect(run.harness!.readback).toBe(false);
    expect(run.harness!.readbackOutcome).toBe('not-injected');
  });

  it('旧记录兼容：v13-V2 前的 harness（只有 graphSha/agentKind）落册读回不炸，三新键整缺为 undefined', () => {
    const legacy = {
      runId: 'old2v13',
      dagName: 'g',
      graph: serialGraph(),
      state: 'completed',
      cwd: '/tmp/x',
      nodes: {},
      startedAt: '2026-09-20T00:00:00.000Z',
      harness: { graphSha: 'deadbeef', agentKind: 'pi' },
    } as unknown as RunRecord;
    store.saveRun(legacy);
    const back = store.getRun('old2v13')!;
    expect(back.harness).toEqual({ graphSha: 'deadbeef', agentKind: 'pi' });
    expect(back.harness!.readback).toBeUndefined();
    expect(back.harness!.readbackOutcome).toBeUndefined();
    expect(back.harness!.skeletonSha).toBeUndefined();
  });
});

// -- v12-S1a 副作用可见化：结构化落册（append 账 + prUrl 镜像），宁缺毋假 ----------------
describe('v12-S1a engine 副作用落册（端点归因 append / 只认活跃 run / prUrl 镜像两处同写）', () => {
  it('活跃 run 归因：建单/覆写各 append 进 issuesCreated/issuePatched 并各落一条「副作用」事件（落盘可读）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s1a-'));
    ops.onPrompt = () => {
      /* 永不 settle：run 保持 running，归因才生效 */
    };
    const run = await engine.startRun(serialGraph(), cwd);
    expect(engine.recordIssueSideEffect(run.runId, 'created', 12)).toBe(true);
    expect(engine.recordIssueSideEffect(run.runId, 'patched', 7)).toBe(true);
    expect(engine.recordIssueSideEffect(run.runId, 'patched', 7)).toBe(true); // 同号覆写两次=两笔账
    const r = engine.getRun(run.runId)!;
    expect(r.sideEffects).toEqual({ issuesCreated: [12], issuePatched: [7, 7] });
    const seEvents = (r.events ?? []).filter((e) => e.text.includes('副作用（S1a）'));
    expect(seEvents).toHaveLength(3);
    expect(seEvents[0]!.text).toContain('建单 #12');
    expect(seEvents[1]!.text).toContain('覆写 Issue #7');
    // 结构化落册（评审 R4）：账在磁盘记录上，不靠事件流推导
    expect(store.getRun(run.runId)!.sideEffects).toEqual({ issuesCreated: [12], issuePatched: [7, 7] });
    engine.stopRun(run.runId);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
  });

  it('不猜不硬绑：未知 run / 已收口 run 一律 false，零改动（pushedAt 无自报键=留空）', async () => {
    expect(engine.recordIssueSideEffect('ghost1234', 'created', 1)).toBe(false);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s1a-dead-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(engine.recordIssueSideEffect(run.runId, 'created', 2)).toBe(false); // completed 不再归因
    const after = engine.getRun(run.runId)!;
    expect(after.sideEffects).toBeUndefined();
    expect(after.sideEffects?.pushedAt).toBeUndefined(); // deliver extra 无 push 类自报键：宁缺毋假
  });

  it('capturePrUrl 一处写两字段：run.prUrl 与 sideEffects.prUrl 同源镜像', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s1a-pr-'));
    ops.onPrompt = () => {
      fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.herdr/artifacts/impl.json'),
        JSON.stringify({ summary: 'x', extra: { pr_url: 'https://github.com/acme/app/pull/9' } }),
      );
    };
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.prUrl).toBe('https://github.com/acme/app/pull/9');
    expect(run.sideEffects?.prUrl).toBe('https://github.com/acme/app/pull/9');
  });
});

// -- v12-S1b 副作用感知 replay：默认拒 / 显式穿透 / 只关这一道门 --------------------------
describe('v12-S1b replay 副作用门禁（sideEffects 非空默认拒两行指路；穿透起单落透明性事件；其余门不豁免）', () => {
  const seedSE = (runId: string) => {
    const r = engine.getRun(runId)!;
    r.sideEffects = { issuesCreated: [12], issuePatched: [7] };
    r.prUrl = 'https://github.com/o/r/pull/3';
  };

  it('源 run 带副作用 → 起单前即拒（run 数不涨），文案两行：清单 + 两旗标指路', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s1b-deny-'));
    const r1 = await runToCompletion(serialGraph(), cwd);
    seedSE(r1.runId);
    const before = engine.listRuns().length;
    const err = await engine.replayRun(r1.runId).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const lines = (err as Error).message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`源 run ${r1.runId} 有副作用（建单#12 · 回写#7 · PR https://github.com/o/r/pull/3`);
    expect(lines[0]).toContain('直接重放会二次副作用');
    expect(lines[1]).toContain('--allow-side-effects');
    expect(lines[1]).toContain('--from-failed');
    expect(engine.listRuns().length).toBe(before); // 拒绝发生在 startRun 之前
  });

  it('allowSideEffects 穿透：照常起单 + 新单落「带副作用复跑（S1b 穿透）」事件（含原单清单摘要）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s1b-pass-'));
    const r1 = await runToCompletion(serialGraph(), cwd);
    seedSE(r1.runId);
    const r2 = await engine.replayRun(r1.runId, undefined, { allowSideEffects: true });
    expect(r2.replayOf).toBe(r1.runId);
    const ev = (r2.events ?? []).filter((e) => e.text.includes('带副作用复跑（S1b 穿透）'));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.text).toContain('建单#12 · 回写#7 · PR https://github.com/o/r/pull/3');
    expect(ev[0]!.text).toContain('全量重放，外部写会二次发生');
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
  });

  it('无副作用单零打扰（不发拒绝也不发穿透事件）；旧 run 只有 prUrl（无 sideEffects 落册）也进门禁判据', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s1b-clean-'));
    const r1 = await runToCompletion(serialGraph(), cwd);
    const r2 = await engine.replayRun(r1.runId); // v11 既有语义：照常起
    expect(r2.replayOf).toBe(r1.runId);
    expect((r2.events ?? []).some((e) => e.text.includes('S1b'))).toBe(false);
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
    // 预镜像时代的旧单：prUrl 结构化在册即算副作用
    const legacy = engine.getRun(r2.runId)!;
    legacy.prUrl = 'https://github.com/o/r/pull/9';
    delete legacy.sideEffects;
    await expect(engine.replayRun(legacy.runId)).rejects.toThrow(/有副作用（PR /);
  });

  it('穿透只关这一道判断：allowSideEffects 下脏检查等其余门照旧拦（错误文案是门自己的）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s1b-dirty-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'pf@test.local');
    git('config', 'user.name', 'pf-test');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.herdr/\n');
    fs.writeFileSync(path.join(cwd, 'README.md'), '# t\n');
    git('add', '-A');
    git('commit', '-m', 'init');
    const r1 = await runToCompletion(serialGraph(), cwd);
    expect(r1.state).toBe('completed');
    seedSE(r1.runId);
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), '未提交改动\n'); // 起单前先脏
    const err = await engine
      .replayRun(r1.runId, undefined, { allowSideEffects: true })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('未提交改动');
    expect((err as Error).message).not.toContain('副作用'); // 不是门禁的文案——门照常生效
    expect(engine.listRuns().length).toBe(1);
  });
});

// -- v12-S3 replay×resume 合流：--from-failed 接既有 resume 通道 --------------------------
describe('v12-S3 replay×resume 合流（fromFailed 走 done 继承通道，只重放失败/未执行节点）', () => {
  /** 复刻 v7-A5 断点续跑场景：design 绿、impl 第一轮判死 */
  async function failingRun(cwd: string) {
    let phase = 1;
    ops.onPrompt = (target, text) => {
      if (phase === 1 && text.includes('实现')) {
        ops.setStatus(target, 'working');
        setTimeout(() => ops.setStatus(target, 'unknown'), 10);
      }
    };
    const run = await runToCompletion(twoNodeGraph(), cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['design']!.state).toBe('done');
    phase = 2;
    return run;
  }

  it('fromFailed：done 节点起单即继承不重跑（无二次外部写），失败节点重放收全绿，replay 血缘事件照在', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s3-'));
    const r1 = await failingRun(cwd);
    const promptsBefore = ops.prompts.length;
    const r2 = await engine.replayRun(r1.runId, undefined, { fromFailed: true });
    expect(r2.replayOf).toBe(r1.runId);
    expect(r2.nodes['design']!.state).toBe('done'); // 继承在 startRun 返回前即完成
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
    const fin = engine.getRun(r2.runId)!;
    expect(fin.state).toBe('completed');
    const newPrompts = ops.prompts.slice(promptsBefore);
    expect(newPrompts.some((p) => p.text.includes('设计'))).toBe(false); // design 不再被 prompt
    expect(newPrompts.some((p) => p.text.includes('实现'))).toBe(true); // impl 是唯一重放对象
    expect((fin.events ?? []).some((e) => e.text.includes(`继承 ${r1.runId}`))).toBe(true);
    expect((fin.events ?? []).some((e) => e.text.includes('复跑 replay（E1a）'))).toBe(true);
  });

  it('拒绝文案里的 --from-failed 指路真实可达：带副作用源单仍需显式穿透，穿透后 done 节点不重跑', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s3-se-'));
    const r1 = await failingRun(cwd);
    r1.sideEffects = { prUrl: 'https://github.com/o/r/pull/3' }; // 例如失败前已开过 PR
    // 只带 fromFailed 不开闸：照拒（副作用可能挂在被重放的失败节点上，穿透必须显式）
    await expect(engine.replayRun(r1.runId, undefined, { fromFailed: true })).rejects.toThrow(/有副作用/);
    const promptsBefore = ops.prompts.length;
    const r2 = await engine.replayRun(r1.runId, undefined, { fromFailed: true, allowSideEffects: true });
    const ev = (r2.events ?? []).filter((e) => e.text.includes('带副作用复跑（S1b 穿透）'));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.text).toContain('--from-failed（done 节点不重跑）');
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
    const fin = engine.getRun(r2.runId)!;
    expect(fin.state).toBe('completed');
    expect((fin.events ?? []).some((e) => e.text.includes(`继承 ${r1.runId}`))).toBe(true);
    const newPrompts = ops.prompts.slice(promptsBefore);
    expect(newPrompts.some((p) => p.text.includes('设计'))).toBe(false); // 穿透也没二次重跑 done 节点
  });

  it('与 V1 共存：from-failed 路新单 harness 照常固化，档位变了照落漂移事件', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s3-drift-'));
    const r1 = await failingRun(cwd);
    upsertGatewayProfile(dataDir, { name: '档A', baseUrl: 'https://gw-a.example.com', apiKey: 'k', freeModel: 'free-m' });
    const r2 = await engine.replayRun(r1.runId, { suite: 'c4', arm: 'b' }, { fromFailed: true });
    expect(r2.harness?.model).toBe('free-m');
    expect((r2.events ?? []).some((e) => e.text.includes('harness 漂移'))).toBe(true);
    expect(r2.experiment).toEqual({ suite: 'c4', arm: 'b' });
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
  });
});

// -- v12-S2 token 预算执行点：实时累计 → 启动前熔断 → null 只警示 → persist 往返 -----------
describe('v12-S2 token 预算熔断（costLive 实时账 + 节点启动前比对）', () => {
  const writeArt = (cwd: string, name: string, obj: unknown) => {
    fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, `.herdr/artifacts/${name}.json`), JSON.stringify(obj));
  };
  const designWith = (extra: Record<string, unknown>) => ({ summary: '设计完成', extra });
  const contractExtra = (maxTokens: number) => ({
    contract: {
      assertions: [{ id: 'AC-1', assertion: '按契约干', verify_method: '人工核对' }],
      questions: [],
      budget: { maxTokens },
    },
  });

  it('契约中途落册即生效：design 自报 usage 合计 1000、契约上限 800 → impl 启动前熔断，run failed', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s2-cap-'));
    ops.onPrompt = (target) => {
      if (target.includes('design')) writeArt(cwd, 'design', designWith({ usage: { input: 500, output: 500 }, ...contractExtra(800) }));
    };
    const run = await runToCompletion(twoNodeGraph(), cwd);
    expect(run.contract!.budget!.maxTokens).toBe(800);
    expect(run.state).toBe('failed');
    // 熔断判据回落到节点：error 一句原文，status/watch 原样带出（CLI 零改动）
    expect(run.nodes['impl']!.state).toBe('failed');
    expect(run.nodes['impl']!.error).toBe('token 预算超限（已用 1000 / 上限 800）');
    expect((run.events ?? []).some((e) => e.text.includes('预算熔断（S2）'))).toBe(true);
    // 执行点语义：impl 的 attempt 根本没起（无 prompt），后续 end 节点被跳过
    expect(ops.prompts.some((p) => p.target.includes('impl'))).toBe(false);
    expect(run.nodes['end']!.state).toBe('skipped');
    // 盘上也是这本账（persist 与广播同步）
    expect(store.getRun(run.runId)!.costLive).toEqual({ input: 500, output: 500, byNode: { design: { input: 500, output: 500 } } });
  });

  it('env 兜底上限（PF_RUN_MAX_TOKENS 注入口）：无契约也熔断；usage 破烂值静默跳过不误伤', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s2-env-'));
    const engine2 = new Engine(ops, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s2-env-data-'))), { ...OPTS, runMaxTokens: 800 });
    let implPrompted = 0;
    ops.onPrompt = (target) => {
      if (target.includes('design')) writeArt(cwd, 'design', designWith({ usage: { input: 900, output: 0 } }));
      else if (target.includes('impl')) implPrompted += 1; // 第二轮：破烂 usage 不入账
    };
    const run = await engine2.startRun(twoNodeGraph(), cwd);
    await waitFor(() => engine2.getRun(run.runId)!.state !== 'running');
    expect(run.state).toBe('failed');
    expect(implPrompted).toBe(0);
    expect(run.nodes['impl']!.error).toBe('token 预算超限（已用 900 / 上限 800）');
    // 破烂 usage（字符串）不进账：改产物重跑一单验证静默跳过
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s2-env2-'));
    const engine3 = new Engine(ops, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s2-env3-data-'))), { ...OPTS, runMaxTokens: 800 });
    ops.onPrompt = (target) => {
      if (target.includes('design')) writeArt(cwd2, 'design', designWith({ usage: { input: '999999', output: 500 } }));
      if (target.includes('impl')) writeArt(cwd2, 'impl', { summary: '实现完成' });
    };
    const r2 = await engine3.startRun(twoNodeGraph(), cwd2);
    await waitFor(() => engine3.getRun(r2.runId)!.state !== 'running');
    expect(r2.state).toBe('completed');
    expect(r2.costLive).toBeUndefined();
  });

  it('null 只警示不熔断（评审 R3）：再小的预算、全程无 usage 自报也跑得完，警示事件只发一次', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s2-null-'));
    const engine2 = new Engine(ops, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s2-null-data-'))), { ...OPTS, runMaxTokens: 1 });
    ops.onPrompt = (target) => {
      if (target.includes('design')) writeArt(cwd, 'design', designWith({ note: '没有 usage' }));
      if (target.includes('impl')) writeArt(cwd, 'impl', { summary: '实现完成' });
    };
    const run = await engine2.startRun(twoNodeGraph(), cwd);
    await waitFor(() => engine2.getRun(run.runId)!.state !== 'running');
    const fin = engine2.getRun(run.runId)!;
    expect(fin.state).toBe('completed');
    expect(fin.costLive).toBeUndefined();
    const warns = (fin.events ?? []).filter((e) => e.text.includes('预算比对失效'));
    expect(warns).toHaveLength(1); // design 落册后、impl 启动前的那一次比对
    expect(warns[0]!.text).toContain('usage 未自报');
  });

  it('实时累计跨节点累加 + persist 往返：重启（新 Engine 读盘）账本不丢', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-s2-persist-'));
    ops.onPrompt = (target) => {
      if (target.includes('design')) writeArt(cwd, 'design', designWith({ usage: { input: 100, output: 50 } }));
      if (target.includes('impl')) writeArt(cwd, 'impl', { summary: '实现完成', extra: { usage: { input: 30, output: 20 } } });
    };
    const run = await runToCompletion(twoNodeGraph(), cwd);
    expect(run.state).toBe('completed');
    expect(run.costLive).toEqual({ input: 130, output: 70, byNode: { design: { input: 100, output: 50 }, impl: { input: 30, output: 20 } } });
    // 收口账照常独立（costLive 与 cost.tokens 不冲突，口径同源同值）
    expect(run.cost!.tokens).toEqual({ input: 130, output: 70 });
    // 重启复原：新 Engine 从盘上读回，累计账一字不差
    const revived = new Engine(ops, store, OPTS).getRun(run.runId)!;
    expect(revived.costLive).toEqual(run.costLive);
  });
});

describe('v12-V2 人介入入账（验证税：放门即结算 waitMs+决策计数，落册不靠 events 推导）', () => {
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const writeImpl = (cwd: string, obj: unknown) => {
    fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.herdr/artifacts/impl.json'), JSON.stringify(obj));
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  function makeRepo(branch: string): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-repo-'));
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.email', 'pf@test.local');
    git(cwd, 'config', 'user.name', 'pf-test');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.herdr/\n');
    fs.writeFileSync(path.join(cwd, 'README.md'), '# t\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'init');
    git(cwd, 'checkout', '-b', branch);
    return cwd;
  }
  /** 停在人门上稍等一拍——保证拦/放两侧时刻差至少几毫秒，waitMs>0 断言不飘 */
  async function onGate(runId: string, nodeId = 'impl') {
    await waitFor(() => engine.isBlocked(runId, nodeId));
    await nap(15);
  }

  // —— 门一：人工检查门（拦侧本就有事件，这里锁放侧三态结算）——
  const manualGraph = () => {
    const g = serialGraph();
    g.nodes[1]!.config.checks = [{ type: 'manual', prompt: '冒烟通过？' }];
    return g;
  };
  for (const action of ['approve', 'reject', 'input'] as const) {
    it(`人工检查门 ${action} → 计数进 gates.${action}、waitMs 累进、blockedAt 放门即清`, async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
      const run = await engine.startRun(manualGraph(), cwd);
      await onGate(run.runId);
      expect(engine.getRun(run.runId)!.nodes['impl']!.blockedAt).toBeTruthy();
      await engine.approve(run.runId, 'impl', action === 'input' ? { action, text: '补一条验收口径' } : { action });
      await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
      const final = engine.getRun(run.runId)!;
      expect(final.state).toBe(action === 'reject' ? 'failed' : 'completed');
      expect(final.attention!.gates).toEqual({
        approve: action === 'approve' ? 1 : 0,
        reject: action === 'reject' ? 1 : 0,
        input: action === 'input' ? 1 : 0,
      });
      expect(final.attention!.waitMs).toBeGreaterThan(0);
      expect(final.nodes['impl']!.blockedAt).toBeUndefined();
    });
  }

  // —— 门二：验收机器门 ——
  for (const action of ['approve', 'reject', 'input'] as const) {
    it(`验收机器门 ${action} → 三态各自入账`, async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
      const g = serialGraph();
      let turn = 0;
      ops.onPrompt = () => {
        turn += 1;
        writeImpl(cwd, {
          summary: 'x',
          extra: {
            assertionResults: turn === 1
              ? [{ id: 'AC-1', status: 'fail', evidence: '缺测试' }]
              : [{ id: 'AC-1', status: 'ok', evidence: '已补测试' }],
          },
        });
      };
      const run = await engine.startRun(g, cwd);
      await onGate(run.runId);
      await engine.approve(run.runId, 'impl', action === 'input' ? { action, text: '补齐 AC-1 测试' } : { action });
      await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
      const final = engine.getRun(run.runId)!;
      expect(final.state).toBe(action === 'reject' ? 'failed' : 'completed');
      expect(final.attention!.gates[action]).toBe(1);
      expect(final.attention!.waitMs).toBeGreaterThan(0);
    });
  }

  // —— 门三：契约门（含多轮进出：input 谈完再拦，逐次累加）——
  const contractArt = (q: string) => ({
    summary: '规划完毕',
    extra: { contract: { assertions: [{ id: 'AC-1', assertion: '导出可用', verify_method: '人工核对' }], questions: [q] } },
  });
  const contractGateGraph = () => {
    const g = serialGraph();
    g.nodes[1]!.config.checks = [{ type: 'contract' }];
    return g;
  };
  it('契约门 approve / reject 各自入账', async () => {
    for (const action of ['approve', 'reject'] as const) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
      ops.onPrompt = () => writeImpl(cwd, contractArt('部署环境是哪个？'));
      const run = await engine.startRun(contractGateGraph(), cwd);
      await onGate(run.runId);
      await engine.approve(run.runId, 'impl', { action });
      await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
      const final = engine.getRun(run.runId)!;
      expect(final.state).toBe(action === 'approve' ? 'completed' : 'failed');
      expect(final.attention!.gates[action]).toBe(1);
      expect(final.attention!.waitMs).toBeGreaterThan(0);
    }
  });
  it('契约门 input 谈判→再拦→approve：同一节点多轮进出门逐次累加（input=1 且 approve=1）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    let turn = 0;
    ops.onPrompt = () => {
      turn += 1;
      writeImpl(cwd, contractArt(turn === 1 ? '部署环境是哪个？' : '（已按补充口径收敛）'));
    };
    const run = await engine.startRun(contractGateGraph(), cwd);
    await onGate(run.runId);
    await engine.approve(run.runId, 'impl', { action: 'input', text: '预算按 3 秒内出结果执行' });
    await onGate(run.runId); // 谈完回到门上：第二次进门已重写 blockedAt
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect(final.attention!.gates).toEqual({ approve: 1, reject: 0, input: 1 });
    expect(final.attention!.waitMs).toBeGreaterThan(0);
    expect((final.events ?? []).filter((e) => e.text.includes('契约门拦截'))).toHaveLength(2);
  });

  // —— 门四：分支守卫 ——
  const guardGraph = () => {
    const g = serialGraph();
    g.nodes[1]!.config.checks = [{ type: 'delivery-branch', expectBranch: 'pf/x' }];
    return g;
  };
  for (const action of ['approve', 'reject', 'input'] as const) {
    it(`分支守卫 ${action} → 三态各自入账`, async () => {
      const cwd = makeRepo('topic');
      const run = await engine.startRun(guardGraph(), cwd);
      await onGate(run.runId);
      if (action === 'input') git(cwd, 'checkout', '-b', 'pf/x'); // agent 按补充指令切了分支
      await engine.approve(run.runId, 'impl', action === 'input' ? { action, text: '切到 pf/x 再继续' } : { action });
      await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
      const final = engine.getRun(run.runId)!;
      expect(final.state).toBe(action === 'reject' ? 'failed' : 'completed');
      expect(final.attention!.gates[action]).toBe(1);
      expect(final.attention!.waitMs).toBeGreaterThan(0);
    });
  }

  // —— 补口：运行中对话框门（此前唯一拦侧无事件无时刻的门）——
  it('对话框门进入即留 approval 事件 + blockedAt；approve 放门后结算并清时刻', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'blocked'), 10);
    };
    const run = await engine.startRun(serialGraph(), cwd);
    await onGate(run.runId);
    const waiting = engine.getRun(run.runId)!;
    expect((waiting.events ?? []).some((e) => e.type === 'approval' && e.text.includes('运行中对话框拦截'))).toBe(true);
    expect(waiting.nodes['impl']!.blockedAt).toBeTruthy();
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect(final.attention!.gates.approve).toBe(1);
    expect(final.attention!.waitMs).toBeGreaterThan(0);
    expect(final.nodes['impl']!.blockedAt).toBeUndefined();
  });

  it('对话框门 input 补发一轮→再次弹框→再 approve：两轮各计一次、逐次累加', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    // 每轮 prompt 都弹框（waitForSettle 双采样采信 blocked，约 3s/轮，10s 预算内）
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'blocked'), 10);
    };
    const run = await engine.startRun(serialGraph(), cwd);
    await onGate(run.runId);
    await engine.approve(run.runId, 'impl', { action: 'input', text: '补发一轮指令' });
    await onGate(run.runId); // 同一节点第二次进门：blockedAt 已重写
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    const attn = final.attention!;
    expect(attn.gates).toEqual({ approve: 1, reject: 0, input: 1 });
    expect(attn.waitMs).toBeGreaterThan(0);
    expect((final.events ?? []).filter((e) => e.text.includes('运行中对话框拦截'))).toHaveLength(2);
  });

  // —— 存量路与红线 ——
  it('旧 run 存量路：进门时刻不可考（blockedAt 缺失）→ 只计次不加时长，绝不造数', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await engine.startRun(manualGraph(), cwd);
    await onGate(run.runId);
    engine.getRun(run.runId)!.nodes['impl']!.blockedAt = undefined; // 模拟升级前已在门上的存量 run
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.attention).toEqual({ waitMs: 0, gates: { approve: 1, reject: 0, input: 0 } });
  });

  it('取消不算放门决策：stopRun 走 waiter 直插，attention 分毫不动、blockedAt 清空', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'blocked'), 10);
    };
    const run = await engine.startRun(serialGraph(), cwd);
    await onGate(run.runId);
    engine.stopRun(run.runId);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('cancelled');
    expect(final.attention).toBeUndefined();
    expect(final.nodes['impl']!.blockedAt).toBeUndefined();
  });

  it('无人批门的普通 run：attention 整缺，读端零破坏', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.state).toBe('completed');
    expect(run.attention).toBeUndefined();
  });

  it('persist 往返：新 Engine 读盘后人介入账一字不差（waitMs/计数是落册账不是内存数）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const run = await engine.startRun(manualGraph(), cwd);
    await onGate(run.runId);
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.attention!.gates.approve).toBe(1);
    const revived = new Engine(ops, store, OPTS).getRun(run.runId)!;
    expect(revived.attention).toEqual(final.attention);
  });
});

describe('v13-S1 孤儿回收（label 反解轴 + 仅活跃认领 + 周期扫描）', () => {
  it('非活跃 runId 的 workspace（含重建后缀形/解不出的junk）被回收；在跑 run 的 workspace 不动', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const eng = new Engine(ops, store, {
      ...OPTS,
      orphanSweepMs: 0,
      worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wt-isolated-')), // 不扫本机真实 paneflow-wt
    });
    ops.promptDelayMs = 400; // 让 run 稳处 running
    const run = await eng.startRun(serialGraph(), cwd);
    ops.workspaces.set('w-dead', { label: 'paneflow-default-deadbeef', panes: new Set() });
    ops.workspaces.set('w-rebuild', { label: 'paneflow-12345678-r2', panes: new Set() });
    ops.workspaces.set('w-junk', { label: 'paneflow-nonsense-space', panes: new Set() });

    const reclaimed = await eng.recoverOrphans();
    expect([...reclaimed].sort()).toEqual(['w-dead', 'w-junk', 'w-rebuild']);
    expect(ops.closedWorkspaces).not.toContain(run.workspaceId!);
    expect(ops.workspaces.has(run.workspaceId!)).toBe(true);

    // 互斥：一轮未毕第二轮直接空手而归
    ops.promptDelayMs = 0;
    const [a, b] = await Promise.all([eng.recoverOrphans(), eng.recoverOrphans()]);
    expect(a.length + b.length).toBeLessThanOrEqual(3); // 至多一轮有动作（已回收者不再在列）

    await waitFor(() => eng.getRun(run.runId)!.state !== 'running');
    // 收口窗登记后终态自关：workspace 不残留
    expect(ops.workspaces.has(run.workspaceId!)).toBe(false);
  });

  it('终态 run（含盘上重读复活）按「仅活跃认领」被回收——旧 workspaceId 轴的隐身孤儿不再有', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.promptDelayMs = 300;
    const run = await engine.startRun(serialGraph(), cwd);
    const wsId = run.workspaceId!;
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    // 第二引擎实例从盘重读：run 已终态——残留 workspace（含重试重建后缀形）一律回收
    const revived = new Engine(ops, store, {
      ...OPTS,
      orphanSweepMs: 0,
      worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wt-isolated-')), // 不扫本机真实 paneflow-wt
    });
    expect(revived.getRun(run.runId)).toBeTruthy();
    ops.workspaces.set(wsId, { label: `paneflow-default-${run.runId}`, panes: new Set() });
    ops.workspaces.set('w-stale-ghost', { label: `paneflow-${run.runId}-r9`, panes: new Set() });
    const reclaimed = await revived.recoverOrphans();
    expect([...reclaimed].sort()).toEqual(['w-stale-ghost', wsId].sort());
  });

  it('worktree 泄漏清扫：干净目录回收、脏目录与无主目录保留（宁缺毋滥）', async () => {
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wt-root-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wt-repo-'));
    execFileSync('git', ['-C', repo, 'init', '-b', 'main']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);
    const clean = path.join(wtRoot, 'deadbeef-impl');
    const dirty = path.join(wtRoot, 'cafebabe-impl');
    const junk = path.join(wtRoot, 'not-mine');
    fs.mkdirSync(wtRoot, { recursive: true });
    execFileSync('git', ['-C', repo, 'worktree', 'add', clean, '-b', 'paneflow/deadbeef-impl']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', dirty, '-b', 'paneflow/cafebabe-impl']);
    fs.writeFileSync(path.join(dirty, 'uncommitted.txt'), 'work in progress');
    fs.mkdirSync(junk);

    const e2 = new Engine(new FakeHerdrOps(), new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wt-store-'))), {
      ...OPTS,
      orphanSweepMs: 0,
      worktreeRoot: wtRoot,
    });
    const reclaimed = await e2.recoverOrphans();
    expect(reclaimed).toEqual([]); // 没有 workspace 可回收不碍着 worktree 账
    expect(fs.existsSync(clean)).toBe(false);
    expect(fs.existsSync(dirty)).toBe(true);
    expect(fs.existsSync(junk)).toBe(true);
  });
});

describe('v13-B3 分支与目录生命周期（回收分支半笔入账 + 脏保留进 events + 档案覆写根）', () => {
  // 真 git 仓 + 同仓并发 fanout（生产路：engine.runNode 撞仓锁 → createWorktree → 收口 reclaimWorktrees）
  function initRepo(prefix: string): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);
    return repo;
  }
  function siblingGraph(repo: string, name: string): DagGraph {
    return {
      version: 1,
      name,
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'fork', type: 'fanout', label: '展开', config: {} },
        { id: 'a', type: 'agent', label: '任务A', config: { agentKind: 'fake', prompt: 'A', cwd: repo } },
        { id: 'b', type: 'agent', label: '任务B', config: { agentKind: 'fake', prompt: 'B', cwd: repo } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fork' },
        { id: 'e2', source: 'fork', target: 'a' },
        { id: 'e3', source: 'fork', target: 'b' },
        { id: 'e4', source: 'a', target: 'end' },
        { id: 'e5', source: 'b', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
  }
  const reclaimEventsOf = (run: RunRecord) => (run.events ?? []).filter((e) => e.text.includes('worktree 回收'));
  // 钩子先于 startRun 装好（startRun 只是点火，b 的 prompt 可能同轮就发）：worktree 目录是
  // createWorktree 里 `git worktree add` 同步建出来的——目录一出现（=名字以 -b 结尾出现在
  // 默认根下）就对它做给定动作，不依赖 runId 时序
  const tamperBWorktree = (fn: (wt: string) => void): (() => boolean) => {
    let done = false;
    ops.onPrompt = () => {
      if (done) return;
      let names: string[];
      try {
        names = fs.readdirSync(path.join(dataDir, 'worktrees'));
      } catch {
        return; // 根还不存在=没人建过 worktree
      }
      const hit = names.find((n) => n.endsWith('-b'));
      if (hit) {
        done = true;
        fn(path.join(dataDir, 'worktrees', hit));
      }
    };
    return () => done;
  };

  it('脏保留进账：worktree 有未提交变更 → 分支名与目录路径都进 events（不再只有一行 console.warn），状态判定零改动', async () => {
    const repo = initRepo('pf-b3-dirty-');
    const did = tamperBWorktree((wt) => fs.writeFileSync(path.join(wt, 'wip.txt'), '未提交的工作'));
    const run = await engine.startRun(siblingGraph(repo, 'b3-dirty'), repo);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(did()).toBe(true);
    expect(final.state).toBe('completed'); // 只披露不拦：脏保留不碰收口判定
    const wtPath = final.nodes['b']!.worktree!;
    expect(fs.existsSync(wtPath)).toBe(true); // 目录保留（成果证据链）
    const evs = reclaimEventsOf(final);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.text).toContain('未提交变更');
    expect(evs[0]!.text).toContain('保留待人工定夺');
    expect(evs[0]!.text).toContain(wtPath); // 路径进账
    expect(evs[0]!.text).toContain(`paneflow/${run.runId}-b`); // 分支名进账
    // 幂等兜底：同单不重复落账（reclaim 后再来的重复调用无登记可记）
    expect(evs.filter((e) => e.text.includes(wtPath))).toHaveLength(1);
  });

  it('分支未合并是读数不是失败：目录照删、git branch -d 被拒不重试不强删，事件带分支名如实写「保留待人工定夺」', async () => {
    const repo = initRepo('pf-b3-unmerged-');
    // 在 b 的 worktree 里提交一笔不合回主支 → 收口时目录干净可删，但分支 -d 必被拒
    const did = tamperBWorktree((wt) => {
      fs.writeFileSync(path.join(wt, 'feature.txt'), 'done');
      execFileSync('git', ['-C', wt, 'add', '-A']);
      execFileSync('git', ['-C', wt, 'commit', '-m', '未合并的工作']);
    });
    const run = await engine.startRun(siblingGraph(repo, 'b3-unmerged'), repo);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(did()).toBe(true);
    expect(final.state).toBe('completed'); // -d 被拒同样不碰收口判定
    const wtPath = final.nodes['b']!.worktree!;
    expect(fs.existsSync(wtPath)).toBe(false); // 目录已回收
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'paneflow/*']).toString();
    expect(branches).toContain(`paneflow/${run.runId}-b`); // 分支保留（未合并）
    const evs = reclaimEventsOf(final);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.text).toContain('未合并，保留待人工定夺');
    expect(evs[0]!.text).toContain(`paneflow/${run.runId}-b`);
  });

  it('空间档案 worktreeRoot 覆写生效：该空间的 worktree 落覆写根（消费现场=起单后建 worktree 时读档案）', async () => {
    const repo = initRepo('pf-b3-ovr-');
    const ovrRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-b3-ovr-root-')), 'wt');
    const sp = new Store(dataDir, 'ovr');
    sp.writeProfile({ ...sp.readProfile(), worktreeRoot: ovrRoot });
    const run = await engine.startRun(siblingGraph(repo, 'b3-ovr'), repo, 'ovr');
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    const wtPath = final.nodes['b']!.worktree!;
    expect(wtPath.startsWith(ovrRoot + path.sep)).toBe(true);
    // 默认根没被顺手造出来——覆写赢在唯一取材处
    expect(fs.existsSync(path.join(dataDir, 'worktrees'))).toBe(false);
    // 回收账照常（覆写根下 reclaim 逻辑同一把尺）
    expect(reclaimEventsOf(final)[0]!.text).toContain('已删除');
  });

  it('泄漏清扫覆盖覆写根：档案声明的根里的无主残留同样被扫；默认根空壳才删（用户的根不替人删）', async () => {
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-b3-sweep-'));
    const repo = initRepo('pf-b3-sweep-repo-');
    const clean = path.join(wtRoot, 'deadbeef-impl');
    const dirty = path.join(wtRoot, 'cafebabe-impl');
    execFileSync('git', ['-C', repo, 'worktree', 'add', clean, '-b', 'paneflow/deadbeef-impl']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', dirty, '-b', 'paneflow/cafebabe-impl']);
    fs.writeFileSync(path.join(dirty, 'uncommitted.txt'), 'work in progress');
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-b3-sweep-store-'));
    const sp = new Store(data, 'swept');
    sp.writeProfile({ ...sp.readProfile(), worktreeRoot: wtRoot });
    const e2 = new Engine(new FakeHerdrOps(), new Store(data), { ...OPTS, orphanSweepMs: 0 });
    const reclaimed = await e2.recoverOrphans();
    expect(reclaimed).toEqual([]);
    expect(fs.existsSync(clean)).toBe(false); // 覆写根里的干净残留被回收
    expect(fs.existsSync(dirty)).toBe(true); // 脏的照旧保留
    expect(fs.existsSync(wtRoot)).toBe(true); // 覆写根=用户点名的目录，空不空都不替人删壳
    // v13-B3 分支半笔的孤儿侧：目录名即 `paneflow/<name>` 的取材处，删了目录就要删分支，
    // 否则清扫只把 N3 账从「目录只增不减」挪成「分支只增不减」
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'paneflow/*']).toString();
    expect(branches).not.toContain('paneflow/deadbeef-impl'); // 已合并（与 main 同尖）→ -d 放行
    expect(branches).toContain('paneflow/cafebabe-impl'); // 脏目录保留时分支一并不动
  });

  it('现网零回归：不带 repo/worktree 的存量单一条回收账都不多', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-b3-plain-'));
    const run = await runToCompletion(serialGraph(), cwd);
    expect(run.state).toBe('completed');
    expect(reclaimEventsOf(run)).toHaveLength(0);
    expect((run.events ?? []).some((e) => e.text.includes('worktree'))).toBe(false);
  });
});

describe('v13-S6 优雅停机（engine.shutdown：掐 agent→关 workspace→flush 账本）', () => {
  it('在飞单就地结算落册：failed+节点带因+workspace 关闭+盘上往返一致', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const eng = new Engine(ops, store, {
      ...OPTS,
      orphanSweepMs: 0,
      worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wt-isolated-')),
    });
    ops.promptDelayMs = 5_000; // 节点卡在 working，等停机处置
    const run = await eng.startRun(serialGraph(), cwd);
    const wsId = run.workspaceId!;
    await waitFor(() => eng.getRun(run.runId)!.state === 'running');

    await eng.shutdown('测试信号');
    const dead = eng.getRun(run.runId)!;
    expect(dead.state).toBe('failed');
    expect(dead.finishedAt).toBeTruthy();
    expect(dead.events?.at(-1)?.text).toContain('服务退出');
    expect(ops.closedWorkspaces).toContain(wsId);
    // flush 账本：新引擎从盘重读，终态一字不差
    const revived = new Engine(ops, store, { ...OPTS, orphanSweepMs: 0, worktreeRoot: path.join(os.tmpdir(), 'pf-wt-none-') });
    expect(revived.getRun(run.runId)!.state).toBe('failed');
    expect(revived.getRun(run.runId)!.nodes['impl']!.error).toContain('服务退出');
    // 幂等：再停一次不动已终态的单
    await eng.shutdown('第二次');
    expect(eng.getRun(run.runId)!.events?.filter((e) => e.text.includes('服务退出'))).toHaveLength(1);
  });
});

describe('v13-S2 尝试边界掐断（interruptAttemptAgent 三触发点 + reconcile not_found 判据）', () => {
  it('触发点 (a) waitForSettle 收敛超时：先掐旧 agent（escape→ctrl+c）再判失败，落册 settle-timeout（轮次/触发/实读状态）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = (target) => ops.setStatus(target, 'working'); // 永不收敛，只等超时路
    const run = await runToCompletion(serialGraph(), cwd);
    const rec = run.nodes['impl']!;
    expect(run.state).toBe('failed');
    expect(rec.abandonments).toHaveLength(1);
    const ab = rec.abandonments![0]!;
    expect(ab.trigger).toBe('settle-timeout');
    expect(ab.attempt).toBe(1);
    expect(ab.agentStatus).toBe('working'); // 掐断现场实读，不是估算
    expect(ab.agentName).toBe(rec.agentName);
    const name = rec.agentName!;
    expect(ops.sentKeys.filter((s) => s.target === name).map((s) => s.keys.join('+'))).toEqual([
      'escape',
      'ctrl+c',
    ]);
  });

  it('触发点 (b) 进入重试：下一轮起窗（startAgent/prompt）之前旧尝试已被掐，落册 retry', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const g = serialGraph();
    g.nodes[1]!.config.retryCount = 1;
    let prompts = 0;
    let keysSeenAtSecondPrompt = -1;
    ops.onPrompt = (target) => {
      prompts += 1;
      if (prompts === 1) {
        // 快速失败路（非 settle 超时）：agent 活着working、prompt 提交即炸——只有 (b) 能掐它
        ops.setStatus(target, 'working');
        throw new Error('prompt 提交即炸（模拟 herdr 判杀）');
      }
      keysSeenAtSecondPrompt = ops.sentKeys.length; // 此刻（第二轮已起 agent 并再次提交）掐断键必须已送达
    };
    const run = await runToCompletion(g, cwd);
    expect(run.state).toBe('completed');
    const rec = run.nodes['impl']!;
    expect(rec.attempts).toBe(2);
    expect(rec.abandonments).toHaveLength(1);
    expect(rec.abandonments![0]!.trigger).toBe('retry');
    expect(rec.abandonments![0]!.attempt).toBe(1);
    expect(rec.abandonments![0]!.agentStatus).toBe('working');
    expect(ops.starts).toHaveLength(2);
    expect(keysSeenAtSecondPrompt).toBe(2); // escape+ctrl+c 成对且先于第二轮 prompt
    expect(ops.sentKeys[0]!.target).toBe(ops.starts[0]!.name); // 掐的是上一轮的 agent
  });

  it('触发点 (c) stopRun：掐断收编进共用函数（键序列与旧内联一致）落册 stop，回收 workspace 行为不退化', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = (target) => ops.setStatus(target, 'working'); // 永不 settle：保持 running
    const run = await engine.startRun(serialGraph(), cwd);
    await waitFor(() => run.nodes['impl']!.state === 'working');
    const rec = run.nodes['impl']!;
    const name = rec.agentName!;
    expect(engine.stopRun(run.runId)).toBe(true);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    await waitFor(() => (rec.abandonments?.length ?? 0) >= 1); // 掐断在 stopRun 返回后异步落账
    expect(run.state).toBe('cancelled');
    expect(ops.closedWorkspaces).toContain(run.workspaceId);
    // 键序列与旧内联实现同款：escape → ctrl+c
    expect(ops.sentKeys.filter((s) => s.target === name).map((s) => s.keys.join('+'))).toEqual([
      'escape',
      'ctrl+c',
    ]);
    const stops = rec.abandonments!.filter((a) => a.trigger === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.attempt).toBe(1);
    // 取消不再触发超时/重试的额外掐断（幂等 + cancels 短路）：整账就这一笔
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.abandonments).toHaveLength(1);
  });

  it('尝试内幂等：(a) 掐过后进入重试不双发键不双落账（settle-timeout 一笔），run 照常经重试收绿', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const g = serialGraph();
    g.nodes[1]!.config.retryCount = 1;
    let prompts = 0;
    ops.onPrompt = (target) => {
      prompts += 1;
      if (prompts === 1) ops.setStatus(target, 'working'); // 第一轮超时被掐，随后进入重试
    };
    const run = await runToCompletion(g, cwd);
    expect(run.state).toBe('completed');
    const rec = run.nodes['impl']!;
    expect(rec.attempts).toBe(2);
    expect(rec.abandonments).toHaveLength(1); // 同一轮两个触发点只落一笔
    expect(rec.abandonments![0]!.trigger).toBe('settle-timeout');
    const name1 = ops.starts[0]!.name;
    expect(ops.sentKeys.filter((s) => s.target === name1)).toHaveLength(2); // escape+ctrl+c，不是翻倍的四发
  });

  it('reconcile 判据：判别读出「gone」（生产路=herdr 明确回 not_found 码，见 herdr-ops.test.ts）才判「agent 已没」→ 掐断并落册 agent-gone（状态读不到记 unknown，绝不估算）', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = (target) => ops.setStatus(target, 'working');
    const run = await engine.startRun(serialGraph(), cwd);
    const rec = run.nodes['impl']!;
    await waitFor(() => rec.state === 'working' && Boolean(rec.agentName));
    ops.goneAgents.add(rec.agentName!);
    await engine.reconcile();
    expect(rec.abandonments).toHaveLength(1);
    expect(rec.abandonments![0]!.trigger).toBe('agent-gone');
    expect(rec.abandonments![0]!.attempt).toBe(1);
    expect(rec.abandonments![0]!.agentStatus).toBe('unknown');
    expect(rec.state).toBe('working'); // 对账只掐断落账，不越权改节点状态（收敛归主循环）
    // 取消收尾，不给测试留活体循环
    engine.stopRun(run.runId);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
  });

  it('reconcile 三态里的 null（没答上话：传输错/超时/破烂应答，生产路同样映成 null）一律不判：不掐、不落账、不发键', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    ops.onPrompt = (target) => ops.setStatus(target, 'working');
    const run = await engine.startRun(serialGraph(), cwd);
    const rec = run.nodes['impl']!;
    await waitFor(() => rec.state === 'working' && Boolean(rec.agentName));
    const orig = ops.probeAgent.bind(ops);
    try {
      ops.probeAgent = async () => null; // 旧「两轮 null」式含糊读数正是本判据要否掉的形态
      await engine.reconcile();
      await engine.reconcile();
    } finally {
      ops.probeAgent = orig;
    }
    expect(rec.abandonments).toBeUndefined();
    expect(ops.sentKeys).toHaveLength(0);
    engine.stopRun(run.runId);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
  });

  it('S6 停机序列复用掐断共用函数：在飞节点除旧裸 escape 外还落 shutdown 触发账', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    const eng = new Engine(ops, store, {
      ...OPTS,
      orphanSweepMs: 0,
      worktreeRoot: path.join(os.tmpdir(), 'pf-wt-none-'),
    });
    ops.onPrompt = (target) => ops.setStatus(target, 'working');
    const run = await eng.startRun(serialGraph(), cwd);
    await waitFor(() => eng.getRun(run.runId)!.nodes['impl']!.state === 'working');
    await eng.shutdown('测试信号');
    const rec = eng.getRun(run.runId)!.nodes['impl']!;
    expect(rec.abandonments?.some((a) => a.trigger === 'shutdown')).toBe(true);
    expect(ops.closedWorkspaces).toContain(run.workspaceId);
  });
});

describe('v13-S4 门到期 fail-closed + 外解唤醒', () => {
  /** 每轮 prompt 都弹框：working→(10ms)blocked——对话框门（门一）停在人身上 */
  const alwaysBlocked = () => {
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'blocked'), 10);
    };
  };

  // —— 解析链纯函数矩阵（口径逐字照 resolveTokenCap 的测试形态）——
  it('resolveGateTimeoutMs：契约 > env > 缺省关；0/负数/NaN/破烂=该级关闭', () => {
    const c = (ms?: number) => ({ assertions: [], questions: [], source: 'input' as const, budget: ms === undefined ? undefined : { gateTimeoutMs: ms } });
    expect(resolveGateTimeoutMs(c(500), 900)).toBe(500); // 契约优先
    expect(resolveGateTimeoutMs(c(0), 900)).toBe(900); // 契约 0=关闭，落到 env
    expect(resolveGateTimeoutMs(c(-5), 900)).toBe(900); // 契约破烂=关闭
    expect(resolveGateTimeoutMs(c(NaN), 900)).toBe(900);
    expect(resolveGateTimeoutMs(undefined, 900)).toBe(900); // env 兜底
    expect(resolveGateTimeoutMs(c(500), 0)).toBe(500);
    expect(resolveGateTimeoutMs(undefined, 0)).toBeNull(); // 两级都无效=整体不武装
    expect(resolveGateTimeoutMs(undefined, undefined)).toBeNull();
    expect(resolveGateTimeoutMs(c(500), undefined)).toBe(500);
  });

  it('gateTimeoutMessage 固定句式：等待审批超时，<时长>，不放行。', () => {
    const msg = gateTimeoutMessage(5_200, 5_000);
    expect(msg).toBe('等待审批超时，已等待 5.2 秒，上限 5.0 秒，不放行。');
    expect(gateTimeoutMessage(120_000, 60_000)).toContain('2.0 分');
  });

  // —— 红线：到期绝不自动放行 ——
  it('红线·到期不放行：门超时后节点收 failed、error 固定句式、不送任何键、不入 attention', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    alwaysBlocked();
    engine = new Engine(ops, store, { ...OPTS, gateTimeoutMs: 150 });
    const run = await engine.startRun(serialGraph(), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('failed'); // watch 按红 1
    const rec = final.nodes['impl']!;
    expect(rec.state).toBe('failed');
    // 固定句式逐字锁死（时长数字随计时抖动，只锁两端模板）
    expect(rec.error).toMatch(/^等待审批超时，已等待 .+，上限 .+，不放行。$/);
    // 红线本体：到期没有放行——七路按键一次都没发（合成 reject / sendKeys 唤醒均判红）
    expect(ops.sentKeys).toHaveLength(0);
    // 到期不是人的决策：attention 分毫不动（v12-V2 红线），blockedAt 清空不残留
    expect(final.attention).toBeUndefined();
    expect(rec.blockedAt).toBeUndefined();
    // 门已除名：isBlocked 转 false，迟到的 approve 敲不上门
    expect(engine.isBlocked(run.runId, 'impl')).toBe(false);
    expect(await engine.approve(run.runId, 'impl', { action: 'approve' })).toBe(false);
    expect(final.attention).toBeUndefined();
  });

  // —— 缺省关闭：与今天完全一致 ——
  it('未武装（缺省 0=关）：门永不到期，人照常批', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    alwaysBlocked();
    const run = await engine.startRun(serialGraph(), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await new Promise((r) => setTimeout(r, 400)); // 远超上一例的 150ms 上限
    expect(engine.isBlocked(run.runId, 'impl')).toBe(true);
    expect(engine.getRun(run.runId)!.nodes['impl']!.state).toBe('blocked');
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(engine.getRun(run.runId)!.state).toBe('completed');
  });

  // —— 外解唤醒 ——
  it('外解唤醒：armed 门到期前人工放行→走现有放路 + 单记 externalRelease', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    alwaysBlocked();
    engine = new Engine(ops, store, { ...OPTS, gateTimeoutMs: 60_000 });
    const run = await engine.startRun(serialGraph(), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await new Promise((r) => setTimeout(r, 15)); // 保证 waitMs 结算非零
    expect(await engine.approve(run.runId, 'impl', { action: 'approve' })).toBe(true);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    // 现有放路一字不变：approve 的实发 enter 键仍由调用方发出（awaitGate 不碰键）
    expect(ops.sentKeys).toEqual([{ target: ops.agents.keys().next().value!, keys: ['enter'] }]);
    // 人的决策照旧入 attention（外解记账不替代它）
    expect(final.attention!.gates.approve).toBe(1);
    expect(final.attention!.waitMs).toBeGreaterThan(0);
    // externalRelease 单记：内存账 + 事件账各一笔
    expect(engine.externalReleaseCount(run.runId, 'impl')).toBe(1);
    expect(engine.externalReleaseCount(run.runId)).toBe(1);
    expect((final.events ?? []).filter((e) => e.text.includes('外解唤醒（S4）'))).toHaveLength(1);
  });

  it('未武装门的人工放行不算外解：externalRelease 零记、无事件', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    alwaysBlocked();
    const run = await engine.startRun(serialGraph(), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await engine.approve(run.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    expect(engine.externalReleaseCount(run.runId)).toBe(0);
    expect((engine.getRun(run.runId)!.events ?? []).some((e) => e.text.includes('外解唤醒'))).toBe(false);
  });

  // —— 契约优先的现场接线（进门时刻解析，与 resolveTokenCap 同款语义）——
  it('契约 budget.gateTimeoutMs 优先于注入/env：进门现场解析生效', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    alwaysBlocked();
    // env 级上限设到 10 分钟（不靠它到期）；契约 150ms 才该是真正的判据
    engine = new Engine(ops, store, { ...OPTS, gateTimeoutMs: 600_000 });
    const run = await engine.startRun(serialGraph(), cwd);
    engine.getRun(run.runId)!.contract = {
      assertions: [],
      questions: [],
      source: 'input',
      budget: { gateTimeoutMs: 150 },
    };
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('failed');
    expect(final.nodes['impl']!.error).toMatch(/^等待审批超时，.+，不放行。$/);
    expect(ops.sentKeys).toHaveLength(0);
  });

  // —— 取消路卫生回归：stopRun 插话仍按「已取消」收，绝不被判成到期或放行 ——
  it('取消唤醒优先于到期：stopRun 后 run 收 cancelled、无超时 error、attention 不动', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
    alwaysBlocked();
    engine = new Engine(ops, store, { ...OPTS, gateTimeoutMs: 5_000 });
    const run = await engine.startRun(serialGraph(), cwd);
    await waitFor(() => engine.isBlocked(run.runId, 'impl'));
    engine.stopRun(run.runId);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('cancelled');
    expect(final.nodes['impl']!.error ?? '').not.toContain('等待审批超时');
    expect(final.attention).toBeUndefined();
    expect((final.events ?? []).some((e) => e.text.includes('外解唤醒'))).toBe(false);
  });
});

// -- v13-V4 ctxSha 注入留痕：取值在注入现场、每单一枚、入漂移比对面、只披露不拦 ----------------
describe('v13-V4 engine ctxSha 注入留痕（注入现场实读集成指纹，replay 漂移只发事件不拦）', () => {
  const GW_RETRIES = 5; // 显式钉死旋钮：指纹在测试里逐字节可复算，不赌机器 env
  const ctxOpts: EngineOptions = { ...OPTS, gwThrottleRetries: GW_RETRIES };

  /** 串行 N 个 agent 节点的图（N=2 时验「多节点注入仍归一一枚指纹/一条漂移」） */
  function ctxGraph(name: string, prompts: string[]): DagGraph {
    const nodes: DagGraph['nodes'] = [{ id: 'start', type: 'start', label: '开始', config: {} }];
    const edges: DagGraph['edges'] = [];
    prompts.forEach((prompt, i) => {
      const id = `a${i + 1}`;
      nodes.push({ id, type: 'agent' as const, label: id, config: { agentKind: 'fake', prompt } });
      edges.push({ id: `e${i}`, source: i ? `a${i}` : 'start', target: id });
    });
    nodes.push({ id: 'end', type: 'end', label: '结束', config: {} });
    edges.push({ id: 'ez', source: `a${prompts.length}`, target: 'end' });
    return { version: 1, name, nodes, edges, metadata: { createdAt: '', updatedAt: '' } };
  }

  function v4Root(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-v4-'));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return root;
  }

  /** 与 harness.computeCtxSha 同款构成独立复算——「在册且可复算」里「可复算」那一半 */
  const ctxOf = (files: Record<string, string>) =>
    computeCtxSha({
      files: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, contentSha(c)])),
      gwThrottleRetries: GW_RETRIES,
      nodeTimeoutMsDefault: ctxOpts.defaultNodeTimeoutMs,
    });

  const driftEvents = (r: RunRecord) => (r.events ?? []).filter((e) => e.text.includes('harness 漂移'));

  it('①配了约定文档+技能的单：ctxSha 注入现场取值、随单落册且可复算', async () => {
    const root = v4Root({ 'conv.md': '约定甲', 'sk.md': '技能乙' });
    store.writeProfile({
      id: 'default',
      name: 'default',
      createdAt: '',
      rootCwd: root,
      rules: [{ file: 'conv.md' }],
      skills: ['sk.md'],
    });
    engine = new Engine(ops, store, ctxOpts);
    const run = await runToCompletion(ctxGraph('v4-basic', ['做A']), root);
    expect(run.state).toBe('completed');
    expect(run.harness!.ctxSha).toMatch(/^[0-9a-f]{8}$/);
    const expected = ctxOf({ [path.join(root, 'conv.md')]: '约定甲', [path.join(root, 'sk.md')]: '技能乙' });
    expect(run.harness!.ctxSha).toBe(expected);
    // 落册不只在内存：盘上记录读回同值
    expect(store.getRun(run.runId)!.harness!.ctxSha).toBe(expected);
  });

  it('②改注入面（换文件内容 / 加一个文件）→ ctxSha 必变，且仍等于现场复算', async () => {
    const root = v4Root({ 'conv.md': '约定甲', 'sk.md': '技能乙' });
    store.writeProfile({
      id: 'default',
      name: 'default',
      createdAt: '',
      rootCwd: root,
      rules: [{ file: 'conv.md' }],
      skills: ['sk.md'],
    });
    engine = new Engine(ops, store, ctxOpts);
    const r1 = await runToCompletion(ctxGraph('v4-c1', ['做A']), root);
    const sha1 = r1.harness!.ctxSha!;
    fs.writeFileSync(path.join(root, 'conv.md'), '约定甲改了一个字');
    const r2 = await runToCompletion(ctxGraph('v4-c2', ['做A']), root);
    expect(r2.harness!.ctxSha).not.toBe(sha1);
    expect(r2.harness!.ctxSha).toBe(
      ctxOf({ [path.join(root, 'conv.md')]: '约定甲改了一个字', [path.join(root, 'sk.md')]: '技能乙' }),
    );
    // 加一本技能文档（档案里多勾一项）→ 指纹再变
    fs.writeFileSync(path.join(root, 'extra.md'), '新技能');
    store.writeProfile({ ...store.readProfile(), skills: ['sk.md', 'extra.md'] });
    const r3 = await runToCompletion(ctxGraph('v4-c3', ['做A']), root);
    expect(r3.harness!.ctxSha).not.toBe(r2.harness!.ctxSha);
    expect(r3.harness!.ctxSha).toBe(
      ctxOf({
        [path.join(root, 'conv.md')]: '约定甲改了一个字',
        [path.join(root, 'sk.md')]: '技能乙',
        [path.join(root, 'extra.md')]: '新技能',
      }),
    );
  });

  it('③没配任何约定/技能：ctxSha 仍是只含两枚旋钮的确定值（正读数）；旧落册记录该键整缺不回填', async () => {
    const root = v4Root({});
    engine = new Engine(ops, store, ctxOpts);
    const run = await runToCompletion(ctxGraph('v4-empty', ['做A']), root);
    expect(run.harness!.ctxSha).toBe(ctxOf({})); // 「什么都没吃进去」也是正读数，不是 undefined
    // v13-V4 前的旧落册记录：harness 里没这键就是没有——存取不炸、读回整缺
    const legacy = {
      runId: 'oldv4rec',
      dagName: 'g',
      graph: ctxGraph('v4-empty', ['做A']),
      state: 'completed',
      cwd: root,
      nodes: {},
      startedAt: '2026-09-25T00:00:00.000Z',
      harness: { graphSha: 'x', agentKind: 'pi', readback: false, readbackOutcome: 'no-pages', skeletonSha: 'y' },
    } as unknown as RunRecord;
    store.saveRun(legacy);
    const back = store.getRun('oldv4rec')!;
    expect(back.harness).toBeDefined();
    expect('ctxSha' in back.harness!).toBe(false);
    expect(back.harness!.ctxSha).toBeUndefined();
  });

  it('④replay 注入面已变→恰好一条「harness 漂移」事件且不拦跑；未变/源侧缺键→零条', async () => {
    const root = v4Root({ 'conv.md': '约定甲' });
    store.writeProfile({ id: 'default', name: 'default', createdAt: '', rootCwd: root, rules: [{ file: 'conv.md' }] });
    engine = new Engine(ops, store, ctxOpts);
    // 两个 agent 节点各自走注入——并集归一后仍只一枚指纹、一条漂移
    const r1 = await runToCompletion(ctxGraph('v4-replay', ['做A', '做B']), root);
    expect(r1.harness!.ctxSha).toBe(ctxOf({ [path.join(root, 'conv.md')]: '约定甲' }));
    fs.writeFileSync(path.join(root, 'conv.md'), '约定甲改');
    const r2 = await engine.replayRun(r1.runId);
    expect(r2.replayOf).toBe(r1.runId);
    await waitFor(() => engine.getRun(r2.runId)!.state !== 'running');
    const back2 = engine.getRun(r2.runId)!;
    expect(back2.state).toBe('completed'); // R5：只披露不拦，单照常跑完
    const d2 = driftEvents(back2);
    expect(d2).toHaveLength(1);
    expect(d2[0]!.text).toContain('harness 漂移（V4）');
    expect(d2[0]!.text).toContain(`上下文 #${r1.harness!.ctxSha}→#${back2.harness!.ctxSha}`);
    expect(back2.harness!.ctxSha).toBe(ctxOf({ [path.join(root, 'conv.md')]: '约定甲改' }));
    // 注入面没再变：同契约复跑零漂移
    const r3 = await engine.replayRun(r2.runId);
    await waitFor(() => engine.getRun(r3.runId)!.state !== 'running');
    expect(driftEvents(engine.getRun(r3.runId)!)).toHaveLength(0);
    // 源侧缺键（v13-V4 前的旧单）：无从比对，宁缺毋假不发
    delete engine.getRun(r1.runId)!.harness!.ctxSha;
    const r4 = await engine.replayRun(r1.runId);
    await waitFor(() => engine.getRun(r4.runId)!.state !== 'running');
    const back4 = engine.getRun(r4.runId)!;
    expect(driftEvents(back4)).toHaveLength(0);
    expect(back4.harness!.ctxSha).toBeDefined(); // 比对跳过≠不留痕：本单指纹照常落册
  });
});

// -- v13-W1 角色装备槽与三轴划界：兼容带逐字节不变 + 降重量得出 + 坏引用只披露 ----------
describe('v13-W1 岗位装备槽（空间登记 / 目录作用域 / 角色装备三轴划界）', () => {
  const REGISTRY = ['sk-a.md', 'sk-b.md', 'sk-c.md'];
  const bodyOf = (f: string) => `${f} 正文开始\n${'填'.repeat(2000)}\n${f} 正文结束`;

  /** 一台项目的文档面：3 篇登记技能 + 1 篇空间家规 + 1 篇岗位专属清单 */
  function w1Root(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-w1-'));
    for (const f of REGISTRY) fs.writeFileSync(path.join(root, f), bodyOf(f));
    fs.writeFileSync(path.join(root, 'space-rule.md'), '空间家规：分支必须 pf/ 前缀');
    fs.writeFileSync(path.join(root, 'role-only.md'), '评审岗专属清单：逐条核对 AC');
    return root;
  }

  function w1Profile(root: string): void {
    store.writeProfile({
      id: 'default',
      name: 'default',
      createdAt: '',
      rootCwd: root,
      rules: [{ file: 'space-rule.md' }],
      skills: REGISTRY,
    });
  }

  /** 单 agent 节点图；tag 让多次 run 的 prompt 在 ops.prompts 里可分 */
  function w1Graph(roleId: string | undefined, tag: string): DagGraph {
    return {
      version: 1,
      name: `w1-${roleId ?? 'none'}-${tag}`,
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        {
          id: 'a',
          type: 'agent',
          label: '甲',
          config: { agentKind: 'fake', prompt: `做 ${tag}`, ...(roleId ? { role: roleId } : {}) },
        },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
  }

  const promptOf = (tag: string): string => ops.prompts.find((p) => p.text.includes(`做 ${tag}`))!.text;

  it('①兼容带：未配装备槽的角色与不绑角色的节点，注入块逐字节相同（全量现状一字不变）；装备账把「在吃全量」显出来', async () => {
    const root = w1Root();
    w1Profile(root);
    saveRoles(dataDir, [{ id: 'r-plain', name: '普通岗' }]);
    const bound = await runToCompletion(w1Graph('r-plain', '甲'), root);
    const unbound = await runToCompletion(w1Graph(undefined, '乙'), root);
    expect(bound.state).toBe('completed');
    // 唯一差异是节点自己的指令文本：上下文块本身一字不差
    expect(promptOf('甲').replace('做 甲', '@')).toBe(promptOf('乙').replace('做 乙', '@'));
    for (const f of REGISTRY) expect(promptOf('甲')).toContain(`${f} 正文开始`);
    // scope=space 是「这个岗其实在吃空间全量」的结构化落册（status 那行警告的唯一依据）
    expect(bound.nodes.a!.equip).toMatchObject({ scope: 'space', role: 'r-plain', skills: REGISTRY });
    const unEq = unbound.nodes.a!.equip!;
    expect(unEq.scope).toBe('space');
    expect(unEq.role).toBeUndefined(); // 没绑角色=没有「岗位未配装备」这回事，整键省略
  });

  it('②登记 3 篇、岗上挂 2 篇：只注这两篇且注入块按一篇文档的量降下来（G1 降重账量得出），装备账 scope=role', async () => {
    const root = w1Root();
    w1Profile(root);
    saveRoles(dataDir, [
      { id: 'r-plain', name: '普通岗' },
      { id: 'r-eq', name: '装备岗', skills: ['sk-a.md', 'sk-b.md'] },
    ]);
    const full = await runToCompletion(w1Graph('r-plain', '甲'), root);
    const armed = await runToCompletion(w1Graph('r-eq', '乙'), root);
    expect(full.state).toBe('completed');
    expect(armed.state).toBe('completed');
    const pFull = promptOf('甲');
    const pEq = promptOf('乙');
    expect(pEq).toContain('sk-a.md 正文开始');
    expect(pEq).toContain('sk-b.md 正文开始');
    expect(pEq).not.toContain('sk-c.md 正文开始');
    // 降重不是口号：少注一篇 2KB 文档，块体就得少这么多（含标签与分隔）
    expect(pFull.length - pEq.length).toBeGreaterThan(2000);
    expect(armed.nodes.a!.equip).toMatchObject({ scope: 'role', role: 'r-eq', skills: ['sk-a.md', 'sk-b.md'] });
  });

  it('③装备引用登记清单外的技能：跳过不注、unknownSkills 只披露、单照常跑完；显式 [] = 该岗一篇技能都不吃', async () => {
    const root = w1Root();
    w1Profile(root);
    saveRoles(dataDir, [
      { id: 'r-bad', name: '坏引用岗', skills: ['sk-a.md', 'ghost.md', 'gone/deep.md'] },
      { id: 'r-zero', name: '零装备岗', skills: [] },
    ]);
    const bad = await runToCompletion(w1Graph('r-bad', '甲'), root);
    expect(bad.state).toBe('completed'); // 一格坏引用不许把跑单弄红（评审 R5：只披露不拦）
    const eqBad = bad.nodes.a!.equip!;
    expect(eqBad.scope).toBe('role');
    expect(eqBad.skills).toEqual(['sk-a.md']);
    expect(eqBad.unknownSkills).toEqual(['ghost.md', 'gone/deep.md']);
    expect(promptOf('甲')).toContain('sk-a.md 正文开始');
    expect(promptOf('甲')).not.toContain('ghost.md');
    expect(promptOf('甲')).not.toContain('gone/deep.md');
    const zero = await runToCompletion(w1Graph('r-zero', '乙'), root);
    const eqZero = zero.nodes.a!.equip!;
    expect(eqZero).toMatchObject({ scope: 'role', role: 'r-zero' });
    expect(eqZero.skills).toEqual([]); // 空数组是正读数：确实一篇都没注
    expect(promptOf('乙')).not.toContain('技能库');
    expect(promptOf('乙')).toContain('空间家规：'); // 空间轴家规照守——降的是技能面，不是家规
  });

  it('④岗位文档槽=命中规则 ∪ 角色 rules（同路径只注一份）；换装备必换 ctxSha（V4 注入面自此可证）', async () => {
    const root = w1Root();
    w1Profile(root);
    saveRoles(dataDir, [
      { id: 'r-plain', name: '普通岗' },
      { id: 'r-rev', name: '评审岗', skills: ['sk-a.md'], rules: ['space-rule.md', 'role-only.md'] },
    ]);
    const plain = await runToCompletion(w1Graph('r-plain', '甲'), root);
    const rev = await runToCompletion(w1Graph('r-rev', '乙'), root);
    const pRev = promptOf('乙');
    expect(pRev.match(/空间家规：/g)).toHaveLength(1); // 空间轴已有的一篇不注第二遍
    expect(pRev).toContain('评审岗专属清单：');
    expect(rev.nodes.a!.equip).toMatchObject({
      scope: 'role',
      role: 'r-rev',
      skills: ['sk-a.md'],
      rules: ['space-rule.md', 'role-only.md'],
    });
    // 换装备=换注入面：ctxSha 不等（改装备不再是查不出的暗改）
    expect(rev.harness!.ctxSha).toBeDefined();
    expect(rev.harness!.ctxSha).not.toBe(plain.harness!.ctxSha);
  });

  it('⑤v14-A5-5b 装备槽写 {kind,id}：注的是条目 spec.file；挂在别的项目的条目不注、只披露', async () => {
    const root = w1Root();
    w1Profile(root);
    const reg = new RegistryStore(dataDir);
    const add = (raw: Record<string, unknown>): string => {
      const r = reg.add(raw);
      if (!r.ok || !r.entry) throw new Error(`fixture 登记失败：${r.why ?? '没回条目'}`);
      return r.entry.id;
    };
    const here = add({ kind: 'skill', name: 'deploy', spec: { space: 'default', file: 'sk-b.md' } });
    const elsewhere = add({ kind: 'skill', name: 'elsewhere', spec: { space: 'other', file: 'sk-c.md' } });
    const checklist = add({ kind: 'rule', name: 'rolecheck', spec: { space: 'default', file: 'role-only.md' } });
    saveRoles(dataDir, [
      { id: 'r-pin', name: '定点岗', skills: [{ kind: 'skill', id: here }, 'sk-a.md'], rules: [{ kind: 'rule', id: checklist }] },
      { id: 'r-cross', name: '跨项目岗', skills: [{ kind: 'skill', id: elsewhere }] },
    ]);

    const pinned = await runToCompletion(w1Graph('r-pin', '甲'), root);
    expect(pinned.state).toBe('completed');
    const pEq = pinned.nodes.a!.equip!;
    // 注进 prompt 的是条目指向的那篇文档原文；装备账落的是**解析出的路径**（引用对象本身不进注入清单）
    expect(promptOf('甲')).toContain('sk-b.md 正文开始');
    expect(promptOf('甲')).toContain('sk-a.md 正文开始');
    expect(promptOf('甲')).toContain('评审岗专属清单：');
    expect(pEq.skills).toEqual(['sk-b.md', 'sk-a.md']);
    expect(pEq.rules).toEqual(['space-rule.md', 'role-only.md']); // 空间轴那篇照守——装备槽降的是技能面，不是家规
    expect(pEq.unknownSkills).toBeUndefined();
    expect(pEq.unknownRules).toBeUndefined();

    // 别的项目登记的条目：`spec.file` 按本单主仓根读就是跨根读——不注，但那一句要在账上
    const cross = await runToCompletion(w1Graph('r-cross', '乙'), root);
    expect(cross.state).toBe('completed'); // 一格落不了地的引用不许把跑单弄红（评审 R5：只披露不拦）
    const cEq = cross.nodes.a!.equip!;
    expect(cEq.skills).toEqual([]);
    expect(cEq.unknownSkills).toEqual([elsewhere]);
    expect(promptOf('乙')).not.toContain('sk-c.md 正文开始');
  });
});

// -- v13-W2 角色指纹与上岗：roleSha/injectedBytes 落在注入现场 + 名册机检只披露不拦 ----------
describe('v13-W2 角色指纹与上岗（roleSha 换装备必变/同装备必等 · injectedBytes 现算可比 · 名册外只警告）', () => {
  const REGISTRY = ['sk-a.md', 'sk-b.md', 'sk-c.md'];
  const bodyOf = (f: string) => `${f} 正文开始\n${'填'.repeat(2000)}\n${f} 正文结束`;

  /** 与 W1 同款一台项目：3 篇登记技能 + 1 篇空间家规 + 1 篇岗位专属清单 */
  function w2Root(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-w2-'));
    for (const f of REGISTRY) fs.writeFileSync(path.join(root, f), bodyOf(f));
    fs.writeFileSync(path.join(root, 'space-rule.md'), '空间家规：分支必须 pf/ 前缀');
    fs.writeFileSync(path.join(root, 'role-only.md'), '评审岗专属清单：逐条核对 AC');
    return root;
  }

  function w2Profile(root: string, extra: Record<string, unknown> = {}): void {
    store.writeProfile({
      id: 'default',
      name: 'default',
      createdAt: '',
      rootCwd: root,
      rules: [{ file: 'space-rule.md' }],
      skills: REGISTRY,
      ...extra,
    });
  }

  /** N 个 agent 节点的串行图；每格可带 tag（在 ops.prompts 里认人）与 role */
  function w2Graph(name: string, nodes: { tag: string; role?: string }[]): DagGraph {
    const list: DagGraph['nodes'] = [{ id: 'start', type: 'start', label: '开始', config: {} }];
    const edges: DagGraph['edges'] = [];
    nodes.forEach((n, i) => {
      const id = `a${i + 1}`;
      list.push({
        id,
        type: 'agent' as const,
        label: id,
        config: { agentKind: 'fake', prompt: `做 ${n.tag}`, ...(n.role ? { role: n.role } : {}) },
      });
      edges.push({ id: `e${i}`, source: i ? `a${i}` : 'start', target: id });
    });
    list.push({ id: 'end', type: 'end', label: '结束', config: {} });
    edges.push({ id: 'ez', source: `a${nodes.length}`, target: 'end' });
    return { version: 1, name, nodes: list, edges, metadata: { createdAt: '', updatedAt: '' } };
  }

  /** 从实发 prompt 里切出「注入现场喂进去的那一截上下文块」——injectedBytes 的独立现算口径 */
  const injectedSliceOf = (tag: string): string => {
    const text = ops.prompts.find((p) => p.text.includes(`做 ${tag}`))!.text;
    return text.slice(0, text.indexOf(`做 ${tag}`));
  };
  const rosterEvents = (r: RunRecord) => (r.events ?? []).filter((e) => e.text.includes('班底名册外'));

  it('①换装备=换 roleSha、同装备同岗重跑=同 roleSha（岗位级 A/B 零新机制复用，判据外延自 V2）；文档内容改算 ctxSha 的账', async () => {
    const root = w2Root();
    w2Profile(root);
    saveRoles(dataDir, [{ id: 'r-arm', name: '装备岗', skills: ['sk-a.md'] }]);
    const r1 = await runToCompletion(w2Graph('w2-arm', [{ tag: '甲', role: 'r-arm' }]), root);
    expect(r1.state).toBe('completed');
    const eq1 = r1.nodes.a1!.equip!;
    expect(eq1.skills).toEqual(['sk-a.md']);
    // 在册值 = 拿现场装备账现算的值（可复算，不是随手一串随机位）
    expect(r1.harness!.roleSha).toBe(computeRoleSha([eq1]));
    // 真落盘：从盘上读回同一枚（harness 不是只在内存里活着的摆设）
    const reloaded = store.getRun(r1.runId)!;
    expect(reloaded.harness!.roleSha).toBe(r1.harness!.roleSha);
    expect(reloaded.harness!.injectedBytes).toBe(r1.harness!.injectedBytes);
    // 同岗同装备再发一单：指纹必等
    const r2 = await runToCompletion(w2Graph('w2-arm', [{ tag: '乙', role: 'r-arm' }]), root);
    expect(r2.harness!.roleSha).toBe(r1.harness!.roleSha);
    // 文档内容改了（吃了什么变没变=ctxSha 的账）：roleSha 不跟着抖，「同装备=同指纹」不被编辑噪声破
    fs.writeFileSync(path.join(root, 'sk-a.md'), `${bodyOf('sk-a.md')}\n补了一段做法`);
    const r3 = await runToCompletion(w2Graph('w2-arm', [{ tag: '丙', role: 'r-arm' }]), root);
    expect(r3.harness!.roleSha).toBe(r1.harness!.roleSha);
    expect(r3.harness!.ctxSha).toBeDefined();
    expect(r3.harness!.ctxSha).not.toBe(r1.harness!.ctxSha);
    // 岗上多挂一篇装备 → 指纹必变（换装备自此是查得出的改动）
    saveRoles(dataDir, [{ id: 'r-arm', name: '装备岗', skills: ['sk-a.md', 'sk-b.md'] }]);
    const r4 = await runToCompletion(w2Graph('w2-arm', [{ tag: '丁', role: 'r-arm' }]), root);
    expect(r4.harness!.roleSha).not.toBe(r3.harness!.roleSha);
    expect(r4.harness!.roleSha).toBe(computeRoleSha([r4.nodes.a1!.equip!]));
    // 同一批装备挂在另一岗：角色身份入指纹，照样变
    saveRoles(dataDir, [
      { id: 'r-arm', name: '装备岗', skills: ['sk-a.md', 'sk-b.md'] },
      { id: 'r-other', name: '另一岗', skills: ['sk-a.md', 'sk-b.md'] },
    ]);
    const r5 = await runToCompletion(w2Graph('w2-other', [{ tag: '戊', role: 'r-other' }]), root);
    expect(r5.harness!.roleSha).not.toBe(r4.harness!.roleSha);
    // 同一岗挂在两个节点上：按条目去重，不重复记账（多节点同岗=同一格账）
    const r6 = await runToCompletion(w2Graph('w2-two', [{ tag: '己', role: 'r-arm' }, { tag: '庚', role: 'r-arm' }]), root);
    expect(r6.harness!.roleSha).toBe(r4.harness!.roleSha);
    // 装备槽里的坏引用变了（虽不注入）也是配置变了：入指纹，只披露不拦
    saveRoles(dataDir, [{ id: 'r-bad', name: '坏引用岗', skills: ['sk-a.md', 'ghost.md'] }]);
    const r7 = await runToCompletion(w2Graph('w2-bad', [{ tag: '辛', role: 'r-bad' }]), root);
    expect(r7.state).toBe('completed');
    expect(r7.nodes.a1!.equip!.unknownSkills).toEqual(['ghost.md']);
    const r8 = await runToCompletion(w2Graph('w2-bad2', [{ tag: '壬', role: 'r-bad' }]), root);
    expect(r8.harness!.roleSha).toBe(r7.harness!.roleSha);
    saveRoles(dataDir, [{ id: 'r-bad', name: '坏引用岗', skills: ['sk-a.md', 'gone.md'] }]);
    const r9 = await runToCompletion(w2Graph('w2-bad3', [{ tag: '癸', role: 'r-bad' }]), root);
    expect(r9.harness!.roleSha).not.toBe(r7.harness!.roleSha);
  });

  it('②injectedBytes 与实发注入块逐字节一致（UTF-8 字节不是字符数；多节点求和；一个字没注=正读数 0）', async () => {
    const root = w2Root();
    w2Profile(root);
    saveRoles(dataDir, [{ id: 'r-arm', name: '装备岗', skills: ['sk-a.md', 'sk-b.md'] }]);
    const run = await runToCompletion(
      w2Graph('w2-bytes', [{ tag: '甲', role: 'r-arm' }, { tag: '乙', role: 'r-arm' }]),
      root,
    );
    expect(run.state).toBe('completed');
    const b1 = Buffer.byteLength(injectedSliceOf('甲'), 'utf8');
    const b2 = Buffer.byteLength(injectedSliceOf('乙'), 'utf8');
    expect(b1).toBeGreaterThan(0);
    expect(run.harness!.injectedBytes).toBe(b1 + b2);
    // 中文按字节算：块里 2×2000 个「填」= 6000+ 字节，字符数口径必然对不上
    expect(b1).toBeGreaterThan(4000);
    // 降重账量得出：只挂一篇技能的岗，注入字节比吃全量的岗明显小
    saveRoles(dataDir, [{ id: 'r-one', name: '单篇岗', skills: ['sk-a.md'] }]);
    const lean = await runToCompletion(w2Graph('w2-lean', [{ tag: '丙', role: 'r-one' }]), root);
    expect(Buffer.byteLength(injectedSliceOf('丙'), 'utf8')).toBe(lean.harness!.injectedBytes);
    expect(lean.harness!.injectedBytes!).toBeLessThan(b1);
    // 整单没东西可注：0 是正读数（与「整键缺失」分家）
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-w2-empty-'));
    store.writeProfile({ id: 'default', name: 'default', createdAt: '', rootCwd: emptyRoot });
    const bare = await runToCompletion(w2Graph('w2-bare', [{ tag: '丁' }]), emptyRoot);
    expect(bare.state).toBe('completed');
    expect(bare.harness!.injectedBytes).toBe(0);
    expect(bare.harness!.roleSha).toBeDefined(); // 吃了零也是解析过装备的（空数组正读数）
  });

  it('③旧形状单（未配槽角色 / 无 role 存量图）跑单照旧绿，装备账不显示成零装备；旧落册记录两键整缺不回填', async () => {
    const root = w2Root();
    w2Profile(root);
    saveRoles(dataDir, [{ id: 'r-plain', name: '普通岗' }]);
    const unbound = await runToCompletion(w2Graph('w2-unbound', [{ tag: '甲' }]), root);
    const plain = await runToCompletion(w2Graph('w2-plain', [{ tag: '乙', role: 'r-plain' }]), root);
    expect(unbound.state).toBe('completed');
    expect(plain.state).toBe('completed');
    for (const r of [unbound, plain]) {
      const eq = r.nodes.a1!.equip!;
      expect(eq.scope).toBe('space');
      expect(eq.skills).toEqual(REGISTRY); // 全量正读数——「没配槽」绝不是零装备
      expect(r.harness!.roleSha).toBe(computeRoleSha([eq]));
    }
    // 未绑角色与绑了未配槽角色是两格账（角色身份入指纹），但都吃全量
    expect(unbound.harness!.roleSha).not.toBe(plain.harness!.roleSha);
    // v13-W2 前的旧落册记录：没这两键就是没有——存取不炸、读回整缺（宁缺毋假不回填）
    const legacy = {
      runId: 'oldw2rec',
      dagName: 'g',
      graph: w2Graph('w2-legacy', [{ tag: '丙' }]),
      state: 'completed',
      cwd: root,
      nodes: {},
      startedAt: '2026-09-25T00:00:00.000Z',
      harness: { graphSha: 'x', agentKind: 'pi', readback: false, readbackOutcome: 'no-pages', ctxSha: 'cx' },
    } as unknown as RunRecord;
    store.saveRun(legacy);
    const back = store.getRun('oldw2rec')!;
    expect(back.harness).toBeDefined();
    expect('roleSha' in back.harness!).toBe(false);
    expect('injectedBytes' in back.harness!).toBe(false);
  });

  it('④名册机检：有班底 run 里名册外的 role 只出 warning 事件且单照跑完；名册内/没配班底 → 零条', async () => {
    const root = w2Root();
    saveRoles(dataDir, [
      { id: 'r-in', name: '在册岗', skills: ['sk-a.md'] },
      { id: 'r-out', name: '黑户岗', skills: ['sk-a.md'] },
    ]);
    w2Profile(root, { team: [{ roleId: 'r-in', alias: '在册别名' }] });
    const off = await runToCompletion(w2Graph('w2-roster-off', [{ tag: '甲', role: 'r-out' }]), root);
    expect(off.state).toBe('completed'); // 只披露不拦（评审 R5）：这单照绿
    const warn = rosterEvents(off);
    expect(warn).toHaveLength(1);
    expect(warn[0]!.text).toContain('班底名册外');
    expect(warn[0]!.text).toContain('节点 a1 点的岗「r-out」不在本空间班底名册');
    // 在册岗：零条
    const on = await runToCompletion(w2Graph('w2-roster-on', [{ tag: '乙', role: 'r-in' }]), root);
    expect(on.state).toBe('completed');
    expect(rosterEvents(on)).toHaveLength(0);
    // 没配班底（存量模板的正身）：随便点岗也零条，不许变红
    w2Profile(root);
    const noTeam = await runToCompletion(w2Graph('w2-roster-none', [{ tag: '丙', role: 'r-out' }]), root);
    expect(noTeam.state).toBe('completed');
    expect(rosterEvents(noTeam)).toHaveLength(0);
    // 不绑角色的节点也不报（没岗就谈不上「岗欠编制」）
    const unbound = await runToCompletion(w2Graph('w2-roster-unbound', [{ tag: '丁' }]), root);
    expect(rosterEvents(unbound)).toHaveLength(0);
    expect(unbound.state).toBe('completed');
  });
});

// -- v13-W3 授权声明+归因+事拦：声明入 prompt（措辞诚实）· 收口对账只照不拦 · 落差结构化落册 ----------
describe('v13-W3 授权声明与收口对账（声明非强制入 prompt · 三面×副作用账落差落 declareViolations+warn 事件 · 只照不拦）', () => {
  function w3Root(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-w3-'));
    fs.writeFileSync(path.join(root, 'sk-a.md'), '装备甲 正文');
    return root;
  }
  function w3Profile(root: string): void {
    store.writeProfile({ id: 'default', name: 'default', createdAt: '', rootCwd: root, skills: ['sk-a.md'] });
  }
  /** start → N 个串行 agent 节点 → end；节点带 tag（ops.prompts 里认人）与 role，可给 timeoutMs */
  function w3Graph(
    name: string,
    nodes: { tag: string; role?: string; timeoutMs?: number }[],
  ): DagGraph {
    const list: DagGraph['nodes'] = [{ id: 'start', type: 'start', label: '开始', config: {} }];
    const edges: DagGraph['edges'] = [];
    nodes.forEach((n, i) => {
      const id = `a${i + 1}`;
      list.push({
        id,
        type: 'agent' as const,
        label: id,
        config: {
          agentKind: 'fake',
          prompt: `做 ${n.tag}`,
          ...(n.role ? { role: n.role } : {}),
          ...(n.timeoutMs ? { timeoutMs: n.timeoutMs } : {}),
        },
      });
      edges.push({ id: `e${i}`, source: i ? `a${i}` : 'start', target: id });
    });
    list.push({ id: 'end', type: 'end', label: '结束', config: {} });
    edges.push({ id: 'ez', source: `a${nodes.length}`, target: 'end' });
    return { version: 1, name, nodes: list, edges, metadata: { createdAt: '', updatedAt: '' } };
  }
  const promptOf = (tag: string): string => ops.prompts.find((p) => p.text.includes(`做 ${tag}`))!.text;
  const dvEvents = (r: RunRecord) => (r.events ?? []).filter((e) => e.text.includes('declareViolation'));

  it('①声明进 prompt 且措辞诚实（声明非强制/锁在 agent CLI 侧）；没声明=注入块零新增；声明不挪 ctxSha/roleSha 指纹、只涨 injectedBytes', async () => {
    const root = w3Root();
    w3Profile(root);
    saveRoles(dataDir, [
      { id: 'r-decl', name: '交付岗', declares: { gitPush: false, prOpen: true } },
      { id: 'r-quiet', name: '安静岗' },
    ]);
    const decl = await runToCompletion(w3Graph('w3-decl', [{ tag: '甲', role: 'r-decl' }]), root);
    expect(decl.state).toBe('completed');
    const p = promptOf('甲');
    expect(p).toContain('岗位授权声明（声明非强制——PaneFlow 不造沙箱');
    expect(p).toContain('真正的能力锁配在你自己的 agent CLI 侧');
    expect(p).toContain('- gitPush=false：本岗声明不向远程仓库推送提交（git push）');
    expect(p).toContain('- prOpen=true：本岗声明可创建 Pull Request');
    // 收口声明账：status 授权行的唯一依据（三面按值域序稳定）
    expect(decl.declares).toEqual([{ roleId: 'r-decl', faces: { gitPush: false, prOpen: true } }]);
    // 没声明的岗：注入块与现状逐字节相同（兼容带），声明账/落差账/事件三路静默
    const quiet = await runToCompletion(w3Graph('w3-quiet', [{ tag: '乙', role: 'r-quiet' }]), root);
    expect(quiet.state).toBe('completed');
    expect(promptOf('乙')).not.toContain('岗位授权声明');
    expect(quiet.declares).toBeUndefined();
    expect(quiet.declareViolations).toBeUndefined();
    expect(dvEvents(quiet)).toHaveLength(0);
    // 声明刻意不入两枚指纹：同岗同装备只加声明 → roleSha/ctxSha 纹丝不动，injectedBytes 涨（块真进了 prompt）
    saveRoles(dataDir, [{ id: 'r-arm', name: '装备岗', skills: ['sk-a.md'] }]);
    const before = await runToCompletion(w3Graph('w3-fp1', [{ tag: '丙', role: 'r-arm' }]), root);
    saveRoles(dataDir, [{ id: 'r-arm', name: '装备岗', skills: ['sk-a.md'], declares: { gitPush: false } }]);
    const after = await runToCompletion(w3Graph('w3-fp2', [{ tag: '丁', role: 'r-arm' }]), root);
    expect(after.harness!.roleSha).toBe(before.harness!.roleSha);
    expect(after.harness!.ctxSha).toBe(before.harness!.ctxSha);
    expect(after.harness!.injectedBytes!).toBeGreaterThan(before.harness!.injectedBytes!);
    expect(before.declares).toBeUndefined();
    expect(after.declares).toEqual([{ roleId: 'r-arm', faces: { gitPush: false } }]);
  });

  it('②三面各落一条落差（同岗多节点去重=一条账）；warn 事件含单级上界归因；单照常全绿、账真落盘', async () => {
    const root = w3Root();
    w3Profile(root);
    saveRoles(dataDir, [
      { id: 'r-deliver', name: '交付岗', declares: { gitPush: false, prOpen: false, issueWrite: false } },
    ]);
    let release = (): void => {};
    const held = new Promise<void>((res) => (release = res));
    ops.onPrompt = (target, text) => {
      if (text.includes('做 甲')) {
        fs.mkdirSync(path.join(root, '.herdr/artifacts'), { recursive: true });
        fs.writeFileSync(
          path.join(root, '.herdr/artifacts/a1.json'),
          JSON.stringify({ summary: 'x', extra: { pr_url: 'https://github.com/acme/app/pull/9' } }),
        );
        ops.setStatus(target, 'working');
        void held.then(() => ops.setStatus(target, 'idle'));
      }
    };
    const run = await engine.startRun(w3Graph('w3-dv', [{ tag: '甲', role: 'r-deliver', timeoutMs: 60_000 }, { tag: '乙', role: 'r-deliver' }]), root);
    await waitFor(() => ops.prompts.length >= 1);
    // 收口前把两枚引擎侧证据记进账（pushedAt：S1a 留键位至今无写路径，按 S1b seedSE 同款直接落账）
    engine.getRun(run.runId)!.sideEffects = { pushedAt: '2026-09-22T02:03:04.000Z' };
    expect(engine.recordIssueSideEffect(run.runId, 'created', 12)).toBe(true);
    release();
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    // 只照不拦（评审 R5）：三面全违也照常 completed、节点全 done
    expect(final.state).toBe('completed');
    expect(final.nodes.a1!.state).toBe('done');
    expect(final.nodes.a2!.state).toBe('done');
    // 两节点同岗=一条声明账、三面各一条落差（面按 DECLARE_FACES 序）
    expect(final.declares).toEqual([
      { roleId: 'r-deliver', faces: { gitPush: false, prOpen: false, issueWrite: false } },
    ]);
    expect(final.declareViolations).toEqual([
      { roleId: 'r-deliver', face: 'gitPush', seen: '已推送 2026-09-22T02:03:04.000Z' },
      { roleId: 'r-deliver', face: 'prOpen', seen: 'PR https://github.com/acme/app/pull/9' },
      { roleId: 'r-deliver', face: 'issueWrite', seen: '建单#12' },
    ]);
    const ev = dvEvents(final);
    expect(ev).toHaveLength(1); // 一次收口恰好一笔账，不逐条刷屏
    expect(ev[0]!.text).toContain('declareViolation');
    expect(ev[0]!.text).toContain('只照不拦');
    expect(ev[0]!.text).toContain('归因为单级上界');
    expect(ev[0]!.text).toContain('岗「r-deliver」声明 gitPush=false，副作用账却见「已推送 2026-09-22T02:03:04.000Z」');
    // 事实结构化落盘（不靠环形 events 推导）：从盘上读回同一本账
    expect(store.getRun(run.runId)!.declareViolations).toEqual(final.declareViolations);
  });

  it('③true 是正断言永不违例；声明了但没副作用账=只落声明账零事件；没声明=带账也整缺静默', async () => {
    saveRoles(dataDir, [{ id: 'r-yes', name: '坦荡岗', declares: { prOpen: true } }]);
    // 坦荡岗声明 prOpen=true，agent 真开了 PR（产物自报 → 引擎 capturePrUrl 在册）：不违例
    const yesRoot = w3Root();
    w3Profile(yesRoot);
    ops.onPrompt = (_t, text) => {
      if (!text.includes('做 甲')) return;
      fs.mkdirSync(path.join(yesRoot, '.herdr/artifacts'), { recursive: true });
      fs.writeFileSync(
        path.join(yesRoot, '.herdr/artifacts/a1.json'),
        JSON.stringify({ summary: 'x', extra: { pr_url: 'https://github.com/acme/app/pull/9' } }),
      );
    };
    const yes = await runToCompletion(w3Graph('w3-yes', [{ tag: '甲', role: 'r-yes' }]), yesRoot);
    expect(yes.state).toBe('completed');
    expect(yes.sideEffects?.prUrl).toBe('https://github.com/acme/app/pull/9');
    expect(yes.declares).toEqual([{ roleId: 'r-yes', faces: { prOpen: true } }]);
    expect(yes.declareViolations).toBeUndefined();
    expect(dvEvents(yes)).toHaveLength(0);
    // 声明 false 但整单没有副作用账：只落声明账，零落差零事件
    saveRoles(dataDir, [{ id: 'r-clean', name: '克制岗', declares: { gitPush: false } }]);
    const cleanRoot = w3Root();
    w3Profile(cleanRoot);
    const clean = await runToCompletion(w3Graph('w3-clean', [{ tag: '乙', role: 'r-clean' }]), cleanRoot);
    expect(clean.state).toBe('completed');
    expect(clean.declares).toEqual([{ roleId: 'r-clean', faces: { gitPush: false } }]);
    expect(clean.declareViolations).toBeUndefined();
    expect(dvEvents(clean)).toHaveLength(0);
    // 没声明的岗哪怕带副作用账：三本账整缺（宁缺毋假——不是「声明了零面」）
    saveRoles(dataDir, [{ id: 'r-none', name: '无名岗' }]);
    const anon = await runToCompletion(w3Graph('w3-anon', [{ tag: '丙', role: 'r-none' }]), yesRoot);
    expect(anon.state).toBe('completed');
    expect(anon.sideEffects?.prUrl).toBeDefined(); // 复用 yesRoot 的在册产物：账是真有，但没声明可对
    expect(anon.declares).toBeUndefined();
    expect(anon.declareViolations).toBeUndefined();
    expect(dvEvents(anon)).toHaveLength(0);
  });

  it('④绑定 precedence 照抄 W4：equip 落了册只认实绑（图里名义岗有声明也排除）；没落册回落名义（红单同样对账，状态不改）', async () => {
    const root = w3Root();
    w3Profile(root);
    // 实绑优先：注入现场图里没有这个岗（equip 不落 role），收口时岗库才补上 → 实态没吃过这岗，不对账
    saveRoles(dataDir, []);
    let release = (): void => {};
    const held = new Promise<void>((res) => (release = res));
    ops.onPrompt = (target, text) => {
      if (!text.includes('做 甲')) return;
      ops.setStatus(target, 'working');
      void held.then(() => ops.setStatus(target, 'idle'));
    };
    const ghostRun = await engine.startRun(w3Graph('w3-ghost', [{ tag: '甲', role: 'r-ghost', timeoutMs: 60_000 }]), root);
    await waitFor(() => ops.prompts.length >= 1);
    saveRoles(dataDir, [{ id: 'r-ghost', name: '幽灵岗', declares: { gitPush: false } }]);
    engine.getRun(ghostRun.runId)!.sideEffects = { pushedAt: '2026-09-22T00:00:00.000Z' };
    release();
    await waitFor(() => engine.getRun(ghostRun.runId)!.state !== 'running');
    const g = engine.getRun(ghostRun.runId)!;
    expect(g.state).toBe('completed');
    expect(g.nodes.a1!.equip).toBeDefined(); // equip 落了册且没有 role：实绑说「这节点没吃上岗」
    expect(g.nodes.a1!.equip!.role).toBeUndefined();
    expect(g.declares).toBeUndefined();
    expect(g.declareViolations).toBeUndefined();
    expect(dvEvents(g)).toHaveLength(0);
    // 回落名义：a1 被人工拒掉（有 equip、无声明岗），a2 没起跑（无 equip）→ 名义 config.role 进账；红单照对账
    saveRoles(dataDir, [
      { id: 'r-quiet', name: '安静岗' },
      { id: 'r-late', name: '迟到岗', declares: { gitPush: false } },
    ]);
    ops.onPrompt = (target) => {
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'blocked'), 10);
    };
    const run = await engine.startRun(w3Graph('w3-nominal', [{ tag: '甲', role: 'r-quiet' }, { tag: '乙', role: 'r-late' }]), root);
    await waitFor(() => engine.isBlocked(run.runId, 'a1'));
    engine.getRun(run.runId)!.sideEffects = { pushedAt: '2026-09-22T01:02:03.000Z' };
    await engine.approve(run.runId, 'a1', { action: 'reject' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const f = engine.getRun(run.runId)!;
    expect(f.state).toBe('failed'); // 对账不改收口判定：这单该红还是红
    expect(f.nodes.a2!.equip).toBeUndefined(); // 没跑到的节点没实绑账 → 回落名义
    expect(f.declares).toEqual([{ roleId: 'r-late', faces: { gitPush: false } }]);
    expect(f.declareViolations).toEqual([
      { roleId: 'r-late', face: 'gitPush', seen: '已推送 2026-09-22T01:02:03.000Z' },
    ]);
    expect(dvEvents(f)).toHaveLength(1);
  });
});

/**
 * v13-B2 交付约定三层消费（现场件）。判据本体（匹配/渲染/文案/纯图账）在 delivery.test.ts，
 * 本文件校的是三层在**生产路**上真的接线：
 *  ①机检=createWorktree（基点 fail-closed + 家规分支命名 + 占位符未解析拒建）
 *  ②注入=resolveContext 约定通道（进 injectedBytes、不进 ctxSha）
 *  ③对账=execute() 收口 reconcileDelivery（两条落差 + 一条聚合 warn，只照不拦）
 * 兼容带死判据：档案没 delivery / 没命中条目 → 引擎与 B1 之前逐字同行为（零新账、零新事件、
 * 零新 git 读、命名与基点一律现状）。
 * fixture 同款 B3：真 git 仓 + FakeHerdrOps + 同仓并发 fanout（a 占锁 → b 走 worktree）。
 */
describe('v13-B2 交付约定三层消费（①机检 fail-closed · ②注入约定通道 · ③收口对账只照不拦 · 兼容带零回归）', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

  /** ref 存在性探针：--quiet 对不存在的 ref 让 git 退非 0，execFileSync 会抛——问「有没有」得自己兜 */
  const refAt = (cwd: string, ref: string): string => {
    try {
      return git(cwd, 'rev-parse', '--verify', '--quiet', ref);
    } catch {
      return '';
    }
  };

  /** 三字段齐 + 人闸声明 + 备注的样本家规：{version} 收起单实填变量、{issue} 收起单 issueId */
  const BUG_HOUSE: DeliveryRule = {
    repo: 'web-console',
    branchFrom: 'main',
    branchName: 'fix/v{version}-{issue}',
    prTarget: 'release/v{version}',
    gates: ['对齐先行', 'PR 前'],
    note: 'bug 单家规：驳回开 Bug 链回主 Issue',
  };
  /** repo 缺省的全空间通配副 */
  function wild(over: Partial<DeliveryRule> = {}): DeliveryRule {
    return { branchFrom: 'main', branchName: 'wt/wild-{run_id}', prTarget: 'main', ...over };
  }

  /**
   * macOS 的 tmpdir 是 /var→/private/var 的软链，而 `git rev-parse --show-toplevel` 返回物理路径：
   * 不做 realpath 的话「仓相对主仓根」永远算不出相对路径（createWorktree 手里的 repo 就是 git 读回来的）。
   */
  function realTmp(prefix: string): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  }
  function gitInit(dir: string): string {
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.email', 'pf@test.local');
    git(dir, 'config', 'user.name', 'pf-test');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.herdr/\n');
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    return dir;
  }
  function initRepo(prefix: string): string {
    return gitInit(realTmp(prefix));
  }
  /** 主仓根 + 根下一个 git 仓（家规按「相对主仓根的仓名」命中，与 rules.matchRules 同一把尺） */
  function spaceRepo(repoName = 'web-console'): { root: string; repo: string } {
    const root = realTmp('pf-b2-root-');
    const repo = path.join(root, repoName);
    fs.mkdirSync(repo, { recursive: true });
    gitInit(repo);
    return { root, repo };
  }
  function houseProfile(root: string, delivery?: DeliveryRule[]): void {
    const p: SpaceProfile = { ...store.readProfile(), rootCwd: root };
    if (delivery) p.delivery = delivery;
    else delete p.delivery;
    store.writeProfile(p);
  }
  /** 同仓并发 fanout（B3 同款现场）：a 先占仓锁 → b 建隔离 worktree */
  function siblingGraph(repo: string, name: string, bConfig: Partial<DagNodeConfig> = {}): DagGraph {
    return {
      version: 1,
      name,
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'fork', type: 'fanout', label: '展开', config: {} },
        { id: 'a', type: 'agent', label: '任务A', config: { agentKind: 'fake', prompt: '做甲活', cwd: repo } },
        {
          id: 'b',
          type: 'agent',
          label: '任务B',
          config: { agentKind: 'fake', prompt: '做乙活', cwd: repo, ...bConfig },
        },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fork' },
        { id: 'e2', source: 'fork', target: 'a' },
        { id: 'e3', source: 'fork', target: 'b' },
        { id: 'e4', source: 'a', target: 'end' },
        { id: 'e5', source: 'b', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
  }
  /** 取**最近一单**发的匹配 prompt（同测试里跑过多单时 find 会命中旧单） */
  const lastPromptOf = (tag: string): string =>
    [...ops.prompts].reverse().find((p) => p.text.includes(tag))!.text;
  /** 顶层 runToCompletion 不带 variables/issueId，本组要起带单号的单故自带跑法 */
  async function runHouse(
    graph: DagGraph,
    cwd: string,
    opts?: { variables?: Record<string, string>; issueId?: string },
  ): Promise<RunRecord> {
    const run = await engine.startRun(graph, cwd, undefined, opts?.variables, opts?.issueId);
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    return engine.getRun(run.runId)!;
  }
  const reclaimEventsOf = (run: RunRecord) => (run.events ?? []).filter((e) => e.text.includes('worktree 回收'));
  const dvEvents = (run: RunRecord) => (run.events ?? []).filter((e) => e.text.includes('deliveryViolation'));
  const houseEvents = (run: RunRecord) => (run.events ?? []).filter((e) => e.text.includes('交付约定'));
  /** worktree 目录名不作家规化（孤儿清扫靠目录名认单），只有分支名交给家规 */
  const wtDirOf = (runId: string, nodeId: string) => path.join(dataDir, 'worktrees', `${runId}-${nodeId}`);
  const worktreeDirs = () => {
    try {
      return fs.readdirSync(path.join(dataDir, 'worktrees'));
    } catch {
      return [];
    }
  };
  /** 同 run 内跨两轮的兄弟占仓现场（T9 用）：a→c 链 + b 重试，c 在 b 首轮失败前接手仓锁 */
  function chainGraph(repo: string, name: string): DagGraph {
    return {
      version: 1,
      name,
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'fork', type: 'fanout', label: '展开', config: {} },
        {
          id: 'a',
          type: 'agent',
          label: '任务A',
          config: { agentKind: 'fake', prompt: '做甲活', cwd: repo, checks: [{ type: 'manual', prompt: '看一眼甲' }] },
        },
        { id: 'b', type: 'agent', label: '任务B', config: { agentKind: 'fake', prompt: '做乙活', cwd: repo, retryCount: 1 } },
        {
          id: 'c',
          type: 'agent',
          label: '任务C',
          config: { agentKind: 'fake', prompt: '做丙活', cwd: repo, checks: [{ type: 'manual', prompt: '看一眼丙' }] },
        },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fork' },
        { id: 'e2', source: 'fork', target: 'a' },
        { id: 'e3', source: 'fork', target: 'b' },
        { id: 'e4', source: 'a', target: 'c' },
        { id: 'e5', source: 'b', target: 'end' },
        { id: 'e6', source: 'c', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
  }

  // T1 兼容带死判据 -----------------------------------------------------------
  it('T1 兼容带·现网零回归：没配家规 / 配了但不命中 → 命名与基点全是现状，零新账零新事件注入面零变化', async () => {
    const { root, repo } = spaceRepo();
    // (a) 档案根本没有 delivery 键
    houseProfile(root);
    const plain = await runToCompletion(siblingGraph(repo, 'b2-band-plain'), repo);
    expect(plain.state).toBe('completed');
    expect(plain.nodes.b!.worktree).toBe(wtDirOf(plain.runId, 'b'));
    // 分支名仍是引擎正身 paneflow/<runId>-<nodeId>（建它时的事件在册，回收时 -d 删掉=现状）
    const claimed = (plain.events ?? []).find((e) => e.text.includes('同仓并发'))!;
    expect(claimed.text).toContain(`paneflow/${plain.runId}-b`);
    const evs = reclaimEventsOf(plain);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.text).toContain('已删除');
    expect(evs[0]!.text).toContain(`paneflow/${plain.runId}-b`);
    expect(plain.deliveryWorktrees).toBeUndefined();
    expect(plain.deliveryViolations).toBeUndefined();
    expect(houseEvents(plain)).toHaveLength(0);
    expect(lastPromptOf('做乙活')).not.toContain('交付约定');
    // (b) 配了家规但 repo 不匹配（仓在另一棵树里，且档案没通配副兜底）→ 三层一条都不走
    const other = initRepo('pf-b2-band-other-');
    houseProfile(root, [{ ...BUG_HOUSE, branchName: 'fix/never-{issue}' }]);
    const miss = await runHouse(siblingGraph(other, 'b2-band-miss'), other, { issueId: '123' });
    expect(miss.state).toBe('completed');
    expect((miss.events ?? []).find((e) => e.text.includes('同仓并发'))!.text).toContain(`paneflow/${miss.runId}-b`);
    expect(git(other, 'branch', '--list')).not.toContain('fix/never-123');
    expect(miss.deliveryWorktrees).toBeUndefined();
    expect(miss.deliveryViolations).toBeUndefined();
    expect(houseEvents(miss)).toHaveLength(0);
    expect(lastPromptOf('做乙活')).not.toContain('交付约定');
    // 不命中=注入面零变化：两单的 ctxSha / injectedBytes 同款（V4/W2 等式不被家规噪声破）
    expect(miss.harness!.ctxSha).toBe(plain.harness!.ctxSha);
    expect(miss.harness!.injectedBytes).toBe(plain.harness!.injectedBytes);
  });

  // T2 三层同现场 -------------------------------------------------------------
  it('T2 家规命中：①按家规拉分支（{version}/{issue} 双取材）②约定块进 prompt ③在册账 + B3 护栏被走到（非正身不碰保留）', async () => {
    const { root, repo } = spaceRepo();
    houseProfile(root, [BUG_HOUSE]);
    const g = siblingGraph(repo, 'b2-three-layer', { checks: [{ type: 'manual', prompt: '看一眼' }] });
    const run = await engine.startRun(g, repo, undefined, { version: '1.4' }, '123');
    await waitFor(() => engine.isBlocked(run.runId, 'b'));
    // ②注入层：渲染后的约定块（基点/分支名/PR 目标/gates 逐条名/note 全在里面）
    const p = lastPromptOf('做乙活');
    expect(p).toContain('交付约定（本项目家规，仓「web-console」（相对主仓根），档案 delivery 第 1 条）');
    expect(p).toContain('- 拉出基点：main（来源=空间家规）');
    expect(p).toContain('- 分支名：fix/v1.4-123（家规模板 fix/v{version}-{issue}）');
    expect(p).toContain('- PR 目标分支：release/v1.4（家规模板 release/v{version}）'); // B4
    expect(p).toContain('「对齐先行」、「PR 前」');
    expect(p).toContain('- 家规备注：bug 单家规');
    expect(p).toContain('PaneFlow 只声明与对账、不代跑 git push 也不代建 PR');
    await engine.approve(run.runId, 'b', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    // ①机检层：分支真按家规命名并从 main 拉出，目录命名仍是 <runId>-<nodeId>
    expect(final.nodes.b!.worktree).toBe(wtDirOf(final.runId, 'b'));
    expect(git(repo, 'branch', '--list')).toContain('fix/v1.4-123');
    expect(git(repo, 'branch', '--list')).not.toContain(`paneflow/${final.runId}-b`); // 绝不回退正身
    // ①的 B3 护栏后果：家规分支非引擎自建正身 → 只删目录、分支一并不碰（需求文档要求走一遍证明护栏没死）
    expect(fs.existsSync(wtDirOf(final.runId, 'b'))).toBe(false);
    const evs = reclaimEventsOf(final);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.text).toContain('非引擎自建正身');
    expect(evs[0]!.text).toContain('不碰保留');
    expect(evs[0]!.text).toContain('fix/v1.4-123');
    // ③对账层在册账：命中哪条家规、怎么命中、真做了什么、期望 vs 实态
    expect(final.deliveryWorktrees).toHaveLength(1);
    expect(final.deliveryWorktrees![0]).toMatchObject({
      nodeId: 'b',
      repo,
      worktreePath: wtDirOf(final.runId, 'b'),
      ruleIndex: 0,
      matchedBy: 'repo',
      pullMode: 'new-branch',
      baseRef: 'main',
      baseSource: 'rule',
      expectedBranch: 'fix/v1.4-123',
      actualBranch: 'fix/v1.4-123',
      // B4：prTarget 渲染结果同场落册（交付出口在场级账上可见，PaneFlow 不代跑建 PR）
      prTarget: 'release/v1.4',
    });
    // 账从盘上读回同一本（不靠环形 events 推导）
    expect(store.getRun(final.runId)!.deliveryWorktrees).toEqual(final.deliveryWorktrees);
    // 家规声明的人闸在图上编出来了（manual 检查）→ 落差整缺、事件静默
    expect(final.deliveryViolations).toBeUndefined();
    expect(dvEvents(final)).toHaveLength(0);
  });

  // T3 基点 fail-closed -------------------------------------------------------
  it('T3 基点两路都解析不到 = 拒建即时红（绝不静默从 HEAD 拉出），零 worktree 零分支零账', async () => {
    const { root, repo } = spaceRepo();
    houseProfile(root, [{ ...BUG_HOUSE, branchName: 'fix/issue-{issue}', prTarget: 'main', branchFrom: 'nope-branch', gates: undefined }]);
    const run = await runHouse(siblingGraph(repo, 'b2-base-fail'), repo, { issueId: '123' });
    expect(run.state).toBe('failed');
    expect(run.nodes.a!.state).toBe('done'); // 占锁的那一支不碰家规建支路，照常跑完
    expect(run.nodes.b!.state).toBe('failed');
    expect(run.nodes.b!.error).toContain('交付约定要求基点「nope-branch」');
    expect(run.nodes.b!.error).toContain('都解析不到');
    expect(run.nodes.b!.error).toContain('绝不静默从当前 HEAD 拉出');
    // 拒建就要什么都没有（旧行为会静默从 HEAD 建出来——那正是污染账）
    expect(run.nodes.b!.worktree).toBeUndefined();
    expect(worktreeDirs()).toEqual([]);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1); // 只剩主检出
    const branches = git(repo, 'branch', '--list');
    expect(branches).not.toContain('fix/issue-123');
    expect(branches).not.toContain(`paneflow/${run.runId}-b`);
    expect(ops.prompts.some((x) => x.text.includes('做乙活'))).toBe(false);
    expect(run.deliveryWorktrees).toBeUndefined();
    // 一句人话只落节点 error 这一格结构化账（status/运行卡直读），不为失败路新造事件族
    expect(houseEvents(run)).toHaveLength(0);
    expect(dvEvents(run)).toHaveLength(0);
  });

  // T4 origin 第二路 ----------------------------------------------------------
  it('T4 基点第二路：本地没有但 origin/<base> 有 → 从 origin ref 拉出（baseRef 记 origin/…，块里仍作家规原名）', async () => {
    const { root, repo } = spaceRepo();
    // 造一个只存在于远端跟踪 ref 的分支：本地分支删掉，refs/remotes/origin/rel-2 留着
    git(repo, 'checkout', '-b', 'rel-2');
    fs.writeFileSync(path.join(repo, 'origin-only.txt'), '只在 origin 上的一笔');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'only on origin');
    git(repo, 'update-ref', 'refs/remotes/origin/rel-2', 'refs/heads/rel-2');
    git(repo, 'checkout', 'main');
    git(repo, 'branch', '-D', 'rel-2');
    expect(refAt(repo, 'refs/heads/rel-2')).toBe('');
    expect(refAt(repo, 'refs/remotes/origin/rel-2')).not.toBe('');
    houseProfile(root, [{ ...BUG_HOUSE, branchName: 'wt/from-origin', prTarget: 'main', branchFrom: 'rel-2', gates: undefined }]);
    const run = await runToCompletion(siblingGraph(repo, 'b2-origin'), repo);
    const wt = run.deliveryWorktrees!.find((w) => w.nodeId === 'b')!;
    expect(wt.pullMode).toBe('new-branch');
    expect(wt.baseRef).toBe('origin/rel-2');
    expect(wt.baseSource).toBe('rule');
    expect(wt.expectedBranch).toBe('wt/from-origin');
    // 拉出的确实是 origin 那笔（main 上没有 origin-only.txt）→ 不是 HEAD 污染账
    expect(git(repo, 'ls-tree', '--name-only', 'wt/from-origin')).toContain('origin-only.txt');
    // 注入块说的是家规写的基点名（不带 origin/ 前缀），解析结果只在账上
    expect(lastPromptOf('做乙活')).toContain('- 拉出基点：rel-2（来源=空间家规）');
  });

  // T5 占位符未解析 fail-closed ----------------------------------------------
  it('T5 占位符解析不到 = 拒建即时红，严禁静默回退 paneflow/ 命名或留字面花括号', async () => {
    const { root, repo } = spaceRepo();
    houseProfile(root, [{ ...BUG_HOUSE, branchName: 'fix/issue-{issue}', prTarget: 'main', gates: undefined }]);
    // 关键：起单没带 issueId → {issue} 无处取材
    const run = await runToCompletion(siblingGraph(repo, 'b2-tpl-fail'), repo);
    expect(run.state).toBe('failed');
    expect(run.nodes.b!.error).toContain('交付约定占位符解析不到');
    expect(run.nodes.b!.error).toContain('branchName 模板「fix/issue-{issue}」缺 {issue}');
    expect(run.nodes.b!.error).toContain('绝不静默回退成 paneflow/<runId>-<nodeId>');
    const branches = git(repo, 'branch', '--list');
    expect(branches).not.toContain(`paneflow/${run.runId}-b`); // 没回退成正身
    expect(branches).not.toContain('fix/issue-{issue}'); // 也没把字面模板当分支名建出去
    expect(worktreeDirs()).toEqual([]);
    expect(run.deliveryWorktrees).toBeUndefined();
  });

  // T6 repo 精确条目优先 ------------------------------------------------------
  it('T6 命中优先级：repo 精确条目赢过通配副（数组顺序不决定优先级），账上 ruleIndex/matchedBy 指认赢家', async () => {
    const root = realTmp('pf-b2-nested-');
    const repo = path.join(root, 'svc-app');
    fs.mkdirSync(repo, { recursive: true });
    gitInit(repo);
    houseProfile(root, [
      wild(), // 通配副故意排第一
      { repo: 'svc-app', branchFrom: 'main', branchName: 'app/{run_id}', prTarget: 'main' },
    ]);
    const run = await runToCompletion(siblingGraph(repo, 'b2-priority'), repo);
    expect(run.state).toBe('completed');
    const wt = run.deliveryWorktrees!.find((w) => w.nodeId === 'b')!;
    expect(wt).toMatchObject({ ruleIndex: 1, matchedBy: 'repo', expectedBranch: `app/${run.runId}` });
    expect(git(repo, 'branch', '--list')).toContain(`app/${run.runId}`);
    expect(git(repo, 'branch', '--list')).not.toContain('wt/wild-');
    expect(lastPromptOf('做乙活')).toContain('仓「svc-app」（相对主仓根），档案 delivery 第 2 条');
  });

  // T7 contract.branch 压过空间 -----------------------------------------------
  it('T7 死字段 contract.branch 点亮：本单契约基点压过空间 branchFrom（契约优先），拉出的真是契约那笔', async () => {
    const { root, repo } = spaceRepo();
    git(repo, 'checkout', '-b', 'release/v2');
    fs.writeFileSync(path.join(repo, 'v2-only.txt'), '只有 v2 支上有的文件');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'v2 only');
    git(repo, 'checkout', 'main');
    houseProfile(root, [{ ...BUG_HOUSE, branchName: 'wt/contract', prTarget: 'main', gates: undefined }]);
    const run = await engine.startRun(siblingGraph(repo, 'b2-contract'), repo, undefined, undefined, undefined, undefined, {
      contract: { assertions: [], questions: [], branch: 'release/v2', source: 'generated' },
    });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    const wt = final.deliveryWorktrees!.find((w) => w.nodeId === 'b')!;
    expect(wt.baseRef).toBe('release/v2');
    expect(wt.baseSource).toBe('contract');
    expect(wt.expectedBranch).toBe('wt/contract');
    // 契约优先是真拉了那一笔，不是账上写写
    expect(git(repo, 'ls-tree', '--name-only', 'wt/contract')).toContain('v2-only.txt');
    expect(lastPromptOf('做乙活')).toContain('- 拉出基点：release/v2（来源=本单契约覆盖，契约优先于空间）');
  });

  // T8 gates-without-gate 纯图账 ---------------------------------------------
  it('T8 对账·家规有人闸图上一道没编：纯图账（没建过 worktree 也照样算），⚠ 一条聚合事件、单照常收口', async () => {
    const dir = realTmp('pf-b2-gates-');
    houseProfile(dir, [wild({ gates: ['对齐先行', 'PR 前'] })]);
    const run = await runToCompletion(serialGraph(), dir);
    expect(run.state).toBe('completed');
    expect(run.deliveryWorktrees).toBeUndefined(); // 没撞仓锁=没建过 worktree，机检账整缺
    expect(run.deliveryViolations).toEqual([
      {
        kind: 'gates-without-gate',
        ruleIndex: 0,
        expected: '「对齐先行」、「PR 前」',
        actual: '图上 0 道人闸位',
        detail: '家规第 1 条声明人闸 「对齐先行」、「PR 前」，而本单的图里一道人闸位都没编（manual 检查/契约门/分支守卫/澄清轮皆无）',
      },
    ]);
    const evs = dvEvents(run);
    expect(evs).toHaveLength(1); // 一次收口恰好一笔账，不逐条刷屏
    expect(evs[0]!.text).toContain('deliveryViolation');
    expect(evs[0]!.text).toContain('只照不拦');
    expect(evs[0]!.text).toContain('家规第 1 条声明人闸');
    expect(evs[0]!.text).toContain('本账只核「分支名」与「图上人闸」两条');
    // 反例甲：图里编了人闸位（manual 检查）→ 零落差零事件
    houseProfile(dir, [wild({ gates: ['PR 前'] })]);
    const gated = serialGraph();
    gated.nodes[1]!.config.checks = [{ type: 'manual', prompt: '确认放行' }];
    const g = await engine.startRun(gated, dir);
    await waitFor(() => engine.isBlocked(g.runId, 'impl'));
    await engine.approve(g.runId, 'impl', { action: 'approve' });
    await waitFor(() => engine.getRun(g.runId)!.state !== 'running');
    const gf = engine.getRun(g.runId)!;
    expect(gf.state).toBe('completed');
    expect(gf.deliveryViolations).toBeUndefined();
    expect(dvEvents(gf)).toHaveLength(0);
    // 反例乙：gates 空数组=没声明（0 是正读，不是落差）
    houseProfile(dir, [wild({ gates: [] })]);
    const none = await runToCompletion(serialGraph(), dir);
    expect(none.state).toBe('completed');
    expect(none.deliveryViolations).toBeUndefined();
    expect(dvEvents(none)).toHaveLength(0);
  });

  // T9 branch-name 落差 ------------------------------------------------------
  /**
   * 生产现场（首驾-4 那笔残留账的形状）：同 run 里另一支兄弟节点在 b 首轮失败之前接手了仓锁
   * 并一直活着（这里让 c 卡在 manual 人闸上），于是 b 的第二轮仍走 worktree 路 →
   * 目录是上一轮残留 → pullMode=reuse-directory（既不建支也不拉基点）→ 现场读回的实分支名
   * 是首轮被 agent 切走的那条 → 与家规渲染名落差。全程真 git + 真门，无 monkeypatch。
   */
  it('T9 对账·实分支名≠家规渲染：重试续用残留目录时现读实态入账（只照不拦，单照常 completed）', async () => {
    const { root, repo } = spaceRepo();
    houseProfile(root, [{ ...BUG_HOUSE, branchName: 'fix/issue-{issue}', prTarget: 'main', gates: undefined }]);
    let bPrompts = 0;
    let tampered = false;
    ops.onPrompt = (target, text) => {
      if (!text.includes('做乙活')) return;
      bPrompts += 1;
      if (bPrompts > 1) return; // 第二轮照常跑完
      // 首轮：worktree 已建好（createWorktree 先于 prompt）→ 就地换支（模拟 agent 在隔离目录里切走），
      // 再让 agent 弹框走人工门——失败时机由本测试亲手按下，保证 c 已接手仓锁
      const hit = worktreeDirs().find((n) => n.endsWith('-b'));
      if (hit) {
        git(path.join(dataDir, 'worktrees', hit), 'checkout', '-b', 'side/track');
        tampered = true;
      }
      ops.setStatus(target, 'working');
      setTimeout(() => ops.setStatus(target, 'blocked'), 10);
    };
    const run = await engine.startRun(chainGraph(repo, 'b2-branch-gap'), repo, undefined, undefined, '123');
    // a 跑到人闸位（其尝试仍持着仓锁的下游），b 首轮弹框等人工处置
    await waitFor(() => engine.isBlocked(run.runId, 'a'));
    await waitFor(() => engine.isBlocked(run.runId, 'b'));
    expect(tampered).toBe(true);
    // 放行 a → c 起跑：同 run 兄弟占仓 → c 也建 worktree（家规分支已由 b 首轮建出、b 目录又切走了，
    // 于是 c 走 attach-existing-branch 续用同名支），并在 c 卡住自己的人闸期间持着仓锁
    await engine.approve(run.runId, 'a', { action: 'approve' });
    await waitFor(() => engine.isBlocked(run.runId, 'c'));
    expect(fs.existsSync(wtDirOf(run.runId, 'c'))).toBe(true);
    // 此刻拒掉 b 首轮 → 重试的第二轮仍走 worktree 路，撞上首轮残留目录。
    // 顺序是判据而非风格：必须等第二轮真的起了 prompt（createWorktree 先于 prompt）再放行 c——
    // c 一出闸就把仓锁撒手，第二轮看不到同 run 兄弟占仓，直接回主检出跑，worktree 路整条走不到。
    await engine.approve(run.runId, 'b', { action: 'reject' });
    await waitFor(() => bPrompts === 2);
    await engine.approve(run.runId, 'c', { action: 'approve' });
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed'); // 只照不拦：落差绝不让红/让绿翻转
    expect(final.nodes.b!.attempts).toBe(2);
    const wt = final.deliveryWorktrees!.find((w) => w.nodeId === 'b')!;
    expect(wt).toMatchObject({
      pullMode: 'reuse-directory',
      expectedBranch: 'fix/issue-123',
      actualBranch: 'side/track',
    });
    expect('baseRef' in wt).toBe(false); // 没拉新支就不写基点（写了就是假账）
    const wc = final.deliveryWorktrees!.find((w) => w.nodeId === 'c')!;
    expect(wc.pullMode).toBe('attach-existing-branch');
    expect('baseRef' in wc).toBe(false);
    expect(wc.actualBranch).toBe('fix/issue-123');
    expect(final.deliveryViolations).toEqual([
      {
        kind: 'branch-name',
        nodeId: 'b',
        ruleIndex: 0,
        expected: 'fix/issue-123',
        actual: 'side/track',
        detail: '节点「b」的隔离工作目录实分支名「side/track」 ≠ 家规第 1 条渲染的「fix/issue-123」',
      },
    ]);
    expect(dvEvents(final)).toHaveLength(1);
    expect(store.getRun(final.runId)!.deliveryViolations).toEqual(final.deliveryViolations);
    // 两枚家规分支（渲染名 + 被切走的那条）都不是引擎自建正身 → 护栏一个都不碰
    const branches = git(repo, 'branch', '--list');
    expect(branches).toContain('fix/issue-123');
    expect(branches).toContain('side/track');
    expect(fs.existsSync(wtDirOf(final.runId, 'b'))).toBe(false);
  });

  // T9b 家规分支被兄弟检出 = ①的第三条拒建路 --------------------------------
  it('T9b 同仓三支并发撞同名家规支：先建者按家规命名，后到者被 git 拒（分支已被别的 worktree 检出）→ 失败带家规指认，绝不静默改名', async () => {
    const { root, repo } = spaceRepo();
    houseProfile(root, [{ ...BUG_HOUSE, branchName: 'fix/issue-{issue}', prTarget: 'main', gates: undefined }]);
    const g: DagGraph = {
      version: 1,
      name: 'b2-collide',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'fork', type: 'fanout', label: '展开', config: {} },
        { id: 'a', type: 'agent', label: '任务A', config: { agentKind: 'fake', prompt: '做甲活', cwd: repo } },
        { id: 'b', type: 'agent', label: '任务B', config: { agentKind: 'fake', prompt: '做乙活', cwd: repo } },
        { id: 'c', type: 'agent', label: '任务C', config: { agentKind: 'fake', prompt: '做丙活', cwd: repo } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'fork' },
        { id: 'e2', source: 'fork', target: 'a' },
        { id: 'e3', source: 'fork', target: 'b' },
        { id: 'e4', source: 'fork', target: 'c' },
        { id: 'e5', source: 'a', target: 'end' },
        { id: 'e6', source: 'b', target: 'end' },
        { id: 'e7', source: 'c', target: 'end' },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    const run = await runHouse(g, repo, { issueId: '123' });
    // 家规模板没有 per-node 判别位时，同仓并发兄弟必然撞名：赢家按家规建支，输家被 git 拒
    const failed = Object.entries(run.nodes).filter(([, rec]) => rec.state === 'failed');
    expect(failed).toHaveLength(1);
    const loser = failed[0]![0];
    expect(['b', 'c']).toContain(loser);
    expect(failed[0]![1].error).toContain('交付约定建 worktree 失败（家规第 1 条：分支 fix/issue-123');
    expect(run.state).toBe('failed');
    // 输家抛在建账之前 → 在册账只有赢家一条（宁缺毋假），且它没拿到 worktree
    expect(run.deliveryWorktrees).toHaveLength(1);
    expect(run.deliveryWorktrees![0]!.nodeId).not.toBe(loser);
    expect(run.nodes[loser]!.worktree).toBeUndefined();
    // 引擎不许自作主张改成 paneflow/ 正身或加后缀续跑——那是静默改名，不是按约定交付
    expect(git(repo, 'branch', '--list')).not.toContain(`paneflow/${run.runId}-`);
  });

  // T10 注入卫生 -------------------------------------------------------------
  it('T10 注入卫生：约定块涨 injectedBytes 但绝不进 ctxSha（运行时文本不是实读文件），没家规时零新增', async () => {
    const dir = realTmp('pf-b2-hygiene-');
    fs.writeFileSync(path.join(dir, 'sk-a.md'), '装备甲 正文');
    houseProfile(dir);
    store.writeProfile({ ...store.readProfile(), skills: ['sk-a.md'] });
    const before = await runToCompletion(serialGraph(), dir);
    expect(before.state).toBe('completed');
    houseProfile(dir, [wild()]);
    const after = await runToCompletion(serialGraph(), dir);
    expect(after.state).toBe('completed');
    // 块真进了 prompt（同目录同档案，家规命中靠通配副）
    expect(lastPromptOf('实现功能')).toContain('本空间通配副（档案 delivery 未限定 repo）');
    // 卫生红线：加家规 → injectedBytes 涨（真进了 prompt），ctxSha 纹丝不动（它不是实读文件）
    expect(after.harness!.ctxSha).toBe(before.harness!.ctxSha);
    expect(after.harness!.injectedBytes!).toBeGreaterThan(before.harness!.injectedBytes!);
    // 撤掉家规 → 注入面回到现状：ctxSha 仍同一枚、injectedBytes 回到旧值
    houseProfile(dir);
    const plain = await runToCompletion(serialGraph(), dir);
    expect(plain.harness!.ctxSha).toBe(before.harness!.ctxSha);
    expect(plain.harness!.injectedBytes).toBe(before.harness!.injectedBytes);
    expect(lastPromptOf('实现功能')).not.toContain('交付约定');
  });
});

// ---------------------------------------------------------------------------
// v13-K1 命名产物台账与硬引用（真 Engine + FakeHerdrOps；台账值取自引擎实读，非自报）
// ---------------------------------------------------------------------------
describe('v13-K1 产物台账与硬引用', () => {
  const k1Tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-k1-'));

  /** design 节点按交接约定写 artifact.json（可带 products 声明）+ 可选写产物文件本体 */
  const writeDesignArtifact = (
    cwd: string,
    obj: Record<string, unknown>,
    files: Record<string, string> = {},
  ): void => {
    fs.mkdirSync(path.join(cwd, '.herdr/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.herdr/artifacts/design.json'), JSON.stringify(obj));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(cwd, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  };

  const chain = (implPrompt: string): DagGraph => ({
    version: 1,
    name: 'k1-chain',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      { id: 'design', type: 'agent', label: '设计', config: { agentKind: 'fake', prompt: '出方案' } },
      { id: 'impl', type: 'agent', label: '实现', config: { agentKind: 'fake', prompt: implPrompt } },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'design' },
      { id: 'e2', source: 'design', target: 'impl' },
      { id: 'e3', source: 'impl', target: 'end' },
    ],
    metadata: { createdAt: '', updatedAt: '' },
  });

  it('声明位被引擎实读算指纹并上架：台账落册、架上有原文、事件有一行', async () => {
    const cwd = k1Tmp();
    ops.onPrompt = (target) => {
      if (target.includes('design')) {
        writeDesignArtifact(cwd, { summary: '方案已定', products: [{ name: 'plan.md' }] }, {
          'plan.md': '# 计划\n第一步',
        });
      }
    };
    const run = await runToCompletion(chain('按 {{design.artifact.summary}} 实现'), cwd);
    expect(run.state).toBe('completed');
    const products = run.nodes['design']!.products;
    expect(products).toHaveLength(1);
    expect(products![0]!.name).toBe('plan.md');
    expect(products![0]!.kind).toBe('doc');
    expect(products![0]!.shelved).toBe(true);
    expect(products![0]!.bytes).toBe(Buffer.byteLength('# 计划\n第一步', 'utf8'));
    expect(products![0]!.sha).toMatch(/^[0-9a-f]{8}$/);
    // 架在 dataDir 下（worktree/工作区蒸发也带不走），且路径按 <runId>/<nodeId>/<名> 分格
    const shelved = path.join(dataDir, 'shelves', run.runId, 'design', 'plan.md');
    expect(fs.readFileSync(shelved, 'utf8')).toBe('# 计划\n第一步');
    expect((run.events ?? []).some((e) => e.text.includes(`产物台账：plan.md(${products![0]!.sha}`))).toBe(true);
  });

  it('硬引用把架上原文注进下游 prompt（不是摘要）——「审的就是那份」的兑现点', async () => {
    const cwd = k1Tmp();
    ops.onPrompt = (target) => {
      if (target.includes('design')) {
        writeDesignArtifact(
          cwd,
          { summary: '一句摘要', products: [{ name: 'plan.md' }] },
          { 'plan.md': '# 计划\n逐条可审的正文 42' },
        );
      }
    };
    const run = await runToCompletion(chain('据这份计划实现：{{artifact:design/plan.md}}'), cwd);
    expect(run.state).toBe('completed');
    const implPrompt = ops.prompts.find((p) => p.target.includes('impl'))!;
    expect(implPrompt.text).toContain('逐条可审的正文 42');
    // 替换发生在指令原位（不是把原文单贴一段）；裸花括号只剩上游产物清单里那句「引用写法」示例
    expect(implPrompt.text).toContain('据这份计划实现：# 计划');
    // 裸花括号只剩一处=上游产物清单里那句「引用写法」示例（指令原位那份已被原文替换）
    expect(implPrompt.text.split('{{artifact:design/plan.md}}').length).toBe(2);
  });

  it('硬引用解析不到=下游节点即时失败，且不把裸花括号交给 agent（与软引用只报告分家）', async () => {
    const cwd = k1Tmp();
    ops.onPrompt = (target) => {
      // design 什么都没声明：台账整键缺省，下游那份「计划」根本不存在
      if (target.includes('design')) writeDesignArtifact(cwd, { summary: '方案已定' });
    };
    const run = await runToCompletion(chain('据这份计划实现：{{artifact:design/plan.md}}'), cwd);
    expect(run.state).toBe('failed');
    expect(run.nodes['design']!.products).toBeUndefined();
    expect(run.nodes['impl']!.state).toBe('failed');
    expect(run.nodes['impl']!.error).toContain('产物引用未解析');
    expect(run.nodes['impl']!.error).toContain('台账里没有名为「plan.md」的产物');
    // 失败发生在提交之前：impl 一个字都没进 agent
    expect(ops.prompts.some((p) => p.target.includes('impl'))).toBe(false);
  });

  it('消费面（结 N1）：下游 prompt 带上游命名产物清单+引用写法，交接约定教 agent 怎么声明', async () => {
    const cwd = k1Tmp();
    ops.onPrompt = (target) => {
      if (target.includes('design')) {
        writeDesignArtifact(
          cwd,
          { summary: '方案已定', products: [{ name: 'plan.md' }, { name: 'big.md' }] },
          { 'plan.md': '# 计划\n正文', 'big.md': 'x'.repeat(2048) },
        );
      }
    };
    // impl 一个硬引用都没写——清单照样得让它看见有得引
    const run = await runToCompletion(chain('按 {{design.artifact.summary}} 实现'), cwd);
    expect(run.state).toBe('completed');
    const ledger = run.nodes['design']!.products!;
    const plan = ledger.find((p) => p.name === 'plan.md')!;
    const implPrompt = ops.prompts.find((p) => p.target.includes('impl'))!.text;
    expect(implPrompt).toContain('【上游命名产物】');
    expect(implPrompt).toContain(`节点「design」：{{artifact:design/plan.md}}（${plan.sha}·`);
    expect(implPrompt).toContain('{{artifact:design/big.md}}');
    expect(implPrompt).toContain('只要结论用 {{节点ID.artifact.summary}} 软引用');
    // 声明位不是暗约定：交接约定文本里就写着 products 怎么填、引擎拿它干什么
    expect(ops.prompts[0]!.text).toContain('products');
  });

  it('上游没产生命名产物=清单零新增，不拿空清单占 token', async () => {
    const cwd = k1Tmp();
    ops.onPrompt = (target) => {
      if (target.includes('design')) writeDesignArtifact(cwd, { summary: '方案已定' });
    };
    const run = await runToCompletion(chain('按 {{design.artifact.summary}} 实现'), cwd);
    expect(run.state).toBe('completed');
    expect(run.nodes['design']!.products).toBeUndefined();
    expect(ops.prompts.some((p) => p.text.includes('【上游命名产物】'))).toBe(false);
  });

  it('破烂声明只披露不拦：节点照 done，未取的件落一句事件，好件照常入台账', async () => {
    const cwd = k1Tmp();
    ops.onPrompt = (target) => {
      if (target.includes('design')) {
        writeDesignArtifact(
          cwd,
          {
            summary: '方案已定',
            products: [{ name: 'plan.md' }, { name: 'ghost.md' }, { name: 'esc', file: '/etc/passwd' }],
          },
          { 'plan.md': '正文' },
        );
      }
    };
    const run = await runToCompletion(chain('按 {{design.artifact.summary}} 实现'), cwd);
    expect(run.state).toBe('completed');
    expect(run.nodes['design']!.state).toBe('done');
    expect(run.nodes['design']!.products).toHaveLength(1);
    const events = (run.events ?? []).map((e) => e.text);
    expect(events.some((t) => t.includes('产物未读到：ghost.md'))).toBe(true);
    expect(events.some((t) => t.includes('产物声明未取：esc'))).toBe(true);
  });

  it('run 级字节上限只拒上架不判节点：超限件 shelved:false + 原因，节点照 done', async () => {
    const smallStore = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-k1-cap-')));
    const smallOps = new FakeHerdrOps();
    const capEngine = new Engine(smallOps, smallStore, { ...OPTS, shelfMaxBytes: 4 });
    const cwd = k1Tmp();
    smallOps.onPrompt = (target) => {
      if (target.includes('design')) {
        writeDesignArtifact(
          cwd,
          { summary: '方案已定', products: [{ name: 'plan.md' }] },
          { 'plan.md': 'x'.repeat(64) },
        );
      }
    };
    const run = await capEngine.startRun(chain('按 {{design.artifact.summary}} 实现'), cwd);
    await waitFor(() => capEngine.getRun(run.runId)!.state !== 'running');
    const final = capEngine.getRun(run.runId)!;
    expect(final.nodes['design']!.state).toBe('done');
    expect(final.nodes['design']!.products![0]!.shelved).toBe(false);
    expect(final.nodes['design']!.products![0]!.shelfError).toContain('over-run-cap');
    expect(fs.existsSync(path.join(smallStore.root, 'shelves', final.runId, 'design', 'plan.md'))).toBe(false);
  });

  it('零约定自动采 diff：git 仓里改了已跟踪文件就有 changes.diff（agent 不用会写声明）', async () => {
    const repo = k1Tmp();
    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);
    ops.onPrompt = (target) => {
      if (target.includes('design')) writeDesignArtifact(repo, { summary: '改完了' }, { 'base.txt': 'base changed' });
    };
    const run = await runToCompletion(chain('按 {{design.artifact.summary}} 实现'), repo);
    expect(run.state).toBe('completed');
    const products = run.nodes['design']!.products!;
    expect(products.map((p) => p.name)).toEqual(['changes.diff']);
    expect(products[0]!.kind).toBe('diff');
    const shelved = fs.readFileSync(path.join(dataDir, 'shelves', run.runId, 'design', 'changes.diff'), 'utf8');
    expect(shelved).toContain('base changed');
    // 同仓的下一节点没声明产物，但工作区那份未提交改动仍在 → 它收口时同样实读到同一 patch：
    // 两枚 sha 相等是「同一份东西被读了两次」的机检口径，不是引擎把账抄了一遍
    expect(run.nodes['impl']!.products).toHaveLength(1);
    expect(run.nodes['impl']!.products![0]!.sha).toBe(products[0]!.sha);
  });

  it('未跟踪新文件不进 diff：台账不拿引擎自造的 patch 冒充账', async () => {
    const repo = k1Tmp();
    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'base']);
    ops.onPrompt = (target) => {
      // 只产新文件（未跟踪），且没声明 products：既没有 patch 也没有声明 → 台账整键缺省
      if (target.includes('design')) writeDesignArtifact(repo, { summary: '只产了新文件' }, { 'new-only.txt': 'x' });
    };
    const run = await runToCompletion(chain('按 {{design.artifact.summary}} 实现'), repo);
    expect(run.state).toBe('completed');
    expect(run.nodes['design']!.products).toBeUndefined();
  });

  it('重试=后一轮覆盖前一轮：台账记的是这一轮实发的那份', async () => {
    const cwd = k1Tmp();
    let round = 0;
    ops.onPrompt = (target) => {
      if (!target.includes('design')) return;
      round += 1;
      if (round === 1) {
        // 第一轮崩在提交途中：盘上留下产物文件但没有 artifact.json（没声明可谈）
        fs.writeFileSync(path.join(cwd, 'plan.md'), '第一轮');
        throw new Error('模拟首轮崩窗');
      }
      writeDesignArtifact(cwd, { summary: '方案已定', products: [{ name: 'plan.md' }] }, { 'plan.md': '第二轮' });
    };
    const g = chain('按 {{design.artifact.summary}} 实现');
    g.nodes[1]!.config.retryCount = 1;
    const run = await runToCompletion(g, cwd);
    expect(run.nodes['design']!.state).toBe('done');
    expect(run.nodes['design']!.attempts).toBe(2);
    expect(run.nodes['design']!.products).toHaveLength(1);
    const shelved = path.join(dataDir, 'shelves', run.runId, 'design', 'plan.md');
    expect(fs.readFileSync(shelved, 'utf8')).toBe('第二轮');
    // 指纹跟着内容走：覆盖后台账记的 sha 属于第二轮那份，不是第一轮
    expect(run.nodes['design']!.products![0]!.sha).toBe(productSha('第二轮'));
  });
});

describe('v14-R5 逐单能力快照（起单现场抄 spec，cap# 进账）', () => {
  /** 走真实落盘读端：注册表用 `RegistryStore`（就是 HTTP 面用的那一支），网关档用 `upsertGatewayProfile` */
  const seed = (spec: Record<string, unknown> = {}) => {
    const res = new RegistryStore(dataDir).add({
      kind: 'model',
      name: 'gpt-4o-mini',
      spec: { model: 'gpt-4o-mini', ...spec },
    });
    if (!res.ok) throw new Error(res.why);
    return res.entry!;
  };
  const gwFree = () =>
    upsertGatewayProfile(dataDir, {
      id: 'free',
      name: '免费档',
      baseUrl: 'https://gw.invalid',
      apiKey: 'sk-secret-永不进快照',
      freeModel: 'gpt-4o-mini',
    });

  /**
   * v14 T1 起快照按 kind 取格。这一格的老账钉的是「网关档 freeModel → model 条目」那条链，
   * 而 T1 把 `node-type` 也迁进了表，于是每一单从此固定多背几枚节点型条目。
   * 按 kind 过滤而不是把三枚 node-type 抄进期望值：期望值里写死出厂清单的成员＝清单改一行、
   * 这里跟着改一次，而那次改动跟这一格要钉的东西毫无关系。
   */
  const refsOf = (run: RunRecord, kind: string) => (run.capabilityRefs ?? []).filter((r) => r.kind === kind);
  /** 本单吃进的节点型（按 id 排，与快照自身的序一致） */
  const nodeTypesIn = (run: RunRecord) => refsOf(run, 'node-type').map((r) => r.id);

  it('生效档 freeModel 命中登记条目 → 快照落册，cap# 与逐条 specSha 自洽', async () => {
    const entry = seed();
    gwFree();
    const run = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    expect(refsOf(run, 'model')).toEqual([
      {
        kind: 'model',
        id: entry.id,
        specSha: contentSha(entry.spec),
        spec: { model: 'gpt-4o-mini' },
        via: ['gateway·freeModel'],
      },
    ]);
    expect(run.capabilitySha).toBe(
      contentSha(run.capabilityRefs!.map(({ kind, id, specSha, spec }) => ({ kind, id, specSha, spec }))),
    );
    // 密钥禁入 spec/快照（R1 边界②）：整份记录里都不该出现那串 apiKey
    expect(JSON.stringify(run.capabilityRefs)).not.toContain('sk-secret');
    // A5-4b-2 的翻面账：`gateway-profile` 进表后，这一单吃的那一档自己也进账（以前那枚裸串只落 `unmigrated` 计数）。
    // 它是**现役能力**这一问的正确答案（钉哪一档就是这一单的能力面之一），但同一张图跨这一刀会有两个 `cap#`——
    // 那一刀是版本带来的，历史单吃自己落册的副本一字不动（上面那两条断言钉的就是这件事）。
    expect(refsOf(run, 'gateway-profile')).toEqual([
      {
        kind: 'gateway-profile',
        id: 'gateway-profile:free',
        specSha: contentSha({ label: '免费档', baseUrl: 'https://gw.invalid', freeModel: 'gpt-4o-mini', keyConfigured: true }),
        spec: { label: '免费档', baseUrl: 'https://gw.invalid', freeModel: 'gpt-4o-mini', keyConfigured: true },
        via: ['gateway·current'],
      },
    ]);
  });

  it('起单之后编辑条目：历史 run 的读数一字不动（v0.1「活行 sha」判死的那条病）', async () => {
    const entry = seed();
    gwFree();
    const run = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    const before = JSON.stringify(run.capabilityRefs);
    const capBefore = run.capabilitySha;
    const upd = new RegistryStore(dataDir).update(entry.id, { spec: { model: 'gpt-4o-mini', note: '起单后才改的备注' } });
    expect(upd.ok).toBe(true);
    expect(JSON.stringify(run.capabilityRefs)).toBe(before);
    expect(run.capabilitySha).toBe(capBefore);
    // 盘上那份也还是起单时的原文——快照不是「读时再去查活行」
    // 按 kind 取而不是数 `[0]`：A5-4b-2 起 `gateway-profile` 也进账，快照按 `kind\0id` 排，
    // 字母序把网关档排在 model 之前——位置是排序的副产品，这一格要钉的是「历史那份没改」。
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'spaces', 'default', 'runs', `${run.runId}.json`), 'utf8'),
    ) as RunRecord;
    expect(refsOf(persisted, 'model')[0]?.spec).toEqual({ model: 'gpt-4o-mini' });
  });

  it('再起一单＝重新现读：编辑后的能力面进新单的 cap#（等臂跨臂变更就此暴露）', async () => {
    const entry = seed();
    gwFree();
    const first = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    new RegistryStore(dataDir).update(entry.id, { spec: { model: 'gpt-4o-mini', note: '换了一版配置' } });
    const second = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    expect(second.capabilitySha).not.toBe(first.capabilitySha);
    expect(refsOf(second, 'model')[0]?.spec).toEqual({ model: 'gpt-4o-mini', note: '换了一版配置' });
    // 同配置连起两单：cap# 相等（等臂第四枚判据的正读数，不受 runId 等噪声影响）
    const third = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    expect(third.capabilitySha).toBe(second.capabilitySha);
  });

  it('停用条目不进快照（enabled=false 不是现役能力）：能力面变窄，但本单仍带着吃进的节点型', async () => {
    const entry = seed();
    gwFree();
    const run = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    expect(refsOf(run, 'model')).toHaveLength(1);
    new RegistryStore(dataDir).update(entry.id, { enabled: false });
    const off = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    expect(refsOf(off, 'model')).toEqual([]);
    // 变空的是 model 那一格，不是整张能力面：节点型条目不受这次停用影响（等臂两臂若只差这一枚停用，cap# 照样不等）
    expect(nodeTypesIn(off).length).toBeGreaterThan(0);
    expect(off.capabilitySha).not.toBe(run.capabilitySha);
  });

  /**
   * T1 之前这一格钉的是「注册表空 → 两键整缺」。今天这条路**走不到了**：每一单的图都有节点型，
   * 而 `node-type` 已迁进表，于是任何一单都至少吃到几枚条目——所以这一格改钉还成立的两件事：
   * 悬挂引用（表里没这一枚）不进快照；整键不给只留给「没走到注册消费面」（今天的形状＝旧 run）。
   * 顺带落一条正向读数：cap# 从此对**任何**一单都可比，不再只在「恰好登记过模型」时才有值。
   */
  it('注册表里没这一枚（悬挂引用）→ 不进快照；本单的节点型照落册（两键整缺只留给没走到快照现场）', async () => {
    gwFree(); // 只有网关档的 freeModel 裸串，注册表空——那枚型号是本单的悬挂引用
    const run = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    expect(refsOf(run, 'model')).toEqual([]);
    expect(nodeTypesIn(run).sort()).toEqual(['node-type:agent', 'node-type:end', 'node-type:start']);
    expect(run.capabilitySha).toBe(
      contentSha(run.capabilityRefs!.map(({ kind, id, specSha, spec }) => ({ kind, id, specSha, spec }))),
    );
  });

  it('只快照本单生效的那一档：别档的 freeModel 不算这单的能力面', async () => {
    const freeEntry = seed(); // model:gpt-4o-mini
    const paidEntry = new RegistryStore(dataDir).add({
      kind: 'model',
      name: 'other-model',
      spec: { model: 'other-model' },
    });
    if (!paidEntry.ok) throw new Error(paidEntry.why);
    // 两档都登记在表、都配了 freeModel——本单钉哪档，能力面就只吃哪档那枚
    upsertGatewayProfile(dataDir, { id: 'paid', name: '付费档', baseUrl: 'https://gw.invalid', apiKey: 'sk-paid', freeModel: 'other-model' });
    gwFree();
    const space = new Store(dataDir, 'default');
    space.writeProfile({ ...space.readProfile(), gatewayProfile: 'free' });
    const run = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    expect(run.harness?.gwProfile).toBe('free');
    expect(refsOf(run, 'model')).toHaveLength(1);
    expect(refsOf(run, 'model')[0]!.id).toBe(freeEntry.id);
    expect(refsOf(run, 'model')[0]!.via).toEqual(['gateway·freeModel']);
    // 换钉付费档再起一单：能力面跟着换一枚（等臂两臂若钉了不同档，cap# 必不等）
    space.writeProfile({ ...space.readProfile(), gatewayProfile: 'paid' });
    const paid = await runToCompletion(serialGraph(), fs.mkdtempSync(path.join(os.tmpdir(), 'pf-r5-')));
    expect(refsOf(paid, 'model').map((r) => r.id)).toEqual([paidEntry.entry!.id]);
  });
});
