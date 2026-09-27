import {
  NODE_TYPE_GROUP_LABELS,
  splitRegistryId,
  type RegistryDescriptor,
  type RegistryEntry,
  type RegistryKind,
} from '@paneflow/shared';

/**
 * v14 A1（R1）Descriptor 表：**一 kind 一模块**的落地处（决议 §十.5）。
 *
 * 这张表守的是「新 kind 忘了挂号」——类型是 mapped over `RegistryKind`，
 * `RegistrySpecMap` 加成员而这里不补一枚，编译期就红（shared 的 `SPEC_PARSERS` 用同一招）。
 *
 * `probe`（只读第五动词）本片**不声明**：A1 没有任何调用它的面，先立槽就是死码（家规：死码清零）。
 * 它的实现属于 R4 探测单通道——那边一有「现役注册项还在不在」的读端，这枚槽随调用点一起落。
 */

/** `model`：把网关探针读到的型号从一次性清单变成长得出回来的常用项；`label` 同时喂 API 与 CLI */
export const modelDescriptor: RegistryDescriptor<'model'> = {
  kind: 'model',
  label(entry) {
    const parts = [entry.spec.model];
    if (entry.spec.gatewayProfile) parts.push(`档=${entry.spec.gatewayProfile}`);
    if (entry.spec.freeModel) parts.push('免费位');
    if (entry.spec.note) parts.push(entry.spec.note);
    return parts.join(' · ');
  },
  /**
   * 现役配置里指向一枚模型条目的写法只有三种：整枚 id、id 的 slug 段、以及 spec 里的型号原值
   * （今天落册的引用就是网关档 `freeModel` 那串型号名，见 `registry-refs.ts`）。
   * 登记时起的中文名不是引用写法——所以它进不了这张表，别拿 label 当匹配键。
   */
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return [entry.id, entry.spec.model, ...(slug ? [slug] : [])];
  },
};

/**
 * `agent-kind`（v14 A3-2）：出厂清单的视图条目——`name` 就是 kind 原值，`spec.binary` 是探测名。
 * `label` 只在异名时说话（`antigravity-cli`→`antigravity`），同名时不重复一遍（一屏 18 行里
 * 十四行「二进制同名」是噪音，不是读数）。
 */
export const agentKindDescriptor: RegistryDescriptor<'agent-kind'> = {
  kind: 'agent-kind',
  label(entry) {
    const bin = entry.spec.binary;
    return bin === entry.name ? '探测名同 kind' : `探测名 ${bin}`;
  },
  /**
   * 现役配置里指向一枚 agent 类型的写法只有两种：kind 原值（`nodes[].config.agentKind`、
   * `SpaceProfile.defaultAgentKind`、`Role.agentKind` 落册的都是这个裸串）和整枚条目 id。
   * **`spec.binary` 不是引用写法**——配置里写 `antigravity` 不合法（那是探测名，不是 kind），
   * 把它算进匹配键就是把「打错的那个名字」读成「正在用」（同 model 那条「中文名不算」一个道理）。
   */
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return slug ? [entry.id, slug] : [entry.id];
  },
};

/**
 * `node-type`（v14 T1）：引擎认识哪些节点类型——出厂清单（`shared/dag.ts: NODE_TYPE_CATALOG`）的视图条目。
 * `name` 就是 graph 里 `node.type` 写的那枚裸串，所以 label 说的是**画布上长成什么样**（中文名 + 归哪组），
 * 不重复 name（那是「探测名同 kind」那条同一个道理：一屏六行里六行重名是噪音）。
 */
export const nodeTypeDescriptor: RegistryDescriptor<'node-type'> = {
  kind: 'node-type',
  label(entry) {
    return `「${entry.spec.label}」· ${NODE_TYPE_GROUP_LABELS[entry.spec.group]}`;
  },
  /**
   * 引用写法只有两种：整枚 id 或 `node.type` 原值（清单里的 `label` 是给人看的中文措辞，
   * 拿它当匹配键就会把「模板里写错的那句中文」读成「正在用某一型」——与 model/agent-kind 同一把尺）。
   */
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return slug ? [entry.id, slug] : [entry.id];
  },
};

/**
 * `mcp`（v14 T4）：本机登记了哪台 MCP server。**只有声明账**——今天没有客户端去 `tools/list`，
 * 所以 label 说的就是登记时那行启动命令本身，不含任何「探到几个工具」的读数（那是 v13:285 判死不做的东西）。
 */
export const mcpDescriptor: RegistryDescriptor<'mcp'> = {
  kind: 'mcp',
  label(entry) {
    const { command, args, note } = entry.spec;
    return [`${command}${args ? ` ${args}` : ''}`, note].filter(Boolean).join(' · ');
  },
  /**
   * 引用写法只有两种：整枚 id 或 slug 段（与 agent-kind/node-type 同一把尺）。
   * **`command` 不算引用写法**——配置里没有任何键写它，把它算进匹配键就是拿「别的条目恰好同命令」
   * 冒充「这一枚正在被用」（同 model「中文名不算」、agent-kind「探测名不算」）。
   */
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return slug ? [entry.id, slug] : [entry.id];
  },
};

/**
 * `skill`（v14 A5-1）：本机上有这么一篇可注入的技能文档。label 说的是**它挂在谁家的哪条路径**——
 * 相对路径离开项目根就没有意义，所以空间 id 必须出现在句子里（只画 `docs/x.md` 会让两个空间的两篇
 * 同名文件在界面上长得一模一样）。
 *
 * 引用写法有三种：整枚 id、slug 段、以及 **`spec.file` 原值**——今天 `SpaceProfile.skills[]` 与
 * `Role.skills[]` 落册的正是那枚裸相对路径，把它算进匹配键才能让「其实正在用」读成「在用」
 * （同 `model` 那枚 `spec.model` 的理由）。它因此是**跨空间可撞**的一枚键——消歧不在这里做，
 * 见 `registry-refs.ts` 的多重命中处置。
 */
export const skillDescriptor: RegistryDescriptor<'skill'> = {
  kind: 'skill',
  label(entry) {
    const { space, file, note } = entry.spec;
    return [`[项目 ${space}] ${file}`, note].filter(Boolean).join(' · ');
  },
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return [entry.id, ...(slug ? [slug] : []), entry.spec.file];
  },
  /**
   * `spec.file` 是相对路径，**跨空间可撞**（两个项目根下各有一篇 `docs/x.md` 时，一枚裸串对两枚条目）。
   * 三条判序：①整枚 id 或 slug 段=**定点引用**，天然无歧义；②空间自己发的引用（`skills[i]`）带主人 id，
   * 照主人收窄——这一路判得准，所以 R5 快照不会把「A 项目的这篇」记成「B 项目的这篇」；
   * ③角色/模板发的引用不绑空间（角色是全局名册），这里不硬判，交给调用方的多重命中处置。
   */
  matches(entry, target, ref) {
    const slug = splitRegistryId(entry.id)?.slug;
    if (target === entry.id || (slug !== undefined && target === slug)) return true;
    return ref.face === 'space' ? entry.spec.space === ref.id : true;
  },
};

export const REGISTRY_DESCRIPTORS: { [K in RegistryEntry['kind']]: RegistryDescriptor<K> } = {
  model: modelDescriptor,
  skill: skillDescriptor,
  'agent-kind': agentKindDescriptor,
  'node-type': nodeTypeDescriptor,
  mcp: mcpDescriptor,
};

/** 按条目 kind 查人话标签（读端每条都过这里，所以 `label` 只可能有一份口径） */
export function registryLabel(entry: RegistryEntry): string {
  const table = REGISTRY_DESCRIPTORS as Record<string, RegistryDescriptor<RegistryKind>>;
  const descriptor = table[entry.kind];
  // 认不出的 kind 走不到这里（`load()` 整条不认）；兜 name 只为防将来加 kind 时这里漏挂号，不返空串冒充标签
  return descriptor ? descriptor.label(entry) : entry.name;
}
