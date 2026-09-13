import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@paneflow/shared';
import {
  EVENT_META,
  UNKNOWN_META,
  eventStats,
  filterEvents,
  fmtClock,
  lastEvent,
  metaOf,
  relLabel,
  summarizeTimeline,
} from './timeline.js';

function ev(type: RunEvent['type'], at: string, text: string, nodeId?: string): RunEvent {
  return nodeId ? { at, type, nodeId, text } : { at, type, text };
}

/** 一份典型的运行事件序列（含一条极端情况：未知类型）。 */
const seq: RunEvent[] = [
  ev('run', '2026-09-12T01:00:00.000Z', '运行启动：交付骨架（7 个节点）'),
  ev('node', '2026-09-12T01:00:01.000Z', '节点启动：准备终端 Pane 与 Agent', 'align'),
  ev('node', '2026-09-12T01:00:12.000Z', '指令已提交', 'align'),
  ev('approval', '2026-09-12T01:01:00.000Z', '人工检查：确认 Issue 正文已回写', 'align'),
  ev('child', '2026-09-12T01:02:00.000Z', '启动子运行 run-abc（模板 builtin-x）', 'fork'),
  ev('snapshot', '2026-09-12T01:03:00.000Z', '采集终端输出快照（3/12）', 'align'),
  ev('node', '2026-09-12T01:03:30.000Z', 'done', 'impl-1'),
  { at: '2026-09-12T01:04:00.000Z', type: 'future' as RunEvent['type'], text: '引擎将来新增的事件' },
];

describe('timeline · 事件元信息', () => {
  it('五类事件都有图标/中文名/配色类', () => {
    for (const t of ['run', 'node', 'child', 'approval', 'snapshot'] as const) {
      const m = EVENT_META[t];
      expect(m.icon).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.cls).toMatch(/^ev-/);
    }
  });

  it('未知类型回退到兜底元信息，不抛出', () => {
    expect(metaOf('future')).toEqual(UNKNOWN_META);
    expect(metaOf('')).toEqual(UNKNOWN_META);
  });
});

describe('timeline · 统计', () => {
  const st = eventStats(seq);

  it('总条数与分类计数正确', () => {
    expect(st.total).toBe(8);
    expect(st.counts.run).toBe(1);
    expect(st.counts.node).toBe(3);
    expect(st.counts.approval).toBe(1);
    expect(st.counts.child).toBe(1);
    expect(st.counts.snapshot).toBe(1);
  });

  it('节点数按去重 nodeId 统计（无 nodeId 的运行级事件不计入）', () => {
    // align / fork / impl-1
    expect(st.nodes).toBe(3);
    expect(st.hasApproval).toBe(true);
  });

  it('空输入不炸', () => {
    expect(eventStats(undefined)).toEqual({ total: 0, counts: {}, nodes: 0, hasApproval: false });
    expect(eventStats([])).toEqual({ total: 0, counts: {}, nodes: 0, hasApproval: false });
  });
});

describe('timeline · 过滤', () => {
  it('all 原样返回并保持时间顺序', () => {
    const r = filterEvents(seq, 'all');
    expect(r).toHaveLength(seq.length);
    expect(r[0]).toBe(seq[0]);
  });

  it('按类别过滤只保留该类', () => {
    const nodes = filterEvents(seq, 'node');
    expect(nodes).toHaveLength(3);
    expect(nodes.every((e) => e.type === 'node')).toBe(true);
    expect(filterEvents(seq, 'approval')).toHaveLength(1);
    expect(filterEvents(seq, 'child')).toHaveLength(1);
    expect(filterEvents(seq, 'snapshot')).toHaveLength(1);
    expect(filterEvents(seq, 'run')).toHaveLength(1);
  });

  it('空输入返回空数组', () => {
    expect(filterEvents(undefined, 'node')).toEqual([]);
  });
});

describe('timeline · 时间格式', () => {
  it('绝对时间按本地时钟渲染为 HH:MM:SS', () => {
    const d = new Date(2026, 8, 12, 9, 5, 3);
    expect(fmtClock(d.toISOString())).toBe('09:05:03');
  });

  it('非法时间戳给占位符而不是 Invalid Date', () => {
    expect(fmtClock('not-a-date')).toBe('--:--:--');
    expect(fmtClock('')).toBe('--:--:--');
  });

  it('相对时间：秒/分/时三档', () => {
    const base = '2026-09-12T01:00:00.000Z';
    expect(relLabel('2026-09-12T01:00:12.000Z', base)).toBe('+12s');
    expect(relLabel('2026-09-12T01:01:04.000Z', base)).toBe('+1m04s');
    expect(relLabel('2026-09-12T02:02:00.000Z', base)).toBe('+1h02m');
  });

  it('缺少起点/时间早于起点/时间非法时返回空串（UI 只显示绝对时间）', () => {
    const base = '2026-09-12T01:00:00.000Z';
    expect(relLabel(base, undefined)).toBe('');
    expect(relLabel('2026-09-12T00:59:00.000Z', base)).toBe('');
    expect(relLabel('bad', base)).toBe('');
    expect(relLabel(base, 'bad')).toBe('');
  });

  it('起点为 0 秒时显示 +0s', () => {
    const base = '2026-09-12T01:00:00.000Z';
    expect(relLabel(base, base)).toBe('+0s');
  });
});

describe('timeline · 摘要与末条', () => {
  it('摘要包含条数/节点数/审批/子运行', () => {
    const s = summarizeTimeline(seq);
    expect(s).toContain('8 条事件');
    expect(s).toContain('覆盖 3 个节点');
    expect(s).toContain('1 次人工审批');
    expect(s).toContain('1 次子运行');
  });

  it('空时间线摘要为「暂无事件」', () => {
    expect(summarizeTimeline(undefined)).toBe('暂无事件');
    expect(summarizeTimeline([])).toBe('暂无事件');
  });

  it('没有审批/子运行时不出现对应片段', () => {
    const s = summarizeTimeline([ev('run', '2026-09-12T01:00:00.000Z', '运行启动')]);
    expect(s).toBe('1 条事件');
  });

  it('末条事件是最新的一条', () => {
    expect(lastEvent(seq)).toBe(seq[seq.length - 1]);
    expect(lastEvent([])).toBeNull();
    expect(lastEvent(undefined)).toBeNull();
  });
});
