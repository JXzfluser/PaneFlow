import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type {
  AgentStatus,
  DagNodeConfig,
  Artifact,
  DagEdge,
  DagGraph,
  NodeRunRecord,
  RunRecord,
} from '@paneflow/shared';
import { applyVariables, renderPromptTemplate, topoSort, validateDag } from '@paneflow/shared';
import type { HerdrOps } from './herdr-ops.js';
import { makeAgentName } from './herdr-ops.js';
import { Store } from './store.js';
import { buildConventionBlock, loadRoles, type Role } from './roles.js';

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

  constructor(
    private readonly ops: HerdrOps,
    private readonly store: Store,
    private readonly opts: EngineOptions,
  ) {
    // surface past runs (from disk, across all spaces) in listings after boot
    for (const space of Store.listSpaces(store.root)) {
      for (const run of new Store(store.root, space.id).listRuns()) {
        this.runs.set(run.runId, run);
      }
    }
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

  async startRun(graph: DagGraph, cwd: string, spaceId?: string, variables?: Record<string, string>, issueId?: string): Promise<RunRecord> {
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
    this.persistAndNotify(run);

    // Fire and forget — the HTTP layer returns the runId immediately and the
    // canvas follows state over WebSocket.
    void this.execute(run, order).catch((err) => {
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
    waiter(action);
    return true;
  }

  isBlocked(runId: string, nodeId: string): boolean {
    return this.blockedWaiters.has(`${runId}:${nodeId}`);
  }

  // -- execution ----------------------------------------------------------------

  private async execute(run: RunRecord, order: string[]): Promise<void> {
    // readable workspace name: paneflow-<space>-<runId> (sweep prefix preserved)
    const label = `${this.opts.workspaceLabelPrefix}${run.spaceId ?? 'default'}-${run.runId}`;
    const ws = await this.ops.createWorkspace(label, run.cwd, this.opts.paneEnv ?? {});
    run.workspaceId = ws.workspaceId;
    this.rootPanes.set(run.runId, ws.rootPaneId);
    this.persistAndNotify(run);

    const blackboard = new Map<string, Artifact>();
    let abort = false;

    try {
      await this.schedule(run, order, blackboard, () => {
        abort = true;
      });

      if (this.cancels.has(run.runId)) run.state = 'cancelled';
      else if (abort) run.state = 'failed';
      else run.state = 'completed';
    } finally {
      run.finishedAt = new Date().toISOString();
      for (const rec of Object.values(run.nodes)) {
        if (['working', 'blocked', 'queued', 'starting', 'retrying'].includes(rec.state)) {
          rec.state = this.cancels.has(run.runId) ? 'cancelled' : 'failed';
        }
      }
      // resource cleanup — never leave panes behind
      try {
        await this.ops.closeWorkspace(run.workspaceId!);
      } catch (err) {
        console.error(`[engine] workspace cleanup failed for ${run.workspaceId}:`, err);
      }
      this.rootPanes.delete(run.runId);
      this.cancels.delete(run.runId);
      this.persistAndNotify(run);
    }
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
      this.persistAndNotify(run);
    };

    for (;;) {
      if (this.cancels.has(run.runId)) break;

      if (!abort) {
        for (const id of [...pending]) {
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
            // start / end / fanout are structural markers
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
        // nothing running and nothing ready → cannot make progress (defensive;
        // cycles are rejected at validation time)
        break;
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
    this.persistAndNotify(run);
    let unsub: (() => void) | null = null;
    try {
      const rootPane = this.rootPanes.get(run.runId)!;
      const nodeCwd = cfg.cwd ? path.resolve(run.cwd, cfg.cwd) : run.cwd;
      const paneId = await this.ops.splitPane(run.workspaceId!, rootPane, nodeCwd);
      rec.paneId = paneId;
      rec.agentName = agentName;
      await this.ops.startAgent(paneId, agentName, this.resolveAgentKind(run, cfg), cfg.agentArgs ?? [], this.opts.agentStartTimeoutMs);
      await this.ops.waitAgent(agentName, ['idle'], this.opts.agentReadyTimeoutMs);
    } catch (err) {
      return `启动失败：${(err as Error).message}`;
    }

    // live status mirroring from events; the poller reconciles drift, so a
    // failed subscription is degraded to warn-only rather than failing the node
    try {
      unsub = await this.ops.subscribePaneStatus(paneIdOf(rec), (status) => {
        rec.agentStatus = status;
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
          if (aligned === 'true' || aligned === '1') break;
          if (round > maxRounds) return `澄清循环 ${maxRounds} 轮后仍未对齐（aligned=${aligned}）`;
          const questions = (rec.artifact?.extra?.questions as string[] | undefined) ?? [];
          rec.state = 'blocked';
          rec.blockedPrompt = questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : 'Agent 有疑问，请补充信息（aligned 未通过）';
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

  private async waitForSettle(
    run: RunRecord,
    rec: NodeRunRecord,
    agentName: string,
    timeoutMs: number,
  ): Promise<AgentStatus> {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    for (;;) {
      if (this.cancels.has(run.runId)) throw new Error('已取消');
      const status = (await this.ops.getAgentStatus(agentName)) ?? 'unknown';
      rec.agentStatus = status;
      if (status === 'idle' || status === 'done' || status === 'blocked') {
        this.persistAndNotify(run);
        return status;
      }
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
