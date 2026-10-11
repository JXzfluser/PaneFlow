/**
 * v19-R6 更新记录的解析层（纯函数，单测口子）：
 * 数据源 = server /api/changelog 原样回传的 CHANGELOG.md 文本。
 * 这里只做陈列前的结构提取——每条一句人话由文件本身负责，不在代码里改写。
 */

export interface ChangelogEntry {
  /** 版本标（原样，如 'v18'） */
  ver: string;
  /** 版本标后的题眼（如 '控制面骨干 + 30 秒建项目'），没有则空串 */
  title: string;
  /** 「这版让你能：…」一句人话 */
  lead: string;
  /** 要点行（已剥 '- '） */
  items: string[];
}

/** 版本序号（'v18'→18）；取不出数字的排最后，不编 */
export function changelogVerNum(ver: string): number {
  const m = /^v(\d+)/i.exec(ver.trim());
  return m ? Number(m[1]) : Number.NaN;
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      const head = h[1] ?? '';
      const sep = head.split(/\s+·\s+/);
      const ver = sep[0] ?? '';
      // 跳过 '# 更新记录' 这类总标题：没有版本标就不开条
      if (!/^v?\d+/i.test(ver)) {
        cur = null;
        continue;
      }
      cur = { ver, title: sep.slice(1).join(' · '), lead: '', items: [] };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('- ')) {
      cur.items.push(line.slice(2).trim());
    } else if (!cur.lead && line.trim() !== '') {
      cur.lead = line.trim();
    }
  }
  // 倒序按版本数字排；能开条的必有数字版本标（上面已把没版本标的节挡在门外）
  return entries.sort((a, b) => changelogVerNum(b.ver) - changelogVerNum(a.ver));
}

/** 页面上的「最近 N 个版本」——默认 5（可感面：30 秒说出最近三版干了什么） */
export function recentChangelog(entries: ChangelogEntry[], n = 5): ChangelogEntry[] {
  return entries.slice(0, n);
}
