import {
  topoSort,
  type DagGraph,
  type DagNode,
  type EdgeCondition,
  type NodeRunRecord,
  type NodeRunState,
} from '@paneflow/shared';

/**
 * DAG → 可读步骤（C 步骤清单视图 / A3 编排预告 共用）。
 *
 * 目的：把「你要画的图」翻译成「系统给你看的清单」——同一份拓扑，两种呈现。
 * 不损失任何语义：依赖 = 步骤顺序，扇出 = 并行，扇入 = 等全部完成，条件边 = 满足条件才执行。
 */

export type StepKind = 'start' | 'agent' | 'parallel' | 'wait' | 'pipeline' | 'end';

export interface Step {
  id: string;
  /** 展示序号（1 起，含首尾） */
  no: number;
  label: string;
  kind: StepKind;
  /** 面向不懂 DAG 的人的一句话说明 */
  note: string;
  /** 上游依赖节点 id */
  deps: string[];
  /** 入边条件断言（条件边）的人话描述 */
  condition?: string;
  /** 运行态（无运行记录时为 undefined = 待执行） */
  state?: NodeRunState;
  /** 该步产出的结论摘要 */
  summary?: string;
  /** 阻塞原因（人工检查 / 审批） */
  blockedPrompt?: string;
  node: DagNode;
}

const KIND_TAG: Record<StepKind, string> = {
  start: '起点',
  agent: 'Agent',
  parallel: '并行',
  wait: '汇总',
  pipeline: '子流水线',
  end: '结束',
};

export function stepKindTag(kind: StepKind): string {
  return KIND_TAG[kind];
}

function oneLine(prompt: string | undefined, max = 46): string {
  if (!prompt) return '';
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function formatCondition(source: string, c: EdgeCondition): string {
  if (!c.field) return `依赖 ${source}`;
  if (c.equals !== undefined) return `${source}.${c.field} = ${c.equals}`;
  if (c.notEquals !== undefined) return `${source}.${c.field} ≠ ${c.notEquals}`;
  if (c.exists) return `${source}.${c.field} 存在`;
  return `依赖 ${source}`;
}

function describe(node: DagNode, deps: DagNode[]): { kind: StepKind; note: string } {
  switch (node.type) {
    case 'start':
      return { kind: 'start', note: '流程起点' };
    case 'end':
      return { kind: 'end', note: '收口结束' };
    case 'fanout':
      return {
        kind: 'parallel',
        note: node.config.expand
          ? `按上游产出的清单动态展开分支（${node.config.expand.from}.${node.config.expand.field}），各分支真实并行`
          : '下游分支真实并行执行',
      };
    case 'fanin': {
      const strict = node.config.requireAll !== false;
      return {
        kind: 'wait',
        note: `等上游 ${deps.length} 条分支全部结束（${strict ? '严格：任一失败则整体失败' : '宽容：允许部分分支失败，用成功分支继续'}）`,
      };
    }
    case 'pipeline':
      return {
        kind: 'pipeline',
        note: node.config.pipeline?.template
          ? `调用子流水线「${node.config.pipeline.template}」${node.config.pipeline.mode === 'fire' ? '（即发即忘）' : '并等待其完成'}`
          : '调用子流水线（具体模板由上游产物决定）',
      };
    default: {
      const who = node.config.role ? `角色「${node.config.role}」` : node.config.agentKind ?? '未配置 Agent';
      const lead = oneLine(node.config.prompt);
      return { kind: 'agent', note: lead ? `${who} · ${lead}` : who };
    }
  }
}

export function deriveSteps(graph: DagGraph, runNodes?: Record<string, NodeRunRecord>): Step[] {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = topoSort(nodes.map((n) => n.id), edges) ?? nodes.map((n) => n.id);

  const steps: Step[] = [];
  let no = 0;
  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    const incoming = edges.filter((e) => e.target === id);
    const deps = incoming.map((e) => e.source).filter((s) => byId.has(s));
    const conditioned = incoming.find((e) => e.condition);
    const condition = conditioned?.condition
      ? formatCondition(conditioned.source, conditioned.condition)
      : undefined;
    const depsNodes = deps.map((d) => byId.get(d)).filter((n): n is DagNode => Boolean(n));
    const { kind, note } = describe(node, depsNodes);
    const rec = runNodes?.[id];
    no += 1;
    steps.push({
      id,
      no,
      label: node.label,
      kind,
      note,
      deps,
      condition,
      state: rec?.state,
      summary: rec?.artifact?.summary,
      blockedPrompt: rec?.blockedPrompt,
      node,
    });
  }
  return steps;
}

/** 「对齐需求 → 拆解任务 → 并行实现 → 汇总 → 验收核对 → 归档收口」 */
export function summarizeSteps(steps: Step[]): string {
  const core = steps.filter((s) => s.kind !== 'start' && s.kind !== 'end');
  const parts: string[] = [];
  core.forEach((s, i) => {
    if (s.kind === 'parallel') {
      // 下一步名字里已经带「并行」时就不重复说
      if (/并行/.test(core[i + 1]?.label ?? '')) return;
      parts.push('并行');
      return;
    }
    if (s.kind === 'wait') {
      parts.push('汇总');
      return;
    }
    if (parts[parts.length - 1] === s.label) return;
    parts.push(s.label);
  });
  return parts.join(' → ');
}

/** 是否含并行分支（用于「共 N 步 · 含并行分支」的概括） */
export function hasParallel(steps: Step[]): boolean {
  return steps.some((s) => s.kind === 'parallel');
}

/** 该步是否属于并行分支（上游是 fanout） */
export function isParallelBranch(step: Step, steps: Step[]): boolean {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return step.deps.some((d) => byId.get(d)?.kind === 'parallel');
}

/** 运行态 → 展示文案与色标 class（.step-state.<cls>） */
export function stateLabel(state: NodeRunState | undefined): { text: string; cls: string } {
  switch (state) {
    case 'done':
      return { text: '已完成', cls: 'done' };
    case 'working':
    case 'starting':
      return { text: '进行中', cls: 'working' };
    case 'blocked':
      return { text: '待处理', cls: 'blocked' };
    case 'paused':
      return { text: '审批暂停（重启）', cls: 'blocked' };
    case 'failed':
      return { text: '失败', cls: 'failed' };
    case 'retrying':
      return { text: '重试中', cls: 'working' };
    case 'queued':
    case 'pending':
      return { text: '等待中', cls: 'idle' };
    case 'skipped':
      return { text: '已跳过', cls: 'idle' };
    case 'cancelled':
      return { text: '已取消', cls: 'idle' };
    default:
      return { text: '待执行', cls: 'idle' };
  }
}
