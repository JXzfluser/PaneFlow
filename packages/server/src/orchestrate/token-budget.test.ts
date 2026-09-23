import { describe, expect, it } from 'vitest';
import type { RunContract } from '@paneflow/shared';
import {
  bookUsage,
  budgetBreach,
  budgetBreachMessage,
  parseUsage,
  resolveTokenCap,
} from './token-budget.js';

/**
 * v12-S2 token 预算执行点的判据测试：累加三态 / 上限解析矩阵 / 超限比对。
 * 引擎接线（启动前熔断、null 只警示、persist 往返）在 engine.test.ts。
 */

const contractWith = (maxTokens?: unknown): RunContract =>
  ({
    assertions: [],
    questions: [],
    source: 'input',
    ...(maxTokens === undefined ? {} : { budget: { maxTokens } as never }),
  }) as RunContract;

describe('v12-S2 usage 解析与累加三态（破烂静默跳过、绝不估算）', () => {
  it('合法态：input/output 均为有限非负数才认；缺键/字符串/负数/NaN/Infinity 一律不认', () => {
    expect(parseUsage({ usage: { input: 10, output: 20 } })).toEqual({ input: 10, output: 20 });
    expect(parseUsage({ usage: { input: 0, output: 0 } })).toEqual({ input: 0, output: 0 });
    expect(parseUsage({ usage: { input: '10', output: 20 } })).toBeNull();
    expect(parseUsage({ usage: { input: 10 } })).toBeNull();
    expect(parseUsage({ usage: { input: -1, output: 20 } })).toBeNull();
    expect(parseUsage({ usage: { input: NaN, output: 20 } })).toBeNull();
    expect(parseUsage({ usage: { input: Infinity, output: 20 } })).toBeNull();
    expect(parseUsage({ usage: 'used 3k tokens' })).toBeNull();
    expect(parseUsage({})).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
  });

  it('累加态一：首报全额入账，多节点各记各的户头', () => {
    let live = bookUsage(undefined, 'a', { input: 100, output: 50 });
    expect(live).toEqual({ input: 100, output: 50, byNode: { a: { input: 100, output: 50 } } });
    live = bookUsage(live, 'b', { input: 30, output: 20 });
    expect(live.input).toBe(130);
    expect(live.output).toBe(70);
    expect(Object.keys(live.byNode)).toEqual(['a', 'b']);
  });

  it('累加态二：同产物重提取同值 → 零增量不双计（总账与户头都不动）', () => {
    const live = bookUsage(undefined, 'a', { input: 100, output: 50 });
    const again = bookUsage(live, 'a', { input: 100, output: 50 });
    expect(again).toBe(live); // 原对象返回：engine 以引用变化判「有没有入账」
    expect(again.input).toBe(100);
  });

  it('累加态三：重试/追加轮报得更多只补差额；报得更少不回收（只增不减，宁高估不误放）', () => {
    let live = bookUsage(undefined, 'a', { input: 100, output: 50 });
    live = bookUsage(live, 'a', { input: 130, output: 50 });
    expect(live).toEqual({ input: 130, output: 50, byNode: { a: { input: 130, output: 50 } } });
    live = bookUsage(live, 'a', { input: 10, output: 5 });
    expect(live.input).toBe(130);
    expect(live.output).toBe(50);
    expect(live.byNode.a).toEqual({ input: 130, output: 50 });
  });
});

describe('v12-S2 上限解析矩阵（contract.budget.maxTokens ?? env PF_RUN_MAX_TOKENS ?? 无）', () => {
  it('契约合法正数优先于 env', () => {
    expect(resolveTokenCap(contractWith(5000), 200000)).toBe(5000);
  });

  it('契约无效值（0/负数/NaN/缺 budget/缺 maxTokens）→ 回落 env', () => {
    expect(resolveTokenCap(contractWith(0), 200000)).toBe(200000);
    expect(resolveTokenCap(contractWith(-5), 200000)).toBe(200000);
    expect(resolveTokenCap(contractWith(NaN), 200000)).toBe(200000);
    expect(resolveTokenCap(contractWith(undefined), 200000)).toBe(200000);
    expect(resolveTokenCap(undefined, 200000)).toBe(200000);
  });

  it('env 0/负数/破烂/未设（undefined）= 关闭；两级都无效 → null（比对整体不启用）', () => {
    expect(resolveTokenCap(contractWith(100), 0)).toBe(100);
    expect(resolveTokenCap(undefined, 0)).toBeNull();
    expect(resolveTokenCap(undefined, -3)).toBeNull();
    expect(resolveTokenCap(undefined, NaN)).toBeNull();
    expect(resolveTokenCap(undefined, undefined)).toBeNull();
    expect(resolveTokenCap(contractWith(0), 0)).toBeNull();
  });
});

describe('v12-S2 超限比对（in+out 合计 vs 上限，严格大于才熔断）', () => {
  const live = bookUsage(bookUsage(undefined, 'a', { input: 60, output: 40 }), 'b', { input: 5, output: 5 });

  it('无上限恒不超；账本缺失按 0 用不超（null 不熔断判据源）', () => {
    expect(budgetBreach(live, null)).toBeNull();
    expect(budgetBreach(undefined, 100)).toBeNull();
    expect(budgetBreach({ input: 0, output: 0, byNode: {} }, 100)).toBeNull();
  });

  it('合计等于上限不熔断，超过一分即熔断并带出 used/cap', () => {
    expect(budgetBreach(live, 110)).toBeNull();
    const b = budgetBreach(live, 109);
    expect(b).toEqual({ input: 65, output: 45, used: 110, cap: 109 });
  });

  it('error 文案定稿：status/watch 原样带出的一句', () => {
    expect(budgetBreachMessage(110, 100)).toBe('token 预算超限（已用 110 / 上限 100）');
  });
});
