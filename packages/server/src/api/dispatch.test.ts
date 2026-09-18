import { describe, expect, it } from 'vitest';
import { buildDispatchGraph } from './dispatch.js';
import { BUILTIN_TEMPLATES } from '../orchestrate/builtin-templates.js';
import { applyVariables, validateDag } from '@paneflow/shared';

describe('buildDispatchGraph', () => {
  const templateList = [
    { name: 'builtin-bug-fix-pipeline', description: '修复型' },
    { name: 'builtin-generic-issue-delivery', description: '交付型兜底' },
  ];

  it('generates a valid 3-node orchestration embedding the task', () => {
    const g = buildDispatchGraph({ task: '探索项目成熟度并建 Issue', cwd: '/tmp/x', templateList });
    expect(validateDag(g).filter((i) => i.level === 'error')).toEqual([]);
    expect(g.nodes.map((n) => n.type)).toEqual(['start', 'agent', 'pipeline', 'end']);
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.prompt).toContain('探索项目成熟度并建 Issue');
    expect(planner.config.prompt).toContain('builtin-generic-issue-delivery');
    // 路由参数携带原始任务（兜底骨架经 variables.task 接收）
    const route = g.nodes.find((n) => n.id === 'route')!;
    expect(route.config.pipeline!.params!.task).toBe('探索项目成熟度并建 Issue');
    expect(route.config.pipeline!.fallbackTemplate).toBe('builtin-generic-issue-delivery');
  });

  it('strips template-injection braces from the task', () => {
    const g = buildDispatchGraph({ task: '做 {{evil}} 事', cwd: '/tmp/x', templateList });
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.prompt).not.toContain('{{evil}}');
    expect(planner.config.prompt).toContain('evil');
  });

  it('caps oversized task input', () => {
    const g = buildDispatchGraph({ task: 'x'.repeat(9999), cwd: '/tmp/x', templateList });
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.prompt!.length).toBeLessThan(6000);
  });

  it('task survives variable pass-through to the route params', () => {
    const g = buildDispatchGraph({ task: 'demo 任务', issueId: '9', cwd: '/tmp/x', templateList });
    // 下发 run 启动时 applyVariables(graph, {task}) 不破坏结构
    const { graph: applied } = applyVariables(g, { task: 'demo 任务' });
    expect(applied.nodes.length).toBe(g.nodes.length);
    expect(validateDag(applied).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('route params keys are declared variables of the fallback template (G: 静默丢弃防线)', () => {
    // applyVariables 只替换模板已声明的变量——params 传了未声明的键会被静默丢掉
    const g = buildDispatchGraph({ task: 't', issueId: '9', cwd: '/tmp/x', templateList });
    const route = g.nodes.find((n) => n.id === 'route')!;
    const generic = BUILTIN_TEMPLATES.find((t) => t.name === route.config.pipeline!.fallbackTemplate)!;
    const declared = new Set((generic.variables ?? []).map((v) => v.key));
    declared.add('cwd'); // params.cwd 走 startRun 第三参，不是模板变量
    for (const key of Object.keys(route.config.pipeline!.params!)) {
      expect(declared.has(key), `兜底模板未声明参数 ${key}，会被静默丢弃`).toBe(true);
    }
    expect(declared.has('task')).toBe(true);
  });
});
