import type { FastifyInstance } from 'fastify';
import { isRegistryViewKind, REGISTRY_KINDS, REGISTRY_VIEW_KINDS, type RegistryEntry } from '@paneflow/shared';
import type { RegistryStore, RegistryWriteResult } from '../orchestrate/registry.js';
import { registryLabel } from '../orchestrate/registry-descriptors.js';
import { viewHomeOf } from '../orchestrate/registry-view.js';
import { readStoredGraphs, readReferenceIndex, refsForEntry, type ReferenceIndex, type RegistryReferrer } from '../orchestrate/registry-refs.js';
import { checkGraphRequirements, requirementKindLabel } from '../orchestrate/registry-check.js';
import { entryHealth, type EntryHealth } from './registry-health.js';
import { referencedWhy } from '../orchestrate/registry-gate.js';

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
type RegistryView = RegistryEntry & {
  label: string;
  refs?: RegistryReferrer[];
  /** 内置清单的视图项：不可登记/改/删（前端据此收起控件，而不是自己拿 `source` 猜——R4 零判据） */
  view: boolean;
};

/** `GET /api/registry/health` 的一行：list 的那一格 + 实探读数（没通道的 kind 整键不给 `health`） */
type RegistryHealthRow = RegistryView & { health?: EntryHealth };

const row = (entry: RegistryEntry, index: ReferenceIndex): RegistryView => ({
  ...entry,
  label: registryLabel(entry),
  refs: refsForEntry(index, entry.id),
  view: isRegistryViewKind(entry.kind),
});

/** 不带引用账的那一格（引用账读不动时的回执，以及删除回执——删掉的条目再谈「谁在用」没意义） */
const bare = (entry: RegistryEntry): RegistryView => ({
  ...entry,
  label: registryLabel(entry),
  view: isRegistryViewKind(entry.kind),
});

/**
 * 写端成功后的回执：写已经落盘了，不该因为引用账读不动而把整次请求判成失败（那会让调用方
 * 以为没登记成功而重复登记）。此时**省掉 `refs` 键**＝「这一格不知道」，绝不渲成零引用。
 */
function viewWithRefs(deps: RegistryRouteDeps, entry: RegistryEntry): RegistryView {
  const r = indexOf(deps, deps.registry.readView().entries);
  return 'why' in r ? bare(entry) : row(entry, r.index);
}

/** 写端结果的 HTTP 码：本机版本过旧＝不是调用方的错（409），其余脏输入与「还在被用」一律 400 指路 */
function codeOf(r: RegistryWriteResult): number {
  return r.ok ? 200 : r.schemaTooNew ? 409 : 400;
}

/**
 * 「被谁在用」这句拒答的画法只有一处（v14 A5-5a 把它收进 `orchestrate/registry-gate.ts`）：
 * 注册表的删除面与三枚正身自己的删除面问的是同一件事，两份措辞迟早分叉，而没人会去比对两句拒答。
 */

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
  // 视图 kind 的盘上那条读端本就不吃（`readView()` 把它挪进 rejected），引用账挂的是出厂项而不是它——
  // 拿出厂项的引用去拦「清账用的 DELETE」，就成了「删不掉一条本来就不生效的记录」。
  if (isRegistryViewKind(entry.kind)) return { ok: true };
  const r = indexOf(deps, deps.registry.readView().entries);
  if ('why' in r) return { ok: false, code: 500, why: r.why };
  const refs = refsForEntry(r.index, entry.id);
  return refs.length ? { ok: false, code: 400, why: referencedWhy(action, entry.name, refs) } : { ok: true };
}

export function registerRegistryRoutes(app: FastifyInstance, deps: RegistryRouteDeps): void {
  app.get<{ Querystring: { kind?: string } }>('/api/registry', async (req, reply) => {
    let snapshot;
    try {
      snapshot = deps.registry.readView();
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
      entries: entries.map((e) => row(e, idx.index)),
      rejected: snapshot.rejected,
      schema: deps.registry.readSchema(),
      // 这版认识的 kind：让「登记了却没亮出来」当场可辨（未知 kind 整条不认，见 §十.4）
      knownKinds: REGISTRY_KINDS,
      // 其中「内置清单现算、写入面不接」的那几类（A3-2）：消费面据此收起登记/编辑/删除控件，
      // 不必自己拿 `source==='builtin'` 猜（那是出处，不是可写性——两条判据迟早分家）
      viewKinds: REGISTRY_VIEW_KINDS,
      // kind → 「这一类的正身在哪儿」（A5-4b-1 起，A5-4b-2 补齐六枚）：视图 kind 里三枚住代码、三枚住用户盘，
      // 「内置清单」这个措辞对后三枚已经是假话——岗是用户自己建的、模板是他自己存的、档是他自己配的，
      // 页面却说「版本自带」。消费面据此出文案，不各自形容词（与 `kindLabels` 同一条理由：两张措辞表迟早分叉，而没人会去比对）。
      viewHomes: Object.fromEntries(REGISTRY_VIEW_KINDS.map((k) => [k, viewHomeOf(k)] as const)),
      // kind → 人话组名：措辞只有 `KIND_CN` 一处（预检的 `need[].label` 同源），网页与 CLI 拿它渲染。
      // 为什么外发而不是让前端各抄一份：两张措辞表迟早分叉，而没人会去比对两张措辞表——分叉了也没人红。
      kindLabels: Object.fromEntries(REGISTRY_KINDS.map((k) => [k, requirementKindLabel(k)] as const)),
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
   * 为什么不并进 `GET /api/registry`：那一刀现在是盘上加现算视图、零网络探针（CLI 每问一次都跑它），把网络实探塞进去
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
      snapshot = deps.registry.readView();
    } catch (err) {
      return reply.code(500).send({ error: `注册表读不出：${(err as Error).message}` });
    }
    const idx = indexOf(deps, snapshot.entries);
    if ('why' in idx) return reply.code(500).send({ error: idx.why });
    const refresh = req.query.refresh === '1';
    const entries: RegistryHealthRow[] = [];
    for (const e of snapshot.entries) {
      entries.push({ ...row(e, idx.index), health: await entryHealth(deps.dataDir, e, { refresh }) });
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

  /**
   * v14-T3 预检读数（`paneflow registry check --template x --space demo` 的落点）。
   *
   * 判据一行都不在这里：槽命中与否、分组计数、人话标签、拒单文案全在 `registry-check.ts`，
   * 引擎 `startRun` 起单时吃的也是那一枚——**预检说没问题而起单当场红**就是两把尺的典型症状，
   * 所以 HTTP 面与起单口共用同一枚纯函数（一处 try/catch 只包读盘）。
   *
   * 两种问法同一个形状：给 `?template=` → `templates` 只有一行；不给 → 扫全部在册模板
   * （网页模板卡一次拿全，不是一张卡发一次请求）。
   */
  app.get<{ Querystring: { template?: string; space?: string } }>('/api/registry/check', async (req, reply) => {
    let entries: RegistryEntry[];
    try {
      entries = deps.registry.readView().entries;
    } catch (err) {
      return reply.code(500).send({ error: `注册表读不出：${(err as Error).message}` });
    }
    let graphs;
    try {
      graphs = readStoredGraphs(deps.dataDir);
    } catch (err) {
      // 模板读不出不渲「零模板」：那会把「预检全绿」的假读数送给无人值守方
      return reply.code(500).send({ error: `模板读不出，预检做不了：${(err as Error).message}` });
    }
    const asked = String(req.query.template ?? '').trim();
    const targets = asked ? graphs.filter((g) => g.name === asked) : graphs;
    if (asked && !targets.length) {
      return reply.code(404).send({ error: `模板不存在：${asked}（GET /api/graphs 看在册模板名）` });
    }
    return {
      space: String(req.query.space ?? '').trim() || 'default',
      spaceNote:
        '命中的判定只看注册表（已迁 kind 全在一张全局表上：model/skill/rule/repo/mcp 是登记项，agent-kind/node-type/check-type 是代码现算的出厂视图项，role/template/gateway-profile 是用户盘现算的视图项），项目名只影响指路文案。`skill`/`rule` 条目确实带项目作用域，但那一维住在两处：引用账（空间自己发的引用按主人收窄）与探针（去那个项目根实读一次）；预检的槽仍不按项目收窄——本机任一项目登记过这篇文档即算命中，因为 requires 槽里没有写项目名的位置',
      at: new Date().toISOString(),
      templates: targets.map((g) => checkGraphRequirements(g, entries)),
    };
  });

  app.get<{ Params: { id: string } }>('/api/registry/:id', async (req, reply) => {
    let entry: RegistryEntry | undefined;
    let snapshot;
    try {
      snapshot = deps.registry.readView();
      entry = snapshot.entries.find((e) => e.id === req.params.id);
    } catch (err) {
      return reply.code(500).send({ error: `注册表读不出：${(err as Error).message}` });
    }
    if (!entry) {
      return reply.code(404).send({ error: `注册表里没有「${req.params.id || '（空）'}」，先 GET /api/registry 看现有 id` });
    }
    const idx = indexOf(deps, snapshot.entries);
    if ('why' in idx) return reply.code(500).send({ error: idx.why });
    // `viewHomes` 与 list 同一份措辞表：详情面也要说清「这一枚的正身在哪儿」——`role` 那几枚岗
    // 是用户自己建的，拿「出厂自带」描述它就是假话（消费面不形容词，判据与文案都出自这一处）
    return {
      entry: row(entry, idx.index),
      viewHomes: Object.fromEntries(REGISTRY_VIEW_KINDS.map((k) => [k, viewHomeOf(k)] as const)),
    };
  });

  /**
   * v14 R4 单枚探针（`paneflow registry probe <id>` 的落点）：只探这一条，吃**同一份**实探缓存。
   *
   * 为什么不并进上面的 `:id`：那一刀是纯读盘（详情抽屉每开合一次都跑它），把网络实探塞进去就等于
   * 网关慢起来时连「这条登记了什么」都读不出——和 `/api/registry` 与 `/api/registry/health` 同一把分刀。
   *
   * `health` 整键不给＝这一类没有探针通道（与批量那一刀的 宁缺毋假 同形，不是 `null` 不是 unknown）。
   */
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/api/registry/:id/health',
    async (req, reply) => {
      let snapshot;
      try {
        snapshot = deps.registry.readView();
      } catch (err) {
        return reply.code(500).send({ error: `注册表读不出：${(err as Error).message}` });
      }
      const entry = snapshot.entries.find((e) => e.id === req.params.id);
      if (!entry) {
        return reply.code(404).send({ error: `注册表里没有「${req.params.id || '（空）'}」，先 GET /api/registry 看现有 id` });
      }
      const idx = indexOf(deps, snapshot.entries);
      if ('why' in idx) return reply.code(500).send({ error: idx.why });
      const health = await entryHealth(deps.dataDir, entry, { refresh: req.query.refresh === '1' });
      return { at: new Date().toISOString(), entry: row(entry, idx.index), ...(health ? { health } : {}) };
    },
  );

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
    return { deleted: bare(r.entry!) };
  });
}
