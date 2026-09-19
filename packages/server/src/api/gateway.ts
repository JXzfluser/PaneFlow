import fs from 'node:fs';
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
  const env: Record<string, string> = {
    OPENAI_API_BASE: `${g.baseUrl.replace(/\/$/, '')}/v1`,
    // pi 读的是 OPENAI_BASE_URL（不是 OPENAI_API_BASE）——两个名字都给，网关对 pi 同样生效
    OPENAI_BASE_URL: `${g.baseUrl.replace(/\/$/, '')}/v1`,
    OPENAI_API_KEY: g.apiKey,
    ANTHROPIC_BASE_URL: g.baseUrl.replace(/\/$/, ''),
    ANTHROPIC_AUTH_TOKEN: g.apiKey,
    ANTHROPIC_API_KEY: g.apiKey,
  };
  if (g.freeModel) {
    env.ANTHROPIC_MODEL = g.freeModel;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = g.freeModel;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = g.freeModel;
    env.ANTHROPIC_SMALL_FAST_MODEL = g.freeModel;
  }
  return env;
}
