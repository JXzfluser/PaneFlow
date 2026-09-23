import type { RunContract, RunTokenLedger } from '@paneflow/shared';

/**
 * v12-S2 token 预算执行点的纯函数集：给已铺好的 contract.budget.maxTokens 字段补熔断判据。
 * 定位与 side-effects.ts / harness.ts 同款——判据全在这里（R4：CLI 只渲染不判断），
 * engine 只在两处接线：产物落册即累加（bookUsage）、节点尝试启动前比对（budgetBreach）。
 *
 * 口径纪律（与收口 cost.tokens 一字同源）：
 * - 只认 agent 自报的 artifact.extra.usage，破烂值静默跳过，**绝不估算**；
 * - 从未自报 usage 的 run（costLive 缺省）带再小预算也跑得完——null 只警示不熔断（评审 R3）；
 * - 时长维度（budget.maxMinutes）不在本片：节点 timeoutMs 缺省 30min 硬顶是先例，另片再议。
 */

/** 合法 usage 值：input/output 都是有限非负数；其余（缺键/字符串/负数/NaN）一律不认 */
export interface UsageValue {
  input: number;
  output: number;
}

function legitToken(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * 从产物 extra 解析合法 usage（三态累加的入口判据）：
 * 与 computeRunCost 同一份校验口径（typeof number），这里额外挡掉 NaN/Infinity/负数——
 * 熔断账只收可信值，破烂值静默跳过（不记事件不抛错，宁漏不误伤）。
 */
export function parseUsage(extra: Record<string, unknown> | undefined | null): UsageValue | null {
  const usage = extra?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = usage as { input?: unknown; output?: unknown };
  if (!legitToken(u.input) || !legitToken(u.output)) return null;
  return { input: u.input, output: u.output };
}

/**
 * 把一节点的一次合法自报累进实时账（返回新账本，engine 负责挂回 run）：
 * per-节点记账户头取分量 max，只有正向差额进总账——
 * 同产物重提取（澄清轮/门内复核）值不变即零增量不双计；重试后报得更多则补差；
 * 报得更少不回收（只增不减，宁高估已用也不让熔断倒退回放行）。
 */
export function bookUsage(
  live: RunTokenLedger | undefined,
  nodeId: string,
  usage: UsageValue,
): RunTokenLedger {
  const prev = live ?? { input: 0, output: 0, byNode: {} };
  const booked = prev.byNode[nodeId] ?? { input: 0, output: 0 };
  const dIn = Math.max(0, usage.input - booked.input);
  const dOut = Math.max(0, usage.output - booked.output);
  if (!dIn && !dOut) return prev;
  return {
    input: prev.input + dIn,
    output: prev.output + dOut,
    byNode: {
      ...prev.byNode,
      [nodeId]: {
        input: Math.max(booked.input, usage.input),
        output: Math.max(booked.output, usage.output),
      },
    },
  };
}

function legitCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * 上限解析（纯函数，矩阵见测试）：contract.budget.maxTokens 优先，
 * 回落 env PF_RUN_MAX_TOKENS（engine 构造时经 envInt 读成数字传入）；
 * 0/负数/NaN/缺失 = 该级关闭——两级都无效则返回 null（预算比对整体不启用）。
 * env 破烂由 envInt 先兜成 fallback（未设/非数字 → 0 = 关闭），这里再统一判正。
 */
export function resolveTokenCap(
  contract: RunContract | undefined,
  envMaxTokens: number | undefined,
): number | null {
  const fromContract = contract?.budget?.maxTokens;
  if (legitCap(fromContract)) return fromContract;
  if (legitCap(envMaxTokens)) return envMaxTokens;
  return null;
}

/** 超限判定结果：合计已用与上限都带出来，拼 error 文案与事件句用 */
export interface BudgetBreach {
  input: number;
  output: number;
  used: number;
  cap: number;
}

/** 超限判定（in+out 合计 vs 上限，严格大于才熔断）；无上限或账本缺失/为 0 恒不超 */
export function budgetBreach(live: RunTokenLedger | undefined, cap: number | null): BudgetBreach | null {
  if (cap === null) return null;
  const input = live?.input ?? 0;
  const output = live?.output ?? 0;
  const used = input + output;
  return used > cap ? { input, output, used, cap } : null;
}

/** 熔断 error 一句（status/watch 原样带出，CLI 零改动）——「token 预算超限（已用 X / 上限 Y）」 */
export function budgetBreachMessage(used: number, cap: number): string {
  return `token 预算超限（已用 ${used} / 上限 ${cap}）`;
}
