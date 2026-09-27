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
    // 改口入账：`agent-kind`（A3-2）、`node-type`（T1）与 `skill`（A5-1）自此不在这份名单里——
    // 它们进了表（前两枚的成员由出厂清单现算），成员判得了死活
    expect(index.unmigrated.map((u) => u.kind).sort()).toEqual(
      ['check-type', 'gateway-profile', 'repo', 'role', 'rule', 'template'].sort(),
    );
    const role = index.unmigrated.find((u) => u.kind === 'role');
    expect(role).toEqual({ kind: 'role', targets: ['r-deliver'], refs: 2 }); // 班底名册 + 模板节点绑岗
    expect(index.dangling.every((d) => !index.unmigrated.some((u) => u.kind === d.kind))).toBe(true);
    expect(index.scanned).toBe(raw.length);
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
        // 留一枚**还没迁进表**的 kind 在这套 fixture 里：A5-1 把 skill 接走之后，
        // 「未迁的 kind 只披露」这条老账总得有个样本可指（rule 是 A5-2 的下一棒）。
        { kind: 'rule', id: 'docs/always.md' },
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
    ]);
  });

  it('声明面与实发面分家：requires 不进 refsFromGraph（R5 的 cap# 只记这单实发吃进的能力）', () => {
    const dataDir = requiresFixture();
    expect(refsFromRequires(readDecl(dataDir), 'decl').map((r) => r.via)).toEqual([
      'requires[0].id',
      'requires[2].id',
      'requires[3].id',
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
    // 改口入账（A5-1）：`skill` 自此不在 unmigrated 里，点名没登记就是**可断的账**
    expect(miss.unmigrated.map((u) => u.kind)).toEqual(['rule']);
    expect(miss.dangling.filter((d) => d.kind === 'skill').map((d) => d.target)).toEqual(['skills/y/SKILL.md']);
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
 * 「这型引擎被谁在用」从此和模型条目同一把尺。这里喂的条目集是 `registryViewEntries()`，
 * 即读面装配的真实形状（HTTP 面与引擎都拿它调 `buildReferenceIndex`）；只喂 model 条目测的是另一件事（上面那几格）。
 */
describe('agent-kind 承接后的引用账（v14 A3-2）', () => {
  const view = registryViewEntries();
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
  const view = registryViewEntries();
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
