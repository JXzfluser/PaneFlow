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
 * kind → spec 形状。**A1 只落 `model` 一枚**当形状样板（§十.5）；
 * 其余 kind 由 A3-x 逐片加成员，每片各带一条「等臂不破」断言。
 */
export interface RegistrySpecMap {
  model: ModelRegistrySpec;
}

export type RegistryKind = keyof RegistrySpecMap;

/**
 * 认识的 kind 清单（与 `RegistrySpecMap` 双向锁死，见下方 `_checkKindsCovered`）：
 * 加了 spec 成员忘了在这里挂号 = 编译期红，不是运行面「静默不认」。
 */
export const REGISTRY_KINDS = ['model'] as const;

type _KindsCovered = [RegistryKind] extends [(typeof REGISTRY_KINDS)[number]]
  ? [(typeof REGISTRY_KINDS)[number]] extends [RegistryKind]
    ? true
    : never
  : never;
const _checkKindsCovered: _KindsCovered = true;
void _checkKindsCovered;

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
 * Descriptor（§十.5）：一 kind 一枚，把「这一类能力怎么读、怎么跟人说话」收在一处。
 * `label` 用**方法语法**声明（不是属性函数）：TS 对方法参数按双变放宽，
 * 于是 `RegistryDescriptor<'model'>` 能原样进 `RegistryDescriptor<RegistryKind>[]` 分派表，
 * 不必为一次查表写三枚 cast。`probe`（只读第五动词）不在这里——A1 没有调用它的面，槽随 R4 落。
 */
export interface RegistryDescriptor<K extends RegistryKind = RegistryKind> {
  kind: K;
  /** 一句人话标签：API 的 `label` 字段与 CLI 渲染共用同一句，零判据的 CLI 因此不必认识 spec */
  label(entry: RegistryEntry<K>): string;
}

const MODEL_SPEC_KEYS = ['model', 'gatewayProfile', 'freeModel', 'note'] as const;

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
