import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RegistryEntry } from '@paneflow/shared';
import { registryViewEntries, viewHomeOf, viewKindWriteWhy } from './registry-view.js';

/**
 * v14 A5-4b-1：`role` 是**第一枚正身在盘上用户数据**的视图 kind——条目由角色库名册（`roles.json`）现算。
 * 前三枚视图 kind 的正身是编译期常量，脏了是编程错（直接抛）；这一枚的正身是用户手编的库，
 * 于是 builder 多了三条必须逐条钉住的姿态：
 *  1. **读不出 ≠ 没有**：坏 JSON / 顶层不是数组时给披露，不给空表（空表在界面上就是「本机零岗位」）；
 *     `ENOENT` 反过来是正读数（还没建过角色库），零条目也零披露；
 *  2. **取舍与引擎同一把尺**：`roleById()` 是 `find(r => r.id === roleId)`，所以绑不上岗的行不渲条目、
 *     同 id 只渲第一条——注册表说「有两枚 std-planner」而引擎只会用第一枚，就是两张嘴；
 *  3. **不替用户编话**：岗名缺了就明说（label 回落拿 id 顶，披露讲清这不是岗名），
 *     `env`/`prePrompt`/装备槽/授权声明一概不进 spec（前者可能含密钥，余下各有自己的账）。
 *
 * 全部用真 tmp 目录：这一格判据就是「读那张盘怎么读」，桩掉 fs 等于把要测的东西测了个影子。
 *
 * v14 A5-4b-2 把同一条路走到底：`template` 的正身是 `graphs/*.json`（机器值是**文件名**，因为
 * `store.getGraph` 按文件名取图），`gateway-profile` 的正身是 `gateway.json` 的 `profiles[]`
 * （机器值是档 id 原样，而 **`apiKey` 永不进条目**——那里有一条可执行的「序列化搜不到密钥」机证）。
 * 三枚现盘视图共用的姿态（读不出≠没有、逐条披露、取舍与引擎同一把尺）在每一块里各钉一次，
 * 因为「同一把尺」在名册是 `roleById` 的 find、在模板是文件名、在网关是 `readGateway` 的 find。
 */
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reg-view-'));

/** 写名册（磁盘形状就是 `Role[]`——与 `roles.json` 的原样，不套信封不补键） */
const roster = (dir: string, raw: unknown): void => {
  fs.writeFileSync(path.join(dir, 'roles.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
};

/** 写一张图到 `graphs/<stem>.json`（A5-4b-2：文件名就是引擎取图的那枚键） */
const graph = (dir: string, stem: string, raw: unknown): void => {
  fs.mkdirSync(path.join(dir, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'graphs', `${stem}.json`), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
};

/** 原样写一张图（连 JSON 文本都不过对象——脏盘的样子） */
const rawGraph = (dir: string, stem: string, text: string): void => {
  fs.mkdirSync(path.join(dir, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'graphs', `${stem}.json`), text, 'utf8');
};

/** 写网关盘（磁盘形状就是 `GatewayDoc`；`apiKey` 故意写真值，用来证明它进不了条目） */
const gateway = (dir: string, raw: unknown): void => {
  fs.writeFileSync(path.join(dir, 'gateway.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
};

const roleRows = (dir: string): RegistryEntry[] => registryViewEntries({ dataDir: dir }).entries.filter((e) => e.kind === 'role');
const disclosures = (dir: string): { id: string; why: string }[] => registryViewEntries({ dataDir: dir }).disclosures;

describe('A5-4b-1 名册现算：干净盘上的岗位条目', () => {
  it('名册不存在（ENOENT）＝正读数：零条零披露，不拿「读不到」冒充「读不出」', () => {
    const dir = tmp();
    expect(roleRows(dir)).toEqual([]);
    expect(disclosures(dir)).toEqual([]);
    // 视图面永不写盘：读一次名册不该在 dataDir 里留下任何字节
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('两枚岗上架：信封字段与 spec 形状逐键如实（id 走 `registryId` 那把尺、`source` 说的是出处）', () => {
    const dir = tmp();
    roster(dir, [
      { id: 'r-deliver', name: '交付岗', agentKind: 'claude', prePrompt: '先把话说清', env: { TOKEN: '永不外泄' }, skills: ['skills/x/SKILL.md'], declares: { gitPush: false } },
      { id: 'r-review', name: '评审岗' },
    ]);
    const rows = roleRows(dir);
    expect(rows.map((e) => e.id)).toEqual(['role:r-deliver', 'role:r-review']);
    expect(rows[0]).toMatchObject({
      kind: 'role',
      name: 'r-deliver',
      source: 'user',
      enabled: true,
      spec: { label: '交付岗', agentKind: 'claude' },
    });
    // spec 的键**只有** label 与 agentKind：`env` 可能含密钥，装备/声明在 W1/W3 各有账，都不从这面漏出去
    expect(Object.keys(rows[0]!.spec).sort()).toEqual(['agentKind', 'label']);
    // 时刻是进程级常量（不是登记时刻，名册没记「这岗哪天建的」）——两枚同源，抖动的读数没法当断言
    expect(rows[0]!.createdAt).toBe(rows[1]!.createdAt);
    expect(Number.isNaN(Date.parse(rows[0]!.createdAt))).toBe(false);
  });

  it('大写 id 的岗：条目 id 里的 slug 被小写化，但 `name` 存原样（引用账靠它才指得回来）', () => {
    const dir = tmp();
    roster(dir, [{ id: 'R-Plan', name: '规划岗' }]);
    const rows = roleRows(dir);
    expect(rows[0]!.id).toBe('role:r-plan');
    expect(rows[0]!.name).toBe('R-Plan');
  });
});

describe('A5-4b-1 名册读不动：披露而不清空表', () => {
  it('坏 JSON＝零条 + 一条点名 `roles.json` 的披露，句子里明说这不是「本机没有岗位」', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'roles.json'), '{ 破烂', 'utf8');
    expect(roleRows(dir)).toEqual([]);
    const out = disclosures(dir);
    expect(out.map((d) => d.id)).toEqual(['roles.json']);
    expect(out[0]!.why).toContain('读不出');
    expect(out[0]!.why).toContain('不是「本机没有岗位」');
  });

  it('顶层不是数组（手写成对象包一层）＝同款披露，不静默当空名册', () => {
    const dir = tmp();
    roster(dir, { roles: [{ id: 'r-a', name: 'A 岗' }] });
    expect(roleRows(dir)).toEqual([]);
    expect(disclosures(dir)[0]!.why).toContain('期望岗位数组');
  });
});

describe('A5-4b-1 脏行逐条披露、其余照给（与 `load()` 对 `entries.json` 同一姿势）', () => {
  it('非对象行 / id 缺或空或非串：不渲条目，披露点到第几条（引擎也永远绑不到它）', () => {
    const dir = tmp();
    roster(dir, [
      { id: 'r-ok', name: '干净岗' },
      null,
      { name: '没有 id 的一格' },
      { id: '   ', name: 'id 全空格' },
      { id: 7, name: 'id 是数字' },
    ]);
    expect(roleRows(dir).map((e) => e.id)).toEqual(['role:r-ok']);
    expect(disclosures(dir).map((d) => d.id)).toEqual(['roles.json[1]', 'roles.json[2]', 'roles.json[3]', 'roles.json[4]']);
  });

  it('同 id 两枚岗：第一条赢（与引擎的 find 同一把尺），第二条披露到「第几条与第几条」', () => {
    const dir = tmp();
    roster(dir, [
      { id: 'r-dup', name: '第一枚' },
      { id: 'r-other', name: '旁岗' },
      { id: 'r-dup', name: '第二枚' },
    ]);
    const rows = roleRows(dir);
    expect(rows.map((e) => e.id)).toEqual(['role:r-dup', 'role:r-other']);
    expect((rows[0]!.spec as { label: string }).label).toBe('第一枚'); // 不是「两个里随便挑一个」：赢的就是引擎会用那枚
    const out = disclosures(dir).filter((d) => d.id === 'role:r-dup');
    expect(out).toHaveLength(1);
    expect(out[0]!.why).toContain('第 1 条与第 3 条');
    expect(out[0]!.why).toContain('去角色库');
  });

  it('岗名缺失：条目照给、label 回落用 id，并披露「这不是替它起的名字」', () => {
    const dir = tmp();
    roster(dir, [
      { id: 'r-nameless' },
      { id: 'r-blank', name: '   ' },
    ]);
    const rows = roleRows(dir);
    expect(rows.map((e) => (e.spec as { label: string }).label)).toEqual(['r-nameless', 'r-blank']);
    expect(disclosures(dir).map((d) => d.id)).toEqual(['role:r-nameless', 'role:r-blank']);
    expect(disclosures(dir)[0]!.why).toContain('没有岗名');
  });

  it('agentKind 脏值：既不当钉档渲、也不当「没钉」——两态同形的地方必须说话；键缺失是正读数零披露', () => {
    const dir = tmp();
    roster(dir, [
      { id: 'r-empty', name: '空串钉档', agentKind: '' },
      { id: 'r-num', name: '数字钉档', agentKind: 3 },
      { id: 'r-none', name: '没钉档' },
    ]);
    const rows = roleRows(dir);
    expect(rows.map((e) => e.spec)).toEqual([{ label: '空串钉档' }, { label: '数字钉档' }, { label: '没钉档' }]);
    const out = disclosures(dir);
    expect(out.map((d) => d.id)).toEqual(['role:r-empty', 'role:r-num']);
    expect(out[0]!.why).toContain('没当钉档渲');
  });
});

describe('A5-4b-1 视图 kind 的措辞表：正身逐 kind 给，拒写与遮蔽披露同源', () => {
  it('六枚视图 kind 各有各的答处：拿「由代码决定」拒岗位的写请求就是当面说假话', () => {
    expect(viewHomeOf('agent-kind')).toContain('版本自带的 agent 类型清单');
    expect(viewHomeOf('node-type')).toContain('画布的节点类型清单');
    expect(viewHomeOf('check-type')).toContain('机检类型清单');
    expect(viewHomeOf('role')).toContain('角色库');
    expect(viewHomeOf('template')).toContain('编排模板那一面');
    expect(viewHomeOf('gateway-profile')).toContain('网关设置那一面');
    // 后三枚的正身是用户数据：拒句里不许出现「代码决定」那套（只有前三枚由代码决定）
    for (const kind of ['role', 'template', 'gateway-profile'] as const) {
      expect(viewHomeOf(kind)).not.toContain('代码决定');
    }
  });

  it('拒写句 = 同一张表拼出来的：动词跟着动作走，去处跟着 kind 走', () => {
    const add = viewKindWriteWhy('登记', 'role');
    expect(add).toContain('「role」是视图 kind');
    expect(add).toContain(viewHomeOf('role'));
    expect(add).toContain('注册表登记不了它');
    expect(viewKindWriteWhy('删', 'role')).toContain('注册表删不了它');
    // A5-4b-2 的两枚走同一句拼装（写入面那三处不需要为它们各开一支 if）
    const why = viewKindWriteWhy('改', 'template');
    expect(why).toContain(viewHomeOf('template'));
    expect(why).toContain('注册表改不了它');
  });

  it('`registryViewEntries` 一次并六枚：出厂三类 + 名册/模板盘/网关盘各一枚，披露也一起带出', () => {
    const dir = tmp();
    roster(dir, [{ id: 'r-a', name: 'A 岗' }, { name: '脏行' }]);
    graph(dir, 'issue-flow', { name: 'issue-flow', nodes: [{ id: 'a' }] });
    gateway(dir, { profiles: [{ id: 'gw-main', name: '主档', baseUrl: 'https://gw.local/v1', apiKey: 'sk-永不外泄' }], current: 'gw-main' });
    const build = registryViewEntries({ dataDir: dir });
    expect([...new Set(build.entries.map((e) => e.kind))].sort()).toEqual([
      'agent-kind',
      'check-type',
      'gateway-profile',
      'node-type',
      'role',
      'template',
    ]);
    expect(build.disclosures).toHaveLength(1);
    expect(build.disclosures[0]!.id).toBe('roles.json[1]');
    expect(build.disclosures[0]!.why).toContain('没有可用的 id');
  });
});

/**
 * v14 A5-4b-2：`template` 的正身是 `graphs/*.json`。与名册同族（用户数据、读端只是镜子），
 * 但**独有一件**必须钉的事：引擎按**文件名**取图（`store.getGraph`），而图里还写着第二枚名字
 * （`graph.name`）——两处不一致时跟着哪一边走都会出一张假账，所以这里以文件名为准并把不一致披露出来。
 * 「读不出」也分两级：整目录读不动是一条披露，单张图读不动逐文件披露，其余照给。
 */
const templateRows = (dir: string): RegistryEntry[] =>
  registryViewEntries({ dataDir: dir }).entries.filter((e) => e.kind === 'template');

describe('A5-4b-2 模板盘现算：条目以文件名为机器值', () => {
  it('目录不存在＝正读数：零条零披露，且视图面不替 `Store` 建目录（读一次不留字节）', () => {
    const dir = tmp();
    expect(templateRows(dir)).toEqual([]);
    expect(disclosures(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'graphs'))).toBe(false);
  });

  it('两张图上架：`name`=文件名去 `.json`、`nodes` 是实读数、`description` 取自 metadata', () => {
    const dir = tmp();
    graph(dir, 'issue-flow', { name: 'issue-flow', nodes: [{ id: 'a' }, { id: 'b' }], edges: [], metadata: { createdAt: '', updatedAt: '', description: '接单到 PR' } });
    graph(dir, 'plain', { name: 'plain', nodes: [], edges: [], metadata: { createdAt: '', updatedAt: '' } });
    const rows = templateRows(dir);
    expect(rows.map((e) => e.id)).toEqual(['template:issue-flow', 'template:plain']);
    expect(rows[0]).toMatchObject({ kind: 'template', name: 'issue-flow', source: 'user', enabled: true, spec: { nodes: 2, description: '接单到 PR' } });
    // 空图 0 是**正读数**（真存在一张没节点的图），与「读不出」两回事，所以这里零披露
    expect(rows[1]!.spec).toEqual({ nodes: 0 });
    expect(disclosures(dir)).toEqual([]);
  });

  it('文件名 ≠ 图内 name：条目按文件名渲（引擎就是按文件名取图），并披露两处不一致', () => {
    const dir = tmp();
    graph(dir, 'fix-issue', { name: '改单流程', nodes: [{ id: 'a' }], edges: [], metadata: { createdAt: '', updatedAt: '' } });
    const rows = templateRows(dir);
    expect(rows.map((e) => e.name)).toEqual(['fix-issue']);
    const ds = disclosures(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.id).toBe('template:fix-issue');
    expect(ds[0]!.why).toContain('文件名是「fix-issue」');
    expect(ds[0]!.why).toContain('改单流程');
  });

  it('单张图读不出＝逐文件披露、不渲条目，其余图照给（拿 `nodes:0` 冒充「读不出」就是二比空图）', () => {
    const dir = tmp();
    rawGraph(dir, 'broken', '{ "nodes": [');
    graph(dir, 'no-nodes', { name: 'no-nodes', edges: [], metadata: { createdAt: '', updatedAt: '' } });
    rawGraph(dir, 'array-top', '[1,2,3]');
    graph(dir, 'good', { name: 'good', nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [], metadata: { createdAt: '', updatedAt: '' } });
    const rows = templateRows(dir);
    expect(rows.map((e) => e.name)).toEqual(['good']);
    expect(rows[0]!.spec).toEqual({ nodes: 3 });
    const ds = disclosures(dir);
    expect(ds.map((d) => d.id).sort()).toEqual(['graphs/array-top.json', 'graphs/broken.json', 'graphs/no-nodes.json']);
    expect(ds.find((d) => d.id === 'graphs/broken.json')!.why).toContain('JSON 读不出');
    expect(ds.find((d) => d.id === 'graphs/no-nodes.json')!.why).toContain('nodes 不是数组');
    expect(ds.find((d) => d.id === 'graphs/array-top.json')!.why).toContain('顶层是 array');
  });

  it('两张图归一成同一枚条目 id（`a b` 与 `a-b` 都能落盘、都能被引擎取到）：只渲第一条并披露撞车，不画「有两枚 template:a-b」', () => {
    // 不用 `Foo`/`foo` 演示：macOS 默认盘大小写不敏感，那是**同一个文件**（第二写覆盖第一写），
    // 撞车发生在区分大小写的卷上；而空格/连字符在任何文件系统上都是两个文件名、一枚 slug。
    const dir = tmp();
    graph(dir, 'a b', { name: 'a b', nodes: [{ id: 'x' }], edges: [], metadata: { createdAt: '', updatedAt: '' } });
    graph(dir, 'a-b', { name: 'a-b', nodes: [{ id: 'y' }, { id: 'z' }], edges: [], metadata: { createdAt: '', updatedAt: '' } });
    const rows = templateRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('template:a-b');
    const ds = disclosures(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.id).toBe('template:a-b');
    expect(ds[0]!.why).toContain('同一枚条目 id');
  });
});

/**
 * v14 A5-4b-2：`gateway-profile` 的正身是 `gateway.json` 的 `profiles[]`。这一枚带着全仓最硬的一条红线：
 * **`apiKey` 永不进条目**（`/api/gateway` 列表面都只回 `keyConfigured`，注册表不可能更松），
 * 所以除了形状断言，还有一条「整条序列化之后搜不到那枚密钥」的机证。
 */
const gwRows = (dir: string): RegistryEntry[] =>
  registryViewEntries({ dataDir: dir }).entries.filter((e) => e.kind === 'gateway-profile');

describe('A5-4b-2 网关盘现算：档 id 是机器值，密钥不进账', () => {
  it('盘不存在＝正读数：零条零披露', () => {
    const dir = tmp();
    expect(gwRows(dir)).toEqual([]);
    expect(disclosures(dir)).toEqual([]);
  });

  it('两档上架：label=档名、`keyConfigured` 是布尔读数，且**整条里搜不到 apiKey**（R1 边界②的机证）', () => {
    const dir = tmp();
    gateway(dir, {
      profiles: [
        { id: 'gw-main', name: '主档', baseUrl: 'https://gw.local/v1', apiKey: 'sk-secret-永不外泄', freeModel: 'gpt-4o-mini', enabled: true },
        { id: 'gw-bare', name: '裸档' },
      ],
      current: 'gw-main',
    });
    const rows = gwRows(dir);
    expect(rows.map((e) => e.id)).toEqual(['gateway-profile:gw-main', 'gateway-profile:gw-bare']);
    expect(rows[0]).toMatchObject({
      kind: 'gateway-profile',
      name: 'gw-main',
      source: 'user',
      enabled: true,
      spec: { label: '主档', baseUrl: 'https://gw.local/v1', freeModel: 'gpt-4o-mini', keyConfigured: true },
    });
    expect(rows[1]!.spec).toEqual({ label: '裸档', keyConfigured: false });
    // 序列化整张视图都搜不到密钥原值——不是「我们没把它写进 spec」的自我声明，而是可执行的断言
    expect(JSON.stringify(registryViewEntries({ dataDir: dir }))).not.toContain('sk-secret');
  });

  it('`enabled:false` 的档渲成条目 `enabled:false`（留着但不再被选），不是删掉也不是假装启用', () => {
    const dir = tmp();
    gateway(dir, { profiles: [{ id: 'gw-off', name: '停用档', baseUrl: 'https://off.local', enabled: false }], current: 'gw-off' });
    const rows = gwRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: false, spec: { label: '停用档', baseUrl: 'https://off.local', keyConfigured: false } });
    expect(disclosures(dir)).toEqual([]);
  });

  it('旧扁平格式包成单档「默认档」（与运行面 `parseGatewayDoc` 同一包装，两面对得上才谈得上迁移）', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'gateway.json'), JSON.stringify({ baseUrl: 'https://old.local', apiKey: 'sk-old', enabled: true }), 'utf8');
    const rows = gwRows(dir);
    expect(rows.map((e) => e.name)).toEqual(['default']);
    expect(rows[0]!.spec).toMatchObject({ label: '默认档', baseUrl: 'https://old.local', keyConfigured: true });
    expect(JSON.stringify(rows)).not.toContain('sk-old');
  });

  it('盘读不出（坏 JSON / 顶层不是对象）＝一条点名 `gateway.json` 的披露，不渲空表冒充「本机没有档」', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'gateway.json'), '{ profiles: ', 'utf8');
    expect(gwRows(dir)).toEqual([]);
    const ds = disclosures(dir);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.id).toBe('gateway.json');
    expect(ds[0]!.why).toContain('JSON 读不出');
    expect(ds[0]!.why).toContain('这不是「本机没有档」');

    const dir2 = tmp();
    gateway(dir2, ['不是对象']);
    expect(disclosures(dir2)[0]!.why).toContain('顶层是 array');
  });

  it('脏行逐条披露、其余照给：id 缺／同 id 只认第一条／档名缺失回落 id／`baseUrl` 空串既不当值也不当没配', () => {
    const dir = tmp();
    gateway(dir, {
      profiles: [
        { name: '没有 id 的档', baseUrl: 'https://a.local' },
        { id: 'gw-dup', name: '第一枚' },
        { id: 'gw-dup', name: '第二枚' },
        { id: 'gw-nameless', baseUrl: 'https://b.local' },
        { id: 'gw-blank', name: '空地址档', baseUrl: '   ' },
      ],
      current: 'gw-dup',
    });
    const rows = gwRows(dir);
    expect(rows.map((e) => e.name)).toEqual(['gw-dup', 'gw-nameless', 'gw-blank']);
    expect(rows[1]!.spec).toEqual({ label: 'gw-nameless', baseUrl: 'https://b.local', keyConfigured: false });
    expect(rows[2]!.spec).toEqual({ label: '空地址档', keyConfigured: false });
    const ds = disclosures(dir);
    expect(ds.map((d) => d.id)).toEqual([
      'gateway.json profiles[0]',
      'gateway-profile:gw-dup',
      'gateway-profile:gw-nameless',
      'gateway-profile:gw-blank',
    ]);
    expect(ds[1]!.why).toContain('两枚 id「gw-dup」');
    expect(ds[2]!.why).toContain('这不是替它起的名字');
    expect(ds[3]!.why).toContain('baseUrl 不是可用的串');
  });

  it('大写档 id 的档：条目 id 里的 slug 被小写化，但 `name` 存原样（引用账靠它才指得回来）', () => {
    const dir = tmp();
    gateway(dir, { profiles: [{ id: 'Gw-Main', name: '主档', baseUrl: 'https://gw.local' }], current: 'Gw-Main' });
    const rows = gwRows(dir);
    expect(rows[0]!.id).toBe('gateway-profile:gw-main');
    expect(rows[0]!.name).toBe('Gw-Main');
  });

  it('「现在生效的是哪一档」是文档级读数，不进任何条目（换档不是能力面变了，不该抖 specSha）', () => {
    const dir = tmp();
    gateway(dir, {
      profiles: [
        { id: 'gw-a', name: 'A 档', baseUrl: 'https://a.local' },
        { id: 'gw-b', name: 'B 档', baseUrl: 'https://b.local' },
      ],
      current: 'gw-b',
    });
    for (const row of gwRows(dir)) {
      expect(Object.keys(row.spec).sort()).toEqual(['baseUrl', 'keyConfigured', 'label']);
      expect(JSON.stringify(row)).not.toContain('current');
    }
    expect(disclosures(dir)).toEqual([]);
  });
});
