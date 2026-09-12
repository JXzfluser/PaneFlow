import { describe, expect, it } from 'vitest';
import type { DagGraph, NodeRunRecord } from '@paneflow/shared';
import { deriveSteps, isParallelBranch, stateLabel, summarizeSteps } from './steps.js';
import { templateLabel } from './template-labels.js';

/** 交付骨架的骨架化版本：start → align → plan → fork → impl → merge → verify → end */
function deliveryLikeGraph(): DagGraph {
  const agent = (id: string, label: string) => ({
    id,
    type: 'agent' as const,
    label,
    config: { agentKind: 'claude', prompt: `做 ${label} 这件事，写清楚结论。` },
  });
  return {
    version: 1,
    name: 'test-delivery',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      agent('align', '对齐需求'),
      agent('plan', '拆解任务'),
      { id: 'fork', type: 'fanout', label: '并行展开', config: {} },
      agent('impl', '并行实现'),
      { id: 'merge', type: 'fanin', label: '汇总验证', config: {} },
      agent('verify', '验收核对'),
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'align' },
      { id: 'e2', source: 'align', target: 'plan', condition: { field: 'aligned', equals: 'true' } },
      { id: 'e3', source: 'plan', target: 'fork' },
      { id: 'e4', source: 'fork', target: 'impl' },
      { id: 'e5', source: 'impl', target: 'merge' },
      { id: 'e6', source: 'merge', target: 'verify' },
      { id: 'e7', source: 'verify', target: 'end' },
    ],
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  };
}

describe('deriveSteps（DAG → 可读步骤）', () => {
  it('按拓扑序产出每一步，并识别并行 / 汇总结构', () => {
    const steps = deriveSteps(deliveryLikeGraph());
    expect(steps.map((s) => s.id)).toEqual([
      'start',
      'align',
      'plan',
      'fork',
      'impl',
      'merge',
      'verify',
      'end',
    ]);
    expect(steps.map((s) => s.kind)).toEqual([
      'start',
      'agent',
      'agent',
      'parallel',
      'agent',
      'wait',
      'agent',
      'end',
    ]);
    const impl = steps.find((s) => s.id === 'impl')!;
    expect(isParallelBranch(impl, steps)).toBe(true);
    expect(steps.find((s) => s.id === 'merge')!.note).toContain('严格');
  });

  it('条件边被翻译成人话，而不是丢掉', () => {
    const steps = deriveSteps(deliveryLikeGraph());
    expect(steps.find((s) => s.id === 'plan')!.condition).toBe('align.aligned = true');
  });

  it('挂上运行记录后带上状态与产物摘要', () => {
    const runNodes: Record<string, NodeRunRecord> = {
      align: {
        nodeId: 'align',
        state: 'done',
        attempts: 1,
        artifact: {
          summary: '需求已对齐：3 条验收断言',
          source: 'file',
          finishedAt: '2026-01-01T00:01:00.000Z',
        },
      },
      impl: { nodeId: 'impl', state: 'blocked', attempts: 1, blockedPrompt: '需要你确认放行' },
    };
    const steps = deriveSteps(deliveryLikeGraph(), runNodes);
    const align = steps.find((s) => s.id === 'align')!;
    expect(align.state).toBe('done');
    expect(align.summary).toBe('需求已对齐：3 条验收断言');
    const impl = steps.find((s) => s.id === 'impl')!;
    expect(impl.state).toBe('blocked');
    expect(impl.blockedPrompt).toBe('需要你确认放行');
    // 没跑过的步骤仍然是"待执行"
    expect(steps.find((s) => s.id === 'verify')!.state).toBeUndefined();
  });

  it('空图不炸，返回空清单', () => {
    const empty: DagGraph = {
      version: 1,
      name: 'empty',
      nodes: [],
      edges: [],
      metadata: { createdAt: '', updatedAt: '' },
    };
    expect(deriveSteps(empty)).toEqual([]);
  });
});

describe('summarizeSteps（一句话概括）', () => {
  it('首尾不计，扇出紧跟"并行实现"时不重复说"并行"', () => {
    const steps = deriveSteps(deliveryLikeGraph());
    expect(summarizeSteps(steps)).toBe('对齐需求 → 拆解任务 → 并行实现 → 汇总 → 验收核对');
  });
});

describe('stateLabel', () => {
  it('运行态映射到中文与色标 class', () => {
    expect(stateLabel('done')).toEqual({ text: '已完成', cls: 'done' });
    expect(stateLabel('blocked')).toEqual({ text: '待处理', cls: 'blocked' });
    expect(stateLabel(undefined)).toEqual({ text: '待执行', cls: 'idle' });
  });
});

describe('templateLabel（内置模板中文化）', () => {
  it('内置模板给中文名与用途', () => {
    const l = templateLabel('builtin-generic-issue-delivery');
    expect(l.title).toBe('通用交付骨架');
    expect(l.use).toContain('对齐需求');
  });

  it('用户模板回退为自己起的名字（不再 slug 化英文）', () => {
    expect(templateLabel('我的交付流程').title).toBe('我的交付流程');
    expect(templateLabel('my-flow', '说明').title).toBe('my flow');
    expect(templateLabel('my-flow', '说明').use).toBe('说明');
  });
});
