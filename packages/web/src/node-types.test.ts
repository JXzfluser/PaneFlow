import { describe, expect, it } from 'vitest';
import { DAG_NODE_TYPES, NODE_TYPE_CATALOG, NODE_TYPE_GROUPS, type NodeTypeRegistrySpec, type RegistryEntry } from '@paneflow/shared';
import { paletteGroups } from './node-types';
import type { RegistryEntryView } from './registry-view';

/** 一条 server 发来的画法条目（`spec` 就是 `NODE_TYPE_CATALOG` 那一形状） */
const nodeType = (name: string, spec: NodeTypeRegistrySpec, over: Partial<RegistryEntry> = {}): RegistryEntryView => ({
  id: `node-type:${name}`,
  kind: 'node-type',
  name,
  source: 'builtin',
  enabled: true,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  spec,
  label: typeof spec.label === 'string' ? spec.label : name,
  view: true,
  ...over,
});

/** 一条能拖的画法（缺省=start 那枚）；`over` 按 `unknown` 吃，才能演「server 发了坏形状」 */
const drawSpec = (over: Record<string, unknown> = {}): NodeTypeRegistrySpec => ({
  label: '开始',
  icon: '▶',
  group: 'basic' as const,
  order: 3,
  ...over,
} as unknown as NodeTypeRegistrySpec);

/** 出厂清单原样当成 server 的读数（成员表在这里是**被测的输入**，不是页面的第二份事实源） */
const asServerReadout = () => NODE_TYPE_CATALOG.map((e) => nodeType(e.type, e));

const typesOf = (group: string, reading: ReturnType<typeof paletteGroups>) =>
  reading.groups.find((g) => g.group === group)?.nodes.map((n) => n.type) ?? [];

/**
 * v14 T1：这一页能拖出哪几型，由 server 的注册表说了算。
 *
 * 全部断言都吃**传进来的条目**，唯独最后一条吃 `undefined`/`[]`——那条才是这枚改动的立身之本：
 * 读不到就是空读数，**绝不拿本 bundle 的清单兜底**。兜一次，第二份事实源就回来了，而那正是 T1
 * 要拆掉的东西（只断言「六型在」分不出「真读到」与「回落兜底」，两者长得一模一样）。
 */
describe('v14 T1 画布节点面板读数（成员从 server 注册表来，不在 web 存一份）', () => {
  it('出厂六型逐型上架：按 NODE_TYPE_GROUPS 分段、组内按 spec.order（不是台账 id 序）', () => {
    const reading = paletteGroups(asServerReadout());
    expect(reading.unusable).toEqual([]);
    // 分组顺序 = shared 那份分组顺序，不是条目数组里出现的顺序
    expect(reading.groups.map((g) => g.group)).toEqual([...NODE_TYPE_GROUPS]);
    // 画法序：agent(1) pipeline(2) | start(3) end(4) | fanout(5) fanin(6)
    expect(typesOf('core', reading)).toEqual(['agent', 'pipeline']);
    expect(typesOf('basic', reading)).toEqual(['start', 'end']);
    expect(typesOf('advanced', reading)).toEqual(['fanout', 'fanin']);
    // 按钮文字与 hover 文案都取 server 字段，不在这里再写一遍
    const agent = reading.groups[0]!.nodes[0]!;
    expect(agent).toEqual({ type: 'agent', label: 'Agent 节点', icon: '⚙', hint: expect.any(String), group: 'core', order: 1 });
    expect(agent.hint).toBe(NODE_TYPE_CATALOG.find((e) => e.type === 'agent')!.hint);
    // 分组标题取 shared 词表（这一枚是页面自带的渲染能力，不是成员表）
    expect(reading.groups.map((g) => g.label)).toEqual(['核心', '基础节点', '高级节点']);
  });

  it('台账序 ≠ 画法序：条目倒着来也照样按 order 排（id 序会把「结束」排在「开始」前）', () => {
    const reading = paletteGroups([
      nodeType('end', drawSpec({ label: '结束', icon: '⏹', order: 4 })),
      nodeType('start', drawSpec()),
    ]);
    expect(typesOf('basic', reading)).toEqual(['start', 'end']);
    // 同 order 时按机器值稳定排（不给「同序谁前」留随机性）
    const same = paletteGroups([nodeType('end', drawSpec({ order: 1 })), nodeType('start', drawSpec({ order: 1 }))]);
    expect(typesOf('basic', same)).toEqual(['end', 'start']);
  });

  it('空组不出标题：某一类今天没货就不占一行（缺是读数，不是报错）', () => {
    const reading = paletteGroups([nodeType('agent', drawSpec({ label: 'Agent 节点', group: 'core', order: 1 }))]);
    expect(reading.groups).toHaveLength(1);
    expect(reading.groups[0]!.group).toBe('core');
  });

  it('停用那一型：进 unusable 说清「启用才能拖」，不画成能拖的按钮', () => {
    const reading = paletteGroups([
      nodeType('agent', drawSpec({ label: 'Agent 节点', group: 'core', order: 1 }), { enabled: false }),
      nodeType('start', drawSpec()),
    ]);
    expect(reading.groups.flatMap((g) => g.nodes).map((n) => n.type)).toEqual(['start']);
    expect(reading.unusable).toEqual([{ name: 'agent', why: expect.stringContaining('被停用了') }]);
  });

  /**
   * server 比页面新（清单加了一型、这个 bundle 还没跟上）：这一型**不能**被 cast 上画布——
   * 画出来的节点本页面不认得，属性面板也是半瞎。进 unusable 明说是页面版本落后。
   */
  it('这一型服务端认识、页面还不认识：不 cast 上画布，逐条挂出原因', () => {
    expect(DAG_NODE_TYPES as readonly string[]).not.toContain('loop');
    const reading = paletteGroups([nodeType('loop', drawSpec({ group: 'advanced', order: 7 }))]);
    expect(reading.groups).toEqual([]);
    expect(reading.unusable).toEqual([{ name: 'loop', why: expect.stringContaining('这个页面还不认识') }]);
  });

  it('画法字段读不出就逐条说清缺哪一键（没有默认值可猜，也不就近并进某一档）', () => {
    const cases: [NodeTypeRegistrySpec, string][] = [
      [drawSpec({ label: '  ' }), '没有 label'],
      [drawSpec({ icon: '' }), '没有 icon'],
      [drawSpec({ group: 'c0re' }), '分组值不认识'],
      [drawSpec({ order: '3' }), '没有 order'],
      [drawSpec({ order: NaN }), '没有 order'],
    ];
    for (const [spec, why] of cases) {
      const reading = paletteGroups([nodeType('start', spec)]);
      expect(reading.groups, JSON.stringify(spec)).toEqual([]);
      expect(reading.unusable[0]!.why, JSON.stringify(spec)).toContain(why);
    }
    // 一塌糊涂时首条原因是「按哪一条去修」的指路：label 先报（缺名连按钮都写不出来）
    expect(paletteGroups([nodeType('start', {} as unknown as NodeTypeRegistrySpec)]).unusable[0]!.why).toContain('没有 label');
  });

  it('hint 不是字符串就当没有（server 加键不炸页面，也不跟着涨按钮）', () => {
    const reading = paletteGroups([nodeType('start', drawSpec({ hint: 42 }))]);
    expect(reading.groups[0]!.nodes[0]!.hint).toBe('');
    // 没给 hint 同样是空串：不给默认文案，「这句解释没有」也是正读数
    expect(paletteGroups([nodeType('start', drawSpec())]).groups[0]!.nodes[0]!.hint).toBe('');
  });

  it('还没读到 / 读到空表 = 空读数：不回落本 bundle 的清单（这条拆的正是第二份事实源）', () => {
    for (const entries of [undefined, []]) {
      expect(paletteGroups(entries)).toEqual({ groups: [], unusable: [] });
    }
    // 与「真读到六枚就是六枚」不冲突：空是「没读到」，不是「读到零」
    expect(paletteGroups(asServerReadout()).groups.flatMap((g) => g.nodes)).toHaveLength(NODE_TYPE_CATALOG.length);
  });
});
