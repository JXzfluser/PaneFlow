import { describe, expect, it } from 'vitest';
import { computeUsageReport, runTrippedTokenBudget } from './usage.js';
import type { RunRecord } from '@paneflow/shared';

/** v18-R4 用量聚合纯函数：窗口收口、三分组、熔断计数、预算现值——「不知道」不冒充 0。 */

const day = (offsetDays: number): string => new Date(Date.now() - offsetDays * 86_400_000).toISOString();

const run = (over: Partial<RunRecord>): RunRecord =>
  ({
    runId: 'r1',
    dagName: 't',
    graph: { version: 1, name: 't', nodes: [], edges: [], metadata: { createdAt: '', updatedAt: '' } },
    state: 'completed',
    cwd: '/tmp',
    startedAt: day(0),
    finishedAt: day(0),
    nodes: {},
    ...over,
  }) as RunRecord;

describe('computeUsageReport', () => {
  it('窗口外的单不计入；tokens 只认 cost.tokens（缺=计单不计 token）', () => {
    const report = computeUsageReport([
      run({ runId: 'in', cost: { totalMs: 1, byNode: {}, retries: 0, tokens: { input: 100, output: 10 } } }),
      run({ runId: 'stale', startedAt: day(40), finishedAt: day(40), cost: { totalMs: 1, byNode: {}, retries: 0, tokens: { input: 9_999, output: 9 } } }),
      run({ runId: 'nocost' }),
    ]);
    expect(report.totals.runs).toBe(2);
    expect(report.totals.tokensIn).toBe(100);
    expect(report.totals.tokensOut).toBe(10);
    expect(Object.keys(report.totals).sort()).toEqual(['runs', 'tokensIn', 'tokensOut']);
    expect(report.byDay).toHaveLength(1);
  });

  it('按项目/按 agentKind 分组；缺项归 default/unknown 不编造', () => {
    const report = computeUsageReport([
      run({ runId: 'a', spaceId: 'proj-a', harness: { agentKind: 'claude', graphSha: 'x', readback: false, readbackOutcome: 'no-pages' }, cost: { totalMs: 1, byNode: {}, retries: 0, tokens: { input: 5, output: 1 } } }),
      run({ runId: 'b', harness: { agentKind: 'claude', graphSha: 'y', readback: false, readbackOutcome: 'no-pages' }, cost: { totalMs: 1, byNode: {}, retries: 0, tokens: { input: 7, output: 2 } } }),
      run({ runId: 'c' }),
    ]);
    const spaceA = report.bySpace.find((s) => s.key === 'proj-a');
    const spaceDefault = report.bySpace.find((s) => s.key === 'default');
    expect(spaceA?.runs).toBe(1);
    expect(spaceDefault?.runs).toBe(2);
    const kinds = Object.fromEntries(report.byKind.map((k) => [k.key, k.runs]));
    expect(kinds).toEqual({ claude: 2, unknown: 1 });
  });

  it('熔断计数只认节点 error 固定句式；envMaxTokens 非法值如实报 null', () => {
    const tripped = run({
      runId: 'trip',
      nodes: { impl: { nodeId: 'impl', state: 'failed', attempts: 1, error: 'token 预算超限（已用 1000 / 上限 800）' } },
    });
    const report = computeUsageReport([tripped, run({ runId: 'clean' })], { envMaxTokens: 800 });
    expect(report.budget.tripRuns).toBe(1);
    expect(report.budget.envMaxTokens).toBe(800);
    expect(runTrippedTokenBudget(run({ runId: 'x' }))).toBe(false);
    expect(computeUsageReport([run({ runId: 'y' })], { envMaxTokens: 0 }).budget.envMaxTokens).toBeNull();
  });

  it('days 收口到 1..365', () => {
    expect(computeUsageReport([], { days: 0 }).days).toBe(1);
    expect(computeUsageReport([], { days: 9999 }).days).toBe(365);
  });
});
