import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import { RegistryStore } from '../orchestrate/registry.js';
import { buildHttpServer } from './http.js';
import { registerRegistryRoutes } from './registry-routes.js';

/**
 * v14 A1+A2（R1+R2）注册内核 HTTP 面：四动词与引用账走真 `buildHttpServer` + `app.inject`，
 * 挂载方式与 `index.ts` 逐字相同（先 build 再 `registerRegistryRoutes(app, …)`）——
 * 于是第 7 条断言（令牌钩子覆盖这组路由）证的是**生产组合方式**，不是「Fastify 应该会继承吧」。
 *
 * 引擎/账本在这里桩掉是既有约定（同 `http-health.test.ts`）：这组路由一个字节都不碰 run 账，
 * 桩它不会让任何断言变成自证——判据全在 server 侧的 `normalizeRegistryEntry` 与 `RegistryStore`。
 * 引用面（`registry-refs.ts`）**不桩**：它读的是 fixture dataDir 的真实落盘形状。
 */
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reg-routes-'));
const HOST = '127.0.0.1:4310';

async function build(extra: { authToken?: string } = {}) {
  const dataDir = tmp();
  const registry = new RegistryStore(dataDir, '0.3.0-test');
  const { app } = await buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: { ping: async () => ({ version: '0.0.0' }) } as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    ...extra,
  });
  registerRegistryRoutes(app, { registry, dataDir });
  return { app, registry, dataDir };
}

const MODEL = { kind: 'model', name: 'gpt-4o-mini', spec: { model: 'gpt-4o-mini', gatewayProfile: 'free' } };

/** 现役盘面唯一的模型引用写法：网关档 `freeModel`（R2 写端守卫的可感来源，不靠虚构形状） */
function pinGatewayModel(dataDir: string, model: string | null): void {
  fs.writeFileSync(
    path.join(dataDir, 'gateway.json'),
    `${JSON.stringify({ profiles: [{ id: 'free', name: '免费档', baseUrl: 'https://gw.example', ...(model ? { freeModel: model } : {}) }], current: 'free' }, null, 2)}\n`,
  );
}

describe('注册内核四动词（/api/registry）', () => {
  it('一条都没登记：空表是正读数，knownKinds 当场说清这版认识什么', async () => {
    const { app } = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        entries: [],
        rejected: [],
        schema: null,
        knownKinds: ['model'],
        refSummary: { scanned: 0, dangling: [], unmigrated: [] },
      });
    } finally {
      await app.close();
    }
  });

  it('POST 登记 → 条目带 server 算好的人话 label（CLI 零判据只看字段）', async () => {
    const { app, registry } = await build();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      expect(res.statusCode).toBe(200);
      expect(res.json().entry).toMatchObject({ id: 'model:gpt-4o-mini', label: 'gpt-4o-mini · 档=free', source: 'user' });
      const got = await app.inject({ method: 'GET', url: '/api/registry/model:gpt-4o-mini', headers: { host: HOST } });
      expect(got.json().entry.id).toBe('model:gpt-4o-mini');
      expect(registry.readSchema()).toEqual({ version: 1, writtenBy: '0.3.0-test' });
    } finally {
      await app.close();
    }
  });

  it('spec 脏 → 400 且文案就是清洗层那句（路由层不自造第二份判据）', async () => {
    const { app } = await build();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'model', name: 'x', spec: { model: 'x', freemodel: true } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('含未知键 freemodel');
    } finally {
      await app.close();
    }
  });

  it('?kind= 值域由 server 说：拼错的组名不渲成「这一组没东西」', async () => {
    const { app } = await build();
    try {
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      const dirty = await app.inject({ method: 'GET', url: '/api/registry?kind=plugin', headers: { host: HOST } });
      expect(dirty.statusCode).toBe(400);
      expect(dirty.json().error).toContain('不认的能力类型「plugin」');
      const ok = await app.inject({ method: 'GET', url: '/api/registry?kind=model', headers: { host: HOST } });
      expect(ok.json().entries).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('PATCH 只改三键、DELETE 删一条；未知 id 一律 404 指路', async () => {
    const { app } = await build();
    try {
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      const bad = await app.inject({
        method: 'PATCH',
        url: '/api/registry/model:gpt-4o-mini',
        headers: { host: HOST },
        payload: { name: 'x', source: 'builtin' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toContain('只认 name/spec/enabled');
      const off = await app.inject({
        method: 'PATCH',
        url: '/api/registry/model:gpt-4o-mini',
        headers: { host: HOST },
        payload: { enabled: false },
      });
      expect(off.json().entry.enabled).toBe(false);
      const del = await app.inject({ method: 'DELETE', url: '/api/registry/model:gpt-4o-mini', headers: { host: HOST } });
      expect(del.json().deleted.id).toBe('model:gpt-4o-mini');
      const gone = await app.inject({ method: 'GET', url: '/api/registry/model:gpt-4o-mini', headers: { host: HOST } });
      expect(gone.statusCode).toBe(404);
      expect(gone.json().error).toContain('先 GET /api/registry');
    } finally {
      await app.close();
    }
  });

  it('版本戳比本机新：写面 409（不是调用方的错），读面照读', async () => {
    const { app, dataDir } = await build();
    try {
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      fs.writeFileSync(path.join(dataDir, 'registry', 'schema.json'), `${JSON.stringify({ version: 99, writtenBy: '9.0.0' })}\n`);
      const res = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'model', name: 'other', spec: { model: 'other' } },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('先升级 PaneFlow');
      const list = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(list.json().entries).toHaveLength(1);
      expect(list.json().schema).toEqual({ version: 99, writtenBy: '9.0.0' });
    } finally {
      await app.close();
    }
  });

  it('表读不出 → 500 一句为什么（把盘坏了渲成「一条都没登记」是假绿）', async () => {
    const { app, dataDir } = await build();
    try {
      fs.mkdirSync(path.join(dataDir, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'registry', 'entries.json'), '{坏 JSON');
      const res = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain('注册表读不出');
    } finally {
      await app.close();
    }
  });

  it('挂在 buildHttpServer 之外也吃令牌钩子（远程暴露模式不开无鉴权写入口）', async () => {
    const { app } = await build({ authToken: 'tok-1' });
    try {
      const noHeader = await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      expect(noHeader.statusCode).toBe(401);
      const noHeaderRead = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(noHeaderRead.statusCode).toBe(401);
      const withHeader = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST, authorization: 'Bearer tok-1' },
        payload: MODEL,
      });
      expect(withHeader.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('引用完整性（R2：写端拒悬挂、读端列引用者）', () => {
  it('有人正在用：条目带 refs 上架，删除与禁用都 400 且把要改的位置一次给够', async () => {
    const { app, dataDir } = await build();
    try {
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      pinGatewayModel(dataDir, 'gpt-4o-mini');
      const list = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(list.json().entries[0].refs).toEqual([{ face: 'gateway', id: 'free', name: '免费档', via: 'freeModel' }]);
      expect(list.json().refSummary.dangling).toEqual([]);

      const del = await app.inject({ method: 'DELETE', url: '/api/registry/model:gpt-4o-mini', headers: { host: HOST } });
      expect(del.statusCode).toBe(400);
      expect(del.json().error).toContain('还被 1 处引用着');
      expect(del.json().error).toContain('网关档「免费档」的 freeModel');
      expect(del.json().error).toContain('先改掉那几处再来');
      const off = await app.inject({
        method: 'PATCH',
        url: '/api/registry/model:gpt-4o-mini',
        headers: { host: HOST },
        payload: { enabled: false },
      });
      expect(off.statusCode).toBe(400);
      expect(off.json().error).toContain('禁用它');
      // 条目照旧在盘上：拒的是这一次写，不是顺手把账清了
      expect((await app.inject({ method: 'GET', url: '/api/registry/model:gpt-4o-mini', headers: { host: HOST } })).json().entry.enabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('改名不是改引用：把 freeModel 换掉之后删除立刻放行（守卫吃实读，不缓存旧账）', async () => {
    const { app, dataDir } = await build();
    try {
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      pinGatewayModel(dataDir, 'gpt-4o-mini');
      pinGatewayModel(dataDir, 'another-model');
      const del = await app.inject({ method: 'DELETE', url: '/api/registry/model:gpt-4o-mini', headers: { host: HOST } });
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted.id).toBe('model:gpt-4o-mini');
    } finally {
      await app.close();
    }
  });

  it('普通更新（改名）不受引用守卫牵连：只有「不再被选」的两件事需要过闸', async () => {
    const { app, dataDir } = await build();
    try {
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      pinGatewayModel(dataDir, 'gpt-4o-mini');
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/registry/model:gpt-4o-mini',
        headers: { host: HOST },
        payload: { name: '小4号' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().entry).toMatchObject({ name: '小4号', id: 'model:gpt-4o-mini' });
      // id 是引用锚，改名后引用账照旧跟得上
      expect(res.json().entry.refs).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('引用账扫不出 → 500，绝不降级成「零引用」放行删除（假绿最危险的落点）', async () => {
    const { app, dataDir } = await build();
    try {
      await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      // 拿「`graphs` 不是目录」当探针：比 chmod 稳（root/CI 下权限挡不住读），且是真实会发生的盘面形状
      fs.writeFileSync(path.join(dataDir, 'graphs'), '不是目录');
      const list = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(list.statusCode).toBe(500);
      expect(list.json().error).toContain('引用账扫不出');
      const del = await app.inject({ method: 'DELETE', url: '/api/registry/model:gpt-4o-mini', headers: { host: HOST } });
      expect(del.statusCode).toBe(500);
      expect(del.json().error).toContain('引用账扫不出');
      // 条目还在盘上：读不出引用账时删除**没有**被放行
      expect(fs.readFileSync(path.join(dataDir, 'registry', 'entries.json'), 'utf8')).toContain('model:gpt-4o-mini');
    } finally {
      await app.close();
    }
  });

  it('写端回执读不动引用账时省掉 refs 键（缺＝不知道，绝不渲成「零引用」）', async () => {
    const { app, dataDir } = await build();
    try {
      fs.writeFileSync(path.join(dataDir, 'graphs'), '不是目录');
      const res = await app.inject({ method: 'POST', url: '/api/registry', headers: { host: HOST }, payload: MODEL });
      expect(res.statusCode).toBe(200);
      expect(res.json().entry).toMatchObject({ id: 'model:gpt-4o-mini', label: 'gpt-4o-mini · 档=free' });
      expect('refs' in res.json().entry).toBe(false);
    } finally {
      await app.close();
    }
  });
});
