import { describe, expect, it } from 'vitest';
import { normalizeRegistryEntry, type RegistryEntry } from '@paneflow/shared';
import { capabilitySnapshot } from './registry-snapshot.js';
import { registryViewEntries } from './registry-view.js';
import { contentSha } from './harness.js';
import type { RawReference } from './registry-refs.js';

/**
 * v14 R5 能力快照账。这里全部喂**内存里的引用与条目**（快照器本来就不读盘，读盘在引擎侧），
 * 判据钉 doc §二 R5 那四句：只快照已迁 kind、悬挂不进快照、null≠`[]`、指纹与「活行」无关。
 */

const modelEntry = (model: string, extra: Record<string, unknown> = {}): RegistryEntry => {
  const r = normalizeRegistryEntry({
    kind: 'model',
    name: model,
    spec: { model, ...extra },
  });
  if (!r.ok) throw new Error(r.why);
  return r.value;
};

const ref = (over: Partial<RawReference>): RawReference => ({
  face: 'gateway',
  id: 'free',
  name: '免费档',
  via: 'freeModel',
  kind: 'model',
  target: 'gpt-4o-mini',
  ...over,
});

describe('v14-R5 能力快照', () => {
  it('命中即快照：整份 spec 抄进账，via 记下「出自哪一格」', () => {
    const e = modelEntry('gpt-4o-mini', { gatewayProfile: 'free' });
    const snap = capabilitySnapshot([e], [ref({})]);
    expect(snap).not.toBeNull();
    expect(snap!.refs).toHaveLength(1);
    expect(snap!.refs[0]).toMatchObject({
      kind: 'model',
      id: e.id,
      spec: { model: 'gpt-4o-mini', gatewayProfile: 'free' },
      via: ['gateway·freeModel'],
    });
    // specSha 就是这条 spec 的内容指纹（与 harness 同一把 canonical 尺）
    expect(snap!.refs[0]!.specSha).toBe(contentSha(e.spec));
    expect(snap!.sha).toMatch(/^[0-9a-f]{8}$/);
  });

  it('同一枚条目被多处引用＝一条账，via 合并去重并排序', () => {
    const e = modelEntry('gpt-4o-mini');
    const snap = capabilitySnapshot([e], [
      ref({ via: 'freeModel' }),
      ref({ face: 'template', id: 'flow', name: 'flow', via: 'nodes[0].config.model' }),
      ref({ via: 'freeModel' }), // 完全同名的一格重复出现（多档同 freeModel）也只留一条
    ])!;
    expect(snap.refs).toHaveLength(1);
    expect(snap.refs[0]!.via).toEqual(['gateway·freeModel', 'template·nodes[0].config.model']);
  });

  it('cap# 只认能力面：引用出处（via）不同不改指纹，spec 变了才改', () => {
    const e = modelEntry('gpt-4o-mini');
    const a = capabilitySnapshot([e], [ref({})])!;
    const b = capabilitySnapshot([e], [ref({ face: 'space', id: 'demo', name: '演示', via: 'model' })])!;
    expect(a.sha).toBe(b.sha);
    const edited = capabilitySnapshot([modelEntry('gpt-4o-mini', { note: '换过备注' })], [ref({})])!;
    expect(edited.sha).not.toBe(a.sha);
  });

  it('spec 键序不影响 specSha/cap#（canonical 序列化，同 graphSha 口径）', () => {
    const x = capabilitySnapshot([modelEntry('m', { gatewayProfile: 'free', freeModel: true })], [ref({ target: 'm' })])!;
    const y = capabilitySnapshot([modelEntry('m', { freeModel: true, gatewayProfile: 'free' })], [ref({ target: 'm' })])!;
    expect(x.refs[0]!.specSha).toBe(y.refs[0]!.specSha);
    expect(x.sha).toBe(y.sha);
  });

  it('悬挂引用不进快照（那是 T3 预检的账），全悬挂＝null', () => {
    const snap = capabilitySnapshot([modelEntry('别的')], [ref({ target: '不存在的模型' })]);
    expect(snap).toBeNull();
  });

  it('未迁进表的 kind 一律不进快照（姿态 1：拿表外形状冒充注册表读数＝假账）', () => {
    const snap = capabilitySnapshot([modelEntry('gpt-4o-mini')], [
      ref({}),
      ref({ kind: 'agent-kind', target: 'claude', via: 'defaultAgentKind', face: 'space', id: 'demo', name: '演示' }),
      ref({ kind: 'skill', target: 'skills/x/SKILL.md', via: 'skills[0]', face: 'space', id: 'demo', name: '演示' }),
    ]);
    expect(snap!.refs.map((r) => r.kind)).toEqual(['model']);
  });

  it('一条已迁能力都没吃＝null（不返回 []：[] 是「扫过、零项」的正断言）', () => {
    expect(capabilitySnapshot([], [])).toBeNull();
    expect(capabilitySnapshot([modelEntry('gpt-4o-mini')], [ref({ kind: 'role', target: 'r-1' })])).toBeNull();
  });

  it('快照是副本：条目日后被改，历史读数不动（v0.1「活行 sha」判死的那条病）', () => {
    const e = modelEntry('gpt-4o-mini', { gatewayProfile: 'free' });
    const snap = capabilitySnapshot([e], [ref({})])!;
    const before = JSON.stringify(snap);
    // 模拟「起单之后有人编辑了注册表」：活行内容变了（spec 是 load() 每次新读的对象，这里就地改）
    (e.spec as unknown as Record<string, unknown>).gatewayProfile = 'paid';
    expect(JSON.stringify(snap)).toBe(before);
    expect(snap.refs[0]!.spec).toEqual({ model: 'gpt-4o-mini', gatewayProfile: 'free' });
  });

  it('多枚条目按 kind·id 定序（等臂比对要的是集合相等，不受引用顺序影响）', () => {
    const a = modelEntry('a-model');
    const b = modelEntry('b-model');
    const s1 = capabilitySnapshot([a, b], [ref({ target: 'b-model' }), ref({ target: 'a-model' })])!;
    const s2 = capabilitySnapshot([b, a], [ref({ target: 'a-model' }), ref({ target: 'b-model' })])!;
    expect(s1.refs.map((r) => r.id)).toEqual(s2.refs.map((r) => r.id));
    expect(s1.sha).toBe(s2.sha);
  });
});

/**
 * v14 A3-2 之后：`agent-kind` 也进快照（它已迁进表，姿态 1 的那把尺过了）。
 * 这一条同时钉住引擎侧的装配——快照喂的必须是 `readView().entries`：视图条目不落盘，
 * 只喂 `load()` 的话「这一单实发用了 pi」会静默不进能力面，cap# 就漏掉一次真实的能力面。
 */
describe('v14 A3-2 agent-kind 进能力快照', () => {
  const agentRef = (target: string): RawReference => ({
    face: 'template',
    id: 't3',
    name: 't3',
    via: 'nodes[0].config.agentKind',
    kind: 'agent-kind',
    target,
  });

  it('出厂视图项能进快照：spec 抄的是现算那一份（binary 探测名，不是 kind 名）', () => {
    const views = registryViewEntries();
    const snap = capabilitySnapshot(views, [agentRef('pi')]);
    expect(snap).not.toBeNull();
    expect(snap!.refs).toEqual([
      {
        kind: 'agent-kind',
        id: 'agent-kind:pi',
        specSha: contentSha({ binary: 'pi' }),
        spec: { binary: 'pi' },
        via: ['template·nodes[0].config.agentKind'],
      },
    ]);
  });

  it('两枚能力并存时按 kind·id 排序；只喂盘上条目（load）就等于把 agent 那一枚读丢了', () => {
    const model = modelEntry('gpt-4o-mini');
    const both = capabilitySnapshot([model, ...registryViewEntries()], [agentRef('pi'), ref({})])!;
    expect(both.refs.map((r) => r.id)).toEqual(['agent-kind:pi', 'model:gpt-4o-mini']);
    // 反面对照：盘上没有 agent-kind 条目（出厂清单不落盘，这是事实源所在）
    expect(capabilitySnapshot([model], [agentRef('pi'), ref({})])!.refs.map((r) => r.id)).toEqual(['model:gpt-4o-mini']);
  });
});

/**
 * v14 A5-1：`skill` 进表后第一次有了「这一单实发吃了哪篇技能文档」的账。
 * 这一枚独有的形状问题是**跨空间可撞**（相对路径在两个项目根下各有一篇同名文档），
 * 而正向快照与反向引用账对此的处理**刻意相反**——两格钉的就是这个不对称：
 * 反向多报只是多挡一次删除，正向多记则是宣称这一单读了它没读的文件。
 */
describe('v14 A5-1 skill 进能力快照', () => {
  const skill = (space: string, name: string): RegistryEntry => {
    const r = normalizeRegistryEntry({ kind: 'skill', name, spec: { space, file: 'docs/x.md' } });
    if (!r.ok) throw new Error(r.why);
    return r.value;
  };
  const bySpace = (space: string): RawReference => ({
    face: 'space',
    id: space,
    name: `项目 ${space}`,
    via: 'skills[0]',
    kind: 'skill',
    target: 'docs/x.md',
  });

  it('空间自己发的引用按主人收窄：快照里是主人那一枚，spec 抄整份（含 space）', () => {
    const jia = skill('a', 'a-doc');
    const yi = skill('b', 'b-doc');
    const snap = capabilitySnapshot([jia, yi], [bySpace('b')])!;
    expect(snap.refs).toEqual([
      {
        kind: 'skill',
        id: 'skill:b-doc',
        specSha: contentSha({ space: 'b', file: 'docs/x.md' }),
        spec: { space: 'b', file: 'docs/x.md' },
        via: ['space·skills[0]'],
      },
    ]);
  });

  it('命中多枚（角色发的引用不绑空间）时整条跳过不猜；跳过全部则整键不给而非空数组', () => {
    const entries = [skill('a', 'a-doc'), skill('b', 'b-doc')];
    const byRole: RawReference = { face: 'role', id: 'r1', name: '岗', via: 'skills[0]', kind: 'skill', target: 'docs/x.md' };
    expect(capabilitySnapshot(entries, [byRole])).toBeNull(); // 全被跳过＝没有正读数，不报 `[]`
    // 同一单里另有判得准的引用：那一条照记，歧义那条不连带污染
    const both = capabilitySnapshot(entries, [byRole, bySpace('a')])!;
    expect(both.refs.map((r) => [r.id, r.via])).toEqual([['skill:a-doc', ['space·skills[0]']]]);
  });
});

/**
 * v14 A5-2：`rule` 进表后能力快照多了一类，但它**不是新机制**——同一份收窄判据、同一条歧义跳过路。
 * 这一格只钉规则独有的那一件事：它的 `spec` 里带作用域，而快照抄的是**整份** spec，
 * 所以「同一条约定、不同生效范围」在两枚 specSha 上是两条不同的账。
 *
 * 为什么这值得单独钉：能力快照（cap#）存在的理由是「replay 时能比出这一单吃的东西变了没有」。
 * 若这里只抄 `{file}`，把一条全局约定改成「只守 packages/web」就不会动指纹——那正是最该被看见的
 * 变化（注入现场少读了一格目录规则）。多抄两枚键的代价是改注释也会动指纹，那笔账本来就该算。
 */
describe('v14 A5-2 rule 进能力快照', () => {
  const rule = (space: string, name: string, scope: Record<string, unknown> = {}): RegistryEntry => {
    const r = normalizeRegistryEntry({ kind: 'rule', name, spec: { space, file: 'docs/x.md', ...scope } });
    if (!r.ok) throw new Error(r.why);
    return r.value;
  };
  const bySpace = (space: string): RawReference => ({
    face: 'space',
    id: space,
    name: `项目 ${space}`,
    via: 'rules[0].file',
    kind: 'rule',
    target: 'docs/x.md',
  });

  it('整份 spec 进账：作用域两枚键跟着走，改收窄=改 specSha（cap# 要能比出「这条约定少守了一格」）', () => {
    const scoped = rule('demo', 'x-rule', { repo: 'packages/web', pathsGlob: 'src/**' });
    const snap = capabilitySnapshot([scoped], [bySpace('demo')])!;
    expect(snap.refs[0]).toMatchObject({
      kind: 'rule',
      id: 'rule:x-rule',
      spec: { space: 'demo', file: 'docs/x.md', repo: 'packages/web', pathsGlob: 'src/**' },
      via: ['space·rules[0].file'],
    });
    // 同一枚条目去掉作用域后指纹必变（两枚条目各记各的，不并成一条）
    const widened = rule('demo', 'x-rule');
    const other = capabilitySnapshot([widened], [bySpace('demo')])!;
    expect(other.refs[0]!.specSha).not.toBe(snap.refs[0]!.specSha);
  });

  it('作用域键不是引用写法，所以它在账上只有一处出现：`spec` 里（不进 `via`，也不参与命中判定）', () => {
    const scoped = rule('demo', '约定 x', { repo: 'packages/web' });
    // 拿同仓那枚目录名当 target 指不到这一枚——与 `agent-kind` 不收 binary 同一把尺
    const byRepo: RawReference = {
      face: 'space',
      id: 'demo',
      name: '项目 demo',
      via: 'rules[0].repo',
      kind: 'repo',
      target: 'packages/web',
    };
    expect(capabilitySnapshot([scoped], [byRepo])).toBeNull();
    expect(capabilitySnapshot([scoped], [byRepo, bySpace('demo')])!.refs.map((r) => r.via)).toEqual([['space·rules[0].file']]);
  });
});
