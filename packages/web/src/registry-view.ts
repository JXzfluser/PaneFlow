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
 * + `view`（A3-2：这一项是内置清单的视图项，不可登记/改/删）。
 * `view` 是 server 给的读数，**不是**这里拿 `source==='builtin'` 推的——出处与可写性是两条判据。
 */
export type RegistryEntryView = RegistryEntry & { label: string; view?: boolean };

/** 这一项是不是内置清单的视图项（缺键＝旧 server，按可写条目渲染） */
export function isViewEntry(entry: RegistryEntryView): boolean {
  return entry.view === true;
}

/** 盘上没被认出的残条（server 只披露不清除；why 是 server 的一句人话，原样转述） */
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
  /** `knownKinds` 里「内置清单现算、写入面不接」的那几类（A3-2；缺键＝旧 server，一律按可登记渲染） */
  viewKinds?: string[];
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
  /** 这一整组都是出厂清单的视图项：登记控件对它不开，行内的启停/删除也不画 */
  view: boolean;
}

/**
 * 按 kind 分组：先按 server 给的 knownKinds 顺序立牌（空组也立——「迁一个 kind 亮一个分组」，
 * 空表是正读数不是错误），entries 里冒出 knownKinds 之外的 kind 时追加在尾部（不静默吞）。
 * `viewKinds` 决定那一组是不是出厂组——以 server 的清单为准而不是「这一组恰好有条目且都带 view」，
 * 出厂组暂时探不出货（比如清单为空）也该说清「这一类不用登记」。
 */
export function groupEntriesByKind(
  entries: RegistryEntryView[],
  knownKinds: string[],
  viewKinds: string[] = [],
  kindLabels?: Record<string, string>,
): KindGroup[] {
  const kinds = [...knownKinds];
  for (const e of entries) if (!kinds.includes(e.kind)) kinds.push(e.kind);
  return kinds.map((kind) => ({
    kind,
    label: kindGroupLabel(kind, kindLabels),
    entries: entries.filter((e) => e.kind === kind),
    view: viewKinds.includes(kind),
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
  list?: 'models' | 'skill-files';
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
  { key: 'model', label: '型号', type: 'text', required: true, list: 'models', hint: '可从网关探得的清单里选，也可直接填' },
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
  { key: 'space', label: '所属项目', type: 'select', required: true, options: 'spaces', hint: '相对路径以这个项目的根为基准，换项目=换文件' },
  { key: 'file', label: '文档路径', type: 'text', required: true, list: 'skill-files', hint: '相对项目根；可从该项目已登记的清单里选，也可直接填' },
  { key: 'note', label: '备注', type: 'text', hint: '这篇是干什么的（选填）' },
];

const MCP_FIELDS: RegistryFormField[] = [
  { key: 'command', label: '启动命令', type: 'text', required: true, hint: '本机可执行文件（绝对路径或 PATH 上的名字）' },
  { key: 'args', label: '参数', type: 'text', hint: '原样存一行，PaneFlow 不解析、不拆词' },
  { key: 'note', label: '备注', type: 'text', hint: '干什么用的（这一版只做登记账，工具桥接还没上）' },
];

export function formFieldsFor(kind: string): RegistryFormField[] | null {
  if (kind === 'model') return MODEL_FIELDS;
  if (kind === 'skill') return SKILL_FIELDS;
  if (kind === 'mcp') return MCP_FIELDS;
  return null;
}

/**
 * 候选池只吃档案里那三条路径列表，所以按**结构**收（server 的 `SpaceProfile` 不在 shared 里，
 * 这里抄全表就是把「档案加字段」变成页面的破坏性变更）。字段全可选：`GET /api/spaces/:id`
 * 对没配过的键整缺不造默认，这里也不拿 `undefined` 当空数组用。
 */
export interface SkillCandidateSource {
  id: string;
  skills?: string[];
  conventionFiles?: string[];
  rules?: { file?: string }[];
}

/**
 * 一枚项目档案里「像技能文档的东西」的候选集：`skills[]` ∪ `conventionFiles[]` ∪ `rules[].file`。
 * 为什么三处并起来：注入现场吃的就是这三类路径（作用域规则与约定文档同一条通道），
 * 只列 `skills[]` 会让「把一篇已在用的规则登记成能力条目」这一路必须手打。
 * 只读给出、不改任何档案：这里是候选池，不是第二个登记面。
 */
export function skillFileCandidates(spaces: SkillCandidateSource[], spaceId: string): string[] {
  const sp = spaces.find((x) => x.id === spaceId);
  if (!sp) return [];
  const files = [
    ...(Array.isArray(sp.skills) ? sp.skills : []),
    ...(Array.isArray(sp.conventionFiles) ? sp.conventionFiles : []),
    ...(Array.isArray(sp.rules) ? sp.rules.map((r) => r?.file) : []),
  ];
  return [...new Set(files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim()))].sort();
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
  return `另有 ${rejected.length} 条没被认出的记录（盘上残留或旧版写入，server 只披露不清除），不计入下表：`;
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
 * 详情格里两枚时刻的表头（出厂项那句「登记于」是假话——它没被登记过）。
 * 出厂项的 `createdAt` 是「本机这次运行开始看见它」的时刻，文案这么说，不替它编登记账。
 */
export function whenLabels(view: boolean): { created: string; updated: string; note: string } {
  return view
    ? { created: '本机自', updated: '本次运行', note: '内置清单项由版本自带，没有登记时刻' }
    : { created: '登记于', updated: '改于', note: '' };
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
