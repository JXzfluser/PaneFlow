import { describe, expect, it } from 'vitest';
import { applyVariables, lintUnresolvedRefs, validateDag } from '@paneflow/shared';
import type { DagGraph } from '@paneflow/shared';

function varGraph(): DagGraph {
  return {
    version: 1,
    name: 'issue-flow',
    variables: [
      { key: 'issue_id', label: '主 Issue', required: true },
      { key: 'version', label: '版本', default: 'v0.1.0' },
    ],
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      {
        id: 'dev',
        type: 'agent',
        label: '处理 {{issue_id}}',
        config: {
          agentKind: 'pi',
          prompt: '处理 Issue {{issue_id}}，分支 feature/{{version}}-{{issue_id}}。参考 {{start.artifact.summary}}。',
          cwd: 'repos/order',
        },
      },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'dev' },
      { id: 'e2', source: 'dev', target: 'end' },
    ],
    metadata: { createdAt: '', updatedAt: '' },
  };
}

describe('applyVariables', () => {
  it('substitutes declared variables into every string field', () => {
    const { graph, missing } = applyVariables(varGraph(), { issue_id: '162' });
    expect(missing).toEqual([]);
    const dev = graph.nodes.find((n) => n.id === 'dev')!;
    expect(dev.label).toBe('处理 162');
    expect(dev.config.prompt).toContain('Issue 162');
    expect(dev.config.prompt).toContain('feature/v0.1.0-162'); // default filled
  });

  it('leaves blackboard node references untouched', () => {
    const { graph } = applyVariables(varGraph(), { issue_id: '162' });
    const dev = graph.nodes.find((n) => n.id === 'dev')!;
    expect(dev.config.prompt).toContain('{{start.artifact.summary}}');
  });

  it('reports missing required variables and does not mutate', () => {
    const g = varGraph();
    const before = JSON.stringify(g);
    const { missing } = applyVariables(g, {});
    expect(missing).toEqual(['主 Issue']);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('variable keys are distinct from node ids in resolution order', () => {
    const g = varGraph();
    g.nodes[0]!.id = 'issue_id'; // adversarial: node id equals a variable key
    const { graph } = applyVariables(g, { issue_id: '162' });
    // variable substitution happens first; node ref resolution later keeps the
    // qualified form intact because it has a dot path
    const dev = graph.nodes.find((n) => n.id === 'dev')!;
    expect(dev.config.prompt).toContain('Issue 162');
  });

  it('resulting graph still passes DAG validation', () => {
    const { graph } = applyVariables(varGraph(), { issue_id: '162' });
    expect(validateDag(graph).filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('lintUnresolvedRefs（G2 引用失败可见）', () => {
  it('报告未声明裸变量与不存在节点引用，放行真实节点引用与 item 绑定', () => {
    const g = varGraph();
    const dev = g.nodes.find((n) => n.id === 'dev')!;
    dev.config.prompt += ' 还有 {{ghost.artifact.summary}} 与 {{nope}}，条目 {{item.name}} 正常。';
    g.metadata.description = '描述里漏了 {{also_missing}}';
    const found = lintUnresolvedRefs(applyVariables(g, { issue_id: '162' }).graph);
    expect(found.map((u) => `${u.where}=${u.ref}`).sort()).toEqual([
      'dev.config.prompt={{ghost.artifact.summary}}',
      'dev.config.prompt={{nope}}',
      'metadata.description={{also_missing}}',
    ]);
  });

  it('同字段同一引用只报一次；已声明变量替换后不再触发', () => {
    const g = varGraph();
    const dev = g.nodes.find((n) => n.id === 'dev')!;
    dev.config.prompt = '{{issue_id}} 与 {{issue_id}} 再与 {{start.output}}';
    const found = lintUnresolvedRefs(applyVariables(g, { issue_id: '162' }).graph);
    expect(found).toEqual([]); // issue_id 已替换、start 是真实节点
  });

  it('run_id 未声明时残留会被抓（声明了才由引擎注入替换）', () => {
    const g = varGraph();
    const dev = g.nodes.find((n) => n.id === 'dev')!;
    dev.config.cwd = 'pf/{{run_id}}';
    expect(lintUnresolvedRefs(applyVariables(g, { run_id: 'abc', issue_id: '1' }).graph)).toEqual([
      { where: 'dev.config.cwd', ref: '{{run_id}}' },
    ]);
    const declared: DagGraph = { ...g, variables: [...(g.variables ?? []), { key: 'run_id', label: '运行编号' }] };
    expect(lintUnresolvedRefs(applyVariables(declared, { run_id: 'abc', issue_id: '1' }).graph)).toEqual([]);
  });
});
