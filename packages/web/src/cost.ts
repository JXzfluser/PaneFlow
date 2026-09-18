import type { RunRecord } from '@paneflow/shared';

/** v7-A3 成本可见：run.cost（R6a 已算好）→ 一行紧凑文案。无 cost（旧记录/仍在跑）返回 null，绝不现编。 */
export function runCostLabel(run: RunRecord): string | null {
  const c = run.cost;
  if (!c) return null;
  const dur = fmtDuration(c.totalMs);
  const retries = c.retries > 0 ? ` · 重试 ${c.retries}` : '';
  const tokens = c.tokens === null ? ' · tokens unknown' : ` · tokens ${fmtTokens(c.tokens.input)}↑/${fmtTokens(c.tokens.output)}↓`;
  return `时长 ${dur}${retries}${tokens}`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
