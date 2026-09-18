import { describe, expect, it } from 'vitest';
import type { RunRecord, RunCost } from '@paneflow/shared';
import { runCostLabel } from './cost.js';

function runWith(cost: RunCost | undefined): RunRecord {
  return { cost } as unknown as RunRecord;
}

describe('runCostLabel (v7-A3)', () => {
  it('无 cost（旧记录/在跑）返回 null——不现编数字', () => {
    expect(runCostLabel(runWith(undefined))).toBeNull();
  });

  it('tokens=null 明示 unknown，有值则 k/M 缩写', () => {
    const base = { totalMs: 45_000, byNode: {}, retries: 0 };
    expect(runCostLabel(runWith({ ...base, tokens: null }))).toBe('时长 45s · tokens unknown');
    expect(runCostLabel(runWith({ ...base, tokens: { input: 12_345, output: 890 } }))).toBe('时长 45s · tokens 12.3k↑/890↓');
    expect(runCostLabel(runWith({ ...base, tokens: { input: 2_500_000, output: 0 } }))).toBe('时长 45s · tokens 2.5M↑/0↓');
  });

  it('重试为 0 时不占位；时长 m/h 分级', () => {
    expect(runCostLabel(runWith({ totalMs: 754_000, byNode: {}, retries: 0, tokens: null }))).toBe('时长 12m34s · tokens unknown');
    expect(runCostLabel(runWith({ totalMs: 3_720_000, byNode: {}, retries: 3, tokens: null }))).toBe('时长 1h2m · 重试 3 · tokens unknown');
  });
});
