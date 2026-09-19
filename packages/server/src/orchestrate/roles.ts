import fs from 'node:fs';
import path from 'node:path';
import type { SpaceRule } from './rules.js';

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
 * v9-B1 标准五连班底（规划/实现/评审/验收/沉淀）：新空间一键装填的内置模板。
 * id 固定 std-*；ensureStandardRoles 只补缺不覆盖——用户改过的同名角色受保护。
 */
export const STANDARD_TEAM_ROLES: Role[] = [
  {
    id: 'std-planner',
    name: '规划',
    prePrompt:
      '你是本班的规划手：把需求拆成可独立交付的小步，写清每步的产出与验收口径；不亲自实现，只把路铺直。',
  },
  {
    id: 'std-implementer',
    name: '实现',
    prePrompt:
      '你是本班的实现手：严格按分配到的步骤改代码，遵守仓库既有约定与分支规范，小步提交，不越界改动。',
  },
  {
    id: 'std-reviewer',
    name: '评审',
    prePrompt:
      '你是本班的评审：对着契约与diff挑问题（正确性/边界/回归风险），只提可执行的修改意见，不亲自改代码。',
  },
  {
    id: 'std-verifier',
    name: '验收',
    prePrompt:
      '你是本班的验收员：逐条核对验收标准（AC），能跑测试就跑测试，给出每条「过/不过」的实证依据，不放水。',
  },
  {
    id: 'std-curator',
    name: '沉淀',
    prePrompt:
      '你是本班的知识沉淀员：把这一单踩过的坑、验证过的做法整理成可复用的短文档，写清适用边界。',
  },
];

/** 把缺失的标准角色补写进全局角色库（按 id 去重，不动已存在的），返回五连全部 */
export function ensureStandardRoles(dataDir: string): Role[] {
  const existing = loadRoles(dataDir);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const added = STANDARD_TEAM_ROLES.filter((s) => !byId.has(s.id));
  if (added.length) saveRoles(dataDir, [...existing, ...added]);
  return STANDARD_TEAM_ROLES.map((s) => byId.get(s.id) ?? s);
}

/**
 * Build the convention context block injected before every agent prompt of a
 * space: entries resolved relative to profile.rootCwd, capped per-file and in
 * total. M3: entries are scoped rules (file + optional note) or plain paths
 * (legacy). Returns '' when nothing configured or nothing matched.
 */
export function buildConventionBlock(
  rootCwd: string | undefined,
  entries: (string | SpaceRule)[] | undefined,
  readFile: (p: string) => string | null,
): string {
  if (!rootCwd || !entries?.length) return '';
  const parts: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const rule = typeof entry === 'string' ? { file: entry } : entry;
    const rel = rule.file;
    if (rel.includes('..')) continue;
    const content = readFile(path.resolve(rootCwd, rel));
    if (content === null) continue;
    const clipped = content.length > PER_FILE_CAP ? `${content.slice(0, PER_FILE_CAP)}\n…（超长截断）` : content;
    if (total + clipped.length > TOTAL_CAP) {
      parts.push(`<约定文档 name="${rel}">（超出总预算未注入）</约定文档>`);
      break;
    }
    total += clipped.length;
    const note = rule.note ? ` note="${rule.note}"` : '';
    parts.push(`<约定文档 name="${rel}"${note}>\n${clipped}\n</约定文档>`);
  }
  if (!parts.length) return '';
  return `以下是本项目的团队约定（必须严格遵守）：\n\n${parts.join('\n\n')}\n\n---\n`;
}
