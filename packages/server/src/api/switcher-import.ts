import fs from 'node:fs';

/**
 * v9-D3 外部 switcher（cc Switch 等）配置导入器：
 * 只认已知形状（provider 数组 + env 里的 ANTHROPIC_BASE_URL/AUTH_TOKEN 系），
 * 认不出的一律跳过——找不到源文件/认不出格式就明说，不猜。
 */
export interface SwitcherCandidate {
  name: string;
  baseUrl: string;
  apiKey: string;
  freeModel?: string;
}

const FILE_CAP = 256 * 1024;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 一项 provider 配置里取 env：支持 {env}、{settings:{env}} 两种挂法 */
function pickEnv(item: Record<string, unknown>): Record<string, unknown> | null {
  const direct = obj(item.env);
  if (direct) return direct;
  return obj(obj(item.settings)?.env);
}

export function parseSwitcherConfig(raw: unknown): SwitcherCandidate[] {
  const list = Array.isArray(raw)
    ? raw
    : obj(raw) && Array.isArray((raw as { providers?: unknown }).providers)
      ? (raw as { providers: unknown[] }).providers
      : null;
  if (!list) return [];
  const out: SwitcherCandidate[] = [];
  for (const entry of list) {
    const item = obj(entry);
    const env = item && pickEnv(item);
    if (!item || !env) continue;
    const baseUrl = str(env.ANTHROPIC_BASE_URL) || str(env.OPENAI_BASE_URL) || str(env.OPENAI_API_BASE);
    const apiKey = str(env.ANTHROPIC_AUTH_TOKEN) || str(env.ANTHROPIC_API_KEY) || str(env.OPENAI_API_KEY);
    if (!baseUrl || !apiKey) continue;
    const base = str(item.name) || str(item.settingsName) || str(item.id) || `导入档 ${out.length + 1}`;
    let name = base;
    for (let i = 2; out.some((c) => c.name === name); i++) name = `${base} (${i})`;
    const freeModel = str(env.ANTHROPIC_MODEL) || str(item.model);
    out.push({ name, baseUrl, apiKey, ...(freeModel ? { freeModel } : {}) });
  }
  return out;
}

/** 读外部配置文件：文件不存在/超限/非 JSON 都是明确错误信息，绝不静默 */
export function readSwitcherFile(
  p: string,
): { ok: true; candidates: SwitcherCandidate[] } | { ok: false; error: string } {
  if (!p.trim()) return { ok: false, error: '请先给出配置文件路径' };
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return { ok: false, error: `找不到源文件：${p}（不猜路径——请核对后重试）` };
  }
  if (size > FILE_CAP) return { ok: false, error: `配置文件超过 ${FILE_CAP / 1024}KB，拒读（这不像 switcher 导出件）` };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${(e as Error).message}` };
  }
  const candidates = parseSwitcherConfig(raw);
  if (!candidates.length) {
    return { ok: false, error: '文件格式能读，但认不出任何 provider 形状（需要 {providers:[{settings:{env:{ANTHROPIC_BASE_URL, AUTH_TOKEN}}}] 一类结构）——不猜' };
  }
  return { ok: true, candidates };
}

/** 响应回显用：密钥只留尾部 4 位 */
export function maskCandidate(c: SwitcherCandidate): { name: string; baseUrl: string; keyTail: string; freeModel?: string } {
  return {
    name: c.name,
    baseUrl: c.baseUrl,
    keyTail: c.apiKey.slice(-4),
    ...(c.freeModel ? { freeModel: c.freeModel } : {}),
  };
}
