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
  /**
   * v13-K1 命名产物声明位（见 ProductDecl 的「声明/实算分两家」理由）。缺省=本节点没声明产物
   * （与「声明了零件」分家：破烂条目整条不记并落一条 warn，宁缺毋假）。
   */
  products?: ProductDecl[];
  /** Whether this artifact came from the result file or the output fallback */
  source: 'file' | 'output-fallback' | 'empty';
  finishedAt: string;
}

/**
 * v13-K1 命名产物的**声明位**（artifact.json 的 `products` 数组条目）。
 * 需求文档把台账形状写成 `{name,kind,sha,bytes}`——这里刻意分两家：agent 只声明
 * 「我产出了什么、文件在哪」（name + 相对节点工作目录的 file），sha/bytes **由引擎读原文实算**。
 * 理由不是洁癖：自报哈希等于没有哈希（v13-V1「机检/自报双口径」同族），而 K1 的立论正是
 * 「下游引用自此可证审的就是这份」——证的东西必须出自引擎实读的那一版。
 * kind 也不由声明决定：声明了 file 的=doc；`diff` 由引擎零约定自动采（agent 不用会写）。
 */
export interface ProductDecl {
  name: string;
  /** 相对该节点工作目录的文件路径；缺省=拿 name 当路径 */
  file?: string;
}

/**
 * v13-K1 命名产物台账（引擎在尝试收口现场实读实算，与 v13-W2 两枚 bit 同款「取值时点=发生的那一刻」）：
 * 落 `NodeRunRecord.products`，重试=后一轮覆盖前一轮（记的是这一轮实发的东西）。
 * `shelved` 说的是「这一份有没有真复制进 dataDir 产物架」——worktree 回收、agent 机器重启都卷不走架上一份，
 * 这笔账的全部意义在此：`shelved:false` **也是读数**（超限被拒/读不到），不是失败也不是没产。
 */
export interface RunProduct {
  /** 节点内唯一名（同名声明后面的整条不取，见 products.normalizeProductDecls）；上架时只取 basename 作文件名 */
  name: string;
  kind: 'doc' | 'diff';
  /** 原文（文件内容或 patch 文本）的 sha256 前 8 位——bytesSha 口径，见 harness.ts */
  sha: string;
  /** UTF-8 字节数（不是字符数） */
  bytes: number;
  shelved: boolean;
  /** shelved=false 时的一句人话（over-run-cap（…）/ write-failed:<原因>）；shelved=true 不写这个键 */
  shelfError?: string;
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

/** assertionDiff 的结构化输出：契约断言集 × run 实际自报结果的交集求差（读端双口径的共同形状） */
export interface AssertionDiff {
  /** 契约断言总数（覆盖率的唯一合法分母；0 = 无契约，交集口径无从谈起） */
  total: number;
  /** 通过数 = 契约 ∩ 自报 ok——**与契约取交后**才计（>100% 修法的落点） */
  passed: number;
  /** 契约里自报结果压根没覆盖到的编号（没跑/没回写；fail/n/a 算覆盖过、不算缺） */
  missing: string[];
  /** 自报了但契约外的编号——旧 >100% bug 的原料，现在如实可见，但绝不再进 passed */
  outside: string[];
}

/**
 * v13-V1 契约断言集与实际断言结果的纯函数求差（零 IO，读端推导）。
 * 过去为什么错：沉淀页覆盖率（wiki.ts renderWikiPage 的 digest）里 pass 数直接数自报 ok 行、
 * 分母却是契约断言数——agent 多报几条契约外断言（AC-9 之类）分子就虚增，能报出 `4/2` 的 >100% 绿数；
 * 现在凭什么对：passed 只按 契约 ∩ status='ok' 计，契约外行归入 outside 单独可见——
 * 「自报比契约多」从算错分母变成读得出来的事实。
 * 同 id 重复行取**最后一行**的状态（与 latestAssertionResults 跨节点「终审覆盖自测」同口径）。
 */
export function assertionDiff(
  contract: readonly { id: string }[] | undefined | null,
  results: readonly { id: string; status: string }[] | undefined | null,
): AssertionDiff {
  const contractIds: string[] = [];
  const seen = new Set<string>();
  for (const a of contract ?? []) {
    if (!a || typeof a.id !== 'string' || !a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    contractIds.push(a.id);
  }
  const statusById = new Map<string, string>();
  const outside: string[] = [];
  const outsideSeen = new Set<string>();
  for (const r of results ?? []) {
    if (!r || typeof r.id !== 'string' || !r.id) continue;
    statusById.set(r.id, typeof r.status === 'string' ? r.status : '');
    if (!seen.has(r.id) && !outsideSeen.has(r.id)) {
      outsideSeen.add(r.id);
      outside.push(r.id);
    }
  }
  const missing: string[] = [];
  let passed = 0;
  for (const id of contractIds) {
    const st = statusById.get(id);
    if (st === undefined) missing.push(id);
    else if (st === 'ok') passed += 1;
  }
  return { total: contractIds.length, passed, missing, outside };
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
   * v13-S4 gateTimeoutMs：run 级审批门到期上限（ms），执行点在 engine awaitGate——
   * 契约优先 > env PF_GATE_TIMEOUT_MS > 0/未设=关闭（到期 fail-closed 收 failed，绝不代放门）。
   */
  budget?: { maxMinutes?: number; maxTokens?: number; gateTimeoutMs?: number };
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
    const b = c.budget as { maxMinutes?: unknown; maxTokens?: unknown; gateTimeoutMs?: unknown };
    const budget: NonNullable<ContractDoc['budget']> = {};
    if (typeof b.maxMinutes === 'number') budget.maxMinutes = b.maxMinutes;
    if (typeof b.maxTokens === 'number') budget.maxTokens = b.maxTokens;
    if (typeof b.gateTimeoutMs === 'number') budget.gateTimeoutMs = b.gateTimeoutMs; // v13-S4：不设防在此，非法值由执行点 resolveGateTimeoutMs 判关闭
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

/**
 * v13-S2 掐断触发点（NodeAbandonment.trigger）——「一次节点尝试到此为止」的原因归类：
 * - settle-timeout：等 agent 状态收敛超时（waitForSettle deadline 路）
 * - retry：进入重试——下一轮起窗之前必须先掐上一轮（含限流扩预算的再轮）
 * - stop：stopRun/取消
 * - shutdown：SIGTERM 优雅停机（v13-S6 停机序列复用同一掐断函数）
 * - agent-gone：后台对账拿到明确 not_found 判 agent 已没（传输错/读不到不判，见 reconcile）
 */
export type NodeAbandonmentTrigger = 'settle-timeout' | 'retry' | 'stop' | 'shutdown' | 'agent-gone';

/**
 * v13-S2 尝试边界掐断账：每一次引擎主动「掐断在飞尝试」都结构化落到节点记录上——
 * 字段要能回答「哪一轮尝试（attempt）、什么触发点（trigger）、掐的是什么状态
 * （agentStatus，掐断现场实读）」。append-only，掐断即落册；
 * K2 打回账（rejections）按需求口径复用本形状。
 * 红线：不靠环形 events 字符串推导（v12-V2 attention 账同款卫生）。
 */
export interface NodeAbandonment {
  at: string;
  /** 被掐的是第几轮尝试（与 NodeRunRecord.attempts 同一口径） */
  attempt: number;
  trigger: NodeAbandonmentTrigger;
  /** 掐断时刻读到的 agent 状态；读不到/已没=unknown——绝不估算 */
  agentStatus: AgentStatus | 'unknown';
  /** 掐的是哪个 agent（事后对账用） */
  agentName: string;
}

/**
 * v13-W3 授权声明三面（`Role.declares?` 的合法面值；类型定义在 server roles.ts，这里放正身）。
 * 三面与引擎唯一的副作用账 RunSideEffects 恰一对一可对账：gitPush↔pushedAt、
 * prOpen↔prUrl、issueWrite↔issuesCreated/issuePatched。需求文档省略号里的 **writeScope 刻意不进**：
 * 账上没有按路径可核对的写键，入库等于登一张永远抓不到落差的脸——「声明了却对不了账」
 * 正是本片要防的静默失效，等有可核对的账再开面。
 */
export const DECLARE_FACES = ['gitPush', 'prOpen', 'issueWrite'] as const;
export type DeclareFace = (typeof DECLARE_FACES)[number];
/** Role.declares 的读端形状：三面全可选——键缺省=没声明（今天的行为一字不变），true 也是正断言（只是永不违例） */
export type RoleDeclaredFaces = Partial<Record<DeclareFace, boolean>>;

/** v13-W3 收口对账的一条声明与实态落差（如声明 gitPush=false 却现 pushedAt；只照不拦） */
export interface RunDeclareViolation {
  roleId: string;
  face: DeclareFace;
  /** 实见的在册证据（人话一句，与 sideEffects 账同源：「已推送 <时刻>」「PR <url>」「建单#12、回写#7」） */
  seen: string;
}

/**
 * v13-B2 ①机检层的实消费账：本单按空间家规（delivery）真实建出来的隔离工作目录。
 * 只在「家规命中且建了 worktree」时才有键——没家规/没建 worktree 的单整键缺省（兼容带：
 * 零新账），与「空数组」分家（空数组理论上不出现，有账至少一条）。
 * 取材时点=createWorktree 现场（与 v13-W2 两枚账同款「取值时点=发生的那一刻」口径）：
 * expectedBranch 是家规模板渲染结果，actualBranch 是 git 在该 worktree 里读回的实分支名
 * （读不到整键省略——宁缺毋假，绝不拿期望值冒充实态）。
 */
export interface RunDeliveryWorktree {
  nodeId: string;
  /** 建它时手里的那个仓（绝对路径——同仓并发锁的键就是它，不另猜） */
  repo: string;
  worktreePath: string;
  /** 命中的家规条目在档案 delivery 数组里的下标（指认「是哪一副家规」） */
  ruleIndex: number;
  /** 命中方式：repo=精确仓条目优先；space=repo 缺省的通配副 */
  matchedBy: 'repo' | 'space';
  /**
   * 这一步真做了什么（建 worktree 现场的事实，决定 baseRef 有没有资格写）：
   *  · new-branch：git worktree add -b <家规分支> <基点>——真从某个 ref 拉出新支；
   *  · attach-existing-branch：分支已存在（上一轮尝试残留）→ 只挂不拉；
   *  · reuse-directory：目录还在（上一轮尝试残留）→ 既不建分支也不拉基点。
   */
  pullMode: 'new-branch' | 'attach-existing-branch' | 'reuse-directory';
  /** 实际用作基点的 ref（渲染并套上契约覆盖后的最终值）——**只有真拉新支时才有**，没拉就不写 */
  baseRef?: string;
  /** baseRef 的来源：contract=本单契约覆盖（契约优先于空间）；rule=空间家规 */
  baseSource?: 'contract' | 'rule';
  /** 家规 branchName 模板的渲染结果=期望分支名（落差比对基准） */
  expectedBranch: string;
  /**
   * 家规 prTarget 模板的渲染结果（B4：交付出口自此在场级账上可见——PaneFlow 不代跑建 PR，
   * 这一格只声明「该提到哪条分支」，落不落地由人在闸位定夺）。取值时点同 expectedBranch。
   */
  prTarget: string;
  /**
   * git 现场读回的实分支名（`rev-parse --abbrev-ref HEAD`，游离 HEAD 时读作字面 "HEAD"）；
   * 读不到（命令失败/不是 worktree）整键省略，该格不比——宁缺毋假，绝不拿期望值冒充实态。
   */
  actualBranch?: string;
}

/**
 * v13-B2 ③对账层落差：家规声明与实态的查得落差。**只照不拦**——warn 级事件 + 本结构化账
 * （评审 R4：算账不靠 500 条环形事件推导），run/节点状态与 watch 退出码零改动（W3 同族）。
 * 只有两条永远可算的落差进账，PR 目标分支不一致不在这里硬拦（那是人闸位的事）：
 *  · branch-name：家规命中建的 worktree 里实分支名 ≠ 模板渲染结果；
 *  · gates-without-gate：家规声明了人闸（gates 非空）而本单的图里一道人闸位都没编。
 * 缺省=无落差（含「没学家规=不对账」=静默，与现状一字不变）。
 */
export interface RunDeliveryViolation {
  kind: 'branch-name' | 'gates-without-gate';
  /** 一句人话（events 聚合文案的组成部分） */
  detail: string;
  nodeId?: string;
  /** 落差所依据的家规条目在档案 delivery 数组里的下标 */
  ruleIndex?: number;
  /** 期望值（branch-name=渲染出的分支名；gates-without-gate=声明的人闸名） */
  expected?: string;
  /** 实态值（gates-without-gate=图上编了几道人闸） */
  actual?: string;
}

/**
 * v13-W1 岗位装备解析账（三轴划界的可见面）：节点组 prompt 时「这一岗到底吃了什么文档」
 * 结构化落在节点记录上——与 v13-S2 掐断账同款卫生：不靠环形 events 字符串推导。
 * 三轴分工：空间级=事实与家规（无作用域 rules/conventionFiles + skills **登记清单**）、
 * 目录级=M3 作用域规则（按节点 cwd 命中）、角色级=岗位装备（Role.skills 引用 / Role.rules）。
 * 空数组是正读数（「确实一个都没注」），与「整键缺失」（注入现场没走到/档案读不了）分家。
 */
export interface NodeEquip {
  /** 吃了哪一轴：role=岗位装备集生效；space=角色未配装备槽或未绑角色，正吃空间全量 */
  scope: 'role' | 'space';
  /** 本节点绑定的角色 id；未绑角色整键省略（没有角色就没有「岗位未配装备」这回事） */
  role?: string;
  /** 实注入的技能文档（相对主仓根，按注入顺序） */
  skills: string[];
  /** 实注入的约定/岗位文档（matchRules 命中 ∪ 角色 rules，按 file 去重后） */
  rules: string[];
  /** 装备槽引用了空间登记清单外的技能=跳过不注、只披露（评审 R5：只披露不拦） */
  unknownSkills?: string[];
}

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
  /**
   * v13-K1 命名产物台账（见 RunProduct）：尝试收口现场引擎实读实算，重试=后一轮覆盖前一轮。
   * 缺省=本节点既没声明产物也不是 git 仓（「产了零件」与「没产」是两回事，不拿空数组冒充）。
   */
  products?: RunProduct[];
  error?: string;
  /**
   * v13-S2 掐断账：本节点每次被中途掐断的尝试各落一条（见 NodeAbandonment）。
   * 缺省=从未掐断（旧记录同款 JSON 向后兼容，只增不改）。
   */
  abandonments?: NodeAbandonment[];
  /**
   * v13-W1 岗位装备账：本节点实发 prompt 的文档取材（见 NodeEquip）。
   * 缺省=注入现场没走到（非 agent 节点/起单前失败/档案不可读）——不拿空账冒充「吃了零」。
   */
  equip?: NodeEquip;
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
  /**
   * v13-S4 外解唤醒计数：被武装的审批门（有 gateTimeoutMs/PF_GATE_TIMEOUT_MS 上限）在
   * 到期前被人放行时 +1——「定时器差点替人做了决定」的次数，默认关闭下永不产生。
   * 与 attention 同理结构化落册，不靠 500 条环形事件推导（S2 同片裁决）。
   * 缺省=本单没有外解唤醒（旧记录向后兼容）。
   */
  externalReleases?: number;
  /**
   * v13-W3 授权声明账：本单实绑各岗（绑定判据与 W4 sampleRunsForRole 同源：equip.role 实绑优先、
   * 回落名义 config.role）在岗库里声明的授权面，收口时落册（取值时点=收口时刻的岗库；同岗多节点只一条）。
   * 缺省=本单没有任何岗声明过（旧记录同款整缺，宁缺毋假不造空账）。status 的授权行唯一依据。
   */
  declares?: { roleId: string; faces: RoleDeclaredFaces }[];
  /**
   * v13-W3 收口对账落差：声明 false 的面却在副作用账上见到实态（如 declare gitPush=false 却现 pushedAt）。
   * **只照不拦**——warn 级事件 + 本结构化账（评审 R4：不靠环形 events 推导），不改 run/节点状态与退出码。
   * 缺省=无落差（或没声明/无副作用账=静默，与现状一字不变）。归因边界：单级上界（见事件文案）。
   */
  declareViolations?: RunDeclareViolation[];
  /**
   * v13-B2 ①机检层实消费账：本单按空间家规（delivery）真建出的隔离工作目录逐条在册
   * （命中判据/取材口径见 RunDeliveryWorktree）。缺省=本单没有家规命中的 worktree——
   * 没学家规的单零新账（兼容带），有账即家规真被消费过。
   */
  deliveryWorktrees?: RunDeliveryWorktree[];
  /**
   * v13-B2 ③对账层落差：家规声明 vs 实态的查得落差（两条可核对项见 RunDeliveryViolation），
   * **只照不拦**（W3 declareViolations 同族：收口判定/节点状态/watch 退出码零改动）。
   * 缺省=无落差（或本单没命中家规=压根不对账，与现状一字不变）。
   */
  deliveryViolations?: RunDeliveryViolation[];
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
 * v13-V2 等臂机检：本单 wiki 读回的**实发结局**六态枚举（五出口 + inherited）。
 * 判据全部来自起单现场（planWikiReadback 走到哪个出口 ∧ 出场 graph 里到底有没有块），
 * 不是现读 env——env 是「想不想注入」，graph 里最终有没有块才是「实发是什么」。
 * 老「off 臂」与「on 但无沉淀页」塌成同一个缺键的账，从这里起分开。
 */
export type ReadbackOutcome =
  /** 注入：本次实跑至少给一个节点 append 了读回块（留痕非空 ∧ graph 实扫有块） */
  | 'injected'
  /** 关闭出口：readbackEnabled=false（EngineOptions.wikiReadback / PF_WIKI_READBACK=off） */
  | 'switch-off'
  /** 无页出口：目标仓认不出（resolveRunRepo 三路全空）或本地缓存读不出一页——都没有可读的页源 */
  | 'no-pages'
  /** 不注入出口：有页源但本单零节点入块——无 plan/impl 目标节点、词面零相关、或预算连表头都装不下 */
  | 'not-injected'
  /** 失败出口：注入旁路整体异常被 catch（读回是加分项，炸了也不拦 run） */
  | 'error'
  /** +1 态：本次一个块都没注入，但出场 graph 的 prompt 里已有读回块——replay 从源 run 在册字面量带进来的旧块 */
  | 'inherited';

/**
 * v12-V1 起单时固化的实发 harness（写一次即成历史）。
 * 拿不到的键直接省略——绝不估算（与 cost.tokens 的 null 原则同款）；
 * 只做披露与比对，不参与任何编排判据（评审 R5）。
 * v13-V2 等臂机检：readback/readbackOutcome/skeletonSha 三键使「两臂只差一个读回块」
 * 可证——等臂判据 = skeletonSha 相等 ∧ readback 不等。v13-V2 之前的旧落册记录无这三键
 * （JSON 只增不改，照常读得出，消费端按缺项跳过）。
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
  /**
   * v13-V2 本单实态：读回块最终在不在 prompt 里。扫出场 graph 实态得出
   * （判据=任一字符串值有独占一行且等于读回块表头的行），不读 env、不看留痕——
   * 所以 replay 的 off 臂带着旧块也照出 true。
   */
  readback: boolean;
  /** v13-V2 读回实发结局（五出口+inherited，每态判据见 ReadbackOutcome 注释） */
  readbackOutcome: ReadbackOutcome;
  /**
   * v13-V2 骨架指纹：剥掉注入块（读回块 + I2 经验块）、并把每次必然不同的
   * run_id/draft_dir 字面量归一之后的 graph 内容指纹（口径同 graphSha）。
   * 两臂 skeletonSha 相等 = 真拓扑逐字节只差被剥掉的注入面；不等 = 动了真格的东西。
   * 可选：v13-V2 前的旧记录拿不到，整键省略（宁缺毋假，不回填）。
   */
  skeletonSha?: string;
  /**
   * v13-V4 注入面指纹：本单实发 prompt 里「PaneFlow 注入面」的可复算字节身份——
   * resolveContext 注入现场实读到的约定文档/技能文件集（逐文件内容指纹）并入
   * gwThrottleRetries / nodeTimeoutMsDefault 两枚运行旋钮后的 contentSha。
   * 口径与取值时点见 engine.noteContextInjection 注释；只披露不参与编排判定（评审 R5）。
   * 可选：v13-V4 前的旧记录、以及整单没走过注入路径的防御路拿不到，整键省略
   * （宁缺毋假，不回填、不估算）。诚实边界：agent 自己的 CLI 在 pane cwd 里
   * 自读的那份 AGENTS.md 引擎不可考，本键只证注入面这一份。
   */
  ctxSha?: string;
  /**
   * v13-W2 岗位指纹：本单实发「角色 + 解析后的装备」的内容指纹——每枚输入=节点绑定的角色 id
   * （未绑=null）∪ 注入现场实解析出的技能/岗位文档路径集（含装备槽里清单外的引用），
   * 多节点/多角色按节点去重后并入一枚（口径与构成见 harness.computeRoleSha）。
   * 与 ctxSha 分家：ctxSha 证「文件内容那一面吃了什么」（逐文件内容指纹），
   * 本键证「哪一岗挂哪几篇」这格配置——**换装备=换指纹、同装备=同指纹**（文件内容改了
   * 是 ctxSha 的事），于是 V2 的等臂判据（骨架# 相等 ∧ 受测变量不等）零新机制外延到岗位级 A/B。
   * 取值时点同 ctxSha：注入现场（起单时点还没有实发值）。
   * 可选：v13-W2 前的旧记录、以及整单没解析出装备（档案不可读/没走注入路径）拿不到，
   * 整键省略（宁缺毋假，不回填、不拿「吃了零」冒充）。
   */
  roleSha?: string;
  /**
   * v13-W2 注入字节账：本单实发 prompt 里「注入面」的 UTF-8 字节总量——各 agent 节点
   * 注入现场实算的上下文块（角色 prePrompt + 约定/技能文档）逐节点取最后一轮值再求和
   * （重试不双计）。0 是正读数（「确实一个字都没注」），缺键=没走到注入现场。
   * G1 降重账的分子：配了装备槽后本值应肉眼掉下来。
   * 可选：v13-W2 前的旧记录整键省略。
   */
  injectedBytes?: number;
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
      // v13-K1 硬引用机检（写入面 fail-closed，与 v13-V0 同款姿势）：引用了图里没有的节点=配置打错，
      // 宁可当场拒也不放行——放行了就是「下游引用一份永不存在的产物」，收口时红得莫名其妙
      for (const ref of productRefsOf(n.config.prompt ?? '')) {
        // 克隆前缀（fanout 展开态 design__2）模板期不存在、运行期才有账——按基名认，不误杀
        const base = ref.nodeId.split('__')[0]!;
        const known = nodes.some((m) => m.id === ref.nodeId || m.id === base);
        if (!known) {
          issues.push({
            level: 'error',
            message: `产物引用指向图外节点：{{artifact:${ref.nodeId}/${ref.name}}}（本图无节点「${ref.nodeId}」）：${n.label}`,
            nodeId: n.id,
          });
        } else if (ref.nodeId === n.id) {
          issues.push({
            level: 'error',
            message: `产物引用指向本节点自己（产物在收口才落册，取不到）：${n.label}`,
            nodeId: n.id,
          });
        }
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

/**
 * v13-K1 命名产物硬引用：`{{artifact:<nodeId>/<产物名>}}`。
 * 与 `{{nodeId.field}}` 分家用冒号形态（TEMPLATE_REF 与 ANY_REF 都不认冒号，于是两族引用互不撞、
 * 存量模板一字不变）。语义也不同，这一字之差就是本片的立论：
 *  · `{{nodeId.field}}` 解析不到=字面放行（G2 只报告不拦，黑盒摘要本就可有可无）；
 *  · 硬引用解析不到=**下游节点即时失败**——「审的就是那份」不许在没那份的时候照样成立。
 */
const PRODUCT_REF = /\{\{\s*artifact:\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\/\s*([^\s{}]+?)\s*\}\}/g;

export interface ProductRef {
  nodeId: string;
  name: string;
  /** 引用原文（含花括号），报错文案与替换前定位用 */
  raw: string;
}

/** 扫一段文本里的产物硬引用（形状非法的也返回，由调用方判名） */
export function productRefsOf(text: string): ProductRef[] {
  const out: ProductRef[] = [];
  for (const m of text.matchAll(PRODUCT_REF)) out.push({ nodeId: m[1]!, name: m[2]!, raw: m[0] });
  return out;
}

/**
 * 渲染产物硬引用：resolve 返 undefined 的引用**不替换**，原样留在 text 里并进 missing
 * ——引擎据 missing 判节点失败，绝不把没解析掉的 `{{artifact:...}}` 交给 agent 当指令读。
 */
export function renderProductRefs(
  text: string,
  resolve: (ref: ProductRef) => string | undefined,
): { text: string; missing: ProductRef[] } {
  const missing: ProductRef[] = [];
  const rendered = text.replace(PRODUCT_REF, (whole, _nodeId: string, _name: string) => {
    const ref: ProductRef = { nodeId: _nodeId, name: _name, raw: whole };
    const value = resolve(ref);
    if (value === undefined) {
      if (!missing.some((m) => m.raw === whole)) missing.push(ref);
      return whole;
    }
    return value;
  });
  return { text: rendered, missing };
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

// ---------------------------------------------------------------------------
// v13-W2 名册引用机检（纯读推导，与 lintUnresolvedRefs 同款姿势：只报告不拦跑）
// ---------------------------------------------------------------------------

/**
 * 节点引用的岗位在不在本空间班底名册里（v13-W2「上岗」的判据面）。
 * `rosterRoleIds` = SpaceProfile.team 的 roleId 集（调用方从档案读好喂进来——validateDag
 * 只吃 graph、拿不到档案，故分此一枚共用纯函数，web 校验面与引擎时间线同源同一判据）。
 * 判据：
 *  · 名册为空/未传 = **没有班底这回事** → 一条不报（存量模板与未配班底的空间不许变红）；
 *  · 节点没绑 role → 不报（不绑岗是合法现状，吃空间默认）；
 *  · 绑了名册外的 role → level:'warning'（跑单照旧绿，只上时间线；评审 R5：只披露不拦）。
 */
export function validateRoleRefs(graph: DagGraph, rosterRoleIds: readonly string[] | undefined): DagIssue[] {
  const roster = new Set((rosterRoleIds ?? []).filter((s): s is string => typeof s === 'string' && s !== ''));
  if (!roster.size) return [];
  const out: DagIssue[] = [];
  for (const n of graph.nodes ?? []) {
    const role = n.config?.role;
    if (typeof role !== 'string' || role === '') continue;
    if (roster.has(role)) continue;
    out.push({
      level: 'warning',
      nodeId: n.id,
      message: `节点 ${n.id} 点的岗「${role}」不在本空间班底名册（跑单照旧，只是这岗没进编制）`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// v13-V1 机检/自报双口径（纯读端推导，零新字段、零新写路径）
// ---------------------------------------------------------------------------

/**
 * checks[] 里引擎实跑得动的机检类（值域全集见 CHECK_SPEC_TYPES）：manual 是「人看一眼」，
 * 引擎实跑不了，不进机检账。过去为什么没有这笔账：跑成功的机检从不落册（没有写端字段可数），
 * 而「上线日之后才开始计数」的写端方案对历史 run 永远缺账——裁决改走纯读端：
 * 分母今天就在 graph 里（每个节点的 checks[]），done 与否就在 state 里。
 */
export const MACHINE_CHECK_TYPES = [
  'file-exists',
  'command',
  'regex',
  'delivery-branch',
  'contract',
] as const satisfies readonly CheckSpecType[];

/** machineCheckTally 的输出：本单「机检实跑」侧的账（与自报断言口径对照着看） */
export interface MachineCheckTally {
  /** 图内机检项总数（checks[] 剔 manual） */
  items: number;
  /** 带机检的节点数 */
  nodes: number;
  /** 其中 state=done 的节点数——引擎门禁保证 done ⇒ 该节点机检全过，done 本身就是实跑证据 */
  verified: number;
  /** nodes>0 且机检节点全 done 才是 true；无机检（nodes=0）恒 false——「无机检」不许搭「全过」的绿车 */
  allPassed: boolean;
}

/**
 * 对给定 run 算机检双口径中的「机检」侧（纯函数、零 IO）。
 * state 拿不到（缺节点记录 / 图与记录对不上，如旧 run 或动态扇出克隆未落册）→ 整个返回 null，
 * 调用端**整键省略**——0 是正断言（「一条机检都没过」），「不知道」不是 0，绝不画假红也绝不画假绿。
 * 未知 checks[].type（v13-V0 白名单前的旧图）不算机检：引擎当年对它是静默通过，没资格声称实跑过。
 */
export function machineCheckTally(
  run: Pick<RunRecord, 'graph' | 'nodes'> | undefined | null,
): MachineCheckTally | null {
  const graphNodes = run?.graph?.nodes;
  if (!run || !Array.isArray(graphNodes) || graphNodes.length === 0) return null;
  let items = 0;
  let nodes = 0;
  let verified = 0;
  for (const n of graphNodes) {
    const machine = (n?.config?.checks ?? []).filter(
      (c) => (MACHINE_CHECK_TYPES as readonly string[]).includes(String(c?.type)),
    );
    if (!machine.length) continue;
    nodes += 1;
    items += machine.length;
    const rec = run.nodes?.[n.id];
    if (!rec || typeof rec.state !== 'string') return null;
    if (rec.state === 'done') verified += 1;
  }
  return { items, nodes, verified, allPassed: nodes > 0 && verified === nodes };
}
