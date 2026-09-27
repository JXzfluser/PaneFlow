import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import { Engine, type EngineOptions } from './engine.js';
import { FakeHerdrOps } from './fake-ops.js';
import { Store } from './store.js';

/**
 * v13-K2 打回回路（裁决问题 9 点头后的执行片）：图允许**指向已完成节点的否决回边**，
 * 拓扑仍确定、attempt 动态 +1、每次打回落 `rejections` 账。
 *
 * 这一份测试要钉住的不是「能重跑」（重跑本身不难），而是三件容易各自成立、合起来才叫回路的东西：
 * ①回边**不是依赖**（builder 不等 review，算进拓扑就是环）；
 * ②封顶真的封得住（无界的自动改图＝夜跑烧穿配额），且封顶**不是成功**（v11-D3 不洗绿）；
 * ③等臂可比性零扰动（`ctxSha`/`skeletonSha` 不许因为「这单被打回过」而变——
 *   打回理由进的是 prompt 运行时文本，不是实读文件装备，那本账是 ctxSha 的、不是它的）。
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

/** 执行 → 质检 → 结束，外加一条 review→build 的否决回边（判据写在审查产物上） */
function loopGraph(opts?: { rejectLimit?: number; verdict?: (n: number) => 'reject' | 'pass' }): DagGraph {
  const limit = opts?.rejectLimit;
  return {
    version: 1,
    name: 'k2-loop',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      { id: 'build', type: 'agent', label: '实现', config: { agentKind: 'fake', prompt: '写代码', ...(limit ? { rejectLimit: limit } : {}) } },
      { id: 'review', type: 'agent', label: '质检', config: { agentKind: 'fake', prompt: '审 {{build.artifact.summary}}' } },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'build' },
      { id: 'e2', source: 'build', target: 'review' },
      { id: 'e3', source: 'review', target: 'end' },
      {
        id: 'e-rej',
        source: 'review',
        target: 'build',
        reject: true,
        condition: { field: 'extra.decision', equals: 'reject' },
      },
    ],
    metadata: { createdAt: '', updatedAt: '' },
  };
}

let ops: FakeHerdrOps;
let store: Store;
let engine: Engine;
let cwd: string;

beforeEach(() => {
  ops = new FakeHerdrOps();
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-k2-')));
  engine = new Engine(ops, store, OPTS);
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-k2-cwd-'));
});

const promptsTo = (nodeId: string): string[] =>
  ops.prompts.filter((p) => p.target.includes(`-${nodeId}-`)).map((p) => p.text);

/** 质检每轮写自己的产物：`verdict` 决定第几轮放行（引擎在尝试收口时实读这份文件） */
function scriptReview(
  verdict: (round: number) => 'reject' | 'pass',
  body: (round: number) => Record<string, unknown> = () => ({}),
): void {
  let round = 0;
  ops.onPrompt = (target) => {
    if (!target.includes('-review-')) return;
    round += 1;
    const dir = path.join(cwd, '.herdr/artifacts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'review.json'),
      JSON.stringify({ extra: { decision: verdict(round), ...body(round) } }),
    );
  };
}

async function settle(runId: string): Promise<RunRecord> {
  for (let i = 0; i < 600 && engine.getRun(runId)!.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return engine.getRun(runId)!;
}

const run = async (graph: DagGraph): Promise<RunRecord> =>
  settle((await engine.startRun(graph, cwd)).runId);

describe('v13-K2 否决回边', () => {
  it('第一轮被拒→打回重跑→第二轮放行：拓扑仍确定、账落被拒方、理由进重跑 prompt', async () => {
    scriptReview((n) => (n === 1 ? 'reject' : 'pass'), () => ({ reason: '缺回归测试' }));
    const r = await run(loopGraph());

    expect(r.state).toBe('completed');
    // 回边不是依赖：builder 先跑，review 才有的可审（拓扑序里 review 永远在 build 之后）
    expect(promptsTo('build')).toHaveLength(2);
    expect(promptsTo('review')).toHaveLength(2);
    // 账落在**被拒方**：谁被拒、谁欠账（abandonments 同款卫生，不靠环形事件反推）
    expect(r.nodes.build!.rejections).toEqual([
      { at: expect.any(String), attempt: 1, reviewer: 'review', reason: '缺回归测试', action: 'rework' },
    ]);
    // 「重试带上下文」现路：第二轮指令里有那句否决原话，第一轮没有
    expect(promptsTo('build')[0]).not.toContain('【打回】');
    expect(promptsTo('build')[1]).toContain('【打回】');
    expect(promptsTo('build')[1]).toContain('缺回归测试');
    expect((r.events ?? []).some((e) => e.text.includes('否决回边成立'))).toBe(true);
    expect(r.nodes.review!.state).toBe('done');
    expect(r.nodes.end!.state).toBe('done');
  });

  it('放行就不产生任何打回账（存量语义一字不变：缺键 ≠ 零次 ≠ 空数组）', async () => {
    scriptReview(() => 'pass');
    const r = await run(loopGraph());
    expect(r.state).toBe('completed');
    expect(promptsTo('build')).toHaveLength(1);
    expect('rejections' in r.nodes.build!).toBe(false);
  });

  it('封顶真的封得住：第 N+1 次否决不再重跑，被拒方按 failed 收口（有否决没解决就不是成功）', async () => {
    scriptReview(() => 'reject', (n) => ({ reason: `第 ${n} 轮的理由` }));
    const r = await run(loopGraph({ rejectLimit: 1 }));

    expect(promptsTo('build')).toHaveLength(2); // 1 次原生 + 1 次打回，到此为止
    expect(r.nodes.build!.rejections?.map((x) => x.action)).toEqual(['rework', 'capped']);
    expect(r.nodes.build!.state).toBe('failed');
    expect(r.nodes.build!.error).toContain('打回上限 1 次已达');
    // 封顶那次照样落账，理由带得上（否则「拒过两次」在账上只看得见一次）
    expect(r.nodes.build!.rejections?.[1]!.reason).toBe('第 2 轮的理由');
    // v11-D3：带失败收口，不洗绿
    expect(r.state).toBe('completed-with-failures');
  });

  it('默认上限 2 次：不写 rejectLimit 也有顶（无界自动改图=夜跑烧穿配额）', async () => {
    scriptReview(() => 'reject', () => ({ reason: '总是不行' }));
    const r = await run(loopGraph());
    expect(promptsTo('build')).toHaveLength(3); // 1 原生 + 2 打回
    expect(r.nodes.build!.rejections).toHaveLength(3);
    expect(r.nodes.build!.state).toBe('failed');
  });

  it('打回连带下游：build 重跑时吃了它产物的 review 也回到待跑，不留上一版的旧结论', async () => {
    scriptReview((n) => (n === 1 ? 'reject' : 'pass'), () => ({ reason: '重来' }));
    const r = await run(loopGraph());
    expect(r.state).toBe('completed');
    // 结构性证据：review 也被重跑过（它的旧 done 真被作废了，不是只重跑了 build 一个点）
    expect(promptsTo('review')).toHaveLength(2);
    // 收口时读的是重跑那一版的产物：黑板与 rec.artifact 都跟着重置过
    expect(r.nodes.review!.artifact?.extra?.decision).toBe('pass');
  });

  it('理由没写就明说没写（不拿被审方的产物冒充审查方的意见）', async () => {
    scriptReview((n) => (n === 1 ? 'reject' : 'pass')); // 只有 decision，没有 reason/summary
    const r = await run(loopGraph());
    const rej = r.nodes.build!.rejections?.[0];
    expect(rej && 'reason' in rej).toBe(false); // 整键缺省，不塞空串冒充读数
    expect(promptsTo('build')[1]).toContain('未写理由');
  });

  it('等臂零扰动：ctxSha / skeletonSha 不因「这单被打回过」而变，injectedBytes 如实涨', async () => {
    scriptReview(() => 'pass');
    const clean = await run(loopGraph());
    scriptReview((n) => (n === 1 ? 'reject' : 'pass'), () => ({ reason: '缺回归测试' }));
    const looped = await run(loopGraph());

    expect(looped.harness?.ctxSha).toBe(clean.harness?.ctxSha);
    expect(looped.harness?.skeletonSha).toBe(clean.harness?.skeletonSha);
    // 打回理由确实进了上下文——它记在 injectedBytes 那本账上，不记在指纹上
    expect((looped.harness?.injectedBytes ?? 0)).toBeGreaterThan(clean.harness?.injectedBytes ?? 0);
  });

  it('并发兄弟在飞时检测到的打回不当半场重置：等所有尝试收口才动手（否则同一路径双跑）', async () => {
    // build → {review, side} 并行；review 打回 build，而 side 还在跑
    const graph = loopGraph();
    graph.nodes.push({ id: 'side', type: 'agent', label: '旁支', config: { agentKind: 'fake', prompt: '旁支活' } });
    graph.edges.push({ id: 'e4', source: 'build', target: 'side' });
    graph.edges.push({ id: 'e5', source: 'side', target: 'end' });
    ops.promptDelayMs = 60; // side 与 review 真并行，制造「review 收口时 side 还在飞」
    scriptReview((n) => (n === 1 ? 'reject' : 'pass'), () => ({ reason: '并行也得等' }));
    const r = await run(graph);

    expect(r.state).toBe('completed');
    // 每个被打回子树的成员恰好跑两轮：没有「重置两次 = 跑三轮」，也没有「半途重置 = 双跑」
    for (const id of ['build', 'review', 'side']) expect(promptsTo(id)).toHaveLength(2);
    expect(r.nodes.build!.rejections?.map((x) => x.action)).toEqual(['rework']);
  });
});
