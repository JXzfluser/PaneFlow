import { describe, expect, it } from 'vitest';
import { normalizeRegistryEntry, type DagGraph, type ModelRegistrySpec, type RegistryEntry } from '@paneflow/shared';
import { checkGraphRequirements, requirementGapWhy, requirementKindLabel } from './registry-check.js';
import { registryViewEntries } from './registry-view.js';

/**
 * v14-T3 起单前预检：模板 `requires` 槽 × 注册表 → 逐槽落点。
 * 钉的是三条姿态，一条都不能漂：
 *  1. 只有已迁进表的 kind 判死活（今天＝`model` 与 A3-2 起的 `agent-kind`），其余 `unjudged` **不拦**；
 *  2. 形状不认 → `malformed` 且 `ok=false`（判不了就不放行）；
 *  3. 匹配吃 R2 那把尺（`matchesTarget` → Descriptor `refKeys`），整枚 id / slug / spec 原值三写法同权。
 */

const entry = (spec: Record<string, unknown>, name = 'm', enabled = true): RegistryEntry => {
  const r = normalizeRegistryEntry({ kind: 'model', name, spec, enabled });
  if (!r.ok) throw new Error(r.why);
  return r.value;
};

const graphWith = (requires: unknown[]): DagGraph => ({
  version: 1,
  name: 't3',
  nodes: [],
  edges: [],
  metadata: { createdAt: '', updatedAt: '' },
  requires: requires as DagGraph['requires'],
});

const model = entry({ model: 'gpt-4o-mini' }, '小4号');

describe('逐槽落点（checkGraphRequirements）', () => {
  it('命中：entryId 给到、why 说用了哪一枚；整枚 id / slug / spec 原值三种写法都算命中', () => {
    // A3-2 起 `RegistryEntry['spec']` 是各类 spec 的联合，取值要按这一类的形状收窄（断言一字未改）
    for (const id of [model.id, (model.spec as ModelRegistrySpec).model, 'gpt-4o-mini']) {
      const r = checkGraphRequirements(graphWith([{ kind: 'model', id }]), [model]);
      expect(r.slots).toEqual([{ kind: 'model', id, verdict: 'ok', why: '用「小4号」', entryId: model.id }]);
      expect(r.ok).toBe(true);
    }
  });

  it('登记时起的中文名不是引用写法（与 R2 同一把尺，两把尺就会出现「预检说缺、引用账说在用」）', () => {
    const r = checkGraphRequirements(graphWith([{ kind: 'model', id: '小4号' }]), [model]);
    expect(r.slots[0]!.verdict).toBe('missing');
  });

  it('不给 id 的槽＝「这一类有可用的就行」，一枚命中即过', () => {
    const r = checkGraphRequirements(graphWith([{ kind: 'model', hint: '要便宜的' }]), [model]);
    expect(r.slots[0]).toEqual({ kind: 'model', hint: '要便宜的', verdict: 'ok', why: '用「小4号」', entryId: model.id });
    expect(r.ok).toBe(true);
  });

  it('死缺：注册表里一枚可用条目也没有 → missing，文案说清是「一类都没有」还是「指不到这一枚」', () => {
    const none = checkGraphRequirements(graphWith([{ kind: 'model' }]), []);
    expect(none.missing[0]!.why).toContain('一枚可用的「模型」条目都没有');
    expect(none.ok).toBe(false);

    const wrong = checkGraphRequirements(graphWith([{ kind: 'model', id: 'gpt-9' }]), [model]);
    expect(wrong.missing[0]!.why).toContain('指向「gpt-9」');
    expect(wrong.missing[0]!.entryId).toBeUndefined(); // 没命中就不给 entryId（宁缺毋假）
  });

  it('禁用中的条目不凑槽：enabled:false 是「留着但不再被选」，拿它算命中就是假绿', () => {
    const r = checkGraphRequirements(graphWith([{ kind: 'model', id: model.id }]), [
      entry({ model: 'gpt-4o-mini' }, '小4号', false),
    ]);
    expect(r.slots[0]!.verdict).toBe('missing');
    expect(r.ok).toBe(false);
  });

  it('未迁进表的 kind 只披露不判死活（表里压根没有 skill 这一类，判「不存在」= 拿空白冒充断言）', () => {
    const r = checkGraphRequirements(graphWith([{ kind: 'skill', id: 'skills/x/SKILL.md' }]), [model]);
    expect(r.unjudged).toEqual([
      { kind: 'skill', id: 'skills/x/SKILL.md', verdict: 'unjudged', why: '「技能」这一类还没迁进注册表，判不了死活（只披露不拦）' },
    ]);
    expect(r.ok).toBe(true); // 起单放行：unjudged 不是闸
  });

  it('脏形状 → malformed 且不放行（正常走不到这里：validateDag 在写入面就拒；盘面手改得动）', () => {
    const r = checkGraphRequirements(graphWith([{ knd: 'model' }, 'model', { kind: '  ' }]), [model]);
    expect(r.malformed.map((m) => m.verdict)).toEqual(['malformed', 'malformed', 'malformed']);
    expect(r.malformed[0]!.why).toContain('含未知键 knd');
    expect(r.slots[1]!.kind).toBe('(空)'); // 连 kind 都没有的项也要显出来，不能被「需要：」一行吞掉
    expect(r.ok).toBe(false);
  });

  it('没带槽是正读数：slots 空数组、ok=true、need 空', () => {
    const r = checkGraphRequirements(graphWith([]), [model]);
    expect(r).toMatchObject({ slots: [], need: [], missing: [], ok: true });
  });
});

describe('分组读数（模板卡那一行「需要：模型 1 · 技能 2」）', () => {
  it('按声明首现顺序分组；judged 只算判得了死活的槽，gaps 只算死缺', () => {
    const r = checkGraphRequirements(
      graphWith([
        { kind: 'model', id: model.id },
        { kind: 'skill', id: 'a' },
        { kind: 'model', id: 'nope' },
        { kind: 'skill', id: 'b' },
      ]),
      [model],
    );
    expect(r.need).toEqual([
      { kind: 'model', label: '模型', declared: 2, judged: 2, gaps: 1 },
      { kind: 'skill', label: '技能', declared: 2, judged: 0, gaps: 0 },
    ]);
  });

  it('未知 kind 原样画中文名，不替未来的新 kind 猜（猜来的标签就是假账）', () => {
    expect(requirementKindLabel('model')).toBe('模型');
    expect(requirementKindLabel('mcp-server')).toBe('mcp-server');
  });
});

describe('拒单文案（requirementGapWhy）', () => {
  it('一句人话带缺因 + 模板备注 + 指路到注册中心', () => {
    const why = requirementGapWhy(
      checkGraphRequirements(graphWith([{ kind: 'model', id: 'gpt-9', hint: '网关免费位' }]), [model]),
    );
    expect(why).toContain('模板「t3」的能力槽没补齐');
    expect(why).toContain('model → gpt-9');
    expect(why).toContain('模板备注：网关免费位');
    expect(why).toContain('先在「注册中心」登记缺的那几项');
  });

  it('malformed 也进拒单清单（判不了就不起红单）', () => {
    const why = requirementGapWhy(checkGraphRequirements(graphWith([{ kind: 'model', x: 1 }]), [model]));
    expect(why).toContain('声明形状不认');
    expect(why).toContain('含未知键 x');
  });
});

/**
 * v14 A3-2：`agent-kind` 迁入注册表（视图 kind）之后，那一类槽从「判不了」变成「判死活」。
 *
 * 这一条翻转是**有代价的**，所以专测钉住：以前 `{kind:'agent-kind'}` 落 `unjudged` 一律放行，
 * 现在指不到就是死缺、起单被拒。代价换来的是「模板声明要 pi，本机这张表里没有 pi」当场可辨。
 * 也正因为判的是**合并视图**，调用方（引擎 `startRun`、`GET /api/registry/check`）必须喂
 * `readView().entries`——只喂 `load()` 会把整类 agent 读成死缺，那是假红不是 fail-closed。
 */
describe('v14 A3-2 agent-kind 槽已判死活（不再落 unjudged）', () => {
  const views = registryViewEntries();

  it('命中写法两枚同权：整枚 id 与 kind 名；探测名**不是**引用写法（与 R2 同一把尺）', () => {
    for (const id of ['agent-kind:pi', 'pi']) {
      const r = checkGraphRequirements(graphWith([{ kind: 'agent-kind', id }]), views);
      expect(r.slots[0]).toMatchObject({ verdict: 'ok', entryId: 'agent-kind:pi' });
      expect(r.ok).toBe(true);
    }
    // `spec.binary='antigravity'` 与 kind 名 `antigravity-cli` 不同名：refKeys 没挂号它就判不到
    // （挂号=同一枚能力有两种引用写法，引用账与预检迟早分叉——那枚决议写在 Descriptor 的注释里）
    const binary = checkGraphRequirements(graphWith([{ kind: 'agent-kind', id: 'antigravity' }]), views);
    expect(binary.slots[0]!.verdict).toBe('missing');
  });

  it('不给 id 的槽＝「这一类有可用的就行」：出厂清单在表上就过（一枚都没有才是死缺）', () => {
    const r = checkGraphRequirements(graphWith([{ kind: 'agent-kind' }]), views);
    expect(r.slots[0]!.verdict).toBe('ok');
    expect(checkGraphRequirements(graphWith([{ kind: 'agent-kind' }]), []).slots[0]!.verdict).toBe('missing');
  });

  it('指不到那一枚 = missing 且不放行（今天这槽是 unjudged 直接放行，翻转要留字为证）', () => {
    const r = checkGraphRequirements(graphWith([{ kind: 'agent-kind', id: 'gemini-pro' }]), views);
    expect(r.slots[0]!.verdict).toBe('missing');
    expect(r.slots[0]!.entryId).toBeUndefined(); // 没命中整键不给（宁缺毋假）
    expect(r.slots[0]!.why).toContain('指向「gemini-pro」');
    expect(r.unjudged).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('分组读数里 agent-kind 记 judged（`需要：Agent 引擎 2` 那一行的 judged/gaps 与预检同一把尺）', () => {
    const r = checkGraphRequirements(
      graphWith([{ kind: 'agent-kind', id: 'pi' }, { kind: 'agent-kind', id: 'nope' }]),
      views,
    );
    expect(r.need).toEqual([{ kind: 'agent-kind', label: 'Agent 引擎', declared: 2, judged: 2, gaps: 1 }]);
    expect(requirementKindLabel('agent-kind')).toBe('Agent 引擎');
  });
});
