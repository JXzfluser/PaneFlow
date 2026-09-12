import fs from 'node:fs';
import path from 'node:path';

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
