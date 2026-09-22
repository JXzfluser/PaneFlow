import { describe, expect, it } from 'vitest';
import { hasSideEffects, sideEffectsSummary } from './side-effects.js';

// v12-S1a/S1b 副作用账目纯函数：判空与清单摘要（拒绝文案/透明性事件的统一表述源）
describe('v12-S1a side-effects 纯函数（判空含 prUrl/pushedAt；摘要缺项跳过绝不编值）', () => {
  it('空账判 false：undefined / 空对象 / 空数组键都不算副作用', () => {
    expect(hasSideEffects(undefined)).toBe(false);
    expect(hasSideEffects({})).toBe(false);
    expect(hasSideEffects({ issuesCreated: [], issuePatched: [] })).toBe(false);
    expect(sideEffectsSummary(undefined)).toEqual([]);
    expect(sideEffectsSummary({ issuesCreated: [] })).toEqual([]);
  });

  it('任一非空键即 true（含镜像 prUrl 与自报 pushedAt）', () => {
    expect(hasSideEffects({ prUrl: 'https://x/pull/1' })).toBe(true);
    expect(hasSideEffects({ pushedAt: '2026-09-22T00:00:00.000Z' })).toBe(true);
    expect(hasSideEffects({ issuesCreated: [3] })).toBe(true);
  });

  it('清单按账目顺序拼可读项：建单#12、#31 · 回写#7 · PR url · 已推送 时刻', () => {
    expect(
      sideEffectsSummary({
        issuesCreated: [12, 31],
        issuePatched: [7],
        prUrl: 'https://github.com/o/r/pull/3',
        pushedAt: '2026-09-22T02:03:04.000Z',
      }),
    ).toEqual([
      '建单#12、#31',
      '回写#7',
      'PR https://github.com/o/r/pull/3',
      '已推送 2026-09-22T02:03:04.000Z',
    ]);
  });
});
