/**
 * v18-R3 审阅 diff 摘要（纯函数）：把 unified diff 原文解析成「改了哪些文件、各加/删几行」。
 * 判据只吃 git diff 的标准产物（changes.diff 由引擎 `git diff HEAD` 采集，products.ts 落架）——
 * 解析不到头部行就如实返回空 files，绝不把正文猜成文件名。
 */

export interface DiffFileSummary {
  file: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface DiffSummary {
  files: DiffFileSummary[];
  totalAdded: number;
  totalRemoved: number;
}

const EMPTY: DiffSummary = { files: [], totalAdded: 0, totalRemoved: 0 };

/** 从 `+++ b/path` / `+++ /dev/null` 行取文件路径（rename/新文件/删除统一按 b 侧算）。 */
function pathOfPlusSide(line: string): string | null {
  const raw = line.replace(/^\+\+\+\s+/, '').trim();
  if (!raw || raw === '/dev/null') return null;
  return raw.replace(/^b\//, '');
}

export function parseUnifiedDiff(text: string): DiffSummary {
  if (!text || !text.includes('diff --git')) return EMPTY;
  const files: DiffFileSummary[] = [];
  let current: DiffFileSummary | null = null;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHunk = false;
      // git 二进制 diff 没有 ---/+++ 行——文件名先按 diff --git 的 b 侧落位（取最后一个 " b/"，
      // 容忍文件名里含 " a/"），后面 +++ 若出现再覆盖；零增删的条目由底部 withCounts 滤掉
      const bIdx = line.lastIndexOf(' b/');
      if (bIdx >= 0) {
        current = { file: line.slice(bIdx + 3).trim(), added: 0, removed: 0, binary: false };
        files.push(current);
      }
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ ')) {
      const p = pathOfPlusSide(line);
      if (p && current) current.file = p;
      else if (p) {
        current = { file: p, added: 0, removed: 0, binary: false };
        files.push(current);
      }
      continue;
    }
    // 二进制标记在 hunk 之前出现（无 @@），必须先于 inHunk 守卫判
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      if (current) current.binary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!current || !inHunk) continue;
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }
  const withCounts = files.filter((f) => f.added > 0 || f.removed > 0 || f.binary);
  return {
    files: withCounts,
    totalAdded: withCounts.reduce((s, f) => s + f.added, 0),
    totalRemoved: withCounts.reduce((s, f) => s + f.removed, 0),
  };
}

/** 人话摘要：「3 个文件 · +48 −12」；空 diff 明说无改动。 */
export function summarizeDiff(s: DiffSummary): string {
  if (!s.files.length) return '无改动';
  return `${s.files.length} 个文件 · +${s.totalAdded} −${s.totalRemoved}`;
}
