import { describe, expect, it } from 'vitest';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import { boardLiveView, runningMinutes } from './board-live.js';

const graph: DagGraph = {
  version: 1,
  name: 'b',
  nodes: [
    { id: 'impl', type: 'agent', label: '并行实现', config: {} },
    { id: 'rev', type: 'agent', label: '验收核对', config: {} },
  ],
  edges: [],
  metadata: { createdAt: '', updatedAt: '' },
};

function stub(partial: Partial<RunRecord>): RunRecord {
  return { graph, ...partial } as unknown as RunRecord;
}

const NOW = new Date('2026-10-11T10:00:00.000Z').getTime();

describe('v19-R8 看板卡取数层（纯读 store 既有 run）', () => {
  it('在跑一句话：标签+时长；>2 格给合计数', () => {
    const v = boardLiveView(
      stub({
        state: 'running',
        nodes: {
          impl: { nodeId: 'impl', state: 'working', attempts: 1, startedAt: '2026-10-11T09:57:00.000Z' },
          rev: { nodeId: 'rev', state: 'starting', attempts: 1 },
        },
      }),
      NOW,
    );
    expect(v.nowLine).toBe('在跑：并行实现（已 3 分） · 验收核对（时长不可考）');
  });

  it('门在卡上：第一道门点名，多道门给计数', () => {
    const v = boardLiveView(
      stub({
        state: 'running',
        nodes: {
          impl: { nodeId: 'impl', state: 'blocked', attempts: 1, blockedPrompt: '要推送吗' },
          rev: { nodeId: 'rev', state: 'blocked', attempts: 1 },
        },
      }),
      NOW,
    );
    expect(v.gate!.nodeId).toBe('impl');
    expect(v.gate!.label).toBe('并行实现');
    expect(v.gate!.ask).toBe('等你批：并行实现 等 2 道门');
  });

  it('最后三笔事件：原样取尾，不加工文本', () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ at: `2026-10-11T09:0${i}:00.000Z`, type: 'node' as const, text: `动静${i}` }));
    const v = boardLiveView(stub({ state: 'running', nodes: {}, events }), NOW);
    expect(v.lines.map((l) => l.text)).toEqual(['动静2', '动静3', '动静4']);
  });

  it('动静账：events 空数组且还在跑=「还没落账」；events 缺键不冒充', () => {
    expect(boardLiveView(stub({ state: 'running', nodes: {}, events: [] }), NOW).quiet).toBe(true);
    expect(boardLiveView(stub({ state: 'running', nodes: {} }), NOW).quiet).toBe(false);
  });

  it('runningMinutes：不可考明说，不把猜测画成读数', () => {
    expect(runningMinutes(undefined, NOW)).toBe('时长不可考');
    expect(runningMinutes('not-a-date', NOW)).toBe('时长不可考');
    expect(runningMinutes('2026-10-11T09:59:40.000Z', NOW)).toBe('刚开始');
    expect(runningMinutes('2026-10-11T09:30:00.000Z', NOW)).toBe('已 30 分');
  });
});
