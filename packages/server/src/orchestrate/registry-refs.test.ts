import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRegistryEntry, type DagGraph, type RegistryEntry } from '@paneflow/shared';
import { buildReferenceIndex, readReferenceIndex, refsFromGraph, refsFromRequires, scanRawReferences } from './registry-refs.js';

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
  it('已迁 kind：网关档的 freeModel 认进模型条目，「被 N 处使用」有出处', () => {
    const index = buildReferenceIndex([entry({ model: 'gpt-4o-mini' })], scanRawReferences(fixtureDataDir()));
    expect(index.byEntry).toHaveLength(1);
    expect(index.byEntry[0]!.refs).toEqual([{ face: 'gateway', id: 'free', name: '免费档', via: 'freeModel' }]);
    expect(index.dangling).toEqual([]);
  });

  it('匹配吃 Descriptor 的多种写法：整枚 id、slug、spec 里的型号原值都算指向我', () => {
    const dataDir = fixtureDataDir();
    // 中文名登记的条目：id 是散列形（`model:u…`），引用面写的却是型号原值——只按 id 匹配就会读成「没人用」
    const byModel = buildReferenceIndex([entry({ model: 'gpt-4o-mini' }, '小4号')], scanRawReferences(dataDir));
    expect(byModel.byEntry[0]!.entryId).not.toBe('model:gpt-4o-mini');
    expect(byModel.dangling).toEqual([]);
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
    expect(index.dangling).toEqual([
      { kind: 'model', target: 'gpt-4o-mini', by: [{ face: 'gateway', id: 'free', name: '免费档', via: 'freeModel' }] },
    ]);
  });

  it('未迁进表的 kind 只披露计数、绝不判死活（表里没有这一类，判「不存在」就是拿空白冒充断言）', () => {
    const raw = scanRawReferences(fixtureDataDir());
    const index = buildReferenceIndex([], raw);
    expect(index.unmigrated.map((u) => u.kind).sort()).toEqual(
      ['agent-kind', 'check-type', 'gateway-profile', 'node-type', 'repo', 'role', 'rule', 'skill', 'template'].sort(),
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
    expect(index.dangling).toHaveLength(1);
    expect(index.dangling[0]!.target).toBe('gpt-4o-mini');
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
    ]);
  });

  it('声明面与实发面分家：requires 不进 refsFromGraph（R5 的 cap# 只记这单实发吃进的能力）', () => {
    const dataDir = requiresFixture();
    expect(refsFromRequires(readDecl(dataDir), 'decl').map((r) => r.via)).toEqual(['requires[0].id', 'requires[2].id']);
    expect(refsFromGraph(readDecl(dataDir), 'decl').some((r) => r.via.startsWith('requires'))).toBe(false);
  });

  it('点名的条目登记后「被 1 处使用」有出处；没登记进 dangling；未迁的 kind 只披露', () => {
    const raw = scanRawReferences(requiresFixture());
    const hit = buildReferenceIndex([entry({ model: 'gpt-4o-mini' })], raw);
    expect(hit.byEntry[0]!.refs).toEqual([{ face: 'template', id: 'decl', name: 'decl', via: 'requires[0].id' }]);
    const miss = buildReferenceIndex([entry({ model: '别的型号' })], raw);
    expect(miss.dangling.map((d) => `${d.kind}:${d.target}`)).toEqual(['model:gpt-4o-mini']);
    expect(miss.unmigrated.find((u) => u.kind === 'skill')).toMatchObject({ targets: ['skills/y/SKILL.md'], refs: 1 });
  });
});
