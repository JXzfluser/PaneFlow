import { describe, expect, it } from 'vitest';
import type { DagGraph } from '@paneflow/shared';
import { autosaveChanged, autoLayout, graphToRfParts, rfToGraph, type AutosaveFields } from './graph-serialization.js';

/** R1 验收：graph → 画布 → graph 往返，字段零丢失（R1.1/R1.2/R1.3） */
function richGraph(): DagGraph {
  return {
    version: 1,
    name: 'rich',
    variables: [
      { key: 'issue_id', label: '主 Issue', required: true },
      { key: 'version', label: '版本', default: 'v0.1.0' },
    ],
    nodes: [
      { id: 'start', type: 'start', label: '开始', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'dev',
        type: 'agent',
        label: '开发',
        position: { x: 200, y: 0 },
        config: {
          agentKind: 'claude',
          prompt: '处理 {{issue_id}}',
          checks: [{ type: 'file-exists', path: 'ok.txt' }],
          env: { ANTHROPIC_MODEL: 'auto/best-free' },
        },
      },
      { id: 'fork', type: 'fanout', label: '展开', position: { x: 400, y: 0 }, config: { expand: { from: 'plan', field: 'extra.tasks', onEmpty: 'fallback' } } },
      { id: 'end', type: 'end', label: '结束', position: { x: 600, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'dev' },
      { id: 'e2', source: 'dev', target: 'fork', condition: { field: 'aligned', equals: 'true' } },
      { id: 'e3', source: 'fork', target: 'end' },
    ],
    metadata: {
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      description: '富字段往返样例',
    },
  };
}

describe('graph round-trip (R1 数据完整性)', () => {
  it('variables 经画布往返零丢失（R1.1）', () => {
    const g = richGraph();
    const parts = graphToRfParts(g);
    const back = rfToGraph({ name: g.name, nodes: parts.nodes, edges: parts.edges, variables: parts.variables, meta: parts.meta });
    expect(back.variables).toEqual(g.variables);
  });

  it('边条件往返零丢失（R1.2）', () => {
    const g = richGraph();
    const parts = graphToRfParts(g);
    // 画布层可见条件
    expect(parts.edges[1]!.data?.condition).toEqual({ field: 'aligned', equals: 'true' });
    const back = rfToGraph({ name: g.name, nodes: parts.nodes, edges: parts.edges, variables: parts.variables, meta: parts.meta });
    expect(back.edges[1]!.condition).toEqual(g.edges[1]!.condition);
    // 无条件边不凭空长出条件
    expect(back.edges[0]!.condition).toBeUndefined();
  });

  it('metadata 保真：createdAt 不重置、description 不丢（R1.3）', () => {
    const g = richGraph();
    const parts = graphToRfParts(g);
    const back = rfToGraph({ name: g.name, nodes: parts.nodes, edges: parts.edges, variables: parts.variables, meta: parts.meta });
    expect(back.metadata.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(back.metadata.description).toBe('富字段往返样例');
    expect(back.metadata.updatedAt).toBeTruthy();
  });

  it('节点 config 深字段（checks/env/expand）往返零丢失', () => {
    const g = richGraph();
    const parts = graphToRfParts(g);
    const back = rfToGraph({ name: g.name, nodes: parts.nodes, edges: parts.edges, variables: parts.variables, meta: parts.meta });
    const dev = back.nodes.find((n) => n.id === 'dev')!;
    expect(dev.config.checks).toEqual(g.nodes[1]!.config.checks);
    expect(dev.config.env).toEqual(g.nodes[1]!.config.env);
    const fork = back.nodes.find((n) => n.id === 'fork')!;
    expect(fork.config.expand).toEqual(g.nodes[2]!.config.expand);
  });

  /**
   * v14-T3：`requires` 是作者手写、画布画不出来的字段——正是 R1 那类事故的现场
   * （「画布只认识 UI 能渲染的东西，其余静默丢弃」）。这一条钉住「打开→保存」不洗掉声明。
   */
  it('requires 经画布往返零丢失；没带槽的模板回写不凭空长出空数组', () => {
    const g = { ...richGraph(), requires: [{ kind: 'model', id: 'gpt-4o-mini' }, { kind: 'skill', hint: '要能读图' }] } as DagGraph;
    const parts = graphToRfParts(g);
    expect(parts.requires).toEqual(g.requires); // 打开时就带着，不等保存才发现
    const back = rfToGraph({
      name: g.name,
      nodes: parts.nodes,
      edges: parts.edges,
      variables: parts.variables,
      meta: parts.meta,
      requires: parts.requires,
    });
    expect(back.requires).toEqual(g.requires);
    // 旧模板（无 requires）往返后仍是「没带槽」，不是 `requires: []`
    const plain = graphToRfParts(richGraph());
    expect(plain.requires).toEqual([]);
    const round = rfToGraph({ name: 'rich', nodes: plain.nodes, edges: plain.edges, variables: plain.variables, meta: plain.meta });
    expect(round.requires).toBeUndefined();
  });

  /**
   * v13-K2 打回线也是「画布画不出来的字段」那一类：UI 不给它一个开关之前，
   * 先保证「在画布中打开 → 保存」不把作者手写的 reject 洗成普通依赖。
   */
  it('reject 回边标记经画布往返零丢失；取消标记回写不落 false', () => {
    const base = richGraph();
    const g: DagGraph = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: 'check', type: 'agent', label: '复核', position: { x: 500, y: 80 }, config: { prompt: '审' } },
      ],
      edges: [
        ...base.edges,
        { id: 'e4', source: 'dev', target: 'check' },
        { id: 'e5', source: 'check', target: 'dev', reject: true, condition: { field: 'extra.decision', equals: 'reject' } },
      ],
    };
    const parts = graphToRfParts(g);
    const line = parts.edges.find((e) => e.id === 'e5')!;
    expect(line.data?.reject).toBe(true);
    expect(line.data?.condition).toEqual({ field: 'extra.decision', equals: 'reject' });
    const back = rfToGraph({ name: g.name, nodes: parts.nodes, edges: parts.edges, variables: parts.variables, meta: parts.meta });
    expect(back.edges.find((e) => e.id === 'e5')).toEqual({
      id: 'e5',
      source: 'check',
      target: 'dev',
      condition: { field: 'extra.decision', equals: 'reject' },
      reject: true,
    });
    // 面板上取消勾选 → 回写「没这键」，不是一堆 reject:false 的噪音
    const off = rfToGraph({
      name: g.name,
      nodes: parts.nodes,
      edges: parts.edges.map((e) => (e.id === 'e5' ? { ...e, data: { ...e.data, reject: undefined } } : e)),
      variables: parts.variables,
      meta: parts.meta,
    });
    expect('reject' in (off.edges.find((e) => e.id === 'e5') ?? {})).toBe(false);
  });

  it('autoLayout 遇到回边不死循环（深度只按前向边算；旧写法会把画布卡死）', () => {
    // 无 position 的图才会走兜底布局；回边构成环，深度取最大值且持续放宽 → 旧实现转不完
    const g: DagGraph = {
      version: 1,
      name: 'loop-layout',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'build', type: 'agent', label: '实现', config: { prompt: '写' } },
        { id: 'review', type: 'agent', label: '质检', config: { prompt: '审' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'build' },
        { id: 'e2', source: 'build', target: 'review' },
        { id: 'e3', source: 'review', target: 'end' },
        { id: 'er', source: 'review', target: 'build', reject: true, condition: { field: 'extra.decision', equals: 'reject' } },
      ],
      metadata: { createdAt: '', updatedAt: '' },
    };
    const layout = autoLayout(g);
    expect(Object.keys(layout)).toHaveLength(4);
    // build 排在 review 左边：回边没把 build 的深度顶到 review 之后
    expect(layout.build!.x).toBeLessThan(layout.review!.x);
  });

  it('缺少 metadata 的 graph 不抛异常（API 客户端/旧版本落盘的运行）', () => {
    const g = richGraph() as DagGraph;
    delete (g as { metadata?: unknown }).metadata;
    expect(() => graphToRfParts(g)).not.toThrow();
    const parts = graphToRfParts(g);
    expect(parts.meta.createdAt).toBeUndefined();
    expect(parts.meta.description).toBeUndefined();
    // 兜底后仍能正常回写（createdAt 由 rfToGraph 补当前时间）
    const back = rfToGraph({ name: g.name, nodes: parts.nodes, edges: parts.edges, variables: parts.variables, meta: parts.meta });
    expect(back.metadata.createdAt).toBeTruthy();
  });
});

/** G3：自动保存守卫六字段引用比较 */
describe('autosaveChanged (G3 变更检测)', () => {
  function base(): AutosaveFields {
    return { graphName: 'g', cwd: '/tmp', nodes: [], edges: [], graphVariables: [], graphMeta: {} };
  }

  it('六字段同引用 → 不保存', () => {
    const s = base();
    expect(autosaveChanged(s, s)).toBe(false);
  });

  it('仅换 graphVariables 引用 → 保存（旧守卫漏判项）', () => {
    const prev = base();
    const next = { ...prev, graphVariables: [{ key: 'k' }] };
    expect(autosaveChanged(prev, next)).toBe(true);
  });

  it('仅换 graphMeta 引用 → 保存（旧守卫漏判项）', () => {
    const prev = base();
    const next = { ...prev, graphMeta: { description: '改了吗' } };
    expect(autosaveChanged(prev, next)).toBe(true);
  });

  it('nodes/edges/cwd/graphName 各自换引用 → 保存', () => {
    const prev = base();
    expect(autosaveChanged(prev, { ...prev, nodes: [{}] })).toBe(true);
    expect(autosaveChanged(prev, { ...prev, edges: [{}] })).toBe(true);
    expect(autosaveChanged(prev, { ...prev, cwd: '/other' })).toBe(true);
    expect(autosaveChanged(prev, { ...prev, graphName: 'other' })).toBe(true);
  });
});
