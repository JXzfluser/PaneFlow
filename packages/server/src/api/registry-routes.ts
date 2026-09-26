import type { FastifyInstance } from 'fastify';
import { REGISTRY_KINDS, type RegistryEntry } from '@paneflow/shared';
import type { RegistryStore, RegistryWriteResult } from '../orchestrate/registry.js';
import { registryLabel } from '../orchestrate/registry-descriptors.js';

/**
 * v14 A1（R1）注册内核的 HTTP 面：四动词（`add`/`update`/`delete` + 纯读 `list`/`get`）。
 *
 * **为什么住独立模块、由 `index.ts` 挂载而不塞进 `http.ts`**：§一 把 `api/http.ts` 记成本仓最挤的
 * 令牌轴，而 v14 的整件事就是「内核分片」。挂载点在启动处，与 `buildHttpServer` 同一实例——
 * 因此根实例上的 CORS 守卫与令牌钩子照旧覆盖这一组路由（`registry-routes.test.ts` 有断言，
 * 不靠「应该会自动继承」这种信念过活）。
 *
 * 姿态三条（与 §十 决议同）：
 *  - 写入面脏形状 **400 一句人话**（`normalizeRegistryEntry` 的 `why` 原样透传，不在路由层自造判据）；
 *  - 读端 `rejected` **只披露不清除**（手改盘面/旧版本写的条目都算，渲成「一条都没登记」是假绿）；
 *  - `label` 由 Descriptor 算好后随条目一起返回——CLI/前端零判据（铁律 R4），不看 spec 说话。
 */
export interface RegistryRouteDeps {
  registry: RegistryStore;
}

/** 条目 + 人话标签（API 与 CLI 共用同一份渲染输入） */
type RegistryView = RegistryEntry & { label: string };

const view = (entry: RegistryEntry): RegistryView => ({ ...entry, label: registryLabel(entry) });

/** 写端结果的 HTTP 码：本机版本过旧＝不是调用方的错（409），其余脏输入一律 400 指路 */
function codeOf(r: RegistryWriteResult): number {
  return r.ok ? 200 : r.schemaTooNew ? 409 : 400;
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
    const entries = kind ? snapshot.entries.filter((e) => e.kind === kind) : snapshot.entries;
    return {
      entries: entries.map(view),
      rejected: snapshot.rejected,
      schema: deps.registry.readSchema(),
      // 这版认识的 kind：让「登记了却没亮出来」当场可辨（未知 kind 整条不认，见 §十.4）
      knownKinds: REGISTRY_KINDS,
    };
  });

  app.get<{ Params: { id: string } }>('/api/registry/:id', async (req, reply) => {
    let entry: RegistryEntry | undefined;
    try {
      entry = deps.registry.get(req.params.id);
    } catch (err) {
      return reply.code(500).send({ error: `注册表读不出：${(err as Error).message}` });
    }
    if (!entry) {
      return reply.code(404).send({ error: `注册表里没有「${req.params.id || '（空）'}」，先 GET /api/registry 看现有 id` });
    }
    return { entry: view(entry) };
  });

  app.post<{ Body: unknown }>('/api/registry', async (req, reply) => {
    const r = deps.registry.add(req.body);
    if (!r.ok) return reply.code(codeOf(r)).send({ error: r.why });
    return { entry: view(r.entry!) };
  });

  // 就地改：只认 name/spec/enabled（id/kind/createdAt/source 不可变，见 §十.6）。
  // 用 PATCH 而不用 PUT——PUT 在本仓是「整份覆写」（/api/spaces/:id、/api/roles 同义），这里是部分更新。
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/registry/:id', async (req, reply) => {
    const r = deps.registry.update(req.params.id, req.body);
    if (!r.ok) return reply.code(codeOf(r)).send({ error: r.why });
    return { entry: view(r.entry!) };
  });

  app.delete<{ Params: { id: string } }>('/api/registry/:id', async (req, reply) => {
    const r = deps.registry.remove(req.params.id);
    if (!r.ok) return reply.code(codeOf(r)).send({ error: r.why });
    return { deleted: view(r.entry!) };
  });
}
