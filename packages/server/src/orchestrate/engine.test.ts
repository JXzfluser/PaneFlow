import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';
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
      if (target.includes('fb')) {
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
      if (target.includes('fb')) {
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
      if (target.includes('fa')) {
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

  it('verify 断言有 fail 时机器判据把关：终审节点检查不过 → run 失败', async () => {
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
    await waitFor(() => engine.getRun(run.runId)!.state !== 'running', 30_000);
    const final = engine.getRun(run.runId)!;
    expect(final.state).toBe('failed'); // onFail:abort 的终审把整个 run 判死
    expect(final.nodes['verify']!.state).toBe('failed');
    // R6a：verify 重试过（retries≥1），全程无 usage 自报 → tokens=null（unknown，非 0）
    expect(final.cost!.retries).toBeGreaterThanOrEqual(1);
    expect(final.cost!.tokens).toBeNull();
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
