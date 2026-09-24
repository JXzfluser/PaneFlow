import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from './builtin-templates.js';
import { CHECK_SPEC_TYPES, DAG_NODE_TYPES, FANOUT_MAX_ITEMS_LIMIT, validateDag } from '@paneflow/shared';
import type { DagGraph, DagNode, DagNodeConfig } from '@paneflow/shared';

/**
 * v13-V0 校验器 fail-closed 判据测试。
 * 旧实现：node.type 与 checks[].type 都不查值（未知类型恒真放行）、fanout 无 maxItems——
 * 配置打错字既不报错也不执行，等于把错念成通过（最便宜的假绿）。
 */

function oneNodeGraph(config: DagNodeConfig, nodeType = 'agent'): DagGraph {
  const nodes: DagNode[] = [
    { id: 'start', type: 'start', label: '开始', config: {} },
    { id: 'n1', type: nodeType as DagNode['type'], label: '节点', config: { prompt: '干活', ...config } },
    { id: 'end', type: 'end', label: '结束', config: {} },
  ];
  return {
    version: 1,
    name: 'v0-validator',
    nodes,
    edges: [
      { id: 'e1', source: 'start', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'end' },
    ],
    metadata: { createdAt: '', updatedAt: '' },
  };
}

const errors = (g: DagGraph) => validateDag(g).filter((i) => i.level === 'error').map((i) => i.message);

describe('v13-V0 校验器值域白名单与扇出上限', () => {
  it('未知 node.type 报错并列出可用值域（旧实现放行：引擎把不认识的类型当结构标记直接标 done）', () => {
    const msgs = errors(oneNodeGraph({ prompt: '干活' }, 'agenta'));
    expect(msgs.some((m) => m.includes('未知节点类型：agenta') && m.includes(DAG_NODE_TYPES.join('/')))).toBe(true);
  });

  it('未知 checks[].type 报错（旧实现放行：检查循环无分支命中 = 静默通过，门禁形同虚设）', () => {
    const g = oneNodeGraph({
      checks: [{ type: 'file-eksists', path: 'a.md' }] as unknown as DagNodeConfig['checks'],
    });
    const msgs = errors(g);
    expect(msgs.some((m) => m.includes('未知检查类型：file-eksists') && m.includes(CHECK_SPEC_TYPES.join('/')))).toBe(true);
  });

  it('合法 node.type / checks[].type 全通过（白名单不得误杀存量语义）', () => {
    const g = oneNodeGraph({
      checks: [
        { type: 'file-exists', path: 'a.md' },
        { type: 'command', run: 'true' },
        { type: 'regex', file: 'a.md', pattern: 'x' },
        { type: 'manual', prompt: '确认' },
        { type: 'contract' },
        { type: 'delivery-branch' },
      ],
    });
    expect(errors(g)).toEqual([]);
  });

  it('fanout maxItems：非整数/0/负/超硬顶一律拒，界内值放行', () => {
    const mk = (maxItems: unknown): string[] =>
      errors(
        oneNodeGraph({ expand: { from: 'plan', field: 'tasks', maxItems } as DagNodeConfig['expand'] }, 'fanout'),
      );
    for (const bad of [0, -1, 1.5, FANOUT_MAX_ITEMS_LIMIT + 1, '8']) {
      expect(mk(bad).some((m) => m.includes('动态扇出上限非法'))).toBe(true);
    }
    expect(mk(1)).toEqual([]);
    expect(mk(FANOUT_MAX_ITEMS_LIMIT)).toEqual([]);
    expect(mk(undefined)).toEqual([]); // 省略=用硬顶，不是非法
  });

  it('内置模板在 fail-closed 之后仍全部过校验（白名单与引擎实处理集同源，不误杀出厂件）', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(errors(t), t.name).toEqual([]);
    }
  });
});
