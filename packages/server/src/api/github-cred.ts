import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface GithubSettings {
  /** GitHub PAT（用于流水线内 Agent 的 gh 命令；解决 EMU 账号无法访问外部仓库的问题） */
  token?: string;
  /** 默认目标仓库（owner/name；Agent 未指定 --repo 时的兜底） */
  defaultRepo?: string;
}

function ghPath(dataDir: string): string {
  return path.join(dataDir, 'github.json');
}

export function readGithubSettings(dataDir: string): GithubSettings {
  try {
    return JSON.parse(fs.readFileSync(ghPath(dataDir), 'utf8')) as GithubSettings;
  } catch {
    return {};
  }
}

export function writeGithubSettings(dataDir: string, next: GithubSettings): void {
  // token 以明文落盘，权限收紧为 0o600（仅属主可读写），消除世界可读风险。
  fs.writeFileSync(ghPath(dataDir), JSON.stringify(next, null, 2), { mode: 0o600 });
}

/** GH_TOKEN/GITHUB_TOKEN 注入（供 gh CLI 使用）；未配置返回空。 */
export function buildGithubEnv(dataDir: string): Record<string, string> {
  const g = readGithubSettings(dataDir);
  if (!g.token) return {};
  const env: Record<string, string> = { GH_TOKEN: g.token, GITHUB_TOKEN: g.token };
  if (g.defaultRepo) env.PF_GITHUB_DEFAULT_REPO = g.defaultRepo;
  return env;
}

/** D1：本机 `gh auth token` 取登录态 token（readToken 可注入供测试） */
export function ghCliToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { timeout: 8000, encoding: 'utf8' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    );
  });
}

/** D1 一键导入：gh 已登录→token 写入 dataDir（0o600）；失败给最小权限 PAT 指引，不猜 */
export async function importFromGhCli(
  dataDir: string,
  readToken: () => Promise<string> = ghCliToken,
): Promise<{ ok: true; defaultRepo?: string } | { ok: false; error: string }> {
  let token = '';
  try {
    token = (await readToken()).trim();
  } catch {
    return {
      ok: false,
      error:
        '本机 gh 未安装或未登录，拿不到 token。路 A：brew install gh && gh auth login 后重试；路 B：手动建 Fine-grained PAT——最小权限仅 Contents:RW / Issues:RW / Pull requests:RW，贴回输入框保存。',
    };
  }
  if (!token) {
    return { ok: false, error: 'gh 已登录但返回空 token：先 gh auth status 看账号状态，或按路 B 贴 PAT。' };
  }
  const cur = readGithubSettings(dataDir);
  writeGithubSettings(dataDir, { ...cur, token });
  return { ok: true, ...(cur.defaultRepo ? { defaultRepo: cur.defaultRepo } : {}) };
}

/** v10-U2 凭据来源：本机存储 PAT > gh CLI 登录态（不落盘直接用）> 无 */
export type GithubCredSource = 'stored-pat' | 'gh-cli' | 'none';

/**
 * 动作侧取 token：存储 PAT 优先，未存则现取 gh 登录态兜底（pane 内 gh 本就吃钥匙串，
 * 服务端确定性调用没理由要求用户多抄一遍 PAT）。取不到返回 null，由调用方决定报错文案。
 */
export async function resolveGithubToken(
  dataDir: string,
  readToken: () => Promise<string> = ghCliToken,
): Promise<string | null> {
  const stored = readGithubSettings(dataDir).token;
  if (stored) return stored;
  try {
    return (await readToken()).trim() || null;
  } catch {
    return null;
  }
}

/** 设置页可见性：来源 + 尾号 + gh 是否登录（只探不写，token 本身不出这里） */
export async function describeGithubCred(
  dataDir: string,
  readToken: () => Promise<string> = ghCliToken,
): Promise<{ source: GithubCredSource; tokenTail: string; ghLoggedIn: boolean }> {
  const g = readGithubSettings(dataDir);
  let ghLoggedIn = false;
  try {
    ghLoggedIn = (await readToken()).trim() !== '';
  } catch {
    ghLoggedIn = false;
  }
  return {
    source: g.token ? 'stored-pat' : ghLoggedIn ? 'gh-cli' : 'none',
    tokenTail: g.token ? g.token.slice(-4) : '',
    ghLoggedIn,
  };
}

/** 解绑：只清存储的 PAT（班底/仓库配置留着）；gh 登录态本就未落盘，无需动 */
export function removeStoredToken(dataDir: string): { defaultRepo: string } {
  const cur = readGithubSettings(dataDir);
  writeGithubSettings(dataDir, cur.defaultRepo ? { defaultRepo: cur.defaultRepo } : {});
  return { defaultRepo: cur.defaultRepo ?? '' };
}
