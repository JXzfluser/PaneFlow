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
 */
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reg-view-'));

/** 写名册（磁盘形状就是 `Role[]`——与 `roles.json` 的原样，不套信封不补键） */
const roster = (dir: string, raw: unknown): void => {
  fs.writeFileSync(path.join(dir, 'roles.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
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
  it('四枚视图 kind 各有各的答处：拿「由代码决定」拒岗位的写请求就是当面说假话', () => {
    expect(viewHomeOf('agent-kind')).toContain('版本自带的 agent 类型清单');
    expect(viewHomeOf('node-type')).toContain('画布的节点类型清单');
    expect(viewHomeOf('check-type')).toContain('机检类型清单');
    expect(viewHomeOf('role')).toContain('角色库');
    // 岗位的正身是用户数据：拒句里不许出现「代码决定」那套（前三枚才由代码决定）
    expect(viewHomeOf('role')).not.toContain('代码决定');
  });

  it('拒写句 = 同一张表拼出来的：动词跟着动作走，去处跟着 kind 走', () => {
    const add = viewKindWriteWhy('登记', 'role');
    expect(add).toContain('「role」是视图 kind');
    expect(add).toContain(viewHomeOf('role'));
    expect(add).toContain('注册表登记不了它');
    expect(viewKindWriteWhy('删', 'role')).toContain('注册表删不了它');
  });

  it('`registryViewEntries` 一次并四枚：出厂三类 + 名册那枚，披露也一起带出', () => {
    const dir = tmp();
    roster(dir, [{ id: 'r-a', name: 'A 岗' }, { name: '脏行' }]);
    const build = registryViewEntries({ dataDir: dir });
    expect([...new Set(build.entries.map((e) => e.kind))].sort()).toEqual(['agent-kind', 'check-type', 'node-type', 'role']);
    expect(build.disclosures).toHaveLength(1);
    expect(build.disclosures[0]!.id).toBe('roles.json[1]');
    expect(build.disclosures[0]!.why).toContain('没有可用的 id');
  });
});
