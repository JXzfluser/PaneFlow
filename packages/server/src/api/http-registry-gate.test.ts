import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v14 A5-5a 删除闸的**面**：三枚「正身在盘上」的视图 kind 各自的写路径（`PUT /api/roles`、
 * `DELETE /api/gateway/profile/:id`、`DELETE /api/graphs/:id`）自此查引用账。
 *
 * 判据层已在 `orchestrate/registry-gate.test.ts` 逐格钉过，这里只断三件事：
 *  1. 闸确实**接在这一条路由上**（400 + 一句人话，而不是默默放行——单元绿而路由没接线，正是这笔欠账的形状）；
 *  2. 拦下时**盘面一个字节没动**（整本覆写是原子的：拒了却少了一枚岗，比不拦更糟）；
 *  3. 每面各有一条**放行路径**（闸不是「一律 400」；那一格的删除真的发生了）。
 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-http-gate-'));
const HOST = '127.0.0.1:4310';

async function build() {
  const dataDir = tmp();
  const { app } = await buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
  return { app, dataDir };
}

function writeJson(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
const rolesFile = (dataDir: string): string => path.join(dataDir, 'roles.json');
const gatewayFile = (dataDir: string): string => path.join(dataDir, 'gateway.json');
const graphFile = (dataDir: string, name: string): string => path.join(dataDir, 'graphs', `${name}.json`);
const META = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

/**
 * 一套盘面喂三面：`r-deliver` 被班底（项目）与画布（`sub` 的节点）两处指着、`r-free` 没人用；
 * `sub` 被 `main` 当子流程指着；网关的 `paid` 被项目钉档、`free` 只是生效档。
 */
function seed(dataDir: string): void {
  writeJson(path.join(dataDir, 'spaces', 'demo', 'profile.json'), {
    id: 'demo',
    name: '演示项目',
    createdAt: META.createdAt,
    team: [{ roleId: 'r-deliver' }],
    gatewayProfile: 'paid',
  });
  writeJson(rolesFile(dataDir), [
    { id: 'r-deliver', name: '交付岗' },
    { id: 'r-free', name: '闲岗' },
  ]);
  writeJson(graphFile(dataDir, 'sub'), {
    version: 1,
    name: 'sub',
    nodes: [{ id: 'n1', type: 'agent', label: '活', config: { role: 'r-deliver' } }],
    edges: [],
    metadata: META,
  });
  writeJson(graphFile(dataDir, 'main'), {
    version: 1,
    name: 'main',
    nodes: [{ id: 'p1', type: 'pipeline', label: '子流程', config: { pipeline: { template: 'sub' } } }],
    edges: [],
    metadata: META,
  });
  writeJson(gatewayFile(dataDir), {
    profiles: [
      { id: 'free', name: '免费档', baseUrl: 'https://gw.example', apiKey: 'sk-secret' },
      { id: 'paid', name: '付费档', baseUrl: 'https://paid.example', apiKey: 'sk-paid' },
    ],
    current: 'free',
  });
}

describe('角色库那一面（PUT /api/roles 是整本名册覆写：撤下被引用的岗即拦）', () => {
  it('这次没再带上被引用的岗 → 400 一句人话，且名册一个字节没动', async () => {
    const { app, dataDir } = await build();
    seed(dataDir);
    const before = fs.readFileSync(rolesFile(dataDir), 'utf8');
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/roles',
        headers: { host: HOST },
        payload: { roles: [{ id: 'r-free', name: '闲岗' }] },
      });
      expect(res.statusCode).toBe(400);
      const error = (res.json() as { error: string }).error;
      expect(error).toContain('还被 2 处引用着');
      expect(error).toContain('项目「演示项目」的 team[0].roleId');
      expect(error).toContain('模板「sub」的 nodes[0].config.role');
      expect(fs.readFileSync(rolesFile(dataDir), 'utf8')).toBe(before);
    } finally {
      await app.close();
    }
  });

  it('带着被引用的岗覆写（没撤它）→ 200；只撤没人用的那枚 → 200 且名册真少一枚', async () => {
    const { app, dataDir } = await build();
    seed(dataDir);
    try {
      const keep = await app.inject({
        method: 'PUT',
        url: '/api/roles',
        headers: { host: HOST },
        payload: { roles: [{ id: 'r-deliver', name: '交付岗' }, { id: 'r-free', name: '闲岗' }] },
      });
      expect(keep.statusCode).toBe(200);
      const drop = await app.inject({
        method: 'PUT',
        url: '/api/roles',
        headers: { host: HOST },
        payload: { roles: [{ id: 'r-deliver', name: '交付岗' }] },
      });
      expect(drop.statusCode).toBe(200);
      expect(drop.json()).toEqual({ saved: 1 });
      expect((readJson(rolesFile(dataDir)) as { id: string }[]).map((r) => r.id)).toEqual(['r-deliver']);
    } finally {
      await app.close();
    }
  });

  it('引用账扫不出（模板盘读不动）→ 500 不放行，覆写不落盘：闸不会降级成「零引用」给删除开绿灯', async () => {
    const { app, dataDir } = await build();
    seed(dataDir);
    // `graphs` 摆成一枚普通文件：视图面把它渲成一条披露（注册表整面照读），引用账那一侧照抛。
    // 这一格走 PUT /api/roles——它不构造 `Store`，不会先把那枚目录补回来，证的正是「抛错＝拦下整次写」。
    fs.rmSync(path.join(dataDir, 'graphs'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dataDir, 'graphs'), 'not a directory');
    const before = fs.readFileSync(rolesFile(dataDir), 'utf8');
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/roles',
        headers: { host: HOST },
        payload: { roles: [{ id: 'r-free', name: '闲岗' }] },
      });
      expect(res.statusCode).toBe(500);
      const error = (res.json() as { error: string }).error;
      expect(error).toContain('引用账扫不出');
      expect(error).toContain('读不出不等于没人用，这次不放行');
      expect(fs.readFileSync(rolesFile(dataDir), 'utf8')).toBe(before);
    } finally {
      await app.close();
    }
  });
});

describe('网关那一面（DELETE /api/gateway/profile/:id）', () => {
  it('被项目钉档的档 → 400 点名那枚项目，档还在盘上；current 那一格不算引用者、密钥不外露', async () => {
    const { app, dataDir } = await build();
    seed(dataDir);
    const before = fs.readFileSync(gatewayFile(dataDir), 'utf8');
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/gateway/profile/paid', headers: { host: HOST } });
      expect(res.statusCode).toBe(400);
      const error = (res.json() as { error: string }).error;
      expect(error).toContain('项目「演示项目」的 gatewayProfile');
      expect(error).not.toContain('current');
      expect(error).not.toContain('sk-paid');
      expect(fs.readFileSync(gatewayFile(dataDir), 'utf8')).toBe(before);
    } finally {
      await app.close();
    }
  });

  it('只被 current 指着的生效档 → 放行，删完顺延到剩下那档', async () => {
    const { app, dataDir } = await build();
    seed(dataDir);
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/gateway/profile/free', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, current: 'paid' });
      expect((readJson(gatewayFile(dataDir)) as { profiles: { id: string }[] }).profiles.map((p) => p.id)).toEqual(['paid']);
    } finally {
      await app.close();
    }
  });
});

describe('画布那一面（DELETE /api/graphs/:id）', () => {
  it('被别的图当子流程指着的模板 → 400 点名那张图与那一格，文件还在', async () => {
    const { app, dataDir } = await build();
    seed(dataDir);
    const file = graphFile(dataDir, 'sub');
    const before = fs.readFileSync(file, 'utf8');
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/graphs/sub', headers: { host: HOST } });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('模板「main」的 nodes[0].config.pipeline.template');
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      await app.close();
    }
  });

  it('没人指的模板 → 真删；自指的模板也删得掉（自己那条边随文件消失，不构成悬挂）', async () => {
    const { app, dataDir } = await build();
    seed(dataDir);
    writeJson(graphFile(dataDir, 'wrap'), {
      version: 1,
      name: 'wrap',
      nodes: [{ id: 'p1', type: 'pipeline', label: '子流程', config: { pipeline: { template: 'wrap' } } }],
      edges: [],
      metadata: META,
    });
    try {
      const wrap = await app.inject({ method: 'DELETE', url: '/api/graphs/wrap', headers: { host: HOST } });
      expect(wrap.statusCode).toBe(200);
      expect(wrap.json()).toEqual({ deleted: true });
      const main = await app.inject({ method: 'DELETE', url: '/api/graphs/main', headers: { host: HOST } });
      expect(main.json()).toEqual({ deleted: true });
      expect(fs.existsSync(graphFile(dataDir, 'sub'))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
