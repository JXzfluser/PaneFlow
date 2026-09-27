import {
  NODE_TYPE_GROUP_LABELS,
  splitRegistryId,
  type RegistryDescriptor,
  type RegistryEntry,
  type RegistryKind,
} from '@paneflow/shared';
import { parseGithubRemote } from '../api/dispatch.js';

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
 * `check-type`（v14 A5-4）：引擎认识哪些机检类型——出厂清单（`shared/dag.ts: CHECK_TYPE_CATALOG`）的视图条目。
 * 与 `node-type` 同形：`name` 就是 `checks[].type` 写的那枚裸串，label 说的是**人看的名字**，不重复 name。
 * 但这一枚多一句必说的话：**引擎实跑还是人看一眼**（`spec.machine`）——它决定这一型进不进 v13-V1 的机检账，
 * 界面上把「人工确认」和「跑命令」画成同一类，就是拿人签字冒充机器证。
 */
export const checkTypeDescriptor: RegistryDescriptor<'check-type'> = {
  kind: 'check-type',
  label(entry) {
    return `「${entry.spec.label}」· ${entry.spec.machine ? '引擎实跑' : '人看一眼'}`;
  },
  /** 引用写法只有两种：整枚 id 或 `checks[].type` 原值（中文 label 不是引用写法，同 node-type 那把尺） */
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return slug ? [entry.id, slug] : [entry.id];
  },
};

/**
 * `role`（v14 A5-4b-1）：角色库名册的视图条目。与前三枚视图 kind 的**唯一**不同是正身是用户数据，
 * 于是 label 的取舍也不同：`name` 是引擎认的那枚 **roleId 机器值**（画布里 `config.role` 写的就是它），
 * 岗名（`spec.label`）是给人看的那个——所以 label 这句必须把岗名说出来，只画 `r-deliver` 用户认不出是哪岗。
 *
 * 引用写法**三枚**（整枚 id／slug 段／`entry.name` 即 roleId 原样）：第三枚是必需的——`registryId`
 * 把 slug 小写化了，名册里那枚 `r-Deliver` 只有靠 name 原值才指得回来（与 `repo` 那枚 `dir` 同理）。
 * **岗名不算引用写法**：没有任何键按岗名指岗，拿它当匹配键就是把「模板里写错的那句中文」读成
 * 「正在用某一枚岗」（model／skill／node-type 三处同一把尺）。钉档 `spec.agentKind` 也不算——它是这枚岗
 * 吃的那台 agent，不是这枚岗的名字（角色自己的 `agentKind` 那格由 `agent-kind` 那一类承接）。
 */
export const roleDescriptor: RegistryDescriptor<'role'> = {
  kind: 'role',
  label(entry) {
    const { label, agentKind } = entry.spec;
    return `「${label}」${agentKind ? ` · 钉档 ${agentKind}` : ''}`;
  },
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return [entry.id, ...(slug ? [slug] : []), entry.name];
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

/**
 * `rule`（v14 A5-2）：本机上有这么一篇要守的约定文档。label 除「挂在谁家哪条路径」外**必须带作用域**
 * （`仅 x 仓` / `目录 glob`）——同一空间里 `docs/x.md` 可以登记两条，一条全空间、一条只在甲仓生效，
 * 不画出来就是界面上两行一模一样，用户没法判断删掉的是哪一条。
 *
 * 引用写法与 `skill` 同形三枚（id／slug／`spec.file`）：今天 `SpaceProfile.rules[].file` 与
 * `Role.rules[]` 落册的正是那枚裸相对路径。`spec.repo`/`pathsGlob` **不算引用写法**：
 * 没有任何键按「作用域」来指一条规则（`rules[i].repo` 那枚裸串指的是仓库，已由引用账归给 `repo` 那一类），
 * 把它算进匹配键就是拿「别的条目恰好同仓」冒充「这一枚正在被用」。
 */
export const ruleDescriptor: RegistryDescriptor<'rule'> = {
  kind: 'rule',
  label(entry) {
    const { space, file, repo, pathsGlob, note } = entry.spec;
    const scope = [repo ? `仅 ${repo} 仓` : '', pathsGlob ? `目录 ${pathsGlob}` : ''].filter(Boolean).join(' + ');
    // 作用域紧跟路径（它修饰的就是这篇文档在哪个范围生效），note 才用 ` · ` 分隔——
    // 中间再插一个点会把「路径＋它的范围」切成两件事，读起来像两条并列的属性
    return [`[项目 ${space}] ${file}${scope ? `（${scope}）` : ''}`, note].filter(Boolean).join(' · ');
  },
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return [entry.id, ...(slug ? [slug] : []), entry.spec.file];
  },
  /** 判定序与 `skillDescriptor.matches` 同一条：定点引用无歧义，空间自发的按主人收窄，角色侧不绑空间照实放行 */
  matches(entry, target, ref) {
    const slug = splitRegistryId(entry.id)?.slug;
    if (target === entry.id || (slug !== undefined && target === slug)) return true;
    return ref.face === 'space' ? entry.spec.space === ref.id : true;
  },
};

/**
 * `repo`（v14 A5-3）：这台机器上有这么个仓目录。label 与 skill/rule 同一句式（`[项目 x] 目录名`），
 * 但**多一枚命名空间就得多种画法**：登记了 `origin` 就把它括在目录名后面——
 * 派活时人写的是 `my-org/my-repo`，界面上只画 `my-repo` 的话，这两枚名字看起来毫无关系，
 * 而它们指的确实是同一个仓（§十二-9 那套「一盘两制」）。
 *
 * 引用写法**四枚**（id／slug／`spec.dir`／`spec.origin`，外加 origin 归一出的 `owner/repo`）：
 * 前两枚是条目自己的名字；`dir` 让 `repos[]`／`rules[].repo`／`delivery[].repo` 三处今天的裸目录名
 * 有正身可指（不认则本片当场把现网引用洗成悬挂）；`origin` 让派活侧那套 `owner/repo` 写法同样指得到。
 * **归一只发生在匹配键这一侧**：条目里 `origin` 原样存（用户写 URL 就是 URL），但 `matchesTarget` 吃的是
 * `refKeys` 的精确串包含，所以这里把 `parseGithubRemote` 归一出的那枚也列进键里——
 * 一把尺（`dispatch.ts` 那一把，候选仓解析用的就是它），两种写法，零数据改写。
 */
export const repoDescriptor: RegistryDescriptor<'repo'> = {
  kind: 'repo',
  label(entry) {
    const { space, dir, origin, note } = entry.spec;
    return [`[项目 ${space}] ${dir}${origin ? `（${origin}）` : ''}`, note].filter(Boolean).join(' · ');
  },
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    const { dir, origin } = entry.spec;
    const keys = [entry.id, ...(slug ? [slug] : []), dir];
    if (origin) {
      keys.push(origin);
      const ownerRepo = parseGithubRemote(origin);
      if (ownerRepo && ownerRepo !== origin) keys.push(ownerRepo);
    }
    return keys;
  },
  /** 判定序同 `skill`/`rule`：定点引用（id/slug/origin）无歧义；目录名跨空间可撞，空间自发的按主人收窄 */
  matches(entry, target, ref) {
    const slug = splitRegistryId(entry.id)?.slug;
    if (target === entry.id || (slug !== undefined && target === slug)) return true;
    const { dir, origin } = entry.spec;
    // 按 origin（或其归一名）点名的引用指的是那枚全局仓标识，不是目录名——所以**不按空间收窄**。
    // 两侧都过一次同一把尺：登记值可能写成 `owner/repo`（`candidateRepos` 外发的就是这一形），
    // 而引用那头发来的可能是完整 clone URL（表单明写允许），只归一登记值就是把其中一种写法当没看见。
    if (origin) {
      const originKey = parseGithubRemote(origin) ?? origin;
      if (target === origin || (parseGithubRemote(target) ?? target) === originKey) return true;
    }
    // 剩下的可能写法只有 `spec.dir`（`matchesTarget` 先按 refKeys 精确串拦过一道，
    // 这里回 false 不是行为而是护栏：真进来一枚认不出的写法，宁可说「指不到这枚」，
    // 也不在预检那一侧画成命中——预检误判绿比引用账多报一笔危险得多）
    if (target !== dir) return false;
    return ref.face === 'space' ? entry.spec.space === ref.id : true;
  },
  /** 发来的裸串先按那唯一一把 remote 尺归一一次，再进 `refKeys` 那道精确串闸门（详见 `registry-refs.ts:matchesTarget`） */
  normalizeTarget: (target) => parseGithubRemote(target) ?? target,
};

export const REGISTRY_DESCRIPTORS: { [K in RegistryEntry['kind']]: RegistryDescriptor<K> } = {
  model: modelDescriptor,
  skill: skillDescriptor,
  rule: ruleDescriptor,
  repo: repoDescriptor,
  'agent-kind': agentKindDescriptor,
  'node-type': nodeTypeDescriptor,
  'check-type': checkTypeDescriptor,
  role: roleDescriptor,
  mcp: mcpDescriptor,
};

/** 按条目 kind 查人话标签（读端每条都过这里，所以 `label` 只可能有一份口径） */
export function registryLabel(entry: RegistryEntry): string {
  const table = REGISTRY_DESCRIPTORS as Record<string, RegistryDescriptor<RegistryKind>>;
  const descriptor = table[entry.kind];
  // 认不出的 kind 走不到这里（`load()` 整条不认）；兜 name 只为防将来加 kind 时这里漏挂号，不返空串冒充标签
  return descriptor ? descriptor.label(entry) : entry.name;
}
