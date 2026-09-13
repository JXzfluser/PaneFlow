import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunEvent } from '@paneflow/shared';
import { useStore } from '../store.js';
import {
  TIMELINE_FILTERS,
  eventStats,
  filterEvents,
  fmtClock,
  lastEvent,
  metaOf,
  relLabel,
  summarizeTimeline,
  type TimelineFilter,
} from '../timeline.js';

export interface RunTimelineProps {
  events: RunEvent[] | undefined;
  /** 运行起点，用于渲染 `+12s` 相对耗时 */
  startedAt?: string;
  /** 运行中：显示实时点并默认跟随最新 */
  running?: boolean;
  /** 历史事件按需加载中 */
  loading?: boolean;
  emptyHint?: string;
  /** 紧凑模式（嵌在运行卡片里） */
  compact?: boolean;
}

/**
 * 运行时间线（D11 · "谁在何时做了什么"）。
 *
 * 纯展示组件：数据由调用方给（运行中心按需 fetch，控制台直接吃 WS 推来的
 * run.events）。不在此处发请求，避免两个入口各自维护一份轮询。
 */
export function RunTimeline({ events, startedAt, running, loading, emptyHint, compact }: RunTimelineProps) {
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [follow, setFollow] = useState(true);
  const [desc, setDesc] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const canvasNodes = useStore((s) => s.nodes);
  const select = useStore((s) => s.select);
  const onCanvas = useMemo(() => new Set(canvasNodes.map((n) => n.id)), [canvasNodes]);

  const stats = useMemo(() => eventStats(events), [events]);
  const shown = useMemo(() => {
    const list = filterEvents(events, filter);
    return desc ? [...list].reverse() : list;
  }, [events, filter, desc]);

  const tail = lastEvent(events);

  // 跟随最新：正序贴底、倒序贴顶，只在运行中且用户没有手动改变滚动位置时生效
  useEffect(() => {
    if (!follow || !running) return;
    const el = bodyRef.current;
    if (!el) return;
    if (desc) el.scrollTo({ top: 0 });
    else el.scrollTo({ top: el.scrollHeight });
  }, [shown.length, follow, running, desc]);

  if (loading) return <div className="tl-empty">正在读取事件记录…</div>;

  if (stats.total === 0) {
    return (
      <div className="tl-empty">
        {emptyHint ?? '这条运行还没有事件记录。'}
        <span className="tl-empty-hint">
          埋点覆盖：运行启动/结束、节点启动与结果、重试、排队等锁、worktree 隔离、人工审批、子运行、终端快照。
        </span>
      </div>
    );
  }

  return (
    <div className={`timeline${compact ? ' compact' : ''}`}>
      <div className="tl-head">
        <span className={`tl-live${running ? ' on' : ''}`} title={running ? '运行中：事件实时追加' : '运行已结束'} />
        <span className="tl-summary">{summarizeTimeline(events)}</span>
        <div className="tl-ops">
          <button
            className={`ghost sm${follow ? ' active' : ''}`}
            title="自动滚动到最新一条"
            onClick={() => setFollow((v) => !v)}
          >
            {follow ? '跟随最新' : '已暂停跟随'}
          </button>
          <button className="ghost sm" title="切换排序" onClick={() => setDesc((v) => !v)}>
            {desc ? '最新在上' : '最早在上'}
          </button>
        </div>
      </div>

      <div className="tl-filters">
        {TIMELINE_FILTERS.map((f) => {
          const n = f.id === 'all' ? stats.total : (stats.counts[f.id] ?? 0);
          return (
            <button
              key={f.id}
              type="button"
              data-type={f.id}
              data-count={n}
              disabled={n === 0}
              className={`tl-chip${filter === f.id ? ' active' : ''}${n === 0 ? ' empty' : ''}`}
              onClick={() => setFilter(f.id)}
              title={n === 0 ? '本次运行没有这类事件' : `只看「${f.label}」`}
            >
              {f.label}
              <em>{n}</em>
            </button>
          );
        })}
      </div>

      {tail && running && (
        <div className="tl-now">
          <span className="tl-icon ev-run">▶</span>
          <span>
            当前：{tail.text}
            {tail.nodeId ? `（${tail.nodeId}）` : ''}
          </span>
        </div>
      )}

      <div className="tl-body" ref={bodyRef}>
        {shown.length === 0 && <div className="tl-empty small">该类别下没有事件。</div>}
        {shown.map((e, i) => {
          const meta = metaOf(e.type);
          const rel = relLabel(e.at, startedAt);
          const clickable = !!e.nodeId && onCanvas.has(e.nodeId);
          return (
            <div className={`tl-row ${meta.cls}`} key={`${e.at}-${e.type}-${e.nodeId ?? ''}-${i}`}>
              <span className="tl-time" title={e.at}>
                {fmtClock(e.at)}
                {rel && <em>{rel}</em>}
              </span>
              <span className={`tl-icon ${meta.cls}`} title={meta.label}>
                {meta.icon}
              </span>
              <div className="tl-main">
                {e.nodeId &&
                  (clickable ? (
                    <button
                      type="button"
                      className="tl-node"
                      title={`选中画布节点 ${e.nodeId}`}
                      onClick={() => select(e.nodeId!)}
                    >
                      {e.nodeId}
                    </button>
                  ) : (
                    <span className="tl-node plain">{e.nodeId}</span>
                  ))}
                <span className="tl-text">{e.text}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
