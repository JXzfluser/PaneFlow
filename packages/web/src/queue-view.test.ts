import { describe, expect, it } from 'vitest';
import { queuedReasonText, type QueueSnapshot } from './queue-view';

const q = (over: Partial<QueueSnapshot> = {}): QueueSnapshot => ({
  cap: 1,
  running: [{ runId: 'r1', title: '第一条在跑' }],
  queued: [{ runId: 'r2', title: '第二条', position: 1 }],
  ...over,
});

describe('v9-N3 queued 卡渲染条件（锁死）', () => {
  it('有快照：给出占用者标题 + 位次 + 额度', () => {
    const text = queuedReasonText(q(), 'r2');
    expect(text).toContain('并发额度 1');
    expect(text).toContain('「第一条在跑」');
    expect(text).toContain('你排第 1 位');
  });

  it('多个占用者全部列出', () => {
    const text = queuedReasonText(
      q({ cap: 2, running: [{ runId: 'a', title: '甲' }, { runId: 'b', title: '乙' }], queued: [{ runId: 'r2', title: '丙', position: 2 }] }),
      'r2',
    );
    expect(text).toContain('「甲」、「乙」');
    expect(text).toContain('你排第 2 位');
  });

  it('快照未到位/不含本单：仍渲染兜底等待原因，不崩', () => {
    expect(queuedReasonText(null, 'r2')).toContain('排队中');
    expect(queuedReasonText(q(), 'other')).toContain('位次刷新中');
  });

  it('额度将空（running 为空）：不谎称被占满', () => {
    const text = queuedReasonText(q({ running: [] }), 'r2');
    expect(text).not.toContain('已占满');
    expect(text).toContain('你排第 1 位');
  });
});
