import type { RunEvent } from '@paneflow/shared';

/**
 * 时间线纯逻辑层（D11）：把引擎记录的 run.events 变成"谁在何时做了什么"。
 *
 * 与组件解耦的原因：事件分类/过滤/相对时间这些规则值得单测，
 * 而组件单测需要 DOM —— 把规则留在这里，测试就不依赖浏览器。
 */

export type TimelineEventType = RunEvent['type'];
export type TimelineFilter = 'all' | TimelineEventType;

export interface EventMeta {
  /** 图标（纯文本，避免引入图标依赖） */
  icon: string;
  /** 中文类别名 */
  label: string;
  /** 配色类名 */
  cls: string;
}

/** 五类事件的展示元信息，顺序即筛选条的展示顺序。 */
export const EVENT_META: Record<TimelineEventType, EventMeta> = {
  run: { icon: '▶', label: '运行', cls: 'ev-run' },
  node: { icon: '◆', label: '节点', cls: 'ev-node' },
  child: { icon: '⤳', label: '子运行', cls: 'ev-child' },
  approval: { icon: '⛔', label: '审批', cls: 'ev-approval' },
  snapshot: { icon: '▤', label: '快照', cls: 'ev-snapshot' },
};

/** 未知类型兜底（服务端未来新增事件类型时不至于渲染成空白）。 */
export const UNKNOWN_META: EventMeta = { icon: '·', label: '事件', cls: 'ev-other' };

export function metaOf(type: string): EventMeta {
  return EVENT_META[type as TimelineEventType] ?? UNKNOWN_META;
}

export const TIMELINE_FILTERS: { id: TimelineFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'run', label: '运行' },
  { id: 'node', label: '节点' },
  { id: 'child', label: '子运行' },
  { id: 'approval', label: '审批' },
  { id: 'snapshot', label: '快照' },
];

export interface EventStats {
  total: number;
  /** 各类别条数（仅包含出现过的类别） */
  counts: Record<string, number>;
  /** 涉及的不同节点数（不含无 nodeId 的运行级事件） */
  nodes: number;
  /** 是否出现过人工审批事件 */
  hasApproval: boolean;
}

export function eventStats(events: RunEvent[] | undefined): EventStats {
  const list = events ?? [];
  const counts: Record<string, number> = {};
  const nodeIds = new Set<string>();
  for (const e of list) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.nodeId) nodeIds.add(e.nodeId);
  }
  return {
    total: list.length,
    counts,
    nodes: nodeIds.size,
    hasApproval: (counts.approval ?? 0) > 0,
  };
}

/** 按类别过滤；'all' 原样返回（保持时间顺序）。 */
export function filterEvents(events: RunEvent[] | undefined, filter: TimelineFilter): RunEvent[] {
  const list = events ?? [];
  return filter === 'all' ? list : list.filter((e) => e.type === filter);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时钟 HH:MM:SS；时间戳非法时给占位符而不是 Invalid Date。 */
export function fmtClock(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 相对运行起点的耗时标签（+12s / +1m04s / +1h02m）。
 * 无从计算时（缺少起点、时间戳非法、早于起点）返回空串，由 UI 只显示绝对时间。
 */
export function relLabel(at: string, from?: string): string {
  if (!from) return '';
  const a = new Date(at).getTime();
  const b = new Date(from).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || a < b) return '';
  const secs = Math.round((a - b) / 1000);
  if (secs < 60) return `+${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `+${mins}m${pad2(secs % 60)}s`;
  return `+${Math.floor(mins / 60)}h${pad2(mins % 60)}m`;
}

/** 头部一句话摘要：`12 条事件 · 覆盖 4 个节点 · 1 次人工审批`。 */
export function summarizeTimeline(events: RunEvent[] | undefined): string {
  const st = eventStats(events);
  if (st.total === 0) return '暂无事件';
  const parts = [`${st.total} 条事件`];
  if (st.nodes > 0) parts.push(`覆盖 ${st.nodes} 个节点`);
  if (st.hasApproval) parts.push(`${st.counts.approval} 次人工审批`);
  if (st.counts.child) parts.push(`${st.counts.child} 次子运行`);
  return parts.join(' · ');
}

/** 最后一条事件（用于"当前在做什么"的一句话摘要）。 */
export function lastEvent(events: RunEvent[] | undefined): RunEvent | null {
  const list = events ?? [];
  return list.length ? list[list.length - 1]! : null;
}
