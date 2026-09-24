import type { AgentStatus } from './states.js';

// ---------------------------------------------------------------------------
// DAG model — the single source of truth for both canvas (web) and orchestrator
// ---------------------------------------------------------------------------

export const DAG_NODE_TYPES = ['start', 'agent', 'fanout', 'fanin', 'pipeline', 'end'] as const;
export type DagNodeType = (typeof DAG_NODE_TYPES)[number];

/** 动态扇出一律有顶：无上限 = 上游产物里 N 条数组无声放大成 N 个并发 agent（烧配额 + 挤爆 pane） */
export const FANOUT_MAX_ITEMS_LIMIT = 64;

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
   * 节点级环境变量（注入该节点的 pane）：
   * 典型用途是把 Agent 指向模型网关（如 ANTHROPIC_BASE_URL/OPENAI_API_BASE
   * 指向 LiteLLM / OmniRoute，实现代理与自动换模型）。
   * 合并顺序：全局 PF_PANE_ENV < 角色默认 < 节点。
   */
  env?: Record<string, string>;
  /** pipeline 子流水线调用（type='pipeline' 专用） */
  pipeline?: {
    /** 目标模板名（支持 {{上游.artifact.*}} 插值，如受理节点建议的模板名） */
    template?: string;
    /** 模板不存在时的兜底模板名 */
    fallbackTemplate?: string;
    /** 传给子运行的参数（值支持插值） */
    params?: Record<string, string>;
    /** wait=等子运行完成并镜像状态；fire=即发即忘 */
    mode?: 'wait' | 'fire';
  };
  /**
   * 动态扇出（fanout 节点专用）：完成后从上游 artifact 的数组字段展开，
   * 为每个元素克隆本节点的直接后继（分支模板），克隆节点内可用 {{item.*}}。
   */
  expand?: {
    from: string;
    field: string;
    /** 数组缺失/为空时的行为：fallback=回退单分支交付（默认），fail=节点失败 */
    onEmpty?: 'fallback' | 'fail';
    /** 分支上限（1..FANOUT_MAX_ITEMS_LIMIT）；省略=用硬顶。超出即节点失败，绝不静默截断 */
    maxItems?: number;
  };
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
  /** Result-file path relative to the node cwd (default: per-node `.herdr/artifacts/<nodeId>.json`) */
  artifactFile?: string;
}

export type CheckSpec =
  | { type: 'file-exists'; path: string }
  | { type: 'command'; run: string; timeoutMs?: number }
  | { type: 'regex'; file: string; pattern: string }
  | { type: 'manual'; prompt: string }
  /**
   * M1 契约接单门：产物 extra.contract（候选断言+澄清提问）必须人工批准才放下游。
   * M6：template=id@sha 为门放行时给契约盖的「按哪版骨架干的」审计戳。
   */
  | { type: 'contract'; template?: string }
  /**
   * H1 分支守卫（引擎侧真约束，不靠提示词）：push 前用 git rev-parse 核验节点工作区
   * HEAD 在交付分支上（缺省期望 pf/<runId>）。不符 → blocked 不静默；
   * HEAD 是 main/master → 直接失败——守卫生与提示词两侧都不给「推默认分支」留路径。
   */
  | { type: 'delivery-branch'; expectBranch?: string };

/**
 * v13-V0 值域白名单（校验器 fail-closed 的判据源）。过去两处都不查值：
 * 未知 node.type 在引擎里走「结构标记」路直接标 done，未知 checks[].type 在检查循环里没有分支命中
 * = 静默通过——两条都是把配置打错念成验收通过的最便宜假绿。
 */
export const CHECK_SPEC_TYPES = [
  'file-exists',
  'command',
  'regex',
  'manual',
  'contract',
  'delivery-branch',
] as const satisfies readonly CheckSpec['type'][];
export type CheckSpecType = (typeof CHECK_SPEC_TYPES)[number];
// 双向锁死：CheckSpec 联合里新增一类而这里漏登记 → 类型不满足 never，编译即红
const _checkSpecTypesCovered: Record<Exclude<CheckSpec['type'], CheckSpecType>, never> = {};
void _checkSpecTypesCovered;

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
  /** Anything else, agent-defined.
   * 验收断言约定：extra.acceptance —— align 节点产物，验收断言列表
   * `[{ id, assertion, verify_method }]`（AcceptanceAssertion[]），供引擎/下游机器消费；
   * extra.assertionResults —— 下游 impl/verify 逐条核对结果
   * `[{ id, status: 'ok'|'fail'|'n/a', evidence }]`（AcceptanceResult[]）。 */
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
// Acceptance — 验收断言（align 注入）与逐条核对结果（impl/verify 回写）
// ---------------------------------------------------------------------------

/** 验收断言：align 节点从需求「验收标准」小节提炼并注入编号断言面 AC-N */
export interface AcceptanceAssertion {
  /** 断言编号，如 AC-1（同一 list 内唯一） */
  id: string;
  /** 可验证断言文本 */
  assertion: string;
  /** 验证方法（人工/AI 如何核实） */
  verify_method: string;
}

/** 验收断言核对结果：下游节点逐条回写至 extra.assertionResults */
export interface AcceptanceResult {
  id: string;
  status: 'ok' | 'fail' | 'n/a';
  /** 核对证据：实测输出、截图、日志摘录等，供人工/下游复核 */
  evidence: string;
}

/**
 * 从节点产物的 extra.assertionResults 里筛出未通过的断言（F1 验收机器门）。
 * status 非 'ok' 且非 'n/a' 一律视为失败（缺失/非法 status 不放行）。
 */
export function failedAssertionsOf(extra: Record<string, unknown> | undefined): AcceptanceResult[] {
  const list = extra?.assertionResults;
  if (!Array.isArray(list)) return [];
  const out: AcceptanceResult[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<AcceptanceResult>;
    if (typeof r.id !== 'string') continue;
    if (r.status !== 'ok' && r.status !== 'n/a') {
      out.push({ id: r.id, status: 'fail', evidence: typeof r.evidence === 'string' ? r.evidence : '' });
    }
  }
  return out;
}

/**
 * M1 契约对象：候选验收断言 + 澄清提问。规划/align 节点写入 extra.contract，
 * 契约接单门（check type 'contract'）消费——契约未确认，下游一律不派。
 */
export interface ContractDoc {
  assertions: AcceptanceAssertion[];
  questions: string[];
  /** 范围边界：本次不动哪些文件/模块（自由文本，人读 also 机读） */
  scopeNotes?: string;
  /**
   * 预算上限。token 维度 v12-S2 起有执行点（节点尝试启动前查 run.costLive，超限熔断）；
   * maxMinutes 仍只记账展示——时长维已有节点 timeoutMs 缺省 30min 硬顶先例，本片不做。
   */
  budget?: { maxMinutes?: number; maxTokens?: number };
  /** 目标仓 / 分支（H1 交付守卫的锚点） */
  repo?: string;
  branch?: string;
}

/**
 * M2 run 一等公民契约：持久化在 RunRecord 上的首个结构化产物。
 * F1 验收机器门、H1 交付守卫、预算顶都引用同一份契约——三处约束是它的三个执行点。
 */
export interface RunContract extends ContractDoc {
  /** input=需求自带（机检提取）；generated=Planner 立约、经契约门人工确认 */
  source: 'input' | 'generated';
  /** M6 预留：本单按哪版契约模板干的（id@sha），留痕红线 */
  template?: string;
  /** 契约门人工批准时刻；input 契约无需批准为空 */
  confirmedAt?: string;
}

/** 从产物 extra 读契约；无 contract 对象返回 null（写了但条目非法则逐条宽松过滤）。 */
export function contractOf(extra: Record<string, unknown> | undefined): ContractDoc | null {
  const raw = extra?.contract;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as {
    assertions?: unknown;
    questions?: unknown;
    scopeNotes?: unknown;
    budget?: unknown;
    repo?: unknown;
    branch?: unknown;
  };
  const assertions: AcceptanceAssertion[] = [];
  if (Array.isArray(c.assertions)) {
    for (const item of c.assertions) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Partial<AcceptanceAssertion>;
      if (typeof a.id !== 'string' || typeof a.assertion !== 'string') continue;
      assertions.push({
        id: a.id,
        assertion: a.assertion,
        verify_method: typeof a.verify_method === 'string' ? a.verify_method : '',
      });
    }
  }
  const questions = Array.isArray(c.questions)
    ? c.questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
    : [];
  const doc: ContractDoc = { assertions, questions };
  if (typeof c.scopeNotes === 'string' && c.scopeNotes.trim()) doc.scopeNotes = c.scopeNotes.trim();
  if (c.budget && typeof c.budget === 'object') {
    const b = c.budget as { maxMinutes?: unknown; maxTokens?: unknown };
    const budget: NonNullable<ContractDoc['budget']> = {};
    if (typeof b.maxMinutes === 'number') budget.maxMinutes = b.maxMinutes;
    if (typeof b.maxTokens === 'number') budget.maxTokens = b.maxTokens;
    if (Object.keys(budget).length) doc.budget = budget;
  }
  if (typeof c.repo === 'string' && c.repo.trim()) doc.repo = c.repo.trim();
  if (typeof c.branch === 'string' && c.branch.trim()) doc.branch = c.branch.trim();
  return doc;
}

/**
 * 轻校验验收断言列表：数组非空、每项 id/assertion/verify_method 均为非空字符串。
 * 校验通过返回 null；否则返回描述问题所在的错误信息
 * （供 aligned 门判定与 clarify 补齐提示复用）。
 */
export function validateAcceptance(list: AcceptanceAssertion[] | undefined | null): string | null {
  if (!Array.isArray(list) || list.length === 0) {
    return '验收断言列表为空或不是数组';
  }
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      return '验收断言包含无效项（非对象）';
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      return `验收断言第 ${list.indexOf(item) + 1} 项缺少非空 id`;
    }
    if (typeof item.assertion !== 'string' || item.assertion.trim() === '') {
      return `验收断言 ${item.id} 缺少非空 assertion`;
    }
    if (typeof item.verify_method !== 'string' || item.verify_method.trim() === '') {
      return `验收断言 ${item.id} 缺少非空 verify_method`;
    }
  }
  return null;
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
  | /** F2：服务重启打断了审批等待；审批上下文保留，⤴ 续跑重到此节点会重新弹出 */
    'paused'
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
  /** worktree 路径（同仓并发隔离时由引擎创建；运行结束前尽力回收） */
  worktree?: string;
  /**
   * 终端输出快照（按时间追加，每条 ≤8KB）：运行中随状态推送采集，
   * run 结束后 agent pane 已回收，终端预览从这里回放。
   */
  outputSnapshots?: { at: string; text: string }[];
  paneId?: string;
  agentName?: string;
  agentStatus?: AgentStatus;
  /** F1 产物可信标记：true 表示结果文件缺失、artifact 来自终端尾部兜底（未经文件验证） */
  unverified?: boolean;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  /**
   * v12-V2 进门时刻（ISO）：审批门挂起等待人工前写、放门结算后清——waitMs 的唯一时长依据。
   * 落册持久化（F2 重启转 paused 时随 rec 保留），但重启后审批 waiter 不存在、
   * 放门走不到结算口（⤴ 续跑重到此节点会重写本时刻）——跨重启那截等待宁缺毋假。
   */
  blockedAt?: string;
  artifact?: Artifact;
  error?: string;
}

export type RunState =
  | 'running'
  /** G3 轻队列：空间并发 run 达上限时待启排队，额度腾出自动出队启动 */
  | 'queued'
  | 'completed'
  /**
   * v11-D3（摩擦账 #12）：全节点到达终态、run 本身没死，但 ≥1 个节点 failed
   * （onFail=continue / 宽松 fan-in 收口）——不再假装全绿收口成 completed。
   * 消费红线：调度/锁释放/归档等「视同已结束」的场合等同 completed；
   * UI 绿标/wiki 沉淀/统计「成功数」等「视同全绿」的场合必须区分。
   */
  | 'completed-with-failures'
  | 'failed'
  | 'cancelled';

/** v11-D3：run 已收口到终态（不论成败）——队列放行、去重释放、归档门槛等用它 */
export function runHasEnded(state: RunState): boolean {
  return state === 'completed' || state === 'completed-with-failures' || state === 'failed' || state === 'cancelled';
}

export interface RunRecord {
  runId: string;
  dagName: string;
  /** 关联需求 Issue（可检索/展示） */
  issueId?: string;
  /** 首驾-2：子 run 的血缘父 run id（同 issue 幂等锁据此排除祖先链，避免父撞子自己死锁） */
  parentRunId?: string;
  /** I2：本单实填的模板变量值（startRun 传入的映射原样留档；经验注入与表单回填补数据） */
  variables?: Record<string, string>;
  graph: DagGraph;
  state: RunState;
  cwd: string;
  /** Owning Space (multi-project isolation) */
  spaceId?: string;
  workspaceId?: string;
  nodes: Record<string, NodeRunRecord>;
  startedAt: string;
  finishedAt?: string;
  /** 运行事件时间线（R5.3：状态变迁/重试/子运行/审批的留档） */
  events?: RunEvent[];
  /** R6a 运行成本汇总（引擎收尾时计算并持久化） */
  cost?: RunCost;
  /**
   * v12-S2 实时 token 账：任一节点产物落册时把合法 extra.usage（agent 自报）增量累进这里，
   * 只增不减、绝不估算——从未自报则该键始终缺省，预算比对只警示不熔断（评审 R3）。
   * S2 熔断执行点（节点尝试启动前）与重启恢复都只读这一份结构化落册，不收口时重算。
   */
  costLive?: RunTokenLedger;
  /** R5.1 归档标记（归档后移出运行中心主列表，记录保留可检索） */
  archived?: boolean;
  /** M2 契约一等公民：本单按什么约定在干（F1 门/H1 守卫/预算的共同引用） */
  contract?: RunContract;
  /** H1 交付出口：wrapup/deliver 回写 extra.pr_url 后引擎捕获至此（运行卡绿灯判据） */
  prUrl?: string;
  /** v11-C3a wiki 读回注入留痕（C3b 页↔run 回链的数据源；缺省=本次没注入/没读回） */
  wikiReadback?: WikiReadbackTrace;
  /** v11-E1a replay 血缘：本单由哪个原 run replay 而来（缺省=普通单） */
  replayOf?: string;
  /** v11-E1b 复跑实验元数据（缺省=非实验单，不进收数表） */
  experiment?: RunExperimentMeta;
  /**
   * v12-V1 harness 披露：本单实发配置在起单时一次性固化（缺省=v11 及更早的旧记录，
   * JSON 向后兼容不炸）。C4 A/B 的「两臂只差 readback」与 replay 漂移比对以此为机器证据源。
   */
  harness?: RunHarness;
  /**
   * v12-S1a 副作用可见化：本单对外部世界写操作的统一落册（缺省=无在册副作用/旧记录，
   * JSON 向后兼容只增不改）。S1b 的 replay 门禁唯一输入：非空=直接重放会二次副作用。
   * 证据源边界见 RunSideEffects 各键注释——宁缺毋假，不做读时推导。
   */
  sideEffects?: RunSideEffects;
  /**
   * v12-V2 人介入账（验证税）：人在审批门上花掉的等待时长与决策次数，
   * 放门处即结算、结构化落册（评审 R4：算账不靠 500 条环形事件推导）。
   * 缺省=本单没经过任何放门动作（旧记录同款向后兼容）。
   */
  attention?: RunAttention;
}

/**
 * v12-V2 人介入账本：同一节点多轮进出门（input 谈完再拦）逐次累加，合法。
 * waitMs 只累「进门时刻可考」的轮次——存量路/重启丢时刻的轮次只计次不加时长，绝不造数。
 */
export interface RunAttention {
  /** Σ 各轮放门等待时长（毫秒，拦侧→放侧）；只在两端时刻皆可考时累加 */
  waitMs: number;
  /** 按决策类型的放门次数 */
  gates: { approve: number; reject: number; input: number };
}

/**
 * v12-S1a 副作用账目（S1a）：只记引擎可见的证据，全部 append-only。
 * 盲 HTTP 端点（create-issue/update-issue）只有调用方带 runId 才归因——
 * agent 是否知道 runId 取决于模板提示词（本片不动），端点侧先接好线。
 */
export interface RunSideEffects {
  /** 经 POST /api/github/create-issue 建成的 issue 号（每次成功 append 一枚） */
  issuesCreated?: number[];
  /** 经 PATCH /api/github/update-issue 覆写正文的 issue 号（同号可重复=覆写多次） */
  issuePatched?: number[];
  /** run.prUrl 的镜像：capturePrUrl 落册处一处写两字段（别做读时推导） */
  prUrl?: string;
  /**
   * git push 已发生（ISO 时刻）——纯自报口径：现查 deliver 节点 extra 只有
   * pr_url/push_error/blocked_reason，没有 commit sha/pushed 类可信键，
   * 模板未报=不可见，宁缺毋假（本片留键位不填）。
   */
  pushedAt?: string;
}

/**
 * v12-V1 起单时固化的实发 harness（写一次即成历史）。
 * 拿不到的键直接省略——绝不估算（与 cost.tokens 的 null 原则同款）；
 * 只做披露与比对，不参与任何编排判据（评审 R5）。
 */
export interface RunHarness {
  /**
   * 实发 graph（变量替换与 I2/C3a 注入全部完成后的 structuredClone 终态快照）
   * 的规范化 JSON sha256 前 8 位——与 v8-M6 契约模板 templateSha 同指纹口径。
   */
  graphSha: string;
  /** AE 解析链（覆盖>节点>角色>空间>自动推荐）起单时对执行序首个 agent 节点的一次性入口结果 */
  agentKind: string;
  /** 起单时生效网关档的 freeModel（网关未激活/无模型/读不到=省略） */
  model?: string;
  /** 起单时空间档案钉的网关档 id（未钉/读不到=省略，语义=跟全局 current 档） */
  gwProfile?: string;
}

/**
 * v11-E1b 实验元数据：这单属于哪个实验（suite）、哪条臂（arm）、
 * 拨着什么开关（flag）。只作标注与过滤，不参与任何编排判定。
 */
export interface RunExperimentMeta {
  suite?: string;
  arm?: string;
  flag?: string;
}

/**
 * v11-C3a 注入留痕：本次 run 按哪个目标仓的本地 llm-wiki 缓存，给哪些节点注入了哪些页。
 * pages.file 相对 `llm-wiki/` 落点根（与 publish 侧同源），title 供展示；
 * 只记**实际进了 prompt** 的页（预算裁掉的尾巴不入账）。
 */
export interface WikiReadbackTrace {
  /** 目标仓 owner/repo（run cwd 的 origin 优先，回落契约/默认仓） */
  repo: string;
  nodes: { nodeId: string; pages: { file: string; title: string }[] }[];
}

export interface RunEvent {
  at: string;
  type: 'node' | 'run' | 'child' | 'approval' | 'snapshot';
  nodeId?: string;
  text: string;
}

/** R6a 成本记账 v0：纯记账（时长/尝试数/token 自报），不做预算强制与熔断 */
export interface NodeCost {
  durationMs: number;
  attempts: number;
  /** 重试次数 = attempts - 1 */
  retries: number;
}

export interface RunCost {
  totalMs: number;
  byNode: Record<string, NodeCost>;
  retries: number;
  /** Σ 各节点 artifact extra.usage（agent 自报）；null = 拿不到，明示 unknown，绝不估算 */
  tokens: { input: number; output: number } | null;
}

/**
 * v12-S2 实时 token 账（RunRecord.costLive）：与收口 cost.tokens 同源同口径
 * （都只认 artifact.extra.usage 自报值），区别在时机——落册即入账，供预算熔断
 * 在节点启动前比对。byNode 记住各节点已入账户头，同产物重提取/重试重报不双计；
 * 各分量只增不减（新报值取 per-分量 max，差额累进总账）。
 */
export interface RunTokenLedger {
  input: number;
  output: number;
  byNode: Record<string, { input: number; output: number }>;
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
    // v13-V0 值域白名单：类型打错过去恒真放行（未知 node.type 走结构标记路标 done、
    // 未知 checks[].type 在检查循环里没有分支 = 静默通过），宁拒不错放。
    if (!(DAG_NODE_TYPES as readonly string[]).includes(n.type)) {
      issues.push({
        level: 'error',
        message: `未知节点类型：${n.type || '(空)'}（可用：${DAG_NODE_TYPES.join('/')}）：${n.label}`,
        nodeId: n.id,
      });
    }
    for (const c of n.config.checks ?? []) {
      if (!(CHECK_SPEC_TYPES as readonly string[]).includes(c.type)) {
        issues.push({
          level: 'error',
          message: `未知检查类型：${c.type || '(空)'}（可用：${CHECK_SPEC_TYPES.join('/')}）：${n.label}`,
          nodeId: n.id,
        });
      }
    }
    if (n.type === 'fanout' && n.config.expand) {
      const mi = n.config.expand.maxItems;
      if (mi !== undefined && (!Number.isInteger(mi) || mi < 1 || mi > FANOUT_MAX_ITEMS_LIMIT)) {
        issues.push({
          level: 'error',
          message: `动态扇出上限非法：maxItems=${mi}（需 1..${FANOUT_MAX_ITEMS_LIMIT} 的整数）：${n.label}`,
          nodeId: n.id,
        });
      }
    }
    if (n.type === 'agent') {
      // AE：agentKind 允许缺省——运行时按 空间默认→自动推荐（已装优先）解析；给了就必须合法
      if (n.config.agentKind !== undefined && !AGENT_KIND_PATTERN.test(n.config.agentKind)) {
        issues.push({ level: 'error', message: `Agent 节点 agentKind 非法：${n.config.agentKind || '(空)'}（${n.label}`, nodeId: n.id });
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

export interface UnresolvedRef {
  /** 出处：节点 id（`<id>.<字段路径>`）或 metadata */
  where: string;
  /** 引用原文（含花括号） */
  ref: string;
}

const ANY_REF = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.\-]*)\s*\}\}/g;

/**
 * G2 引用失败可见：扫描图内残留的 `{{...}}` token，基准名既不是本图节点、
 * 也不是动态扇出的 `item` 绑定 → 判为未解析（花括号会原样进提示词，静默事故）。
 * 应在 applyVariables 之后跑（已声明变量彼时已被替换掉）。只报告不拦截——
 * startRun 据此发 warn 事件上时间线，与 RunDialog 必填校验互补。
 */
export function lintUnresolvedRefs(graph: DagGraph): UnresolvedRef[] {
  const bases = new Set(graph.nodes.map((n) => n.id));
  bases.add('item');
  const out: UnresolvedRef[] = [];
  const seen = new Set<string>();
  const scan = (where: string, value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(ANY_REF)) {
        const base = m[1]!.split('.')[0]!;
        if (bases.has(base)) continue;
        const key = `${where}\u0000${m[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ where, ref: m[0] });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => scan(`${where}[${i}]`, v));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) scan(where ? `${where}.${k}` : k, v);
    }
  };
  for (const n of graph.nodes) {
    scan(n.id, { label: n.label, config: n.config });
  }
  scan('metadata', { description: graph.metadata.description });
  return out;
}
