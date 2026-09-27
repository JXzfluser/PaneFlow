import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRegistryEntry, type DagGraph, type RegistryEntry } from '@paneflow/shared';
import { registryViewEntries } from './registry-view.js';
import { buildReferenceIndex, readReferenceIndex, refsFromGraph, refsFromRequires, scanRawReferences, type ReferenceIndex } from './registry-refs.js';

/**
 * v14 A2（R2）引用索引：五个测试块各自钉住一条姿态，全部读**真实落盘形状**
 * （`Store`/`loadRoles`/`readGatewayDoc` 都从 fixture dataDir 实读，不桩——桩掉就等于
 * 只证了自己的解析假设，而本片的全部风险恰在「假设的盘面键名对不对」）。
 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reg-refs-'));

function writeJson(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** 四个引用面各给一处现役写法（键名逐字对齐 `store.ts` / `roles.ts` / `gateway.ts` 的读端） */
function fixtureDataDir(): string {
  const dataDir = tmp();
  writeJson(path.join(dataDir, 'spaces', 'demo', 'profile.json'), {
    id: 'demo',
    name: '演示项目',
    createdAt: '2026-01-01T00:00:00.000Z',
    defaultAgentKind: 'pi',
    gatewayProfile: 'free',
    team: [{ roleId: 'r-deliver' }],
    skills: ['skills/x/SKILL.md'],
    repos: ['my-repo'],
    rules: [{ repo: 'my-repo', file: 'docs/rule.md' }],
    delivery: [{ branchFrom: 'main', branchName: 'fix/{issue}', prTarget: 'main' }],
  });
  writeJson(path.join(dataDir, 'roles.json'), [
    { id: 'r-deliver', name: '交付岗', agentKind: 'claude', skills: ['skills/y/SKILL.md'], rules: ['docs/convention.md'] },
  ]);
  writeJson(path.join(dataDir, 'graphs', 'flow.json'), {
    version: 1,
    name: 'flow',
    nodes: [
      { id: 'n1', type: 'agent', label: '干活', config: { role: 'r-deliver', agentKind: 'codex', checks: [{ type: 'file-exists', path: 'a.md' }] } },
      { id: 'n2', type: 'pipeline', label: '子流程', config: { pipeline: { template: 'sub-flow', fallbackTemplate: 'fallback' } } },
    ],
    edges: [],
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  });
  writeJson(path.join(dataDir, 'gateway.json'), {
    profiles: [{ id: 'free', name: '免费档', baseUrl: 'https://gw.example', apiKey: 'sk-secret-永不出现', freeModel: 'gpt-4o-mini' }],
    current: 'free',
  });
  return dataDir;
}

const entry = (spec: Record<string, unknown>, name = 'model'): RegistryEntry => {
  const r = normalizeRegistryEntry({ kind: 'model', name, spec });
  if (!r.ok) throw new Error(r.why);
  return r.value;
};

describe('跨面裸串引用扫描（scanRawReferences）', () => {
  it('四面各自扫到位，`via` 是能按图索骥的键路径', () => {
    const raw = scanRawReferences(fixtureDataDir());
    const at = (face: string, via: string) => raw.filter((r) => r.face === face && r.via === via);
    expect(at('space', 'team[0].roleId')).toEqual([{ face: 'space', id: 'demo', name: '演示项目', via: 'team[0].roleId', kind: 'role', target: 'r-deliver' }]);
    expect(at('space', 'gatewayProfile').map((r) => r.target)).toEqual(['free']);
    expect(at('space', 'defaultAgentKind').map((r) => r.target)).toEqual(['pi']);
    expect(at('space', 'rules[0].file').map((r) => r.target)).toEqual(['docs/rule.md']);
    expect(at('space', 'rules[0].repo').map((r) => r.target)).toEqual(['my-repo']);
    expect(at('role', 'skills[0]').map((r) => r.target)).toEqual(['skills/y/SKILL.md']);
    expect(at('role', 'agentKind').map((r) => r.target)).toEqual(['claude']);
    expect(at('template', 'nodes[0].config.checks[0].type').map((r) => r.target)).toEqual(['file-exists']);
    expect(at('template', 'nodes[1].config.pipeline.template').map((r) => r.target)).toEqual(['sub-flow']);
    expect(at('gateway', 'freeModel').map((r) => r.target)).toEqual(['gpt-4o-mini']);
    expect(at('gateway', 'current').map((r) => r.target)).toEqual(['free']);
  });

  it('扫描是只读的：扫一遍不新增、不改一个字节（纯读推导的账不许有写端）', () => {
    const dataDir = fixtureDataDir();
    const before = JSON.stringify([...fs.readdirSync(dataDir, { recursive: true })].sort());
    scanRawReferences(dataDir);
    expect(JSON.stringify([...fs.readdirSync(dataDir, { recursive: true })].sort())).toBe(before);
  });

  it('密钥不在引用面的任何输出里（R1 边界：apiKey 既禁入 spec 也禁入反查）', () => {
    expect(JSON.stringify(scanRawReferences(fixtureDataDir()))).not.toContain('sk-secret');
  });

  it('空盘面扫出空账，不抛（新装机器上注册中心首屏就要走得通）', () => {
    expect(scanRawReferences(tmp())).toEqual([]);
  });
});

describe('引用索引（buildReferenceIndex）', () => {
  // A3-2 起 `agent-kind` 也迁进了表（视图 kind），fixture 里那三枚 kind 裸串从此参与判定：
  // 这里的 model 面断言按 kind 取自己的账，agent-kind 的承接情况在下面那格专测（该入账的是新账）。
  const modelDangling = (index: ReferenceIndex) => index.dangling.filter((d) => d.kind === 'model');

  it('已迁 kind：网关档的 freeModel 认进模型条目，「被 N 处使用」有出处', () => {
    const index = buildReferenceIndex([entry({ model: 'gpt-4o-mini' })], scanRawReferences(fixtureDataDir()));
    expect(index.byEntry).toHaveLength(1);
    expect(index.byEntry[0]!.refs).toEqual([{ face: 'gateway', id: 'free', name: '免费档', via: 'freeModel' }]);
    expect(modelDangling(index)).toEqual([]);
  });

  it('匹配吃 Descriptor 的多种写法：整枚 id、slug、spec 里的型号原值都算指向我', () => {
    const dataDir = fixtureDataDir();
    // 中文名登记的条目：id 是散列形（`model:u…`），引用面写的却是型号原值——只按 id 匹配就会读成「没人用」
    const byModel = buildReferenceIndex([entry({ model: 'gpt-4o-mini' }, '小4号')], scanRawReferences(dataDir));
    expect(byModel.byEntry[0]!.entryId).not.toBe('model:gpt-4o-mini');
    expect(modelDangling(byModel)).toEqual([]);
    expect(byModel.byEntry[0]!.refs).toHaveLength(1);
    // 同一枚条目换成 id 形引用（迁移后的写法）也照样认得
    const byId = buildReferenceIndex([entry({ model: 'xlarge' }, 'gpt-4o-mini')], [
      { face: 'gateway', id: 'free', name: '免费档', via: 'freeModel', kind: 'model', target: 'model:gpt-4o-mini' },
    ]);
    expect(byId.byEntry[0]!.refs).toHaveLength(1);
    expect(byId.dangling).toEqual([]);
  });

  it('指向已迁 kind 却解析不到条目 = dangling，带得上游出处（这才是「删了会断」的那类账）', () => {
    const index = buildReferenceIndex([], scanRawReferences(fixtureDataDir()));
    expect(modelDangling(index)).toEqual([
      { kind: 'model', target: 'gpt-4o-mini', by: [{ face: 'gateway', id: 'free', name: '免费档', via: 'freeModel' }] },
    ]);
    // 迁入表的另一面：这一类判得了死活了——只喂 model 条目时，三枚 kind 裸串全是悬挂（下面那格喂出厂清项即归零）
    expect(index.dangling.filter((d) => d.kind === 'agent-kind').map((d) => d.target).sort()).toEqual(['claude', 'codex', 'pi']);
  });

  it('未迁进表的 kind 只披露计数、绝不判死活（表里没有这一类，判「不存在」就是拿空白冒充断言）', () => {
    const raw = scanRawReferences(fixtureDataDir());
    const index = buildReferenceIndex([], raw);
    // 改口入账：`agent-kind`（A3-2）、`node-type`（T1）、`skill`（A5-1）、`rule`（A5-2）、`repo`（A5-3）、
    // `check-type`（A5-4）、`role`（A5-4b-1）自此都不在这份名单里——它们进了表（视图那几枚的成员由出厂清单或名册现算），成员判得了死活
    expect(index.unmigrated.map((u) => u.kind).sort()).toEqual(
      ['gateway-profile', 'template'].sort(),
    );
    expect(index.dangling.every((d) => !index.unmigrated.some((u) => u.kind === d.kind))).toBe(true);
    expect(index.scanned).toBe(raw.length);
    // A5-4b-1 同款代价：绑岗那两枚引用（`team[0].roleId` 与 `nodes[0].config.role`）从今天起是**可断的账**
    // ——不喂名册条目时它落 dangling（以前连 dangling 都不进，只报一个 unmigrated 计数）。
    // 两枚引用指向同一枚 `r-deliver`，逐条记全不合并：删岗要的就是「两处都得先改」这张账。
    expect(index.dangling.filter((d) => d.kind === 'role').map((d) => `${d.kind}:${d.target}·${d.by.length}`)).toEqual([
      'role:r-deliver·2',
    ]);
    // A5-2 的代价钉在这里：约定文档路径从今天起是**可断的账**——只喂 model 条目时它落悬挂，
    // 而迁表之前它连 dangling 都不进（拿空白冒充断言）。引用来自两面（岗位装备槽 `rules[]` 与
    // 空间目录规则 `rules[i].file`），两面一起翻面：这正是「一条路径两处引用」该有的账，不合并。
    expect(index.dangling.filter((d) => d.kind === 'rule').map((d) => `${d.kind}:${d.target}`)).toEqual([
      'rule:docs/convention.md',
      'rule:docs/rule.md',
    ]);
    // A5-3 同款代价：仓库目录名从今天起也是可断的账。同一枚 `my-repo` 在盘面上被三处指着
    // （`repos[0]` 与 `rules[0].repo`；本套 fixture 没配 delivery，故两处）——三处都翻面，不合并成一条。
    expect(index.dangling.filter((d) => d.kind === 'repo').map((d) => `${d.kind}:${d.target}·${d.by.length}`)).toEqual([
      'repo:my-repo·2',
    ]);
    // A5-4 同款代价：`checks[].type` 从今天起也是可断的账。本套 fixture 那一格吃了 `file-exists`——
    // 不喂出厂项时它落悬挂（以前连 dangling 都不进）。喂了清单即归零，见下面「check-type 承接后的引用账」。
    expect(index.dangling.filter((d) => d.kind === 'check-type').map((d) => `${d.kind}:${d.target}`)).toEqual([
      'check-type:file-exists',
    ]);
  });

  it('同一枚目标被多处引用：by 逐条列全（删除时要把人要回去改的位置一次给够）', () => {
    const raw = scanRawReferences(fixtureDataDir());
    const index = buildReferenceIndex([entry({ model: 'gpt-4o-mini' })], [
      ...raw,
      { face: 'space', id: 'demo', name: '演示项目', via: 'skills[0]', kind: 'model', target: 'gpt-4o-mini' },
    ]);
    expect(index.byEntry[0]!.refs.map((r) => `${r.face}.${r.via}`)).toEqual(['gateway.freeModel', 'space.skills[0]']);
    expect(index.byEntry[0]!.refs).toHaveLength(2);
  });

  it('表里没这一类条目时，别的 kind 引用不受牵连（unmigrated 与 dangling 分家）', () => {
    const index = buildReferenceIndex([entry({ model: 'other-model' })], scanRawReferences(fixtureDataDir()));
    expect(index.byEntry[0]!.refs).toEqual([]);
    expect(modelDangling(index)).toHaveLength(1);
    expect(modelDangling(index)[0]!.target).toBe('gpt-4o-mini');
  });
});

describe('读端装配（readReferenceIndex）', () => {
  it('真盘面 + 真条目一次成账', () => {
    const index = readReferenceIndex(fixtureDataDir(), [entry({ model: 'gpt-4o-mini' })]);
    expect(index.byEntry[0]!.refs[0]!.name).toBe('免费档');
    expect(index.scanned).toBeGreaterThan(10);
  });
});

/**
 * v14-T3 新增的引用面：模板的 `requires`。单独一套 fixture——上面那套四面断言钉的是
 * 「现役四面各扫到位」的 exact 计数，把第五面混进去等于让老账给新行为改口；该入账的是新账。
 */
describe('模板声明面 requires（v14-T3）', () => {
  function requiresFixture(): string {
    const dataDir = tmp();
    writeJson(path.join(dataDir, 'graphs', 'decl.json'), {
      version: 1,
      name: 'decl',
      nodes: [{ id: 'n1', type: 'agent', label: '干活', config: { agentKind: 'pi' } }],
      edges: [],
      requires: [
        { kind: 'model', id: 'gpt-4o-mini', hint: '要便宜的那枚' },
        { kind: 'model', hint: '任一模型即可，不点名' },
        { kind: 'skill', id: 'skills/y/SKILL.md' },
        { kind: 'rule', id: 'docs/always.md' },
        // 留一枚**还没迁进表**的 kind 在这套 fixture 里：A5-3 把 repo、A5-4b-1 把 role 接走之后，
        // 「未迁的 kind 只披露」这条老账总得有个样本可指（template 是下一棒的替身）。
        { kind: 'template', id: 'issue-flow' },
      ],
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    return dataDir;
  }

  const readDecl = (dataDir: string): DagGraph =>
    JSON.parse(fs.readFileSync(path.join(dataDir, 'graphs', 'decl.json'), 'utf8')) as DagGraph;

  it('逐槽建边：via 指得到第几槽；没点名（不写 id）的槽不建边', () => {
    const raw = scanRawReferences(requiresFixture());
    expect(raw.filter((r) => r.via.startsWith('requires')).map((r) => `${r.via}=${r.kind}:${r.target}`)).toEqual([
      'requires[0].id=model:gpt-4o-mini',
      'requires[2].id=skill:skills/y/SKILL.md',
      'requires[3].id=rule:docs/always.md',
      'requires[4].id=template:issue-flow',
    ]);
  });

  it('声明面与实发面分家：requires 不进 refsFromGraph（R5 的 cap# 只记这单实发吃进的能力）', () => {
    const dataDir = requiresFixture();
    expect(refsFromRequires(readDecl(dataDir), 'decl').map((r) => r.via)).toEqual([
      'requires[0].id',
      'requires[2].id',
      'requires[3].id',
      'requires[4].id',
    ]);
    expect(refsFromGraph(readDecl(dataDir), 'decl').some((r) => r.via.startsWith('requires'))).toBe(false);
  });

  it('点名的条目登记后「被 1 处使用」有出处；没登记进 dangling；未迁的 kind 只披露', () => {
    const raw = scanRawReferences(requiresFixture());
    const hit = buildReferenceIndex([entry({ model: 'gpt-4o-mini' })], raw);
    expect(hit.byEntry[0]!.refs).toEqual([{ face: 'template', id: 'decl', name: 'decl', via: 'requires[0].id' }]);
    const miss = buildReferenceIndex([entry({ model: '别的型号' })], raw);
    // fixture 的节点还写着 `agentKind: 'pi'`——A3-2 起这一类判得了死活，按 kind 取 model 那格的老账
    expect(miss.dangling.filter((d) => d.kind === 'model').map((d) => `${d.kind}:${d.target}`)).toEqual(['model:gpt-4o-mini']);
    // 改口入账（A5-1 → A5-2 → A5-3 → A5-4 → A5-4b-1）：`skill`/`rule`/`repo`/`check-type`/`role` 自此都不在 unmigrated 里，
    // 点名没登记就是**可断的账**；这份名单里剩下的那枚 `template` 是下一棒的替身（模板还没进表）
    expect(miss.unmigrated.map((u) => u.kind)).toEqual(['template']);
    expect(miss.dangling.filter((d) => d.kind === 'skill').map((d) => d.target)).toEqual(['skills/y/SKILL.md']);
    expect(miss.dangling.filter((d) => d.kind === 'rule').map((d) => d.target)).toEqual(['docs/always.md']);
  });

  /**
   * A5-1 在引用面上的形状：一枚裸相对路径命中两枚条目（两个项目根下各有一篇同名文档）时
   * **逐条记全**，而不是挑一枚。反向账问的是「删了会断谁」，漏报等于静默剪断现役配置；
   * 多报只是多挡一次删除（先改引用再删即可）。而**空间自己发的**引用带主人 id，按主人收窄——
   * 这一路判得准，所以 B 项目登记的那篇不会冒领 A 项目的引用。
   */
  it('同一枚相对路径命中两枚条目：反向逐条记全（不挑一枚），空间自发的引用按主人收窄', () => {
    const skill = (space: string, name: string): RegistryEntry => {
      const r = normalizeRegistryEntry({ kind: 'skill', name, spec: { space, file: 'docs/x.md' } });
      if (!r.ok) throw new Error(r.why);
      return r.value;
    };
    const entries = [skill('a', '甲'), skill('b', '乙')];
    // 角色（全局名册）发的引用不绑空间：两枚都认领，各得一条出处
    const byRole = buildReferenceIndex(entries, [
      { face: 'role', id: 'r1', name: '岗位', via: 'skills[0]', kind: 'skill', target: 'docs/x.md' },
    ]);
    expect(byRole.byEntry.map((b) => b.refs.length)).toEqual([1, 1]);
    expect(byRole.dangling).toEqual([]);
    // 空间发的引用带主人：只有主人那一枚认领
    const bySpace = buildReferenceIndex(entries, [
      { face: 'space', id: 'a', name: 'A 项目', via: 'skills[0]', kind: 'skill', target: 'docs/x.md' },
    ]);
    expect(bySpace.byEntry.map((b) => b.refs.map((x) => `${x.face}:${x.id}`))).toEqual([['space:a'], []]);
    expect(bySpace.dangling).toEqual([]);
    // 指到没登记的路径才是 dangling（这一枚自此判得了死活）
    const none = buildReferenceIndex(entries, [
      { face: 'space', id: 'a', name: 'A 项目', via: 'skills[0]', kind: 'skill', target: 'docs/nope.md' },
    ]);
    expect(none.dangling.map((d) => `${d.kind}:${d.target}`)).toEqual(['skill:docs/nope.md']);
  });
});

/**
 * v14 A3-2 的入账：`agent-kind` 迁入表（视图 kind）之后，盘面那三枚 kind 裸串第一次有了反查——
 * 「这型引擎被谁在用」从此和模型条目同一把尺。这里喂的条目集是 `registryViewEntries({ dataDir })`（读面装配的真实形状：出厂三类 + 名册那几枚岗），
 * 即读面装配的真实形状（HTTP 面与引擎都拿它调 `buildReferenceIndex`）；只喂 model 条目测的是另一件事（上面那几格）。
 */
describe('agent-kind 承接后的引用账（v14 A3-2）', () => {
  // 视图条目现算现在要吃 dataDir（`role` 的正身是名册）：这几格仍用出厂那三类，给真 fixture 目录=读面装配的真实形状
  const view = registryViewEntries({ dataDir: fixtureDataDir() }).entries;
  const raw = () => scanRawReferences(fixtureDataDir());

  it('现役三枚 kind 裸串全部落到出厂条目：unmigrated 不再报这一类，也不是 dangling', () => {
    const index = buildReferenceIndex(view, raw());
    expect(index.unmigrated.find((u) => u.kind === 'agent-kind')).toBeUndefined();
    expect(index.dangling.filter((d) => d.kind === 'agent-kind')).toEqual([]);
    const used = index.byEntry.filter((b) => b.kind === 'agent-kind' && b.refs.length);
    expect(used.map((b) => `${b.entryId}←${b.refs[0]!.face}.${b.refs[0]!.via}`).sort()).toEqual([
      'agent-kind:claude←role.agentKind',
      'agent-kind:codex←template.nodes[0].config.agentKind',
      'agent-kind:pi←space.defaultAgentKind',
    ]);
    // 出厂清单里没人用的那几枚：refs=[] 是正读数（与「读不出」分家，消费面据此画「没人用」）
    // 按 kind 取格而不是拿 `view.length` 减：视图 kind 会一批批加进来（T1 就加了 node-type），
    // 写死总数的断言每迁一类都要改一次，而且错了也不会指认是哪一类。
    const agentRows = index.byEntry.filter((b) => b.kind === 'agent-kind');
    expect(agentRows.filter((b) => !b.refs.length)).toHaveLength(agentRows.length - 3);
  });

  it('清单外的 kind 裸串判得出死活＝dangling（这正是迁入表换来的能力：以前只数不判）', () => {
    const index = buildReferenceIndex(view, [
      ...raw(),
      { face: 'space', id: 'demo', name: '演示项目', via: 'defaultAgentKind', kind: 'agent-kind', target: 'no-such-agent' },
    ]);
    expect(index.dangling.find((d) => d.kind === 'agent-kind')).toMatchObject({
      target: 'no-such-agent',
      by: [{ face: 'space', via: 'defaultAgentKind' }],
    });
  });

  it('探测名不是引用写法：配置里写 `antigravity`（binary）不指向 `antigravity-cli` 这一型', () => {
    const index = buildReferenceIndex(view, [
      { face: 'space', id: 'demo', name: '演示项目', via: 'defaultAgentKind', kind: 'agent-kind', target: 'antigravity' },
    ]);
    // 拿探测名当引用是把「打错的那个名字」读成「正在用」——这一条钉死 Descriptor 的 refKeys 不收 binary
    expect(index.byEntry.some((b) => b.refs.length)).toBe(false);
    expect(index.dangling).toEqual([
      { kind: 'agent-kind', target: 'antigravity', by: [{ face: 'space', id: 'demo', name: '演示项目', via: 'defaultAgentKind' }] },
    ]);
  });
});

/**
 * v14 T1 的入账：`node-type` 迁入表（第二枚视图 kind）之后，模板里每一枚 `nodes[].type` 裸串第一次
 * 有了反查。上面那几格喂的是「只迁了 model」的旧形状，这一格喂 `registryViewEntries()`（读面装配的真实形状）。
 *
 * 这一格为什么值得单列（不是照抄 agent-kind 那三行）：节点类型是**每张模板每一节都写**的那一类引用，
 * 于是它第一次把「被 N 处使用」变成注册中心上的常态读数，也第一次让「模板里写了引擎不认识的一型」
 * 从 `unmigrated` 的一句计数变成点名到格的悬挂账——那正是迁入表换来的能力。
 */
describe('node-type 承接后的引用账（v14 T1）', () => {
  // 视图条目现算现在要吃 dataDir（`role` 的正身是名册）：这几格仍用出厂那三类，给真 fixture 目录=读面装配的真实形状
  const view = registryViewEntries({ dataDir: fixtureDataDir() }).entries;
  const raw = () => scanRawReferences(fixtureDataDir());

  it('每一枚 `nodes[].type` 都挂到出厂条目：出处指得到第几个节点', () => {
    const index = buildReferenceIndex(view, raw());
    expect(index.unmigrated.find((u) => u.kind === 'node-type')).toBeUndefined();
    expect(index.dangling.filter((d) => d.kind === 'node-type')).toEqual([]);
    const slot = (type: string) => index.byEntry.find((b) => b.entryId === `node-type:${type}`);
    expect(slot('agent')!.refs).toEqual([{ face: 'template', id: 'flow', name: 'flow', via: 'nodes[0].type' }]);
    expect(slot('pipeline')!.refs).toEqual([{ face: 'template', id: 'flow', name: 'flow', via: 'nodes[1].type' }]);
    // 清单里没被任何模板用过的型：refs=[] 是正读数（「这型今天没人画」），与「扫不出」分家
    expect(slot('fanin')!.refs).toEqual([]);
  });

  it('清单外的型判得出死活＝dangling（以前只数不判）：改错一个字母的 `agenta` 点名到第几格', () => {
    const index = buildReferenceIndex(view, [
      ...raw(),
      { face: 'template', id: 'flow', name: 'flow', via: 'nodes[2].type', kind: 'node-type', target: 'agenta' },
    ]);
    expect(index.dangling.find((d) => d.target === 'agenta')).toMatchObject({
      kind: 'node-type',
      by: [{ face: 'template', id: 'flow', via: 'nodes[2].type' }],
    });
  });

  it('中文名不是引用写法：模板里写「Agent 节点」（画布上的措辞）不指向 `agent` 这一型', () => {
    const index = buildReferenceIndex(view, [
      { face: 'template', id: 'flow', name: 'flow', via: 'nodes[0].type', kind: 'node-type', target: 'Agent 节点' },
    ]);
    // 拿措辞当匹配键会把「写错成界面文案的那一格」读成「正在用某一型」——与 agent-kind 不收 binary 同一把尺
    expect(index.byEntry.some((b) => b.kind === 'node-type' && b.refs.length)).toBe(false);
    expect(index.dangling.map((d) => d.target)).toEqual(['Agent 节点']);
  });
});

/**
 * v14 A5-4 的入账：`check-type` 进表（视图 kind）之后，「这一型机检有人在画」第一次有了反查账。
 * 形状与 `node-type` 同形（成员由 `shared/dag.ts: CHECK_TYPE_CATALOG` 现算、不落盘），所以这里
 * 只钉机检多出来的那一件事：注册中心那一行说的「引擎实跑 / 人看一眼」与引用写法是**两枚键**——
 * 前者是画法（`spec.machine`），后者只有整枚 id 与 `checks[].type` 原值两种。
 */
describe('check-type 承接后的引用账（v14 A5-4）', () => {
  // 视图条目现算现在要吃 dataDir（`role` 的正身是名册）：这几格仍用出厂那三类，给真 fixture 目录=读面装配的真实形状
  const view = registryViewEntries({ dataDir: fixtureDataDir() }).entries;
  const raw = () => scanRawReferences(fixtureDataDir());

  it('每一枚 `checks[].type` 都挂到出厂条目：出处指得到第几格第几项', () => {
    const index = buildReferenceIndex(view, raw());
    expect(index.unmigrated.find((u) => u.kind === 'check-type')).toBeUndefined();
    expect(index.dangling.filter((d) => d.kind === 'check-type')).toEqual([]);
    const slot = (type: string) => index.byEntry.find((b) => b.entryId === `check-type:${type}`);
    expect(slot('file-exists')!.refs).toEqual([
      { face: 'template', id: 'flow', name: 'flow', via: 'nodes[0].config.checks[0].type' },
    ]);
    // 出厂清单里没被任何模板跑过的型：refs=[] 是正读数（「这一型今天没人画」），不是「扫不出」
    expect(slot('delivery-branch')!.refs).toEqual([]);
  });

  it('整枚 id 与机器值同权命中（迁移后的 `{kind,id}` 写法今天就该认）', () => {
    const index = buildReferenceIndex(view, [
      { face: 'template', id: 'flow', name: 'flow', via: 'requires[0].id', kind: 'check-type', target: 'check-type:regex' },
    ]);
    expect(index.dangling).toEqual([]);
    expect(index.byEntry.find((b) => b.entryId === 'check-type:regex')!.refs).toHaveLength(1);
  });

  it('清单外的型判得出死活＝dangling（以前只数不判）：改错一个字母的 `file-exis` 点名到第几格', () => {
    const index = buildReferenceIndex(view, [
      ...raw(),
      { face: 'template', id: 'flow', name: 'flow', via: 'nodes[0].config.checks[1].type', kind: 'check-type', target: 'file-exis' },
    ]);
    expect(index.dangling.find((d) => d.target === 'file-exis')).toMatchObject({
      kind: 'check-type',
      by: [{ face: 'template', id: 'flow', via: 'nodes[0].config.checks[1].type' }],
    });
  });

  it('中文名不是引用写法：模板里写「文件存在」（画布上的措辞）不指向 `file-exists` 这一型', () => {
    const index = buildReferenceIndex(view, [
      { face: 'template', id: 'flow', name: 'flow', via: 'nodes[0].config.checks[0].type', kind: 'check-type', target: '文件存在' },
    ]);
    // 与 `node-type`/`agent-kind` 同一把尺：拿措辞当匹配键，就会把写错成界面文案的那一格读成「正在用某一型」
    expect(index.byEntry.some((b) => b.kind === 'check-type' && b.refs.length)).toBe(false);
    expect(index.dangling.map((d) => d.target)).toEqual(['文件存在']);
  });
});

/**
 * v14 A5-4b-1 的入账：`role` 进表（**第一枚正身在盘上**的视图 kind）之后，「这一枚岗有人在绑」第一次
 * 有了反查账——R2 那条「被引用不许删」的守卫本来就在，缺的只是这一类条目去接它。
 *
 * 这一格喂的是 `registryViewEntries({ dataDir })`，名册就是上面那套 fixture 里的 `roles.json`：
 * 「条目从名册现算」与「引用账接得上」在同一次读数里对上，不靠手装条目冒充（手装的只能证明匹配键，
 * 证不了读端装配出来的就是那一条）。这里同时是 `entry.name` 那枚键的存在理由——
 * 名册里 `r-deliver` 靠 slug 也指得回，但大写 id 那种岗只认 name 原值（见 `roleDescriptor`）。
 */
describe('role 承接后的引用账（v14 A5-4b-1）', () => {
  const dataDir = fixtureDataDir();
  const view = registryViewEntries({ dataDir });
  const raw = () => scanRawReferences(dataDir);

  it('名册里的岗渲成条目：班底绑定与节点绑岗各得一条出处', () => {
    const index = buildReferenceIndex(view.entries, raw());
    expect(index.unmigrated.find((u) => u.kind === 'role')).toBeUndefined();
    expect(index.dangling.filter((d) => d.kind === 'role')).toEqual([]);
    const bound = index.byEntry.find((b) => b.entryId === 'role:r-deliver');
    expect(bound!.refs.map((r) => `${r.face}.${r.via}`).sort()).toEqual([
      'space.team[0].roleId',
      'template.nodes[0].config.role',
    ]);
  });

  it('整枚 id 与 roleId 原值同权命中（迁移后的 `{kind,id}` 写法今天就该认）', () => {
    const index = buildReferenceIndex(view.entries, [
      { face: 'template', id: 'flow', name: 'flow', via: 'requires[0].id', kind: 'role', target: 'role:r-deliver' },
    ]);
    expect(index.dangling).toEqual([]);
    expect(index.byEntry.find((b) => b.entryId === 'role:r-deliver')!.refs).toHaveLength(1);
  });

  it('名册里没有的岗判得出死活＝dangling（以前只数不判）：班底打错一个字母点名到第几项', () => {
    const index = buildReferenceIndex(view.entries, [
      ...raw(),
      { face: 'space', id: 'demo', name: '演示项目', via: 'team[1].roleId', kind: 'role', target: 'r-delvery' },
    ]);
    expect(index.dangling.find((d) => d.target === 'r-delvery')).toMatchObject({
      kind: 'role',
      by: [{ face: 'space', id: 'demo', via: 'team[1].roleId' }],
    });
  });

  it('岗名不是引用写法：配置里写「交付岗」（界面措辞）不指向 r-deliver 那一枚', () => {
    const index = buildReferenceIndex(view.entries, [
      { face: 'template', id: 'flow', name: 'flow', via: 'nodes[0].config.role', kind: 'role', target: '交付岗' },
    ]);
    expect(index.byEntry.some((b) => b.kind === 'role' && b.refs.length)).toBe(false);
    expect(index.dangling.map((d) => d.target)).toEqual(['交付岗']);
  });
});

/**
 * v14 A5-2 的入账：`rule` 进表之后，「这篇约定文档有人在守」第一次有了反查账。
 * 这一枚与 skill 同形（作用域在 `spec.space`、引用写法吃 `spec.file`），所以这里**不重讲**
 * 那套不对称处置（上一格已证），只钉规则多出来的两件事：
 *  ①引用**来自两面**——岗位装备槽 `rules[]`（face=role，全局名册、不绑空间）与空间目录规则
 *    `rules[i].file`（face=space，带主人）。同一篇文档被两处引用时逐条记全，删条目前给人两处都要改；
 *  ②`spec.repo`/`spec.pathsGlob` **不是**引用写法——它们是注入现场的生效条件（判据在 `rules.ts:
 *    matchRules`，吃节点真实 cwd）。把「别的配置恰好同仓」读成「这一枚正在被用」，就会让一条从没
 *    被引用过的规则显示成「被 N 处使用」，进而拒掉一次本来安全的删除。
 */
describe('rule 承接后的引用账（v14 A5-2）', () => {
  const rule = (space: string, name: string, specExtra: Record<string, unknown> = {}): RegistryEntry => {
    const r = normalizeRegistryEntry({ kind: 'rule', name, spec: { space, file: 'docs/x.md', ...specExtra } });
    if (!r.ok) throw new Error(r.why);
    return r.value;
  };

  it('两面引用各得一条出处；同路径跨空间时对 role 面逐条记全', () => {
    const entries = [rule('a', '甲', { repo: 'packages/web' }), rule('b', '乙')];
    const index = buildReferenceIndex(entries, [
      { face: 'role', id: 'r1', name: '岗位', via: 'rules[0]', kind: 'rule', target: 'docs/x.md' },
      { face: 'space', id: 'a', name: 'A 项目', via: 'rules[0].file', kind: 'rule', target: 'docs/x.md' },
    ]);
    expect(index.byEntry.map((b) => b.refs.map((x) => `${x.face}:${x.id}.${x.via}`))).toEqual([
      ['role:r1.rules[0]', 'space:a.rules[0].file'],
      ['role:r1.rules[0]'],
    ]);
    expect(index.dangling).toEqual([]);
  });

  it('整枚 id / slug 写法同权命中（与 skill、model 同一把尺）', () => {
    const r = rule('a', 'x-rule');
    for (const target of [r.id, 'x-rule', 'docs/x.md']) {
      const index = buildReferenceIndex([r], [{ face: 'role', id: 'r1', name: '岗位', via: 'rules[0]', kind: 'rule', target }]);
      expect(index.byEntry[0]!.refs).toHaveLength(1);
      expect(index.dangling).toEqual([]);
    }
  });

  it('作用域收窄键不建引用边：`repo` 面指到同仓目录名时不落 rule 条目（那是 `repo` 那一类的账）', () => {
    const r = rule('demo', '前端约定', { repo: 'packages/web', pathsGlob: 'src/**' });
    // 空间档案的 `rules[0].repo` 由 scanner 发成 kind='repo'——A5-3 起这一类判得了死活了：
    // 表里没这枚仓条目时它落 **dangling**（可断的账），而不是以前那个「只披露计数」的 unmigrated
    const index = buildReferenceIndex([r], [
      { face: 'space', id: 'demo', name: '演示项目', via: 'rules[0].repo', kind: 'repo', target: 'packages/web' },
      { face: 'space', id: 'demo', name: '演示项目', via: 'rules[0].file', kind: 'rule', target: 'src/**' },
    ]);
    expect(index.byEntry[0]!.refs).toEqual([]); // 同仓≠同一条规则：rule 条目一条都不许认领
    expect(index.unmigrated).toEqual([]);
    expect(index.dangling.map((d) => `${d.kind}:${d.target}`)).toEqual(['repo:packages/web', 'rule:src/**']);
  });

  it('同一枚目录名各归各类：`repo` 面归仓条目，规则条目不冒领（两把尺就会「引用账说在用、探针说没有」）', () => {
    const r = rule('demo', '前端约定', { repo: 'packages/web' });
    const repoNorm = normalizeRegistryEntry({ kind: 'repo', name: '前端仓', spec: { space: 'demo', dir: 'packages/web' } });
    if (!repoNorm.ok) throw new Error(repoNorm.why);
    const index = buildReferenceIndex([r, repoNorm.value], [
      { face: 'space', id: 'demo', name: '演示项目', via: 'rules[0].repo', kind: 'repo', target: 'packages/web' },
    ]);
    expect(index.byEntry.map((b) => `${b.kind}→${b.refs.length}`)).toEqual(['rule→0', 'repo→1']);
    expect(index.dangling).toEqual([]);
  });
});
