import { describe, expect, it } from 'vitest';
import {
  buildRegistryPayload,
  formFieldsFor,
  formatWhen,
  groupEntriesByKind,
  healthDot,
  healthIndex,
  healthTitle,
  isViewEntry,
  kindGroupLabel,
  missingRequiredFields,
  refCountOf,
  rejectedSummary,
  registrableKinds,
  requirementBadge,
  requirementDetail,
  sourceLabel,
  specRows,
  whenLabels,
  type RegistryCheckRow,
  type RegistryEntryView,
} from './registry-view';

const entry = (over: Partial<RegistryEntryView> = {}): RegistryEntryView => ({
  id: 'model:gpt-4o',
  kind: 'model',
  name: 'GPT-4o 常用',
  source: 'user',
  enabled: true,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  spec: { model: 'gpt-4o' },
  label: 'gpt-4o',
  ...over,
});

describe('v14-X1 注册中心分组与文案（判据全在 server，这里只渲给到的）', () => {
  /** 组名只从 server 的 `kindLabels` 来——这里给的是「server 说了什么」的桩，不是 web 自己的表 */
  const LABELS = { model: '模型', 'agent-kind': 'Agent 引擎' };

  it('knownKinds 立牌：空组也在——空表是正读数不是错误，不画报错', () => {
    const groups = groupEntriesByKind([], ['model'], [], LABELS);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('model');
    expect(groups[0]!.label).toBe('模型');
    expect(groups[0]!.entries).toEqual([]);
  });

  /**
   * 单一词表（A3-2 决议）：web 里不留 kind→中文名 那份表。
   * 所以「server 没给 labels」必须是**看得见**的「未知类型」，而不是悄悄回落成中文——
   * 回落了就是两张表还在，只是这一版没测到。
   */
  it('组名只认 server 给的 labels：没给就明说未知，绝不回落成 web 自带的中文名', () => {
    expect(kindGroupLabel('model')).toBe('未知类型：model');
    expect(kindGroupLabel('model', LABELS)).toBe('模型');
    expect(groupEntriesByKind([], ['model'], [])[0]!.label).toBe('未知类型：model');
  });

  it('分组按 server 给的 knownKinds 顺序，条目按 kind 归位', () => {
    const groups = groupEntriesByKind([entry(), entry({ id: 'x:1', kind: 'other' as never })], ['model'], [], LABELS);
    expect(groups.map((g) => g.kind)).toEqual(['model', 'other']);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['model:gpt-4o']);
  });

  it('未知 kind 不静默吞：条目里有 knownKinds 之外的 kind 时追加成组并标明未知', () => {
    const groups = groupEntriesByKind([entry({ kind: 'skill' as never })], ['model'], [], LABELS);
    expect(groups.map((g) => g.kind)).toEqual(['model', 'skill']);
    expect(kindGroupLabel('skill', LABELS)).toContain('未知类型');
    expect(kindGroupLabel('skill', LABELS)).toContain('skill');
    expect(groups[1]!.label).toBe('未知类型：skill');
  });

  it('source 三态中文定死；没挂号的来源值原样披露而不是画成空', () => {
    expect(sourceLabel('builtin')).toBe('出厂');
    expect(sourceLabel('user')).toBe('登记');
    expect(sourceLabel('discovered')).toBe('探得');
    expect(sourceLabel(' alien')).toContain('未识别来源');
    expect(sourceLabel(' alien')).toContain(' alien');
  });

  it('rejected 一句总述带计数与「不计入下表」；空 rejected 不给话（不凭空造警告）', () => {
    expect(rejectedSummary([])).toBeNull();
    const text = rejectedSummary([{ id: 'bad:1', why: '不认的能力类型「bad」' }]);
    expect(text).toContain('1 条');
    expect(text).toContain('不计入下表');
  });
});

describe('v14-X1 表单长法与 POST 体组装', () => {
  it('model 长出四键、model 必填；没挂号的 kind 不临场发明字段', () => {
    expect(formFieldsFor('model')!.map((f) => f.key)).toEqual(['model', 'gatewayProfile', 'freeModel', 'note']);
    expect(formFieldsFor('model')!.find((f) => f.key === 'model')!.required).toBe(true);
    expect(formFieldsFor('skill')).toBeNull();
  });

  it('missingRequiredFields 只问必填：没填名字与型号时报出中文名', () => {
    expect(missingRequiredFields('model', '', {})).toEqual(['显示名', '型号']);
    expect(missingRequiredFields('model', ' 甲 ', { model: 'gpt-4o' })).toEqual([]);
  });

  it('buildRegistryPayload：可选键空了整键不发（宁缺键不空键），只会长出 spec 四键里的', () => {
    const p = buildRegistryPayload('model', ' 甲 ', {
      model: ' gpt-4o ',
      gatewayProfile: '   ',
      freeModel: false,
      note: '',
    });
    expect(p).toEqual({ kind: 'model', name: '甲', spec: { model: 'gpt-4o' } });
    const full = buildRegistryPayload('model', '甲', {
      model: 'gpt-4o',
      gatewayProfile: 'p-main',
      freeModel: true,
      note: '留作对照',
    });
    expect(full!.spec).toEqual({ model: 'gpt-4o', gatewayProfile: 'p-main', freeModel: true, note: '留作对照' });
    expect(Object.keys(full!.spec)).toEqual(['model', 'gatewayProfile', 'freeModel', 'note']);
  });

  it('必填没填时拒组装（返回 null），未知 kind 也拒（不猜形状）', () => {
    expect(buildRegistryPayload('model', '甲', { model: '  ' })).toBeNull();
    expect(buildRegistryPayload('skill', '甲', {})).toBeNull();
  });

  /** v14-T4：`mcp` 是第二类可登记 kind——表单长三键，但**只登记不探测**（没有健康点那一格） */
  it('mcp 长出三键且 command 必填；args 空了整键不发', () => {
    expect(formFieldsFor('mcp')!.map((f) => f.key)).toEqual(['command', 'args', 'note']);
    expect(missingRequiredFields('mcp', '', {})).toEqual(['显示名', '启动命令']);
    expect(buildRegistryPayload('mcp', ' 文件服务 ', { command: ' npx ', args: '   ', note: '' })).toEqual({
      kind: 'mcp',
      name: '文件服务',
      spec: { command: 'npx' },
    });
    expect(buildRegistryPayload('mcp', '甲', { command: '' })).toBeNull();
    // 出厂清单类（视图 kind）不进下拉：选了也登记不了，那是假可点
    expect(registrableKinds(['model', 'agent-kind', 'node-type', 'mcp'], ['agent-kind', 'node-type'])).toEqual([
      'model',
      'mcp',
    ]);
  });
});

describe('v14-X1 只读 spec 与前向兼容读数', () => {
  it('spec 渲成 标签→值 的行数组（不是可编辑文本团），布尔给 是/否，未知键原样挂出', () => {
    const rows = specRows({ model: 'gpt-4o', freeModel: true, custom: 7 });
    expect(rows).toEqual([
      { key: 'model', label: '型号', text: 'gpt-4o' },
      { key: 'freeModel', label: '免费位', text: '是' },
      { key: 'custom', label: 'custom', text: '7' },
    ]);
    expect(specRows('怪形状')[0]!.text).toBe('怪形状');
  });

  it('refs：键不在就什么都不画——缺 ≠ 0（引用账没读出来不是「没人用」）', () => {
    expect(refCountOf(entry())).toBeNull();
    // 引用者形状与 server 的 RegistryReferrer 一致（face/id/name/via），别拿假形状喂测试
    expect(refCountOf(entry({ refs: [{ face: 'gateway', id: 'p-free', name: '免费档', via: 'freeModel' }] } as never))).toBe(1);
    expect(refCountOf(entry({ refs: 3 } as never))).toBe(3);
    expect(refCountOf(entry({ refs: null } as never))).toBeNull();
  });

  it('R4 三态：live 绿 / missing 红 / 其余一律灰，没读数就不画——探不通绝不并成「不在」', () => {
    expect(healthDot(undefined)).toBeNull();
    expect(healthDot({ status: 'live', detail: '在清单里' })).toBe('ok');
    expect(healthDot({ status: 'missing', detail: '清单里没有' })).toBe('bad');
    expect(healthDot({ status: 'unknown', detail: 'HTTP 503' })).toBe('unknown');
    // server 日后加一枚枚举值：落灰、原样，不就近并进红点（那等于替人判死）
    expect(healthDot({ status: 'degraded', detail: '' })).toBe('unknown');
    expect(healthTitle(undefined)).toBeUndefined();
    expect(healthTitle({ status: 'unknown', detail: '未探得：「档」HTTP 503' })).toBe('未探得：「档」HTTP 503');
    expect(healthTitle({ status: 'live', detail: '在', cached: true })).toBe('在（缓存读数）');
    expect(healthTitle({ status: 'missing', detail: '  ' })).toBe('状态「missing」（server 没给解释）');
  });

  it('healthIndex：没有探针通道的 kind 整键不给 → 表上天然没有点（不是画成灰点）', () => {
    const res = {
      at: '2026-09-26T12:00:00.000Z',
      entries: [
        { id: 'model:a', health: { status: 'live', detail: '在', at: 'x', cached: false } },
        { id: 'role:r-x' },
      ],
      dangling: [],
    } as never;
    const idx = healthIndex(res);
    expect(healthDot(idx.get('model:a'))).toBe('ok');
    expect(idx.has('role:r-x')).toBe(false);
    expect(healthDot(idx.get('role:r-x'))).toBeNull();
  });

  it('时间戳：能读则读成人话，读不出原样挂出，空才是空', () => {
    expect(formatWhen('2026-09-01T08:00:00.000Z')).toMatch(/^2026-09-0\d \d{2}:\d{2}$/);
    expect(formatWhen('不是时间')).toBe('不是时间');
    expect(formatWhen(undefined)).toBe('');
  });
});

/**
 * v14-T3 模板卡上那一行「需要：…」。四态各有归宿，混一件就是假账：
 * 命中 ✓ / 缺口 ✗ / 还判不了 ? / 预检没读出 …（绝不画 ✓）/ 没带槽 什么都不画。
 */
describe('requirementBadge / requirementDetail（能力槽读数排版）', () => {
  const row = (over: Partial<RegistryCheckRow> = {}): RegistryCheckRow => ({
    template: 'flow',
    slots: [{ kind: 'model', id: 'gpt-4o-mini', verdict: 'ok', why: '用「小4号」' }],
    need: [{ kind: 'model', label: '模型', declared: 1, judged: 1, gaps: 0 }],
    missing: [],
    unjudged: [],
    malformed: [],
    ok: true,
    ...over,
  });

  it('命中画 ✓、缺口画 ✗：文案吃 server 的分组计数，前端不自己数', () => {
    expect(requirementBadge(row(), 1)).toEqual({ text: '需要：模型 1', tone: 'ok' });
    expect(
      requirementBadge(
        row({
          ok: false,
          need: [
            { kind: 'model', label: '模型', declared: 1, judged: 1, gaps: 1 },
            { kind: 'skill', label: '技能', declared: 2, judged: 0, gaps: 0 },
          ],
        }),
        3,
      ),
    ).toEqual({ text: '需要：模型 1 · 技能 2', tone: 'gap' });
  });

  it('整组都判不了 = pending（画问号）：它既不是缺口也不是命中，红绿都不对', () => {
    const r = row({
      slots: [{ kind: 'skill', id: 'skills/x/SKILL.md', verdict: 'unjudged', why: '还没迁进注册表' }],
      need: [{ kind: 'skill', label: '技能', declared: 1, judged: 0, gaps: 0 }],
      unjudged: [{ kind: 'skill', id: 'skills/x/SKILL.md', verdict: 'unjudged', why: '还没迁进注册表' }],
    });
    expect(requirementBadge(r, 1).tone).toBe('pending');
    // 一半命中一半判不了 → 按命中说（有真读数就别挂问号）
    expect(requirementBadge({ ...r, slots: [...r.slots, { kind: 'model', verdict: 'ok', why: '用「小4号」' }] }, 2).tone).toBe('ok');
  });

  it('预检没读出不冒充 ✓：模板自己说了要几项，就当「不知道」明说', () => {
    expect(requirementBadge(undefined, 2)).toEqual({ text: '需要 2 项 · 预检没读出', tone: 'unknown' });
    expect(requirementBadge(undefined, 0)).toEqual({ text: '', tone: 'none' }); // 没声明也没读数：这一格不画
  });

  it('slots 空数组是正读数「没带槽」，与「预检没读出」（row undefined）分家', () => {
    expect(requirementBadge(row({ slots: [], need: [] }), 0)).toEqual({
      text: '没带能力槽',
      tone: 'none',
    });
  });

  it('detail 一行一槽：✓/✗/?/⚠ 四种标记 + server 的缺因原文；认不出的 verdict 原样画不猜标记', () => {
    const detail = requirementDetail(
      row({
        slots: [
          { kind: 'model', id: 'gpt-4o-mini', verdict: 'ok', why: '用「小4号」' },
          { kind: 'model', id: 'gpt-9', verdict: 'missing', why: '注册表里没有' },
          { kind: 'skill', verdict: 'unjudged', why: '这一类还判不了' },
          { kind: 'model', verdict: 'malformed', why: '声明形状不认' },
          { kind: 'model', verdict: 'probed-elsewhere', why: '未来新值' },
        ],
      }),
    );
    expect(detail.split('\n')).toEqual([
      '✓ model → gpt-4o-mini：用「小4号」',
      '✗ model → gpt-9：注册表里没有',
      '? skill：这一类还判不了',
      '⚠ model：声明形状不认',
      'probed-elsewhere model：未来新值',
    ]);
  });
});

describe('v14-A3-2 内置清单视图项的消费面（只认 server 给的 view 标，不拿 source 猜）', () => {
  const viewEntry = (over: Partial<RegistryEntryView> = {}): RegistryEntryView =>
    entry({ id: 'agent-kind:pi', kind: 'agent-kind' as never, name: 'pi', source: 'builtin', view: true, ...over });

  it('条目级：view 是 server 的读数；缺键（旧 server）按可写条目渲染', () => {
    expect(isViewEntry(viewEntry())).toBe(true);
    expect(isViewEntry(entry())).toBe(false);
    // source 是出处、view 是可写性：拿 builtin 推「不可删」会把未来的 discovered 出厂项一起判死
    expect(isViewEntry(entry({ source: 'builtin' }))).toBe(false);
  });

  it('分组级：出厂那一组整组标 view，且以 server 的 viewKinds 为准（空组也说清「不用登记」）', () => {
    const groups = groupEntriesByKind([viewEntry()], ['model', 'agent-kind'], ['agent-kind'], {
      model: '模型',
      'agent-kind': 'Agent 引擎',
    });
    expect(groups.map((g) => [g.kind, g.view, g.label])).toEqual([
      ['model', false, '模型'],
      ['agent-kind', true, 'Agent 引擎'],
    ]);
    // 出厂组一枚货都没探到时仍立牌并说明——不能因为它空就当普通空组劝人来登记
    const empty = groupEntriesByKind([], ['agent-kind'], ['agent-kind'], { 'agent-kind': 'Agent 引擎' });
    expect(empty[0]).toMatchObject({ view: true, entries: [] });
  });

  it('登记下拉里不挂出厂 kind：挂上去就是「点开却登记不了」的假可点', () => {
    expect(registrableKinds(['model', 'agent-kind'], ['agent-kind'])).toEqual(['model']);
    expect(registrableKinds(['model', 'agent-kind'])).toEqual(['model', 'agent-kind']); // 旧 server 缺键：不猜
  });

  it('两枚时刻的表头分家：出厂项没有登记时刻，说「登记于」是假话', () => {
    expect(whenLabels(false)).toMatchObject({ created: '登记于', updated: '改于', note: '' });
    expect(whenLabels(true).created).not.toContain('登记');
    expect(whenLabels(true).note).toContain('版本自带');
  });
});
