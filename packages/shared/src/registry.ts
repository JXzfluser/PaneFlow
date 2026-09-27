/**
 * v14 A1（R1）注册内核信封：能力清单的**统一信封**与它的纯判据。
 * 形状决议逐条落在 `docs/iteration-v14-requirements.md §十`，本文件是那份决议的代码化——
 * 开放点不在此临场发明。
 *
 * 一句话边界（防内核长成第二个泥潭）：
 *  - **统一的是信封，不是内容**：`spec` 每 kind 一个形状，住在 `RegistrySpecMap`，新增 kind=在这里加一个成员；
 *    map 里没有的 kind，读取面整条不认、写入面 400（不猜形状＝不把一份不认识的东西渲成空卡）。
 *  - **密钥永不进 spec**（§十 与 R1 边界②）：这里只允许出现「引用」（网关档 id 之类的裸串）与「读数」。
 *  - **id 不可变**：改名/改语义＝新条目，否则「改 id=历史能力账断轴」这笔债（§一 第 2 行自己写的）永远还不清。
 *
 * shared 里不放任何 IO：落盘/版本戳在 server 的 `orchestrate/registry.ts`。
 */

import { NODE_TYPE_GROUPS, type NodeTypeGroup } from './dag.js';

/** 本文件认识的 dataDir 注册表 schema 版本；读到更高版本＝拒启（server 侧 enforce，见 §十.2） */
export const REGISTRY_SCHEMA_VERSION = 1;

/** `model` —— 「登记为常用模型」：把网关探针读到的型号从一次性清单变成长得出来的可勾选项（§一 第 13 行的缺口） */
export interface ModelRegistrySpec {
  /** 模型 id 原值（型号名不是密钥；它就是网关 catalog 探得的那枚串） */
  model: string;
  /** 归属网关档的**裸 id 引用**（与 `SpaceProfile.gatewayProfile` 同语义；档在不在不由写入面判——那是 R2 的引用账） */
  gatewayProfile?: string;
  /** 免费档标记：探针读数的转录，不是判定（true=登记时它挂在 freeModel 位上） */
  freeModel?: boolean;
  /** 人写的备注（为什么留这一枚） */
  note?: string;
}

/**
 * `agent-kind`（v14 A3-2）——「本机可跑的 agent 类型」这张**出厂清单**。
 * 数据原地住在 `api/agent-kinds.ts`（前置-1 合一的那枚白名单），注册表这一侧只是把它渲成条目：
 *  - 视图 kind（见 `REGISTRY_VIEW_KINDS`）：**不落盘、不可写**，删/禁用都不接（那条路会让出厂清单和用户数据混成一锅）；
 *  - `binary` 是探测用的二进制名（`antigravity-cli`→`antigravity` 是唯一的异名），不是密钥也不含路径；
 *  - 装没装**不进 spec**——那是探针读数（每次现探，进 spec 就是把 60 秒前的世界写进台账）。
 */
export interface AgentKindRegistrySpec {
  /** 本机 PATH 上探的那个名字（与 kind 同名时就是 kind） */
  binary: string;
}

/**
 * `node-type`（v14 T1）——「引擎认识哪些节点类型」这张**出厂清单**。数据原地住在 `dag.ts: NODE_TYPE_CATALOG`
 * （画布值域那张表就是它，`DAG_NODE_TYPES` 由它派生），注册表这一侧只把它渲成条目：
 *  - 视图 kind：**不落盘、不可写**（删掉一枚节点类型=画布上一型跑不了的假开关）；
 *  - 机器值就是条目的 `name`（`agent`/`fanout`…，graph 里 `node.type` 写的正是这枚裸串），所以 spec 里**不再存一遍 type**；
 *  - spec 存的是**画法**（中文名/图标/分组/一句解释）——「登记形状，不登记执行体」这条边界（红线七）在这里的形状：
 *    怎么跑住在引擎分派段，今天没有任何外部执行体，所以这里连 `run` 的形状都不预留。
 */
export interface NodeTypeRegistrySpec {
  /** 人话名（画布按钮文字，也是清单里唯一一处这一型的中文措辞） */
  label: string;
  icon: string;
  /** 画布分组：核心 / 基础 / 高级（值域见 `dag.ts: NODE_TYPE_GROUPS`） */
  group: NodeTypeGroup;
  /** 组内次序（小的在前）；见 `dag.ts: NodeTypeCatalogEntry.order` 那段「台账序≠画法序」 */
  order: number;
  /** 一句解释（hover 用；start/end 这类自明的可以不给） */
  hint?: string;
}

/**
 * `mcp`（v14 T4）——「本机登记了哪个 MCP server」这张**声明账**。
 * 形状决议只到「登记有什么」为止，**不含工具桥接**：v13:285 的既有裁决是不自实现 MCP 客户端，
 * 所以这一版既没有客户端去 `tools/list`，R4 也就**没有 mcp 探针通道**（健康读数整键不给——
 * 「没客户端可探」与「探到不在」是两件事）。这条边界必须写在这里，因为下一位接手的人最容易
 * 顺手把「探到工具 5 个」的回执补上：那需要真客户端，而它是本片判死不做的东西。
 *
 * 消费面因此只有两处，都是声明级的：①T3 预检的 `requires: [{kind:'mcp', id}]` 槽（这单**需要**
 * 环境里登记过这台 server——问的是登记账在不在，不是工具跑不跑）；②R2 引用账。
 * 传输今天只有 stdio 一条（启动=在本机拉起那个命令），所以 `transport` 无第二值可枚举、不预留。
 */
export interface McpRegistrySpec {
  /** 拉起这一 server 的可执行文件（绝对路径或 PATH 上的名字；不含密钥） */
  command: string;
  /** 启动参数，**原样存一行、不解析**（真正拉起它的人自己拆；这里不猜 shell 语义） */
  args?: string;
  /** 人写的备注（干什么用的、为什么留这一枚） */
  note?: string;
}

/**
 * `skill`（v14 A5-1）——「本机上有这么一篇可注入的技能文档」。数据原身今天住在
 * `SpaceProfile.skills[]`（相对该空间 `rootCwd` 的裸路径串，消费在 `orchestrate/skills.ts`），
 * 本片把它渲成可登记、可实探、可被引用账指着的能力条目（注入消费点仍在档案侧，切换正身是 A5-5 的迁移片）。
 *
 * 作用域为什么进 spec 而不进信封：技能天生属于某一个项目根（同一相对路径在两个空间是两个文件），
 * 而信封加了 `scope` 就是把落盘 schema bump 到 v2、背上整表迁移的债（§十.2 给搬数据定的三条硬前置）。
 * `model.spec.gatewayProfile` 是同一形状的先行例——「指向别处的一枚裸串」本来就是 spec 的语义。
 * `space` 与 `gatewayProfile` 同一条边界：写入面**不判它在不在**，那是 R2 引用账的账（判了就等于
 * 拿「我此刻扫到的名册」冒充「永远不会有的历史」）。`file` 也不判存在性：登记时刻文件可以还没落，
 * 死活归探针通道（R4）说。
 */
export interface SkillRegistrySpec {
  /** 所属空间的 id 裸串引用（`SpaceProfile.id`） */
  space: string;
  /** 相对该空间 `rootCwd` 的技能文档路径（今天 `skills[]` 里写的正是这一串，两面对得上才谈得上迁移） */
  file: string;
  /** 人写的备注（这篇是干什么的、为什么留这一枚） */
  note?: string;
}

/**
 * `rule`（v14 A5-2）——「本机上有这么一篇要守的约定文档」。数据原身今天住在
 * `SpaceProfile.rules[]`（`orchestrate/rules.ts: SpaceRule`，消费在注入现场 `matchRules`），
 * 信封与 `skill` 同形再加两枚作用域键：`repo`/`pathsGlob` **照 SpaceRule 的形状存**，不重命名、
 * 不合并——注册表里写的和档案里写的必须是同一串，否则 A5-5 迁移片得到处对账。
 *
 * `repo` 与 `pathsGlob` 是可缺省的作用域面（都没给=全空间规则，等价于旧 `conventionFiles` 那条），
 * 所以它们进 spec 是「这条规则自己说它在哪儿生效」，不是注册表替注入现场做决定：
 * 真正的命中判定仍只有一处（`rules.ts: matchRules` 那把 glob 尺）。注册表这边再算一遍就是两份判据。
 */
export interface RuleRegistrySpec {
  /** 所属空间的 id 裸串引用（`SpaceProfile.id`） */
  space: string;
  /** 相对该空间主仓根的约定文档路径（今天 `rules[].file` 写的正是这一串） */
  file: string;
  /** 只在该仓库目录内生效（相对主仓根的目录名；原样存，包含判定归 `matchRules`） */
  repo?: string;
  /** 对节点工作目录（相对主仓根、`/` 分隔）的 glob；原样存，展开归 `globToRegExp` */
  pathsGlob?: string;
  /** 为什么/什么时候守这条——随约定文档注入给 Agent 的那句提示 */
  note?: string;
}

/**
 * `repo`（v14 A5-3）——「这台机器上有这么个仓目录」。数据原身今天住在 `SpaceProfile.repos[]`
 * （相对主仓根的目录名字符串；消费在 `dispatch.ts: candidateRepos` 的候选仓解析与 `rules.ts`/家规的作用域键），
 * 本片同样只把它渲成可登记、可实探、可被引用账指着的能力条目（切换正身是 A5-5 的迁移片）。
 *
 * **这一枚与前两枚的差别：今天「仓库」在盘上有两套命名空间**，塞进一枚键就是假账——
 * `dir` 是相对主仓根的目录名（`repos[]`／`rules[].repo`／`delivery[].repo` 三处写的都是这一形），
 * `origin` 是 GitHub 的 `owner/repo`（`contract.repo`／`dispatch --repo` 那一形）。所以两枚都得是引用写法，
 * 否则要么现网裸串全洗成悬挂，要么派活时写的 `my-org/my-repo` 从此指不到任何条目。
 */
export interface RepoRegistrySpec {
  /** 所属空间的 id 裸串引用（`SpaceProfile.id`；探针去它的 `rootCwd` 下看这个目录） */
  space: string;
  /** 相对该空间主仓根的仓库目录名（今天 `repos[]` 里写的正是这一串） */
  dir: string;
  /** GitHub 的 `owner/repo` 或完整 remote URL（**原样存**；归一只发生在匹配时，用 `parseGithubRemote` 那一把尺） */
  origin?: string;
  /** 人写的备注（这个仓是干什么的、为什么留这一枚） */
  note?: string;
}

/**
 * `check-type`（v14 A5-4）——「引擎认识哪些机检类型」这张**出厂清单**，与 `node-type` 完全同形：
 *  - 数据原地住在 `dag.ts: CHECK_TYPE_CATALOG`（值域 `CHECK_SPEC_TYPES` 与机检账 `MACHINE_CHECK_TYPES` 都由它派生），
 *    注册表这一侧只把它渲成条目；
 *  - 机器值就是条目的 `name`（`command`/`manual`…，graph 里 `checks[].type` 写的正是这枚裸串），所以 spec 里**不再存一遍 type**；
 *  - spec 存的是**画法与口径**（中文名 / 一句解释 / 引擎实跑还是人看一眼）。**怎么跑不在这里**（红线七）：
 *    `file-exists` 读哪个键、`command` 怎么起子进程，全住在引擎的 checks 分派段。
 */
export interface CheckTypeRegistrySpec {
  /** 人话名（画布按钮文字，也是清单里唯一一处这一型的中文措辞） */
  label: string;
  /** 这一型问的是什么问题（六枚各有各的要解释，因此必填——不给就等于详情行少一句） */
  hint: string;
  /** 引擎实跑得动＝进 v13-V1 机检账；`false`＝这一型拦的是人，不是机器 */
  machine: boolean;
}

/**
 * kind → spec 形状。**A1 落 `model` 当样板，A3-2 加 `agent-kind`（视图 kind）**；
 * 其余 kind 由 A3-x 逐片加成员，每片各带一条「等臂不破」断言。
 */
export interface RegistrySpecMap {
  model: ModelRegistrySpec;
  skill: SkillRegistrySpec;
  rule: RuleRegistrySpec;
  repo: RepoRegistrySpec;
  'agent-kind': AgentKindRegistrySpec;
  'node-type': NodeTypeRegistrySpec;
  'check-type': CheckTypeRegistrySpec;
  mcp: McpRegistrySpec;
}

export type RegistryKind = keyof RegistrySpecMap;

/**
 * 认识的 kind 清单（与 `RegistrySpecMap` 双向锁死，见下方 `_checkKindsCovered`）：
 * 加了 spec 成员忘了在这里挂号 = 编译期红，不是运行面「静默不认」。
 * 顺序即注册中心的分组序（用户自己登记的东西排前，出厂那几十行不糊住自己的账）。
 */
export const REGISTRY_KINDS = ['model', 'skill', 'rule', 'repo', 'agent-kind', 'node-type', 'check-type', 'mcp'] as const;

/**
 * **视图 kind**：条目由别处（代码里的出厂清单）现算出来，`entries.json` 里永远没有它们。
 * 单列一枚清单而不写死在某个 if 里：写入面拒、UI 收控件、文案说「出厂登记不可删」三处都要用同一个答案
 * ——三份 if 迟早对不上，那就是第二份判据。
 */
export const REGISTRY_VIEW_KINDS = ['agent-kind', 'node-type', 'check-type'] as const;

export function isRegistryViewKind(kind: unknown): boolean {
  return typeof kind === 'string' && (REGISTRY_VIEW_KINDS as readonly string[]).includes(kind);
}

type _KindsCovered = [RegistryKind] extends [(typeof REGISTRY_KINDS)[number]]
  ? [(typeof REGISTRY_KINDS)[number]] extends [RegistryKind]
    ? true
    : never
  : never;
const _checkKindsCovered: _KindsCovered = true;
void _checkKindsCovered;

// 视图 kind 必须是认识的 kind：挂号挂到不认识的类型上=写入面拒、读取面也不认，那枚清单就是死码
type _ViewKindsCovered = [(typeof REGISTRY_VIEW_KINDS)[number]] extends [RegistryKind] ? true : never;
const _checkViewKindsCovered: _ViewKindsCovered = true;
void _checkViewKindsCovered;

/** 条目来源三态语义（§十.3，不许拿它当「是不是内置模板」这类模糊用途） */
export const REGISTRY_SOURCES = ['builtin', 'user', 'discovered'] as const;
export type RegistrySource = (typeof REGISTRY_SOURCES)[number];

/** 注册表条目（信封本体；键名即账名，落盘形状与 API 返回形状同一份） */
export interface RegistryEntry<K extends RegistryKind = RegistryKind> {
  /** `<kind>:<slug>`，全局唯一且**不可变** */
  id: string;
  kind: K;
  name: string;
  source: RegistrySource;
  /** false=留着但不再被选——**不是删除**（§十.3：被引用项 disable 只在运行面披露） */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  spec: RegistrySpecMap[K];
}

/** dataDir 注册表的 schema 戳文件内容（`registry/schema.json`） */
export interface RegistrySchemaDoc {
  version: number;
  /** 写下这一版的 PaneFlow 版本号（拒启文案要指名是谁写的，只报个数字人没法行动） */
  writtenBy?: string;
}

/**
 * 一条引用的出出处（`matches` 的判定上下文）。只有两枚键：谁发的、发的原文是什么不在这里（那是 `target` 参数）。
 * 单列一枚类型而不是让 server 侧传自己的 `RegistryReferrer`：内核不许认识引用扫描器的形状，
 * 而 `face`/`id` 这两个词的含义（哪一面、哪一枚条目发的）两边本来就一致。
 */
export interface RegistryRefContext {
  face: string;
  id: string;
}

/**
 * Descriptor（§十.5）：一 kind 一枚，把「这一类能力怎么读、怎么跟人说话」收在一处。
 * `label` 用**方法语法**声明（不是属性函数）：TS 对方法参数按双变放宽，
 * 于是 `RegistryDescriptor<'model'>` 能原样进 `RegistryDescriptor<RegistryKind>[]` 分派表，
 * 不必为一次查表写三枚 cast。`probe`（只读第五动词）**不在这里**——它是 IO（网络/读盘），
 * 而 descriptor 是纯判据件；R4 的探针通道分派表住在 server 侧 `api/registry-health.ts:CHANNELS`。
 */
export interface RegistryDescriptor<K extends RegistryKind = RegistryKind> {
  kind: K;
  /** 一句人话标签：API 的 `label` 字段与 CLI 渲染共用同一句，零判据的 CLI 因此不必认识 spec */
  label(entry: RegistryEntry<K>): string;
  /**
   * 这一枚条目**能被哪些裸串引用到**（R2 反查用）。必须由 kind 自己报：
   * 引用面写的是原始值（网关档的 `freeModel: 'gpt-4o-mini'`），而条目 id 是人登记时起的名字——
   * 两者不是一回事，只按 id 匹配会把「其实正在用」读成「没人用」（那是最危险方向的一次假读数）。
   */
  refKeys(entry: RegistryEntry<K>): string[];
  /**
   * **可选**：引用面那枚裸串该怎么归一，才和 `refKeys` 比。
   * 只有「同一枚标识在盘上有好几种写法」的 kind 用得上——`repo` 的远端仓既可能登记成完整 clone URL、
   * 也可能登记成 `owner/repo`，而 `refKeys` 只能列出**条目自己**那几种写法，指过来的 target 是另一种时
   * 就会「同仓两写法各算各的」。这里声明一次归一，`matchesTarget` 那道精确串闸门跟着它走；
   * **绝不许在这里改判据**（判据只住 `matches`），它只负责把两种写法摆到同一张台面上比。
   * 缺省＝不归一（今天除 `repo` 外都是这一路）。
   */
  normalizeTarget?(target: string): string;
  /**
   * **可选**的第二把判据：光看裸串判不准的 kind，自己按「这条引用从哪一面发来」收窄匹配。
   * 存在的理由只有一个——跨条目撞键。`skill` 的 `spec.file` 是相对路径，同名文件在两个项目根下是两个文件，
   * 而空间侧的引用（`SpaceProfile.skills[i]`）自带空间 id，能判准；角色侧的引用（`Role.skills[i]`）天生不绑空间，
   * 判不准就照实返回 false 之外的答案（见 server 侧多重命中的两处不同处置）。
   * 缺省＝不声明＝只看 `refKeys`（今天绝大多数 kind 都是这一路，不逼每个 kind 写它用不上的分支）。
   */
  matches?(entry: RegistryEntry<K>, target: string, ref: RegistryRefContext): boolean;
}

const MODEL_SPEC_KEYS = ['model', 'gatewayProfile', 'freeModel', 'note'] as const;
const SKILL_SPEC_KEYS = ['space', 'file', 'note'] as const;
const RULE_SPEC_KEYS = ['space', 'file', 'repo', 'pathsGlob', 'note'] as const;
const REPO_SPEC_KEYS = ['space', 'dir', 'origin', 'note'] as const;
const AGENT_KIND_SPEC_KEYS = ['binary'] as const;
const NODE_TYPE_SPEC_KEYS = ['label', 'icon', 'group', 'order', 'hint'] as const;
const CHECK_TYPE_SPEC_KEYS = ['label', 'hint', 'machine'] as const;
const MCP_SPEC_KEYS = ['command', 'args', 'note'] as const;

export type RegistryParse<T> = { ok: true; value: T } | { ok: false; why: string };

/** 一句人话的未知 kind 文案：把「这版认识哪些」当场列出来，别让人去猜 */
export function unknownKindWhy(kind: string): string {
  return `不认的能力类型「${kind}」（这版只登记：${REGISTRY_KINDS.join('/')}）`;
}

/**
 * spec 解析的分派表：一 kind 一条判据，未知 kind 在此**一并拒掉**（写入面 400 / 读取面整条不认，
 * 两面共用同一函数＝只可能有一份口径）。
 * 表本身是 `Record<RegistryKind, …>`：**加了 spec 成员忘了在这里挂号 = 编译期红**，
 * 不是运行面「静默不认」——这比手写 `if (kind === 'model')` 强，后者漏分支只能靠单测兜。
 */
const SPEC_PARSERS: { [K in RegistryKind]: (raw: unknown) => RegistryParse<RegistrySpecMap[K]> } = {
  model: parseModelSpec,
  skill: parseSkillSpec,
  rule: parseRuleSpec,
  repo: parseRepoSpec,
  'agent-kind': parseAgentKindSpec,
  'node-type': parseNodeTypeSpec,
  'check-type': parseCheckTypeSpec,
  mcp: parseMcpSpec,
};

export function parseRegistrySpec(kind: unknown, raw: unknown): RegistryParse<RegistryEntry['spec']> {
  if (typeof kind !== 'string' || !kind) return { ok: false, why: 'kind 必须是非空字符串' };
  const parser = (SPEC_PARSERS as Record<string, ((r: unknown) => RegistryParse<RegistrySpecMap[RegistryKind]>) | undefined>)[kind];
  if (!parser) return { ok: false, why: unknownKindWhy(kind) };
  return parser(raw);
}

/** `model` 的 spec 机检：姿态同 `validateDelivery`——未知键即拒（拼错字段=条目静默失效，宁拒不错放） */
export function parseModelSpec(raw: unknown): RegistryParse<ModelRegistrySpec> {
  const SHAPE = 'model 的配置详情必须是 {model, gatewayProfile?, freeModel?, note?}';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(MODEL_SPEC_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, why: `${SHAPE}；含未知键 ${unknown.join('/')}` };
  const model = typeof o.model === 'string' ? o.model.trim() : '';
  if (!model) return { ok: false, why: `${SHAPE}；model 必须是非空字符串` };
  const spec: ModelRegistrySpec = { model };
  if (o.gatewayProfile !== undefined) {
    const gp = typeof o.gatewayProfile === 'string' ? o.gatewayProfile.trim() : '';
    if (!gp) return { ok: false, why: 'gatewayProfile 给了就得是非空字符串（不留空串占位）' };
    spec.gatewayProfile = gp;
  }
  if (o.freeModel !== undefined) {
    if (typeof o.freeModel !== 'boolean') return { ok: false, why: 'freeModel 必须是布尔值' };
    spec.freeModel = o.freeModel;
  }
  if (o.note !== undefined) {
    if (typeof o.note !== 'string') return { ok: false, why: 'note 必须是字符串' };
    const note = o.note.trim();
    if (note) spec.note = note;
  }
  return { ok: true, value: spec };
}

/**
 * `skill` 的 spec 机检（v14 A5-1）。姿态同 `model`：未知键即拒（`flie` 拼错=这篇技能从此探不到也注不进，
 * 宁拒不错放），`space`/`file` 都要非空——「登记了一篇没有主人的技能」没有任何后续能兑现。
 * `file` **不判存在性也不判越界**：登记时刻文件可以还没落盘（先立账后写文是常态），
 * 而相对路径越不越出 `rootCwd` 是**消费现场**的判据（`skills.ts: safeJoin` 那一把尺）——
 * 在这里再算第二把尺，就会出现「注册中心说它在、注入现场把它跳过」两处对不上。死活归探针通道说。
 */
export function parseSkillSpec(raw: unknown): RegistryParse<SkillRegistrySpec> {
  const SHAPE = 'skill 的配置详情必须是 {space, file, note?}';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(SKILL_SPEC_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, why: `${SHAPE}；含未知键 ${unknown.join('/')}` };
  const space = typeof o.space === 'string' ? o.space.trim() : '';
  if (!space) return { ok: false, why: `${SHAPE}；space 必须是非空字符串（这篇技能属于哪个项目根，没有默认空间可猜）` };
  const file = typeof o.file === 'string' ? o.file.trim() : '';
  if (!file) return { ok: false, why: `${SHAPE}；file 必须是非空字符串（相对该空间主仓根的技能文档路径）` };
  const spec: SkillRegistrySpec = { space, file };
  if (o.note !== undefined) {
    if (typeof o.note !== 'string') return { ok: false, why: 'note 必须是字符串' };
    const note = o.note.trim();
    if (note) spec.note = note;
  }
  return { ok: true, value: spec };
}

/**
 * `rule` 的 spec 机检（v14 A5-2）。姿态同 `skill`：未知键即拒（`pathGlob` 少写一个 s＝这条规则从此
 * 不作用域化，静默降级成全空间规则，那是最坏的一种「看起来存成功了」）；`space`/`file` 必填；
 * `repo`/`pathsGlob` 给了就得是非空串（同 `model.gatewayProfile`：空串被丢掉＝作用域静默放大），
 * `note` 空了整键不发（同 `model`/`skill`：注释不承载判据，别让同一个可选注释键两种脾气）。
 *
 * **不判存在性、也不判 glob 能否展开**：登记时刻文档可以还没落（先立账后写文是常态），而 glob 的语义
 * 只有注入现场那一把尺说得清（`rules.ts: globToRegExp`）——这里再算一遍就是两处判据，迟早对不上。
 * 死活归探针通道（R4）说。
 */
export function parseRuleSpec(raw: unknown): RegistryParse<RuleRegistrySpec> {
  const SHAPE = 'rule 的配置详情必须是 {space, file, repo?, pathsGlob?, note?}';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(RULE_SPEC_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, why: `${SHAPE}；含未知键 ${unknown.join('/')}` };
  const space = typeof o.space === 'string' ? o.space.trim() : '';
  if (!space) return { ok: false, why: `${SHAPE}；space 必须是非空字符串（这篇约定属于哪个项目根，没有默认空间可猜）` };
  const file = typeof o.file === 'string' ? o.file.trim() : '';
  if (!file) return { ok: false, why: `${SHAPE}；file 必须是非空字符串（相对该空间主仓根的约定文档路径）` };
  const spec: RuleRegistrySpec = { space, file };
  // 两枚作用域键与 `note` 分家处理，不是手滑：`repo: ''` 若被静默丢掉，这条约定就从「只守某仓」**悄悄
  // 放大**成「整个项目都守」——那是最坏的一种「看起来存成功了」，所以照 `model.gatewayProfile` 拒；
  // `note` 只是给人看的注释，空了就整键不发（照 `model`/`skill` 同一处理，别让同一个可选注释键两种脾气）。
  for (const key of ['repo', 'pathsGlob'] as const) {
    if (o[key] === undefined) continue;
    if (typeof o[key] !== 'string') return { ok: false, why: `${key} 必须是字符串` };
    const v = (o[key] as string).trim();
    if (!v) return { ok: false, why: `${key} 给了就得是非空字符串（不留空串占位）` };
    spec[key] = v;
  }
  if (o.note !== undefined) {
    if (typeof o.note !== 'string') return { ok: false, why: 'note 必须是字符串' };
    const note = o.note.trim();
    if (note) spec.note = note;
  }
  return { ok: true, value: spec };
}

/**
 * `repo` 的 spec 机检（v14 A5-3）。姿态同前两枚：未知键即拒（`dire` 拼错＝这一枚仓从此探不到、
 * 也指不到任何出处，静默变成一条空账），`space`/`dir` 必填，`origin` 给了就得是非空串——
 * 它是**引用写法之一**，留空串等于往引用账里塞一条永远指不到的裸串（同 `rule.repo` 那条理由：
 * 承载身份/作用域的键不许静默丢弃，只有纯注释的 `note` 空了整键不发）。
 *
 * **不判目录在不在、也不判 origin 与 `.git/config` 符不符**：登记时刻仓可以还没克隆（先立账后克隆是常态），
 * 而 origin 的实读归派发现场（`dispatch.ts: candidateRepos` 每次都现读）。这里再算一遍就是两处判据。
 * `origin` **原样存**（`owner/repo` 或完整 remote URL 都收）：归一只发生在匹配那一侧，且只用既有那一把尺。
 */
export function parseRepoSpec(raw: unknown): RegistryParse<RepoRegistrySpec> {
  const SHAPE = 'repo 的配置详情必须是 {space, dir, origin?, note?}';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(REPO_SPEC_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, why: `${SHAPE}；含未知键 ${unknown.join('/')}` };
  const space = typeof o.space === 'string' ? o.space.trim() : '';
  if (!space) return { ok: false, why: `${SHAPE}；space 必须是非空字符串（这个仓挂在哪个项目根下，没有默认空间可猜）` };
  const dir = typeof o.dir === 'string' ? o.dir.trim() : '';
  if (!dir) return { ok: false, why: `${SHAPE}；dir 必须是非空字符串（相对该空间主仓根的仓库目录名）` };
  const spec: RepoRegistrySpec = { space, dir };
  if (o.origin !== undefined) {
    if (typeof o.origin !== 'string') return { ok: false, why: 'origin 必须是字符串' };
    const origin = o.origin.trim();
    if (!origin) return { ok: false, why: 'origin 给了就得是非空字符串（不留空串占位：它是引用写法之一）' };
    spec.origin = origin;
  }
  if (o.note !== undefined) {
    if (typeof o.note !== 'string') return { ok: false, why: 'note 必须是字符串' };
    const note = o.note.trim();
    if (note) spec.note = note;
  }
  return { ok: true, value: spec };
}

/**
 * `agent-kind` 的 spec 机检。这枚形状**只有出厂清单会造**（视图 kind，写入面一律拒），
 * 但它仍要走同一张 `SPEC_PARSERS` 表：条目从代码现算出来之后，读端与引用账拿的是同一个
 * `normalizeRegistryEntry`——不复用就得到处开第二份清洗路。
 */
export function parseAgentKindSpec(raw: unknown): RegistryParse<AgentKindRegistrySpec> {
  const SHAPE = 'agent-kind 的配置详情必须是 {binary}';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(AGENT_KIND_SPEC_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, why: `${SHAPE}；含未知键 ${unknown.join('/')}` };
  const binary = typeof o.binary === 'string' ? o.binary.trim() : '';
  if (!binary) return { ok: false, why: `${SHAPE}；binary 必须是非空字符串` };
  return { ok: true, value: { binary } };
}

/**
 * `node-type` 的 spec 机检（v14 T1）。与 `agent-kind` 同理：**只有出厂清单会造这一形状**（视图 kind，
 * 写入面一律拒），但仍走同一张分派表清洗。`group` 吃 `dag.ts` 那枚值域而不是本地重列——
 * 画布按组分桶，组名在这里再列一遍就是两处存。
 */
export function parseNodeTypeSpec(raw: unknown): RegistryParse<NodeTypeRegistrySpec> {
  const SHAPE = 'node-type 的配置详情必须是 {label, icon, group, order, hint?}';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(NODE_TYPE_SPEC_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, why: `${SHAPE}；含未知键 ${unknown.join('/')}` };
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (!label) return { ok: false, why: `${SHAPE}；label 必须是非空字符串（这一型在界面上叫什么，没有默认名可猜）` };
  const icon = typeof o.icon === 'string' ? o.icon.trim() : '';
  if (!icon) return { ok: false, why: `${SHAPE}；icon 必须是非空字符串` };
  if (typeof o.group !== 'string' || !(NODE_TYPE_GROUPS as readonly string[]).includes(o.group)) {
    return { ok: false, why: `${SHAPE}；group 只认 ${NODE_TYPE_GROUPS.join('/')}，收到「${String(o.group)}」` };
  }
  // 只要求「有限数」：次序是相对量，负数与小数都不影响排序，把它拒了只是让清单薄一点改动就 400
  if (typeof o.order !== 'number' || !Number.isFinite(o.order)) {
    return { ok: false, why: `${SHAPE}；order 必须是有限数（画布上的组内次序，没有默认次序可猜）` };
  }
  const spec: NodeTypeRegistrySpec = { label, icon, group: o.group as NodeTypeGroup, order: o.order };
  if (o.hint !== undefined) {
    if (typeof o.hint !== 'string') return { ok: false, why: 'hint 必须是字符串' };
    const hint = o.hint.trim();
    if (hint) spec.hint = hint;
  }
  return { ok: true, value: spec };
}

/**
 * `check-type` 的 spec 机检（v14 A5-4）。与 `node-type` 同理：**只有出厂清单会造这一形状**（视图 kind，
 * 写入面一律拒），但仍走同一张分派表清洗。`machine` 必填且不猜默认值——它决定这一型进不进 v13-V1 机检账，
 * 「没给就当引擎实跑」会把 `manual` 静默算进机器证的分子（那是最坏方向的假绿）。
 */
export function parseCheckTypeSpec(raw: unknown): RegistryParse<CheckTypeRegistrySpec> {
  const SHAPE = 'check-type 的配置详情必须是 {label, hint, machine}';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(CHECK_TYPE_SPEC_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, why: `${SHAPE}；含未知键 ${unknown.join('/')}` };
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (!label) return { ok: false, why: `${SHAPE}；label 必须是非空字符串（这一型在界面上叫什么，没有默认名可猜）` };
  const hint = typeof o.hint === 'string' ? o.hint.trim() : '';
  if (!hint) return { ok: false, why: `${SHAPE}；hint 必须是非空字符串（这一型问的是什么，注册中心那一行没有解释可猜）` };
  if (typeof o.machine !== 'boolean') {
    return { ok: false, why: `${SHAPE}；machine 必须是布尔（引擎实跑得动与否是机检账的分母，没有默认值可猜）` };
  }
  return { ok: true, value: { label, hint, machine: o.machine } };
}

/**
 * `mcp` 的 spec 机检（v14 T4）。与 `model` 同属**用户登记项**（走写入面），姿态同款：未知键即拒
 * （`comand` 拼错=这台 server 从此探不到也起不来，宁拒不错放）。
 * `command` 要求非空是因为「登记了一台没有启动命令的 MCP server」没有任何后续能兑现；
 * `args` **不做任何解析**（不拆引号、不分词、不校验可执行性）——本片没有客户端，拆它是替一个
 * 不存在的消费方猜语义。
 */
export function parseMcpSpec(raw: unknown): RegistryParse<McpRegistrySpec> {
  const SHAPE = 'mcp 的配置详情必须是 {command, args?, note?}';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(MCP_SPEC_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, why: `${SHAPE}；含未知键 ${unknown.join('/')}` };
  const command = typeof o.command === 'string' ? o.command.trim() : '';
  if (!command) return { ok: false, why: `${SHAPE}；command 必须是非空字符串（stdio 传输就得给出拉起它的那条命令）` };
  const spec: McpRegistrySpec = { command };
  if (o.args !== undefined) {
    if (typeof o.args !== 'string') return { ok: false, why: 'args 必须是字符串（启动参数原样一行，不拆不解析）' };
    const args = o.args.trim();
    if (args) spec.args = args;
  }
  if (o.note !== undefined) {
    if (typeof o.note !== 'string') return { ok: false, why: 'note 必须是字符串' };
    const note = o.note.trim();
    if (note) spec.note = note;
  }
  return { ok: true, value: spec };
}

/**
 * id 生成：`<kind>:<slug>`。slug 取 name 的 ASCII 化结果（小写、非 `[a-z0-9._-]` 转 `-`、首尾 `-` 去掉）；
 * **name 全非 ASCII（中文名很常见）时回落 `u<确定性散列>`**——回落值必须可复算，
 * 因为随机值会让「同一件事登记两次」产生两个 id（E2 一次事务登记就没了幂等），而且测试无从断言。
 * 散列撞车不静默：`add` 撞已有 id 一律 400（改=显式 update）。
 */
export function registryId(kind: string, name: string): string {
  const trimmed = name.trim();
  const ascii = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${kind}:${ascii || `u${stableHash(trimmed)}`}`;
}

/** id 拆解（引用与反查都用它；形状不对返回 null，由调用方决定是拒还是披露） */
export function splitRegistryId(id: unknown): { kind: string; slug: string } | null {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1) return null;
  const kind = id.slice(0, i);
  const slug = id.slice(i + 1);
  if (!/^[a-z][a-z0-9._-]*$/.test(kind) || !/^[a-z0-9._-]+$/i.test(slug)) return null;
  return { kind, slug };
}

/** djb2 → base36；只用作非 ASCII 名的稳定回落位 */
function stableHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 写入/读取面共用的条目清洗：合法返回 entry（原地规范化后的新对象），非法返回一句人话 */
export function normalizeRegistryEntry(raw: unknown): RegistryParse<RegistryEntry> {
  const SHAPE = '注册条目必须是 {id?, kind, name, spec}（source/enabled/时间戳由服务端落）';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: SHAPE };
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !o.kind) return { ok: false, why: `${SHAPE}；kind 缺失` };
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { ok: false, why: `${SHAPE}；name 必须是非空字符串` };
  const parsed = parseRegistrySpec(o.kind, o.spec);
  if (!parsed.ok) return parsed;
  const id = o.id === undefined ? registryId(o.kind, name) : typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) return { ok: false, why: 'id 给了就得是非空字符串' };
  const split = splitRegistryId(id);
  if (!split) return { ok: false, why: `id 形状必须是 <kind>:<slug>，收到「${id}」` };
  if (split.kind !== o.kind) return { ok: false, why: `id 的 kind 前缀（${split.kind}）与条目 kind（${o.kind}）不一致` };
  const source = o.source === undefined ? 'user' : o.source;
  if (typeof source !== 'string' || !(REGISTRY_SOURCES as readonly string[]).includes(source)) {
    return { ok: false, why: `source 只认 ${REGISTRY_SOURCES.join('/')}，收到「${String(o.source)}」` };
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
    return { ok: false, why: 'enabled 必须是布尔值（禁用=false，删除走 delete，别拿 null 冒充）' };
  }
  const now = new Date().toISOString();
  return {
    ok: true,
    value: {
      id,
      kind: o.kind as RegistryKind,
      name,
      source: source as RegistrySource,
      enabled: o.enabled === undefined ? true : (o.enabled as boolean),
      createdAt: typeof o.createdAt === 'string' && o.createdAt ? o.createdAt : now,
      updatedAt: typeof o.updatedAt === 'string' && o.updatedAt ? o.updatedAt : now,
      // 单一 kind 时类型收窄得靠这枚断言；A3-x 加第二个 kind 时把它换成分派表的返回值类型
      spec: parsed.value as RegistryEntry['spec'],
    },
  };
}
