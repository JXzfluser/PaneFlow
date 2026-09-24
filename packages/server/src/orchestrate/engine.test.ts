import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import { execFileSync } from 'node:child_process';
import { Engine } from './engine.js';
import type { ApprovalAction, EngineOptions } from './engine.js';
import { BUILTIN_TEMPLATES } from './builtin-templates.js';
import { contentSha } from './harness.js';
import { upsertGatewayProfile } from '../api/gateway.js';
import { Store } from './store.js';

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
    expect(wtPath).toContain('paneflow-wt');
    // 运行结束：完成 + worktree 回收（分支引用保留、目录移除）——fake 环境毫秒级完成，中途存在性断言有竞态
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('completed');
    expect(final.nodes['b']!.worktree).toBe(wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'paneflow/*']).toString();
    expect(branches).toContain('paneflow/');
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
    await waitFor(() => fs.existsSync(file));
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
