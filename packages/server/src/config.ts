import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PaneFlowConfig {
  /** Herdr socket path; resolved from env or the default session */
  herdrSocketPath: string;
  /** Workspace label prefix used to identify our runs in the user's session */
  workspaceLabelPrefix: string;
  /** Data dir for templates, runs and logs */
  dataDir: string;
  /** Server port */
  port: number;
  /** Max panes created in parallel (fan-out) across all running pipelines */
  maxConcurrentPanes: number;
  /** Default agent kind for new nodes */
  defaultAgentKind: string;
  /** Polling interval for state reconciliation (ms) */
  reconcileIntervalMs: number;
  /** Extra env injected into every pipeline workspace (PF_PANE_ENV=K=V,K2=V2) */
  paneEnv: Record<string, string>;
}

function detectSocketPath(): string {
  if (process.env.PF_HERDR_SOCKET) return process.env.PF_HERDR_SOCKET;
  if (process.env.PF_HERDR_SESSION) {
    return path.join(os.homedir(), '.config/herdr/sessions', process.env.PF_HERDR_SESSION, 'herdr.sock');
  }
  return path.join(os.homedir(), '.config/herdr/herdr.sock');
}

export function parsePaneEnv(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

export function loadConfig(overrides: Partial<PaneFlowConfig> = {}): PaneFlowConfig {
  const dataDir = process.env.PF_DATA_DIR ?? path.join(os.homedir(), '.paneflow');
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    herdrSocketPath: detectSocketPath(),
    workspaceLabelPrefix: process.env.PF_WORKSPACE_PREFIX ?? 'paneflow-',
    dataDir,
    port: Number(process.env.PF_PORT ?? 4310),
    maxConcurrentPanes: Number(process.env.PF_MAX_PANES ?? 8),
    defaultAgentKind: process.env.PF_DEFAULT_AGENT_KIND ?? 'opencode',
    reconcileIntervalMs: Number(process.env.PF_RECONCILE_MS ?? 5000),
    paneEnv: parsePaneEnv(process.env.PF_PANE_ENV),
    ...overrides,
  };
}
