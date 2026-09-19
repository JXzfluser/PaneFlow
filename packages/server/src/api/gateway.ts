import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ModelGatewaySettings {
  /** OmniRoute 等网关的根地址（Anthropic 与 OpenAI 兼容端点都挂在这里） */
  baseUrl?: string;
  apiKey?: string;
  /** 免费档模型 id（注入 ANTHROPIC_MODEL 等覆盖，如 auto/best-free） */
  freeModel?: string;
  /** 是否启用注入（默认配置存在即启用） */
  enabled?: boolean;
}

function gatewayPath(dataDir: string): string {
  return path.join(dataDir, 'gateway.json');
}

export function readGateway(dataDir: string): ModelGatewaySettings {
  try {
    return JSON.parse(fs.readFileSync(gatewayPath(dataDir), 'utf8')) as ModelGatewaySettings;
  } catch {
    return {};
  }
}

export function writeGateway(dataDir: string, next: ModelGatewaySettings): void {
  fs.writeFileSync(gatewayPath(dataDir), JSON.stringify(next, null, 2));
}

/** 网关是否配置齐全且启用——Agent 启动参数按此决定是否注入统一路由 */
export function gatewayActive(dataDir: string): boolean {
  const g = readGateway(dataDir);
  return Boolean(g.enabled && g.baseUrl && g.apiKey);
}

/**
 * Build the per-pane env block that routes any gateway-aware agent
 * (claude via ANTHROPIC_*, OpenAI-compatible via OPENAI_*) to the router.
 * Empty object when unconfigured/disabled.
 */
export function buildGatewayEnv(dataDir: string): Record<string, string> {
  const g = readGateway(dataDir);
  if (!g.enabled || !g.baseUrl || !g.apiKey) return {};
  // 用户常把地址连 /v1 一起贴进来——统一剥掉尾部 v1 再拼，避免 ANTHROPIC_BASE_URL 变成 …/v1（claude 会再拼一层）
  const base = g.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const env: Record<string, string> = {
    OPENAI_API_BASE: `${base}/v1`,
    // pi 的 provider baseUrl 来自它的 models.json 目录而非环境变量——这里只作兜底注入
    OPENAI_BASE_URL: `${base}/v1`,
    OPENAI_API_KEY: g.apiKey,
    // paneflow-gw（写入 ~/.pi/agent/models.json 的自定义 provider）按 $PANEFLOW_GW_KEY 引用
    PANEFLOW_GW_KEY: g.apiKey,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: g.apiKey,
    ANTHROPIC_API_KEY: g.apiKey,
  };
  if (g.freeModel) {
    env.ANTHROPIC_MODEL = g.freeModel;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = g.freeModel;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = g.freeModel;
    env.ANTHROPIC_SMALL_FAST_MODEL = g.freeModel;
  }
  // herdr 守护进程可能带着已死的 HTTP_PROXY 传给所有 pane（pi 的 undici 会照走 → 连接失败）。
  // 这里不删用户的代理，只把网关主机与常用内网段加进 NO_PROXY，保证网关与本机 API 直连。
  try {
    const gwHost = new URL(base).hostname;
    const parts = [
      ...(process.env.NO_PROXY ?? '').split(','),
      'localhost', '127.0.0.1', '::1', '10.*', '192.168.*', '*.local', gwHost,
    ].map((s) => s.trim()).filter(Boolean);
    const noProxy = [...new Set(parts)].join(',');
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  } catch {
    /* baseUrl 不是合法 URL：跳过（上面 baseUrl 正则以已验过，正常到不了这里） */
  }
  return env;
}

/** 网关 OpenAI 兼容端点前缀（…/v1），已做 /v1 去重 */
export function gatewayOpenaiBase(dataDir: string): string | null {
  const g = readGateway(dataDir);
  if (!g.enabled || !g.baseUrl || !g.apiKey) return null;
  return `${g.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
}

/** pi 里 PaneFlow 网关 provider 的名字；引擎以 `--provider paneflow-gw` 启动 pi */
export const PI_GATEWAY_PROVIDER = 'paneflow-gw';

/**
 * pi 的 provider baseUrl 写死在它的目录里（OPENAI_BASE_URL 环境变量不被读取），且 openai
 * 下未登记的模型 id 会继承 gpt-5.4 模板（api=openai-responses + api.openai.com）——
 * 在网关环境下表现为 pi 每次 "Request timed out"。这里把网关注册成显式的
 * openai-completions provider，密钥用 $PANEFLOW_GW_KEY 引用（pane env 注入，磁盘不落明文）。
 * 合并写：保留用户 models.json 里的其他 provider；幂等，配置没变则不写盘。
 */
export function syncPiGatewayProvider(
  dataDir: string,
  opts: { homeDir?: string } = {},
): { synced: boolean; path: string; removed?: boolean } {
  const home = opts.homeDir ?? os.homedir();
  const file = path.join(home, '.pi', 'agent', 'models.json');
  const g = readGateway(dataDir);
  let doc: { providers?: Record<string, unknown> } = {};
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof doc;
      if (!doc || typeof doc !== 'object' || ('providers' in doc && typeof doc.providers !== 'object')) {
        return { synced: false, path: file };
      }
    } catch {
      // 文件损坏时不动用户数据，交由用户处理
      return { synced: false, path: file };
    }
  }
  doc.providers ??= {};
  const providers = doc.providers as Record<string, unknown>;
  if (!gatewayActive(dataDir)) {
    if (!(PI_GATEWAY_PROVIDER in providers)) return { synced: false, path: file };
    delete providers[PI_GATEWAY_PROVIDER];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    return { synced: true, path: file, removed: true };
  }
  const next = {
    name: 'PaneFlow 网关',
    baseUrl: gatewayOpenaiBase(dataDir) ?? '',
    api: 'openai-completions',
    apiKey: '$PANEFLOW_GW_KEY',
    models: [
      {
        id: g.freeModel || 'auto',
        name: g.freeModel || 'auto',
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
  if (JSON.stringify(providers[PI_GATEWAY_PROVIDER]) === JSON.stringify(next)) {
    return { synced: false, path: file };
  }
  providers[PI_GATEWAY_PROVIDER] = next;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { synced: true, path: file };
}
