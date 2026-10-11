/**
 * v19-R8 看板卡就地读数的取数层（纯函数，判据零自造）：
 * 「在跑哪格 / 最后三笔动静 / 哪道门等你批」全部读自 store 里既有的 run 记录——
 * WS 推的就是整本 RunRecord（含 events），这里不新发请求、不轮询、不改口径。
 */
import type { RunRecord } from '@paneflow/shared';

export interface BoardLiveView {
  /** 在跑格一句话（含已进行时长；时长不可考明说） */
  nowLine: string | null;
  /** 最后至多三笔事件（原样文本 + 时刻） */
  lines: { at: string; text: string }[];
  /** 事件账存在但为空，且单子还在跑：动静还没落账 */
  quiet: boolean;
  /** 等你批的第一道门（多道门计数进 ask） */
  gate: { nodeId: string; label: string; ask: string } | null;
}

const LIVE_NODE_STATES = ['working', 'starting', 'retrying'];

function labelOf(run: RunRecord, id: string): string {
  return run.graph.nodes.find((n) => n.id === id)?.label ?? id;
}

/** 在跑格已进行时长：startedAt 缺或不可考就明说，不拿「刚刚」冒充读数 */
export function runningMinutes(startedAt: string | undefined, now = Date.now()): string {
  if (!startedAt) return '时长不可考';
  const m = Math.round((now - new Date(startedAt).getTime()) / 60_000);
  if (!Number.isFinite(m) || m < 0) return '时长不可考';
  return m < 1 ? '刚开始' : `已 ${m} 分`;
}

export function boardLiveView(run: RunRecord, now = Date.now()): BoardLiveView {
  const recs = Object.values(run.nodes);
  const running = recs.filter((n) => LIVE_NODE_STATES.includes(n.state));
  const blocked = recs.filter((n) => n.state === 'blocked');
  const nowLine = running.length
    ? `在跑：${running.slice(0, 2).map((n) => `${labelOf(run, n.nodeId)}（${runningMinutes(n.startedAt, now)}）`).join(' · ')}` +
      (running.length > 2 ? ` 等 ${running.length} 格` : '')
    : null;
  const lines = (run.events ?? []).slice(-3).map((e) => ({ at: e.at, text: e.text }));
  const quiet = run.state === 'running' && Array.isArray(run.events) && run.events.length === 0;
  const gate = blocked.length
    ? {
        nodeId: blocked[0]!.nodeId,
        label: labelOf(run, blocked[0]!.nodeId),
        ask: `等你批：${labelOf(run, blocked[0]!.nodeId)}${blocked.length > 1 ? ` 等 ${blocked.length} 道门` : ''}`,
      }
    : null;
  return { nowLine, lines, quiet, gate };
}
