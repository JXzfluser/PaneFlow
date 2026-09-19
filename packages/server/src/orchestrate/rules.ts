import path from 'node:path';

/**
 * M3 规范作用域化：空间 profile.rules 条目（配置文件管理，不做编辑器）。
 * 无 repo 且无 pathsGlob = 全空间规则（旧 conventionFiles 的等价形）。
 */
export interface SpaceRule {
  /** 相对空间主仓根的仓库目录名——只给在该仓工作目录内的节点注入（消费 repos 登记的作用域面） */
  repo?: string;
  /** 对节点工作目录（相对主仓根、/ 分隔）的 glob；支持 * / ** / ? */
  pathsGlob?: string;
  /** 约定文档路径（相对主仓根） */
  file: string;
  /** 为什么/什么时候守这条——随约定文档注入给 Agent 提示 */
  note?: string;
}

const norm = (p: string): string => p.split(path.sep).join('/');

/** 生效规则 = 新 rules + 旧 conventionFiles 自动迁移为无作用域条目（按 file 去重，rules 优先） */
export function effectiveRules(profile: {
  conventionFiles?: string[];
  rules?: SpaceRule[];
}): SpaceRule[] {
  const out = (profile.rules ?? []).filter((r) => r && typeof r.file === 'string' && r.file);
  const seen = new Set(out.map((r) => r.file));
  for (const f of profile.conventionFiles ?? []) {
    if (!seen.has(f)) {
      out.push({ file: f });
      seen.add(f);
    }
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'; // ** 跨目录段；v0 保守：不支持零段折叠（docs/** 不匹配 docs 本身）
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * 节点工作目录 → 命中的规则子集：无作用域恒命中（即使仓外）；
 * repo 按目录包含；pathsGlob 对 rel 匹配；repo+glob 同时给出取与。
 * 主仓根未配置或节点不在仓内时，作用域规则一律不命中。
 */
export function matchRules(rules: SpaceRule[], rootCwd: string | undefined, nodeCwd: string | undefined): SpaceRule[] {
  const rel = rootCwd && nodeCwd ? norm(path.relative(path.resolve(rootCwd), path.resolve(nodeCwd))) : '';
  const inside = !!rel && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel);
  return rules.filter((r) => {
    if (!r.repo && !r.pathsGlob) return true;
    if (!inside) return false;
    if (r.repo) {
      const repo = r.repo.replace(/\/+$/, '');
      if (!(rel === repo || rel.startsWith(`${repo}/`))) return false;
    }
    if (r.pathsGlob && !globToRegExp(r.pathsGlob).test(rel)) return false;
    return true;
  });
}
