import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import { RegistryStore } from '../orchestrate/registry.js';
import { requirementKindLabel } from '../orchestrate/registry-check.js';
import { DAG_NODE_TYPES, NODE_TYPE_CATALOG } from '@paneflow/shared';
import { AGENT_KINDS } from './agent-kinds.js';
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
  it('一条都没登记：用户登记项为空是正读数，出厂清单以视图项上架（A3-2 R3 分组的面）', async () => {
    const { app } = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        entries: { id: string; kind: string; name: string; source: string; view: boolean; label: string; spec: unknown }[];
        rejected: unknown[];
        schema: unknown;
        knownKinds: string[];
        viewKinds: string[];
        kindLabels: Record<string, string>;
        refSummary: unknown;
      };
      expect(body.entries.filter((e) => !e.view)).toEqual([]); // 盘上真的一条没登记——这格还是正读数零
      expect(body.rejected).toEqual([]);
      expect(body.schema).toBeNull();
      expect(body.knownKinds).toEqual(['model', 'agent-kind', 'node-type']);
      expect(body.viewKinds).toEqual(['agent-kind', 'node-type']);
      // 组名只有一处措辞表（`registry-check.ts` 的 `KIND_CN`）：网页拿这张外发表的标签画分组，
      // 前端不再自己抄一份——抄了迟早分叉，而分叉的代价是「同一个 kind 两处两个名字」。
      expect(Object.keys(body.kindLabels).sort()).toEqual([...body.knownKinds].sort());
      expect(body.kindLabels).toMatchObject({ model: '模型', 'agent-kind': 'Agent 引擎', 'node-type': '节点类型' });
      expect(requirementKindLabel('agent-kind')).toBe(body.kindLabels['agent-kind']);
      expect(body.refSummary).toEqual({ scanned: 0, dangling: [], unmigrated: [] });
      // 视图项=出厂清单成员，一条不多一条不少（计数吃单一事实源，不写死 18）
      const agents = body.entries.filter((e) => e.kind === 'agent-kind');
      expect(agents).toHaveLength(AGENT_KINDS.length);
      expect(new Set(agents.map((e) => e.name))).toEqual(new Set(AGENT_KINDS));
      expect(body.entries.every((e) => e.view && e.source === 'builtin')).toBe(true);
      expect(new Set(body.entries.map((e) => e.kind))).toEqual(new Set(body.viewKinds));
      // label 由 Descriptor 算：异名才说话，同名不重复一遍
      const agy = body.entries.find((e) => e.name === 'antigravity-cli');
      expect(agy).toMatchObject({ id: 'agent-kind:antigravity-cli', label: '探测名 antigravity', spec: { binary: 'antigravity' } });
      expect(body.entries.find((e) => e.name === 'pi')).toMatchObject({ label: '探测名同 kind', spec: { binary: 'pi' } });
    } finally {
      await app.close();
    }
  });

  /**
   * 视图 kind 的写入面三动词全拒（A3-2 的立命之处）：不拒的话，用户手造的 `agent-kind:xxx`
   * 会被读端当成可用能力，而它既进不了节点校验也起不了 agent。
   */
  it('内置清单类不能登记也不能改：POST/PATCH 400 一句指路，DELETE 只清盘上那条', async () => {
    const { app, registry, dataDir } = await build();
    try {
      const add = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'agent-kind', name: 'my-agent', spec: { binary: 'my-agent' } },
      });
      expect(add.statusCode).toBe(400);
      expect(add.json().error).toContain('内置能力清单');
      expect(add.json().error).toContain('注册表不代造本机没有的东西');
      expect(registry.list('agent-kind')).toEqual([]); // 拒得干净：盘上没落下一条
      expect(fs.existsSync(path.join(dataDir, 'registry', 'entries.json'))).toBe(false);

      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/registry/agent-kind%3Api',
        headers: { host: HOST },
        payload: { enabled: false },
      });
      expect(patch.statusCode).toBe(400);
      expect(patch.json().error).toContain('改不了它');

      // 视图项在表上：GET 得到、DELETE 拒（它不落盘，拆不掉出厂项——写面 refusal 与未知 id 同款 400）
      const got = await app.inject({ method: 'GET', url: '/api/registry/agent-kind%3Api', headers: { host: HOST } });
      expect(got.statusCode).toBe(200);
      expect(got.json().entry).toMatchObject({ id: 'agent-kind:pi', view: true });
      const del = await app.inject({ method: 'DELETE', url: '/api/registry/agent-kind%3Api', headers: { host: HOST } });
      expect(del.statusCode).toBe(400);
      expect(del.json().error).toContain('内置能力清单');
    } finally {
      await app.close();
    }
  });

  /**
   * 手把 `agent-kind` 塞进 `entries.json`（绕过写入面）：读端**不吃**它，出厂项优先，
   * 盘上那条进 `rejected` 只披露——同时 DELETE 仍能清掉它（不然一条不生效的残记录永远删不掉）。
   */
  it('盘上手写的视图项：被出厂项遮蔽并进 rejected，DELETE 清得掉', async () => {
    const { app, dataDir } = await build();
    try {
      fs.mkdirSync(path.join(dataDir, 'registry'), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'registry', 'entries.json'),
        `${JSON.stringify({ entries: [{ id: 'agent-kind:pi', kind: 'agent-kind', name: 'pi', source: 'user', enabled: false, createdAt: '2026-01-01T00:00:00.000Z', spec: { binary: 'not-real' } }] })}\n`,
      );
      const list = await app.inject({ method: 'GET', url: '/api/registry?kind=agent-kind', headers: { host: HOST } });
      expect(list.json().entries).toHaveLength(AGENT_KINDS.length); // 全看出厂项，遮蔽的那条不掺进来
      const pi = list.json().entries.find((e: { id: string }) => e.id === 'agent-kind:pi');
      expect(pi).toMatchObject({ source: 'builtin', enabled: true, spec: { binary: 'pi' } });
      const shadow = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(shadow.json().rejected).toHaveLength(1);
      expect(shadow.json().rejected[0].id).toBe('agent-kind:pi');
      expect(shadow.json().rejected[0].why).toContain('内置能力清单');
      expect(shadow.json().rejected[0].why).toContain('DELETE');

      const del = await app.inject({ method: 'DELETE', url: '/api/registry/agent-kind%3Api', headers: { host: HOST } });
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted).toMatchObject({ id: 'agent-kind:pi', view: true });
      const after = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(after.json().rejected).toEqual([]);
      expect(after.json().entries).toHaveLength(AGENT_KINDS.length + NODE_TYPE_CATALOG.length); // 清的是盘上残条，出厂项一条没少
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

  /**
   * v14 T1 的对外读数：画布节点面板从此只问这一刀（`Palette.tsx` 那份硬编码按钮列表已拆掉）。
   * 这里钉「表里有什么」，画法怎么排成组是 web 的纯函数判据（`node-types.test.ts`）。
   */
  it('GET ?kind=node-type：出厂六型上架，画法字段齐（label/icon/group/order），写入面照拒', async () => {
    const { app, registry, dataDir } = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/registry?kind=node-type', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { entries: { id: string; name: string; view: boolean; label: string; spec: Record<string, unknown> }[] };
      expect(body.entries.map((e) => e.name).sort()).toEqual([...DAG_NODE_TYPES].sort());
      expect(body.entries.every((e) => e.view && e.spec.label && e.spec.icon && typeof e.spec.order === 'number')).toBe(true);
      // 人话标签说「画布上长成什么样」，不把机器值重念一遍
      expect(body.entries.find((e) => e.name === 'agent')).toMatchObject({
        id: 'node-type:agent',
        label: '「Agent 节点」· 核心',
        spec: { icon: '⚙', group: 'core', order: 1, hint: '一个 Agent 节点 = 一个独立终端 Pane，在这里写任务指令' },
      });
      // `order` 存在是因为台账序≠画法序：条目按 id 稳定排，那样「结束」会排在「开始」前面
      expect(body.entries.map((e) => e.id)).toEqual([...body.entries.map((e) => e.id)].sort());
      // 线上传的 order 得是真数（web 侧拿它排序；是字符串就一路静默回落成 id 序，画法序白做）
      const orderOf = (name: string) => {
        const raw = body.entries.find((e) => e.name === name)!.spec.order;
        if (typeof raw !== 'number') throw new Error(`${name} 的 order 不是数：${JSON.stringify(raw)}`);
        return raw;
      };
      expect(orderOf('start')).toBeLessThan(orderOf('end'));
      // 写入面对这一类同样全关：表单据此收起（`registrableKinds` 吃 viewKinds），不给「点开却登记不了」的假可点
      const add = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'node-type', name: 'my-node', spec: { label: '我的节点', icon: '★', group: 'core', order: 1 } },
      });
      expect(add.statusCode).toBe(400);
      expect(add.json().error).toContain('内置能力清单');
      expect(registry.list('node-type')).toEqual([]);
      expect(fs.existsSync(path.join(dataDir, 'registry', 'entries.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  /**
   * v14 T1 的 HTTP 面：画布节点面板从此读这一刀（`Palette.tsx` 里那份硬编码按钮列表已拆）。
   * 这里钉的是「server 交出去的那张表长什么样」，画法怎么排是 web 的纯函数（`node-types.test.ts`）。
   */
  it('GET /api/registry?kind=node-type：出厂六型带画法字段上架（画布面板的数据源）', async () => {
    const { app } = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/registry?kind=node-type', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { entries: { id: string; name: string; view: boolean; label: string; spec: Record<string, unknown> }[] };
      expect(body.entries.map((e) => e.name).sort()).toEqual([...DAG_NODE_TYPES].sort());
      expect(body.entries.every((e) => e.view && e.spec.label && e.spec.icon && typeof e.spec.order === 'number')).toBe(true);
      // label 说的是画布上的样子（中文名 + 归组），不是把机器值重念一遍
      expect(body.entries.find((e) => e.name === 'agent')).toMatchObject({
        id: 'node-type:agent',
        label: '「Agent 节点」· 核心',
        spec: { icon: '⚙', group: 'core', order: 1 },
      });
      // 台账序（条目按 id 稳定排）与画布序是两件事：id 序把「结束」排在「开始」前面。
      // 所以画法必须自带一枚 `order`，不能拿台账序冒充——这一条同时钉住「两把尺没被并成一把」。
      const byId = body.entries.map((e) => e.name);
      expect(byId).toEqual([...byId].sort());
      expect(byId.indexOf('end')).toBeLessThan(byId.indexOf('start'));
      const order = (name: string): number => body.entries.find((e) => e.name === name)!.spec.order as number;
      expect(order('start')).toBeLessThan(order('end'));
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
      // 读面照读：盘上那条 + 出厂清单的视图项都在表上（视图项本来就不落盘，版本戳管不着它）
      expect(list.json().entries.filter((e: { view: boolean }) => !e.view)).toHaveLength(1);
      expect(list.json().entries.filter((e: { view: boolean }) => e.view)).toHaveLength(
        AGENT_KINDS.length + NODE_TYPE_CATALOG.length,
      );
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
