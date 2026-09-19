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

/** v9-D2 网关档位：多套配置共存，current 指向生效档 */
export interface GatewayProfile extends ModelGatewaySettings {
  id: string;
  name: string;
}

interface GatewayDoc {
  profiles: GatewayProfile[];
  current: string | null;
}

const DEFAULT_PROFILE_ID = 'default';
const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

function gatewayPath(dataDir: string): string {
  return path.join(dataDir, 'gateway.json');
}

/** 磁盘 → 档位文档；旧扁平格式自动包成单档（读侧兼容），空/坏文件 = 无档 */
function parseGatewayDoc(raw: unknown): GatewayDoc {
  if (!raw || typeof raw !== 'object') return { profiles: [], current: null };
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.profiles)) {
    const profiles = (o.profiles as GatewayProfile[]).filter(
      (p) => p && typeof p === 'object' && typeof p.id === 'string',
    );
    const current = typeof o.current === 'string' && profiles.some((p) => p.id === o.current)
      ? o.current
      : (profiles[0]?.id ?? null);
    return { profiles, current };
  }
  if (o.baseUrl !== undefined || o.apiKey !== undefined || o.enabled !== undefined || o.freeModel !== undefined) {
    const flat = o as ModelGatewaySettings;
    return { profiles: [{ id: DEFAULT_PROFILE_ID, name: '默认档', ...flat }], current: DEFAULT_PROFILE_ID };
  }
  return { profiles: [], current: null };
}

export function readGatewayDoc(dataDir: string): GatewayDoc {
  try {
    return parseGatewayDoc(JSON.parse(fs.readFileSync(gatewayPath(dataDir), 'utf8')));
  } catch {
    return { profiles: [], current: null };
  }
}

function writeGatewayDoc(dataDir: string, doc: GatewayDoc): void {
  // 含 apiKey 明文：权限收紧 0o600（对齐 github.json）
  fs.writeFileSync(gatewayPath(dataDir), JSON.stringify(doc, null, 2), { mode: 0o600 });
}

/**
 * 生效配置（去掉档位外壳）。profileId 指定档（空间钉档用，悬空回落 current）；
 * 缺省 = current 档；无档 = {}（消费方语义与旧版一致）。
 */
export function readGateway(dataDir: string, profileId?: string): ModelGatewaySettings {
  const doc = readGatewayDoc(dataDir);
  const p =
    (profileId ? doc.profiles.find((x) => x.id === profileId) : undefined) ??
    doc.profiles.find((x) => x.id === doc.current) ??
    doc.profiles[0];
  if (!p) return {};
  const { id: _id, name: _name, ...settings } = p;
  return settings;
}

/** 写当前生效档（不存在则建「默认档」）——语义与旧 writeGateway 对齐 */
export function writeGateway(dataDir: string, next: ModelGatewaySettings): void {
  const doc = readGatewayDoc(dataDir);
  const cur = doc.profiles.find((p) => p.id === doc.current);
  if (cur) Object.assign(cur, next);
  else {
    doc.profiles.push({ id: DEFAULT_PROFILE_ID, name: '默认档', ...next });
    doc.current = DEFAULT_PROFILE_ID;
  }
  writeGatewayDoc(dataDir, doc);
}

export interface GatewayProfileView extends GatewayProfile {
  isCurrent: boolean;
  /** 密钥只在服务端流转：列表只回「配没配」 */
  keyConfigured: boolean;
}

export function listGatewayProfiles(dataDir: string): { profiles: GatewayProfileView[]; current: string | null } {
  const doc = readGatewayDoc(dataDir);
  return {
    current: doc.current,
    profiles: doc.profiles.map((p) => ({
      ...p,
      apiKey: undefined,
      isCurrent: p.id === doc.current,
      keyConfigured: Boolean(p.apiKey),
    })),
  };
}

/** 新增/按 id 覆盖一档（apiKey 留空 = 保留旧值）；首档自动成为 current。id 非法则自动生成 */
export function upsertGatewayProfile(
  dataDir: string,
  input: { id?: string; name: string; baseUrl: string; apiKey?: string; freeModel?: string; enabled?: boolean },
): GatewayProfile {
  const doc = readGatewayDoc(dataDir);
  const id = input.id && PROFILE_ID_RE.test(input.id) ? input.id : `gw-${Date.now().toString(36)}`;
  const existing = doc.profiles.find((p) => p.id === id);
  const next: GatewayProfile = {
    id,
    name: input.name.trim() || id,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey || existing?.apiKey,
    freeModel: input.freeModel ?? existing?.freeModel,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
  if (existing) Object.assign(existing, next);
  else doc.profiles.push(next);
  if (!doc.current) doc.current = id;
  writeGatewayDoc(dataDir, doc);
  return next;
}

export function setCurrentGateway(dataDir: string, id: string): boolean {
  const doc = readGatewayDoc(dataDir);
  if (!doc.profiles.some((p) => p.id === id)) return false;
  doc.current = id;
  writeGatewayDoc(dataDir, doc);
  return true;
}

/** 删档：唯一一档不许删（用 PUT 清空即可）；删的是 current 则顺延到剩下的第一档 */
export function deleteGatewayProfile(dataDir: string, id: string): { ok: boolean; error?: string; current?: string | null } {
  const doc = readGatewayDoc(dataDir);
  const i = doc.profiles.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false, error: `没有名为 ${id} 的网关档` };
  if (doc.profiles.length === 1) return { ok: false, error: '只剩这一档：要清配置请在档位里清空后保存' };
  doc.profiles.splice(i, 1);
  if (doc.current === id) doc.current = doc.profiles[0]!.id;
  writeGatewayDoc(dataDir, doc);
  return { ok: true, current: doc.current };
}

/** 网关是否配置齐全且启用——Agent 启动参数按此决定是否注入统一路由 */
export function gatewayActive(dataDir: string, profileId?: string): boolean {
  const g = readGateway(dataDir, profileId);
  return Boolean(g.enabled && g.baseUrl && g.apiKey);
}

/**
 * Build the per-pane env block that routes any gateway-aware agent
 * (claude via ANTHROPIC_*, OpenAI-compatible via OPENAI_*) to the router.
 * Empty object when unconfigured/disabled.
 */
export function buildGatewayEnv(dataDir: string, profileId?: string): Record<string, string> {
  const g = readGateway(dataDir, profileId);
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
    // 从未配过网关的 dataDir（新装/第二实例）没有清理权——否则会把别的实例写好的 provider 误删
    if (!fs.existsSync(gatewayPath(dataDir))) return { synced: false, path: file };
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
