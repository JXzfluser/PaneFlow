import { execFile } from 'node:child_process';

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

function probeBinary(bin: string): Promise<boolean> {
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
