import { describe, expect, it } from 'vitest';
import {
  buildRegistryPayload,
  formFieldsFor,
  formatWhen,
  groupEntriesByKind,
  kindGroupLabel,
  missingRequiredFields,
  probeOf,
  refCountOf,
  rejectedSummary,
  sourceLabel,
  specRows,
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
  it('knownKinds 立牌：空组也在——空表是正读数不是错误，不画报错', () => {
    const groups = groupEntriesByKind([], ['model']);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('model');
    expect(groups[0]!.label).toBe('模型');
    expect(groups[0]!.entries).toEqual([]);
  });

  it('分组按 server 给的 knownKinds 顺序，条目按 kind 归位', () => {
    const groups = groupEntriesByKind([entry(), entry({ id: 'x:1', kind: 'other' as never })], ['model']);
    expect(groups.map((g) => g.kind)).toEqual(['model', 'other']);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['model:gpt-4o']);
  });

  it('未知 kind 不静默吞：条目里有 knownKinds 之外的 kind 时追加成组并标明未知', () => {
    const groups = groupEntriesByKind([entry({ kind: 'skill' as never })], ['model']);
    expect(groups.map((g) => g.kind)).toEqual(['model', 'skill']);
    expect(kindGroupLabel('skill')).toContain('未知类型');
    expect(kindGroupLabel('skill')).toContain('skill');
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

  it('refs/probe：键不在就什么都不画——缺 ≠ 0，缺 ≠ 不健康', () => {
    expect(refCountOf(entry())).toBeNull();
    expect(probeOf(entry())).toBeNull();
    // 引用者形状与 server 的 RegistryReferrer 一致（face/id/name/via），别拿假形状喂测试
    expect(refCountOf(entry({ refs: [{ face: 'gateway', id: 'p-free', name: '免费档', via: 'freeModel' }] } as never))).toBe(1);
    expect(refCountOf(entry({ refs: 3 } as never))).toBe(3);
    expect(refCountOf(entry({ refs: null } as never))).toBeNull();
    const p = probeOf(entry({ probe: { ok: false, detail: '404', at: '2026-09-01' } } as never));
    expect(p).toEqual({ ok: false, detail: '404', at: '2026-09-01' });
    expect(probeOf(entry({ probe: { detail: '形状不认识' } } as never))).toBeNull();
  });

  it('时间戳：能读则读成人话，读不出原样挂出，空才是空', () => {
    expect(formatWhen('2026-09-01T08:00:00.000Z')).toMatch(/^2026-09-0\d \d{2}:\d{2}$/);
    expect(formatWhen('不是时间')).toBe('不是时间');
    expect(formatWhen(undefined)).toBe('');
  });
});
