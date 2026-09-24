import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** kind → local binary probe name (herdr integration kinds) */
export const AGENT_BINARIES: Record<string, string> = {
  pi: 'pi',
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  copilot: 'copilot',
  devin: 'devin',
  droid: 'droid',
  kimi: 'kimi',
  kilo: 'kilo',
  hermes: 'hermes',
  qwen: 'qwen',
  qodercli: 'qodercli',
  cursor: 'cursor',
  grok: 'grok',
  omp: 'omp',
  mastracode: 'mastracode',
  'antigravity-cli': 'antigravity',
  gemini: 'gemini',
};

interface CacheEntry {
  at: number;
  installed: string[];
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** win32 的 env 键名大小写不稳（PATH/Path 都出现过）；注入的纯对象区分大小写——兜底不区分大小写找 */
function lookupEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === key) return v;
  return undefined;
}

/** 默认可执行文件视图：真实文件系统上「存在且是文件」（目录名撞车不算命中）。 */
function win32FileExists(p: string): boolean {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * v13-E2（v6-oss-landing §#4 沉淀方案）：win32 探测走 PATH × PATHEXT 纯枚举。
 * win32 没有 sh，旧「command -v」路在那儿恒 false（agentsInstalled 恒空的根因）；
 * 起 cmd/where 又是把结果交给环境运气——不起 shell，纯 fs 判定。
 * env / fileExists 可注入供单测锁三态；生产走默认值（win32 真机可达）。
 */
export function probeWin32Binary(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = win32FileExists,
): boolean {
  const pathVar = lookupEnv(env, 'PATH');
  if (!pathVar) return false;
  const pathExt = lookupEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  const exts = ['', ...pathExt.split(';').map((e) => e.trim()).filter(Boolean)];
  for (const dir of pathVar.split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      if (fileExists(path.win32.join(dir, bin + ext))) return true;
    }
  }
  return false;
}

function probeBinary(bin: string): Promise<boolean> {
  // win32：PATH × PATHEXT 枚举（v13-E2）；非 win32：今天的 command -v 路一字未改
  if (process.platform === 'win32') return Promise.resolve(probeWin32Binary(bin));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    execFile('sh', ['-c', `command -v ${JSON.stringify(bin)} >/dev/null 2>&1`], (err) => {
      clearTimeout(timer);
      resolve(!err);
    });
  });
}

/** Detect which agent kinds have a local binary on PATH (cached 60s). */
export async function detectInstalledAgents(kinds: string[]): Promise<string[]> {
  const key = kinds.slice().sort().join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.installed;
  const results = await Promise.all(
    kinds.map(async (kind) => {
      const bin = AGENT_BINARIES[kind] ?? kind;
      return (await probeBinary(bin)) ? kind : null;
    }),
  );
  const installed = results.filter((k): k is string => k !== null);
  cache.set(key, { at: Date.now(), installed });
  return installed;
}

export function clearAgentProbeCache(): void {
  cache.clear();
}

/** 自动推荐优先级（用户裁决：装了 pi 就默认 pi；claude 常遇未登录，排最后） */
export const RECOMMEND_PRIORITY = ['pi', 'opencode', 'codex', 'claude'] as const;

/** 本机装了哪个优先用哪个；全都没装返回 null（调用方兜底）。 */
export async function recommendAgentKind(): Promise<string | null> {
  const installed = await detectInstalledAgents([...RECOMMEND_PRIORITY]);
  for (const kind of RECOMMEND_PRIORITY) {
    if (installed.includes(kind)) return kind;
  }
  return null;
}
