import type { RunRecord } from '@paneflow/shared';

/**
 * v18-R4 用量聚合（纯函数）：对账「这个月哪个项目烧了多少 token」这一问。
 * 口径三则（与 cost/costLive 的既有账本同源，绝不估算）：
 *  · token 只认 run.cost.tokens（引擎收口 computeRunCost 落册的合计；缺=该单只计 runs 不计 token——
 *    「不知道」不是 0，但聚合面按 0 计入分母是诚实读数，明细缺失由分母差暴露）；
 *  · 归日 = run.finishedAt ?? startedAt 的 UTC 日期（toISOString 口径，与账面时刻同源）；
 *  · 分组键缺项不编造：spaceId 缺=default（Store 的既有缺省），agentKind 缺=unknown（前端渲「未落册」）。
 * 熔断计数只认节点 error 的固定句式「token 预算超限」（engine 熔断路的原话），不靠事件反推。
 */

export interface UsageBucket {
  key: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface UsageReport {
  days: number;
  generatedAt: string;
  totals: { runs: number; tokensIn: number; tokensOut: number };
  byDay: UsageBucket[];
  bySpace: UsageBucket[];
  byKind: UsageBucket[];
  budget: {
    /** env PF_RUN_MAX_TOKENS 现值（>0 整数；否则 null=未设/关闭） */
    envMaxTokens: number | null;
    /** 触发过 token 熔断的 run 数（窗口内） */
    tripRuns: number;
  };
}

const TOKEN_TRIP_MARK = 'token 预算超限';

const emptyBucket = (key: string): UsageBucket => ({ key, runs: 0, tokensIn: 0, tokensOut: 0 });

const bump = (map: Map<string, UsageBucket>, key: string, run: RunRecord): void => {
  const b = map.get(key) ?? emptyBucket(key);
  b.runs += 1;
  b.tokensIn += run.cost?.tokens?.input ?? 0;
  b.tokensOut += run.cost?.tokens?.output ?? 0;
  map.set(key, b);
};

const sorted = (map: Map<string, UsageBucket>): UsageBucket[] =>
  [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));

/** 熔断过 = 任一节点 error 带固定句式（节点级 error 是 engine 熔断路的落册点）。 */
export const runTrippedTokenBudget = (run: RunRecord): boolean =>
  Object.values(run.nodes ?? {}).some((n) => typeof n?.error === 'string' && n.error.includes(TOKEN_TRIP_MARK));

export function computeUsageReport(
  runs: RunRecord[],
  opts: { days?: number; now?: Date; envMaxTokens?: number | null } = {},
): UsageReport {
  const days = Math.min(365, Math.max(1, Math.floor(opts.days ?? 30)));
  const now = opts.now ?? new Date();
  // 窗口按「天」收口：cutoffDay=now-(days-1) 的 UTC 日期，键字典序比较即窗口内
  const cutoffDay = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const inWindow = runs.filter((r) => {
    const day = (r.finishedAt ?? r.startedAt ?? '').slice(0, 10);
    return day >= cutoffDay && day <= now.toISOString().slice(0, 10);
  });
  const byDay = new Map<string, UsageBucket>();
  const bySpace = new Map<string, UsageBucket>();
  const byKind = new Map<string, UsageBucket>();
  let totalRuns = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const r of inWindow) {
    const day = (r.finishedAt ?? r.startedAt).slice(0, 10);
    bump(byDay, day, r);
    bump(bySpace, r.spaceId ?? 'default', r);
    bump(byKind, r.harness?.agentKind ?? 'unknown', r);
    totalRuns += 1;
    totalIn += r.cost?.tokens?.input ?? 0;
    totalOut += r.cost?.tokens?.output ?? 0;
  }
  const envRaw = Number(opts.envMaxTokens ?? process.env.PF_RUN_MAX_TOKENS);
  return {
    days,
    generatedAt: now.toISOString(),
    totals: { runs: totalRuns, tokensIn: totalIn, tokensOut: totalOut },
    byDay: sorted(byDay),
    bySpace: sorted(bySpace),
    byKind: sorted(byKind),
    budget: {
      envMaxTokens: Number.isFinite(envRaw) && envRaw > 0 ? Math.floor(envRaw) : null,
      tripRuns: inWindow.filter(runTrippedTokenBudget).length,
    },
  };
}
