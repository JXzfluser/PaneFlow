import type { AgentStatus } from '@paneflow/shared';
import { HerdrClient } from '../herdr/client.js';
import type { WorkspaceInfo } from '../herdr/types.js';

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

  async promptAgent(target: string, text: string, timeoutMs: number): Promise<void> {
    await this.client.agentPrompt(
      { target, text, wait: { until: ['idle', 'done', 'blocked'], timeout_ms: timeoutMs } },
      timeoutMs + 60_000,
    );
  }

  async getAgentStatus(target: string): Promise<AgentStatus | null> {
    try {
      const r = await this.client.agentGet(target);
      return r.agent?.agent_status ?? null;
    } catch {
      return null;
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
