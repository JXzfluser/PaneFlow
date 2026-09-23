/**
 * Herdr socket protocol types — protocol 20 subset used by the orchestrator.
 * Full schema: docs/herdr-socket-schema.json (dumped from `herdr api schema`).
 */

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export type ReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';

export interface EnvelopeError {
  code: string;
  message: string;
}

/** `{id, error}` */
export interface ErrorResponse {
  id: string;
  error: EnvelopeError;
}

/** `{id, result}` */
export interface SuccessResponse<T = unknown> {
  id: string;
  result: T;
}

/** Any line pushed by the server that is not a pending-request response. */
export interface PushMessage {
  [k: string]: unknown;
}

// --- workspace ---------------------------------------------------------------

export interface WorkspaceCreateParams {
  cwd?: string | null;
  label?: string | null;
  env?: Record<string, string>;
  focus?: boolean;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label?: string | null;
  active_tab_id?: string;
  number?: number;
  agent_status?: AgentStatus;
  tab_count?: number;
  pane_count?: number;
  focused?: boolean;
}

export interface WorkspaceCreateResult {
  workspace: WorkspaceInfo;
  tab: { tab_id: string; [k: string]: unknown };
  root_pane: { pane_id: string; [k: string]: unknown };
}

// --- pane --------------------------------------------------------------------

export interface PaneSplitParams {
  direction: 'right' | 'down';
  target_pane_id?: string | null;
  workspace_id?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  ratio?: number | null;
  focus?: boolean;
}

export interface PaneReadParams {
  pane_id: string;
  source: ReadSource;
  lines?: number | null;
  format?: 'text' | 'ansi';
  strip_ansi?: boolean;
}

/** 响应封包：`{type, read}` —— 内容在 read 子对象（M0 实测，勿改） */
export interface PaneReadResult {
  type: string;
  read: {
    pane_id: string;
    revision: number;
    source: ReadSource;
    format: string;
    text?: string;
    truncated?: boolean;
  };
}

export interface PaneWaitForOutputParams {
  pane_id: string;
  source: ReadSource;
  match: { type: 'substring' | 'regex'; value: string };
  lines?: number | null;
  timeout_ms?: number | null;
  strip_ansi?: boolean;
}

// --- agent -------------------------------------------------------------------

export interface AgentStartParams {
  name: string;
  kind: string;
  pane_id: string;
  args?: string[];
  timeout_ms?: number | null;
}

export interface AgentPromptWaitOptions {
  timeout_ms?: number | null;
  until?: AgentStatus[];
}

export interface AgentPromptParams {
  target: string;
  text: string;
  wait?: AgentPromptWaitOptions | null;
}

export interface AgentWaitParams {
  target: string;
  until?: AgentStatus[];
  timeout_ms?: number | null;
}

export interface AgentReadParams {
  target: string;
  source: ReadSource;
  lines?: number | null;
  format?: 'text' | 'ansi';
  strip_ansi?: boolean;
}

export interface AgentSendKeysParams {
  target: string;
  keys: string[];
}

export interface AgentInfo {
  agent: string | null;
  display_agent?: string | null;
  name?: string | null;
  agent_status: AgentStatus;
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  cwd: string | null;
  foreground_cwd?: string | null;
  focused?: boolean;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  revision?: number;
  state_change_seq?: number;
  state_labels?: Record<string, string>;
  terminal_title?: string | null;
}

// --- events ------------------------------------------------------------------

export interface Subscription {
  type: string;
  /** Required for pane.* filtered event types (agent_status_changed, etc.) */
  pane_id?: string;
  agent_status?: AgentStatus | null;
}

/**
 * Push envelope on the event connection:
 * `{"event":"pane.agent_status_changed","data":{...}}`
 */
export interface PushedEvent<T = unknown> {
  event: string;
  data: T;
}

export interface PaneAgentStatusChangedData {
  pane_id: string;
  workspace_id: string;
  agent_status: AgentStatus;
  agent?: string | null;
  display_agent?: string | null;
  title?: string | null;
  state_labels?: Record<string, string>;
}

export type PaneAgentStatusChangedEvent = PushedEvent<PaneAgentStatusChangedData>;
