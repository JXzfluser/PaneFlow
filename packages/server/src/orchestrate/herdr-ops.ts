import type { AgentStatus } from '@paneflow/shared';
import { HerdrClient, HerdrRequestError } from '../herdr/client.js';
import type { WorkspaceInfo } from '../herdr/types.js';

/**
 * v13-S2 「agent 已没」的唯一判据：**只看协议错误码里的 not_found 类**
 * （`not_found`/`agent_not_found`/`pane_not_found` 都算——target 已不存在就是不存在）。
 * 传输错（HerdrConnectionError）、超时（code=timeout）、invalid_request 一律不算——
 * 那些是「没答上话」，拿它判死就是把含糊读数当证据（宁缺毋假）。
 * 错误码是 client 拼进 message 的（`herdr <code>: <message>`，见 client.ts HerdrRequestError），
 * 这里认结构化的 `code` 字段，不认 message 里的人话。
 */
export function isAgentNotFoundError(err: unknown): boolean {
  return err instanceof HerdrRequestError && /not_found/i.test(err.code);
}

/**
 * The engine-facing surface over Herdr. Isolated behind an interface so the
 * orchestration engine is unit-testable without a live Herdr server.
 */
export interface HerdrOps {
  /** Server reachability probe. */
  ping(): Promise<void>;
  /** Create a dedicated workspace for a pipeline run. */
  createWorkspace(label: string, cwd: string, env?: Record<string, string>): Promise<{ workspaceId: string; tabId: string; rootPaneId: string }>;
  /** Split a new pane off an existing one; returns the new pane id. */
  splitPane(workspaceId: string, targetPaneId: string, cwd: string, env?: Record<string, string>): Promise<string>;
  /** Start an agent in a pane. Resolves once Herdr accepts the launch. */
  startAgent(paneId: string, name: string, kind: string, args: string[], timeoutMs: number): Promise<void>;
  /** Submit a prompt; waits (server-side) until the turn settles. */
  promptAgent(target: string, text: string, timeoutMs: number): Promise<void>;
  /** Block until the agent reaches one of `until`. */
  waitAgent(target: string, until: AgentStatus[], timeoutMs: number): Promise<void>;
  /** Current agent status (explicit read — used for polling reconciliation). */
  getAgentStatus(target: string): Promise<AgentStatus | null>;
  /**
   * v13-S2 对账专用三态判别读：`AgentStatus`=还在、`'gone'`=server 明确应答查无此 agent、
   * `null`=拿不到判据（传输错/超时/无法归类）。与 getAgentStatus 的关键差别：后者把一切错误
   * 压成 null，于是「明确没有」与「没答上话」塌成同一读数——判「agent 已没」若用那把尺，
   * 要么永远判不了（生产路 null 吞掉），要么把瞬断判成死单。只此一个用途，别处别拿它当状态读。
   */
  probeAgent(target: string): Promise<AgentStatus | 'gone' | null>;
  /** Send key presses (approval flow). */
  sendKeys(target: string, keys: string[]): Promise<void>;
  /** Send raw text to a pane's terminal (manual intervention channel). */
  sendPaneText(paneId: string, text: string): Promise<void>;
  /** Recent terminal output of the agent. */
  readOutput(target: string, lines: number): Promise<string>;
  /** Subscribe to per-pane status changes; returns unsubscribe. */
  subscribePaneStatus(paneId: string, cb: (status: AgentStatus, agent: string | null) => void): Promise<() => void>;
  /** Close (destroy) a whole workspace with all its panes. */
  closeWorkspace(workspaceId: string): Promise<void>;
  /** List workspaces currently known to Herdr. */
  listWorkspaces(): Promise<WorkspaceInfo[]>;
}

/** Real implementation backed by the socket client. */
export class RealHerdrOps implements HerdrOps {
  constructor(private readonly client: HerdrClient) {}

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async createWorkspace(label: string, cwd: string, env?: Record<string, string>) {
    const r = await this.client.workspaceCreate({
      label,
      cwd,
      ...(env && Object.keys(env).length ? { env } : {}),
    });
    return {
      workspaceId: r.workspace.workspace_id,
      tabId: r.tab.tab_id,
      rootPaneId: r.root_pane.pane_id,
    };
  }

  async splitPane(workspaceId: string, targetPaneId: string, cwd: string, env?: Record<string, string>): Promise<string> {
    const r = await this.client.paneSplit({
      direction: 'right',
      target_pane_id: targetPaneId,
      workspace_id: workspaceId,
      cwd,
      ...(env && Object.keys(env).length ? { env } : {}),
    });
    return r.pane.pane_id;
  }

  async startAgent(paneId: string, name: string, kind: string, args: string[], timeoutMs: number): Promise<void> {
    await this.client.agentStart({
      name,
      kind,
      pane_id: paneId,
      ...(args.length ? { args } : {}),
      timeout_ms: timeoutMs,
    });
  }

  async waitAgent(target: string, until: AgentStatus[], timeoutMs: number): Promise<void> {
    // server-held long-poll: request timeout must exceed the wait window
    await this.client.agentWait({ target, until, timeout_ms: timeoutMs }, timeoutMs + 60_000);
  }

  async promptAgent(target: string, text: string, _timeoutMs: number): Promise<void> {
    // A.4 fire＋确认窗：提交即返回（herdr 5s 判杀窗不再参与），settle 由引擎
    // waitForSettle 全权等待；提交后 45s 内状态必须离开 idle（确认窗），
    // 否则视为 prompt 石沉大海快速失败进重试（引擎侧实现确认窗）。
    await this.client.agentPrompt({ target, text }, 30_000);
  }

  async getAgentStatus(target: string): Promise<AgentStatus | null> {
    try {
      const r = await this.client.agentGet(target);
      return r.agent?.agent_status ?? null;
    } catch {
      return null;
    }
  }

  async probeAgent(target: string): Promise<AgentStatus | 'gone' | null> {
    try {
      const r = await this.client.agentGet(target);
      // 答上了但没状态字段=判据不齐，不判 gone（宁缺毋假）——'gone' 只由明确错误码给出
      return r.agent?.agent_status ?? null;
    } catch (err) {
      return isAgentNotFoundError(err) ? 'gone' : null;
    }
  }

  async sendKeys(target: string, keys: string[]): Promise<void> {
    await this.client.agentSendKeys(target, keys);
  }

  async sendPaneText(paneId: string, text: string): Promise<void> {
    await this.client.request('pane.send_text', { pane_id: paneId, text: text.endsWith('\n') ? text : text + '\n' });
  }

  async readOutput(target: string, lines: number): Promise<string> {
    // TUI agents (pi/opencode…) render on the alternate screen — host
    // scrollback (recent_unwrapped) comes back empty for them. Fall back to
    // the live viewport, which always reflects what the user would see.
    try {
      const r = await this.client.agentRead(target, 'recent_unwrapped', lines);
      if (r.read.text?.trim()) return r.read.text;
    } catch {
      // fall through
    }
    try {
      const r = await this.client.agentRead(target, 'visible', lines);
      return r.read.text ?? '';
    } catch {
      return '';
    }
  }

  async subscribePaneStatus(
    paneId: string,
    cb: (status: AgentStatus, agent: string | null) => void,
  ): Promise<() => void> {
    return await this.client.subscribe([{ type: 'pane.agent_status_changed', pane_id: paneId }], (msg) => {
      const m = msg as { event?: string; data?: { pane_id?: string; agent_status?: AgentStatus; agent?: string | null } };
      if (m.event === 'pane.agent_status_changed' && m.data?.pane_id === paneId && m.data.agent_status) {
        cb(m.data.agent_status, m.data.agent ?? null);
      }
    });
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.client.workspaceClose(workspaceId);
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const r = await this.client.workspaceList();
    return r.workspaces;
  }
}

/** Unique agent name generator (names must match [a-z][a-z0-9_-]{0,31}). */
let agentNameSeq = 0;
export function makeAgentName(runId: string, nodeId: string): string {
  const raw = `pf-${runId.slice(0, 6)}-${nodeId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 30);
  const safe = raw.replace(/-+$/, '');
  // names must be unique among live agents; suffix guarantees it across runs
  return `${safe || 'pf-agent'}-${(++agentNameSeq).toString(36)}`;
}
