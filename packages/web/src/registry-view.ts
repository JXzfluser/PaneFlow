/**
 * v14 X1 注册中心视图的纯函数件（M0 可感面的判据层）。
 *
 * 家规照旧：**所有判定在 server**——这里不重算 id、不校验 spec 形状（表单只问「必填齐没齐」）、
 * 不渲 server 没给的读数（缺键就什么都不画，绝不把「不知道」画成 0）。
 * web 测试无 DOM 库，分组/文案/表单字段/只读 spec 行这些判断全收在本模块（样板：project-cards.ts）。
 */
import type { RegistryEntry } from '@paneflow/shared';

/** API 返回的条目 = 信封 + server 算好的人话标签（零判据消费面，不看 spec 说话） */
export type RegistryEntryView = RegistryEntry & { label: string };

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
}

/** kind → 分组中文名。只映射认识的；没挂号的 kind 不静默吞掉（见 kindGroupLabel）。 */
const KIND_GROUP_LABELS: Record<string, string> = {
  model: '模型',
};

export function kindGroupLabel(kind: string): string {
  return KIND_GROUP_LABELS[kind] ?? `未知类型：${kind}`;
}

export interface KindGroup {
  kind: string;
  label: string;
  entries: RegistryEntryView[];
}

/**
 * 按 kind 分组：先按 server 给的 knownKinds 顺序立牌（空组也立——「迁一个 kind 亮一个分组」，
 * 空表是正读数不是错误），entries 里冒出 knownKinds 之外的 kind 时追加在尾部（不静默吞）。
 */
export function groupEntriesByKind(entries: RegistryEntryView[], knownKinds: string[]): KindGroup[] {
  const kinds = [...knownKinds];
  for (const e of entries) if (!kinds.includes(e.kind)) kinds.push(e.kind);
  return kinds.map((kind) => ({
    kind,
    label: kindGroupLabel(kind),
    entries: entries.filter((e) => e.kind === kind),
  }));
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
// 表单字段：从 kind 的 spec 形状「长」出来。今天只有 model 一枚（shared RegistrySpecMap 同款四键）。
// 没定义字段的 kind 返回 null——界面对它明说「不登记不认识的形状」，绝不临场发明字段。
// ---------------------------------------------------------------------------

export interface RegistryFormField {
  /** spec 里的键名（即 POST 体的 spec 键；提交时只发这些键，多一个都会被 server 400） */
  key: string;
  label: string;
  type: 'text' | 'select' | 'checkbox';
  required?: boolean;
  hint?: string;
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
  { key: 'model', label: '型号', type: 'text', required: true, hint: '可从网关探得的清单里选，也可直接填' },
  { key: 'gatewayProfile', label: '归属网关档', type: 'select', hint: '只是裸 id 引用；档在不在由服务端的引用账说' },
  { key: 'freeModel', label: '免费位', type: 'checkbox', hint: '登记时它挂在网关的免费位上才勾' },
  { key: 'note', label: '备注', type: 'text', hint: '为什么留这一枚' },
];

export function formFieldsFor(kind: string): RegistryFormField[] | null {
  if (kind === 'model') return MODEL_FIELDS;
  return null;
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
