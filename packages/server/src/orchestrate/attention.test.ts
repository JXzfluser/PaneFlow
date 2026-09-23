import { describe, expect, it } from 'vitest';
import { attentionMinutes, bookGateRelease, emptyAttention } from './attention.js';

/**
 * v12-V2 人介入结算纯函数单测：验证税的入账纪律——
 * 计数恒实（放门即事实）、时长宁缺毋假（两端时刻不可考/差值非正就不累）。
 */

const T0 = Date.parse('2026-09-29T08:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe('v12-V2 bookGateRelease（放门结算：纯函数、只增不改 prev）', () => {
  it('首笔 approve：prev 为空从空账起算，waitMs=拦放两端的差', () => {
    const next = bookGateRelease(undefined, 'approve', at(0), T0 + 250_000);
    expect(next).toEqual({ waitMs: 250_000, gates: { approve: 1, reject: 0, input: 0 } });
  });

  it('三态各进各的键，互不串门', () => {
    let a = bookGateRelease(undefined, 'reject', at(0), T0 + 1_000);
    a = bookGateRelease(a, 'input', at(2_000), T0 + 4_000);
    a = bookGateRelease(a, 'approve', at(5_000), T0 + 9_000);
    expect(a.gates).toEqual({ approve: 1, reject: 1, input: 1 });
    expect(a.waitMs).toBe(1_000 + 2_000 + 4_000);
  });

  it('多轮进出逐次累加（同节点谈完再拦合法）', () => {
    let a = bookGateRelease(undefined, 'input', at(0), T0 + 60_000);
    a = bookGateRelease(a, 'approve', at(120_000), T0 + 200_000);
    expect(a).toEqual({ waitMs: 60_000 + 80_000, gates: { approve: 1, reject: 0, input: 1 } });
  });

  it('进门时刻缺失/破烂/倒挂 → 只计次不加时长（宁可少记不虚记）', () => {
    const cases: (string | undefined)[] = [undefined, '', 'not-a-date', at(10_000)]; // 末个：放门早于进门（时钟回拨）
    for (const enteredAt of cases) {
      const a = bookGateRelease(undefined, 'approve', enteredAt, T0);
      expect(a).toEqual({ waitMs: 0, gates: { approve: 1, reject: 0, input: 0 } });
    }
  });

  it('差值为 0 不累（毫秒同刻放门不存在正税）；prev 不被改动（纯函数）', () => {
    const prev = emptyAttention();
    const a = bookGateRelease(prev, 'approve', at(0), T0);
    expect(a.waitMs).toBe(0);
    expect(prev).toEqual({ waitMs: 0, gates: { approve: 0, reject: 0, input: 0 } });
  });

  it('怪 prev（缺 gates 键/waitMs 非数）按空补零，结算不被旧脏数据带崩', () => {
    const dirty = { waitMs: Number.NaN } as unknown as ReturnType<typeof emptyAttention>;
    const a = bookGateRelease(dirty, 'reject', at(0), T0 + 500);
    expect(a).toEqual({ waitMs: 500, gates: { approve: 0, reject: 1, input: 0 } });
  });
});

describe('v12-V2 attentionMinutes（人等分格式化：收数表列/展示单源）', () => {
  it('分钟一位小数；无账本画 -；零等待如实 0.0', () => {
    expect(attentionMinutes({ waitMs: 252_000, gates: { approve: 2, reject: 0, input: 1 } })).toBe('4.2');
    expect(attentionMinutes({ waitMs: 0, gates: { approve: 0, reject: 0, input: 0 } })).toBe('0.0');
    expect(attentionMinutes(undefined)).toBe('-');
  });
});
