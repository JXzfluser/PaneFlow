import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';
import { Engine } from './engine.js';
import type { ApprovalAction, EngineOptions } from './engine.js';
import { Store } from './store.js';

import { FakeHerdrOps } from './fake-ops.js';

const OPTS: EngineOptions = {
  workspaceLabelPrefix: 'paneflow-',
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
        { id: 'fork', type: 'fanout', label: '动态展开', config: { expand: { from: 'plan', field: 'tasks' } } },
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

  it('recoverOrphans reclaims workspaces from previous dead runs', async () => {
    await ops.createWorkspace('paneflow-deadbeef', '/tmp');
    await ops.createWorkspace('unrelated', '/tmp');
    const reclaimed = await engine.recoverOrphans();
    expect(reclaimed).toHaveLength(1);
    expect(ops.workspaces.has('w2')).toBe(true);
    expect(ops.workspaces.has('w1')).toBe(false);
  });
});
