import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import { execFileSync } from 'node:child_process';
import { Engine } from './engine.js';
import type { ApprovalAction, EngineOptions } from './engine.js';
import { BUILTIN_TEMPLATES } from './builtin-templates.js';
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
    // onFail=continue → pipeline completes, end node done
    expect(run.state).toBe('completed');
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
    expect(run.state).toBe('completed');
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
