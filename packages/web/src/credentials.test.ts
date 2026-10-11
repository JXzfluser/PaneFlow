import { describe, expect, it } from 'vitest';
import type { DagGraph, NodeRunRecord, RunRecord } from '@paneflow/shared';
import { buildCredentialLines, credTerminalState, type ShelfInfo } from './credentials.js';

function graphWithChecks(checksPerNode: Record<string, number>): DagGraph {
  const nodes = Object.entries(checksPerNode).map(([id, n]) => ({
    id,
    type: 'agent' as const,
    label: `节点${id}`,
    config: {
      agentKind: 'claude',
      prompt: '干活',
      checks: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, type: 'command' as const, run: 'test -f x' })),
    },
  }));
  return {
    version: 1,
    name: 'cred-test',
    nodes,
    edges: [],
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  };
}

function runStub(partial: Partial<RunRecord> & { graph: DagGraph }): RunRecord {
  return partial as unknown as RunRecord;
}

const doneNodes = (ids: string[]): Record<string, NodeRunRecord> =>
  Object.fromEntries(ids.map((id) => [id, { nodeId: id, state: 'done', attempts: 1, startedAt: '', finishedAt: '' }]));

describe('v19-R5 验收凭据行（纯读既有字段，缺键明说不省略）', () => {
  it('机检全过：items 正读数 + 跳时间线', () => {
    const run = runStub({ graph: graphWithChecks({ a: 2, b: 1 }), nodes: doneNodes(['a', 'b']) });
    const [mc] = buildCredentialLines(run, undefined);
    expect(mc!.text).toBe('机检 3 项实跑全过');
    expect(mc!.jump).toBe('timeline');
  });

  it('无机检=正读数 0 项，不是「拿不到」', () => {
    const run = runStub({ graph: graphWithChecks({ a: 0 }), nodes: doneNodes(['a']) });
    const [mc] = buildCredentialLines(run, undefined);
    expect(mc!.text).toContain('没装机检项');
  });

  it('图与账对不上：机检行明说拿不到，不画 0', () => {
    const run = runStub({ graph: graphWithChecks({ a: 1 }), nodes: {} });
    const [mc] = buildCredentialLines(run, undefined);
    expect(mc!.text).toContain('拿不到');
  });

  it('产物：加载中/空架/上架计数三态各说各话', () => {
    const run = runStub({ graph: graphWithChecks({ a: 0 }), nodes: {} });
    const loading = buildCredentialLines(run, undefined)[1]!;
    expect(loading.text).toContain('读取中');
    const empty = buildCredentialLines(run, { exists: false, files: [] } satisfies ShelfInfo)[1]!;
    expect(empty.text).toBe('这单没落过产物文件');
    const shelf: ShelfInfo = {
      exists: true,
      files: [
        { name: 'plan.md', source: 'shelf', sha: 'a1b2c3' },
        { name: 'raw.log', source: 'workspace' },
        { name: 'big.bin', source: 'workspace', shelved: false },
      ],
    };
    const full = buildCredentialLines(run, shelf)[1]!;
    expect(full.text).toBe('产物 3 件 · 1 件已上架 · ⚠ 1 件没上架（sha 可点验）');
    expect(full.jump).toBe('shelf');
  });

  it('人等分：有账给分秒与门计数，缺账明说没有这份账', () => {
    const run = runStub({ graph: graphWithChecks({ a: 0 }), nodes: {} });
    const withWait = buildCredentialLines(
      runStub({ graph: run.graph, nodes: run.nodes, attention: { waitMs: 252_000, gates: { approve: 2, reject: 0, input: 1 } } }),
      undefined,
    )[3]!;
    expect(withWait.text).toBe('全程你等待 4.2 分 · 批 2/驳 0/补料 1');
    const longWait = buildCredentialLines(
      runStub({ graph: run.graph, nodes: run.nodes, attention: { waitMs: 42_000_000, gates: { approve: 3, reject: 1, input: 0 } } }),
      undefined,
    )[3]!;
    expect(longWait.text).toContain('11.7 小时');
    const noWait = buildCredentialLines(run, undefined)[3]!;
    expect(noWait.text).toContain('没有等待账');
  });

  it('外部动作：逐面拼句 + PR 单走外链', () => {
    const run = runStub({ graph: graphWithChecks({ a: 0 }), nodes: {} });
    const one = buildCredentialLines(
      runStub({ graph: run.graph, nodes: run.nodes, sideEffects: { issuesCreated: [12], issuePatched: [7], pushedAt: '2026-10-11T08:30:00.000Z' } }),
      undefined,
    )[4]!;
    expect(one.text).toBe('外部动作：建单 #12 · 覆写 #7 · 已推送 2026-10-11 08:30');
    expect(one.jump).toBe('timeline');
    const withPr = buildCredentialLines(
      runStub({ graph: run.graph, nodes: run.nodes, sideEffects: { prUrl: 'https://github.com/o/r/pull/1' } }),
      undefined,
    )[4]!;
    expect(withPr.jump).toBe('pr');
    const emptyObj = buildCredentialLines(runStub({ graph: run.graph, nodes: run.nodes, sideEffects: {} }), undefined)[4]!;
    expect(emptyObj.text).toBe('没有对外部系统的写账');
    const missing = buildCredentialLines(run, undefined)[4]!;
    expect(missing.text).toContain('或模板没报');
  });

  it('打回：有账给总数与最近一笔，无账不冒充零返工', () => {
    const run = runStub({ graph: graphWithChecks({ a: 0 }), nodes: {} });
    const reworked = runStub({
      graph: run.graph,
      nodes: {
        a: {
          nodeId: 'a', state: 'done', attempts: 2, startedAt: '', finishedAt: '',
          rejections: [{ at: '2026-10-11T08:00:00.000Z', attempt: 1, reviewer: 'rev', action: 'rework' }],
        },
      },
    });
    const line = buildCredentialLines(reworked, undefined)[5]!;
    expect(line.text).toBe('被打回 1 次（最近：rev 否决）');
    const clean = buildCredentialLines(run, undefined)[5]!;
    expect(clean.text).toContain('零返工，或这是账本上线前的旧单');
  });

  it('装备：有账汇总实注与告警，缺账明说没有这份账', () => {
    const run = runStub({ graph: graphWithChecks({ a: 0 }), nodes: {} });
    const noEquipLedger = buildCredentialLines(run, undefined)[2]!;
    expect(noEquipLedger.text).toContain('没有装备账');
    expect(noEquipLedger.jump).toBeNull();

    const mixed = runStub({
      graph: run.graph,
      nodes: {
        a: {
          nodeId: 'a',
          state: 'done',
          attempts: 1,
          startedAt: '',
          finishedAt: '',
          equip: { scope: 'role', role: 'r-impl', skills: ['s1', 's2'], rules: ['docs/x.md'], model: 'gpt-4o' },
        },
        b: {
          nodeId: 'b',
          state: 'done',
          attempts: 1,
          startedAt: '',
          finishedAt: '',
          equip: { scope: 'space', role: 'r-x', skills: ['a', 'b', 'c'], rules: [] },
        },
      },
    });
    const line = buildCredentialLines(mixed, undefined)[2]!;
    expect(line.text).toBe('实注 技能 5 · 岗位文档 1 · 2 岗 · 模型 gpt-4o · ⚠ 1 格岗未配装备吃全量');
    expect(line.title).toContain('· a 技能 2 · 文档 1 · 岗 r-impl · 模型 gpt-4o');
    expect(line.title).toContain('· b 技能 3 · 文档 0（⚠ 岗未配装备，吃项目全量） · 岗 r-x');
    expect(line.jump).toBe('timeline');

    // 旧账只有 unknownSkills，新账逐格带 why：两种写法都归进同一个「没落地」计数
    const oldLedger = runStub({
      graph: run.graph,
      nodes: {
        a: {
          nodeId: 'a',
          state: 'done',
          attempts: 1,
          startedAt: '',
          finishedAt: '',
          equip: { scope: 'role', role: 'r', skills: [], rules: [], unknownSkills: ['ghost'] },
        },
      },
    });
    expect(buildCredentialLines(oldLedger, undefined)[2]!.text).toBe(
      '实注 技能 0 · 岗位文档 0 · 1 岗 · ⚠ 1 格装备没落地',
    );
    const newMiss = runStub({
      graph: run.graph,
      nodes: {
        a: {
          nodeId: 'a',
          state: 'done',
          attempts: 1,
          startedAt: '',
          finishedAt: '',
          equip: {
            scope: 'role',
            role: 'r',
            skills: ['s'],
            rules: [],
            misses: [
              { axis: 'skill', slot: 'ghost', why: '不在登记清单' },
              { axis: 'rule', slot: 'docs/gone.md', why: '文件读不到' },
            ],
          },
        },
      },
    });
    const missLine = buildCredentialLines(newMiss, undefined)[2]!;
    expect(missLine.text).toContain('⚠ 2 格装备没落地');
    expect(missLine.title).toContain('没落地 2 格');
  });

  it('凭据卡只在收口态出现', () => {
    expect(credTerminalState('completed')).toBe(true);
    expect(credTerminalState('completed-with-failures')).toBe(true);
    expect(credTerminalState('failed')).toBe(true);
    expect(credTerminalState('cancelled')).toBe(true);
    expect(credTerminalState('running')).toBe(false);
    expect(credTerminalState('queued')).toBe(false);
  });
});
