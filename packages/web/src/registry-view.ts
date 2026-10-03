/**
 * v14 X1 注册中心视图的纯函数件（M0 可感面的判据层）。
 *
 * 家规照旧：**所有判定在 server**——这里不重算 id、不校验 spec 形状（表单只问「必填齐没齐」）、
 * 不渲 server 没给的读数（缺键就什么都不画，绝不把「不知道」画成 0）。
 * web 测试无 DOM 库，分组/文案/表单字段/只读 spec 行这些判断全收在本模块（样板：project-cards.ts）。
 */
import type { RegistryEntry } from '@paneflow/shared';

/**
 * API 返回的条目 = 信封 + server 算好的人话标签（零判据消费面，不看 spec 说话）
 * + `view`（A3-2：这一项是视图 kind 的条目，不可登记/改/删；正身逐 kind 见 `viewHomes`）。
 * `view` 是 server 给的读数，**不是**这里拿 `source==='builtin'` 推的——出处与可写性是两条判据。
 */
export type RegistryEntryView = RegistryEntry & { label: string; view?: boolean };

/** 这一项是不是视图 kind 的条目（缺键＝旧 server，按可写条目渲染） */
export function isViewEntry(entry: RegistryEntryView): boolean {
  return entry.view === true;
}

/**
 * 照读时的一句话（server 只披露不清除；why 是 server 的一句人话，原样转述）。
 * 两种行都有：渲不出条目的坏行，以及**条目照渲、旁边要补一句**的落差行（文件名≠图内 name 等）——
 * 所以这一栏的文案不许说成「没被认出」，见 `rejectedSummary`。
 */
export interface RegistryRejectedRow {
  id: string;
  why: string;
}

/** GET /api/registry 的响应形状（`registry-routes.ts` 的直译；schema 配了才出现，没货为 null） */
export interface RegistryListResponse {
  entries: RegistryEntryView[];
  rejected: RegistryRejectedRow[];
  schema: { version: number; writtenBy?: string } | null;
  knownKinds: string[];
  /** `knownKinds` 里「现算出来、写入面不接」的那几类（A3-2；缺键＝旧 server，一律按可登记渲染） */
  viewKinds?: string[];
  /**
   * kind → 「这一类的正身在哪儿」（A5-4b-1）。视图 kind 有了第二份出处之后，「内置清单」这个措辞
   * 对 `role` 就是假话（岗位是用户在角色库建的）——所以这句话由 server 逐 kind 给，网页不形容词。
   * 缺键＝旧 server：回落到不带出处的通用措辞，不猜那一类的正身是什么。
   */
  viewHomes?: Record<string, string>;
  /** kind → 人话组名，server 算好（与预检的 `need[].label` 同一处措辞；缺键＝旧 server，见 kindGroupLabel） */
  kindLabels?: Record<string, string>;
}

/** kind → 人话组名：`labels` 来自 server（`GET /api/registry` 的 `kindLabels`，与预检的组名同源）。
 *  这里**不留第二份措辞表**——两张表迟早分叉，而分叉了没人会去比对。`labels` 缺（旧 server / 还没到）
 *  或那一枚没挂号，都明说「未知类型」：把不认识的 kind 画成猜来的中文名是假账。 */
export function kindGroupLabel(kind: string, labels?: Record<string, string>): string {
  return labels?.[kind] ?? `未知类型：${kind}`;
}

export interface KindGroup {
  kind: string;
  label: string;
  entries: RegistryEntryView[];
  /** 这一整组都是视图项：登记控件对它不开，行内的启停/删除也不画 */
  view: boolean;
  /** 这一类的正身在哪儿（server 给；缺＝旧 server，文案回落成不带出处的说法，不猜） */
  home?: string;
}

/**
 * 按 kind 分组：先按 server 给的 knownKinds 顺序立牌（空组也立——「迁一个 kind 亮一个分组」，
 * 空表是正读数不是错误），entries 里冒出 knownKinds 之外的 kind 时追加在尾部（不静默吞）。
 * `viewKinds` 决定那一组是不是视图组——以 server 的清单为准而不是「这一组恰好有条目且都带 view」，
 * 视图组暂时探不出货（比如清单为空）也该说清「这一类不用登记」。
 * `viewHomes` 逐 kind 带上「正身在哪儿」：六枚视图 kind 里 `agent-kind`/`node-type`/`check-type` 住代码，
 * `role`/`template`/`gateway-profile` 住用户盘（角色库、模板、网关设置那一面）。
 * 拿一句「版本自带的内置清单」去描述用户自己建的岗位/模板/网关档就是说假话。
 */
export function groupEntriesByKind(
  entries: RegistryEntryView[],
  knownKinds: string[],
  viewKinds: string[] = [],
  kindLabels?: Record<string, string>,
  viewHomes?: Record<string, string>,
): KindGroup[] {
  const kinds = [...knownKinds];
  for (const e of entries) if (!kinds.includes(e.kind)) kinds.push(e.kind);
  return kinds.map((kind) => ({
    kind,
    label: kindGroupLabel(kind, kindLabels),
    entries: entries.filter((e) => e.kind === kind),
    view: viewKinds.includes(kind),
    ...(viewHomes?.[kind] ? { home: viewHomes[kind] } : {}),
  }));
}

/** 能被表单登记的 kind（= 认识的 kind 减掉出厂那几类）；出厂 kind 进下拉就是「点开却登记不了」的假可点 */
export function registrableKinds(knownKinds: string[], viewKinds: string[] = []): string[] {
  return knownKinds.filter((k) => !viewKinds.includes(k));
}

/** source 三态语义（§十.3 定死）：builtin=代码出厂、user=表单/CLI 登记、discovered=环境探得 */
const SOURCE_LABELS: Record<string, string> = {
  builtin: '出厂',
  user: '登记',
  discovered: '探得',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? `未识别来源「${source}」`;
}

/**
 * 视图项在「启停」那一格画什么（纯函数，组件只照读——和 `whenLabels` 同一批可测的画法件）。
 *
 * 默认话术是「清单里没有它就用不了，所以没有停用这一格」，但 **`gateway-profile` 是例外**：
 * 网关那一面自己有 `enabled` 键，一个停用的档真跑不了。镜子必须照出那一格，否则「清单里有就能用」
 * 这句在停用档面前就是假话，而预检那边已经按 `enabled` 收窄过了（两面向同一件事说两种话）。
 * 照读不等于给开关：这一格永远不可点，启停的正身在那一面。
 */
export function viewEnabledCell(entry: RegistryEntryView, home?: string): { text: string; title: string } {
  if (entry.enabled === false) {
    return {
      text: '停用中',
      title: `这一项在${home ?? '它自己的那一面'}里是停用状态：注册表只照读，启停不在这里按`,
    };
  }
  return {
    text: '—',
    title: home
      ? `这一类是现算出来的（${home}）：那一面里没有它，画布上也就用不了它，没有「停用」这一格`
      : '现算清单没有启停这一格：清单里有就能用',
  };
}

// ---------------------------------------------------------------------------
// 表单字段：从 kind 的 spec 形状「长」出来（与 shared 的 `RegistrySpecMap` 逐 kind 对齐）。
// 没定义字段的 kind 返回 null——界面对它明说「不登记不认识的形状」，绝不临场发明字段。
// ---------------------------------------------------------------------------

export interface RegistryFormField {
  /** spec 里的键名（即 POST 体的 spec 键；提交时只发这些键，多一个都会被 server 400） */
  key: string;
  label: string;
  type: 'text' | 'select' | 'checkbox';
  required?: boolean;
  hint?: string;
  /** 下拉选项的来源（渲染侧按这一枚去取候选，不再写死 `key === 'gatewayProfile'`） */
  options?: 'gateway-profiles' | 'spaces';
  /** 直接给 datalist 候选集（可选也可填——候选是省手的，不是白名单） */
  list?: 'models' | 'space-docs' | 'space-repos' | 'repo-origins';
  /**
   * 这一格填的是**这一项的正身**（型号串／文档路径／仓目录／启动命令）——显示名空着时从它派生。
   * 刻意不用「第一个必填字段」代替这一枚：`skill`/`rule`/`repo` 的必填头一格是「所属项目」，
   * 拿项目 id 当能力名就是把「default」写进账里，而它是作用域不是身份。
   */
  primary?: boolean;
}

/** 信封层的显示名（POST 体的 name，所有 kind 共用） */
export const REGISTRY_NAME_FIELD: RegistryFormField = {
  key: 'name',
  label: '显示名',
  type: 'text',
  required: true,
  hint: '分组表格里认它；id 由服务端从名字算，改登记走新条目',
};

const MODEL_FIELDS: RegistryFormField[] = [
  { key: 'model', label: '型号', type: 'text', required: true, primary: true, list: 'models', hint: '可从网关探得的清单里选，也可直接填' },
  { key: 'gatewayProfile', label: '归属网关档', type: 'select', options: 'gateway-profiles', hint: '只是裸 id 引用；档在不在由服务端的引用账说' },
  { key: 'freeModel', label: '免费位', type: 'checkbox', hint: '登记时它挂在网关的免费位上才勾' },
  { key: 'note', label: '备注', type: 'text', hint: '为什么留这一枚' },
];

/**
 * `skill`（v14 A5-1）：形状照 server 的 `parseSkillSpec`（{space,file,note?}）。
 * 「所属项目」是下拉（读自 `/api/spaces`，能选不打）；「文档路径」给候选但仍可直填——
 * 候选出自那个项目**已经登记过的**技能/规则/约定文档，而「登记一篇新技能」恰恰可能不在里面，
 * 把候选当白名单就是把表单路堵回「先去项目档案里加路径」那一趟。
 */
const SKILL_FIELDS: RegistryFormField[] = [
  { key: 'space', label: '所属项目', type: 'select', required: true, options: 'spaces', hint: '文档路径以这个项目的根为基准，换项目=换文件' },
  { key: 'file', label: '文档路径', type: 'text', required: true, primary: true, list: 'space-docs', hint: '如 skills/review.md 或 skills/review/SKILL.md' },
  { key: 'note', label: '备注', type: 'text', hint: '这篇是干什么的（选填）' },
];

/**
 * `rule`（v14 A5-2）：形状照 server 的 `parseRuleSpec`（{space,file,repo?,pathsGlob?,note?}）。
 * 两枚作用域键**原样存**（`repo` 是目录名、`pathsGlob` 是 glob 串），页面不解析也不校验能否展开——
 * 命中判定只住在注入现场那一把尺里（`rules.ts: matchRules`），这里再算一遍就是两处判据。
 * 两枚都不填=全空间规则（旧 `conventionFiles` 的等价形），所以不是必填。
 */
const RULE_FIELDS: RegistryFormField[] = [
  { key: 'space', label: '所属项目', type: 'select', required: true, options: 'spaces', hint: '约定文档以这个项目的根为基准' },
  { key: 'file', label: '文档路径', type: 'text', required: true, primary: true, list: 'space-docs', hint: '相对项目根；候选来自该项目已登记的文档路径，也可直接填' },
  { key: 'repo', label: '只在某仓生效', type: 'text', list: 'space-repos', hint: '填仓库目录名（相对主仓根）；留空=整个项目都守这条' },
  { key: 'pathsGlob', label: '只在某目录生效', type: 'text', hint: '对节点工作目录的 glob，如 packages/**；原样存，PaneFlow 不在这一步展开' },
  { key: 'note', label: '备注', type: 'text', hint: '为什么/什么时候守这条（会随文档注入给 agent）' },
];

/**
 * `repo`（v14 A5-3）：形状照 server 的 `parseRepoSpec`（{space,dir,origin?,note?}）。
 * 两枚标识**分开放**不是偷懒：`dir` 是本地目录名（`repos[]`／作用域／家规三处写的都是它），
 * `origin` 是 GitHub 的 `owner/repo`（派活时写的是它）——今天盘上两套命名空间同时存在，
 * 页面把它们塞进一个框就会让其中一套引用从此指不到条目。
 * `origin` 可填完整 remote URL：归一只在 server 那一侧做一次，这里不预处理（两处归一=两处判据）。
 */
const REPO_FIELDS: RegistryFormField[] = [
  { key: 'space', label: '所属项目', type: 'select', required: true, options: 'spaces', hint: '目录名以这个项目的根为基准，换项目=换目录' },
  { key: 'dir', label: '仓库目录', type: 'text', required: true, primary: true, list: 'space-repos', hint: '相对项目根的目录名；可从该项目已登记的仓库里选，也可直接填' },
  { key: 'origin', label: '远端仓', type: 'text', list: 'repo-origins', hint: 'owner/repo 或完整 remote URL（选填）；派活时 --repo 认的就是这一枚' },
  { key: 'note', label: '备注', type: 'text', hint: '这个仓是干什么的（选填）' },
];

const MCP_FIELDS: RegistryFormField[] = [
  { key: 'command', label: '启动命令', type: 'text', required: true, primary: true, hint: '如 npx 或 /usr/local/bin/uvx' },
  { key: 'args', label: '参数', type: 'text', hint: '如 -y @modelcontextprotocol/server-filesystem /path/to/dir（原样一行）' },
  { key: 'note', label: '备注', type: 'text', hint: '干什么用的（这一版只做登记账，工具桥接还没上）' },
];

export function formFieldsFor(kind: string): RegistryFormField[] | null {
  if (kind === 'model') return MODEL_FIELDS;
  if (kind === 'skill') return SKILL_FIELDS;
  if (kind === 'rule') return RULE_FIELDS;
  if (kind === 'repo') return REPO_FIELDS;
  if (kind === 'mcp') return MCP_FIELDS;
  return null;
}

/**
 * 本机只读探测（`POST /api/env/probe`，v14-E1）的候选提取——登记面的「路径」那一格不该逼人回忆。
 *
 * 三条边界：
 *  - **只挑不改**：`evidence` 就是 server 给的相对路径原值（doc 是 `AGENTS.md`、skill 是 `skills/x.md`、
 *    rule 是 `docs/y.md`），与 `spec.file` 落册时吃的是同一串，所以这里不拼路径、也不剥前缀。
 *  - **计数项不是路径**：规则候选超过上限时 server 会另起一项「另 N 篇未逐项列出」，
 *    它的 `evidence` 是 `<目录清单：…>` 这种带尖括号的说明（正是为了不被当成相对路径去 stat）——挡掉。
 *  - 探得的与档案里已登记的并起来：前者说「盘上有这篇」，后者说「这项目已经在用这篇」，
 *    人要的往往两枚都有；重复由 `Set` 收，序按码位（与 server 的 `byRelPath` 同一条理由）。
 */
export function probeFileCandidates(items: { kind: string; evidence: string }[]): string[] {
  const out = items
    .filter((it) => (it.kind === 'doc' || it.kind === 'skill' || it.kind === 'rule') && it.evidence)
    .filter((it) => !it.evidence.startsWith('<'))
    .map((it) => it.evidence.trim());
  return [...new Set(out)].sort();
}

/** 远端仓候选：`repo` 那一项的 `name` 是 server 归一过的 `owner/repo`（认不出时是原始 URL），原样递给人挑 */
export function probeOriginCandidates(items: { kind: string; name: string }[]): string[] {
  return [...new Set(items.filter((it) => it.kind === 'repo' && it.name.trim()).map((it) => it.name.trim()))].sort();
}

/** 档案已登记的路径 ∪ 本机探得的路径（两枚都不空时并；空的那侧不参与） */
export function mergeCandidates(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b].map((x) => x.trim()).filter((x) => x !== ''))].sort();
}

/**
 * 从主字段派生显示名（少打一格）：`docs/guide/review.md` → `review`，`glm-4.7` → `glm-4.7`。
 * 只在名字那一格还空着时用它——派生是**代填**，不是替人改写已经填过的字。
 */
export function deriveNameFromValue(v: string): string {
  const s = String(v ?? '').trim().replace(/[\\/]+$/, '');
  if (!s) return '';
  const last = s.split(/[\\/]/).pop() ?? s;
  return last.replace(/\.(md|json|ya?ml|ts|js|tsx|jsx)$/i, '');
}

/**
 * 候选池只吃档案里那三条路径列表，所以按**结构**收（server 的 `SpaceProfile` 不在 shared 里，

 * 这里抄全表就是把「档案加字段」变成页面的破坏性变更）。字段全可选：`GET /api/spaces/:id`
 * 对没配过的键整缺不造默认，这里也不拿 `undefined` 当空数组用。
 */
export interface SpaceDocCandidateSource {
  id: string;
  skills?: string[];
  conventionFiles?: string[];
  rules?: { file?: string }[];
  repos?: string[];
}

/**
 * 一枚项目档案里「像约定/技能文档的东西」的候选集：`skills[]` ∪ `conventionFiles[]` ∪ `rules[].file`。
 * 为什么三处并起来：注入现场吃的就是这三类路径（作用域规则与约定文档同一条通道），
 * 只列 `skills[]` 会让「把一篇已在用的规则登记成能力条目」这一路必须手打。
 * 只读给出、不改任何档案：这里是候选池，不是第二个登记面。
 * `skill` 与 `rule` 两 kind 共用它（候选池问的是「这个根下有哪些文档路径」，不问登记成哪一类）。
 */
export function spaceDocCandidates(spaces: SpaceDocCandidateSource[], spaceId: string): string[] {
  const sp = spaces.find((x) => x.id === spaceId);
  if (!sp) return [];
  const files = [
    ...(Array.isArray(sp.skills) ? sp.skills : []),
    ...(Array.isArray(sp.conventionFiles) ? sp.conventionFiles : []),
    ...(Array.isArray(sp.rules) ? sp.rules.map((r) => r?.file) : []),
  ];
  return [...new Set(files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim()))].sort();
}

/** `rule.spec.repo` 的候选：该项目**已登记的仓库目录名**（`repos[]`）。仍可直填——目录名可以还没登记 */
export function spaceRepoCandidates(spaces: SpaceDocCandidateSource[], spaceId: string): string[] {
  const sp = spaces.find((x) => x.id === spaceId);
  if (!sp) return [];
  const repos = Array.isArray(sp.repos) ? sp.repos : [];
  return [...new Set(repos.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim()))].sort();
}

/** 装备槽「定点引用」的一行（v14-A5-5b-2）：勾它 = 往那一格写 `{kind,id}` */
export interface EquipRefOption {
  /** 写进槽的原样 id（不 trim、不小写、不换成 `spec.file`——换了就不是定点引用了） */
  id: string;
  kind: 'skill' | 'rule';
  /** 条目说的是哪篇文档（相对那一项目的主仓根） */
  file: string;
  /** 挂在哪个项目：有名字用名字，**没这个名字就退回 id 原样**（不拿空白冒充「没项目」） */
  space: string;
}

/**
 * 注册中心里可被岗位装备槽引用的 `skill`/`rule` 条目清单。
 * 三条判序都不在这儿自造：`enabled` 与注入现场（`registry-equip.resolveRef` 的 `e.enabled`）**同一把尺**
 * ——停用的条目拿去凑装备槽就是假绿，所以这里根本递不出去；`spec.space`/`spec.file` 读不出的行
 * 不画（说不清它指哪篇文档，画出来就是一格点了会落空的勾）；跨项目的条目**照列**并带项目名——
 * 角色是全局库，「这一枚在别的项目、注到本项目时会被跳过不注」那句话住在状态页的装备明细行，
 * 不在勾选面上重算一遍（两处判据迟早分叉）。
 */
export function equipRefOptions(
  entries: readonly RegistryEntry[],
  kind: EquipRefOption['kind'],
  spaces: readonly { id: string; name: string }[],
): EquipRefOption[] {
  const out: EquipRefOption[] = [];
  for (const e of entries) {
    if (e.kind !== kind || !e.enabled) continue;
    const spec = e.spec as { space?: unknown; file?: unknown } | undefined;
    const file = typeof spec?.file === 'string' ? spec.file : '';
    const space = typeof spec?.space === 'string' ? spec.space : '';
    if (!file || !space) continue;
    out.push({ id: e.id, kind, file, space: spaces.find((s) => s.id === space)?.name ?? space });
  }
  return out.sort((a, b) => a.space.localeCompare(b.space) || a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
}

export type RegistryFormValues = Record<string, string | boolean>;

/** 提交前的「必填齐没齐」清单（返回缺的字段中文名；这是 UI 礼节，不是形状校验） */
export function missingRequiredFields(kind: string, name: string, values: RegistryFormValues): string[] {
  const missing: string[] = [];
  if (!name.trim()) missing.push(REGISTRY_NAME_FIELD.label);
  for (const f of formFieldsFor(kind) ?? []) {
    if (!f.required || f.type === 'checkbox') continue;
    if (!String(values[f.key] ?? '').trim()) missing.push(f.label);
  }
  return missing;
}

export interface RegistryAddPayload {
  kind: string;
  name: string;
  spec: Record<string, string | boolean>;
}

/**
 * 组装 POST 体：可选键**空了就整个不发**（发空串 gatewayProfile 会被 server 拒——宁缺键不空键），
 * 复选框只在 true 时发。kind 没有表单定义时返回 null（不猜形状）。
 */
export function buildRegistryPayload(
  kind: string,
  name: string,
  values: RegistryFormValues,
): RegistryAddPayload | null {
  const fields = formFieldsFor(kind);
  if (!fields) return null;
  const spec: Record<string, string | boolean> = {};
  for (const f of fields) {
    const raw = values[f.key];
    if (f.type === 'checkbox') {
      if (raw === true) spec[f.key] = true;
      continue;
    }
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) {
      if (f.required) return null;
      continue;
    }
    spec[f.key] = v;
  }
  return { kind, name: name.trim(), spec };
}

// ---------------------------------------------------------------------------
// 详情抽屉的只读 spec 行：渲染成 标签→值 的行数组，绝不给可编辑 textarea。
// ---------------------------------------------------------------------------

const SPEC_FIELD_LABELS: Record<string, string> = {
  model: '型号',
  gatewayProfile: '网关档',
  freeModel: '免费位',
  note: '备注',
  binary: '探测名',
  // node-type（v14 T1，出厂清单的视图项）：画布画法，不是配置——这里只披露读到的，不补默认值
  label: '显示名',
  icon: '图标',
  group: '分组',
  order: '组内次序',
  hint: '说明',
  // mcp（v14 T4，用户登记项）：启动命令 + 参数 + 备注
  command: '启动命令',
  args: '参数',
  // skill（v14 A5-1，用户登记项）：作用域住在 spec 里，所以「所属项目」也得画出来
  space: '所属项目',
  file: '文档路径',
  // rule（v14 A5-2）：两枚作用域键，原样存原样画——页面不展开 glob，也不判目录在不在
  repo: '生效仓库',
  pathsGlob: '作用域 glob',
  // repo（v14 A5-3）：本地目录名与远端仓是两套命名空间，两枚都得单独画出来
  dir: '仓库目录',
  origin: '远端仓',
  // check-type（v14 A5-4）：spec 里第一枚布尔——`false` 说的是「人看一眼」，与行首那句 label 同源
  machine: '引擎实跑',
  // template（v14 A5-4b-2， graphs 盘现算）：节点数是读数，0 是「一张空图」而不是「没读出来」
  nodes: '节点数',
  description: '说明',
  // gateway-profile（v14 A5-4b-2，网关盘现算）：这里只有引用与读数，`apiKey` 从不进条目（所以也没有对应键）
  baseUrl: '网关地址',
  keyConfigured: '配了密钥',
};

export interface SpecRow {
  key: string;
  label: string;
  text: string;
}

/** spec → 只读展示行。认识键给中文名，不认识的键原样挂出（披露优先，不吞不编） */
export function specRows(spec: unknown): SpecRow[] {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{ key: '(形状异常)', label: '配置详情', text: String(spec) }];
  }
  return Object.entries(spec as Record<string, unknown>).map(([key, value]) => ({
    key,
    label: SPEC_FIELD_LABELS[key] ?? key,
    text: typeof value === 'boolean' ? (value ? '是' : '否') : String(value),
  }));
}

// ---------------------------------------------------------------------------
// R2/R4 的读数消费面：被引用数与三态健康点。
// 「缺」不是 0，也不是「不健康」——没通道、还在探、探不通是三件事，各画各的。
// ---------------------------------------------------------------------------

/** 被引用数：refs 键不在 → null（什么都不画）；数组按条数、数值直取；其它形状不猜 */
export function refCountOf(entry: RegistryEntryView): number | null {
  const refs = (entry as { refs?: unknown }).refs;
  if (refs === undefined) return null;
  if (Array.isArray(refs)) return refs.length;
  if (typeof refs === 'number') return refs;
  return null;
}

/** 详情抽屉的「谁在用」一行（`face` 原样画：中文对照表只住在 server 的拒绝文案里，这里抄第二份迟早分叉） */
export interface RegistryRefRow {
  key: string;
  text: string;
}

/**
 * 引用出处逐条（X1 的「引用者清单」——CLI `registry refs <id>` 的同一份账，同一个画法）。
 * `refs` 键不在＝引用账没扫出来（那一格画「不知道」，绝不画「没人用」给删除开绿灯）；
 * `[]`＝正读数「没人用」。
 */
export function refRows(entry: RegistryEntryView): RegistryRefRow[] | null {
  const refs = (entry as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return null;
  return refs.map((r, i) => {
    const o = (r ?? {}) as { face?: unknown; id?: unknown; name?: unknown; via?: unknown };
    const name = typeof o.name === 'string' ? o.name : '';
    const id = typeof o.id === 'string' ? o.id : '';
    return {
      key: `${String(o.face ?? '?')}-${String(o.id ?? i)}-${i}`,
      text: [
        String(o.face ?? '（出处形状不认）'),
        name || id ? `「${name || id}」${name && id ? `（${id}）` : ''}` : '',
        typeof o.via === 'string' && o.via ? o.via : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };
  });
}

/** 引用清单的收尾一句（三种读数三句话，混一句就是假账） */
export function refNote(entry: RegistryEntryView, rows: RegistryRefRow[] | null): string {
  if (rows === null) return '引用账这次没扫出来（不是「没人用」）——上方「被引用」因此不画。';
  if (rows.length === 0) return '没人用（这是正读数：引用账确实扫过盘面，一处都没指着它）。';
  return `被 ${rows.length} 处引用——删除/停用时 server 会拿这份清单拒你。`;
}

/**
 * R4 `GET /api/registry/health` 的逐条目读数。`status` 按 string 收（server 日后加一枚枚举值
 * 不许把页面炸红，也不许被就近并进某一档），`detail` 是 server 的一句人话、原样进 title。
 */
export interface RegistryHealthReadout {
  status: string;
  detail: string;
  at?: string;
  cached?: boolean;
}

export interface RegistryHealthResponse {
  at: string;
  entries: (RegistryEntryView & { health?: RegistryHealthReadout })[];
  /** 盘上正被引用、表里却没条目的裸串（登记是 E2 的事，这里不消费） */
  dangling: { kind: string; target: string; by: { face: string; id: string; name: string; via: string }[] }[];
  summary?: {
    scanned?: number;
    dangling?: number;
    unmigrated?: number;
    probed?: number;
    live?: number;
    missing?: number;
    unknown?: number;
    unused?: number;
  };
}

/** id → 健康读数；**没有通道的 kind 整键不给**，于是它在表上天然没有点（不是画成灰点） */
export function healthIndex(res: RegistryHealthResponse): Map<string, RegistryHealthReadout> {
  const m = new Map<string, RegistryHealthReadout>();
  for (const e of res.entries) if (e.health) m.set(e.id, e.health);
  return m;
}

/**
 * 三态 → 点色的类名。**live=绿 / missing=红 / 其余一律灰**：未知状态与「探不通」都不许被
 * 洗成红点——网关 503 时把整表画红是替人判死一堆好模型（R4 的立命之处）。
 * 没读数（还没探到 / 这一类没通道）→ null，那一格什么都不画。
 */
export function healthDot(readout: RegistryHealthReadout | undefined): 'ok' | 'bad' | 'unknown' | null {
  if (!readout) return null;
  if (readout.status === 'live') return 'ok';
  if (readout.status === 'missing') return 'bad';
  return 'unknown';
}

/** 点的 hover 文案：server 的人话 + 「（缓存）」标（读数不是这刻现探的就说清） */
export function healthTitle(readout: RegistryHealthReadout | undefined): string | undefined {
  if (!readout) return undefined;
  const d = readout.detail.trim();
  const text = d || `状态「${readout.status}」（server 没给解释）`;
  return readout.cached ? `${text}（缓存读数）` : text;
}

/**
 * `GET /api/registry/:id/health` 的单枚探针回执（X1 的「探一次」，与 CLI `registry probe` 同一端点）。
 * `health` **整键不给＝这一类没有探针通道**（server 的宁缺毋假同形）——那不是「不健康」，
 * 也不许拿 `at`（回执时刻）当读数时刻画个灰点冒充探过。
 */
export interface RegistryProbeResponse {
  at: string;
  entry: RegistryEntryView;
  health?: RegistryHealthReadout;
}

/**
 * 「探一次」按钮下面那一句。四种读数四句话（上一格的健康行只吃 `health` 读数，
 * 这里说的是它说不出来的那三件事）：
 *  - 没点过 → `''`（不画「等待探测」占位，那一格本来就不存在）；
 *  - 请求失败 → server/网络的原话；
 *  - 回了却没 `health` 键 → **这一类没有探针通道**，不是「不健康」（拿它画灰点就是替人判死）；
 *  - 回了且有读数 → 读数已并进上面那一格，这里只说刚做过这一次（不重复贴同一段人话）。
 */
export function probeNote(res: RegistryProbeResponse | undefined, failed: string | null): string {
  if (failed) return `探针没回话：${failed}`;
  if (!res) return '';
  if (!res.health) return '这一类没有探针通道（注册表对它没有「实探」这一说，不是它不健康）。';
  return `刚探过一次（回执时刻 ${formatWhen(res.at) || res.at}），读数见上一格。`;
}

/** rejected 的一句话总述（表前披露用；不代清、不提供批量清除） */
export function rejectedSummary(rejected: RegistryRejectedRow[]): string | null {
  if (rejected.length === 0) return null;
  // 这一栏两种行都有：压根渲不出条目的坏行，以及**条目照渲、旁边要补一句**的落差行（文件名≠图内 name 等）。
  // 所以不能说成「N 条没被认出」——对在表上明晃晃摆着的那一行就是假话，而用户会以为整组读数都不可信。
  return `另有 ${rejected.length} 条照读时的一句话（server 只披露不清除）：渲不出条目的那类不进下表，条目在表上的那类是它旁边要补的话：`;
}

/** 时间戳 → 人话（读不出就原样挂出，不冒充空串是「没有」） */
export function formatWhen(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 详情格里两枚时刻的表头（视图项那句「登记于」是假话——它没被登记过）。
 * 视图项的 `createdAt` 是「本机这次运行开始看见它」的时刻，文案这么说，不替它编登记账。
 * `home` 是 server 逐 kind 给的正身（`agent-kind` 住出厂清单、`role` 住角色库）：拿「版本自带」去说
 * 一枚用户自己建的岗位，就是当着用户的面撒谎，所以这一句也吃外发的那份措辞，页面不形容词。
 */
export function whenLabels(
  view: boolean,
  home?: string,
): { created: string; updated: string; note: string } {
  if (!view) return { created: '登记于', updated: '改于', note: '' };
  return {
    created: '本机自',
    updated: '本次运行',
    note: home ? `这一项由${home}现算出来，没有登记时刻` : '内置清单项由版本自带，没有登记时刻',
  };
}

// -- v14-T3 模板卡的能力槽读数（`GET /api/registry/check` 的直译 + 那一行的排版） ------------

/** 一条槽的落点读数（`verdict` 按 string 读：server 日后加一枚落点不许把这里炸红，也不许并档） */
export interface RequirementSlotView {
  kind: string;
  id?: string;
  hint?: string;
  verdict: string;
  why: string;
  entryId?: string;
}

/** 一张模板的预检读数（分组计数与中文组名全在 server 算，这里只排版） */
export interface RegistryCheckRow {
  template: string;
  slots: RequirementSlotView[];
  need: { kind: string; label: string; declared: number; judged: number; gaps: number }[];
  missing: RequirementSlotView[];
  unjudged: RequirementSlotView[];
  malformed: RequirementSlotView[];
  ok: boolean;
}

export interface RegistryCheckResponse {
  space: string;
  spaceNote?: string;
  at: string;
  templates: RegistryCheckRow[];
}

/** 卡片那一行的读数：`text` 是「需要：模型 1 · 技能 2」，`tone` 决定画 ✓ / ✗ / ? 还是什么都不画 */
export interface RequirementBadge {
  text: string;
  tone: 'ok' | 'gap' | 'pending' | 'unknown' | 'none';
}

/**
 * 模板卡上「需要：…」那一格。四件事分开说，混一件就是假账：
 *  - 没声明槽（且 server 也没给读数）→ `none`：这一格不画，别拿「全绿」糊弄没带槽的模板；
 *  - 声明了却没读到预检（预检那一刀失败/还没回来）→ `unknown`：**绝不画 ✓**，
 *    缺口最坏的样子就是「看着没事」；
 *  - `ok=false` → `gap`（死缺或形状不认，起单会被引擎 fail-closed 拒掉）；
 *  - `ok=true` 但整组都判不了（这一类还没迁进注册表）→ `pending`，画问号灰点，
 *    红绿都不对：它既不是缺口也不是命中。
 */
export function requirementBadge(row: RegistryCheckRow | undefined, declared: number): RequirementBadge {
  if (!row) {
    return declared
      ? { text: `需要 ${declared} 项 · 预检没读出`, tone: 'unknown' }
      : { text: '', tone: 'none' };
  }
  const need = row.need.map((n) => `${n.label} ${n.declared}`).join(' · ');
  const text = need ? `需要：${need}` : '没带能力槽';
  if (!row.slots.length) return { text, tone: 'none' };
  if (!row.ok) return { text, tone: 'gap' };
  return row.unjudged.length === row.slots.length ? { text, tone: 'pending' } : { text, tone: 'ok' };
}

/** 逐槽 hover 明细（一行一槽；`why` 是 server 写好的命中说明或缺因，原样转述） */
export function requirementDetail(row: RegistryCheckRow): string {
  const mark: Record<string, string> = { ok: '✓', missing: '✗', unjudged: '?', malformed: '⚠' };
  return row.slots
    .map((s) => `${mark[s.verdict] ?? s.verdict} ${s.kind}${s.id ? ` → ${s.id}` : ''}：${s.why}`)
    .join('\n');
}
