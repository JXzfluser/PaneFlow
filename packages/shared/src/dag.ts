import type { AgentStatus } from './states.js';

// ---------------------------------------------------------------------------
// DAG model — the single source of truth for both canvas (web) and orchestrator
// ---------------------------------------------------------------------------

export type DagNodeType = 'start' | 'agent' | 'fanout' | 'fanin' | 'end';

export interface DagNodeConfig {
  /** 全局角色库的角色 id（继承 agentKind 默认与 prePrompt） */
  role?: string;
  /** Herdr agent kind, e.g. claude | codex | opencode | pi | kimi ... */
  agentKind?: string;
  /** Extra argv passed to the agent after `--` at `agent start` */
  agentArgs?: string[];
  /**
   * Prompt template. Supports `{{nodeId.artifact.field}}` interpolation from
   * the blackboard and `{{nodeId.output}}` for upstream terminal snapshot.
   */
  prompt?: string;
  /** Working directory for this node's pane; empty = pipeline default cwd */
  cwd?: string;
  /** done 后检查门禁（全部通过才算完成；对齐 flow-engine 检查语义） */
  checks?: CheckSpec[];
  /**
   * 澄清循环（grilling 编排化）：节点完成后读取 artifact.aligned；非 'true' 时
   * 进入问答回合（审批卡片展示 extra.questions），人类回答作为补充指令再跑一轮，
   * 直到 aligned=true（approve=强制放行）或轮次耗尽。
   */
  clarify?: { maxRounds?: number };
  /** Retries before the node is considered failed (default 0) */
  retryCount?: number;
  /** Hard per-node execution timeout in ms (0 = unlimited) */
  timeoutMs?: number;
  /** Failure policy for this node (default 'abort') */
  onFail?: 'abort' | 'continue';
  /**
   * Fan-in barrier policy: when true (default), any failed incoming branch
   * fails the merge node; when false, the merge proceeds with whichever
   * branches finished successfully.
   */
  requireAll?: boolean;
  /**
   * Key sequence to send when the agent hits a `blocked` approval UI.
   * Default: ['enter'] to approve, ['ctrl+c'] to reject is offered separately
   * by the approval card UI.
   */
  approveKeys?: string[];
  /** Result-file path relative to the node cwd (default '.herdr/artifact.json') */
  artifactFile?: string;
}

export type CheckSpec =
  | { type: 'file-exists'; path: string }
  | { type: 'command'; run: string; timeoutMs?: number }
  | { type: 'regex'; file: string; pattern: string }
  | { type: 'manual'; prompt: string };

export interface DagNode {
  id: string;
  type: DagNodeType;
  label: string;
  /** Canvas position (React Flow coordinates) */
  position?: { x: number; y: number };
  config: DagNodeConfig;
}

export interface DagEdge {
  id: string;
  source: string;
  target: string;
  /**
   * 条件边：对上游节点 artifact 的断言，运行时不满足即剪枝（下游按依赖缺失处理）。
   * field 支持 artifact 深层路径（如 aligned / extra.status）。
   */
  condition?: EdgeCondition;
}

export interface EdgeCondition {
  field: string;
  equals?: string;
  notEquals?: string;
  /** 字段存在即通过 */
  exists?: boolean;
}

export interface DagGraph {
  version: 1;
  name: string;
  nodes: DagNode[];
  edges: DagEdge[];
  metadata: {
    createdAt: string;
    updatedAt: string;
    description?: string;
  };
  /** Declared run-time parameters (rendered into all string fields before execution) */
  variables?: TemplateVariable[];
}

export interface TemplateVariable {
  key: string;
  label: string;
  required?: boolean;
  default?: string;
}

// ---------------------------------------------------------------------------
// Blackboard artifact — structured hand-off produced per finished agent node
// ---------------------------------------------------------------------------

export interface Artifact {
  /** Free-form conclusion text the agent was asked to write out */
  summary?: string;
  /** Files the agent reports having created/modified (absolute or cwd-relative) */
  files?: string[];
  /** Errors / failures the agent reports */
  errors?: string[];
  /** Anything else, agent-defined */
  extra?: Record<string, unknown>;
  /** 澄清循环约定字段：'true' 表示已对齐（Agent 按结果约定写入） */
  aligned?: string;
  /** Raw terminal output snapshot at completion (fallback when file missing) */
  outputTail?: string;
  /** Whether this artifact came from the result file or the output fallback */
  source: 'file' | 'output-fallback' | 'empty';
  finishedAt: string;
}

// ---------------------------------------------------------------------------
// Run state — what the orchestrator persists and pushes to the canvas
// ---------------------------------------------------------------------------

export type NodeRunState =
  | 'pending'
  | 'queued'
  | 'starting'
  | 'working'
  | 'blocked'
  | 'retrying'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface NodeRunRecord {
  nodeId: string;
  state: NodeRunState;
  /** manual 检查的提问文本（审批卡片展示） */
  blockedPrompt?: string;
  paneId?: string;
  agentName?: string;
  agentStatus?: AgentStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  artifact?: Artifact;
  error?: string;
}

export type RunState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunRecord {
  runId: string;
  dagName: string;
  /** 关联需求 Issue（可检索/展示） */
  issueId?: string;
  graph: DagGraph;
  state: RunState;
  cwd: string;
  /** Owning Space (multi-project isolation) */
  spaceId?: string;
  workspaceId?: string;
  nodes: Record<string, NodeRunRecord>;
  startedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Validation + topological utilities (shared by canvas and orchestrator)
// ---------------------------------------------------------------------------

export interface DagIssue {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

const AGENT_KIND_PATTERN = /^[a-z][a-z0-9_-]*$/;
const NODE_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export function validateDag(graph: DagGraph): DagIssue[] {
  const issues: DagIssue[] = [];
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (nodes.length === 0) {
    issues.push({ level: 'error', message: '画布为空：至少需要一个开始节点' });
    return issues;
  }

  // id uniqueness & format
  for (const n of nodes) {
    if (!NODE_ID_PATTERN.test(n.id)) {
      issues.push({
        level: 'error',
        message: `节点 ID 非法（需以字母开头，仅含字母/数字/-/_，≤64 字符）：${n.id || '(空)'}`,
        nodeId: n.id,
      });
    }
  }
  const dup = [...byId.keys()].length !== nodes.length;
  if (dup) {
    issues.push({ level: 'error', message: '存在重复的节点 ID' });
  }

  // edges reference existing nodes, no self loops, no duplicate edges
  const seen = new Set<string>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      issues.push({
        level: 'error',
        message: `连线引用了不存在的节点：${e.source} → ${e.target}`,
      });
      continue;
    }
    if (e.source === e.target) {
      issues.push({ level: 'error', message: `不允许自环连线：${e.source}`, nodeId: e.source });
    }
    const key = `${e.source}->${e.target}`;
    if (seen.has(key)) {
      issues.push({ level: 'warning', message: `重复连线：${key}` });
    }
    seen.add(key);
  }

  // start / end exactly once, agent node sanity
  const starts = nodes.filter((n) => n.type === 'start');
  const ends = nodes.filter((n) => n.type === 'end');
  if (starts.length !== 1) {
    issues.push({ level: 'error', message: `开始节点必须有且仅有一个（当前 ${starts.length} 个）` });
  }
  if (ends.length > 1) {
    issues.push({ level: 'error', message: `结束节点最多一个（当前 ${ends.length} 个）` });
  }
  for (const n of nodes) {
    if (n.type === 'agent') {
      if (!n.config.agentKind || !AGENT_KIND_PATTERN.test(n.config.agentKind)) {
        issues.push({ level: 'error', message: `Agent 节点缺少合法的 agentKind：${n.label}`, nodeId: n.id });
      }
      if (!n.config.prompt || !n.config.prompt.trim()) {
        issues.push({ level: 'error', message: `Agent 节点缺少任务指令（prompt）：${n.label}`, nodeId: n.id });
      }
    }
    if ((n.type === 'start' || n.type === 'end') && (n.config.prompt || n.config.agentKind)) {
      issues.push({
        level: 'warning',
        message: `${n.type} 节点不应配置 prompt/agentKind：${n.label}`,
        nodeId: n.id,
      });
    }
  }

  // cycle detection + reachability via Kahn's algorithm
  const order = topoSort(nodes.map((n) => n.id), edges);
  if (order === null) {
    issues.push({ level: 'error', message: '图中存在环，DAG 必须无环' });
  } else if (starts.length === 1) {
    // unreachable-from-start check
    const reach = new Set<string>();
    const stack = [starts[0]!.id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (reach.has(cur)) continue;
      reach.add(cur);
      for (const e of edges) if (e.source === cur && !reach.has(e.target)) stack.push(e.target);
    }
    for (const n of nodes) {
      if (!reach.has(n.id)) {
        issues.push({ level: 'error', message: `节点不可从开始节点到达：${n.label}`, nodeId: n.id });
      }
    }
  }

  return issues;
}

/** Kahn topological order; null when a cycle exists. */
export function topoSort(nodeIds: string[], edges: DagEdge[]): string[] | null {
  const indeg = new Map(nodeIds.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const queue = nodeIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of adj.get(id) ?? []) {
      const left = (indeg.get(t) ?? 0) - 1;
      indeg.set(t, left);
      if (left === 0) queue.push(t);
    }
  }
  return order.length === nodeIds.length ? order : null;
}

/** All nodes that feed into `nodeId` (direct predecessors). */
export function upstreamOf(nodeId: string, edges: DagEdge[]): string[] {
  return edges.filter((e) => e.target === nodeId).map((e) => e.source);
}

// ---------------------------------------------------------------------------
// Prompt template interpolation: {{nodeId.artifact.summary}} / {{nodeId.output}}
// ---------------------------------------------------------------------------

const TEMPLATE_REF = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*(?:\.\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*)?\}\}/g;

export function renderPromptTemplate(
  template: string,
  resolve: (nodeId: string, path: string | undefined) => string | undefined,
): string {
  return template.replace(TEMPLATE_REF, (whole, nodeId: string, path?: string) => {
    const value = resolve(nodeId, path);
    return value === undefined ? whole : value;
  });
}

// ---------------------------------------------------------------------------
// Template variables: declared run-time parameters, substituted before any
// blackboard rendering. `{{key}}` is replaced in every string field of the
// graph (prompts, cwd, labels, descriptions). Declared variables take
// precedence — node artifact references use `{{nodeId.field}}` and never
// collide because variable keys must not match node ids (validated below).
// ---------------------------------------------------------------------------

export function applyVariables(
  graph: DagGraph,
  values: Record<string, string> | undefined,
): { graph: DagGraph; missing: string[] } {
  const declared = graph.variables ?? [];
  const missing = declared.filter((v) => v.required && !values?.[v.key]).map((v) => v.label || v.key);
  const clone: DagGraph = structuredClone(graph);
  if (!declared.length || missing.length) return { graph: clone, missing };

  const resolved: Record<string, string> = {};
  for (const v of declared) {
    resolved[v.key] = values?.[v.key] ?? v.default ?? '';
  }
  const substitute = (s: string): string =>
    s.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g, (whole, key: string) =>
      key in resolved ? resolved[key]! : whole,
    );
  const walk = (o: unknown): unknown => {
    if (typeof o === 'string') return substitute(o);
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) out[k] = walk(v);
      return out;
    }
    return o;
  };
  return { graph: walk(clone) as DagGraph, missing };
}
