import type { AgentStatus } from '@paneflow/shared';
import type { HerdrOps } from './herdr-ops.js';

/** Deterministic in-memory Herdr double driven by scripted agent behavior. */
export class FakeHerdrOps implements HerdrOps {
  workspaces = new Map<string, { label: string; panes: Set<string> }>();
  agents = new Map<string, { paneId: string; status: AgentStatus }>();
  prompts: { target: string; text: string }[] = [];
  sentKeys: { target: string; keys: string[] }[] = [];
  closedWorkspaces: string[] = [];
  /** AE：启动记录（kind/args）与各 pane 注入的 env，供解析链断言 */
  starts: { paneId: string; name: string; kind: string; args: string[] }[] = [];
  paneEnvs = new Map<string, Record<string, string>>();
  paneCounter = 0;
  statusSubs = new Map<string, Set<(s: AgentStatus, agent: string | null) => void>>();
  /** concurrency observation */
  concurrent = 0;
  maxConcurrent = 0;
  /** artificial per-prompt delay to observe real overlap (ms) */
  promptDelayMs = 0;
  /** script: called on each prompt; may flip agent status to simulate work */
  onPrompt: (target: string, text: string) => void = () => {
    // default: pretend the agent did one working→idle cycle instantly
  };

  async ping(): Promise<void> {}
  async createWorkspace(label: string, _cwd: string, _env?: Record<string, string>) {
    const id = `w${this.workspaces.size + 1}`;
    const rootPane = `${id}:p0`;
    this.workspaces.set(id, { label, panes: new Set([rootPane]) });
    return { workspaceId: id, tabId: `${id}:t1`, rootPaneId: rootPane };
  }
  async splitPane(workspaceId: string, _targetPaneId?: string, _cwd?: string, env?: Record<string, string>) {
    const ws = this.workspaces.get(workspaceId)!;
    const pane = `${workspaceId}:p${++this.paneCounter}`;
    ws.panes.add(pane);
    if (env) this.paneEnvs.set(pane, env);
    return pane;
  }
  async startAgent(paneId: string, name: string, kind = '', args: string[] = []) {
    this.starts.push({ paneId, name, kind, args });
    this.agents.set(name, { paneId, status: 'idle' });
  }
  async promptAgent(target: string, text: string) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      this.prompts.push({ target, text });
      if (this.promptDelayMs) await new Promise((r) => setTimeout(r, this.promptDelayMs));
      this.onPrompt(target, text);
    } finally {
      this.concurrent -= 1;
    }
  }
  async waitAgent(target: string, until: AgentStatus[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const a = this.agents.get(target);
      if (a && until.includes(a.status)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout waiting ${target} for ${until.join(',')}`);
  }
  async getAgentStatus(target: string) {
    return this.agents.get(target)?.status ?? null;
  }
  async sendKeys(target: string, keys: string[]) {
    this.sentKeys.push({ target, keys });
    // default: keys resolve a blocked dialog back to idle
    this.agents.get(target)!.status = 'idle';
  }
  async sendPaneText(_paneId: string, _text: string): Promise<void> {}
  async readOutput(target?: string) {
    void target;
    return 'FAKE OUTPUT TAIL';
  }
  async subscribePaneStatus(paneId: string, cb: (status: AgentStatus, agent: string | null) => void) {
    let set = this.statusSubs.get(paneId);
    if (!set) {
      set = new Set();
      this.statusSubs.set(paneId, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }
  async closeWorkspace(workspaceId: string) {
    this.workspaces.delete(workspaceId);
    this.closedWorkspaces.push(workspaceId);
  }
  async listWorkspaces() {
    return [...this.workspaces.entries()].map(([workspace_id, w]) => ({
      workspace_id,
      label: w.label,
    }));
  }
  /** test helper: flip a fake agent's status and fire subscribers */
  setStatus(target: string, status: AgentStatus): void {
    const a = this.agents.get(target);
    if (!a) return;
    a.status = status;
    for (const cb of this.statusSubs.get(a.paneId) ?? []) cb(status, null);
  }
}
