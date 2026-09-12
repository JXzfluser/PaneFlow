import type { DagGraph } from '@paneflow/shared';

export interface DispatchOptions {
  task: string;
  issueId?: string;
  cwd: string;
  /** 当前空间的模板清单（Planner 从中选择；受理流水线自身会被排除） */
  templateList: { name: string; description?: string }[];
  /** 空间主仓根（给 Planner 的上下文） */
  rootCwd?: string;
}

const MAX_TASK_LEN = 4000;

/**
 * 智能下发：把一句任务描述变成一个三节点临时编排
 *   [Planner 路由决策] → [pipeline 路由执行] → 结束
 * Planner 产出 extra.suggestedTemplate（命中模板）或直接落到
 * builtin-generic-issue-delivery 兜底骨架（task 作为参数传入，动态扇出展开）。
 * 拓扑恒为策展骨架——AI 只选编排与填参（确定性红线 D3）。
 */
export function buildDispatchGraph(opts: DispatchOptions): DagGraph {
  // 防模板引擎注入：剥掉 {{ }} 并限长
  const task = opts.task.replace(/\{\{|\}\}/g, '').trim().slice(0, MAX_TASK_LEN);
  const tplList = opts.templateList
    .map((t) => `- ${t.name}${t.description ? ` —— ${t.description}` : ''}`)
    .join('\n');

  const plannerPrompt = [
    '你是 PaneFlow 的任务下发规划员。用户任务描述：',
    `"""${task}"""`,
    '',
    '当前空间可用的交付模板（ID — 说明）：',
    tplList || '（无）',
    opts.rootCwd ? `空间主仓根：${opts.rootCwd}` : '',
    '',
    '请决策并把结论写入结果文件 .herdr/artifacts/planner.json 的 extra 字段：',
    '1. extra.taskBrief：用一两句话向执行 Agent 清晰重述这个任务（必填）',
    `2. extra.suggestedTemplate：若任务与某个模板高度匹配写其精确 ID；否则写 builtin-generic-issue-delivery（通用交付骨架，会把任务拆解为并行子任务执行）`,
    opts.issueId ? `3. extra.issue_id：${opts.issueId}` : '',
    '4. aligned：写 true（决策完成）',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    version: 1,
    name: `dispatch-${Date.now().toString(36)}`,
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      {
        id: 'planner',
        type: 'agent',
        label: 'Planner · 下发规划',
        config: {
          agentKind: 'claude',
          prompt: plannerPrompt,
          clarify: { maxRounds: 2 },
          retryCount: 1,
          onFail: 'continue', // planner 失败时 route 的兜底模板仍会执行
        },
      },
      {
        id: 'route',
        type: 'pipeline',
        label: '路由执行',
        config: {
          pipeline: {
            template: '{{planner.artifact.extra.suggestedTemplate}}',
            fallbackTemplate: 'builtin-generic-issue-delivery',
            params: { task, ...(opts.issueId ? { issue_id: opts.issueId } : {}), cwd: opts.cwd },
            mode: 'wait',
          },
        },
      },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'd1', source: 'start', target: 'planner' },
      { id: 'd2', source: 'planner', target: 'route' },
      { id: 'd3', source: 'route', target: 'end' },
    ],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      description: `智能下发：${task.slice(0, 80)}`,
    },
  };
}
