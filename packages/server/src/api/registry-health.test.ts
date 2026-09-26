import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import { RegistryStore } from '../orchestrate/registry.js';
import type { RegistryEntry } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import { registerRegistryRoutes } from './registry-routes.js';
import { entryHealth } from './registry-health.js';

/**
 * v14 R4（探测单通道）：注册中心那颗「健康点」的三态判据 + 「只有一份探针实现」的机器证。
 *
 * 走真 `buildHttpServer`（不是只测纯函数）有两个必须的理由：
 *  1. `/api/gateway/catalog` 与 `/api/registry/health` 挂在**同一台 server**上，
 *     第 5 条断言（探过一次之后 catalog 不再打网络）只有在这个组合方式下才证得出「同一份缓存」——
 *     各测各的模块永远证不出一条通道；
 *  2. `GET /api/registry/health` 与 `GET /api/registry/:id` 形状撞车（静态段 vs 参数段），
 *     路由表实不实效只能注入真请求看它落到哪一边。
 */
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reg-health-'));
const HOST = '127.0.0.1:4310';
const BASE = 'http://127.0.0.1:19099';

async function build(stubEntries?: RegistryEntry[]) {
  const dataDir = tmp();
  /**
   * 桩盘面**只在测「这一类没有探针通道」时用**：今天只有 `model` 进了表（`REGISTRY_KINDS`），
   * 走真 store 写不进第二枚 kind（会被 400 拒），而路由那格的「整键不给」必须在 HTTP 面证到
   * ——只测 `entryHealth` 返回 undefined，等于没证路由不把 undefined 写成 `null`。
   */
  const registry = stubEntries
    ? ({ load: () => ({ entries: stubEntries, rejected: [] }), readSchema: () => null } as unknown as RegistryStore)
    : new RegistryStore(dataDir, '0.3.0-test');
  const { app } = await buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: { ping: async () => ({ version: '0.0.0' }) } as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
  registerRegistryRoutes(app, { registry, dataDir });
  return { app, dataDir };
}

/** 写一档网关配置（`gateway.json` 的磁盘形状即 GatewayDoc；密钥只在这份盘上，永不进返回值） */
function gatewayDoc(dataDir: string, profiles: { id: string; name: string; freeModel?: string }[], current: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'gateway.json'),
    JSON.stringify({
      profiles: profiles.map((p) => ({ id: p.id, name: p.name, baseUrl: BASE, apiKey: 'sk-secret-永不出现', freeModel: p.freeModel, enabled: true })),
      current,
    }),
  );
}

/** 假实探：按序回放每档的清单/错，并数网络次数（缓存与单通道都靠它证） */
function stubModels(responses: { status?: number; models?: string[] }[]) {
  let hits = 0;
  vi.stubGlobal(
    'fetch',
    (async (url: string | URL) => {
      hits++;
      const r = responses[Math.min(hits - 1, responses.length - 1)] ?? {};
      if ((r.status ?? 200) >= 400) return new Response('', { status: r.status ?? 500 });
      return new Response(JSON.stringify({ data: (r.models ?? []).map((id) => ({ id })) }), { status: 200 });
    }) as unknown as typeof globalThis.fetch,
  );
  return { hits: () => hits };
}

const MODEL = (model: string, extra: Record<string, unknown> = {}) => ({ kind: 'model', name: model, spec: { model, ...extra } });
const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });

describe('v14-R4 健康点三态（live / missing / unknown）', () => {
  it('实探清单里有＝live，detail 说清是哪一档第几枚；免费位同串时一并说出来', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-free', name: '免费档', freeModel: 'gpt-4o-mini' }], 'p-free');
      stubModels([{ models: ['gpt-4o-mini', 'gpt-4o'] }]);
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL('gpt-4o-mini') });
      const res = await get(app, '/api/registry/health');
      expect(res.statusCode).toBe(200);
      const row = res.json().entries[0];
      expect(row.id).toBe('model:gpt-4o-mini');
      expect(row.health.status).toBe('live');
      expect(row.health.detail).toContain('免费档');
      expect(row.health.detail).toContain('第 1 枚');
      expect(row.health.detail).toContain('免费位');
      // 被引用数是同一份读数里的另一样（M0 首屏三样：表 + 点 + 被引用数）
      expect(row.refs).toEqual([{ face: 'gateway', id: 'p-free', name: '免费档', via: 'freeModel' }]);
      expect(JSON.stringify(res.json())).not.toContain('sk-secret');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('探通了但清单里没有＝missing（这是正读数，与「没探通」分家）', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-free', name: '免费档' }], 'p-free');
      stubModels([{ models: ['gpt-4o'] }]);
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL('gpt-9') });
      const row = (await get(app, '/api/registry/health')).json().entries[0];
      expect(row.health.status).toBe('missing');
      expect(row.health.detail).toContain('里都没有「gpt-9」');
      expect(row.refs).toEqual([]); // 没人用也是正读数：[] 不是缺键
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('档没答上（HTTP 503/超时同一条路）＝unknown，绝不并进 missing', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-free', name: '免费档' }], 'p-free');
      stubModels([{ status: 503 }]);
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL('gpt-4o-mini') });
      const row = (await get(app, '/api/registry/health')).json().entries[0];
      expect(row.health.status).toBe('unknown');
      expect(row.health.status).not.toBe('missing'); // R4 的立命之处：未探得不是不可用
      expect(row.health.detail).toContain('HTTP 503');
      expect(row.health.detail).toContain('没探通不等于不可用');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('本机压根没配网关档＝unknown（不配档不是「所有模型都不在」）', async () => {
    const { app } = await build();
    try {
      stubModels([{ models: [] }]);
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL('gpt-4o-mini') });
      const row = (await get(app, '/api/registry/health')).json().entries[0];
      expect(row.health.status).toBe('unknown');
      expect(row.health.detail).toContain('没有配置网关档');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('钉着的网关档在本机不存在＝unknown 并指名那一档（R2 的悬挂在探针面上同样不判死）', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-other', name: '别档' }], 'p-other');
      stubModels([{ models: ['gpt-4o-mini'] }]);
      await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: MODEL('gpt-4o-mini', { gatewayProfile: 'p-missing' }),
      });
      const row = (await get(app, '/api/registry/health')).json().entries[0];
      expect(row.health.status).toBe('unknown');
      expect(row.health.detail).toContain('p-missing');
      expect(row.health.detail).toContain('未探得');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});

describe('v14-R4 单通道：缓存只有一份实现', () => {
  it('健康点探过一次后 /api/gateway/catalog 零新增请求；registry list 一步网络都不打', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-free', name: '免费档', freeModel: 'gpt-4o-mini' }], 'p-free');
      const probe = stubModels([{ models: ['gpt-4o-mini'] }]);
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL('gpt-4o-mini') });

      await get(app, '/api/registry');
      expect(probe.hits()).toBe(0); // 表是纯读盘：网关慢/挂不该把整张表拖红

      const first = await get(app, '/api/registry/health');
      expect(probe.hits()).toBe(1);
      expect(first.json().entries[0].health.status).toBe('live');

      await get(app, '/api/registry/health');
      expect(probe.hits()).toBe(1); // 自家缓存

      const catalog = await get(app, '/api/gateway/catalog');
      expect(catalog.json().profiles[0].models).toEqual(['gpt-4o-mini']);
      expect(probe.hits()).toBe(1); // **同一份实现**：换了消费者不重探

      await get(app, '/api/registry/health?refresh=1');
      expect(probe.hits()).toBe(2); // 强刷仍走同一道闸
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});

describe('v14-R4 单枚探针（`GET /api/registry/:id/health` = `paneflow registry probe <id>` 的落点）', () => {
  /** id 里的 `:` 按 CLI 的写法编码：路由要能把 `model%3Agpt-4o-mini` 还原成盘上那枚 id */
  const probeUrl = (id: string, q = '') => `/api/registry/${encodeURIComponent(id)}/health${q}`;

  it('只探这一条：detail 是 server 那句人话，且与批量面/catalog 吃同一份缓存（不重探）', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-free', name: '免费档', freeModel: 'gpt-4o-mini' }], 'p-free');
      const probe = stubModels([{ models: ['gpt-4o-mini'] }]);
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL('gpt-4o-mini') });

      const res = await get(app, probeUrl('model:gpt-4o-mini'));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entry.id).toBe('model:gpt-4o-mini');
      expect(body.entry.label).toBe('gpt-4o-mini'); // 单枚面也带 label/refs，CLI 不必二次请求
      expect(body.entry.refs).toEqual([{ face: 'gateway', id: 'p-free', name: '免费档', via: 'freeModel' }]);
      expect(body.health.status).toBe('live');
      expect(body.health.detail).toContain('在「免费档」的实探清单里');
      expect(probe.hits()).toBe(1);

      await get(app, probeUrl('model:gpt-4o-mini'));
      expect(probe.hits()).toBe(1); // 自家缓存

      const catalog = await get(app, '/api/gateway/catalog');
      expect(catalog.json().profiles[0].models).toEqual(['gpt-4o-mini']);
      expect(probe.hits()).toBe(1); // 与 catalog 同一份实现：换了消费者不重探

      const batch = await get(app, '/api/registry/health');
      expect(batch.json().entries[0].health.status).toBe('live');
      expect(probe.hits()).toBe(1); // 批量面与单枚面也是同一份：换粒度不重探

      await get(app, probeUrl('model:gpt-4o-mini', '?refresh=1'));
      expect(probe.hits()).toBe(2); // 强刷仍走同一道闸
      const again = await get(app, probeUrl('model:gpt-4o-mini'));
      expect(probe.hits()).toBe(2); // 强刷那一探也落进同一份缓存，下一次照吃
      expect(JSON.stringify(again.json())).not.toContain('sk-secret');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('id 不在表上＝404 一句指路，不是空读数也不是 unknown（「没这条」与「探不通」分家）', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-free', name: '免费档' }], 'p-free');
      const probe = stubModels([{ models: ['gpt-4o'] }]);
      const res = await get(app, probeUrl('model:gpt-nope'));
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toContain('model:gpt-nope');
      expect(body.error).toContain('先 GET /api/registry');
      expect(body.health).toBeUndefined();
      expect(probe.hits()).toBe(0); // 不存在的条目不配打网络
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('这一类没有探针通道＝`health` 整键不给（路由不把它写成 null）；同一条盘上 `/api/registry/health` 仍落批量那一刀', async () => {
    const role = {
      id: 'role:r-x',
      kind: 'role',
      name: '交付岗',
      source: 'user',
      enabled: true,
      createdAt: '2026-09-26T10:00:00.000Z',
      updatedAt: '2026-09-26T10:00:00.000Z',
      spec: {},
    } as unknown as RegistryEntry;
    const { app } = await build([role]);
    try {
      stubModels([{ models: [] }]);
      const body = (await get(app, probeUrl('role:r-x'))).json();
      expect(body.entry.id).toBe('role:r-x');
      // descriptor 没挂号时 label 兜 name（不返空串冒充标签）
      expect(body.entry.label).toBe('交付岗');
      expect('health' in body).toBe(false);
      // 静态段 vs 参数段的优先级：`/api/registry/health` 不能被 `:id` 吞成「探 id 叫 health 的条目」
      const batch = (await get(app, '/api/registry/health')).json();
      expect(batch.entries).toHaveLength(1);
      expect(batch.summary).toMatchObject({ scanned: 0, probed: 0 });
      expect('health' in batch.entries[0]).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});

describe('v14-R4 汇总账：哪些裸串引用被注册表承接了', () => {  it('freeModel 没人登记＝悬挂裸串（E2 的登记输入）；登记同值后引用账改口，悬挂归零', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-free', name: '免费档', freeModel: 'gpt-9' }], 'p-free');
      stubModels([{ models: ['gpt-9'] }]);
      const before = (await get(app, '/api/registry/health')).json();
      expect(before.dangling).toEqual([
        { kind: 'model', target: 'gpt-9', by: [{ face: 'gateway', id: 'p-free', name: '免费档', via: 'freeModel' }] },
      ]);
      // 一条都没登记：没有探针通道＝probed 0（缺读数，不是 unknown）；unused 也是 0
      expect(before.summary).toEqual({ scanned: 2, dangling: 1, unmigrated: 1, probed: 0, live: 0, missing: 0, unknown: 0, unused: 0 });

      // 登记时人给的名字与裸串不同——按 spec 值匹配（refKeys）才对得上，按登记名匹配必猜错
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: { kind: 'model', name: '备用型号', spec: { model: 'gpt-9' } } });
      const after = (await get(app, '/api/registry/health')).json();
      expect(after.dangling).toEqual([]);
      expect(after.entries[0].refs).toHaveLength(1);
      expect(after.summary).toMatchObject({ dangling: 0, probed: 1, live: 1, unused: 0 });
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('gateway-profile 一类还没进表：只披露计数，绝不判死活（宁缺毋假）', async () => {
    const { app, dataDir } = await build();
    try {
      gatewayDoc(dataDir, [{ id: 'p-free', name: '免费档' }], 'p-free');
      stubModels([{ models: [] }]);
      const body = (await get(app, '/api/registry/health')).json();
      // 只有 `current` 这一枚 gateway-profile 引用：没进表＝只数不判（判「不存在」就是拿空白冒充断言）
      expect(body.summary.unmigrated).toBe(1);
      expect(body.dangling).toEqual([]);
      expect(body.entries).toEqual([]); // 一条都没登记＝[] 是正读数
      expect(body.summary.probed).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});

describe('v14-R4 分派表：没有通道的 kind 整键不给', () => {
  it('未知 kind → undefined（不是 unknown、不是 missing——那是两件事）', async () => {
    const dataDir = tmp();
    const e = { id: 'role:r-x', kind: 'role', name: 'x', source: 'user', enabled: true, createdAt: '', updatedAt: '', spec: {} } as unknown as RegistryEntry;
    expect(await entryHealth(dataDir, e)).toBeUndefined();
  });
});
