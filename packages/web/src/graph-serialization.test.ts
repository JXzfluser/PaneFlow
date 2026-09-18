import { describe, expect, it } from 'vitest';
import type { DagGraph } from '@paneflow/shared';
import { autosaveChanged, graphToRfParts, rfToGraph, type AutosaveFields } from './graph-serialization.js';

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
