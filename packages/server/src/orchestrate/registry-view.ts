import {
  normalizeRegistryEntry,
  registryId,
  REGISTRY_VIEW_KINDS,
  NODE_TYPE_CATALOG,
  type RegistryEntry,
} from '@paneflow/shared';
import { AGENT_KINDS, agentBinaryName } from '../api/agent-kinds.js';

/**
 * v14 A3-2（R3）：**视图 kind** 的现算清单——条目由代码里的出厂数据算出来，`entries.json` 里永远没有它们。
 *
 * 为什么要这一层，而不是把 18 枚 agent 类型一次性 `add` 进盘：
 *  - **只有一份事实源**（前置-1 合一的那张表就是它）。搬进盘＝同一件事两处存，改代码那片从此不再生效，
 *    而它才是真正决定「能不能起这个 agent」的地方；
 *  - **删/禁用没有意义**：出厂清单里没有的 kind 本机跑不了，用户把视图条目禁了也拦不住节点配置里写它。
 *    与其给一个不生效的开关，不如整条不接（写入面拒，见 `RegistryStore.add`）。
 *
 * 视图条目**不填时刻**是不可能的（信封要求字符串），所以这里给的是**本机进程启动时刻**，
 * 含义如实：「这台机器这次运行从什么时候开始看见这一项」。它不是登记时刻——出厂项没有登记时刻，
 * 界面与文案都不拿它当登记账（`source:'builtin'` 已经说了出处）。取一次进程级常量而不是每次 `new Date()`：
 * 每条请求都抖一下的读数没法比较，也就没法当断言。
 */
const BOOT_AT = new Date().toISOString();

/** 现算一组成员条目；抛错＝出厂数据本身脏（编程错，不是用户数据错），让它响 */
type ViewBuilder = () => RegistryEntry[];

function agentKindEntries(): RegistryEntry[] {
  return AGENT_KINDS.map((kind) => {
    const raw = {
      id: registryId('agent-kind', kind),
      kind: 'agent-kind' as const,
      name: kind,
      source: 'builtin' as const,
      enabled: true,
      createdAt: BOOT_AT,
      updatedAt: BOOT_AT,
      spec: { binary: agentBinaryName(kind) },
    };
    const norm = normalizeRegistryEntry(raw);
    if (!norm.ok) throw new Error(`出厂 agent 清单算出了不合法的条目（${kind}）：${norm.why}`);
    return norm.value;
  });
}

/**
 * `node-type`（v14 T1）：画布值域那张清单的渲版。这里**不新增事实**——`type/label/icon/group/hint`
 * 全部原样取自 `NODE_TYPE_CATALOG`，条目只是给它套上注册表信封（id、来源、引用账才因此接得上）。
 * 清单本身脏（少一枚类型、组名拼错）在这里会以 `normalizeRegistryEntry` 不合法的形式炸出来：
 * 那是编程错，不是用户数据错，抛出去比渲半张表诚实。
 */
function nodeTypeEntries(): RegistryEntry[] {
  return NODE_TYPE_CATALOG.map((row) => {
    const raw = {
      id: registryId('node-type', row.type),
      kind: 'node-type' as const,
      name: row.type,
      source: 'builtin' as const,
      enabled: true,
      createdAt: BOOT_AT,
      updatedAt: BOOT_AT,
      spec: {
        label: row.label,
        icon: row.icon,
        group: row.group,
        order: row.order,
        ...(row.hint ? { hint: row.hint } : {}),
      },
    };
    const norm = normalizeRegistryEntry(raw);
    if (!norm.ok) throw new Error(`出厂节点类型清单算出了不合法的条目（${row.type}）：${norm.why}`);
    return norm.value;
  });
}

/**
 * kind → 现算函数。表本身 mapped over `REGISTRY_VIEW_KINDS`：**挂号了却没 builders = 编译期红，
 * 反之多写了没挂号的 builder 也是**（shared 的 `SPEC_PARSERS`/`REGISTRY_DESCRIPTORS` 同一招）。
 */
const VIEW_BUILDERS: { [K in (typeof REGISTRY_VIEW_KINDS)[number]]: ViewBuilder } = {
  'agent-kind': agentKindEntries,
  'node-type': nodeTypeEntries,
};

/** 全部视图条目（本次调用现算，不缓存：出厂清单是编译期常量，重算一次 18 个对象比缓存判据便宜） */
export function registryViewEntries(): RegistryEntry[] {
  return Object.values(VIEW_BUILDERS).flatMap((build) => build());
}

/** 视图 kind 的写入面文案（`add`/`update`/`remove` 三处共用一句，不在三处各写一遍）。
 *  判据本身在 shared（`isRegistryViewKind`）——这里只出文案，不开第二份清单。 */
export function viewKindWriteWhy(action: string, kind: string): string {
  return (
    `「${kind}」是 PaneFlow 的内置能力清单（出厂项），${action}不了它：` +
    '这一类的成员与配置由版本决定，注册表不代造本机没有的东西，也不给用户造一个关掉就好的假开关。'
  );
}
