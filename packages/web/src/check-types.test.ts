import { describe, expect, it } from 'vitest';
import {
  CHECK_SPEC_TYPES,
  CHECK_TYPE_CATALOG,
  MACHINE_CHECK_TYPES,
  type CheckTypeRegistrySpec,
  type RegistryEntry,
} from '@paneflow/shared';
import { blankCheck, checkTypeButtons } from './check-types';
import type { RegistryEntryView } from './registry-view';

/** 一条 server 来的画法条目（`spec` 就是 `CHECK_TYPE_CATALOG` 那一形状） */
const checkType = (name: string, spec: CheckTypeRegistrySpec, over: Partial<RegistryEntry> = {}): RegistryEntryView => ({
  id: `check-type:${name}`,
  kind: 'check-type',
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

/** 一条能加的画法（缺省=command 那枚）；`over` 按 `unknown` 吃，才能演「server 发了坏形状」 */
const drawSpec = (over: Record<string, unknown> = {}): CheckTypeRegistrySpec =>
  ({ label: '跑命令', hint: '跑一条命令，退出码 0 才算过', machine: true, ...over }) as unknown as CheckTypeRegistrySpec;

/** 出厂清单原样当成 server 的读数（成员表在这里是**被测的输入**，不是页面的第二份事实源） */
const asServerReadout = () => CHECK_TYPE_CATALOG.map((e) => checkType(e.type, e));

/**
 * v14 A5-4：属性面板「检查门禁」那一节能加哪几型，由 server 的注册表说了算。
 *
 * 与 `node-types.test.ts` 同一条底线：全部断言吃**传进来的条目**，只有最后一条吃 `undefined`/`[]`——
 * 读不到就是空读数，**绝不拿本 bundle 的 `CHECK_SPEC_TYPES` 兜一份清单**。兜一次，第二份事实源就回来了。
 * 这一格另外钉一件 A5-4 特有的事：`contract` 与 `delivery-branch` 从此在画布上**加得出来**
 * （引擎认得它们，而旧面板那四枚硬编码按钮里从来没有这两位）。
 */
describe('v14 A5-4 检查门禁读数（成员从 server 注册表来，不在 web 存一份）', () => {
  it('出厂六型逐型成按钮：文字/解释/机检口径都取 server 字段', () => {
    const reading = checkTypeButtons(asServerReadout());
    expect(reading.unusable).toEqual([]);
    expect(reading.buttons.map((b) => b.type)).toEqual(CHECK_TYPE_CATALOG.map((e) => e.type));
    for (const row of CHECK_TYPE_CATALOG) {
      const b = reading.buttons.find((x) => x.type === row.type)!;
      expect(b).toEqual({ type: row.type, label: row.label, hint: row.hint, machine: row.machine });
    }
    // 这两型是这一片的净新增：以前硬编码四枚按钮里根本没有它们
    expect(reading.buttons.map((b) => b.type)).toEqual(expect.arrayContaining(['contract', 'delivery-branch']));
  });

  it('机检/人一眼的划线与账本同源：`machine` 照 server 发来的，不在这里按类型名推', () => {
    const reading = checkTypeButtons(asServerReadout());
    expect(reading.buttons.filter((b) => b.machine).map((b) => b.type).sort()).toEqual([...MACHINE_CHECK_TYPES].sort());
    expect(reading.buttons.find((b) => b.type === 'manual')!.machine).toBe(false);
  });

  it('每一型都起得出空机检；起不出的型（server 比页面新）不 cast 进 checks[]', () => {
    for (const type of CHECK_SPEC_TYPES) expect(blankCheck(type)).not.toBeNull();
    expect(blankCheck('loop-check')).toBeNull();
    // 空值的形状由本 bundle 负责（判别联合是页面自带的渲染能力，不是成员表）
    expect(blankCheck('command')).toEqual({ type: 'command', run: '' });
    expect(blankCheck('contract')).toEqual({ type: 'contract' });
    expect(blankCheck('delivery-branch')).toEqual({ type: 'delivery-branch' });
  });

  it('停用那一型：进 unusable 说清「启用才能加」，不画成按钮', () => {
    const reading = checkTypeButtons([
      checkType('command', drawSpec(), { enabled: false }),
      checkType('file-exists', drawSpec({ label: '文件存在', hint: '要有这个文件' })),
    ]);
    expect(reading.buttons.map((b) => b.type)).toEqual(['file-exists']);
    expect(reading.unusable).toEqual([{ name: 'command', why: expect.stringContaining('被停用了') }]);
  });

  it('这一型服务端认识、页面还不认识：不加它，逐条挂出原因', () => {
    expect(CHECK_SPEC_TYPES as readonly string[]).not.toContain('loop-check');
    const reading = checkTypeButtons([checkType('loop-check', drawSpec({ label: '循环检查' }))]);
    expect(reading.buttons).toEqual([]);
    expect(reading.unusable).toEqual([{ name: 'loop-check', why: expect.stringContaining('这个页面还不认识') }]);
  });

  it('画法字段读不出就逐条说清缺哪一键（没有默认值可猜，也不去猜机检口径）', () => {
    const cases: [CheckTypeRegistrySpec, string][] = [
      [drawSpec({ label: '  ' }), '没有 label'],
      [drawSpec({ hint: '' }), '没有 hint'],
      [drawSpec({ machine: 'true' }), '没有 machine 标'],
      [drawSpec({ machine: undefined }), '没有 machine 标'],
    ];
    for (const [spec, why] of cases) {
      const reading = checkTypeButtons([checkType('command', spec)]);
      expect(reading.buttons, JSON.stringify(spec)).toEqual([]);
      expect(reading.unusable[0]!.why, JSON.stringify(spec)).toContain(why);
    }
    // 一塌糊涂时首条原因是「先补哪一枚键」的指路：label 先报（连按钮写什么都无从谈起）
    expect(checkTypeButtons([checkType('command', {} as unknown as CheckTypeRegistrySpec)]).unusable[0]!.why).toContain('没有 label');
  });

  it('还没读到 / 读到空表 = 空读数：不回落本 bundle 的清单（这一片拆的正是那份）', () => {
    for (const entries of [undefined, []]) {
      expect(checkTypeButtons(entries)).toEqual({ buttons: [], unusable: [] });
    }
    // 「没读到」与「读到就是这六枚」是两件事，界面上前者画指路文案、后者画按钮
    expect(checkTypeButtons(asServerReadout()).buttons).toHaveLength(CHECK_TYPE_CATALOG.length);
  });
});
