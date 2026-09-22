import type { RunAttention } from '@paneflow/shared';

/**
 * v12-V2 人介入账（验证税）的纯函数：放门处的结算规则。
 * 定位与 side-effects.ts / token-budget.ts 同款——判据集中一处小文件，
 * engine 只在放门点接线调用；收口/读端都只消费落册结果，绝不从 events 重算（评审 R4）。
 * arXiv 2609.04681「验证税」：人复核/批门是主要延迟源，不入账的复利叙事是自欺。
 */

/** 放门决策类型——与 ApprovalAction.action 同域 */
export type GateDecision = 'approve' | 'reject' | 'input';

/** 空账本（首笔结算的起点） */
export function emptyAttention(): RunAttention {
  return { waitMs: 0, gates: { approve: 0, reject: 0, input: 0 } };
}

/**
 * 放门结算（返回新对象，不改 prev）：
 * - 计数是事实——放门动作确实发生了，无论进门时刻可考与否都 +1；
 * - waitMs 只在拦/放两端时刻皆可考且差值为正时累进——旧 run 存量路、
 *   重启后进门时刻对不上的轮次一律只计不加（宁可少记不虚记）；
 * - 同一节点多轮进出门逐次调用本函数累加，天然合法。
 */
export function bookGateRelease(
  prev: RunAttention | undefined,
  decision: GateDecision,
  enteredAt: string | undefined,
  releasedAtMs: number,
): RunAttention {
  const next: RunAttention = {
    waitMs: Number.isFinite(prev?.waitMs) ? prev!.waitMs : 0,
    gates: {
      approve: prev?.gates?.approve ?? 0,
      reject: prev?.gates?.reject ?? 0,
      input: prev?.gates?.input ?? 0,
    },
  };
  if (decision === 'approve' || decision === 'reject' || decision === 'input') {
    next.gates[decision] += 1;
  }
  const enteredMs = enteredAt ? Date.parse(enteredAt) : NaN;
  if (Number.isFinite(enteredMs) && Number.isFinite(releasedAtMs)) {
    const wait = releasedAtMs - enteredMs;
    if (wait > 0) next.waitMs += Math.round(wait);
  }
  return next;
}

/** 人等分（分钟，一位小数）——收数表列与展示面的单源格式化；无账本返回 '-' */
export function attentionMinutes(attention: RunAttention | undefined): string {
  if (!attention) return '-';
  const ms = Number.isFinite(attention.waitMs) ? attention.waitMs : 0;
  return (ms / 60_000).toFixed(1);
}
