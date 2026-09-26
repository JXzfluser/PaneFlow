import type { FastifyInstance } from 'fastify';
import { REGISTRY_KINDS, type RegistryEntry } from '@paneflow/shared';
import type { RegistryStore, RegistryWriteResult } from '../orchestrate/registry.js';
import { registryLabel } from '../orchestrate/registry-descriptors.js';
import { readReferenceIndex, refsForEntry, type ReferenceIndex, type RegistryReferrer } from '../orchestrate/registry-refs.js';
import { entryHealth, type EntryHealth } from './registry-health.js';

/**
 * v14 A1+A2（R1+R2）注册内核的 HTTP 面：四动词（`add`/`update`/`delete` + 纯读 `list`/`get`）
 * 与它的引用账（「谁在用」纯读推导 + 写端拒删被引用/拒禁用）。
 *
 * **为什么住独立模块、由 `index.ts` 挂载而不塞进 `http.ts`**：§一 把 `api/http.ts` 记成本仓最挤的
 * 令牌轴，而 v14 的整件事就是「内核分片」。挂载点在启动处，与 `buildHttpServer` 同一实例——
 * 因此根实例上的 CORS 守卫与令牌钩子照旧覆盖这一组路由（`registry-routes.test.ts` 有断言，
 * 不靠「应该会自动继承」这种信念过活）。
 *
 * 姿态四条（与 §十 决议同）：
 *  - 写入面脏形状 **400 一句人话**（`normalizeRegistryEntry` 的 `why` 原样透传，不在路由层自造判据）；
 *  - 读端 `rejected` **只披露不清除**（手改盘面/旧版本写的条目都算，渲成「一条都没登记」是假绿）；
 *  - `label`/`refs` 由 server 算好后随条目一起返回——CLI/前端零判据（铁律 R4），不看 spec 说话；
 *  - 删除/禁用被引用项 → **400 列引用者**（R2 那句「宁拒不错放只管写入面」；运行面照旧只披露不拦）。
 */
export interface RegistryRouteDeps {
  registry: RegistryStore;
  dataDir: string;
}

/** 条目 + 人话标签 + 引用账（API 与 CLI 共用同一份渲染输入；`refs: []` 是正读数「没人用」，缺键才是「不知道」） */
type RegistryView = RegistryEntry & { label: string; refs?: RegistryReferrer[] };

/** `GET /api/registry/health` 的一行：list 的那一格 + 实探读数（没通道的 kind 整键不给 `health`） */
type RegistryHealthRow = RegistryView & { health?: EntryHealth };

const view = (entry: RegistryEntry, index: ReferenceIndex): RegistryView => ({
  ...entry,
  label: registryLabel(entry),
  refs: refsForEntry(index, entry.id),
});

/**
 * 写端成功后的回执：写已经落盘了，不该因为引用账读不动而把整次请求判成失败（那会让调用方
 * 以为没登记成功而重复登记）。此时**省掉 `refs` 键**＝「这一格不知道」，绝不渲成零引用。
 */
function viewWithRefs(deps: RegistryRouteDeps, entry: RegistryEntry): RegistryView {
  const r = indexOf(deps, deps.registry.load().entries);
  return 'why' in r ? { ...entry, label: registryLabel(entry) } : view(entry, r.index);
}

/** 写端结果的 HTTP 码：本机版本过旧＝不是调用方的错（409），其余脏输入与「还在被用」一律 400 指路 */
function codeOf(r: RegistryWriteResult): number {
  return r.ok ? 200 : r.schemaTooNew ? 409 : 400;
}

const FACE_CN: Record<RegistryReferrer['face'], string> = { space: '项目', role: '角色', template: '模板', gateway: '网关档' };

/** 「删不动的原因」必须看得见：逐条列是谁在用、用在哪个键（人按这个位置去改，不用猜） */
function referencedWhy(action: string, entry: RegistryEntry, refs: RegistryReferrer[]): string {
  const list = refs.map((r) => `${FACE_CN[r.face]}「${r.name}」的 ${r.via}`).join('、');
  return `「${entry.name}」还被 ${refs.length} 处引用着（${list}），${action}会把这些引用变成悬挂引用——先改掉那几处再来。`;
}

/**
 * 引用账读端（一处 try/catch，五个动词共用）：**扫不出引用 ≠ 没人在用**——
 * 这里降级成「零引用」就等于给删除开了绿灯，是 R2 最危险的假绿落点，所以整次请求如实报 500。
 */
type IndexResult = { index: ReferenceIndex } | { why: string };

function indexOf(deps: RegistryRouteDeps, entries: RegistryEntry[]): IndexResult {
  try {
    return { index: readReferenceIndex(deps.dataDir, entries) };
  } catch (err) {
    return { why: `引用账扫不出：${(err as Error).message}` };
  }
}

/** 被引用即拒（删除与禁用共用：R2 的写入面 fail-closed 只管这两件事，运行面照旧不拦在跑的单） */
type Guard = { ok: true } | { ok: false; code: number; why: string };

function guardReferenced(deps: RegistryRouteDeps, entry: RegistryEntry | undefined, action: string): Guard {
  if (!entry) return { ok: true };
  const r = indexOf(deps, deps.registry.load().entries);
  if ('why' in r) return { ok: false, code: 500, why: r.why };
  const refs = refsForEntry(r.index, entry.id);
  return refs.length ? { ok: false, code: 400, why: referencedWhy(action, entry, refs) } : { ok: true };
}

export function registerRegistryRoutes(app: FastifyInstance, deps: RegistryRouteDeps): void {
  app.get<{ Querystring: { kind?: string } }>('/api/registry', async (req, reply) => {
    let snapshot;
    try {
      snapshot = deps.registry.load();
    } catch (err) {
      // 盘读不出不渲空表：500 带一句为什么（与 Store 的 S5 姿态同源——静默失败不伪装成正断言）
      return reply.code(500).send({ error: `注册表读不出：${(err as Error).message}` });
    }
    const kind = req.query.kind;
    // `--kind` 值域由 server 说（CLI 零判据，铁律 R4）：拼错的组名渲成空表＝「这一组没东西」的假读数
    if (kind && !(REGISTRY_KINDS as readonly string[]).includes(kind)) {
      return reply.code(400).send({ error: `不认的能力类型「${kind}」（这版只登记：${REGISTRY_KINDS.join('/')}）` });
    }
    const idx = indexOf(deps, snapshot.entries);
    if ('why' in idx) return reply.code(500).send({ error: idx.why });
    const entries = kind ? snapshot.entries.filter((e) => e.kind === kind) : snapshot.entries;
    return {
      entries: entries.map((e) => view(e, idx.index)),
      rejected: snapshot.rejected,
      schema: deps.registry.readSchema(),
      // 这版认识的 kind：让「登记了却没亮出来」当场可辨（未知 kind 整条不认，见 §十.4）
      knownKinds: REGISTRY_KINDS,
      // M0 的底座读数：现役配置里到底有多少跨面裸串引用、其中多少指向还没迁进表的 kind（只披露计数，不判死活）
      refSummary: {
        scanned: idx.index.scanned,
        dangling: idx.index.dangling,
        unmigrated: idx.index.unmigrated,
      },
    };
  });

  /**
   * v14 R4：首屏那颗「健康点」＋「被引用数」的一次读数（`?refresh=1` 绕开 5min 实探缓存）。
   *
   * 为什么不并进 `GET /api/registry`：那一刀现在是纯读盘（CLI 每问一次都跑它），把网络实探塞进去
   * 等于让网关慢起来时整张表跟着慢、跟着变红——表读不出与点读不出是两回事，得分开报。
   *
   * 三样东西同一次给齐，消费面（网页首屏、`paneflow registry health`）零拼装：
   *  - `entries[].health`：逐条目实探读数（**这一类没有探针通道＝整键不给**，不是 unknown）；
   *  - `entries[].refs`：谁在用这一枚（R2 的引用账，同 list 一份实现）；
   *  - `dangling[]`：盘上正在被引用、表里却没有条目的裸串（E2「一键登记」的输入源）。
   *    这里**不放**「已被条目承接」那种字段：能被 `refKeys` 匹配上的引用压根不会进 dangling，
   *    加一枚恒 false 的 `consumed` 就是自己造一个假读数（曾想过，故在此留字为证）。
   *    反过来可读的只有这一枚——登记了却一处没人用的 `unused`（**只披露不判死活**：
   *    刚登记完还没接线也是这个读数，别画成错误）。
   *
   * 逐条目**串行**探：同一次里两枚条目钉同一档时并发会把那一档打两次，探针通道自己造重复读数。
   */
  app.get<{ Querystring: { refresh?: string } }>('/api/registry/health', async (req, reply) => {
    let snapshot;
    try {
      snapshot = deps.registry.load();
    } catch (err) {
      return reply.code(500).send({ error: `注册表读不出：${(err as Error).message}` });
    }
    const idx = indexOf(deps, snapshot.entries);
    if ('why' in idx) return reply.code(500).send({ error: idx.why });
    const refresh = req.query.refresh === '1';
    const entries: RegistryHealthRow[] = [];
    for (const e of snapshot.entries) {
      entries.push({ ...view(e, idx.index), health: await entryHealth(deps.dataDir, e, { refresh }) });
    }
    return {
      at: new Date().toISOString(),
      entries,
      dangling: idx.index.dangling,
      // 计数与归一全在判据层：消费面只照读这句汇总，不自己数（数错了没人知道）
      summary: {
        scanned: idx.index.scanned,
        dangling: idx.index.dangling.length,
        unmigrated: idx.index.unmigrated.length,
        probed: entries.filter((e) => e.health).length,
        live: entries.filter((e) => e.health?.status === 'live').length,
        missing: entries.filter((e) => e.health?.status === 'missing').length,
        unknown: entries.filter((e) => e.health?.status === 'unknown').length,
        unused: entries.filter((e) => !(e.refs ?? []).length).length,
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/registry/:id', async (req, reply) => {
    let entry: RegistryEntry | undefined;
    let snapshot;
    try {
      snapshot = deps.registry.load();
      entry = snapshot.entries.find((e) => e.id === req.params.id);
    } catch (err) {
      return reply.code(500).send({ error: `注册表读不出：${(err as Error).message}` });
    }
    if (!entry) {
      return reply.code(404).send({ error: `注册表里没有「${req.params.id || '（空）'}」，先 GET /api/registry 看现有 id` });
    }
    const idx = indexOf(deps, snapshot.entries);
    if ('why' in idx) return reply.code(500).send({ error: idx.why });
    return { entry: view(entry, idx.index) };
  });

  app.post<{ Body: unknown }>('/api/registry', async (req, reply) => {
    const r = deps.registry.add(req.body);
    if (!r.ok) return reply.code(codeOf(r)).send({ error: r.why });
    return { entry: viewWithRefs(deps, r.entry!) };
  });

  // 就地改：只认 name/spec/enabled（id/kind/createdAt/source 不可变，见 §十.6）。
  // 用 PATCH 而不用 PUT——PUT 在本仓是「整份覆写」（/api/spaces/:id、/api/roles 同义），这里是部分更新。
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/registry/:id', async (req, reply) => {
    const patch = req.body as { enabled?: unknown } | null;
    // 禁用与被引用＝「留着但不再被选」＋「有人在选」同时成立，必须先拒（R2 写入面）；其余更新照走
    if (patch && typeof patch === 'object' && patch.enabled === false) {
      const blocked = guardReferenced(deps, deps.registry.get(req.params.id), '禁用它');
      if (!blocked.ok) return reply.code(blocked.code).send({ error: blocked.why });
    }
    const r = deps.registry.update(req.params.id, req.body);
    if (!r.ok) return reply.code(codeOf(r)).send({ error: r.why });
    return { entry: viewWithRefs(deps, r.entry!) };
  });

  app.delete<{ Params: { id: string } }>('/api/registry/:id', async (req, reply) => {
    const blocked = guardReferenced(deps, deps.registry.get(req.params.id), '删掉它');
    if (!blocked.ok) return reply.code(blocked.code).send({ error: blocked.why });
    const r = deps.registry.remove(req.params.id);
    if (!r.ok) return reply.code(codeOf(r)).send({ error: r.why });
    return { deleted: { ...r.entry!, label: registryLabel(r.entry!) } };
  });
}
