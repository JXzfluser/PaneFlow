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

/**
 * v13-K1 命名产物硬引用的静态判据（V0 同款姿态：结「引用没解析也照样绿」的假绿，不是造新绿）。
 * 运行时解析不到=节点即时失败；这一层把「一眼看得出引错了」的场合提前到起单/存模板。
 */
describe('v13-K1 硬引用图校验', () => {
  const chain = (implPrompt: string): DagGraph => ({
    version: 1,
    name: 'k1-refs',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      { id: 'design', type: 'agent', label: '设计', config: { prompt: '出方案' } },
      { id: 'impl', type: 'agent', label: '实现', config: { prompt: implPrompt } },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'design' },
      { id: 'e2', source: 'design', target: 'impl' },
      { id: 'e3', source: 'impl', target: 'end' },
    ],
    metadata: { createdAt: '', updatedAt: '' },
  });

  it('引用图外节点=拒（旧语义：裸花括号原样进 prompt、节点照 done）', () => {
    const msgs = errors(chain('按 {{artifact:ghost/plan.md}} 实现'));
    expect(msgs.some((m) => m.includes('本图无节点「ghost」') && m.includes('artifact:'))).toBe(true);
  });

  it('引用本节点自己的产物=拒（同一轮收口前台账必空，放开=引用必失败）', () => {
    expect(errors(chain('按 {{artifact:impl/plan.md}} 实现')).some((m) => m.includes('指向本节点自己'))).toBe(true);
  });

  it('引用上游节点=过；克隆前缀 design__2（fanout 展开后的运行期节点）也认，不误杀', () => {
    expect(errors(chain('按 {{artifact:design/plan.md}} 实现'))).toEqual([]);
    expect(errors(chain('按 {{artifact:design__2/plan.md}} 实现'))).toEqual([]);
  });
});

/**
 * v14-T3 模板带槽：`requires` 的形状在**写入面**就拒（与预检共用 `requirementIssueOf` 一把尺）。
 * 姿态：脏声明正常进不到盘面（PUT /api/graphs 走 validateDag），但盘面手改得动，
 * 所以读端预检还要再过一次同一把尺——两把尺就会「预检说全绿、起单当场红」。
 */
describe('v14-T3 requires 槽声明形状', () => {
  const withRequires = (requires: unknown): string[] =>
    errors({ ...oneNodeGraph({ prompt: '干活' }), requires } as DagGraph);

  it('省略 = 不判（存量模板零新增，不因为新增字段集体变红）', () => {
    expect(validateDag(oneNodeGraph({ prompt: '干活' }))).toEqual([]);
    expect(withRequires([])).toEqual([]);
  });

  it('合法项放行：kind 必填，id/hint 可选', () => {
    expect(withRequires([{ kind: 'model' }, { kind: 'skill', id: 'skills/x/SKILL.md', hint: '要能读图' }])).toEqual([]);
  });

  it('非数组 / 未知键 / 空 kind / id-hint 非字符串一律拒，且报错说清只认哪三个键', () => {
    expect(withRequires('model').some((m) => m.includes('requires 必须是数组'))).toBe(true);
    const msgs = withRequires([
      { knd: 'model' },
      { kind: '  ' },
      { kind: 'model', id: 42 },
      { kind: 'model', hint: '' },
    ]);
    expect(msgs[0]).toContain('含未知键 knd');
    expect(msgs[0]).toContain('kind/id/hint');
    expect(msgs.filter((m) => m.includes('缺 kind'))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes('需是非空字符串或不给'))).toHaveLength(2);
    expect(msgs.every((m) => m.startsWith('requires['))).toBe(true); // 带下标，作者才知道改哪一格
  });
});

/**
 * v13-K2 否决回边的形状关（写入面 fail-closed）。
 * 回边是这张图里唯一能改动「已完成节点」的机制：一条写歪的边＝夜跑里停不下来的回路，
 * 所以判据全在写入面掐死——放行的图必须「条件说得清、两端都能干、方向指得对、且不跟动态展开打架」。
 */
describe('v13-K2 否决回边形状', () => {
  const GO = { field: 'extra.decision', equals: 'reject' };
  /** start → build → review → end；回边默认 review → build（合法形状） */
  const loop = (rejectEdge?: Partial<DagGraph['edges'][number]> | null): DagGraph => ({
    version: 1,
    name: 'k2-shape',
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
      ...(rejectEdge === null
        ? []
        : [{ id: 'er', source: 'review', target: 'build', reject: true, condition: GO, ...rejectEdge }]),
    ],
    metadata: { createdAt: '', updatedAt: '' },
  });

  it('合法回边=过，而且**不算环**（回边不进环检测，否则这形状永远画不出来）', () => {
    expect(errors(loop())).toEqual([]);
  });

  it('不带 condition=拒：没有断言就是恒打回，那是拿封顶当设计', () => {
    const msgs = errors(loop({ condition: undefined }));
    expect(msgs.some((m) => m.includes('打回边必须带 condition') && m.includes('恒打回'))).toBe(true);
  });

  it('reject 破烂值=拒（图可以不走画布直接 POST，`"yes"` 不许靠猜生效）', () => {
    expect(errors(loop({ reject: 'yes' as unknown as boolean })).some((m) => m.includes('reject 只能是 true 或 false'))).toBe(true);
  });

  it('reject:false 是正身声明「这不是回边」=按普通前向边放行', () => {
    expect(errors(loop({ id: 'e4', source: 'build', target: 'end', reject: false, condition: undefined }))).toEqual([]);
  });

  it('端点不是 Agent=拒（否决要有产物可依据、被拒方要能重跑）', () => {
    const g = loop();
    g.nodes = g.nodes.map((n) => (n.id === 'review' ? { ...n, type: 'fanin' as const, config: {} } : n));
    expect(errors(g).some((m) => m.includes('打回的两端都得是 Agent 节点'))).toBe(true);
  });

  it('方向指反=拒：打回必须指向前置环节（下游不是审查方的上游，拒不动它）', () => {
    const msgs = errors({
      ...loop(),
      edges: loop().edges.map((e) => (e.id === 'er' ? { ...e, source: 'build', target: 'review' } : e)),
    });
    expect(msgs.some((m) => m.includes('打回必须指向前置环节'))).toBe(true);
  });

  it('挂在动态扇出的展开子树里=拒（展开会重写子树的边，回边届时指向不存在的分支模板节点）', () => {
    const g = loop();
    g.nodes = g.nodes.map((n) => (n.id === 'build' ? { ...n, type: 'fanout' as const, config: { expand: { from: 'review', field: 'tasks' } } } : n));
    expect(errors(g).some((m) => m.includes('动态扇出的展开子树'))).toBe(true);
  });

  it('rejectLimit 越界=拒并说清值域（1..5；省略=默认 2）', () => {
    const withLimit = (v: unknown): string[] => {
      const g = loop();
      g.nodes = g.nodes.map((n) => (n.id === 'build' ? { ...n, config: { ...n.config, rejectLimit: v as number } } : n));
      return errors(g);
    };
    expect(withLimit(0).some((m) => m.includes('打回上限非法') && m.includes('1..5'))).toBe(true);
    expect(withLimit(6).some((m) => m.includes('打回上限非法'))).toBe(true);
    expect(withLimit(1.5).some((m) => m.includes('打回上限非法'))).toBe(true);
    expect(withLimit(3)).toEqual([]);
  });

  it('真画成正向环仍然拒，且文案指路改用回边（回边不是「绕开无环要求」的后门）', () => {
    const g = loop(null);
    g.edges.push({ id: 'ec', source: 'review', target: 'build' });
    const msgs = errors(g);
    expect(msgs.some((m) => m.includes('图中存在环') && m.includes('打回请用回边 reject'))).toBe(true);
  });
});
