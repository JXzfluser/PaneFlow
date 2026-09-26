/**
 * v14 T1 画布节点面板的读数件（**成员从 server 的注册表来，不在这里存一份**）。
 *
 * 一句话边界：这一页能拖出哪几型节点，今天由 `GET /api/registry?kind=node-type` 说了算——
 * 那张表的成员住在 `shared/dag.ts: NODE_TYPE_CATALOG`（与画布值域、`validateDag` 同源），
 * web 只是把它渲成按钮。所以「注册进来一型，画布上就拖得出来」这条是**可证的**：
 * 清单加一行，这里一行都不用动。
 *
 * 那这里为什么还 import shared？拿的是**词表与分组顺序**（分组叫什么、谁先谁后）和
 * `DagNodeType` 那枚联合——这些是本页面自带的渲染能力，不是「有哪些类型」那份成员表。
 * 一枚 server 发来的、这个 bundle 还不认识的类型（server 比页面新），一律进 `unusable` 明说，
 * 绝不 cast 一下拖上画布：画出来的节点本页面不认得，属性面板也是半瞎。
 */
import {
  DAG_NODE_TYPES,
  NODE_TYPE_GROUPS,
  NODE_TYPE_GROUP_LABELS,
  type DagNodeType,
  type NodeTypeGroup,
} from '@paneflow/shared';
import type { RegistryEntryView } from './registry-view.js';

/** 一个能拖的按钮 */
export interface PaletteNode {
  type: DagNodeType;
  /** 按钮文字（server 的 `spec.label`） */
  label: string;
  icon: string;
  /** hover 那句解释；清单没给就是空串（不给默认文案——没有解释也是正读数） */
  hint: string;
  group: NodeTypeGroup;
  /** 组内次序（server 的 `spec.order`，小的在前） */
  order: number;
}

/** 画布侧栏的一组按钮 */
export interface PaletteGroup {
  group: NodeTypeGroup;
  /** 分组标题（`NODE_TYPE_GROUP_LABELS`） */
  label: string;
  nodes: PaletteNode[];
}

/** 读不出画法、因此不给拖的条目：`why` 是要挂在界面上的那句人话 */
export interface UnusableNodeType {
  name: string;
  why: string;
}

export interface PaletteReading {
  groups: PaletteGroup[];
  unusable: UnusableNodeType[];
}

const KNOWN_TYPES = new Set<string>(DAG_NODE_TYPES);
const KNOWN_GROUPS = new Set<string>(NODE_TYPE_GROUPS);

/** 一条画法读数：读得出来是 `node`，读不出来是 `why`（人话，逐条挂到界面上） */
type NodeReading = { node: PaletteNode } | { why: string };

/** spec 按 `unknown` 逐键窄化：server 日后加键不该把页面炸红，也不该被就近并进某一档 */
function readNode(entry: RegistryEntryView): NodeReading {
  const spec = entry.spec as { label?: unknown; icon?: unknown; group?: unknown; order?: unknown; hint?: unknown };
  const label = typeof spec?.label === 'string' ? spec.label.trim() : '';
  const icon = typeof spec?.icon === 'string' ? spec.icon.trim() : '';
  const group = typeof spec?.group === 'string' ? spec.group : '';
  const order = typeof spec?.order === 'number' && Number.isFinite(spec.order) ? spec.order : null;
  const bad = (why: string): NodeReading => ({ why });
  // 本 bundle 的节点类型联合里没有它：画布与属性面板都不知道怎么渲，拖出来就是一格空白
  if (!KNOWN_TYPES.has(entry.name)) return bad('这一型服务端认识、这个页面还不认识（页面比服务端旧），不去拖它');
  if (!label) return bad('配置详情里没有 label（按钮该写什么，没有默认名可猜）');
  if (!icon) return bad('配置详情里没有 icon');
  if (!KNOWN_GROUPS.has(group)) return bad('分组值不认识（侧栏不知道该把它放哪一段）');
  if (order === null) return bad('配置详情里没有 order（组内次序不猜）');
  return {
    node: {
      type: entry.name as DagNodeType,
      label,
      icon,
      hint: typeof spec?.hint === 'string' ? spec.hint.trim() : '',
      group: group as NodeTypeGroup,
      order,
    },
  };
}

/**
 * 条目 → 侧栏分组。三件事分开处理，混一件就是假账：
 *  - 读得出画法的按 `NODE_TYPE_GROUPS` 顺序分组、组内按 `spec.order` 排（同值再按机器值，稳）；
 *  - 读不出画法的进 `unusable`（界面逐条挂出原因，不静默丢）；
 *  - 空组不出标题（「这一类今天没货」注册中心那一页已经说了，不必在拖拽面板占一行）。
 * `entries` 传 `undefined`（还没读到/读失败）时只给空读数，调用方自己画占位——
 * 这里**绝不拿本 bundle 的清单兜底**，那正是这份文件要拆掉的第二份事实源。
 */
export function paletteGroups(entries: RegistryEntryView[] | undefined): PaletteReading {
  const nodes: PaletteNode[] = [];
  const unusable: UnusableNodeType[] = [];
  for (const entry of entries ?? []) {
    if (entry.enabled === false) {
      unusable.push({ name: entry.name, why: '这一型在清单里被停用了（启用它才能拖）' });
      continue;
    }
    const r = readNode(entry);
    if ('node' in r) nodes.push(r.node);
    else unusable.push({ name: entry.name, why: r.why });
  }
  const groups = NODE_TYPE_GROUPS.flatMap((group): PaletteGroup[] => {
    const inGroup = nodes
      .filter((n) => n.group === group)
      .sort((a, b) => a.order - b.order || a.type.localeCompare(b.type));
    return inGroup.length ? [{ group, label: NODE_TYPE_GROUP_LABELS[group], nodes: inGroup }] : [];
  });
  return { groups, unusable };
}
