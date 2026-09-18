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
  RunRecord,
  RunCost,
  NodeCost,
} from '@paneflow/shared';
import { applyVariables, renderPromptTemplate, topoSort, validateDag, validateAcceptance } from '@paneflow/shared';
import type { HerdrOps } from './herdr-ops.js';
import { makeAgentName } from './herdr-ops.js';
import { Store } from './store.js';
import { buildConventionBlock, loadRoles, type Role } from './roles.js';
import { buildGatewayEnv } from '../api/gateway.js';
import { buildGithubEnv } from '../api/github-cred.js';

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
}

export interface ApprovalAction {
  action: 'approve' | 'reject' | 'input';
  keys?: string[];
  text?: string;
}

type RunListener = (run: RunRecord) => void;

/** Default artifact file for a node (node-scoped so shared-cwd branches don't clobber each other). */
function defaultArtifactFile(nodeId: string): string {
  return `.herdr/artifacts/${nodeId}.json`;
}

/**
 * Deterministic DAG execution engine on top of Herdr panes.
 * M1: serial scheduling. Fan-out/Fan-in parallelism lands in M2 on the same
 * node lifecycle primitives built here.
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

  constructor(
    private readonly ops: HerdrOps,
    private readonly store: Store,
    private readonly opts: EngineOptions,
  ) {
    // surface past runs (from disk, across all spaces) in listings after boot.
    // Runs persisted as 'running' belong to a dead process — their workspaces
    // were reclaimed by the orphan sweep; mark them interrupted.
    for (const space of Store.listSpaces(store.root)) {
      for (const run of new Store(store.root, space.id).listRuns()) {
        if (run.state === 'running') {
          run.state = 'failed';
          run.finishedAt = run.finishedAt ?? new Date().toISOString();
          for (const rec of Object.values(run.nodes)) {
            if (['working', 'blocked', 'queued', 'starting', 'retrying'].includes(rec.state)) {
              rec.state = 'failed';
              rec.error = '服务重启，运行中断';
            }
          }
          try {
            new Store(store.root, space.id).saveRun(run);
          } catch {
            // best-effort persistence
          }
        }
        this.runs.set(run.runId, run);
      }
    }
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

  /** Boot-time sweep: reclaim leftover workspaces from dead previous runs. */
  async recoverOrphans(): Promise<string[]> {
    const reclaimed: string[] = [];
    try {
      const workspaces = await this.ops.listWorkspaces();
      for (const w of workspaces) {
        if (!w.label?.startsWith(this.opts.workspaceLabelPrefix)) continue;
        const owned = [...this.runs.values()].some((r) => r.workspaceId === w.workspace_id);
        if (!owned) {
          try {
            await this.ops.closeWorkspace(w.workspace_id);
            reclaimed.push(w.workspace_id);
          } catch {
            // leave it; the next sweep will retry
          }
        }
      }
    } catch {
      // Herdr offline at boot — the sweep runs again on the next start
    }
    return reclaimed;
  }

  async startRun(
    graph: DagGraph,
    cwd: string,
    spaceId?: string,
    variables?: Record<string, string>,
    issueId?: string,
    resumeOf?: string,
  ): Promise<RunRecord> {
    // R3.4 同 issue 幂等锁：同空间同 issue 已有运行中流水线时拒绝重复下发
    if (issueId) {
      const dup = [...this.runs.values()].find(
        (r) => r.state === 'running' && r.issueId === issueId && (r.spaceId ?? 'default') === (spaceId ?? 'default'),
      );
      if (dup) {
        throw new Error(`Issue ${issueId} 已有运行中的流水线（run ${dup.runId}），如需重跑请先停止它`);
      }
    }
    // R3.3 启动前脏检查：git 仓库有未提交改动时拒绝（不覆盖用户工作区）
    const dirtyErr = this.checkDirtyRepos(graph, cwd, spaceId);
    if (dirtyErr) throw new Error(dirtyErr);
    const applied = applyVariables(graph, variables);
    if (applied.missing.length) {
      throw new Error(`缺少必填参数：${applied.missing.join('、')}`);
    }
    graph = applied.graph;
    const issues = validateDag(graph);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      throw new Error(`DAG 校验失败：${errors.map((e) => e.message).join('；')}`);
    }
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
    const runId = randomUUID().slice(0, 8);
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
      nodes,
      startedAt: new Date().toISOString(),
    };
    this.runs.set(runId, run);
    this.recordEvent(run, 'run', undefined, `运行启动：${graph.name}（${order.length} 个节点）`);
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
        if (srcRec.artifact) blackboardPreload.set(nodeId, srcRec.artifact);
        inherited += 1;
      }
      if (inherited) {
        this.recordEvent(run, 'run', undefined, `断点续跑：继承 ${resumeOf} 的 ${inherited} 个已完成节点`);
      }
    }
    this.persistAndNotify(run);

    // Fire and forget — the HTTP layer returns the runId immediately and the
    // canvas follows state over WebSocket.
    void this.execute(run, order, blackboardPreload).catch((err) => {
      run.state = 'failed';
      run.finishedAt = new Date().toISOString();
      this.persistAndNotify(run);
      console.error(`[engine] run ${runId} crashed:`, err);
    });
    return run;
  }

  stopRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.state !== 'running') return false;
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
    // actively interrupt in-flight agents (esc dismisses dialogs, ctrl+c
    // interrupts the turn) so server-held prompt waits settle promptly
    for (const rec of Object.values(run.nodes)) {
      if (!rec.agentName || !['working', 'blocked', 'starting'].includes(rec.state)) continue;
      const agentName: string = rec.agentName;
      void this.ops
        .sendKeys(agentName, ['escape'])
        .catch(() => {})
        .then(() => sleep(300))
        .then(() => this.ops.sendKeys(agentName, ['ctrl+c']))
        .catch(() => {});
    }
    return true;
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
      this.persistAndNotify(run);
    }
    waiter(action);
    return true;
  }

  isBlocked(runId: string, nodeId: string): boolean {
    return this.blockedWaiters.has(`${runId}:${nodeId}`);
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
      else run.state = 'completed';
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
      try {
        await this.ops.closeWorkspace(run.workspaceId!);
      } catch (err) {
        console.error(`[engine] workspace cleanup failed for ${run.workspaceId}:`, err);
      }
      this.rootPanes.delete(run.runId);
      this.cancels.delete(run.runId);
      run.cost = this.computeRunCost(run); // R6a：先记账再广播（持久化含 cost）
      this.persistAndNotify(run);
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

    for (;;) {
      if (this.cancels.has(run.runId)) break;

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

          if (this.paneSlots.acquired >= capacity) break; // global pool full — resume after any release
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
    const maxAttempts = 1 + Math.max(0, node.config.retryCount ?? 0);
    const onFail = node.config.onFail ?? 'abort';

    let lastError = '未知错误';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.cancels.has(run.runId)) return 'abort';
      rec.attempts = attempt;
      rec.state = attempt > 1 ? 'retrying' : 'queued';
      rec.error = undefined;
      if (attempt > 1) {
        this.recordEvent(run, 'node', nodeId, `第 ${attempt - 1} 次重试（最多 ${maxAttempts - 1} 次）`);
      }
      this.persistAndNotify(run);

      lastError = await this.attemptNode(run, node.id, blackboard);
      if (lastError === 'ok') return 'done';
      if (this.cancels.has(run.runId)) return 'abort';

      rec.state = 'failed';
      rec.error = lastError;
      rec.finishedAt = new Date().toISOString();
      this.persistAndNotify(run);
    }
    return onFail === 'continue' ? 'failed' : 'abort';
  }

  /** One full attempt: pane → agent → ready → prompt → (approval) → artifact. */
  private async attemptNode(run: RunRecord, nodeId: string, blackboard: Map<string, Artifact>): Promise<'ok' | string> {
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
            while (this.repoClaims.get(repo)?.runId === holder.runId) {
              if (this.cancels.has(run.runId)) return '已取消（等待仓库锁）';
              if (Date.now() > lockDeadline) return `仓库锁等待超时：${repo}`;
              await sleep(1500);
            }
          }
        }
        this.repoClaims.set(repo, { runId: run.runId, nodeId, key: myKey });
        repoClaimKey = repo;
      }
      // env 合并：全局 < 模型网关 < 角色 < 节点
      let paneEnv: Record<string, string> = {
        ...(this.opts.paneEnv ?? {}),
        ...buildGatewayEnv(this.store.root),
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
        const ws = await this.ops.createWorkspace(
          `${this.opts.workspaceLabelPrefix}${run.runId}-r${rec.attempts}`, run.cwd, this.opts.paneEnv ?? {},
        );
        run.workspaceId = ws.workspaceId;
        this.rootPanes.set(run.runId, ws.rootPaneId);
        paneId = await this.ops.splitPane(ws.workspaceId, ws.rootPaneId, nodeCwd, paneEnv);
      }
      rec.paneId = paneId;
      rec.agentName = agentName;
      // claude 自动附加沙箱豁免 + 网关/凭据 env（信任与 bypass 对话框经 settings 预接受）
      let startArgs = [...(cfg.agentArgs ?? [])];
      const kind = this.resolveAgentKind(run, cfg);
      if (kind === 'claude') {
        const bootstrapEnv = {
          ...buildGatewayEnv(this.store.root),
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
      const { block, agentKind } = this.resolveContext(run, cfg);
      const prompt = this.withArtifactConvention(
        `${block}${rendered}`,
        path.join(nodeCwd, cfg.artifactFile ?? defaultArtifactFile(nodeId)),
      );
      let status = await this.promptAndSettle(run, rec, agentName, prompt, timeoutMs);

      // 3. human approval loop while blocked
      while (status === 'blocked' && !this.cancels.has(run.runId)) {
        rec.state = 'blocked';
        rec.agentStatus = 'blocked';
        this.persistAndNotify(run);
        const action = await new Promise<ApprovalAction>((resolve) => {
          this.blockedWaiters.set(`${run.runId}:${nodeId}`, resolve);
        });
        if (this.cancels.has(run.runId)) return '已取消';
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
      const artifact = await this.extractArtifact(nodeId, cfg.artifactFile ?? defaultArtifactFile(nodeId), run, outputTail);
      rec.artifact = artifact;
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
          this.persistAndNotify(run);
          const action = await new Promise<ApprovalAction>((resolve) => {
            this.blockedWaiters.set(`${run.runId}:${nodeId}`, resolve);
          });
          rec.blockedPrompt = undefined;
          if (this.cancels.has(run.runId)) return '已取消';
          if (action.action === 'reject') return '澄清被人工终止';
          if (action.action === 'approve') break; // 强制放行
          if (action.action === 'input' && action.text) {
            // answers become a follow-up turn; artifact re-extracted for the next aligned check
            await this.promptAndSettle(run, rec, agentName, action.text, timeoutMs);
            const tail = await this.ops.readOutput(agentName, 80).catch(() => '');
            rec.artifact = await this.extractArtifact(nodeId, cfg.artifactFile ?? defaultArtifactFile(nodeId), run, tail);
            blackboard.set(nodeId, rec.artifact);
            this.persistAndNotify(run);
          }
        }
        rec.state = 'done';
        this.persistAndNotify(run);
      }

      // checks gate: all configured checks must pass for the node to be done
      const checkFail = await this.runChecks(run, rec, nodeId, nodeCwdOf(run, cfg));
      if (checkFail) return checkFail;

      this.persistAndNotify(run);
      return 'ok';
    } catch (err) {
      return (err as Error).message;
    } finally {
      unsub?.();
    }
  }

  /** Evaluate node check gates; returns an error message on failure, null when all pass. */
  private async runChecks(
    run: RunRecord,
    rec: NodeRunRecord,
    nodeId: string,
    nodeCwd: string,
  ): Promise<string | null> {
    const node = run.graph.nodes.find((n) => n.id === nodeId)!;
    const checks = node.config.checks ?? [];
    for (const c of checks) {
      if (this.cancels.has(run.runId)) return '已取消';
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
        this.persistAndNotify(run);
        const action = await new Promise<ApprovalAction>((resolve) => {
          this.blockedWaiters.set(`${run.runId}:${nodeId}`, resolve);
        });
        rec.blockedPrompt = undefined;
        if (this.cancels.has(run.runId)) return '已取消';
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
    const child = await this.startRun(target, params.cwd ?? run.cwd, spaceId, params, issueId);
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
        this.persistAndNotify(run);
        const action = await new Promise<ApprovalAction>((resolve) => {
          this.blockedWaiters.set(`${run.runId}:${rec.nodeId}`, resolve);
        });
        rec.blockedPrompt = undefined;
        if (this.cancels.has(run.runId)) throw new Error('已取消');
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

  /** Resolve role defaults: agentKind from role when node omits it. */
  private resolveAgentKind(run: RunRecord, cfg: DagNodeConfig): string {
    if (cfg.agentKind) return cfg.agentKind;
    const role = this.roleById(run, cfg.role);
    if (role?.agentKind) return role.agentKind;
    return 'opencode';
  }

  private roleById(run: RunRecord, roleId: string | undefined): Role | undefined {
    if (!roleId) return undefined;
    return loadRoles(this.store.root).find((r) => r.id === roleId);
  }

  /** Convention block from the space profile + role prePrompt, prepended to prompts. */
  private resolveContext(run: RunRecord, cfg: DagNodeConfig): { block: string; agentKind?: string } {
    const parts: string[] = [];
    const role = this.roleById(run, cfg.role);
    if (role?.prePrompt) parts.push(`${role.prePrompt}\n`);
    try {
      const profile = this.storeFor(run).readProfile();
      const block = buildConventionBlock(profile.rootCwd, profile.conventionFiles, (p) => {
        try {
          return fs.readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      });
      if (block) parts.push(block);
    } catch {
      // profile unreadable — proceed without conventions
    }
    return { block: parts.join('\n'), agentKind: role?.agentKind };
  }

  /**
   * R3.1 同仓并发隔离：git worktree add 独立目录 + 独立分支（脏目录保留并注明）。
   */
  private createWorktree(repo: string, runId: string, nodeId: string): { path: string; branch: string } {
    const wtPath = path.join(os.tmpdir(), 'paneflow-wt', `${runId}-${nodeId}`);
    const branch = `paneflow/${runId}-${nodeId}`;
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    execFileSync('git', ['-C', repo, 'worktree', 'add', wtPath, '-b', branch], { timeout: 30_000 });
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
    let polls = 0;
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
      if (Date.now() >= deadline) throw new Error('等待节点完成超时');
      polls += 1;
      if (polls > 40) {
        // debug probe: an unbounded wait would be a logic bug
        throw new Error(`waitForSettle polls=${polls} timeoutMs=${timeoutMs} deadline=${deadline} now=${Date.now()} status=${status}`);
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
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<Artifact, 'source' | 'finishedAt'>;
      return { ...parsed, outputTail, source: 'file', finishedAt: now };
    } catch {
      return {
        summary: outputTail ? outputTail.split('\n').slice(-5).join('\n') : undefined,
        outputTail,
        source: outputTail ? 'output-fallback' : 'empty',
        finishedAt: now,
      };
    }
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
   * G1 已知坑（v6 判决：本迭代不通电）：本方法当前无任何调用点，"事件+轮询双向校对"
   * 只剩事件一半。接线时注意 PF_RECONCILE_MS=0 会让 setInterval(0) 退化为 ~4ms 空转，
   * 足以打爆 herdr——通电前必须先加 `<= 0 直接 return` 守卫（详见 iteration-v6-oss-landing #2）。
   */
  private startReconciler(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.opts.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  /** Polling reconciliation against live agent status (guards event loss). */
  private async reconcile(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.state !== 'running') continue;
      for (const rec of Object.values(run.nodes)) {
        if (rec.agentName && (rec.state === 'working' || rec.state === 'blocked')) {
          const status = await this.ops.getAgentStatus(rec.agentName);
          if (status && status !== rec.agentStatus) {
            rec.agentStatus = status;
            if (rec.state === 'working' && status === 'blocked') rec.state = 'blocked';
            if (rec.state === 'blocked' && status === 'working') rec.state = 'working';
            this.persistAndNotify(run);
          }
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
    } catch {
      // never let persistence break a live run
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
