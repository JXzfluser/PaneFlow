import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import { RegistryStore } from '../orchestrate/registry.js';
import { requirementKindLabel } from '../orchestrate/registry-check.js';
import { viewHomeOf } from '../orchestrate/registry-view.js';
import { CHECK_SPEC_TYPES, CHECK_TYPE_CATALOG, DAG_NODE_TYPES, MACHINE_CHECK_TYPES, NODE_TYPE_CATALOG } from '@paneflow/shared';
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
        viewHomes: Record<string, string>;
      };
      expect(body.entries.filter((e) => !e.view)).toEqual([]); // 盘上真的一条没登记——这格还是正读数零
      expect(body.rejected).toEqual([]);
      expect(body.schema).toBeNull();
      // 挂号序＝注册中心的分组序：登记项在前、视图 kind 穿插在其注册位（A5-4 起 `check-type`、A5-4b-1 起 `role` 进表）
      expect(body.knownKinds).toEqual(['model', 'skill', 'rule', 'repo', 'agent-kind', 'node-type', 'check-type', 'role', 'mcp']);
      expect(body.viewKinds).toEqual(['agent-kind', 'node-type', 'check-type', 'role']);
      // 正身逐 kind 给（A5-4b-1）：四枚视图 kind 里 `role` 住在角色库，其余三枚住在代码。
      // 外发而不是让页面形容词——「版本自带的内置清单」这一句用在用户自己建的岗位上是假话。
      const homes = body.viewHomes;
      expect(Object.keys(homes).sort()).toEqual([...body.viewKinds].sort());
      expect(homes.role).toContain('角色库');
      expect(homes.role).not.toContain('版本自带');
      expect(homes['agent-kind']).toContain('代码决定');
      expect(homes['node-type']).toBe(viewHomeOf('node-type'));
      // 组名只有一处措辞表（`registry-check.ts` 的 `KIND_CN`）：网页拿这张外发表的标签画分组，
      // 前端不再自己抄一份——抄了迟早分叉，而分叉的代价是「同一个 kind 两处两个名字」。
      expect(Object.keys(body.kindLabels).sort()).toEqual([...body.knownKinds].sort());
      expect(body.kindLabels).toMatchObject({ model: '模型', skill: '技能', rule: '规则', repo: '仓库', 'agent-kind': 'Agent 引擎', 'node-type': '节点类型', 'check-type': '机检', role: '角色', mcp: 'MCP 服务' });
      expect(requirementKindLabel('agent-kind')).toBe(body.kindLabels['agent-kind']);
      expect(body.refSummary).toEqual({ scanned: 0, dangling: [], unmigrated: [] });
      // 视图项=现算清单成员，一条不多一条不少（计数吃单一事实源，不写死 18）
      const agents = body.entries.filter((e) => e.kind === 'agent-kind');
      expect(agents).toHaveLength(AGENT_KINDS.length);
      expect(new Set(agents.map((e) => e.name))).toEqual(new Set(AGENT_KINDS));
      expect(body.entries.every((e) => e.view && e.source === 'builtin')).toBe(true);
      // role 这一组此刻**空**是正读数：这一格的名册（`roles.json`）不存在，读端不替用户编岗位。
      // 「视图项只可能来自 `REGISTRY_VIEW_KINDS`」这条仍成立（渲染出来的 kind 是它的子集）。
      expect(body.entries.filter((e) => e.kind === 'role')).toEqual([]);
      expect(new Set(body.entries.map((e) => e.kind))).toEqual(new Set(['agent-kind', 'node-type', 'check-type']));
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
      // 拒句点名这一类的**正身住在哪**（`VIEW_HOME` 一份措辞，四个视图 kind 各有各的答处）
      expect(add.json().error).toContain('版本自带的 agent 类型清单');
      expect(add.json().error).toContain('写入面不代造本机没有的东西');
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
      expect(del.json().error).toContain('版本自带的 agent 类型清单');
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
      expect(shadow.json().rejected[0].why).toContain('读端只吃现算那份');
      expect(shadow.json().rejected[0].why).toContain('DELETE');

      const del = await app.inject({ method: 'DELETE', url: '/api/registry/agent-kind%3Api', headers: { host: HOST } });
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted).toMatchObject({ id: 'agent-kind:pi', view: true });
      const after = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      expect(after.json().rejected).toEqual([]);
      expect(after.json().entries).toHaveLength(
        AGENT_KINDS.length + NODE_TYPE_CATALOG.length + CHECK_TYPE_CATALOG.length,
      ); // 清的是盘上残条，出厂项一条没少
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
      // 台账序（条目按 id 稳定排）与画布序是两件事：id 序把「结束」排在「开始」前面。
      // 所以画法必须自带一枚 `order`，不能拿台账序冒充——这一条同时钉住「两把尺没被并成一把」。
      const byId = body.entries.map((e) => e.name);
      expect(byId.indexOf('end')).toBeLessThan(byId.indexOf('start'));
      // 写入面对这一类同样全关：表单据此收起（`registrableKinds` 吃 viewKinds），不给「点开却登记不了」的假可点
      const add = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'node-type', name: 'my-node', spec: { label: '我的节点', icon: '★', group: 'core', order: 1 } },
      });
      expect(add.statusCode).toBe(400);
      expect(add.json().error).toContain('画布的节点类型清单');
      expect(registry.list('node-type')).toEqual([]);
      expect(fs.existsSync(path.join(dataDir, 'registry', 'entries.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  /**
   * v14 A5-4 的对外读数：属性面板「检查门禁」那一节的加号从此只问这一刀
   * （`PropertyPanel.tsx` 那份硬编码四枚已拆掉——顺带把 `contract`/`delivery-branch` 两型接上了线，
   * 它们引擎认得、画布上却一直加不出来）。画法怎么渲成按钮是 web 的纯函数判据（`check-types.test.ts`）。
   */
  it('GET ?kind=check-type：出厂六型上架，画法字段齐（label/hint/machine），写入面照拒', async () => {
    const { app, registry, dataDir } = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/registry?kind=check-type', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { entries: { id: string; name: string; view: boolean; label: string; spec: Record<string, unknown> }[] };
      expect(body.entries.map((e) => e.name).sort()).toEqual([...CHECK_SPEC_TYPES].sort());
      expect(body.entries.every((e) => e.view && e.spec.label && e.spec.hint && typeof e.spec.machine === 'boolean')).toBe(true);
      // 人话标签说的是「这一型谁来判断」，不把机器值重念一遍
      expect(body.entries.find((e) => e.name === 'file-exists')).toMatchObject({
        id: 'check-type:file-exists',
        label: '「文件存在」· 引擎实跑',
        spec: { machine: true, hint: '节点工作目录下要有这个文件，没有就没过' },
      });
      expect(body.entries.find((e) => e.name === 'manual')).toMatchObject({ label: '「人工确认」· 人看一眼', spec: { machine: false } });
      // 机检账的分母从这一枚派生（`MACHINE_CHECK_TYPES` 不再手抄）：线上传的 machine 与账本口径必须同源
      expect(body.entries.filter((e) => e.spec.machine === true).map((e) => e.name).sort()).toEqual(
        [...MACHINE_CHECK_TYPES].sort(),
      );
      // 写入面对这一类同样全关（与 node-type 同一扇拒路）
      const add = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'check-type', name: 'my-check', spec: { label: '我的检查', hint: '问一句', machine: true } },
      });
      expect(add.statusCode).toBe(400);
      expect(add.json().error).toContain('机检类型清单');
      expect(registry.list('check-type')).toEqual([]);
      expect(fs.existsSync(path.join(dataDir, 'registry', 'entries.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  /**
   * v14 A5-4b-1 的对外读数：`role` 是**第一枚正身在盘上用户数据**的视图 kind——条目由角色库名册现算。
   * 这一格钉四件事，缺一件都说明读端或写端把「谁是正身」答错了：
   *  1. 名册里干净的两枚岗上架，label/`name`/`spec` 的形状由 Descriptor + 信封算（这里不现编第二套措辞）；
   *  2. 脏行（没 id、重名 id）**一枚不渲**，但必须出现在 `rejected` 里指名道姓——静默吞掉就是
   *     「名册明明有四格，表上只见两格」那种查三天的账；
   *  3. 三个写动词全拒，且拒句点名**去角色库**（用户在注册中心找那扇门是找不到的）；
   *  4. 拒得干净：注册台账一个字节不落（视图 kind 不因「正身也在盘上」就偷偷开第二条写路）。
   */
  it('GET ?kind=role：名册现算上架、脏行只披露，写入面照拒并指路角色库', async () => {
    const { app, registry, dataDir } = await build();
    try {
      fs.writeFileSync(
        path.join(dataDir, 'roles.json'),
        `${JSON.stringify(
          [
            { id: 'r-deliver', name: '交付岗', agentKind: 'claude' },
            { id: 'r-review', name: '评审岗' },
            { name: '没有 id 的一格' },
            { id: 'r-deliver', name: '重名的第二格' },
          ],
          null,
          2,
        )}\n`,
      );
      const res = await app.inject({ method: 'GET', url: '/api/registry?kind=role', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        entries: { id: string; name: string; label: string; source: string; view: boolean; enabled: boolean; spec: unknown }[];
      };
      expect(body.entries.map((e) => e.id)).toEqual(['role:r-deliver', 'role:r-review']);
      expect(body.entries[0]).toMatchObject({
        view: true,
        source: 'user',
        enabled: true,
        name: 'r-deliver', // 机器值＝名册里的 id 原样（引用写法吃它，不吃岗名）
        label: '「交付岗」 · 钉档 claude',
        spec: { label: '交付岗', agentKind: 'claude' },
      });
      expect(body.entries[1]).toMatchObject({ label: '「评审岗」', spec: { label: '评审岗' } });

      const list = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      const rejected = list.json().rejected as { id: string; why: string }[];
      expect(rejected.map((r) => r.id)).toEqual(['roles.json[2]', 'role:r-deliver']);
      expect(rejected[0]!.why).toContain('没有可用的 id');
      expect(rejected[1]!.why).toContain('两枚 id');

      const add = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'role', name: 'r-new', spec: { label: '新岗' } },
      });
      expect(add.statusCode).toBe(400);
      expect(add.json().error).toContain('角色库那一面');
      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/registry/role%3Ar-deliver',
        headers: { host: HOST },
        payload: { enabled: false },
      });
      expect(patch.statusCode).toBe(400);
      expect(patch.json().error).toContain('改不了它');
      const del = await app.inject({ method: 'DELETE', url: '/api/registry/role%3Ar-deliver', headers: { host: HOST } });
      expect(del.statusCode).toBe(400);
      expect(del.json().error).toContain('角色库那一面');
      expect(registry.list('role')).toEqual([]);
      expect(fs.existsSync(path.join(dataDir, 'registry', 'entries.json'))).toBe(false);

      // 详情面也带正身措辞（`paneflow registry get` 吃这一格）：视图项那一行不能写死「出厂自带」
      const detail = await app.inject({ method: 'GET', url: '/api/registry/role%3Ar-deliver', headers: { host: HOST } });
      expect(detail.statusCode).toBe(200);
      expect((detail.json() as { viewHomes: Record<string, string> }).viewHomes.role).toContain('角色库');
    } finally {
      await app.close();
    }
  });

  /**
   * v14 T4 的对外读数：`mcp` 是**用户登记项**（与 `model` 同侧），所以这一格要钉的是两件相反的事——
   * 写路径**开得通**（视图 kind 那扇拒路不许误伤），而脏形状（多一个 `transport` 键）照旧 400。
   */
  it('POST kind=mcp：登记得进、label 就是那行启动命令；未知键照拒（宁拒不错放）', async () => {
    const { app, registry } = await build();
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'mcp', name: '文件服务', spec: { command: 'npx', args: '-y @mcp/fs /srv' } },
      });
      expect(ok.statusCode).toBe(200);
      const id = (ok.json() as { entry: { id: string } }).entry.id;
      expect(id).toMatch(/^mcp:u[0-9a-z]+$/); // 中文名→确定性散列 id（同 E2 幂等地基）
      const one = await app.inject({ method: 'GET', url: `/api/registry/${id}`, headers: { host: HOST } });
      expect(one.json()).toMatchObject({ entry: { kind: 'mcp', view: false, label: 'npx -y @mcp/fs /srv' } });
      expect(registry.list('mcp').map((e) => e.id)).toEqual([id]);
      const dirty = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'mcp', name: '另一台', spec: { command: 'mcp-x', transport: 'stdio' } },
      });
      expect(dirty.statusCode).toBe(400);
      expect(dirty.json().error).toContain('transport');
      expect(registry.list('mcp')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  /**
   * v14 A5-1 的对外读数：`skill` 与 `model`/`mcp` 同侧（用户登记项），所以写路径照开。
   * 这一格额外钉两件 HTTP 面才有的事：①label 里必须出现**所属项目**（相对路径离开项目根没有意义，
   * 两枚不同项目的同名路径不能在界面上长得一样）；②写入面**不判**那个项目存不存在——
   * 「先立账后写文」是正常路径，存在性是 R4 探针的账（探到 unknown 会明说「未探得不等于不存在」）。
   */
  it('POST kind=skill：登记得进、label 带项目作用域；不存在的 space 照登记（存在性不是写入面的账）', async () => {
    const { app, registry } = await build();
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'skill', name: 'x', spec: { space: 'ghost', file: 'skills/x/SKILL.md', note: '还没写' } },
      });
      expect(ok.statusCode).toBe(200);
      const id = (ok.json() as { entry: { id: string } }).entry.id;
      expect(id).toBe('skill:x');
      const one = await app.inject({ method: 'GET', url: `/api/registry/${id}`, headers: { host: HOST } });
      expect(one.json()).toMatchObject({
        entry: { kind: 'skill', view: false, label: '[项目 ghost] skills/x/SKILL.md · 还没写' },
      });
      // 探针在这一枚上是空参数没有缓存：项目档案里没有 ghost → unknown（未探得），不是 missing
      const health = await app.inject({ method: 'GET', url: '/api/registry/health', headers: { host: HOST } });
      const row = (health.json() as { entries: { id: string; health: { status: string; detail: string } }[] }).entries.find(
        (e) => e.id === id,
      );
      expect(row?.health?.status).toBe('unknown');
      expect(row?.health?.detail).toContain('不等于这篇技能不存在');
      expect(registry.list('skill').map((e) => e.id)).toEqual([id]);
      const dirty = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'skill', name: 'y', spec: { space: 'demo', flie: 'skills/y.md' } },
      });
      expect(dirty.statusCode).toBe(400);
      expect(dirty.json().error).toContain('flie');
      expect(registry.list('skill')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  /**
   * v14 A5-2 的对外读数：`rule` 与 skill 同侧（登记项），写路径照开，label 里带作用域。
   * 这一格额外钉 HTTP 面才有的两件事：①**收窄进 label**（一条只守某仓的约定与一条全项目都守的同名
   * 文档不能在同一张列表里长得一样，否则启停时按名字点是点不准的）；②未知键在这条路上同样 400
   * （`pathGlob` 少个 s 若被放过，这条约定就静默从「只守某仓」放大成「全项目都守」）。
   * 「项目有根而那枚作用域目录不在 → missing」是探针通道的账，判据已在 `registry.test.ts` 钉过；
   * 这里喂的 dataDir 没有真项目根，硬造一份只为走另一条分支就是重复挂号。
   */
  it('POST kind=rule：label 带作用域；项目没根/没这枚项目=unknown（不判死），拼错的键照拒', async () => {
    const { app, registry } = await build();
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'rule', name: 'x', spec: { space: 'ghost', file: 'docs/x.md', repo: 'packages/web', note: '只守前端' } },
      });
      expect(ok.statusCode).toBe(200);
      const id = (ok.json() as { entry: { id: string } }).entry.id;
      expect(id).toBe('rule:x');
      const one = await app.inject({ method: 'GET', url: `/api/registry/${id}`, headers: { host: HOST } });
      expect(one.json()).toMatchObject({
        entry: { kind: 'rule', view: false, label: '[项目 ghost] docs/x.md（仅 packages/web 仓） · 只守前端' },
      });
      // 项目不存在 → 无从判（unknown），这里不问作用域目录：根都没有，目录更无从谈起
      const health = await app.inject({ method: 'GET', url: '/api/registry/health', headers: { host: HOST } });
      const row = (health.json() as { entries: { id: string; health: { status: string; detail: string } }[] }).entries.find(
        (e) => e.id === id,
      );
      expect(row?.health?.status).toBe('unknown');
      expect(row?.health?.detail).toContain('不等于这篇约定不存在');
      expect(registry.list('rule').map((e) => e.id)).toEqual([id]);
      const dirty = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'rule', name: 'y', spec: { space: 'demo', file: 'a.md', pathGlob: 'src/**' } },
      });
      expect(dirty.statusCode).toBe(400);
      expect(dirty.json().error).toContain('pathGlob');
      expect(registry.list('rule')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  /**
   * v14 A5-3 的对外读数：一枚登记走完「上架 → 探针 live → 被档案引用 → 拒删」整条路。
   * 为什么在路由面再走一遍（探针判据已在 `registry.test.ts` 逐分支钉过）：这一格证的是**接线**——
   * `?kind=repo` 从此不 400、`CHANNELS.repo` 真被 `/health` 调到、`repos[i]` 那条裸串从此进引用账
   * （A5-3 之前它是 `unmigrated` 只报计数，删掉条目没人拦）。三件事都只在 HTTP 面才看得见。
   * `origin` 那枚远端标识在这儿只进 label 与 detail 的「不实读核对」——探针不起 `git` 子进程。
   */
  it('POST kind=repo：探针按项目根问目录在不在；被档案的 repos 引用后拒删', async () => {
    const { app, registry, dataDir } = await build();
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reg-repo-'));
      fs.mkdirSync(path.join(root, 'app', '.git'), { recursive: true });
      const put = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { rootCwd: root, repos: ['app'] },
      });
      expect(put.statusCode).toBe(200);
      const add = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'repo', name: 'app', spec: { space: 'demo', dir: 'app', origin: 'https://github.com/my-org/app.git', note: '主仓' } },
      });
      expect(add.statusCode).toBe(200);
      expect((add.json() as { entry: { id: string } }).entry.id).toBe('repo:app');
      // 值域面从此认这一类（没进表时 `?kind=repo` 是 400「不认的能力类型」）
      const grouped = await app.inject({ method: 'GET', url: '/api/registry?kind=repo', headers: { host: HOST } });
      expect(grouped.statusCode).toBe(200);
      expect(grouped.json().entries.map((e: { label: string }) => e.label)).toEqual([
        '[项目 demo] app（https://github.com/my-org/app.git） · 主仓',
      ]);
      const health = await app.inject({ method: 'GET', url: '/api/registry/health', headers: { host: HOST } });
      const row = (health.json() as { entries: { id: string; health?: { status: string; detail: string } }[] }).entries.find(
        (e) => e.id === 'repo:app',
      );
      expect(row?.health?.status).toBe('live');
      expect(row?.health?.detail).toContain('是 git 工作区（看到 .git）');
      expect(row?.health?.detail).toContain('这一版探针不实读核对');
      // 引用账：项目档案的 `repos[0]` 自此是一条**边**（不再只进 unmigrated 计数）
      const list = await app.inject({ method: 'GET', url: '/api/registry', headers: { host: HOST } });
      const listed = (list.json() as { entries: { id: string; refs?: { face: string; via: string }[] }[] }).entries.find(
        (e) => e.id === 'repo:app',
      );
      expect(listed?.refs?.map((r) => `${r.face}.${r.via}`)).toEqual(['space.repos[0]']);
      expect(list.json().refSummary.unmigrated.map((u: { kind: string }) => u.kind)).not.toContain('repo');
      const del = await app.inject({ method: 'DELETE', url: '/api/registry/repo:app', headers: { host: HOST } });
      expect(del.statusCode).toBe(400);
      expect(del.json().error).toContain('还被 1 处引用着');
      expect(del.json().error).toContain('repos[0]');
      expect(registry.list('repo').map((e) => e.id)).toEqual(['repo:app']);
      // 拼错的键照拒：`originu` 若被放过，这枚仓的远端标识就是空的，派活时 --repo 指不到它
      const dirty = await app.inject({
        method: 'POST',
        url: '/api/registry',
        headers: { host: HOST },
        payload: { kind: 'repo', name: 'x', spec: { space: 'demo', dir: 'x', originu: 'my-org/x' } },
      });
      expect(dirty.statusCode).toBe(400);
      expect(dirty.json().error).toContain('originu');
      expect(registry.list('repo')).toHaveLength(1);
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
        AGENT_KINDS.length + NODE_TYPE_CATALOG.length + CHECK_TYPE_CATALOG.length,
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
