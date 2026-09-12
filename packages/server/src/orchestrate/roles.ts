import fs from 'node:fs';
import path from 'node:path';

export interface Role {
  id: string;
  name: string;
  /** 默认 agent kind（节点未显式配置时使用） */
  agentKind?: string;
  /** 角色前置提示（渲染在节点 prompt 之前） */
  prePrompt?: string;
  /** 角色级环境变量（如模型网关地址；节点 env 覆盖此处） */
  env?: Record<string, string>;
}

const PER_FILE_CAP = 100 * 1024;
const TOTAL_CAP = 250 * 1024;

export function rolesPath(dataDir: string): string {
  return path.join(dataDir, 'roles.json');
}

export function loadRoles(dataDir: string): Role[] {
  try {
    const arr = JSON.parse(fs.readFileSync(rolesPath(dataDir), 'utf8')) as Role[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveRoles(dataDir: string, roles: Role[]): void {
  fs.writeFileSync(rolesPath(dataDir), JSON.stringify(roles, null, 2));
}

/**
 * Build the convention context block injected before every agent prompt of a
 * space: profile.conventionFiles read relative to profile.rootCwd, capped
 * per-file and in total. Returns '' when nothing configured.
 */
export function buildConventionBlock(
  rootCwd: string | undefined,
  conventionFiles: string[] | undefined,
  readFile: (p: string) => string | null,
): string {
  if (!rootCwd || !conventionFiles?.length) return '';
  const parts: string[] = [];
  let total = 0;
  for (const rel of conventionFiles) {
    if (rel.includes('..')) continue;
    const content = readFile(path.resolve(rootCwd, rel));
    if (content === null) continue;
    const clipped = content.length > PER_FILE_CAP ? `${content.slice(0, PER_FILE_CAP)}\n…（超长截断）` : content;
    if (total + clipped.length > TOTAL_CAP) {
      parts.push(`<约定文档 name="${rel}">（超出总预算未注入）</约定文档>`);
      break;
    }
    total += clipped.length;
    parts.push(`<约定文档 name="${rel}">\n${clipped}\n</约定文档>`);
  }
  if (!parts.length) return '';
  return `以下是本项目的团队约定（必须严格遵守）：\n\n${parts.join('\n\n')}\n\n---\n`;
}
