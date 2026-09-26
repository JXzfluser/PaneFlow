import { describe, expect, it } from 'vitest';
import { normalizeRegistryEntry, type RegistryEntry } from '@paneflow/shared';
import { capabilitySnapshot } from './registry-snapshot.js';
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
