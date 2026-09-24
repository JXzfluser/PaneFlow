import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import type {
  AgentStatus,
  AcceptanceAssertion,
  DagNodeConfig,
  Artifact,
  DagEdge,
  DagGraph,
  NodeRunRecord,
  RunContract,
  RunRecord,
  RunCost,
  NodeCost,
  WikiReadbackTrace,
  RunExperimentMeta,
  RunHarness,
  RunSideEffects,
  NodeAbandonmentTrigger,
} from '@paneflow/shared';
import { applyVariables, renderPromptTemplate, topoSort, validateDag, validateAcceptance, failedAssertionsOf, contractOf, lintUnresolvedRefs, runHasEnded, FANOUT_MAX_ITEMS_LIMIT } from '@paneflow/shared';
import { appendTemplateFeedback } from './contract-templates.js';
import type { HerdrOps } from './herdr-ops.js';
import { makeAgentName } from './herdr-ops.js';
import { Store } from './store.js';
import { buildConventionBlock, loadRoles, type Role } from './roles.js';
import { effectiveRules, matchRules } from './rules.js';
import { buildSkillBlock } from './skills.js';
import { buildGatewayEnv, gatewayActive, PI_GATEWAY_PROVIDER, readGateway } from '../api/gateway.js';
import { envInt, gatewayHostOf, GwConcurrencyGate, looksLikeGatewayThrottle } from './gwlimit.js';
import {
  bookUsage,
  budgetBreach,
  budgetBreachMessage,
  parseUsage,
  resolveTokenCap,
} from './token-budget.js';
import { appendExperimentRow } from './experiment.js';
import { bookGateRelease } from './attention.js';
import { contentSha, harnessDriftDiffs } from './harness.js';
import { hasSideEffects, sideEffectsSummary } from './side-effects.js';
import { recommendAgentKind as probeRecommendAgentKind } from '../api/env-check.js';
import { buildGithubEnv, readGithubSettings } from '../api/github-cred.js';
import { autoDistillEnabled, autoDistillRun } from '../api/wiki-distill.js';
import {
  buildReadbackBlock,
  isReadbackTarget,
  loadReadbackPages,
  makeWikiCacheRefresher,
  rankReadbackPages,
  readbackEnabled,
  readbackQuery,
  resolveRunRepo,
} from './readback.js';

export interface EngineOptions {
  workspaceLabelPrefix: string;
  reconcileIntervalMs: number;
  /** Default per-node settle timeout when the node does not specify one (ms) */
  defaultNodeTimeoutMs: number;
  /** agent.start timeout (ms) */
  agentStartTimeoutMs: number;
  /** Max wait for the agent to become idle after start (ms) */
  agentReadyTimeoutMs: number;
  /** Extra env for pipeline workspaces (e.g. OPENCODE_DISABLE_AUTOUPDATE=1) */
  paneEnv?: Record<string, string>;
  /** 提交后确认窗（ms）：窗口内状态必须离开 idle，否则判 stalled 快速失败（默认 45s） */
  promptConfirmWindowMs?: number;
  /** Max agent panes running in parallel across a run (default 8) */
  maxConcurrentPanes?: number;
  /** AE 自动推荐的探针（默认查本机已装 CLI，60s 缓存）；测试注入以保确定性 */
  recommendAgentKind?: () => Promise<string | null>;
  /** v11-D1 同一网关主机上允许同时在跑的节点数；0=关闭。缺省 env PF_GW_MAX_CONCURRENT，再缺省 2 */
  gwMaxConcurrent?: number;
  /** v11-D1 命中一次网关限流后该主机闸临时收紧的基础窗口（ms）。缺省 env PF_GW_TIGHTEN_MS，再缺省 15000 */
  gwTightenMs?: number;
  /** v11-D1 限流退避基数（ms，指数递增封顶 60s）。缺省 env PF_GW_BACKOFF_BASE_MS，再缺省 3000 */
  gwBackoffBaseMs?: number;
  /** v11-D1 纯限流失败在节点自身 retryCount 之外的额外重试次数。缺省 env PF_GW_THROTTLE_RETRIES，再缺省 2 */
  gwThrottleRetries?: number;
  /** v11-D1 等闸轮询间隔（ms），仅测试调小；生产默认 250 */
  gwPollMs?: number;
  /** v11-C3a wiki 读回注入开关；缺省回落 env PF_WIKI_READBACK，两者皆缺=on（理由见 readback.ts） */
  wikiReadback?: 'on' | 'off';
  /** v11-C3a wiki 缓存后台刷新（默认 resolveGithubToken+syncWikiCache；测试注入以绝网络） */
  wikiCacheRefresh?: (repo: string) => Promise<void>;
  /** v11-C1 绿 run 收口后自动蒸馏开关；缺省回落 env PF_WIKI_DISTILL，两者皆缺=**off**（理由见 wiki-distill.ts autoDistillEnabled 注释） */
  wikiDistill?: 'on' | 'off';
  /** v11-C1 自动蒸馏执行体（默认 wiki-distill.autoDistillRun：直连网关提取 + 一次 commit 多文件 push；测试注入以绝网络/git） */
  wikiDistillRun?: (run: RunRecord) => Promise<unknown>;
  /**
   * v12-S2 run 级 token 预算上限（env PF_RUN_MAX_TOKENS 的显式覆写口，测试注入以保确定性）。
   * 缺省回落 envInt('PF_RUN_MAX_TOKENS', 0)；0/未设/破烂=关闭。契约 budget.maxTokens 优先于此。
   */
  runMaxTokens?: number;
  /**
   * v13-S4 审批门到期 fail-closed 的超时（ms，env PF_GATE_TIMEOUT_MS 的显式覆写口，测试注入以保确定性）。
   * 缺省回落 envInt('PF_GATE_TIMEOUT_MS', 0)；0/未设/破烂=关闭——缺省关闭即今日语义，
   * 现网不改任何行为。契约 budget.gateTimeoutMs 优先于此（进门现场解析，见 awaitGate）。
   */
  gateTimeoutMs?: number;
  /**
   * v13-S1 孤儿回收周期扫描间隔（ms）。缺省回落 envInt('PF_ORPHAN_SWEEP_MS', 300000)；<=0 关闭周期扫描
   * （boot 后的一次性回收不受影响）。测试注入以保确定性。
   */
  orphanSweepMs?: number;
  /** v13-S1 worktree 根目录覆写口（仅测试注入；生产默认 os.tmpdir()/paneflow-wt，B3 再谈迁移） */
  worktreeRoot?: string;
}

export interface ApprovalAction {
  action: 'approve' | 'reject' | 'input';
  keys?: string[];
  text?: string;
}

/**
 * v13-S4 门的三态出路（awaitGate 唯一返回口径，调用方据此分流）：
 * - released：人经 approve() 放了门，action 即人的原始决策，走各门既有放行路；
 * - cancelled：stopRun 置取消位后经 waiter 插话唤醒——action 只是 stopRun 合成的
 *   reject 载体，调用方按旧口径先查 cancels 收「已取消」，绝不读 action 做决策；
 * - timeout：门到期（fail-closed）——没有 action 可读，引擎不合成 reject、不送键，
 *   调用方直接以固定句式走既有失败路。
 */
export type GateOutcome = 'released' | 'cancelled' | 'timeout';
export type GateResult =
  | { outcome: 'released'; action: ApprovalAction }
  | { outcome: 'cancelled'; action: ApprovalAction }
  | { outcome: 'timeout'; waitedMs: number; capMs: number };

function legitGateTimeout(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * v13-S4 门到期上限解析（纯函数，口径逐字照 resolveTokenCap）：
 * contract.budget.gateTimeoutMs 优先（进门现场解析——契约可能 run 中途才落册，晚于派单也生效），
 * 回落 env PF_GATE_TIMEOUT_MS（engine 构造时经 envInt 读成数字传入）；
 * 0/负数/NaN/缺失=该级关闭，两级都无效返回 null（不武装，门行为与今天完全一致）。
 */
export function resolveGateTimeoutMs(
  contract: RunContract | undefined,
  envGateTimeoutMs: number | undefined,
): number | null {
  const fromContract = contract?.budget?.gateTimeoutMs;
  if (legitGateTimeout(fromContract)) return fromContract;
  if (legitGateTimeout(envGateTimeoutMs)) return envGateTimeoutMs;
  return null;
}

/** 门时长人话格式：<60s 报秒，否则报分（一位小数）——固定句式的数字口径单一来源 */
function fmtGateDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 秒';
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${(ms / 60_000).toFixed(1)} 分`;
}

/**
 * v13-S4 到期 error 固定句式（status/watch 原样带出，watch 按红 1 归因）：
 * `等待审批超时，<时长>，不放行。`——恒含已等待/上限两个数，失败节点 error 的唯一超时
 * 文案，测试锁句式。引擎不代替人放行、不合成放行按键，都写死在这句话里。
 */
export function gateTimeoutMessage(waitedMs: number, capMs: number): string {
  return `等待审批超时，已等待 ${fmtGateDuration(waitedMs)}，上限 ${fmtGateDuration(capMs)}，不放行。`;
}

type RunListener = (run: RunRecord) => void;

/** Default artifact file for a node (node-scoped so shared-cwd branches don't clobber each other). */
function defaultArtifactFile(nodeId: string): string {
  return `.herdr/artifacts/${nodeId}.json`;
}

/**
 * v13-S1（D4 转正）：workspace label → runId 反解。两副形状同源：
 * 起单 `<prefix><spaceId>-<runId>`（startRun）、重试重建 `<prefix><runId>-r<attempts>`（splitPane not_found 路）。
 * runId 恒为 8 位 hex 且在 label 头部或尾部——解不出 runId 的前缀命中 label 按孤儿处理。
 */
function runIdFromLabel(prefix: string, label: string | null | undefined): string | null {
  if (!label || !label.startsWith(prefix)) return null;
  const rest = label.slice(prefix.length);
  const head = /^([0-9a-f]{8})(?:-r\d+)?$/.exec(rest);
  if (head) return head[1]!;
  const tail = /-([0-9a-f]{8})$/.exec(rest);
  return tail ? tail[1]! : null;
}

/**
 * Deterministic DAG execution engine on top of Herdr panes.
 * 拓扑序调度：无依赖关系的节点（fan-out 分支）并行执行，受全局 pane 并发上限约束；
 * fan-in 按 requireAll 严/宽收敛。
 */
export class Engine {
  private readonly runs = new Map<string, RunRecord>();
  private readonly rootPanes = new Map<string, string>();
  private readonly listeners = new Set<RunListener>();
  private readonly cancels = new Set<string>();
  private readonly blockedWaiters = new Map<string, (action: ApprovalAction) => void>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** Cross-run pane semaphore: the cap holds across ALL concurrent pipelines. */
  private readonly paneSlots: { acquired: number } = { acquired: 0 };
  private readonly paneWaiters: (() => void)[] = [];
  /** R3.1/R3.2 仓库占用登记：repoRoot → 占用者（runId + nodeId） */
  private readonly repoClaims = new Map<string, { runId: string; nodeId: string; key: string }>();
  /** R3.5 本引擎创建的 worktree（run 结束时尽力回收） */
  private readonly liveWorktrees: { runId: string; repo: string; path: string; branch: string }[] = [];
  /** G3 空间级轻队列：spaceKey → 待启 runId 的 FIFO */
  private readonly runQueues = new Map<string, string[]>();
  /** G3 排队 run 随身携带的启动参数（order/续跑黑板），出队即用；重启后从 graph 重算 */
  private readonly pendingLaunches = new Map<string, { order: string[]; preload?: Map<string, Artifact> }>();
  /** v11-D1：跨 run 共享的按网关主机在途并发闸（第三层限流，与 paneSlots/run 额度取交集） */
  private readonly gwGate: GwConcurrencyGate;
  private readonly gwBackoffBaseMs: number;
  private readonly gwThrottleRetries: number;
  /** v12-S2：env PF_RUN_MAX_TOKENS 解析后的兜底上限（0=关闭）；契约上限在比对现场再解析 */
  private readonly runMaxTokensEnv: number;
  /** v13-S4：env PF_GATE_TIMEOUT_MS 解析后的门到期上限（0=关闭）；契约上限在进门现场再解析 */
  private readonly gateTimeoutEnv: number;
  /**
   * v13-S4 外解唤醒计数（key=runId:nodeId）：armed（有超时）的门到期前被人工放行、
   * 且非经 sendKeys 模拟——单独记账，不混进 attention（那是人的决策账）、不是新协议。
   * 只增不删：默认关闭下无人进门记账，增长有界（每 run 每门一个整数）；权威账在 run.events。
   */
  private readonly externalReleases = new Map<string, number>();
  /** v13-S1：孤儿周期扫描间隔（<=0=关）与互斥位（一轮未跑完不起第二轮） */
  private readonly orphanSweepMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;
  /** v13-S1：正在收口关闭中的 workspaceId——终态转换与 closeWorkspace 之间的窗，周期扫描须绕行 */
  private readonly closingWorkspaces = new Set<string>();
  /** v13-S2 尝试内掐断幂等键（runId:nodeId:attempt）：同一轮尝试多个触发点连发只掐一次、只落一笔账 */
  private readonly interruptedAttempts = new Set<string>();
  /** v13-S1 worktree 根目录（泄漏清扫的扫描面） */
  private readonly wtRoot: string;

  constructor(
    private readonly ops: HerdrOps,
    private readonly store: Store,
    private readonly opts: EngineOptions,
  ) {
    this.gwGate = new GwConcurrencyGate({
      maxConcurrent: opts.gwMaxConcurrent ?? envInt('PF_GW_MAX_CONCURRENT', 2),
      tightenMs: Math.max(0, opts.gwTightenMs ?? envInt('PF_GW_TIGHTEN_MS', 15_000)),
      pollMs: opts.gwPollMs ?? 250,
    });
    this.gwBackoffBaseMs = Math.max(0, opts.gwBackoffBaseMs ?? envInt('PF_GW_BACKOFF_BASE_MS', 3_000));
    this.gwThrottleRetries = Math.max(0, opts.gwThrottleRetries ?? envInt('PF_GW_THROTTLE_RETRIES', 2));
    // v12-S2：env 兜底的 token 预算上限，构造时读一次（env 不热改）；契约 budget.maxTokens 优先
    this.runMaxTokensEnv = Math.max(0, opts.runMaxTokens ?? envInt('PF_RUN_MAX_TOKENS', 0));
    // v13-S4：env 兜底的门到期超时，同款口径；契约 budget.gateTimeoutMs 在每次进门现场再解析
    this.gateTimeoutEnv = Math.max(0, opts.gateTimeoutMs ?? envInt('PF_GATE_TIMEOUT_MS', 0));
    // v13-S1：孤儿周期扫描（缺省 300s，<=0 关）与 worktree 根
    this.orphanSweepMs = opts.orphanSweepMs ?? envInt('PF_ORPHAN_SWEEP_MS', 300_000);
    this.wtRoot = opts.worktreeRoot ?? path.join(os.tmpdir(), 'paneflow-wt');
    // surface past runs (from disk, across all spaces) in listings after boot.
    // Runs persisted as 'running' belong to a dead process — mark them
    // interrupted here; their workspaces are reclaimed by the orphan sweep
    // (index.ts 的 boot 回收 + v13-S1 起的周期扫描，label 反解轴上活跃 run 才认领)。
    for (const space of Store.listSpaces(store.root)) {
      for (const run of new Store(store.root, space.id).listRuns()) {
        if (run.state === 'running') {
          run.state = 'failed';
          run.finishedAt = run.finishedAt ?? new Date().toISOString();
          const paused: string[] = [];
          for (const rec of Object.values(run.nodes)) {
            if (rec.state === 'blocked') {
              // F2：审批等待不随重启蒸发——节点转 paused，审批上下文（blockedPrompt）保留；
              // herdr pane 已死，续跑走 A5 ⤴，重执行到该节点会再次弹出审批
              rec.state = 'paused';
              rec.error = '服务重启，审批等待已暂停：⤴ 续跑后重到此节点会再次请求审批';
              paused.push(rec.nodeId);
            } else if (['working', 'queued', 'starting', 'retrying'].includes(rec.state)) {
              rec.state = 'failed';
              rec.error = '服务重启，运行中断';
            }
          }
          if (paused.length) {
            (run.events ??= []).push({
              at: new Date().toISOString(),
              type: 'run',
              text: `服务重启：${paused.join('、')} 的审批等待转入暂停（⤴ 续跑可重新触达）`,
            });
          }
          try {
            new Store(store.root, space.id).saveRun(run);
          } catch (err) {
            // v13-S5：改判结果落不下去就是真丢账（内存改了、盘上还是 running）——
            // 计数由 Store.atomicWriteSync 记，这里只补一句人话进日志
            console.error(`[paneflow] boot 改判落盘失败 run=${run.runId}：${(err as Error).message}`);
          }
        }
        this.runs.set(run.runId, run);
      }
    }
    // G3：排队态跨重启复原——盘上 queued 的 run 按入队顺序重新排，随后放行使额度内自动开跑
    for (const r of [...this.runs.values()]
      .filter((r) => r.state === 'queued')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      this.enqueue(r.spaceId ?? 'default', r.runId);
    }
    for (const key of [...this.runQueues.keys()]) this.pumpQueue(key);
    // F3：轮询校对通电（PF_RECONCILE_MS<=0 时内部守卫视为关闭）
    this.startReconciler();
    // v13-S1：孤儿回收从「boot 一次性」升为「常驻周期扫描」——回收失败的「下一次扫描会重试」自此是真话
    this.startOrphanSweep();
  }

  /**
   * R3.3 启动前脏检查：对每个 agent 节点的 cwd（git 仓库）执行 status --porcelain，
   * 有未提交改动即拒绝启动并给出清单。非 git 目录跳过；PF_DIRTY_CHECK=0 可关闭。
   */
  private checkDirtyRepos(graph: DagGraph, cwd: string, spaceId?: string): string | null {
    if (process.env.PF_DIRTY_CHECK === '0') return null;
    const checked = new Set<string>();
    const dirty: string[] = [];
    for (const n of graph.nodes) {
      if (n.type !== 'agent') continue;
      const nodeCwd = n.config.cwd ? path.resolve(cwd, n.config.cwd) : cwd;
      const repo = gitRepoRoot(nodeCwd);
      if (!repo || checked.has(repo)) continue;
      checked.add(repo);
      const st = gitStatusPorcelain(repo);
      if (st) dirty.push(`${repo}（${st.split('\n').filter(Boolean).length} 个未提交变更）`);
    }
    if (!dirty.length) return null;
    return `工作区有未提交改动，拒绝启动（防止覆盖你的工作）：\n${dirty.join('\n')}\n提交或 stash 后重试；临时关闭请设置 PF_DIRTY_CHECK=0`;
  }

  /** Space-scoped store for persistence of a given run. */
  private storeFor(run: RunRecord): Store {
    return run.spaceId ? new Store(this.store.root, run.spaceId) : this.store;
  }

  /**
   * v11-D5（摩擦账 #13）：run 草稿目录 = <dataDir>/spaces/<space>/runs/drafts/<血缘根 runId>/。
   * align/受理等草稿型产物一律落这里，不再写用户工作区（cwd git status 保持干净，
   * 也不再把同仓下一次 startRun 的 R3.3 脏检查挡死）。与 runs/archive 同级，随 run 记录留存。
   */
  private ensureDraftDir(spaceId: string | undefined, runKey: string): string {
    const dir = path.join(this.store.root, 'spaces', spaceId ?? 'default', 'runs', 'drafts', runKey);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * v11-D5：沿 parentRunId 链上溯到血缘根 run——父子 run 共用一个草稿目录
   * （受理 run 写好 issue-draft.json，其 pipeline 子 run 的 align 才读得到同一份）。
   */
  private draftOwnerRunId(parentRunId?: string): string | undefined {
    let cur = parentRunId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const parent = this.runs.get(cur);
      if (!parent?.parentRunId) return cur;
      cur = parent.parentRunId;
    }
    return cur;
  }

  /** v9-D2：空间档案钉的网关档 id；未钉/读不到返回 undefined → 网关读侧回落全局 current 档 */
  private gatewayPinFor(run: RunRecord): string | undefined {
    try {
      return this.storeFor(run).readProfile().gatewayProfile || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * v11-D1：「该 run 走哪个网关」= 生效档（空间钉档优先）baseUrl 的主机键。
   * 未配/未启用网关、或 baseUrl 解析不了 → null（免闸）。
   */
  private gatewayHostFor(run: RunRecord): string | null {
    const pin = this.gatewayPinFor(run);
    if (!gatewayActive(this.store.root, pin)) return null;
    return gatewayHostOf(readGateway(this.store.root, pin).baseUrl);
  }

  /** v11-D1 诊断/测试：各网关主机闸的在途数与收紧窗截止时刻快照 */
  gwGateSnapshot(): Record<string, { active: number; cooldownUntil: number; streak: number }> {
    return this.gwGate.snapshot();
  }

  onChange(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /** R5.1 归档后从内存移除（记录已落盘 archive/） */
  evictRun(runId: string): void {
    this.runs.delete(runId);
  }

  /** v7-A2 反归档后回注内存（与 evictRun 对称；记录已是终态，不会被重新调度） */
  restoreRun(run: RunRecord): void {
    this.runs.set(run.runId, run);
  }

  /**
   * v13-S1（D4 转正）孤儿回收：boot 后一次 + 周期扫描（PF_ORPHAN_SWEEP_MS，缺省 300s，<=0 关）。
   * 认领轴从「run.workspaceId 相等」换成「label 反解 runId ∧ 仅活跃认领」——
   * 旧轴两处漏：workspaceId 被重试重建覆盖（splitPane not_found 路）后旧 ws 变隐身孤儿；
   * 且 map 里含终态 run，failed/cancelled 的 workspace 永远「被拥有」永不回收。
   * 保护：收口窗（closingWorkspaces）与互斥位（一轮未毕不起第二轮）；回收失败明说失败。
   * 顺手账：worktree 目录泄漏清扫（死掉的 run 留在全新尝试名下的残留）。
   */
  async recoverOrphans(): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      return await this.sweepOrphansOnce();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOrphansOnce(): Promise<string[]> {
    const reclaimed: string[] = [];
    const activeRunIds = new Set(
      [...this.runs.values()].filter((r) => ['running', 'queued'].includes(r.state)).map((r) => r.runId),
    );
    try {
      const workspaces = await this.ops.listWorkspaces();
      for (const w of workspaces) {
        if (!w.label?.startsWith(this.opts.workspaceLabelPrefix)) continue;
        if (this.closingWorkspaces.has(w.workspace_id)) continue; // 收口窗：正被终态流程关闭
        const ownerId = runIdFromLabel(this.opts.workspaceLabelPrefix, w.label);
        if (ownerId && activeRunIds.has(ownerId)) continue; // 仅活跃认领
        this.closingWorkspaces.add(w.workspace_id);
        try {
          await this.ops.closeWorkspace(w.workspace_id);
          reclaimed.push(w.workspace_id);
        } catch (err) {
          console.warn(`[engine] 孤儿 workspace 回收失败（下一轮扫描重试）：${w.workspace_id} — ${(err as Error).message}`);
        } finally {
          this.closingWorkspaces.delete(w.workspace_id);
        }
      }
    } catch (err) {
      // Herdr 离线/瞬断：不吞成静默——周期扫描下一轮会再来，但每次都要留痕
      console.warn(`[engine] 孤儿扫描本轮失败（下一轮 ${this.orphanSweepMs > 0 ? `${Math.round(this.orphanSweepMs / 1000)}s 后` : '无，周期扫描已关'}）：${(err as Error).message}`);
      return reclaimed;
    }
    try {
      this.sweepWorktreeLeaks(activeRunIds);
    } catch (err) {
      console.warn(`[engine] worktree 泄漏清扫失败：${(err as Error).message}`);
    }
    return reclaimed;
  }

  /**
   * v13-S1 顺手账（v5-audit:97）：worktree 目录只增不减的残留清扫。
   * 判据：目录名 `<runId8>-<nodeId>` 的 runId 无活跃 run 认领，且不在本引擎在活登记（liveWorktrees）里。
   * 干净 → `git worktree remove`；脏/认不出仓库 → 保留但明说（证据链不销毁，回收宁缺毋滥）。
   */
  private sweepWorktreeLeaks(activeRunIds: Set<string>): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.wtRoot);
    } catch {
      return; // 根目录不存在=从未有过 worktree
    }
    const registered = new Set(this.liveWorktrees.map((w) => w.path));
    for (const name of names) {
      const dir = path.join(this.wtRoot, name);
      if (registered.has(dir)) continue;
      const m = /^([0-9a-f]{8})-/.exec(name);
      if (!m) continue; // 非本器命名，不认不删
      if (activeRunIds.has(m[1]!)) continue;
      let gitdir: string;
      try {
        const head = fs.readFileSync(path.join(dir, '.git'), 'utf8');
        const gm = /^gitdir:\s*(.+)$/m.exec(head);
        if (!gm) continue;
        gitdir = gm[1]!.trim();
      } catch {
        continue; // 没有 .git 文件=不是 worktree 目录，别人的东西不碰
      }
      const repo = gitdir.split('/.git/worktrees/')[0];
      if (!repo) continue;
      try {
        if (gitStatusPorcelain(dir)) {
          console.warn(`[engine] worktree 泄漏清扫：脏目录保留（成果证据链）：${dir}`);
          continue;
        }
        execFileSync('git', ['-C', repo, 'worktree', 'remove', dir], { timeout: 15_000 });
        console.log(`[engine] worktree 泄漏已回收：${dir}`);
      } catch (err) {
        console.warn(`[engine] worktree 泄漏回收失败（保留）：${dir} — ${(err as Error).message}`);
      }
    }
    try {
      // 空根目录不留壳（有残余子项则 readdir 非空，rmdir 自然失败即弃）
      fs.rmdirSync(this.wtRoot);
    } catch {
      /* not empty or gone */
    }
  }

  /** v13-S1：周期孤儿扫描通电（PF_ORPHAN_SWEEP_MS<=0 视为关闭；照 startReconciler 的守卫形状） */
  private startOrphanSweep(): void {
    if (this.sweepTimer || this.orphanSweepMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      void this.recoverOrphans().then((reclaimed) => {
        if (reclaimed.length) console.log(`[engine] 周期孤儿扫描回收 ${reclaimed.length} 个 workspace：${reclaimed.join(', ')}`);
      });
    }, this.orphanSweepMs);
    this.sweepTimer.unref?.();
  }

  /**
   * v13-S6 优雅停机：掐 agent → 关 workspace → flush 账本（与 boot 对账同款处置）。
   * 只保证账本落到真实终态、资源不泄漏；不复活执行循环、不假装续跑——
   * 醒来后这些单走 boot 对账 + ⤴/--from-failed 既有恢复通道。
   */
  async shutdown(reason: string): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // 放掉所有卡在审批门上的执行循环（reject=人不在，判红不是判批）
    for (const [key, waiter] of [...this.blockedWaiters.entries()]) {
      this.blockedWaiters.delete(key);
      waiter({ action: 'reject' });
    }
    for (const run of [...this.runs.values()]) {
      if (!['running', 'queued'].includes(run.state)) continue;
      this.cancels.add(run.runId);
      // v13-S2/S6 合流：停机掐 agent 复用同一掐断共用函数（旧实现只裸发 escape 不落账；
      // 现统一 escape→ctrl+c 序列 + abandonments 结构化落册，停机序列语义「掐→关→flush」不变）
      const interrupts = Object.values(run.nodes)
        .filter((rec) => rec.agentName && ['working', 'blocked', 'starting', 'retrying'].includes(rec.state))
        .map((rec) => this.interruptAttemptAgent(run, rec, 'shutdown'));
      await Promise.allSettled(interrupts);
      for (const rec of Object.values(run.nodes)) {
        if (['working', 'blocked', 'queued', 'starting', 'retrying'].includes(rec.state)) {
          rec.state = 'failed';
          rec.error = `服务退出（${reason}），运行中断`;
        }
      }
      run.state = 'failed';
      run.finishedAt = run.finishedAt ?? new Date().toISOString();
      this.recordEvent(run, 'run', undefined, `服务退出（${reason}）：在飞单就地结算落册，恢复走 ⤴/--from-failed`);
      if (run.workspaceId) {
        const id = run.workspaceId;
        this.closingWorkspaces.add(id);
        try {
          await this.ops.closeWorkspace(id);
        } catch (err) {
          console.warn(`[engine] 停机关 workspace 失败（留给孤儿扫描）：${id} — ${(err as Error).message}`);
        } finally {
          this.closingWorkspaces.delete(id);
        }
      }
      this.rootPanes.delete(run.runId);
      this.persistAndNotify(run);
    }
  }

  async startRun(
    graph: DagGraph,
    cwd: string,
    spaceId?: string,
    variables?: Record<string, string>,
    issueId?: string,
    resumeOf?: string,
    /** M2：机检契约随单落册（input 模式）；generated 模式由引擎在产物提取时捕获 */
    opts?: {
      contract?: RunContract;
      parentRunId?: string;
      /** v11-E1a：replay 显式发起的豁免声明——只穿透 R3.4 同 issue 幂等锁，锁本体对普通下发一丝不变 */
      replay?: { of: string };
      /** v11-E1b：实验元数据（只作标注与过滤，不参与任何编排判定） */
      experiment?: RunExperimentMeta;
    },
  ): Promise<RunRecord> {
    // R3.4 同 issue 幂等锁：同空间同 issue 已有运行中/排队中的流水线时拒绝重复下发（G3 起含 queued，批量派发不重复入队）
    // 首驾-2：排除本 run 的祖先链——派发父 run 带 issueId，其 pipeline 子 run 透传同 issue 是血缘不是重复下发，
    // 旧实现父撞子自己 = 100% 自我死锁（route 节点必炸「Issue 6 已有运行中/排队中的流水线（run 39dd3f22）」）。
    // v11-E1a：唯一豁免口=opts.replay（replayRun 显式发起），豁免的是同 issue 重复单本身，其余校验一条不少。
    if (issueId && !opts?.replay) {
      const lineage = new Set<string>();
      for (let p = opts?.parentRunId; p && !lineage.has(p); p = this.runs.get(p)?.parentRunId) lineage.add(p);
      const dup = [...this.runs.values()].find(
        (r) => ['running', 'queued'].includes(r.state) && r.issueId === issueId && (r.spaceId ?? 'default') === (spaceId ?? 'default') && !lineage.has(r.runId),
      );
      if (dup) {
        throw new Error(`Issue ${issueId} 已有运行中/排队中的流水线（run ${dup.runId}），如需重跑请先停止它`);
      }
    }
    // R3.3 启动前脏检查：git 仓库有未提交改动时拒绝（不覆盖用户工作区）
    const dirtyErr = this.checkDirtyRepos(graph, cwd, spaceId);
    if (dirtyErr) throw new Error(dirtyErr);
    // H1：runId 先行生成——内置变量 run_id 注入模板（交付分支名 pf/<run_id> 与守卫期望同源）
    const runId = randomUUID().slice(0, 8);
    // v11-D5：内置变量 draft_dir——dataDir 下的 run 草稿目录（模板声明后才替换，与 run_id 同机制）；
    // 显式传同名 variables 可覆盖（留调试后门），默认父子 run 共享血缘根目录
    const draftDir = this.ensureDraftDir(spaceId, this.draftOwnerRunId(opts?.parentRunId) ?? runId);
    const applied = applyVariables(graph, { run_id: runId, draft_dir: draftDir, ...variables });
    if (applied.missing.length) {
      throw new Error(`缺少必填参数：${applied.missing.join('、')}`);
    }
    graph = applied.graph;
    const issues = validateDag(graph);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      throw new Error(`DAG 校验失败：${errors.map((e) => e.message).join('；')}`);
    }
    // G2 引用失败可见：applyVariables 后仍残留的 {{}} 是未声明变量或坏节点引用——
    // 不拦跑（与 B2 必填校验互补），但以 warn 事件上时间线，静默事故变可见事故
    const unresolved = lintUnresolvedRefs(graph);
    if (graph.nodes.some((n) => n.type === 'fanout' || n.type === 'fanin')) {
      for (const n of graph.nodes) {
        if (n.type === 'fanin' && n.config.onFail) {
          throw new Error('Fan-in 汇聚节点请使用 requireAll 配置而非 onFail');
        }
      }
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`工作目录不存在：${cwd}`);
    }

    // R6.5 断点续跑：源校验必须在创建 run 之前，否则抛错会留下僵尸 running 记录
    let resumeSource: RunRecord | undefined;
    if (resumeOf) {
      const srcStore = spaceId ? new Store(this.store.root, spaceId) : this.store;
      const source = srcStore.getRun(resumeOf);
      if (!source || source.dagName !== graph.name) {
        throw new Error(`断点续跑源无效：${resumeOf}（不存在或模板不一致）`);
      }
      resumeSource = source;
    }

    const order = topoSort(graph.nodes.map((n) => n.id), graph.edges)!;
    // I2 上次经验自动注入 v0（仅变量层——B1 黑板别名未做前不碰产物层）：
    // 同空间+同模板存在绿 run 时，把其「实填变量+断言清单+成本画像」附入
    // 执行序首个 agent 节点的 prompt；透明性红线——run 事件明示注入了什么
    const experience = resumeOf ? null : this.findGreenPredecessor(spaceId, graph.name);
    let expNodeTarget: string | undefined;
    if (experience) {
      const expNodeId = order.find((id) => {
        const n = graph.nodes.find((x) => x.id === id);
        return n?.type === 'agent' && Boolean(n.config.prompt);
      });
      const expNode = expNodeId ? graph.nodes.find((x) => x.id === expNodeId) : undefined;
      if (expNode) {
        expNode.config.prompt = `${expNode.config.prompt}\n\n${Engine.buildExperienceBlock(experience)}`;
        expNodeTarget = expNode.id;
      }
    }
    // v11-C3a wiki 读回注入：plan/impl 类 agent 节点起笔前，把目标仓本地 llm-wiki/ 缓存
    // 里词面相关的 top-k 摘录附进 prompt 尾部。只读现成缓存（零网络），缺仓/缺缓存静默跳过；
    // 必须在 RunRecord 创建前做——graph 会被 structuredClone 进记录，留痕与实注入同源。
    const wikiReadback = this.planWikiReadback(graph, cwd, opts?.contract?.repo);
    const nodes: Record<string, NodeRunRecord> = {};
    for (const n of graph.nodes) {
      nodes[n.id] = { nodeId: n.id, state: 'pending', attempts: 0 };
    }
    const run: RunRecord = {
      runId,
      dagName: graph.name,
      graph: structuredClone(graph),
      state: 'running',
      cwd,
      ...(spaceId ? { spaceId } : {}),
      ...(issueId ? { issueId } : {}),
      ...(opts?.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      nodes,
      startedAt: new Date().toISOString(),
      ...(variables && Object.keys(variables).length ? { variables: { ...variables } } : {}),
      ...(opts?.contract ? { contract: opts.contract } : {}),
      ...(wikiReadback ? { wikiReadback } : {}),
      // v11-E1a/b：replay 血缘与实验标注（缺省=普通单，两键省略）
      ...(opts?.replay ? { replayOf: opts.replay.of } : {}),
      ...(opts?.experiment ? { experiment: opts.experiment } : {}),
    };
    // v12-V1 harness 披露：起单时把「本单实发配置」一次性固化进 run 头（写一次即成历史）。
    // graphSha 算的是上面已 structuredClone 的 run.graph——变量替换、I2 经验注入、C3a
    // 读回注入全部在 clone 之前同步完成（读回只在 clone 后有异步刷缓存旁路，不再改 graph），
    // 所以指纹就是实发终态；agentKind 是 AE 解析链对执行序首个 agent 节点的一次性入口
    // 结果（以往每试现算不写回）；gwProfile/model 起单现读，拿不到键即缺省——绝不估算
    // （与 cost.tokens 的 null 原则同款）。
    try {
      run.harness = await this.buildRunHarness(run, order);
    } catch {
      // 防御（读回同款姿势）：披露旁账不许把起跑挡下来，最坏这单缺 harness 字段
    }
    this.runs.set(runId, run);
    this.recordEvent(run, 'run', undefined, `运行启动：${graph.name}（${order.length} 个节点）`);
    if (experience && expNodeTarget) {
      this.recordEvent(
        run,
        'run',
        expNodeTarget,
        `经验注入（I2 v0，仅变量层）：沿用同模板绿 run ${experience.runId} 的实填变量/断言 ${experience.contract?.assertions.length ?? 0} 条/成本画像，已附入「${expNodeTarget}」上下文；全局关闭=项目档案 experienceInjection=false`,
      );
    }
    if (wikiReadback) {
      const detail = wikiReadback.nodes
        .map((n) => `${n.nodeId}←${n.pages.map((p) => p.file).join('、')}`)
        .join('；');
      this.recordEvent(
        run,
        'run',
        undefined,
        `沉淀读回（C3a）：目标仓 ${wikiReadback.repo} 的本地 llm-wiki 缓存已注入 ${wikiReadback.nodes.length} 个节点（${detail}）；开关=env PF_WIKI_READBACK`,
      );
    }
    // v11-E1：透明性红线——豁免/血缘/实验都必须上时间线，事后从事件能 recon 出这单怎么来的
    if (opts?.replay) {
      this.recordEvent(
        run,
        'run',
        undefined,
        `复跑 replay（E1a）：源自 run ${opts.replay.of}，同契约重发（穿透 R3.4 同 issue 锁，仅 replay 显式发起）${opts.experiment?.suite ? ` · 实验 ${opts.experiment.suite}${opts.experiment.arm ? `/臂 ${opts.experiment.arm}` : ''}` : ''}`,
      );
    }
    if (unresolved.length) {
      const detail = unresolved.slice(0, 6).map((u) => `${u.where} 的 ${u.ref}`).join('、');
      this.recordEvent(
        run,
        'run',
        undefined,
        `⚠ 引用未解析 ${unresolved.length} 处（花括号将原样进提示词——核对变量声明与节点名）：${detail}${unresolved.length > 6 ? ' 等' : ''}`,
      );
    }
    this.persistAndNotify(run);

    // 继承 done 节点的记录与产物（这些节点不再执行）
    const blackboardPreload = new Map<string, Artifact>();
    if (resumeSource) {
      const orderSet = new Set(order);
      let inherited = 0;
      for (const [nodeId, srcRec] of Object.entries(resumeSource.nodes)) {
        if (!orderSet.has(nodeId) || srcRec.state !== 'done') continue;
        const rec = run.nodes[nodeId]!;
        Object.assign(rec, {
          ...srcRec,
          nodeId,
          state: 'done' as const,
          finishedAt: srcRec.finishedAt,
        });
        if (srcRec.artifact) {
          blackboardPreload.set(nodeId, srcRec.artifact);
          // v12-S2：done 节点继承时把其自报 usage 也带进实时账——续跑单的预算比对
          // 不欠账（与收口 computeRunCost 扫产物同口径）
          this.bookArtifactUsage(run, nodeId, srcRec.artifact);
        }
        inherited += 1;
      }
      if (inherited) {
        this.recordEvent(run, 'run', undefined, `断点续跑：继承 ${resumeOf} 的 ${inherited} 个已完成节点`);
      }
      // M2：续跑沿用同一份契约（除非本次显式给了新的）
      if (resumeSource.contract && !run.contract) run.contract = structuredClone(resumeSource.contract);
    }
    this.persistAndNotify(run);

    // Fire and forget — the HTTP layer returns the runId immediately and the
    // canvas follows state over WebSocket.
    // G3 空间级轻队列：并发达上限即排队待启（profile.maxConcurrentRuns 可配，
    // 默认=营地上限），额度腾出自动出队——批量派发不再冲垮营地
    this.pendingLaunches.set(runId, { order, preload: blackboardPreload });
    const spaceKey = spaceId ?? 'default';
    if (this.activeRunCount(spaceKey, runId) >= this.runCapFor(spaceKey)) {
      run.state = 'queued';
      this.enqueue(spaceKey, runId);
      this.recordEvent(
        run,
        'run',
        undefined,
        `排队中：项目并发 run 上限 ${this.runCapFor(spaceKey)} 已占满，位次 ${this.runQueues.get(spaceKey)!.length}，出队即启`,
      );
      this.persistAndNotify(run);
    } else {
      this.launch(run);
    }
    return run;
  }

  /** G3：真正点火一个 run（startRun 直通与出队放行共用此入口） */
  private launch(run: RunRecord): void {
    const pending = this.pendingLaunches.get(run.runId);
    this.pendingLaunches.delete(run.runId);
    const order =
      pending?.order ?? topoSort(run.graph.nodes.map((n) => n.id), run.graph.edges) ?? run.graph.nodes.map((n) => n.id);
    void this.execute(run, order, pending?.preload).catch((err) => {
      run.state = 'failed';
      run.finishedAt = new Date().toISOString();
      this.persistAndNotify(run);
      this.pumpQueue(run.spaceId ?? 'default'); // 点火即炸也要放行队列，不留僵尸额度
      console.error(`[engine] run ${run.runId} crashed:`, err);
    });
  }

  private activeRunCount(spaceKey: string, excludeRunId?: string): number {
    return [...this.runs.values()].filter(
      (r) => r.state === 'running' && r.runId !== excludeRunId && (r.spaceId ?? 'default') === spaceKey,
    ).length;
  }

  /** G3 并发 run 上限：空间档案 maxConcurrentRuns 优先，缺省回落营地上限（maxConcurrentPanes） */
  private runCapFor(spaceKey: string): number {
    try {
      const n = new Store(this.store.root, spaceKey).readProfile().maxConcurrentRuns;
      if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.floor(n);
    } catch {
      // profile unreadable → default cap
    }
    return Math.max(1, this.opts.maxConcurrentPanes ?? 8);
  }

  private enqueue(spaceKey: string, runId: string): void {
    const q = this.runQueues.get(spaceKey);
    if (q) q.push(runId);
    else this.runQueues.set(spaceKey, [runId]);
  }

  /** G3：额度有空位就放行一个排队 run（每次最多放行 1 个，FIFO） */
  private pumpQueue(spaceKey: string): void {
    const q = this.runQueues.get(spaceKey);
    if (!q?.length) return;
    if (this.activeRunCount(spaceKey) >= this.runCapFor(spaceKey)) return;
    let nextId: string | undefined;
    while (q.length) {
      const id = q.shift()!;
      const r = this.runs.get(id);
      if (r && r.state === 'queued') {
        nextId = id;
        break;
      }
      this.pendingLaunches.delete(id); // 已取消/失踪的排队项：清掉随行参数
    }
    if (!nextId) return;
    const run = this.runs.get(nextId)!;
    run.state = 'running';
    this.recordEvent(run, 'run', undefined, '出队启动：并发额度腾出，排队放行');
    this.persistAndNotify(run);
    this.launch(run);
  }

  /**
   * N3 排队可见：额度上限 + 占用者 + 队列位次（任务卡据此渲染等待原因与可动按钮）。
   * title 与运行卡标题同源：描述 > Issue 编号 > 骨架名。
   */
  queueStatus(spaceId?: string): {
    cap: number;
    running: { runId: string; title: string }[];
    queued: { runId: string; title: string; position: number }[];
  } {
    const spaceKey = spaceId ?? 'default';
    const titleOf = (r: RunRecord) =>
      r.graph.metadata?.description?.trim() || (r.issueId ? `Issue #${r.issueId}` : r.dagName);
    const q = this.runQueues.get(spaceKey) ?? [];
    const queuedIds = q.filter((id) => this.runs.get(id)?.state === 'queued');
    return {
      cap: this.runCapFor(spaceKey),
      running: [...this.runs.values()]
        .filter((r) => r.state === 'running' && (r.spaceId ?? 'default') === spaceKey)
        .map((r) => ({ runId: r.runId, title: titleOf(r) })),
      queued: queuedIds.map((id, i) => ({ runId: id, title: titleOf(this.runs.get(id)!), position: i + 1 })),
    };
  }

  /** N3 排队可动：提到队首插队；恰有空额则立即点火。不在队列（已开跑/已取消）返回 false */
  promoteRun(runId: string): boolean {
    for (const [spaceKey, q] of this.runQueues) {
      const i = q.indexOf(runId);
      if (i < 0) continue;
      const run = this.runs.get(runId);
      if (!run || run.state !== 'queued') return false;
      q.splice(i, 1);
      q.unshift(runId);
      this.recordEvent(run, 'run', undefined, `提到队首：原位次 ${i + 1} → 1（插队需对后果负责——前面各单主人可见）`);
      this.persistAndNotify(run);
      this.pumpQueue(spaceKey);
      return true;
    }
    return false;
  }

  /**
   * I2：找同空间+同模板最近一次绿 run（归档的也算——历史即经验）。
   * 全局关：项目档案 experienceInjection=false（缺省开）。
   */
  private findGreenPredecessor(spaceId: string | undefined, dagName: string): RunRecord | null {
    try {
      const profile =
        spaceId && spaceId !== this.store.spaceId
          ? new Store(this.store.root, spaceId).readProfile()
          : this.store.readProfile();
      if (profile.experienceInjection === false) return null;
    } catch {
      // 档案不可读 = 默认开
    }
    let best: RunRecord | null = null;
    for (const r of this.runs.values()) {
      // 经验注入只认全绿 completed；v11-D3 的 completed-with-failures 有失败节点，不算绿
      if (r.state !== 'completed' || r.dagName !== dagName) continue;
      if ((r.spaceId ?? 'default') !== (spaceId ?? 'default')) continue;
      if (!best || (r.finishedAt ?? r.startedAt) > (best.finishedAt ?? best.startedAt)) best = r;
    }
    return best;
  }

  /** I2 经验块（仅变量层）：实填变量 + 断言清单 + 成本画像；剥 {{}} 防污染运行期插值 */
  static buildExperienceBlock(prev: RunRecord): string {
    const safe = (s: string) => s.replace(/\{\{|\}\}/g, '').slice(0, 160);
    const vars = Object.entries(prev.variables ?? {});
    const varLine = vars.length ? vars.map(([k, v]) => `${k}=${safe(v)}`).join('；') : '（无实填变量记录）';
    const acs = prev.contract?.assertions ?? [];
    const acBlock = acs.length
      ? acs.map((a) => `  - ${safe(a.id)}：${safe(a.assertion)}`).join('\n')
      : '  （该单无在册契约）';
    const c = prev.cost;
    const costLine = c
      ? `总耗时 ${(c.totalMs / 60_000).toFixed(1)} 分、重试 ${c.retries} 次、tokens ${
          c.tokens ? `in ${c.tokens.input}/out ${c.tokens.output}` : '未知（agent 未自报）'
        }`
      : '未知（无成本记录）';
    return [
      `【上次经验 · I2 自动注入，仅变量层】同空间同模板（${safe(prev.dagName)}）的绿 run ${prev.runId}` +
        `${prev.finishedAt ? `（完成于 ${prev.finishedAt.slice(0, 16).replace('T', ' ')}）` : ''}：`,
      `· 当时实填变量：${varLine}`,
      `· 当时的断言清单（措辞与颗粒度可借鉴；本单以自身契约为准）：`,
      acBlock,
      `· 成本画像：${costLine}`,
      `——以上是历史经验参考，不是本单需求；不要因为「上次这么干过」就照抄路径。`,
    ].join('\n');
  }

  /**
   * v11-C3a：wiki 读回注入（照 I2 同款姿势——startRun 前对 graph 节点 prompt 动刀）。
   * 与 I2 的差别：经验块进首个 agent 节点、全局一份；读回块进每个 plan/impl 类节点、
   * 按各节点任务词面各挑各的 top-k。返回注入留痕（RunRecord.wikiReadback，C3b 数据源）。
   */
  private planWikiReadback(graph: DagGraph, cwd: string, contractRepo?: string): WikiReadbackTrace | undefined {
    try {
      if (!readbackEnabled(this.opts.wikiReadback)) return undefined;
      const repo = resolveRunRepo({
        cwd,
        contractRepo,
        defaultRepo: readGithubSettings(this.store.root).defaultRepo,
      });
      if (!repo) return undefined;
      // 起跑异步刷一次缓存（唯一触网路径，失败静默）：本次吃现成的，下次吃新鲜的
      void this.refreshWikiReadbackCache(repo);
      const pages = loadReadbackPages(this.store.root, repo);
      if (!pages.length) return undefined;
      const traceNodes: WikiReadbackTrace['nodes'] = [];
      for (const n of graph.nodes) {
        if (!isReadbackTarget(n)) continue;
        const ranked = rankReadbackPages(pages, readbackQuery(n));
        if (!ranked.length) continue;
        const { block, used } = buildReadbackBlock(ranked);
        if (!block) continue;
        n.config.prompt = `${n.config.prompt}\n\n${block}`;
        traceNodes.push({ nodeId: n.id, pages: used.map((p) => ({ file: p.file, title: p.title })) });
      }
      return traceNodes.length ? { repo, nodes: traceNodes } : undefined;
    } catch {
      // 读回是纯加分项：任何意外都不许把 run 起跑挡下来
      return undefined;
    }
  }

  /** 同仓刷新去重（在途即不再起第二个 clone/fetch）；测试注入 wikiCacheRefresh 以避开真实网络 */
  private readonly wikiRefreshing = new Set<string>();

  private async refreshWikiReadbackCache(repo: string): Promise<void> {
    if (this.wikiRefreshing.has(repo)) return;
    this.wikiRefreshing.add(repo);
    try {
      await (this.opts.wikiCacheRefresh ?? makeWikiCacheRefresher(this.store.root))(repo);
    } catch {
      // 静默：刷不动就继续吃旧缓存
    } finally {
      this.wikiRefreshing.delete(repo);
    }
  }

  /**
   * v11-E1a 同契约 replay：取原 run 在册的 graph 快照与实填变量重新 startRun——
   * 「同契约」是照本宣科（复跑的就是当时落册的那一单）。豁免只开在 R3.4 同 issue
   * 幂等锁上（opts.replay 声明），其余门（脏检查/DAG 校验/cwd/变量必填）一条不少。
   * 已知限制：I2/C3a 注入照跑（当时注入进的是在册 graph 的字面量，新单还会各得一份
   * 新注入）——实验若在意，同 suite 各臂承受同等注入，A/B 差值仍读得出。
   * v12-S1b：源 run 带在册副作用（含 prUrl）且未显式放行（allowSideEffects）→ 起单前
   * 拒绝。评审 R5 口径：这道门只卡 replay 显式路，且 withSideEffects 穿透不开其余任何
   * 门（脏检查/锁豁免边界等语义一丝不动）。
   * v12-S3：fromFailed=true 时接上既有 resume 通道（startRun 第 7 参 resumeOf）——
   * done 节点继承不重跑（天然不二次 push），只重放失败/未执行节点。resume 校验段
   * （见 startRun R6.5 处）对源 run 无终态要求，只要求存在且同模板；注意与整单 replay
   * 的一处语义差：带 resumeOf 的起单按既有行为跳过 I2 经验注入。
   */
  async replayRun(
    runId: string,
    meta?: RunExperimentMeta,
    opts?: { allowSideEffects?: boolean; fromFailed?: boolean },
  ): Promise<RunRecord> {
    const source = this.runs.get(runId) ?? undefined;
    if (!source) throw new Error(`找不到要 replay 的原 run：${runId}`);
    // v12-S1b 副作用感知门禁：判据只看落册账（不靠事件推导）；旧 run 无 sideEffects
    // 但已有 prUrl 在册的，把 prUrl 并进判据视图（读结构化字段，非推导）。
    const se: RunSideEffects = { ...source.sideEffects, ...(source.prUrl ? { prUrl: source.prUrl } : {}) };
    const seNotes = sideEffectsSummary(se);
    if (hasSideEffects(se) && !opts?.allowSideEffects) {
      throw new Error(
        `源 run ${source.runId} 有副作用（${seNotes.join(' · ')}）——直接重放会二次副作用\n` +
          `显式穿透加 --allow-side-effects；只重跑失败/未执行节点加 --from-failed`,
      );
    }
    const run = await this.startRun(
      structuredClone(source.graph),
      source.cwd,
      source.spaceId,
      source.variables ? structuredClone(source.variables) : undefined,
      source.issueId,
      // v12-S3：--from-failed 走 resume 通道（done 继承+调度跳过），其余 replay 语义不变
      opts?.fromFailed ? source.runId : undefined,
      {
        ...(source.contract ? { contract: structuredClone(source.contract) } : {}),
        replay: { of: source.runId },
        ...(meta && (meta.suite || meta.arm || meta.flag) ? { experiment: meta } : {}),
      },
    );
    // v12-S1b 透明性红线：穿透必须上时间线，事后能从新单事件 recon 出带了哪些旧副作用
    if (seNotes.length) {
      this.recordEvent(
        run,
        'run',
        undefined,
        `带副作用复跑（S1b 穿透）：原 run ${source.runId} 副作用清单 ${seNotes.join(' · ')}；` +
          (opts?.fromFailed
            ? '本单走 --from-failed（done 节点不重跑），失败/未执行节点重放仍可能触及其外部写'
            : '本单全量重放，外部写会二次发生'),
      );
      this.persistAndNotify(run);
    }
    // v12-V1 replay 漂移比对（评审 R5：只落透明性事件不拦）：model/钉档两个闸口，
    // 新单起单现读值与原 run.harness 不一致即实验两臂档位已变的机器证据；
    // graphSha 不比对（replay 复用原在册 graph，恒等）；原记录无 harness=旧单，不发。
    const diffs = harnessDriftDiffs(source.harness, run.harness);
    if (diffs.length) {
      this.recordEvent(
        run,
        'run',
        undefined,
        `harness 漂移（V1）：复跑时档位/模型与原 run ${source.runId} 已变——${diffs.join(' · ')}；只记事件不拦停，实验要等臂请先对齐网关再复跑`,
      );
      this.persistAndNotify(run);
    }
    return run;
  }

  stopRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    // G3：排队中未开跑的 run 直接撤回（无 pane 可断，取消即终态）
    if (run.state === 'queued') {
      const q = this.runQueues.get(run.spaceId ?? 'default');
      if (q) {
        const i = q.indexOf(runId);
        if (i >= 0) q.splice(i, 1);
      }
      this.pendingLaunches.delete(runId);
      run.state = 'cancelled';
      run.finishedAt = new Date().toISOString();
      this.recordEvent(run, 'run', undefined, '取消排队：尚未开跑即撤回');
      this.persistAndNotify(run);
      return true;
    }
    if (run.state !== 'running') return false;
    this.cancels.add(runId);
    this.recordEvent(run, 'run', undefined, '收到停止指令：中断运行中的 Agent 并回收');
    this.persistAndNotify(run);
    // unblock any node waiting for approval so the loop can exit
    for (const [key, waiter] of [...this.blockedWaiters.entries()]) {
      if (key.startsWith(`${runId}:`)) {
        this.blockedWaiters.delete(key);
        waiter({ action: 'reject' });
      }
    }
    // v12-V2：取消经 waiter 直接放行，不走 approve() 的结算口——撤销不是人的门决策，
    // 绝不入账（红线）；进门时刻就地清空，防残留时刻被后续轮次误结。
    for (const rec of Object.values(run.nodes)) rec.blockedAt = undefined;
    // v13-S2 触发点 (c)：取消/停止——旧实现在这里内联「escape→300ms→ctrl+c」，现复用
    // 同一掐断共用函数（键序列一字不差），额外把掐断事实结构化落 rec.abandonments。
    // 状态过滤保持旧口径（working/blocked/starting），行为不得退化。
    for (const rec of Object.values(run.nodes)) {
      if (!rec.agentName || !['working', 'blocked', 'starting'].includes(rec.state)) continue;
      void this.interruptAttemptAgent(run, rec, 'stop');
    }
    return true;
  }

  /**
   * v13-S2 尝试边界掐断（唯一实现）：「一次节点尝试到此为止，别让它的 agent 继续活着」。
   * 旧实现只在 stopRun 有这一段动作，重试直接另起一轮——上一轮 pane 里的 agent 还在
   * 吃 prompt 烧钱（双跑账）。零新协议动词：只做既有逃逸键序列（escape 关对话框 →
   * ctrl+c 打断回合）；workspace/pane 回收沿用各触发点既有动作（本函数不越权关人）。
   * 掐断事实结构化落 rec.abandonments（哪一轮、什么触发点、掐的是什么状态）——
   * S2 红线：不靠环形 events 人话字符串推导。
   * 尝试内幂等：settle 超时掐过后紧接着进重试，同一轮只掐一次（第二个触发点空手而归）。
   * 永不 reject：任何观测/送键失败都静默降级，不许反噬触发点主流程。
   */
  private async interruptAttemptAgent(
    run: RunRecord,
    rec: NodeRunRecord,
    trigger: NodeAbandonmentTrigger,
  ): Promise<void> {
    if (!rec.agentName) return; // agent 从未起成——没东西可掐，也不落假账
    const agentName = rec.agentName;
    const key = `${run.runId}:${rec.nodeId}:${rec.attempts}`;
    if (this.interruptedAttempts.has(key)) return;
    this.interruptedAttempts.add(key);
    let observed: AgentStatus | 'unknown' = 'unknown';
    try {
      observed = (await this.ops.getAgentStatus(agentName)) ?? 'unknown';
    } catch {
      // 状态读不到照掐——账上记 unknown，绝不估算
    }
    try {
      await this.ops.sendKeys(agentName, ['escape']);
      await sleep(300);
      await this.ops.sendKeys(agentName, ['ctrl+c']);
    } catch {
      // agent 可能已没/pane 已碎：逃逸键送不到不算掐断失败，账照落
    }
    (rec.abandonments ??= []).push({
      at: new Date().toISOString(),
      attempt: rec.attempts,
      trigger,
      agentStatus: observed,
      agentName,
    });
    this.persistAndNotify(run);
  }

  /** Human approval for a blocked node. */
  async approve(runId: string, nodeId: string, action: ApprovalAction): Promise<boolean> {
    const key = `${runId}:${nodeId}`;
    const waiter = this.blockedWaiters.get(key);
    if (!waiter) return false;
    this.blockedWaiters.delete(key);
    const run = this.runs.get(runId);
    if (run) {
      this.recordEvent(
        run,
        'approval',
        nodeId,
        action.action === 'reject'
          ? '人工拒绝：终止本次执行'
          : action.action === 'input'
            ? '人工补充指令'
            : '人工放行：继续执行',
      );
      // v12-V2 人介入结算（放门即入账）：进门→放门的差累进 waitMs、对应决策计数 +1。
      // 进门时刻不可考（旧 run 存量路/重启后残留）→ 只计次不加时长，绝不造数；
      // 不做收口时从 events 重算（评审 R4）。多轮进出门（input 谈完再拦）逐次累加合法。
      const rec = run.nodes[nodeId];
      run.attention = bookGateRelease(run.attention, action.action, rec?.blockedAt, Date.now());
      if (rec) rec.blockedAt = undefined;
      this.persistAndNotify(run);
    }
    waiter(action);
    return true;
  }

  isBlocked(runId: string, nodeId: string): boolean {
    return this.blockedWaiters.has(`${runId}:${nodeId}`);
  }

  /**
   * v13-S4 唯一门实现：收编七处裸 `new Promise<ApprovalAction>` 的人工门
   * （运行中对话框 / 澄清轮 / 人工检查 / 验收机器门 / 契约门 / 分支守卫 / 启动确认）。
   * 只管「进门登记 waiter + 三态出路」；Promise 之外的前后处理（blockedAt 进门留痕、
   * blockedPrompt、拦侧事件、attention 结算、放门按键、产物复读）一律留在调用方——
   * 不塞进来，避免七门行为漂移。
   * 出路判据：
   * - waiter 被唤醒时 cancels 已置位 → cancelled（stopRun 先置位再插话；与调用方
   *   「await 后先查 cancels」的旧口径同构）；否则 released。
   * - released 且本门被武装（有超时上限）→ 外解唤醒：单记 externalRelease（run 级计数落册
   *   + 内存 per-node 细账 + 一条带 nodeId 的 approval 事件）。严禁在这里 sendKeys 模拟
   *   按键——放门后的实发键仍归各门调用方。
   * - 定时器先到期 → timeout：waiter 就地除名（isBlocked 转 false，迟到的 approve 得 409，
   *   attention 永不再经这笔结算）；进门时刻同步清空（与取消唤醒同款卫生——到期不是人的
   *   决策，绝不入 attention.gates、不把 waitMs 结算进「人等分」，v12-V2 红线）。
   * 定时器卫生：unref + 门醒即清（先出者胜，双出路不会重入），run 收口不留活定时器。
   */
  private awaitGate(run: RunRecord, nodeId: string): Promise<GateResult> {
    const key = `${run.runId}:${nodeId}`;
    const capMs = resolveGateTimeoutMs(run.contract, this.gateTimeoutEnv);
    return new Promise<GateResult>((resolve) => {
      const enteredAt = Date.now();
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      const finish = (res: GateResult): void => {
        if (settled) return; // 人放 / 取消插话 / 到期三方先到先得，之后另一路一律静默
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(res);
      };
      this.blockedWaiters.set(key, (action) => {
        if (this.cancels.has(run.runId)) {
          finish({ outcome: 'cancelled', action });
          return;
        }
        if (capMs !== null) {
          const n = (this.externalReleases.get(key) ?? 0) + 1;
          this.externalReleases.set(key, n);
          // 落册一份总额：per-node 细账在这条 approval 事件里，但 run.events 是 500 条环形
          // （见 recordEvent）——长单一挤就丢账，故计数本身结构化落 RunRecord（S2 同片裁决）。
          run.externalReleases = (run.externalReleases ?? 0) + 1;
          this.recordEvent(
            run,
            'approval',
            nodeId,
            `外解唤醒（S4）：超时门（上限 ${fmtGateDuration(capMs)}）到期前被人工放行（本节点第 ${n} 次）`,
          );
          this.persistAndNotify(run);
        }
        finish({ outcome: 'released', action });
      });
      if (capMs !== null) {
        timer = setTimeout(() => {
          this.blockedWaiters.delete(key);
          const rec = run.nodes[nodeId];
          if (rec) rec.blockedAt = undefined;
          finish({ outcome: 'timeout', waitedMs: Date.now() - enteredAt, capMs });
        }, capMs);
        timer.unref?.();
      }
    });
  }

  /**
   * v13-S4 外解唤醒计数读取（nodeId 省略=该 run 全部节点合计）。内存账随进程生命周期，
   * 权威事实另有一笔 approval 事件落 run.events（收口不删：默认关闭下此账根本不产生）。
   */
  externalReleaseCount(runId: string, nodeId?: string): number {
    if (nodeId) return this.externalReleases.get(`${runId}:${nodeId}`) ?? 0;
    let sum = 0;
    for (const [k, v] of this.externalReleases) {
      if (k.startsWith(`${runId}:`)) sum += v;
    }
    return sum;
  }

  // -- execution ----------------------------------------------------------------

  private async execute(run: RunRecord, order: string[], blackboardPreload?: Map<string, Artifact>): Promise<void> {
    // readable workspace name: paneflow-<space>-<runId> (sweep prefix preserved)
    const label = `${this.opts.workspaceLabelPrefix}${run.spaceId ?? 'default'}-${run.runId}`;
    const ws = await this.ops.createWorkspace(label, run.cwd, this.opts.paneEnv ?? {});
    run.workspaceId = ws.workspaceId;
    this.rootPanes.set(run.runId, ws.rootPaneId);
    // 工作区卫生守护：运行产物目录（.herdr/）不进版本库
    try {
      const gitignore = path.join(run.cwd, '.gitignore');
      const cur = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : null;
      if (cur === null || !/^\.herdr\/?$/m.test(cur)) {
        fs.appendFileSync(gitignore, `${cur && !cur.endsWith('\n') ? '\n' : ''}.herdr/\n`);
      }
    } catch {
      // 非 git 目录或只读 —— 跳过
    }
    this.persistAndNotify(run);

    const blackboard = blackboardPreload ?? new Map<string, Artifact>();
    let abort = false;

    try {
      await this.schedule(run, order, blackboard, () => {
        abort = true;
      });

      if (this.cancels.has(run.runId)) run.state = 'cancelled';
      else if (abort) run.state = 'failed';
      else {
        // v11-D3（摩擦账 #12）：onFail=continue/宽松 fan-in 收口时若仍有 failed 节点，
        // 如实收口成 completed-with-failures，不再假装全绿。skipped 不计失败——
        // 条件剪枝、fanout 展开占位都是合法形态；上游失败致的跳过已由那个 failed 节点计入。
        const failedCount = Object.values(run.nodes).filter((n) => n.state === 'failed').length;
        run.state = failedCount ? 'completed-with-failures' : 'completed';
      }
      const done = Object.values(run.nodes).filter((n) => n.state === 'done').length;
      const total = Object.keys(run.nodes).length;
      const secs = Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000);
      this.recordEvent(
        run,
        'run',
        undefined,
        `运行结束：${run.state}（${done}/${total} 节点完成，耗时 ${secs}s）`,
      );
    } finally {
      run.finishedAt = new Date().toISOString();
      for (const rec of Object.values(run.nodes)) {
        if (['working', 'blocked', 'queued', 'starting', 'retrying'].includes(rec.state)) {
          rec.state = this.cancels.has(run.runId) ? 'cancelled' : 'failed';
        }
      }
      // final terminal snapshot per node — panes are about to be reclaimed
      await Promise.allSettled(
        Object.values(run.nodes).map((rec) =>
          rec.agentName
            ? this.ops.readOutput(rec.agentName, 240).then((text) => {
                if (!text.trim()) return;
                const snaps = (rec.outputSnapshots ??= []);
                snaps.push({ at: new Date().toISOString(), text: text.slice(0, 16 * 1024) });
                if (snaps.length > 12) snaps.splice(0, snaps.length - 12);
              }).catch(() => {})
            : Promise.resolve(),
        ),
      );
      // resource cleanup — never leave panes behind
      this.reclaimWorktrees(run.runId);
      // v13-S1：终态转换→closeWorkspace 之间有窗口，run 已非活跃——登记收口窗防周期扫描抢关
      if (run.workspaceId) this.closingWorkspaces.add(run.workspaceId);
      try {
        await this.ops.closeWorkspace(run.workspaceId!);
      } catch (err) {
        console.error(`[engine] workspace cleanup failed for ${run.workspaceId}:`, err);
      } finally {
        if (run.workspaceId) this.closingWorkspaces.delete(run.workspaceId);
      }
      this.rootPanes.delete(run.runId);
      this.cancels.delete(run.runId);
      // v13-S2：尝试掐断幂等键随 run 收口清账，不留内存残渣
      for (const k of [...this.interruptedAttempts]) {
        if (k.startsWith(`${run.runId}:`)) this.interruptedAttempts.delete(k);
      }
      run.cost = this.computeRunCost(run); // R6a：先记账再广播（持久化含 cost）
      this.persistAndNotify(run);
      this.pumpQueue(run.spaceId ?? 'default'); // G3：终态腾出额度，队列放行
      // v11-C1：绿 run 收口后自动蒸馏（只加不改——收口判定/调度/prompt 注入区均未动）。
      // 纯 fire-and-forget：void + maybeAutoDistill 内部全捕获，永不 reject，
      // 收口路径不 await 任何 LLM/git/网络，蒸馏炸与否都流不回终态广播。
      if (run.state === 'completed') void this.maybeAutoDistill(run);
      // v11-E1c：实验收数（同样只加不改）——只认带 suite 的实验单。v13-V3 起落盘失败不再无声：
      // appendExperimentRow 三态返回 + 进程级计数（/api/health 的 experimentWrites 可读），
      // 但收口路径依旧不 await（纯本地 append，炸不回灌终态广播）。
      if (run.experiment?.suite) void appendExperimentRow(this.store.root, run);
    }
  }

  /**
   * v11-C1 自动蒸挂点：开关（opts.wikiDistill > env PF_WIKI_DISTILL，默认 off）+
   * fail-closed 绿门（autoDistillRun 内复用 publishableRun）都过了才起后台任务。
   * 默认 off 的理由写在 wiki-distill.ts autoDistillEnabled 注释（自动路未经用户
   * 点头直推 main，宁缺毋滥门风不动，开不开等 C4 实证）。任何异常就地吞掉。
   */
  private async maybeAutoDistill(run: RunRecord): Promise<void> {
    try {
      if (!autoDistillEnabled(this.opts.wikiDistill)) return;
      const distill = this.opts.wikiDistillRun ?? ((r: RunRecord) => autoDistillRun(this.store.root, r));
      await distill(run);
    } catch {
      // 蒸馏是纯加分项：任何意外都不许流回收口路径
    }
  }

  /**
   * R6a 收尾成本账：时长/attempt 由节点记录推算（必有）；
   * tokens 只聚合 agent 自报的 extra.usage（headless JSON 天然带 / TUI 经 prompt 引导），
   * 一处都没有即 tokens=null（消费方展示为 unknown）——绝不造估算数。
   */
  private computeRunCost(run: RunRecord): RunCost {
    const byNode: Record<string, NodeCost> = {};
    let retries = 0;
    let input = 0;
    let output = 0;
    let sawUsage = false;
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
    for (const rec of Object.values(run.nodes)) {
      if (!rec.startedAt || rec.state === 'skipped') continue;
      const durationMs = Math.max(0, (rec.finishedAt ? Date.parse(rec.finishedAt) : end) - Date.parse(rec.startedAt));
      const r = Math.max(0, rec.attempts - 1);
      byNode[rec.nodeId] = { durationMs, attempts: rec.attempts, retries: r };
      retries += r;
      const usage = (rec.artifact?.extra as Record<string, unknown> | undefined)?.usage as
        | { input?: unknown; output?: unknown }
        | undefined;
      if (usage && typeof usage === 'object' && typeof usage.input === 'number' && typeof usage.output === 'number') {
        input += usage.input;
        output += usage.output;
        sawUsage = true;
      }
    }
    return {
      totalMs: Math.max(0, end - Date.parse(run.startedAt)),
      byNode,
      retries,
      tokens: sawUsage ? { input, output } : null,
    };
  }

  /**
   * Dataflow scheduler: launches every node whose predecessors have all
   * settled, up to the global pane concurrency limit. `fail` is invoked when
   * a node failure with onFail=abort (or a strict fan-in breach) should stop
   * new launches.
   */
  private async schedule(
    run: RunRecord,
    order: string[],
    blackboard: Map<string, Artifact>,
    fail: () => void,
  ): Promise<void> {
    const graph = run.graph;
    const outcomes = new Map<string, 'done' | 'failed' | 'skipped'>();
    const pending = new Set(order);
    const inflight = new Map<string, Promise<void>>();
    // 断点续跑：已继承 done 的节点直接登记，不再执行
    for (const id of order) {
      const rec = run.nodes[id]!;
      if (rec.state === 'done') {
        outcomes.set(id, 'done');
        pending.delete(id);
      }
    }
    const capacity = Math.max(1, this.opts.maxConcurrentPanes ?? 8);
    let abort = false;

    const releaseSlot = (): void => {
      this.paneSlots.acquired = Math.max(0, this.paneSlots.acquired - 1);
      const next = this.paneWaiters.shift();
      if (next) next();
    };
    const waitSlot = (): Promise<void> =>
      this.paneSlots.acquired < capacity
        ? new Promise<void>((resolve) => {
            this.paneSlots.acquired += 1;
            resolve();
          })
        : new Promise<void>((resolve) => this.paneWaiters.push(() => {
            this.paneSlots.acquired += 1;
            resolve();
          }));

    /** 条件边剪枝：无条件恒真；上游未落定视为有效；上游落定后按 artifact 断言 */
    const edgeActive = (e: DagEdge): boolean => {
      const c = e.condition;
      if (!c) return true;
      const artifact = blackboard.get(e.source);
      if (!artifact) return outcomes.has(e.source) ? false : true; // skipped/failed source → pruned
      let cur: unknown = artifact as unknown;
      for (const seg of c.field.split('.')) {
        if (cur === null || typeof cur !== 'object') return c.exists === false;
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (c.exists !== undefined) return c.exists ? cur !== undefined : cur === undefined;
      const v = cur === undefined || cur === null ? '' : String(cur);
      if (c.equals !== undefined) return v === c.equals;
      if (c.notEquals !== undefined) return v !== c.notEquals;
      return true;
    };

    const predStatus = (id: string): 'ready' | 'wait' | 'skip' | 'nolink' => {
      const edgesIn = graph.edges.filter((e) => e.target === id);
      const activeEdges = edgesIn.filter((e) => edgeActive(e));
      if (edgesIn.length > 0 && activeEdges.length === 0) return 'nolink';
      let anyFailed = false;
      for (const e of activeEdges) {
        const o = outcomes.get(e.source);
        if (!o) return 'wait';
        if (o === 'failed') anyFailed = true;
      }
      return anyFailed ? 'skip' : 'ready';
    };

    const mark = (id: string, outcome: 'done' | 'failed' | 'skipped', error?: string): void => {
      outcomes.set(id, outcome);
      const rec = run.nodes[id]!;
      rec.state = outcome;
      if (error !== undefined) rec.error = error;
      rec.finishedAt = rec.finishedAt ?? new Date().toISOString();
      this.recordEvent(run, 'node', id, `${outcome}${error ? `：${error}` : ''}`);
      this.persistAndNotify(run);
    };

    let capacityBlocked = false;
    for (;;) {
      if (this.cancels.has(run.runId)) break;
      capacityBlocked = false;

      if (!abort) {
        for (const id of [...pending]) {
          if (!pending.has(id)) continue; // removed by expansion in this same pass
          const node = graph.nodes.find((n) => n.id === id)!;
          let st = predStatus(id);
          if (node.type === 'fanin') {
            // the barrier waits for ALL active branches and then judges failures itself
            const preds = graph.edges.filter((e) => e.target === id && edgeActive(e)).map((e) => e.source);
            st = preds.every((p) => outcomes.get(p)) ? 'ready' : 'wait';
          }
          if (st === 'wait') continue;
          pending.delete(id);
          const rec = run.nodes[id]!;

          if (st === 'nolink') {
            mark(id, 'skipped', '入边条件均未满足');
            continue;
          }
          if (st === 'skip') {
            mark(id, 'skipped', '上游分支失败');
            continue;
          }

          if (node.type !== 'agent') {
            // pipeline: spawn a child run from a template (B-场景: 受理→路由→执行)
            if (node.type === 'pipeline') {
              {
                const recP = run.nodes[id]!;
                recP.state = 'starting';
                this.persistAndNotify(run);
              }
              const launchErr = await this.runPipelineNode(run, node, blackboard, (childId) => {
                const recW = run.nodes[id]!;
                recW.state = 'working';
                recW.error = `子运行 ${childId}`;
                this.persistAndNotify(run);
              });
              if (launchErr) {
                mark(id, 'failed', launchErr);
                fail();
                continue;
              }
              mark(id, 'done');
              continue;
            }
            // start / end are structural markers; fanout may expand dynamically
            if (node.type === 'fanout' && node.config.expand) {
              const exp = node.config.expand;
              const artifact = blackboard.get(exp.from);
              let cur: unknown = artifact as unknown;
              for (const seg of exp.field.split('.')) {
                if (cur === null || typeof cur !== 'object') break;
                cur = (cur as Record<string, unknown>)[seg];
              }
              const items = Array.isArray(cur) ? cur : null;
              if (!items?.length) {
                // 弱模型常不守结构化约定：默认回退单分支（用上游 summary 作为任务），保交付
                if ((exp.onEmpty ?? 'fallback') === 'fallback') {
                  const upstream = blackboard.get(exp.from);
                  const fallbackItem: Record<string, unknown> = {
                    name: '串行交付',
                    brief: upstream?.summary ?? upstream?.outputTail ?? '按上游结论完成全部工作',
                    __upstream: true,
                  };
                  mark(id, 'done');
                  this.expandFanout(run, node.id, [fallbackItem], pending, blackboard);
                  this.persistAndNotify(run);
                  continue;
                }
                const keys = artifact && typeof artifact === 'object' ? Object.keys(artifact as object).join(',') : '(无产物)';
                mark(id, 'failed', `动态扇出未取到数组 {{${exp.from}.${exp.field}}}（上游产物字段: ${keys}）`);
                fail();
                continue;
              }
              const cap = exp.maxItems ?? FANOUT_MAX_ITEMS_LIMIT;
              if (items.length > cap) {
                // v13-V0 有顶：超上限不截断（截断=少交付还报完成）、不放过（N 项=N 个并发 agent 烧配额）
                mark(id, 'failed', `动态扇出超限：{{${exp.from}.${exp.field}}} 有 ${items.length} 项，上限 ${cap}（请上游分批，或给本节点 expand.maxItems 明确更小上限）`);
                fail();
                continue;
              }
              mark(id, 'done');
              this.expandFanout(run, node.id, items, pending, blackboard);
              continue;
            }
            if (node.type === 'fanin') {
              const preds = graph.edges.filter((e) => e.target === id && edgeActive(e)).map((e) => e.source);
              const failedCount = preds.filter((p) => outcomes.get(p) === 'failed').length;
              const requireAll = node.config.requireAll ?? true;
              if (failedCount > 0 && requireAll) {
                mark(id, 'failed', `${failedCount}/${preds.length} 个分支失败`);
                fail();
                continue;
              }
            }
            mark(id, 'done');
            continue;
          }

          if (this.paneSlots.acquired >= capacity) {
            pending.add(id); // 首驾调度洞：扫描开头已把节点摘出 pending——没启动就还回去，否则它谁也不在（run 会带着未跑节点「完成」）
            capacityBlocked = true;
            break;
          }
          const launch = waitSlot().then(() =>
            this.runAgentNode(run, id, blackboard)
              .then((res) => {
                inflight.delete(id);
                releaseSlot();
                if (res === 'abort') {
                  mark(id, 'failed', undefined);
                  abort = true;
                  fail();
                } else {
                  mark(id, res === 'done' ? 'done' : 'failed', res === 'failed' ? run.nodes[id]!.error : undefined);
                }
              })
              .catch((err) => {
                inflight.delete(id);
                releaseSlot();
                mark(id, 'failed', (err as Error).message);
                abort = true;
                fail();
              }),
          );
          inflight.set(id, launch);
        }
      }

      if (abort) {
        for (const id of pending) mark(id, 'skipped', '流水线已终止');
        pending.clear();
      }

      if (inflight.size) {
        await Promise.race(inflight.values());
      } else if (pending.size && !abort && !this.cancels.has(run.runId)) {
        // exit only when no pending node can progress (expansion may have just
        // added ready nodes; genuine stalls cannot happen for valid DAGs)
        const canProgress = [...pending].some((id) => {
          const node = graph.nodes.find((n) => n.id === id)!;
          let st = predStatus(id);
          if (node.type === 'fanin') {
            const preds = graph.edges.filter((e) => e.target === id).map((e) => e.source);
            st = preds.every((p) => outcomes.get(p)) ? 'ready' : 'wait';
          }
          return st !== 'wait';
        });
        if (!canProgress) break;
        // 槽位被别的 run 占着且本 run 无在飞：轮询等释放，绝不空转也绝不带着 pending 退出
        if (capacityBlocked && !inflight.size) await sleep(300);
      } else if (!pending.size && !inflight.size) {
        break;
      }
    }

    // wait for the rest of the in-flight work after abort/cancel
    await Promise.allSettled([...inflight.values()]);
  }

  /** Execute one agent node with retries. 'abort' = onFail=abort breach. */
  private async runAgentNode(run: RunRecord, nodeId: string, blackboard: Map<string, Artifact>): Promise<'done' | 'failed' | 'abort'> {
    const node = run.graph.nodes.find((n) => n.id === nodeId)!;
    const rec = run.nodes[nodeId]!;
    let maxAttempts = 1 + Math.max(0, node.config.retryCount ?? 0);
    const onFail = node.config.onFail ?? 'abort';
    // v11-D1：本 run 走网关时按主机限在途并发；限流失败还有专属额外重试预算（不占节点 retryCount）
    const gwHost = this.gatewayHostFor(run);
    let throttleBudget = gwHost ? this.gwThrottleRetries : 0;
    let throttleStreak = 0;

    let lastError = '未知错误';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.cancels.has(run.runId)) return 'abort';
      // v12-S2 熔断执行点：每次尝试启动前查实时 token 账——超限即走既有失败收口
      // （返回 abort → 调度器 mark failed + 停派后续），pane 不起、网关额度不占。
      const breach = this.tokenBudgetBreach(run, nodeId);
      if (breach) {
        rec.error = breach;
        rec.finishedAt = rec.finishedAt ?? new Date().toISOString();
        this.persistAndNotify(run);
        return 'abort';
      }
      rec.attempts = attempt;
      rec.state = attempt > 1 ? 'retrying' : 'queued';
      rec.error = undefined;
      if (attempt > 1) {
        this.recordEvent(run, 'node', nodeId, `第 ${attempt - 1} 次重试（最多 ${maxAttempts - 1} 次）`);
      }
      this.persistAndNotify(run);

      let gated = false;
      if (gwHost) {
        // 起 agent 前领取该主机的在途额度；排不上就地轮询等（可被停止打断），不另起调度器
        rec.error = `网关限流排队：${gwHost} 在途并发已达上限，等待起窗`;
        this.persistAndNotify(run);
        const granted = await this.gwGate.acquire(gwHost, () => this.cancels.has(run.runId));
        if (!granted) return 'abort';
        gated = true;
        rec.error = undefined;
      }
      let attemptResult: string;
      try {
        attemptResult = await this.attemptNode(run, node.id, blackboard);
      } finally {
        if (gated) this.gwGate.release(gwHost!);
      }
      lastError = attemptResult;
      if (lastError === 'ok') return 'done';
      if (this.cancels.has(run.runId)) return 'abort';

      rec.state = 'failed';
      rec.error = lastError;
      rec.finishedAt = new Date().toISOString();
      this.persistAndNotify(run);

      // v13-S2 触发点 (b)：进入重试——下一轮起窗之前（含限流退避窗前）先掐断这一轮的
      // agent，重试不再双跑。还会不会再进循环两种判据都要问：常规预算没耗尽，或
      // 纯限流失败还有专属额外预算（下方 throttle 分支会扩 maxAttempts）。
      // 同一轮若已被 (a) 掐过，幂等键让这里空手而归、不双落账。
      const willRetry =
        attempt < maxAttempts ||
        (gwHost !== null && throttleBudget > 0 && looksLikeGatewayThrottle(lastError));
      if (willRetry) {
        await this.interruptAttemptAgent(run, rec, 'retry');
      }

      if (gwHost && looksLikeGatewayThrottle(lastError)) {
        throttleStreak += 1;
        // 命中限流：该主机闸临时收紧——后续起窗错峰，别在同一刻再撞整点 503
        const tightenMs = this.gwGate.penalize(gwHost);
        if (attempt >= maxAttempts && throttleBudget > 0) {
          throttleBudget -= 1;
          maxAttempts = attempt + 1;
        }
        if (attempt < maxAttempts) {
          const backoffMs = Math.min(this.gwBackoffBaseMs * 2 ** (throttleStreak - 1), 60_000);
          this.recordEvent(
            run,
            'node',
            nodeId,
            `检测到网关限流（429/503）：${gwHost} 闸收紧 ${tightenMs}ms 错峰，退避 ${backoffMs}ms 后重试`,
          );
          if (!(await this.cancellableSleep(backoffMs, run))) return 'abort';
        }
      } else {
        throttleStreak = 0;
      }
    }
    return onFail === 'continue' ? 'failed' : 'abort';
  }

  /** 退避等待：期间停止指令可打断（返回 false = 已取消），不把人质在睡眠里 */
  private async cancellableSleep(ms: number, run: RunRecord): Promise<boolean> {
    const endAt = Date.now() + ms;
    for (;;) {
      if (this.cancels.has(run.runId)) return false;
      const left = endAt - Date.now();
      if (left <= 0) return true;
      await sleep(Math.min(100, left));
    }
  }

  /** One full attempt: pane → agent → ready → prompt → (approval) → artifact. */
  private async attemptNode(run: RunRecord, nodeId: string, blackboard: Map<string, Artifact>): Promise<'ok' | string> {
    // 首驾-3：跨 run 软锁必须随节点尝试结束而释放——旧实现 claim 只写不还，
    // 派发父 run 的 planner 跑完后仍「持锁」，其 pipeline 子 run 的 align 排队等锁直到超时，
    // 而父 run 又在等子 run 结束 = 环形等待（首驾实抓：3b559054/align 卡「等待仓库锁 47015711/planner」）。
    const cfg0 = run.graph.nodes.find((n) => n.id === nodeId)!.config;
    const repo = gitRepoRoot(cfg0.cwd ? path.resolve(run.cwd, cfg0.cwd) : run.cwd);
    try {
      return await this.doAttemptNode(run, nodeId, blackboard);
    } finally {
      if (repo) {
        const claim = this.repoClaims.get(repo);
        if (claim && claim.runId === run.runId && claim.nodeId === nodeId) this.repoClaims.delete(repo);
      }
    }
  }

  private async doAttemptNode(run: RunRecord, nodeId: string, blackboard: Map<string, Artifact>): Promise<'ok' | string> {
    const node = run.graph.nodes.find((n) => n.id === nodeId)!;
    const rec = run.nodes[nodeId]!;
    const cfg = node.config;
    const agentName = makeAgentName(run.runId, nodeId);
    const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : this.opts.defaultNodeTimeoutMs;

    // 1. pane + agent + readiness
    rec.state = 'starting';
    this.recordEvent(run, 'node', nodeId, '节点启动：准备终端 Pane 与 Agent');
    this.persistAndNotify(run);
    let unsub: (() => void) | null = null;
    let repoClaimKey: string | null = null;
    let nodeCwd = cfg.cwd ? path.resolve(run.cwd, cfg.cwd) : run.cwd;
    try {
      const rootPane = this.rootPanes.get(run.runId)!;
      // R3.1/R3.2 仓库占用：同 run 兄弟并发写同仓 → worktree 隔离；跨 run → 软锁排队
      const repo = gitRepoRoot(nodeCwd);
      if (repo) {
        const myKey = `${run.runId}:${nodeId}`;
        const holder = this.repoClaims.get(repo);
        if (holder && holder.key !== myKey) {
          if (holder.runId === run.runId) {
            const wt = this.createWorktree(repo, run.runId, nodeId);
            nodeCwd = wt.path;
            rec.worktree = wt.path;
            this.recordEvent(run, 'node', nodeId, `同仓并发：创建隔离 worktree（${wt.branch}）`);
          } else {
            rec.state = 'queued';
            rec.error = `等待仓库锁：${repo}（被 run ${holder.runId} 的 ${holder.nodeId} 占用）`;
            this.recordEvent(run, 'node', nodeId, `排队等待仓库锁：${holder.runId}/${holder.nodeId} 占用中`);
            this.persistAndNotify(run);
            const lockDeadline = Date.now() + Math.max(60_000, timeoutMs);
            // v13-S3 出闸判据修正：问「锁还在不在」而不是「锁还归不归于进队时那个 holder」——
            // 旧式下 holder 释放瞬间若有人抢入，等待者手里攥着已死 holder 的 runId 作比对对象，
            // 永远对不上 = 两个等待者同刻出闸、随后各自无条件 set 互相踩（隔离形同虚设）。
            // 红线：本 while 与其后的 repoClaims.set 之间严禁引入 await——JS 单线程下
            // 「同 tick 的 has() 判定 + set 写入」天然原子，插一个 await 就把这块补成新的竞态。
            let waitingHolder = holder;
            while (this.repoClaims.has(repo)) {
              const cur = this.repoClaims.get(repo);
              if (cur && cur.key !== myKey && cur.runId !== waitingHolder.runId) {
                // 锁转手（前一家放行、后一家接手）：排队文案要说清现在挡在谁面前
                waitingHolder = cur;
                rec.error = `等待仓库锁：${repo}（被 run ${cur.runId} 的 ${cur.nodeId} 占用）`;
                this.recordEvent(run, 'node', nodeId, `仍在排队：锁已转手 ${cur.runId}/${cur.nodeId}`);
                this.persistAndNotify(run);
              }
              if (this.cancels.has(run.runId)) return '已取消（等待仓库锁）';
              if (Date.now() > lockDeadline) return `仓库锁等待超时：${repo}`;
              await sleep(1500);
            }
            // 拿到锁：清掉排队期留下的 error（旧实现让「等待仓库锁」字样一直挂在节点记录上直到结束）
            delete rec.error;
            rec.state = 'starting';
            this.recordEvent(run, 'node', nodeId, '仓库锁到手，继续执行');
            this.persistAndNotify(run);
          }
        }
        this.repoClaims.set(repo, { runId: run.runId, nodeId, key: myKey });
        repoClaimKey = repo;
      }
      // env 合并：全局 < 模型网关（D2：空间钉档优先） < 角色 < 节点
      const gwPin = this.gatewayPinFor(run);
      let paneEnv: Record<string, string> = {
        ...(this.opts.paneEnv ?? {}),
        ...buildGatewayEnv(this.store.root, gwPin),
        ...buildGithubEnv(this.store.root),
      };
      const role = this.roleById(run, cfg.role);
      if (role?.env) paneEnv = { ...paneEnv, ...role.env };
      if (cfg.env) paneEnv = { ...paneEnv, ...cfg.env };
      let paneId: string;
      try {
        paneId = await this.ops.splitPane(run.workspaceId!, rootPane, nodeCwd, paneEnv);
      } catch (err) {
        // 重试时根 pane 可能已消失：重建工作区再分割（保交付）
        if (!/not_found|not found/i.test((err as Error).message)) throw err;
        // v13-S1：先谢旧再换新——旧实现直接覆盖 run.workspaceId，旧 ws 在 herdr 里成永久幽灵
        const staleWs = run.workspaceId;
        const ws = await this.ops.createWorkspace(
          `${this.opts.workspaceLabelPrefix}${run.runId}-r${rec.attempts}`, run.cwd, this.opts.paneEnv ?? {},
        );
        run.workspaceId = ws.workspaceId;
        this.rootPanes.set(run.runId, ws.rootPaneId);
        if (staleWs && staleWs !== ws.workspaceId) {
          this.closingWorkspaces.add(staleWs);
          void this.ops.closeWorkspace(staleWs)
            .catch((e) => console.warn(`[engine] 重建后关旧 workspace 失败（留给孤儿扫描）：${staleWs} — ${(e as Error).message}`))
            .finally(() => this.closingWorkspaces.delete(staleWs));
        }
        paneId = await this.ops.splitPane(ws.workspaceId, ws.rootPaneId, nodeCwd, paneEnv);
      }
      rec.paneId = paneId;
      rec.agentName = agentName;
      // claude 自动附加沙箱豁免 + 网关/凭据 env（信任与 bypass 对话框经 settings 预接受）
      let startArgs = [...(cfg.agentArgs ?? [])];
      const kind = await this.resolveAgentKind(run, cfg);
      // AE：网关启用时 pi 走 PaneFlow 注册的 paneflow-gw provider（pi 不读 OPENAI_BASE_URL，
      // 且 openai 目录下的未知模型会绕到 api.openai.com 超时）；provider 由网关保存/启动时写入
      if (kind === 'pi' && gatewayActive(this.store.root, gwPin)) {
        const gm = readGateway(this.store.root, gwPin).freeModel;
        startArgs = ['--provider', PI_GATEWAY_PROVIDER, ...(gm ? ['--model', gm] : []), ...startArgs];
      }
      if (kind === 'claude') {
        const bootstrapEnv = {
          ...buildGatewayEnv(this.store.root, gwPin),
          ...buildGithubEnv(this.store.root),
        };
        if (Object.keys(bootstrapEnv).length) {
          startArgs = [
            '--dangerously-skip-permissions',
            '--settings',
            JSON.stringify({
              env: bootstrapEnv,
              hasTrustDialogAccepted: true,
              bypassPermissionsModeAccepted: true,
              // 沙箱网络白名单：放行 GitHub（gh 命令）与网关
              sandbox: { network: { allowedDomains: ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'localhost', '127.0.0.1'] } },
            }),
            ...startArgs,
          ];
        }
      }
      // shell 首帧未就绪时短暂退避重试（新 pane 的 zsh 初始化在大仓库 cwd 下可能秒级延迟）
      let started = false;
      let startError = 'unknown';
      for (let st = 0; ; st++) {
        try {
          await this.ops.startAgent(paneId, agentName, kind, startArgs, this.opts.agentStartTimeoutMs);
          started = true;
          break;
        } catch (e) {
          startError = (e as Error).message;
          if (st < 2 && /pane_busy|available shell/i.test(startError)) {
            await sleep(1500 * (st + 1));
            continue;
          }
          return `启动失败：${startError}`;
        }
      }
      if (!started) return `启动失败：${startError}`;
      // 启动等待含人工闸门：冷启动慢→继续等；启动对话框 blocked→审批卡片
      await this.waitReadyWithGate(run, rec, agentName, cfg);
    } catch (err) {
      return `启动失败：${(err as Error).message}`;
    }

    // live status mirroring from events; the poller reconciles drift, so a
    // failed subscription is degraded to warn-only rather than failing the node
    try {
      unsub = await this.ops.subscribePaneStatus(paneIdOf(rec), (status) => {
        rec.agentStatus = status;
        this.captureOutput(run, rec);
        if (status === 'blocked' && rec.state === 'working') {
          rec.state = 'blocked';
          this.persistAndNotify(run);
        }
      });
    } catch (err) {
      console.warn(`[engine] pane subscription failed (polling only): ${(err as Error).message}`);
    }

    try {
      // 2. render prompt against the blackboard, append the artifact
      // convention so the agent knows the hand-off contract, then submit
      rec.state = 'working';
      rec.startedAt = rec.startedAt ?? new Date().toISOString();
      this.recordEvent(run, 'node', nodeId, '指令已提交');
      this.persistAndNotify(run);
      const rendered = renderPromptTemplate(cfg.prompt ?? '', (refId, refPath) =>
        this.resolveBlackboardRef(blackboard, refId, refPath),
      );
      const nodeCwd = cfg.cwd ? path.resolve(run.cwd, cfg.cwd) : run.cwd;
      const artifactRel = cfg.artifactFile ?? defaultArtifactFile(nodeId);
      const { block, agentKind } = this.resolveContext(run, cfg, nodeCwd);
      const prompt = this.withArtifactConvention(
        `${block}${rendered}`,
        path.join(nodeCwd, artifactRel),
      );
      let status = await this.promptAndSettle(run, rec, agentName, prompt, timeoutMs);

      // 3. human approval loop while blocked
      while (status === 'blocked' && !this.cancels.has(run.runId)) {
        rec.state = 'blocked';
        rec.agentStatus = 'blocked';
        // v12-V2 进门留痕补口：此前唯一拦侧不发消息的审批门——照其他三门文案风格补一条，
        // 并记进门时刻（waitMs 结算依据；此前这类门等待时长只能干瞪眼不可推导）。
        this.recordEvent(run, 'approval', nodeId, '运行中对话框拦截：Agent 弹框等待人工处置（放行/拒绝/补料）');
        rec.blockedAt = new Date().toISOString();
        this.persistAndNotify(run);
        // v13-S4 门收编进 awaitGate（七门同款接线，后文不再逐处注释）：cancels 短路先于
        // 一切出路（旧口径零漂移）；到期 fail-closed——固定句式走既有失败路，不合成放行。
        const decision = await this.awaitGate(run, nodeId);
        if (this.cancels.has(run.runId)) return '已取消';
        if (decision.outcome === 'timeout') return gateTimeoutMessage(decision.waitedMs, decision.capMs);
        const action = decision.action;
        if (action.action === 'input' && action.text) {
          status = await this.promptAndSettle(run, rec, agentName, action.text, timeoutMs);
          continue;
        }
        const keys = action.keys ?? (action.action === 'approve' ? (cfg.approveKeys ?? ['enter']) : ['ctrl+c']);
        await this.ops.sendKeys(agentName, keys);
        status = await this.settleAfterKeys(rec, agentName, timeoutMs);
        if (action.action === 'reject' && status !== 'blocked') return '人工审批拒绝';
      }
      if (this.cancels.has(run.runId)) return '已取消';

      // 4. artifact extraction → blackboard
      if (status !== 'idle' && status !== 'done') {
        return `节点结束于异常状态：${status}`;
      }
      rec.state = 'done';
      rec.agentStatus = status;
      rec.finishedAt = new Date().toISOString();
      const outputTail = await this.ops.readOutput(agentName, 80).catch(() => '');
      const artifact = await this.extractArtifact(nodeId, artifactRel, run, outputTail);
      rec.artifact = artifact;
      // F1 可信标记：结果文件缺失、以终端尾部兜底的产物未经文件验证，运行卡上要可见
      rec.unverified = artifact.source === 'output-fallback';
      if (rec.unverified) {
        this.recordEvent(run, 'node', nodeId, '⚠ 产物文件缺失，以终端尾部兜底（未经文件验证）');
      }
      blackboard.set(nodeId, artifact);
      this.persistAndNotify(run);

      // clarify loop (grilling): artifact.aligned !== 'true' → Q&A rounds
      if (cfg.clarify) {
        const maxRounds = Math.max(1, cfg.clarify.maxRounds ?? 3);
        for (let round = 1; ; round++) {
          const aligned = String(rec.artifact?.aligned ?? 'true');
          // 断言完成门：aligned=true 且验收断言有效（T1 validateAcceptance 通过）才算对齐；
          // 断言缺失/无效即视同未对齐，进入澄清轮提示补齐（approve 强制放行 / 轮次耗尽语义不变）
          // 验收断言可选增强：Agent 写了断言才校验其有效性；未写时 aligned=true 即放行（向后兼容）
          const acceptanceList = rec.artifact?.extra?.acceptance as AcceptanceAssertion[] | undefined;
          const acceptInvalid = acceptanceList?.length ? validateAcceptance(acceptanceList) : null;
          if (String(aligned) === 'true' && acceptInvalid === null) break;
          if (round > maxRounds) return `澄清循环 ${maxRounds} 轮后仍未对齐（aligned=${aligned}）`;
          const questions = (rec.artifact?.extra?.questions as string[] | undefined) ?? [];
          rec.state = 'blocked';
          rec.blockedPrompt = acceptInvalid !== null
            ? '验收断言缺失/无效：请补齐 resultFile.extra.acceptance=[{id,assertion,verify_method}] 后再写 aligned=true'
            : questions.length
              ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
              : 'Agent 有疑问，请补充信息（aligned 未通过）';
          // v12-V2：澄清轮门同为拦侧无事件的门——与四门同款补齐进门留痕 + 进门时刻
          this.recordEvent(run, 'approval', nodeId, '澄清轮拦截：aligned 未通过，等待人工补充或强制放行');
          rec.blockedAt = new Date().toISOString();
          this.persistAndNotify(run);
          const decision = await this.awaitGate(run, nodeId); // v13-S4 门收编（S4 注释只在此说明，余五门同款）
          rec.blockedPrompt = undefined;
          if (this.cancels.has(run.runId)) return '已取消';
          if (decision.outcome === 'timeout') return gateTimeoutMessage(decision.waitedMs, decision.capMs);
          const action = decision.action;
          if (action.action === 'reject') return '澄清被人工终止';
          if (action.action === 'approve') break; // 强制放行
          if (action.action === 'input' && action.text) {
            // answers become a follow-up turn; artifact re-extracted for the next aligned check
            await this.promptAndSettle(run, rec, agentName, action.text, timeoutMs);
            const tail = await this.ops.readOutput(agentName, 80).catch(() => '');
            rec.artifact = await this.extractArtifact(nodeId, artifactRel, run, tail);
            rec.unverified = rec.artifact.source === 'output-fallback';
            blackboard.set(nodeId, rec.artifact);
            this.persistAndNotify(run);
          }
        }
        rec.state = 'done';
        this.persistAndNotify(run);
      }

      // M2 契约落册：产物写了 extra.contract 且本 run 尚无契约 → 成为 run 的一等公民产物
      this.captureContract(run, rec);
      // H1 交付出口：任一节点产物写了合法 pr_url → 落册到 run（先到先得）
      this.capturePrUrl(run, rec);

      // F1 验收机器门：产物写了 assertionResults 且有未通过项时不许静默 done
      const gateFail = await this.assertionGate(run, rec, nodeId, agentName, timeoutMs, artifactRel, blackboard);
      if (gateFail) return gateFail;

      // checks gate: all configured checks must pass for the node to be done
      const checkFail = await this.runChecks(
        run, rec, nodeId, nodeCwdOf(run, cfg),
        { agentName, timeoutMs, artifactRel, blackboard },
      );
      if (checkFail) return checkFail;

      this.persistAndNotify(run);
      return 'ok';
    } catch (err) {
      return await this.errorWithOutputTail(agentName, (err as Error).message);
    } finally {
      unsub?.();
    }
  }

  /**
   * v11-D2：节点异常失败时，终端里往往就有真正的报错行——尽力把 agent 输出末尾
   * ~800 字符（保尾截断）附到错误信息后；抓不到/抓输出自身失败静默降级为裸 message，
   * 绝不因采集本身再抛错。err.message 恒在最前，供上层按原有前缀匹配。
   */
  private async errorWithOutputTail(agentName: string, message: string): Promise<string> {
    const tail = await this.ops.readOutput(agentName, 80).catch(() => '');
    const trimmed = (typeof tail === 'string' ? tail : '').trimEnd();
    if (!trimmed.trim()) return message;
    return `${message}（输出尾部：${trimmed.slice(-800)}）`;
  }

  /** Evaluate node check gates; returns an error message on failure, null when all pass. */
  private async runChecks(
    run: RunRecord,
    rec: NodeRunRecord,
    nodeId: string,
    nodeCwd: string,
    gate: { agentName: string; timeoutMs: number; artifactRel: string; blackboard: Map<string, Artifact> },
  ): Promise<string | null> {
    const node = run.graph.nodes.find((n) => n.id === nodeId)!;
    const checks = node.config.checks ?? [];
    for (const c of checks) {
      if (this.cancels.has(run.runId)) return '已取消';
      if (c.type === 'contract') {
        const err = await this.contractGate(run, rec, nodeId, gate);
        if (err) return err;
        continue;
      }
      if (c.type === 'delivery-branch') {
        const err = await this.deliveryBranchGuard(run, rec, nodeId, nodeCwd, c.expectBranch, {
          agentName: gate.agentName,
          timeoutMs: gate.timeoutMs,
        });
        if (err) return err;
        continue;
      }
      if (c.type === 'file-exists') {
        const p = path.resolve(nodeCwd, c.path);
        if (!fs.existsSync(p)) return `检查未通过：文件不存在 ${c.path}`;
      } else if (c.type === 'regex') {
        const p = path.resolve(nodeCwd, c.file);
        let content: string;
        try {
          content = fs.readFileSync(p, 'utf8');
        } catch {
          return `检查未通过：无法读取 ${c.file}`;
        }
        if (!new RegExp(c.pattern).test(content)) return `检查未通过：${c.file} 不匹配 /${c.pattern}/`;
      } else if (c.type === 'command') {
        const res = await execFileAsync('sh', ['-c', c.run], {
          cwd: nodeCwd,
          timeout: Math.min(600_000, Math.max(5_000, c.timeoutMs ?? 120_000)),
        }).then(() => null).catch((err: { message?: string }) => `检查未通过：命令失败 — ${(err.message ?? '').slice(0, 300)}`);
        if (res) return res;
      } else if (c.type === 'manual') {
        // human gate: reuse the approval flow with the check prompt
        rec.state = 'blocked';
        rec.blockedPrompt = c.prompt;
        this.recordEvent(run, 'approval', nodeId, `人工检查：${c.prompt}`);
        rec.blockedAt = new Date().toISOString(); // v12-V2 进门时刻（放门在 approve() 结算）
        this.persistAndNotify(run);
        const decision = await this.awaitGate(run, nodeId); // v13-S4 门收编
        rec.blockedPrompt = undefined;
        if (this.cancels.has(run.runId)) return '已取消';
        if (decision.outcome === 'timeout') return gateTimeoutMessage(decision.waitedMs, decision.capMs);
        const action = decision.action;
        if (action.action === 'reject') return `人工检查未通过：${c.prompt}`;
        if (action.action === 'input' && action.text) {
          // informational input recorded into the artifact
          rec.artifact = { ...rec.artifact, extra: { ...rec.artifact?.extra, 人工反馈: action.text }, source: rec.artifact?.source ?? 'empty', finishedAt: new Date().toISOString() };
        }
        rec.state = 'done';
        this.persistAndNotify(run);
      }
    }
    return null;
  }

  /**
   * M2 契约落册：run 的首个结构化产物。写了 extra.contract（且含断言）的节点产物
   * 被捕获到 RunContract——source 按该节点是否挂契约门判定（有门=谈出来的，无门=自带的）。
   */
  private captureContract(run: RunRecord, rec: NodeRunRecord): void {
    if (run.contract) return;
    const doc = contractOf(rec.artifact?.extra);
    if (!doc || doc.assertions.length === 0) return;
    const node = run.graph.nodes.find((n) => n.id === rec.nodeId);
    const gated = (node?.config.checks ?? []).some((c) => c.type === 'contract');
    // M6 留痕：无门直落路径也接产物自述的模板戳（有门路径以门配置为准，在 contractGate 里盖）
    const claimedTpl = (rec.artifact?.extra?.contract as { template?: unknown } | undefined)?.template;
    run.contract = {
      ...doc,
      source: gated ? 'generated' : 'input',
      ...(typeof claimedTpl === 'string' && claimedTpl ? { template: claimedTpl } : {}),
    };
    this.recordEvent(
      run,
      'run',
      rec.nodeId,
      gated
        ? `契约落册（谈判中，待契约门确认）：断言 ${doc.assertions.length} 条`
        : `契约落册（自带，无需批准）：断言 ${doc.assertions.length} 条`,
    );
    this.persistAndNotify(run);
  }

  /** H1：交付出口捕获——extra.pr_url 是合法 http(s) 链接才落册（拒收垃圾字符串充数）。 */
  private capturePrUrl(run: RunRecord, rec: NodeRunRecord): void {
    if (run.prUrl) return;
    const raw = rec.artifact?.extra?.pr_url;
    if (typeof raw !== 'string') return;
    const url = raw.trim();
    if (!/^https?:\/\/\S+$/.test(url)) return;
    run.prUrl = url;
    // v12-S1a：同一处写两字段——sideEffects.prUrl 是 prUrl 的镜像（不做读时推导），
    // 保证 S1b 门禁只看 sideEffects 一处判据。
    (run.sideEffects ??= {}).prUrl = url;
    this.recordEvent(run, 'run', rec.nodeId, `交付出口：PR 已开出 ${url}`);
    this.persistAndNotify(run);
  }

  /**
   * v12-S1a 副作用归因接线：盲 GitHub 写端点（create-issue/update-issue）带 runId 调用时，
   * 把这次对外部世界的写落进 run 的结构化账（评审 R4：凡要算账的必须落册，不靠事件推导）。
   * 只认活跃 run（未收口）；定位不到/已收口一律 false——端点行为与今天完全一致。
   * 如实边界：agent 是否携带 runId 取决于模板提示词（本片不动模板），无 runId=漏账可见不可判。
   */
  recordIssueSideEffect(runId: string, kind: 'created' | 'patched', issueNumber: number): boolean {
    const run = this.runs.get(runId);
    if (!run || runHasEnded(run.state)) return false;
    const se = (run.sideEffects ??= {});
    if (kind === 'created') (se.issuesCreated ??= []).push(issueNumber);
    else (se.issuePatched ??= []).push(issueNumber);
    // 笔序号入文案：recordEvent 对相邻同文事件去重，同号覆写两次也要各留一条
    const nth = (se.issuesCreated?.length ?? 0) + (se.issuePatched?.length ?? 0);
    this.recordEvent(
      run,
      'run',
      undefined,
      `副作用（S1a）：${kind === 'created' ? `建单 #${issueNumber}（create-issue）` : `覆写 Issue #${issueNumber} 正文（update-issue）`}，已落 run 副作用账（第 ${nth} 笔）`,
    );
    this.persistAndNotify(run);
    return true;
  }

  /**
   * F1 验收机器门：节点产物 extra.assertionResults 存在未通过断言（status 非 ok/n/a）时，
   * 节点不得静默 done——复用审批循环：reject→节点失败；approve→人工追认放行；
   * input→追加一轮指令、重新提取产物后复核。无断言结果或全过则直接放行（向后兼容）。
   */
  private async assertionGate(
    run: RunRecord,
    rec: NodeRunRecord,
    nodeId: string,
    agentName: string,
    timeoutMs: number,
    artifactRel: string,
    blackboard: Map<string, Artifact>,
  ): Promise<string | null> {
    for (;;) {
      const failed = failedAssertionsOf(rec.artifact?.extra);
      if (failed.length === 0) return null;
      if (this.cancels.has(run.runId)) return '已取消';
      rec.state = 'blocked';
      const contractIds = new Set((run.contract?.assertions ?? []).map((a) => a.id));
      rec.blockedPrompt =
        `验收断言未全过（${failed.length} 条）${run.contract ? `——按本单契约 ${contractIds.size} 条对照` : ''}：\n` +
        failed
          .map(
            (f) =>
              `- ${f.id}: ${f.evidence.slice(0, 160) || '（无证据）'}${
                run.contract && !contractIds.has(f.id) ? '（此 id 不在契约内——执行方自增/写错）' : ''
              }`,
          )
          .join('\n');
      this.recordEvent(run, 'approval', nodeId, `验收机器门拦截：${failed.map((f) => f.id).join('、')}`);
      rec.blockedAt = new Date().toISOString(); // v12-V2 进门时刻
      this.persistAndNotify(run);
      const decision = await this.awaitGate(run, nodeId); // v13-S4 门收编
      rec.blockedPrompt = undefined;
      if (this.cancels.has(run.runId)) return '已取消';
      if (decision.outcome === 'timeout') return gateTimeoutMessage(decision.waitedMs, decision.capMs);
      const action = decision.action;
      if (action.action === 'reject') return `验收断言未通过：${failed.map((f) => f.id).join('、')}`;
      if (action.action === 'approve') {
        this.recordEvent(run, 'approval', nodeId, `人工追认放行：${failed.map((f) => f.id).join('、')}`);
        rec.state = 'done';
        this.persistAndNotify(run);
        return null;
      }
      if (action.action === 'input' && action.text) {
        const st = await this.promptAndSettle(run, rec, agentName, action.text, timeoutMs);
        rec.agentStatus = st;
        const tail = await this.ops.readOutput(agentName, 80).catch(() => '');
        rec.artifact = await this.extractArtifact(nodeId, artifactRel, run, tail);
        rec.unverified = rec.artifact.source === 'output-fallback';
        blackboard.set(nodeId, rec.artifact);
        this.persistAndNotify(run);
      }
    }
  }

  /**
   * M1 契约接单门：check type 'contract' 的门体——产物 extra.contract（候选断言+澄清提问）
   * 必须人工批准才放下游。三档处置齐：拦（reject=契约未确认，节点失败）、
   * 警（时间线事件）、谈（input 追加一轮、重取产物后复核）。与执行审批语义分开：
   * 这里确认的是「这单按什么约定干」，不是「干得怎么样」。
   */
  private async contractGate(
    run: RunRecord,
    rec: NodeRunRecord,
    nodeId: string,
    gate: { agentName: string; timeoutMs: number; artifactRel: string; blackboard: Map<string, Artifact> },
  ): Promise<string | null> {
    const { agentName, timeoutMs, artifactRel, blackboard } = gate;
    // M6 留痕红线：门配置带的模板戳（id@sha）优先于产物自述——「按哪版约定干的」以派单时发出去的为准
    const gateCheck = (run.graph.nodes.find((n) => n.id === nodeId)?.config.checks ?? [])
      .find((c) => c.type === 'contract');
    const claimedTpl = (rec.artifact?.extra?.contract as { template?: unknown } | undefined)?.template;
    const stamp = gateCheck?.template ?? (typeof claimedTpl === 'string' && claimedTpl ? claimedTpl : undefined);
    for (;;) {
      if (this.cancels.has(run.runId)) return '已取消';
      const doc = contractOf(rec.artifact?.extra);
      if (!doc) return '契约门未过：产物未写 extra.contract（assertions+questions），无从立约';
      rec.state = 'blocked';
      rec.blockedPrompt = [
        `契约接单门：候选验收断言 ${doc.assertions.length} 条、澄清提问 ${doc.questions.length} 条——契约确认前下游不派`,
        ...doc.assertions.map((a) => `- ${a.id}: ${a.assertion.slice(0, 200)}`),
        ...doc.questions.map((q, i) => `❓${i + 1}. ${q.slice(0, 200)}`),
        '',
        '放行=按此契约执行；补充输入=谈（把答案/修改发给规划 Agent 重出契约）；拒绝=终止本单',
      ].join('\n');
      this.recordEvent(
        run,
        'approval',
        nodeId,
        `契约门拦截：断言 ${doc.assertions.length} 条 / 提问 ${doc.questions.length} 条`,
      );
      rec.blockedAt = new Date().toISOString(); // v12-V2 进门时刻
      this.persistAndNotify(run);
      const decision = await this.awaitGate(run, nodeId); // v13-S4 门收编
      rec.blockedPrompt = undefined;
      if (this.cancels.has(run.runId)) return '已取消';
      if (decision.outcome === 'timeout') return gateTimeoutMessage(decision.waitedMs, decision.capMs);
      const action = decision.action;
      if (action.action === 'reject') {
        // M6 判例回流：整单被拒也值得记——多半是骨架/措辞误导
        this.templateFeedback(run, nodeId, stamp, 'reject', {
          assertions: doc.assertions.map((a) => `${a.id}: ${a.assertion.slice(0, 120)}`),
        });
        return '契约未确认：拒绝即终止本单（下游不派）';
      }
      if (action.action === 'approve') {
        // M2：放行即契约定稿——以批准时这一版内容落册并盖确认时刻；M6：带上模板戳留痕
        run.contract = {
          ...doc,
          source: 'generated',
          confirmedAt: new Date().toISOString(),
          ...(stamp ? { template: stamp } : {}),
        };
        this.recordEvent(
          run,
          'approval',
          nodeId,
          `契约确认放行：${doc.assertions.map((a) => a.id).join('、') || '（无断言，人工认可空契约）'}${stamp ? `（按 ${stamp}）` : ''}`,
        );
        rec.state = 'done';
        this.persistAndNotify(run);
        return null;
      }
      if (action.action === 'input' && action.text) {
        // M6 判例回流：门里被人工追问/改写的内容 = 模板修改建议的原料（判例喂养模板）
        this.templateFeedback(run, nodeId, stamp, 'negotiate', { note: action.text.slice(0, 500) });
        const st = await this.promptAndSettle(run, rec, agentName, action.text, timeoutMs);
        rec.agentStatus = st;
        const tail = await this.ops.readOutput(agentName, 80).catch(() => '');
        rec.artifact = await this.extractArtifact(nodeId, artifactRel, run, tail);
        rec.unverified = rec.artifact.source === 'output-fallback';
        blackboard.set(nodeId, rec.artifact);
        this.persistAndNotify(run);
      }
    }
  }

  /** M6 判例回流：契约门里被拒/被追问的内容记进空间 contract-feedback.jsonl，供人改模板 */
  private templateFeedback(
    run: RunRecord,
    nodeId: string,
    stamp: string | undefined,
    kind: string,
    payload: Record<string, unknown>,
  ): void {
    const spaceDir = path.join(this.store.root, 'spaces', run.spaceId ?? 'default');
    appendTemplateFeedback(spaceDir, {
      kind,
      runId: run.runId,
      nodeId,
      template: stamp ?? null,
      dag: run.dagName,
      ...payload,
    });
  }

  /**
   * H1 分支守卫（引擎侧真约束——「只推工作分支」不能只写在提示词里）：
   * 在节点工作区跑 git rev-parse --abbrev-ref HEAD，核验在交付分支（缺省 pf/<runId>）上。
   * HEAD 是 main/master → 直接失败，不给放行路径；不符 → blocked 不静默；非 git 仓 → 警示跳过。
   */
  private async deliveryBranchGuard(
    run: RunRecord,
    rec: NodeRunRecord,
    nodeId: string,
    nodeCwd: string,
    expectBranch: string | undefined,
    gate: { agentName: string; timeoutMs: number },
  ): Promise<string | null> {
    const expect = (expectBranch ?? `pf/${run.runId}`).trim();
    if (/^(main|master)$/.test(expect)) return `分支守卫：期望分支 ${expect} 即默认分支——不给推 main 的交付路径`;
    const readHead = async (): Promise<string | null> => {
      try {
        const out = await execFileAsync('git', ['-C', nodeCwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: nodeCwd,
          timeout: 10_000,
        });
        return out.stdout.trim();
      } catch {
        return null;
      }
    };
    let cur = await readHead();
    if (cur === null) {
      this.recordEvent(run, 'node', nodeId, '分支守卫：工作区非 git 仓库，跳过分支校验（无远程交付可言）');
      return null;
    }
    for (;;) {
      if (this.cancels.has(run.runId)) return '已取消';
      if (cur === expect) {
        this.recordEvent(run, 'node', nodeId, `分支守卫通过：${cur}`);
        return null;
      }
      if (/^(main|master)$/.test(cur)) {
        return `分支守卫：当前在默认分支「${cur}」——推 main 无放行路径，请把成果挪到 ${expect} 分支后重跑交付`;
      }
      rec.state = 'blocked';
      rec.blockedPrompt = [
        `分支守卫卡住：当前分支「${cur}」≠ 期望交付分支「${expect}」`,
        `放行=确认按「${cur}」交付继续；拒绝=节点失败；补充输入=让 Agent 切分支后复核`,
      ].join('\n');
      this.recordEvent(run, 'approval', nodeId, `分支守卫拦截：${cur} ≠ ${expect}`);
      rec.blockedAt = new Date().toISOString(); // v12-V2 进门时刻
      this.persistAndNotify(run);
      const decision = await this.awaitGate(run, nodeId); // v13-S4 门收编；本函数参数名 gate 是 {agentName,timeoutMs} 载体，门出路一律叫 decision 防遮蔽
      rec.blockedPrompt = undefined;
      if (this.cancels.has(run.runId)) return '已取消';
      if (decision.outcome === 'timeout') return gateTimeoutMessage(decision.waitedMs, decision.capMs);
      const action = decision.action;
      if (action.action === 'reject') return `分支守卫未通过：交付分支不符（${cur} ≠ ${expect}）`;
      if (action.action === 'approve') {
        this.recordEvent(run, 'approval', nodeId, `分支守卫人工放行：按「${cur}」继续`);
        rec.state = 'done';
        this.persistAndNotify(run);
        return null;
      }
      if (action.action === 'input' && action.text) {
        const { agentName, timeoutMs } = gate;
        const st = await this.promptAndSettle(run, rec, agentName, action.text, timeoutMs);
        rec.agentStatus = st;
        cur = (await readHead()) ?? cur;
        this.persistAndNotify(run);
      }
    }
  }

  /**
   * 子流水线节点：按（插值后的）模板名启动子 run。
   * 模板缺失时回退 fallbackTemplate；wait 模式轮询子 run 至终态并镜像结果。
   */
  private async runPipelineNode(
    run: RunRecord,
    node: DagGraph['nodes'][number],
    _blackboard: Map<string, Artifact>,
    onChildStarted: (childId: string) => void,
  ): Promise<string | null> {
    const cfg = node.config.pipeline;
    if (!cfg?.template) return 'pipeline 节点缺少 template 配置';
    const spaceId = run.spaceId ?? 'default';
    const store = new Store(this.store.root, spaceId);

    // 插值：黑板产物 + run 变量（graph.variables 已在启动时展开，这里做 artifact 引用）
    const render = (str: string): string =>
      renderPromptTemplate(str, (refId, refPath) => this.resolveBlackboardRef(_blackboard, refId, refPath));
    const templateName = render(cfg.template).trim();

    let target = store.getGraph(templateName);
    let usedTemplate = templateName;
    if (!target && cfg.fallbackTemplate) {
      usedTemplate = cfg.fallbackTemplate;
      target = store.getGraph(cfg.fallbackTemplate);
      this.recordEvent(run, 'child', node.id, `模板 ${templateName} 不存在，回退到 ${usedTemplate}`);
    }
    if (!target) return `模板不存在：${templateName}${cfg.fallbackTemplate ? `（兜底 ${cfg.fallbackTemplate} 亦未找到）` : ''}`;

    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.params ?? {})) params[k] = render(v);
    // 子 run 的必填变量校验留给 startRun；这里把受理产出透传为 issueId（常见路由约定）
    const issueId = params.issue_id ?? run.issueId;

    onChildStarted('');
    const child = await this.startRun(target, params.cwd ?? run.cwd, spaceId, params, issueId, undefined, { parentRunId: run.runId });
    run.nodes[node.id]!.error = `子运行 ${child.runId}（模板 ${usedTemplate}）`;
    this.recordEvent(
      run,
      'child',
      node.id,
      `启动子运行 ${child.runId}（模板 ${usedTemplate}，${(cfg.mode ?? 'wait') === 'wait' ? '等待完成' : '即发即忘'}）`,
    );
    this.persistAndNotify(run);

    if ((cfg.mode ?? 'wait') === 'wait') {
      const deadline = Date.now() + 24 * 60 * 60 * 1000;
      let lastMirror = 0;
      for (;;) {
        if (this.cancels.has(run.runId)) {
          this.stopRun(child.runId);
          return '已取消（子运行一并停止）';
        }
        const cur = this.getRun(child.runId);
        if (cur && cur.state !== 'running') {
          // 只有全绿 completed 算成功；v11-D3 带失败收口（completed-with-failures）如实上抛，
          // 父节点标 failed——失败可见原则，pipeline 节点不在这里替子 run 洗绿
          if (cur.state === 'completed') return null;
          return `子运行 ${child.runId} 结束于 ${cur.state}`;
        }
        // 进度镜像：把子运行节点粒度进度写到父节点（运行中心可见）
        if (cur && Date.now() - lastMirror > 30_000) {
          lastMirror = Date.now();
          const all = Object.values(cur.nodes);
          const done = all.filter((n) => ['done', 'failed', 'skipped', 'cancelled'].includes(n.state)).length;
          const working = all.find((n) => ['working', 'blocked', 'starting'].includes(n.state));
          const recP = run.nodes[node.id]!;
          recP.error = `子运行 ${child.runId}（模板 ${usedTemplate}）：${done}/${all.length} 节点${working ? ` · ${working.nodeId} ${working.state}` : ''}`;
          this.persistAndNotify(run);
        }
        if (Date.now() > deadline) return '等待子运行超时（24h）';
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    return null;
  }

  /**
   * B14 动态扇出：为 items 的每个元素克隆 fanout 的直接后继（分支模板），
   * 克隆节点内 {{item.field}} 注入元素字段（嵌套字段 JSON 序列化）。原后继节点
   * 标记 skipped 并注明展开数量；下游（fanin）改接克隆节点。
   */
  private expandFanout(
    run: RunRecord,
    fanoutId: string,
    items: unknown[],
    pending: Set<string>,
    blackboard: Map<string, Artifact>,
  ): void {
    const succIds = run.graph.edges.filter((e) => e.source === fanoutId).map((e) => e.target);
    for (const succId of succIds) {
      const orig = run.graph.nodes.find((n) => n.id === succId);
      if (!orig) continue;
      const origOut = run.graph.edges.filter((e) => e.source === succId);
      run.graph.edges = run.graph.edges.filter((e) => e.source !== fanoutId || e.target !== succId);
      run.graph.edges = run.graph.edges.filter((e) => e.source !== succId);
      items.forEach((item, i) => {
        const rec0: Record<string, unknown> =
          item && typeof item === 'object' ? (item as Record<string, unknown>) : { value: item };
        const cid = `${succId}__${i + 1}`;
        const clone = structuredClone(orig);
        clone.id = cid;
        const sub = (str: string): string =>
          str.replace(/\{\{\s*item\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, keyPath: string) => {
            let v: unknown = rec0;
            for (const seg of keyPath.split('.')) {
              if (v === null || typeof v !== 'object') return whole;
              v = (v as Record<string, unknown>)[seg];
            }
            if (v === undefined) return whole;
            return typeof v === 'string' ? v : JSON.stringify(v);
          });
        clone.label = sub(`${orig.label} · ${String(rec0.name ?? i + 1)}`);
        clone.config.prompt = clone.config.prompt ? sub(clone.config.prompt) : clone.config.prompt;
        clone.config.cwd = clone.config.cwd ? sub(clone.config.cwd) : clone.config.cwd;
        run.graph.nodes.push(clone);
        run.nodes[cid] = { nodeId: cid, state: 'pending', attempts: 0 };
        run.graph.edges.push({ id: `e-${fanoutId}-${cid}`, source: fanoutId, target: cid });
        for (const e of origOut) {
          run.graph.edges.push({ id: `e-${cid}-${e.target}`, source: cid, target: e.target });
        }
        pending.add(cid);
      });
      if (pending.has(succId)) pending.delete(succId);
      const rec = run.nodes[succId]!;
      rec.state = 'skipped';
      rec.error = `分支模板已展开为 ${items.length} 个实例`;
      this.persistAndNotify(run);
    }
  }

  /**
   * 等待 Agent 就绪；超时或启动对话框时转人工闸门（审批卡片 + 终端预览按键），
   * 而不是直接判死——弱网/慢模型/首次对话框都可能让就绪等待超时。
   */
  private async waitReadyWithGate(
    run: RunRecord,
    rec: NodeRunRecord,
    agentName: string,
    cfg: DagNodeConfig,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(60_000, this.opts.agentReadyTimeoutMs * 2);
    for (;;) {
      if (this.cancels.has(run.runId)) throw new Error('已取消');
      const status = (await this.ops.getAgentStatus(agentName)) ?? 'unknown';
      rec.agentStatus = status;
      if (status === 'idle' || status === 'done') return;
      if (status === 'blocked') {
        // 常见确认框（trust/bypass：光标默认在否定项）自动应答一轮，未决再转人工
        rec.state = 'blocked';
        rec.blockedPrompt = '启动确认框：自动应答中（下移+回车）…';
        this.persistAndNotify(run);
        await this.ops.sendKeys(agentName, ['down']).catch(() => {});
        await sleep(400);
        await this.ops.sendKeys(agentName, ['enter']).catch(() => {});
        await sleep(4000);
        const after = (await this.ops.getAgentStatus(agentName)) ?? 'unknown';
        rec.agentStatus = after;
        if (after === 'idle' || after === 'done') {
          rec.state = 'starting';
          this.persistAndNotify(run);
          continue;
        }
        rec.state = 'blocked';
        rec.blockedPrompt = '自动应答未解决启动确认——请在终端预览查看并用按键处理，或点放行发送回车';
        // v12-V2 进门留痕补口：自动应答未决转人工这一步此前也无拦侧事件——补齐 + 记进门时刻
        //（自动应答那段不算人等，只在真正等人按键的 waiter 前记）
        this.recordEvent(run, 'approval', rec.nodeId, '启动确认拦截：自动应答未决，等待人工按键或放行');
        rec.blockedAt = new Date().toISOString();
        this.persistAndNotify(run);
        const decision = await this.awaitGate(run, rec.nodeId); // v13-S4 门收编；到期经 throw 收口为「启动失败：等待审批超时…」固定句式
        rec.blockedPrompt = undefined;
        if (this.cancels.has(run.runId)) throw new Error('已取消');
        if (decision.outcome === 'timeout') throw new Error(gateTimeoutMessage(decision.waitedMs, decision.capMs));
        const action = decision.action;
        if (action.action === 'reject') throw new Error('启动确认被人工拒绝');
        const keys = action.keys ?? (action.action === 'approve' ? (cfg.approveKeys ?? ['enter']) : ['enter']);
        await this.ops.sendKeys(agentName, keys).catch(() => {});
        if (action.action === 'input' && action.text) {
          await this.ops.sendKeys(agentName, [action.text]).catch(() => {});
        }
        this.persistAndNotify(run);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`启动超时（最后状态 ${status}）——可在终端预览查看 Agent 画面`);
      }
      await sleep(2500);
    }
  }

  /**
   * Resolve which agent CLI to launch（AE 链）：
   * 统一覆盖(space) > 节点指定 > 角色默认 > 空间默认 > 自动推荐（已装优先 pi）> opencode 兜底。
   */
  private async resolveAgentKind(run: RunRecord, cfg: DagNodeConfig): Promise<string> {
    const profile = this.storeFor(run).readProfile();
    const spaceDefault = profile.defaultAgentKind?.trim();
    if (profile.agentOverride && spaceDefault) return spaceDefault;
    if (cfg.agentKind) return cfg.agentKind;
    const role = this.roleById(run, cfg.role);
    if (role?.agentKind) return role.agentKind;
    if (spaceDefault) return spaceDefault;
    const recommend = this.opts.recommendAgentKind ?? probeRecommendAgentKind;
    return (await recommend()) ?? 'opencode';
  }

  /**
   * v12-V1：起单时一次性算好本单实发 harness（graphSha + agentKind + 网关档/模型）。
   * agentKind 走 resolveAgentKind 同款链，作用域取执行序首个 agent 节点的 config——
   * 落册一次不每节点重写，节点间 kind 差异（若有）仍以各节点实发为准。
   */
  private async buildRunHarness(run: RunRecord, order: string[]): Promise<RunHarness> {
    const firstAgentCfg =
      order
        .map((id) => run.graph.nodes.find((n) => n.id === id))
        .find((n) => n?.type === 'agent')?.config ?? {};
    const agentKind = await this.resolveAgentKind(run, firstAgentCfg);
    const { gwProfile, model } = this.gatewayHarnessFor(run);
    return {
      graphSha: contentSha(run.graph),
      agentKind,
      ...(model ? { model } : {}),
      ...(gwProfile ? { gwProfile } : {}),
    };
  }

  /** v12-V1：现读网关两个闸口（空间钉档 id + 生效档 freeModel）；读不到一律留缺省，不估算 */
  private gatewayHarnessFor(run: RunRecord): { gwProfile?: string; model?: string } {
    const gwProfile = this.gatewayPinFor(run);
    try {
      const model = gatewayActive(this.store.root, gwProfile)
        ? readGateway(this.store.root, gwProfile).freeModel?.trim()
        : undefined;
      return { ...(gwProfile ? { gwProfile } : {}), ...(model ? { model } : {}) };
    } catch {
      return gwProfile ? { gwProfile } : {};
    }
  }

  private roleById(run: RunRecord, roleId: string | undefined): Role | undefined {
    if (!roleId) return undefined;
    return loadRoles(this.store.root).find((r) => r.id === roleId);
  }

  /** Convention block from the space profile + role prePrompt, prepended to prompts. M3: 规则按节点工作目录做作用域匹配。 */
  private resolveContext(
    run: RunRecord,
    cfg: DagNodeConfig,
    nodeCwd?: string,
  ): { block: string; agentKind?: string } {
    const parts: string[] = [];
    const role = this.roleById(run, cfg.role);
    if (role?.prePrompt) parts.push(`${role.prePrompt}\n`);
    try {
      const profile = this.storeFor(run).readProfile();
      const read = (p: string) => {
        try {
          return fs.readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      };
      const hit = matchRules(effectiveRules(profile), profile.rootCwd, nodeCwd);
      const block = buildConventionBlock(profile.rootCwd, hit, read);
      if (block) parts.push(block);
      // I1：技能库走约定同款通道（整篇注入、大小上限复用），与命中规则同文件去重避免双份
      const skillFiles = (profile.skills ?? []).filter((f) => !hit.some((r) => r.file === f));
      const skillBlock = buildSkillBlock(profile.rootCwd, skillFiles, read);
      if (skillBlock) parts.push(skillBlock);
    } catch {
      // profile unreadable — proceed without conventions
    }
    return { block: parts.join('\n'), agentKind: role?.agentKind };
  }

  /**
   * R3.1 同仓并发隔离：git worktree add 独立目录 + 独立分支（脏目录保留并注明）。
   */
  private createWorktree(repo: string, runId: string, nodeId: string): { path: string; branch: string } {
    const wtPath = path.join(this.wtRoot, `${runId}-${nodeId}`);
    const branch = `paneflow/${runId}-${nodeId}`;
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    // 首驾-4 重试幂等：上轮尝试的 worktree/分支可能残留（回收只删目录不删分支；脏则保目录）——
    // 目录在就直接续用，仅分支在就挂分支续用，都没有才 -b 新建；旧实现无条件 -b，重试必炸「分支已经存在」
    if (fs.existsSync(wtPath)) {
      console.log(`[engine] worktree 重建：续用残留目录 ${wtPath}`);
    } else {
      const hasBranch = execFileSync('git', ['-C', repo, 'branch', '--list', branch], { timeout: 10_000 }).toString().trim() !== '';
      const args = hasBranch ? ['worktree', 'add', wtPath, branch] : ['worktree', 'add', wtPath, '-b', branch];
      if (hasBranch) console.log(`[engine] worktree 重建：续用既有分支 ${branch}`);
      execFileSync('git', ['-C', repo, ...args], { timeout: 30_000 });
    }
    const entry = { runId, repo, path: wtPath, branch };
    this.liveWorktrees.push(entry);
    return entry;
  }

  /** R3.5 worktree 回收：干净则 remove，脏则保留目录并在日志注明。 */
  private reclaimWorktrees(runId: string): void {
    for (const wt of this.liveWorktrees.filter((w) => w.runId === runId)) {
      try {
        if (gitStatusPorcelain(wt.path)) {
          console.warn(`[engine] worktree 有未提交变更，保留目录：${wt.path}`);
          continue;
        }
        execFileSync('git', ['-C', wt.repo, 'worktree', 'remove', wt.path], { timeout: 15_000 });
      } catch (err) {
        console.warn(`[engine] worktree 回收失败（保留）：${wt.path} — ${(err as Error).message}`);
      }
    }
    for (let i = this.liveWorktrees.length - 1; i >= 0; i--) {
      if (this.liveWorktrees[i]!.runId === runId) this.liveWorktrees.splice(i, 1);
    }
  }

  /** Submit a prompt and wait for the turn to settle (server-side wait + poll). */
  private async promptAndSettle(
    run: RunRecord,
    rec: NodeRunRecord,
    agentName: string,
    text: string,
    timeoutMs: number,
  ): Promise<AgentStatus> {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; ; i++) {
      const remaining = Math.max(1000, deadline - Date.now());
      try {
        await this.ops.promptAgent(agentName, text, remaining);
        const confirmMs = this.opts.promptConfirmWindowMs ?? 0;
        if (confirmMs > 0) await this.confirmPromptLanded(agentName, confirmMs);
      } catch (err) {
        const msg = (err as Error).message;
        // observed start-race: the agent name binds slightly after agent.start
        if (i < 2 && /agent_not_ready|not an active named agent/i.test(msg)) {
          await sleep(1500);
          continue;
        }
        throw err;
      }
      return await this.waitForSettle(run, rec, agentName, Math.max(1000, deadline - Date.now()));
    }
  }

  /**
   * A.4 确认窗：prompt 提交后 confirmMs 内状态必须离开 idle/done（working/blocked），
   * 否则视为 prompt 石沉大海，快速失败进重试（替代 herdr 侧不可配的 5s 判杀）。
   * 查询接口自身故障按"无变化"处理——宁可窗口末误杀重试，不可无证据放行挂起 45min。
   */
  private async confirmPromptLanded(agentName: string, confirmMs: number): Promise<void> {
    const deadline = Date.now() + confirmMs;
    for (;;) {
      let status: AgentStatus | 'unknown';
      try {
        status = (await this.ops.getAgentStatus(agentName)) ?? 'unknown';
      } catch (err) {
        console.warn(`[engine] 确认窗状态查询失败，按无变化处理：${(err as Error).message}`);
        status = 'unknown';
      }
      if (status === 'working' || status === 'blocked') return;
      if (Date.now() >= deadline) {
        throw new Error(`agent_prompt_stalled：提交后 ${confirmMs}ms 无状态变化（确认窗，末次状态 ${status}）`);
      }
      await sleep(2000);
    }
  }

  private async waitForSettle(
    run: RunRecord,
    rec: NodeRunRecord,
    agentName: string,
    timeoutMs: number,
  ): Promise<AgentStatus> {
    const deadline = Date.now() + timeoutMs;
    let blockedStreak = 0;
    for (;;) {
      if (this.cancels.has(run.runId)) throw new Error('已取消');
      const status = (await this.ops.getAgentStatus(agentName)) ?? 'unknown';
      rec.agentStatus = status;
      if (status === 'idle' || status === 'done') {
        this.persistAndNotify(run);
        return status;
      }
      if (status === 'blocked') {
        // herdr 偶发把 bypass 横幅误判为 blocked：连续两次（间隔 3s）仍是 blocked 才采信
        blockedStreak += 1;
        if (blockedStreak >= 2) {
          this.persistAndNotify(run);
          return 'blocked';
        }
        await sleep(3000);
        continue;
      }
      blockedStreak = 0;
      if (Date.now() >= deadline) {
        // v13-S2 触发点 (a)：收敛超时——这一轮到此为止，先掐旧 agent 再抛错进下一步，
        // 不许它还活着把退避窗/下一轮的预算烧掉（旧实现直接抛，agent 原地续跑）
        await this.interruptAttemptAgent(run, rec, 'settle-timeout');
        throw new Error('等待节点完成超时');
      }
      await sleep(1000);
    }
  }

  private async settleAfterKeys(rec: NodeRunRecord, agentName: string, timeoutMs: number): Promise<AgentStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = (await this.ops.getAgentStatus(agentName)) ?? 'unknown';
      rec.agentStatus = status;
      if (status === 'idle' || status === 'done' || status === 'blocked') return status;
      if (Date.now() >= deadline) return 'unknown';
      await sleep(800);
    }
  }

  /** Capture a terminal output snapshot onto the node record (bounded). */
  private captureOutput(run: RunRecord, rec: NodeRunRecord): void {
    if (!rec.agentName) return;
    void this.ops
      .readOutput(rec.agentName, 120)
      .then((text) => {
        if (!text.trim()) return;
        const snaps = (rec.outputSnapshots ??= []);
        const last = snaps[snaps.length - 1];
        if (last && last.text === text) return;
        snaps.push({ at: new Date().toISOString(), text: text.slice(0, 8192) });
        if (snaps.length > 12) snaps.splice(0, snaps.length - 12);
        this.recordEvent(run, 'snapshot', rec.nodeId, `采集终端输出快照（${snaps.length}/12）`);
      })
      .catch(() => {});
  }

  /** Append the artifact hand-off contract unless the prompt already mentions it. */
  private withArtifactConvention(prompt: string, artifactFile: string): string {
    if (prompt.includes('artifact.json')) return prompt;
    return (
      `${prompt}\n\n` +
      `【结果交接约定】完成任务后，请务必用绝对路径创建结果文件 ${artifactFile}` +
      `（目录不存在则先创建，可直接用 shell 命令写入），内容为 JSON 对象，字段：` +
      `summary（本次工作结论，必填，简洁准确）、files（创建/修改的文件路径数组，无则省略）、` +
      `errors（遇到的错误列表，无则省略）。写完后在终端回复一行确认即可，不要粘贴整个 JSON。`
    );
  }

  private async extractArtifact(
    nodeId: string,
    artifactFile: string,
    run: RunRecord,
    outputTail: string,
  ): Promise<Artifact> {
    const now = new Date().toISOString();
    const node = run.graph.nodes.find((n) => n.id === nodeId)!;
    const nodeCwd = node.config.cwd ? path.resolve(run.cwd, node.config.cwd) : run.cwd;
    const file = path.join(nodeCwd, artifactFile);
    let artifact: Artifact;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<Artifact, 'source' | 'finishedAt'>;
      artifact = { ...parsed, outputTail, source: 'file', finishedAt: now };
    } catch {
      artifact = {
        summary: outputTail ? outputTail.split('\n').slice(-5).join('\n') : undefined,
        outputTail,
        source: outputTail ? 'output-fallback' : 'empty',
        finishedAt: now,
      };
    }
    // v12-S2 实时累计：产物落册即把合法 usage（agent 自报）增量进 run.costLive——
    // 四个提取点（主落册/澄清轮/F1 门内复核/契约门谈判）一处接线全覆盖；
    // 调用方随后的 persistAndNotify 把它结构化落盘，重启恢复不丢累计。
    this.bookArtifactUsage(run, nodeId, artifact);
    return artifact;
  }

  /**
   * v12-S2 累账入口（判据全在 token-budget.ts 纯函数）：破烂 usage 静默跳过、绝不估算；
   * 同节点重提取值不变零增量不双计，重试后报得更多只补差额（只增不减）。
   */
  private bookArtifactUsage(run: RunRecord, nodeId: string, artifact: Artifact | undefined): void {
    const usage = parseUsage(artifact?.extra);
    if (!usage) return;
    const next = bookUsage(run.costLive, nodeId, usage);
    if (next !== run.costLive) run.costLive = next;
  }

  /**
   * v12-S2 熔断执行点（节点尝试启动前调用）：超限返回 error 一句（status/watch 原样带出），
   * 并落「预算熔断（S2）」事件——调用方走既有失败收口（abort → run failed），不新增状态。
   * 上限现场解析 resolveTokenCap(run.contract, env)：契约可能 run 中途才落册，晚于派单也生效。
   * 账本为空（从未有合法 usage 自报）不熔断只警示（评审 R3：绝不估算、宁漏不误杀）——
   * 「usage 未自报，预算比对失效」警示事件全 run 只发一次（判据=时间线里没这句；
   * 500 条环形卷出或重启后理论上会再发一次，警示无害可接受）。
   * maxMinutes 时长维度不在本片：节点 timeoutMs 缺省 30min 硬顶是先例。
   */
  private tokenBudgetBreach(run: RunRecord, nodeId: string): string | null {
    const cap = resolveTokenCap(run.contract, this.runMaxTokensEnv);
    if (cap === null) return null;
    const breach = budgetBreach(run.costLive, cap);
    if (!breach) {
      // 警示时机=「已有节点跑完、账本却仍是空」——首节点启动前没机会自报属正常，不打扰
      const sawSettled = Object.values(run.nodes).some((n) => n.state === 'done');
      if (!run.costLive && sawSettled && !(run.events ?? []).some((e) => e.text.includes('预算比对失效'))) {
        this.recordEvent(
          run,
          'run',
          undefined,
          'token 预算（S2）：usage 未自报，预算比对失效——产物自报 extra.usage 后才强制；绝不估算，宁漏不误杀',
        );
        this.persistAndNotify(run);
      }
      return null;
    }
    const error = budgetBreachMessage(breach.used, breach.cap);
    this.recordEvent(
      run,
      'run',
      nodeId,
      `预算熔断（S2）：${error}，run 停止于「${nodeId}」启动前；后续节点不再调度`,
    );
    this.persistAndNotify(run);
    return error;
  }

  private resolveBlackboardRef(
    blackboard: Map<string, Artifact>,
    refId: string,
    refPath: string | undefined,
  ): string | undefined {
    const artifact = blackboard.get(refId);
    if (!artifact) return undefined;
    if (!refPath) return artifact.summary ?? artifact.outputTail;
    if (refPath === 'output') return artifact.outputTail;
    const segments = refPath.replace(/^artifact\.?/, '').split('.').filter(Boolean);
    let cur: unknown = artifact as unknown;
    for (const seg of segments) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur === undefined ? undefined : String(cur);
  }

  // -- infrastructure -------------------------------------------------------------

  /**
   * F3（v8 裁决通电）："事件+轮询双向校对"补齐轮询一半，守卫已带——
   * reconcileIntervalMs<=0（PF_RECONCILE_MS=0）视为显式关闭，直接不启动，
   * 防止 setInterval(0) 退化为 ~4ms 空转打爆 herdr（v6 G1 已知坑）。
   */
  private startReconciler(): void {
    if (this.reconcileTimer || this.opts.reconcileIntervalMs <= 0) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.opts.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  /** Polling reconciliation against live agent status (guards event loss). */
  async reconcile(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.state !== 'running') continue;
      for (const rec of Object.values(run.nodes)) {
        if (!rec.agentName || (rec.state !== 'working' && rec.state !== 'blocked')) continue;
        // v13-S2 判据重做：走 probeAgent 三态判别读——'gone'（herdr 明确应答 not_found 类错误码）
        // 才判「agent 已没」，掐断该轮尝试并落 agent-gone 账；null=没答上话（传输错/超时/
        // 破烂应答）一律不判。旧实现用 getAgentStatus，它把一切错误压成 null，「查无此 agent」
        // 与「server 没答上话」塌成同一读数——判死与不判两头都拿它当证据，故这条读单独开。
        const probed = await this.ops.probeAgent(rec.agentName);
        if (probed === 'gone') {
          await this.interruptAttemptAgent(run, rec, 'agent-gone');
          continue;
        }
        if (!probed) continue;
        if (probed !== rec.agentStatus) {
          rec.agentStatus = probed;
          if (rec.state === 'working' && probed === 'blocked') rec.state = 'blocked';
          if (rec.state === 'blocked' && probed === 'working') rec.state = 'working';
          this.persistAndNotify(run);
        }
      }
    }
  }

  /** R5.3 事件时间线：关键状态变迁留档（随 run 持久化，上限 500 条） */
  private recordEvent(run: RunRecord, type: 'node' | 'run' | 'child' | 'approval' | 'snapshot', nodeId: string | undefined, text: string): void {
    const events = (run.events ??= []);
    const last = events[events.length - 1];
    if (last && last.type === type && last.nodeId === nodeId && last.text === text) return; // 去重
    events.push({ at: new Date().toISOString(), type, nodeId, text });
    if (events.length > 500) events.splice(0, events.length - 500);
  }

  private persistAndNotify(run: RunRecord): void {
    try {
      this.storeFor(run).saveRun(run);
    } catch (err) {
      // never let persistence break a live run —— 但不等于不说：v13-S5 起写盘失败会抛，
      // 这里只降级为日志 + Store.persistFailures 计数（挂 health 读端），在飞单照跑
      console.error(`[paneflow] 在飞 run 落账失败 run=${run.runId}：${(err as Error).message}`);
    }
    for (const l of this.listeners) {
      try {
        l(structuredClone(run));
      } catch {
        // listener errors must not break the engine
      }
    }
  }
}

function paneIdOf(rec: NodeRunRecord): string {
  return rec.paneId ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function gitRepoRoot(dir: string): string | null {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

function gitStatusPorcelain(repo: string): string | null {
  try {
    const out = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { timeout: 5000 });
    const text = String(out);
    return text.trim() ? text : null;
  } catch {
    return null; // 非 git 仓库/无 git 命令 —— 视为干净
  }
}

function nodeCwdOf(run: RunRecord, cfg: DagNodeConfig): string {
  return cfg.cwd ? path.resolve(run.cwd, cfg.cwd) : run.cwd;
}

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });
}
