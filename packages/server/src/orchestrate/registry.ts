import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeRegistryEntry,
  registryId,
  REGISTRY_SCHEMA_VERSION,
  type RegistryEntry,
  type RegistryKind,
  type RegistrySchemaDoc,
} from '@paneflow/shared';
import { Store } from './store.js';

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

/** 全表读取结果：`rejected` 是盘面里有但本机不认的条目（只披露不清除——手改盘面/旧版本写的都算） */
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
   * 全表读取：不存在=空表（正读数，不是错误）；整份 JSON 读不出=抛给调用方披露（不静默当空表——
   * 把「盘坏了」渲成「一条都没登记」是最典型的假绿）；单条不认识=进 rejected，其余照给。
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
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { entries, rejected };
  }

  /** 按 kind 过滤（`--kind` 与将来 UI 分组共用；不认识的 kind 返回空表，不报错——那是「这一组没有条目」） */
  list(kind?: RegistryKind | string): RegistryEntry[] {
    const { entries } = this.load();
    return kind ? entries.filter((e) => e.kind === kind) : entries;
  }

  get(id: string): RegistryEntry | undefined {
    return this.load().entries.find((e) => e.id === id);
  }

  /** 新增：id 缺省时按 name 生成；撞已有 id 一律拒（改=显式 update，id 不可变＝§十.6） */
  add(raw: unknown): RegistryWriteResult {
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
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, why: '更新体必须是 {name?, spec?, enabled?} 对象' };
    }
    const o = patch as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !['name', 'spec', 'enabled'].includes(k));
    if (unknown.length) return { ok: false, why: `更新体含不可改的键：${unknown.join('/')}（只认 name/spec/enabled）` };
    const { entries } = this.load();
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

  /** 删除：找不到=失败读数（不静默成功）。R2 的「被引用不许删」长在这个入口之前，不塞进本片 */
  remove(id: string): RegistryWriteResult {
    if (!id) return { ok: false, why: '缺少要删的条目 id' };
    const { entries } = this.load();
    const cur = entries.find((e) => e.id === id);
    if (!cur) return { ok: false, why: `没有条目「${id}」` };
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
