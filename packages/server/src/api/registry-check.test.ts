import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import { RegistryStore } from '../orchestrate/registry.js';
import { normalizeRegistryEntry, type RegistryEntry } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import { registerRegistryRoutes } from './registry-routes.js';

/**
 * v14-T3 预检 HTTP 面（`GET /api/registry/check`）。
 *
 * 判据本身在 `orchestrate/registry-check.test.ts` 逐条钉过，这里只证三件路由才有的事：
 *  1. 静态段 `/api/registry/check` 不被 `/api/registry/:id` 吃掉（与 R4 健康点同款的撞车形状）；
 *  2. 一次请求拿**全部**在册模板（网页模板卡不是一卡一发请求），`?template=` 才收窄到一行；
 *  3. 读盘失败渲 500 而不渲「零模板 / 全绿」——把假读数送给无人值守方，比报错更难查。
 */
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reg-check-'));
const HOST = '127.0.0.1:4310';

const modelEntry = (enabled = true): RegistryEntry => {
  const r = normalizeRegistryEntry({
    kind: 'model',
    name: 'gpt-4o-mini',
    spec: { model: 'gpt-4o-mini', gatewayProfile: 'free' },
    enabled,
  });
  if (!r.ok) throw new Error(r.why);
  return r.value;
};

/**
 * 桩 `load()` 只在两格用：注册表读不出（真 store 造不出破烂盘面而不抛——它整条不认是设计），
 * 以及 `enabled:false`（写端把禁用位留着，POST 造不出「禁用但仍注册」的形状）。
 * 其余一律走真 store，免得把「路由 ↔ RegistryStore 的装配」桩成自证。
 */
async function build(loadStub?: () => { entries: RegistryEntry[]; rejected: unknown[] }) {
  const dataDir = tmp();
  const registry = loadStub
    ? ({ load: loadStub } as unknown as RegistryStore)
    : new RegistryStore(dataDir, '0.3.0-test');
  const { app } = await buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: { ping: async () => ({ version: '0.0.0' }) } as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
  registerRegistryRoutes(app as FastifyInstance, { registry, dataDir });
  return { app, registry: registry as RegistryStore, dataDir };
}

const graph = (name: string, requires?: unknown[]) => ({
  version: 1,
  name,
  nodes: [],
  edges: [],
  metadata: { createdAt: '', updatedAt: '' },
  ...(requires ? { requires } : {}),
});

function writeGraphs(dataDir: string, docs: unknown[]): void {
  fs.mkdirSync(path.join(dataDir, 'graphs'), { recursive: true });
  for (const d of docs) {
    fs.writeFileSync(path.join(dataDir, 'graphs', `${(d as { name: string }).name}.json`), JSON.stringify(d));
  }
}

const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });

describe('GET /api/registry/check', () => {
  it('默认扫全部在册模板：逐行带 slots/need/ok；没带槽的行也在账上（空数组是正读数）', async () => {
    const { app, registry, dataDir } = await build();
    try {
      expect(registry.add({ kind: 'model', name: 'gpt-4o-mini', spec: { model: 'gpt-4o-mini' } }).ok).toBe(true);
      writeGraphs(dataDir, [
        graph('flow', [{ kind: 'model' }, { kind: 'model', id: 'nope' }, { kind: 'skill', id: 'skills/x/SKILL.md' }]),
        graph('bare'),
      ]);
      const res = await get(app, '/api/registry/check');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.space).toBe('default');
      expect(body.templates.map((t: { template: string }) => t.template)).toEqual(['bare', 'flow']); // 文件名排序=稳定顺序
      const flow = body.templates[1];
      expect(flow.slots.map((s: { verdict: string }) => s.verdict)).toEqual(['ok', 'missing', 'unjudged']);
      expect(flow.ok).toBe(false);
      expect(flow.need).toEqual([
        { kind: 'model', label: '模型', declared: 2, judged: 2, gaps: 1 },
        { kind: 'skill', label: '技能', declared: 1, judged: 0, gaps: 0 },
      ]);
      expect(body.templates[0]).toMatchObject({ template: 'bare', slots: [], need: [], ok: true });
    } finally {
      await app.close();
    }
  });

  it('?template= 收窄到一行；问的模板不在册 → 404 指路到 /api/graphs（不是 200 空数组）', async () => {
    const { app, dataDir } = await build();
    try {
      writeGraphs(dataDir, [graph('flow', [{ kind: 'model' }]), graph('other')]);
      const one = await get(app, '/api/registry/check?template=flow');
      expect(one.statusCode).toBe(200);
      expect(one.json().templates.map((t: { template: string }) => t.template)).toEqual(['flow']);
      const ghost = await get(app, '/api/registry/check?template=ghost');
      expect(ghost.statusCode).toBe(404);
      expect(ghost.json().error).toContain('模板不存在：ghost');
    } finally {
      await app.close();
    }
  });

  it('?space= 原样回显并带诚实标注：本版项目名不参与死活判定（等带作用域的 kind 迁入才接线）', async () => {
    const { app } = await build();
    try {
      const res = await get(app, '/api/registry/check?space=demo');
      expect(res.json().space).toBe('demo');
      expect(res.json().spaceNote).toContain('项目名只影响指路文案');
    } finally {
      await app.close();
    }
  });

  it('静态段不被 /api/registry/:id 吃掉：同一台 server 上两枚路由各回各的形状', async () => {
    const { app } = await build();
    try {
      const res = await get(app, '/api/registry/check');
      expect(res.statusCode).toBe(200);
      expect(res.json().templates).toEqual([]); // 一个在册模板也没有——正读数，与下面那格 404 分家
      const byId = await get(app, '/api/registry/model%3Agpt-4o-mini');
      expect(byId.statusCode).toBe(404);
      expect(byId.json().error).toContain('注册表里没有'); // 参数段那条路：真按条目 id 找
    } finally {
      await app.close();
    }
  });

  it('注册表读不出 → 500 一句人话，绝不降级成「模板都没带槽」的全绿', async () => {
    const { app } = await build(() => {
      throw new Error('盘上 registry.json 是破烂');
    });
    try {
      const res = await get(app, '/api/registry/check');
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain('注册表读不出');
    } finally {
      await app.close();
    }
  });

  it('禁用中的条目不凑槽：HTTP 面与纯函数同一结论（不是路由自己放宽了一次）', async () => {
    const { app, dataDir } = await build(() => ({ entries: [modelEntry(false)], rejected: [] }));
    try {
      writeGraphs(dataDir, [graph('flow', [{ kind: 'model' }])]);
      const res = await get(app, '/api/registry/check');
      expect(res.json().templates[0]).toMatchObject({
        ok: false,
        missing: [{ kind: 'model', verdict: 'missing' }],
      });
    } finally {
      await app.close();
    }
  });

  /**
   * 实机首驾（本片收口前）当场撞出来的洞：模板 `requires` 指着一枚条目，DELETE 却放行了
   * ——删完那张模板的预检从此红着，而「删了会断谁」正是 R2 反向引用账唯一该回答的问题。
   * 这一条钉住两个方向：写端拦得住，同时 `requires: []`（没点名任何条目）不误拦。
   */
  it('requires 点名的条目受「拒删被引用」保护；没点名的槽不建边', async () => {
    const { app, registry, dataDir } = await build();
    try {
      expect(registry.add({ kind: 'model', name: 'gpt-4o-mini', spec: { model: 'gpt-4o-mini' } }).ok).toBe(true);
      writeGraphs(dataDir, [
        graph('named', [{ kind: 'model', id: 'gpt-4o-mini' }]),
        graph('anonymous', [{ kind: 'model' }]),
      ]);
      const blocked = await app.inject({ method: 'DELETE', url: '/api/registry/model%3Agpt-4o-mini', headers: { host: HOST } });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error).toContain('named'); // 指得到是哪张模板按名引用了它，不是含糊一句「有引用」
    } finally {
      await app.close();
    }
  });

  it('条目只被「没点名」的槽需要时仍可删：那种槽吃的是「这一类里随便一枚」，删一枚不等于删断它', async () => {
    const { app, registry, dataDir } = await build();
    try {
      expect(registry.add({ kind: 'model', name: 'gpt-4o-mini', spec: { model: 'gpt-4o-mini' } }).ok).toBe(true);
      writeGraphs(dataDir, [graph('anonymous', [{ kind: 'model' }])]);
      const del = await app.inject({ method: 'DELETE', url: '/api/registry/model%3Agpt-4o-mini', headers: { host: HOST } });
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted.id).toBe('model:gpt-4o-mini');
    } finally {
      await app.close();
    }
  });
});
