import fs from 'node:fs';
import path from 'node:path';
import {
  isRegistryViewKind,
  normalizeRegistryEntry,
  registryId,
  REGISTRY_KINDS,
  REGISTRY_SCHEMA_VERSION,
  splitRegistryId,
  type RegistryEntry,
  type RegistryKind,
  type RegistrySchemaDoc,
} from '@paneflow/shared';
import { Store } from './store.js';
import { registryViewEntries, viewHomeOf, viewKindWriteWhy } from './registry-view.js';

/**
 * v14 A1（R1）注册表落盘层：`<dataDir>/registry/` 下两份文件——
 *  - `entries.json`：能力条目本体（一张表，信封统一、`spec` 各 shape，见 `shared/src/registry.ts`）；
 *  - `schema.json`：**版本戳**（§十.2，顺带还清 v13 记到现在的 R7 债「数据迁移无版本戳」）。
 *
 * 为什么是单文件而不是 per-kind 一文件：id 全局唯一这道守卫不能跨文件核、R2 的反查要把全表一次读进内存、
 * 条目量级是「几十」不是「几万」。三条都是硬的。
 *
 * 版本戳的两条姿态（这两条决定「敢不敢让旧二进制再碰这份 dataDir」）：
 *  - 读到 `version` **高于**本版认识的值 → **拒启**（`assertSchemaOk` 返回 why，调用方据此不起服务）：
 *    旧二进制在新 dataDir 上「零配置健康」启动＝把不认识的东西洗掉，那是假绿最贵的形态；
 *  - 目录不存在/戳不存在 → 不是错误，是「还没登记过任何东西」的正读数（`load()` 返回空表，不写盘）。
 */

/**
 * 全表读取结果。`rejected` 是**照读时的一句话**，两种行都有：渲不出条目的坏行（手改盘面/旧版本写的/
 * 视图 kind 被塞进 entries.json），以及条目照渲、但旁边要补一句的落差行（A5-4b-2 起有实例：模板文件名
 * ≠ 图内 name、档名缺失回落 id）。所以这一栏不叫「本机不认的条目」——对在表上明晃晃摆着的那一行是假话。
 * 共同不变量只有一条：只披露，不清除。
 */
export interface RegistrySnapshot {
  entries: RegistryEntry[];
  rejected: { id: string; why: string }[];
}

export interface RegistryWriteResult {
  ok: boolean;
  entry?: RegistryEntry;
  why?: string;
  /** 写不下去的原因是本机版本比这份 dataDir 旧（不是调用方脏输入）：HTTP 面据此报 409 而非 400 */
  schemaTooNew?: boolean;
}

export class RegistryStore {
  /**
   * @param appVersion 发行版本号，由调用方（index.ts 起服务处）传进来——存储层自己去摸 package.json
   *   会在「源码跑 / 发行包跑」两种落点下给出不同的答案，那种不确定正是版本戳最不该有的。
   */
  constructor(
    private readonly dataDir: string,
    private readonly appVersion?: string,
  ) {}

  get rootDir(): string {
    return path.join(this.dataDir, 'registry');
  }

  get entriesPath(): string {
    return path.join(this.rootDir, 'entries.json');
  }

  get schemaPath(): string {
    return path.join(this.rootDir, 'schema.json');
  }

  /** 戳读不出来（没文件/脏 JSON/非对象）一律返回 null＝「不知道」，不当成版本 0 放行 */
  readSchema(): RegistrySchemaDoc | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.schemaPath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const o = raw as Record<string, unknown>;
      if (typeof o.version !== 'number' || !Number.isFinite(o.version)) return null;
      return { version: o.version, ...(typeof o.writtenBy === 'string' ? { writtenBy: o.writtenBy } : {}) };
    } catch {
      return null;
    }
  }

  /**
   * 能不能在本 dataDir 上写注册表：本机版本过旧 → 返回 why（拒启/拒写共用这一条判据）。
   * 戳缺失时不拒——那是「还没人登记过」，首次写会补上。
   */
  static assertSchemaOk(
    schema: RegistrySchemaDoc | null,
  ): { ok: true } | { ok: false; why: string; schemaTooNew: true } {
    if (!schema) return { ok: true };
    if (schema.version > REGISTRY_SCHEMA_VERSION) {
      const who = schema.writtenBy ? `由 ${schema.writtenBy} 写的` : '由更新版本的 PaneFlow 写的';
      return {
        ok: false,
        schemaTooNew: true,
        why:
          `这份 dataDir 的注册表版本是 ${schema.version}（${who}），本机只认识 ${REGISTRY_SCHEMA_VERSION} 及以下。` +
          '先升级 PaneFlow 再跑，别用旧二进制覆写这份数据；要回到旧行为请还原整个 registry/ 目录快照（不是 .bak 改名）。',
      };
    }
    return { ok: true };
  }

  /** 首次写入时补戳；已有戳不覆写（版本只能由迁移路径抬，本片没有迁移） */
  private ensureSchema(): { ok: true } | { ok: false; why: string; schemaTooNew?: true } {
    const existing = this.readSchema();
    const check = RegistryStore.assertSchemaOk(existing);
    if (!check.ok) return check;
    if (existing) return { ok: true };
    try {
      this.writeEntries(this.schemaPath, RegistryStore.schemaDoc(REGISTRY_SCHEMA_VERSION, this.appVersion));
      return { ok: true };
    } catch (err) {
      return { ok: false, why: `写不动注册表版本戳：${(err as Error).message}` };
    }
  }

  /** 版本戳文档：`writtenBy` 拿不到就整键不写（宁缺毋假，不拿 'dev' 冒充读数）——起服务处与首次写共用同一构造 */
  static schemaDoc(version: number, writtenBy?: string): RegistrySchemaDoc {
    return { version, ...(writtenBy ? { writtenBy } : {}) };
  }

  /**
   * 全表读取（**盘上事实**）：不存在=空表（正读数，不是错误）；整份 JSON 读不出=抛给调用方披露（不静默当空表——
   * 把「盘坏了」渲成「一条都没登记」是最典型的假绿）；单条不认识=进 rejected，其余照给。
   *
   * 写入路径（`add`/`update`/`remove`）只能吃这一枚：它们把结果整数组回写盘，
   * 一旦在这里并进视图条目，现算清单就被抄进了 `entries.json`（视图从此不再是视图，且再也删不掉）。
   * 要「用户登记项 + 视图现算项」的完整读数，用下面的 `readView()`。
   */
  load(): RegistrySnapshot {
    let text: string;
    try {
      text = fs.readFileSync(this.entriesPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], rejected: [] };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`注册表读不出（${this.entriesPath}）：${(err as Error).message}`);
    }
    const list = Array.isArray((parsed as { entries?: unknown })?.entries) ? (parsed as { entries: unknown[] }).entries : null;
    if (!list) throw new Error(`注册表形状不对（${this.entriesPath}）：期望 {entries: [...]}`);
    const entries: RegistryEntry[] = [];
    const rejected: { id: string; why: string }[] = [];
    for (const [i, raw] of list.entries()) {
      const norm = normalizeRegistryEntry(raw);
      if (norm.ok) entries.push(norm.value);
      else rejected.push({ id: labelOf(raw, i), why: norm.why });
    }
    entries.sort(compareEntries);
    return { entries, rejected };
  }

  /**
   * 读端全貌（A3-2 起所有 HTTP/引擎读面吃这一枚）：`load()` 的用户登记项 **+ 视图 kind 现算条目**。
   *
   * 三条规矩：
   *  1. **视图赢**：视图 kind（今天 `agent-kind`/`node-type`/`check-type`/`role`）在盘上的那几条一律不生效，
   *     整条挪进 `rejected` 说清为什么不生效——把它们和现算项并排渲出来就是两份「本机有哪些 agent」打架；
   *  2. **不落盘**：本方法只读，`add`/`update`/`remove` 走 `load()`。视图条目进了写路径＝现算清单被抄进台账；
   *  3. **现算的脏读数也披露**（A5-4b-1）：`role` 的正身是用户数据（`roles.json`），那张盘可以是脏的
   *     （手编名册是文档里明写过的正常操作）。builders 把「读得出但读不干净」的部分作为 `disclosures` 交出来，
   *     这里并进同一格 `rejected`——网页与 CLI 已经在渲它，不开第二份「脏数据清单」字段。
   */
  readView(): RegistrySnapshot {
    const disk = this.load();
    const views = registryViewEntries({ dataDir: this.dataDir });
    const shadowed = disk.entries.filter((e) => isRegistryViewKind(e.kind));
    const entries = [...disk.entries.filter((e) => !isRegistryViewKind(e.kind)), ...views.entries];
    entries.sort(compareEntries);
    return {
      entries,
      rejected: [
        ...disk.rejected,
        ...views.disclosures,
        ...shadowed.map((e) => ({ id: e.id, why: shadowedOnDiskWhy(e.kind) })),
      ],
    };
  }

  /** 按 kind 过滤（**盘上事实**，与 `load()` 同源；给「只谈用户登记项」的读端用）。视图条目请走 `readView()`。 */
  list(kind?: RegistryKind | string): RegistryEntry[] {
    const { entries } = this.load();
    return kind ? entries.filter((e) => e.kind === kind) : entries;
  }

  /**
   * 按 id 取**盘上那条**（写路径与「这条是不是用户登记的」判定用；视图项在这里查不到，正是它该被认出的地方）。
   * 面向人的详情读取用 `readView()`——视图项（出厂清单与名册现算的那几类）也要能查得到。
   */
  get(id: string): RegistryEntry | undefined {
    return this.load().entries.find((e) => e.id === id);
  }

  /** 新增：id 缺省时按 name 生成；撞已有 id 一律拒（改=显式 update，id 不可变＝§十.6） */
  add(raw: unknown): RegistryWriteResult {
    // 视图 kind 的成员由现算决定（出厂清单或名册），登记这条路不通（不拒的话，用户造的假 kind 会被读端当成可用能力）
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (typeof kind === 'string' && isRegistryViewKind(kind)) return viewRefused('登记', kind);
    const norm = normalizeRegistryEntry(raw);
    if (!norm.ok) return { ok: false, why: norm.why };
    const guard = this.ensureSchema();
    if (!guard.ok) return guard;
    const { entries } = this.load();
    if (entries.some((e) => e.id === norm.value.id)) {
      return { ok: false, why: `id「${norm.value.id}」已存在（改它就发 update，注册表不认静默覆盖）` };
    }
    entries.push(norm.value);
    this.writeEntries(this.entriesPath, { entries });
    return { ok: true, entry: norm.value };
  }

  /**
   * 就地更新：只认 `name`/`spec`/`enabled` 三个可改键，`id`/`kind`/`createdAt`/`source` 不许改
   * （前四枚是身份与出处，改了=换了一条账）；未知键直接拒，免得把「拼错的 enabled」当成一次成功更新。
   * id 不可变由「未知键即拒」兜住：更新体进不来 id，就没有「静默换锚」这条路。
   */
  update(id: string, patch: unknown): RegistryWriteResult {
    if (!id) return { ok: false, why: '缺少要改的条目 id' };
    const { entries } = this.load();
    const kind = splitRegistryId(id)?.kind;
    if (kind && isRegistryViewKind(kind)) return viewRefused('改', kind, entries.some((e) => e.id === id));
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, why: '更新体必须是 {name?, spec?, enabled?} 对象' };
    }
    const o = patch as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !['name', 'spec', 'enabled'].includes(k));
    if (unknown.length) return { ok: false, why: `更新体含不可改的键：${unknown.join('/')}（只认 name/spec/enabled）` };
    const cur = entries.find((e) => e.id === id);
    if (!cur) return { ok: false, why: `没有条目「${id}」（注册表不代造条目，改前先登记）` };
    const merged = normalizeRegistryEntry({
      ...cur,
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.spec !== undefined ? { spec: o.spec } : {}),
      ...(o.enabled !== undefined ? { enabled: o.enabled } : {}),
      updatedAt: new Date().toISOString(),
    });
    if (!merged.ok) return { ok: false, why: merged.why };
    entries[entries.indexOf(cur)] = merged.value;
    const guard = this.ensureSchema();
    if (!guard.ok) return guard;
    this.writeEntries(this.entriesPath, { entries });
    return { ok: true, entry: merged.value };
  }

  /**
   * 删除：找不到=失败读数（不静默成功）。R2 的「被引用不许删」长在这个入口之前，不塞进本片。
   * 视图 kind 的 id 在**读端看得到**（现算项上架），盘上却没有那条记录——这里只说「没有条目」会自相矛盾，
   * 所以点名「这一类删不了」；盘上真有一条手写的残记录时走下面的正常删除（清的是账，拆不掉正身那面的成员）。
   */
  remove(id: string): RegistryWriteResult {
    if (!id) return { ok: false, why: '缺少要删的条目 id' };
    const { entries } = this.load();
    const cur = entries.find((e) => e.id === id);
    if (!cur) {
      const kind = splitRegistryId(id)?.kind;
      if (kind && isRegistryViewKind(kind)) return viewRefused('删', kind);
      return { ok: false, why: `没有条目「${id}」` };
    }
    // 只删**盘上那条**（手放进 `entries.json` 的记录）：读端本来就不吃它（见 `readView()` 的 shadow 账），
    // 删掉它只是清账，拆不掉正身那面的成员。删视图项走不到这里——它压根不在 `load()` 的结果里。
    const rest = entries.filter((e) => e.id !== id);
    const guard = this.ensureSchema();
    if (!guard.ok) return guard;
    this.writeEntries(this.entriesPath, { entries: rest });
    return { ok: true, entry: cur };
  }

  private writeEntries(target: string, doc: unknown): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    Store.atomicWriteSync(target, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

/**
 * rejected 里的标签：有 id 报 id；没 id 但 kind+name 认得出就报 `<kind>:<name>`（人就是照这枚 id 去查的，
 * 而 id 是 name 的确定性函数——见 `registryId`）；再读不出就报第几条。别让一条烂条目在文案里变成无名氏。
 */
function labelOf(raw: unknown, i: number): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (typeof o.id === 'string' && o.id) return o.id;
    if (typeof o.kind === 'string' && o.kind && typeof o.name === 'string' && o.name) {
      return registryId(o.kind, o.name);
    }
  }
  return `entries[${i}]`;
}

/**
 * 排序：先按 kind（`REGISTRY_KINDS` 的挂号顺序），再按 id。
 * 为什么不裸按 id：内置清单一次就是十几枚，按 id 排会把它们整块压在用户亲手登记的那几枚前面
 * （`agent-kind:` 字典序在 `model:` 之前）——「我登记的东西」该在第一屏，不是被现算项埋了。
 * 挂号顺序本身即「用户可写的在前、视图 kind 在后」那份意图（视图 kind 总在清单尾部加）。
 */
function compareEntries(a: RegistryEntry, b: RegistryEntry): number {
  const ka = REGISTRY_KINDS.indexOf(a.kind);
  const kb = REGISTRY_KINDS.indexOf(b.kind);
  // 认不出的 kind 走不到这里（`load()` 整条不认）；-1 就当排最前，不拿它冒充 0
  if (ka !== kb) return ka - kb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 盘上那条视图项的披露文案（进 `rejected`：只说清为什么不生效，不替人删——它是手放进去的，人该看见）。
 *  正身那句取自 `viewHomeOf`：视图 kind 从今往后有六枚、其中三枚（`role`/`template`/`gateway-profile`）
 *  的正身是用户数据而不是出厂清单，措辞在 registry-view 一处给，这里不另抄一份「内置能力清单」。 */
function shadowedOnDiskWhy(kind: string): string {
  return (
    `「${kind}」这一类是视图 kind（条目由${viewHomeOf(kind)}现算出来），读端只吃现算那份，盘上这条不生效（不占 id、不参与引用账与预检）。` +
    '要清掉它发 DELETE（删的就是这条盘上记录）；留着的话它每次都会出现在这份披露里。'
  );
}

/** 视图 kind 的写入面拒答：`onDisk` 只影响要不要补那句「盘上那条也不生效，想清头发 DELETE」 */
function viewRefused(action: string, kind: string, onDisk = false): RegistryWriteResult {
  return {
    ok: false,
    why: `${viewKindWriteWhy(action, kind)}${onDisk ? '盘上那条同名记录同样不生效——要清账请发 DELETE。' : ''}`,
  };
}

/**
 * 发行版本号（版本戳的 `writtenBy`）：从本模块所在目录向上找**第一枚 `name==='paneflow'` 的 package.json**。
 * 为什么向上找而不写死相对深度：三种落点深度各不相同——源码跑（`packages/server/src` → 仓库根清单）、
 * esbuild 单文件（`<pkg>/lib` → 发行包根清单）、npm 全局装（`node_modules/paneflow/lib` 同上）。
 * 写死 `../../../` 的那版本会在其中一种落点上给出错误答案，而「谁写的这份数据」正是错误答案最不该出现在的字段。
 * 拿不到＝返回 undefined，调用方整键不写（宁缺毋假，不拿 'dev' 冒充读数）。
 */
export function detectAppVersion(fromDir: string = path.dirname(new URL(import.meta.url).pathname)): string | undefined {
  for (let dir = fromDir, i = 0; i < 8 && dir !== path.parse(dir).root; i += 1, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === 'paneflow' && typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      /* 这层没有清单/读不动：继续向上 */
    }
  }
  return undefined;
}
