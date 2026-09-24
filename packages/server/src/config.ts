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

/**
 * v13-E2：平台/环境视图可注入参数（win32 默认路径候选的单测口子）。
 * 生产调用一律用默认 currentView()；测试注入 {platform, env, home} 锁住
 * 「同一段代码在 darwin 上返回值与今天一致」与 win32 的 %APPDATA% 分支。
 */
export interface PlatformView {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

function currentView(): PlatformView {
  return { platform: process.platform, env: process.env, home: os.homedir() };
}

/** win32 env 键名大小写不稳（APPDATA/AppData）；注入的纯对象区分大小写——兜底不区分大小写找 */
function lookupEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === key) return v;
  return undefined;
}

/** 平台对应的 path 实现：单测在 darwin 上也要能产出/断言 win32 形态路径 */
function pathImpl(platform: NodeJS.Platform): typeof path {
  return platform === 'win32' ? path.win32 : path;
}

/**
 * dataDir 缺省候选（显式 PF_DATA_DIR 永远最优先，那在 loadConfig 里）：
 * win32 认 %APPDATA%\paneflow（APPDATA 缺失回落 home\.paneflow——宁缺毋假，不猜盘符）；
 * 其余平台维持今天：`<home>/.paneflow`。
 */
export function defaultDataDir(view: PlatformView = currentView()): string {
  const p = pathImpl(view.platform);
  const appData = view.platform === 'win32' ? lookupEnv(view.env, 'APPDATA') : undefined;
  return appData ? p.join(appData, 'paneflow') : p.join(view.home, '.paneflow');
}

/**
 * herdr socket 缺省候选（PF_HERDR_SOCKET / PF_HERDR_SESSION 优先级在 detectSocketPath）：
 * win32 认 %APPDATA%\herdr（XDG ~/.config 是 posix 口径）；其余平台维持今天：
 * `~/.config/herdr[/sessions/<session>]/herdr.sock`。
 */
export function defaultHerdrSocketPath(session: string | undefined = undefined, view: PlatformView = currentView()): string {
  const p = pathImpl(view.platform);
  const appData = view.platform === 'win32' ? lookupEnv(view.env, 'APPDATA') : undefined;
  const base = appData ? p.join(appData, 'herdr') : p.join(view.home, '.config', 'herdr');
  return session ? p.join(base, 'sessions', session, 'herdr.sock') : p.join(base, 'herdr.sock');
}

/**
 * 用户主目录（fs-routes 目录浏览的锚点，全仓唯一口径）：
 * posix 认 HOME（与今天 fs-routes 一致；HOME 缺失回落 os.homedir()，好过旧的 '/'），
 * win32 认 USERPROFILE（os.homedir() 在 win32 本就以它为先）。
 */
export function userHome(view: PlatformView = currentView()): string {
  return (view.platform === 'win32' ? lookupEnv(view.env, 'USERPROFILE') : lookupEnv(view.env, 'HOME')) || view.home;
}

function detectSocketPath(view: PlatformView = currentView()): string {
  if (view.env.PF_HERDR_SOCKET) return view.env.PF_HERDR_SOCKET;
  if (view.env.PF_HERDR_SESSION) return defaultHerdrSocketPath(view.env.PF_HERDR_SESSION, view);
  return defaultHerdrSocketPath(undefined, view);
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
  // 显式 env 最优先；缺省候选 win32 认 %APPDATA%（v13-E2），posix 与今天一字不差
  const dataDir = process.env.PF_DATA_DIR ?? defaultDataDir();
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
