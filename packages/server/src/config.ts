import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
  /** Polling interval for state reconciliation (ms) */
  reconcileIntervalMs: number;
  /** Extra env injected into every pipeline workspace (PF_PANE_ENV=K=V,K2=V2) */
  paneEnv: Record<string, string>;
  /** 服务监听地址：非 127.0.0.1 时启用访问令牌鉴权（R4.1） */
  host: string;
  /** 访问令牌（远程模式必配；PF_TOKEN 或首次自动生成持久化） */
  authToken: string | null;
  /** prompt 提交确认窗（ms） */
  promptConfirmWindowMs: number;
  /** G2：CORS 白名单（PF_CORS_ORIGINS 逗号分隔）；空 = 不回 CORS 头，跨站读被浏览器拦截 */
  corsOrigins: string[];
}

function ensureAuthToken(dataDir: string, host: string): string | null {
  const local = host === '127.0.0.1' || host === 'localhost';
  if (local && !process.env.PF_TOKEN) return null; // 本机信任模式
  const tokenFile = path.join(dataDir, 'auth-token.json');
  if (process.env.PF_TOKEN) return process.env.PF_TOKEN;
  try {
    return (JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as { token: string }).token;
  } catch {
    const token = `pf_${randomUUID().replace(/-/g, '')}`;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ token }), { mode: 0o600 });
    return token;
  }
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
  const host = process.env.PF_HOST ?? '127.0.0.1';
  return {
    herdrSocketPath: detectSocketPath(),
    workspaceLabelPrefix: process.env.PF_WORKSPACE_PREFIX ?? 'paneflow-',
    dataDir,
    port: Number(process.env.PF_PORT ?? 4310),
    maxConcurrentPanes: Number(process.env.PF_MAX_PANES ?? 8),
    reconcileIntervalMs: Number(process.env.PF_RECONCILE_MS ?? 5000),
    paneEnv: parsePaneEnv(process.env.PF_PANE_ENV),
    host,
    authToken: ensureAuthToken(dataDir, host),
    promptConfirmWindowMs: Number(process.env.PF_PROMPT_CONFIRM_MS ?? 45_000),
    corsOrigins: (process.env.PF_CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    ...overrides,
  };
}
