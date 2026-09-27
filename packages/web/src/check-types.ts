/**
 * v14 A5-4 画布属性面板「检查门禁」那一节的读数件（**成员从 server 的注册表来，不在这里存一份**）。
 *
 * 与 `node-types.ts` 同一条边界：这一格能加哪几型机检，今天由 `GET /api/registry?kind=check-type` 说了算，
 * 那张表的成员住在 `shared/dag.ts: CHECK_TYPE_CATALOG`（与值域 `CHECK_SPEC_TYPES`、机检账
 * `MACHINE_CHECK_TYPES` 同源）。这里只留两样本 bundle 自带的东西：
 *  - **怎么起一份空机检**（`blankCheck`）——那是 TS 判别联合的形状，执行面与判别联合按 §一 的决议留在代码里，
 *    注册表发的是画法（叫什么、解释什么、引擎实跑还是人看一眼），不是这一份；
 *  - **分组词表**（`引擎实跑`/`人看一眼` 那两枚措辞由 server 的 label 给，这里不重列）。
 * 一枚 server 发来、本 bundle 还起不出形状的机检类型（server 比页面新）一律进 `unusable` 明说，
 * 绝不 `as` 一下塞进 `checks[]`：画出来的那一格属性面板渲不出输入框，人只能看着它填不进东西。
 */
import { CHECK_SPEC_TYPES, type CheckSpec, type CheckSpecType } from '@paneflow/shared';
import type { RegistryEntryView } from './registry-view.js';

/** 一颗「+加这一型机检」的按钮 */
export interface CheckTypeButton {
  type: CheckSpecType;
  /** 按钮文字（server 的 `spec.label`） */
  label: string;
  /** 这一型问的是什么（hover 那句；server 必填，所以读到空串就是画法脏，走 `unusable`） */
  hint: string;
  /** 引擎实跑得动＝进机检账（server 的 `spec.machine`，不是这里推的） */
  machine: boolean;
}

export interface CheckTypeReading {
  buttons: CheckTypeButton[];
  /** 读不出画法、因此加不了的条目：`why` 是要挂在界面上的那句人话 */
  unusable: { name: string; why: string }[];
}

const KNOWN_TYPES = new Set<string>(CHECK_SPEC_TYPES);

/**
 * 各型的一份空机检长什么样。**按值域全键声明**（`Record<CheckSpecType, …>`）：
 * 联合里加一类而这里不补一行 = 编译期红，与 shared 那几张表同一招。
 * `contract`/`delivery-branch` 起出来就没有必填参数（契约盖戳与期望分支都可缺），
 * 所以那两枚是空对象——这不是省事，是那两型自己说的。
 */
const BLANK_CHECK: Record<CheckSpecType, () => CheckSpec> = {
  'file-exists': () => ({ type: 'file-exists', path: '' }),
  command: () => ({ type: 'command', run: '' }),
  regex: () => ({ type: 'regex', file: '', pattern: '' }),
  manual: () => ({ type: 'manual', prompt: '' }),
  contract: () => ({ type: 'contract' }),
  'delivery-branch': () => ({ type: 'delivery-branch' }),
};

/** 加一型机检时的初值；这一型这里起不出形状就返回 `null`（调用方不画按钮，因此正常走不到） */
export function blankCheck(type: string): CheckSpec | null {
  const make = (BLANK_CHECK as Partial<Record<string, () => CheckSpec>>)[type];
  return make ? make() : null;
}

/**
 * 条目 → 按钮列表（保持 server 发来的顺序：值域序，稳定）。三件事分家：
 *  - 画法读得出、本 bundle 也起得出形状 → 按钮；
 *  - 被停用的条目进 `unusable`（出厂清单今天不会停用谁，但这一格判据与 `node-types.ts` 同形，不例外）；
 *  - `entries` 传 `undefined`（还没读到/读失败）→ **空读数**，调用方自己画指路文案：
 *    这里绝不拿 `CHECK_SPEC_TYPES` 兜出一份清单，那正是这一片要拆掉的第二份事实源。
 */
export function checkTypeButtons(entries: RegistryEntryView[] | undefined): CheckTypeReading {
  const buttons: CheckTypeButton[] = [];
  const unusable: { name: string; why: string }[] = [];
  for (const entry of entries ?? []) {
    if (entry.enabled === false) {
      unusable.push({ name: entry.name, why: '这一型在清单里被停用了（启用它才能加）' });
      continue;
    }
    if (!KNOWN_TYPES.has(entry.name) || !blankCheck(entry.name)) {
      unusable.push({ name: entry.name, why: '这一型服务端认识、这个页面还不认识（页面比服务端旧），不加它' });
      continue;
    }
    const spec = entry.spec as { label?: unknown; hint?: unknown; machine?: unknown };
    const label = typeof spec?.label === 'string' ? spec.label.trim() : '';
    const hint = typeof spec?.hint === 'string' ? spec.hint.trim() : '';
    if (!label) {
      unusable.push({ name: entry.name, why: '配置详情里没有 label（按钮该写什么，没有默认名可猜）' });
      continue;
    }
    if (!hint) {
      unusable.push({ name: entry.name, why: '配置详情里没有 hint（这一型问的是什么，不猜一句文案糊上去）' });
      continue;
    }
    if (typeof spec.machine !== 'boolean') {
      unusable.push({ name: entry.name, why: '配置详情里没有 machine 标（分不清引擎实跑还是要人看一眼，不去加它）' });
      continue;
    }
    buttons.push({ type: entry.name as CheckSpecType, label, hint, machine: spec.machine });
  }
  return { buttons, unusable };
}
