/**
 * v11-C5 沉淀卡片/弹层的纯逻辑（可离线单测，不碰 DOM）：
 * 页列表按 file 顶级目录分组 + 发布预览的响应面类型。
 */

export interface WikiPageRow {
  file: string;
  title: string;
}

export interface WikiPageGroup {
  /** 顶级目录名；未分目录的旧扁平页归 ''（展示为「其他」） */
  dir: string;
  label: string;
  pages: WikiPageRow[];
}

/** 每组展示上限：放宽自旧的整表 8（组内按文件名序，超出折叠在组尾部提示） */
export const WIKI_GROUP_CAP = 5;

export const WIKI_OTHER_LABEL = '其他';

/** 目录 → 人话标签（已知分类给图标；未知/未分目录用原名/「其他」） */
const DIR_LABELS: Record<string, string> = {
  summaries: '📄 summaries（run 沉淀页）',
  concepts: '💡 concepts（概念页）',
  entities: '🏷 entities（实体页）',
  syntheses: '🧪 syntheses（综合页）',
};

/**
 * 按 file 顶级目录分组：组内按文件名排序；已知分类目录按 summaries→concepts→
 * entities→syntheses 排前，其余目录按字典序，未分目录（「其他」）永远垫底。
 */
export function groupWikiPages(pages: WikiPageRow[]): WikiPageGroup[] {
  const byDir = new Map<string, WikiPageRow[]>();
  for (const p of pages) {
    const i = p.file.indexOf('/');
    const dir = i > 0 ? p.file.slice(0, i) : '';
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(p);
    else byDir.set(dir, [p]);
  }
  const rank = (dir: string): number => {
    if (dir === '') return Number.MAX_SAFE_INTEGER; // 「其他」垫底
    const known = Object.keys(DIR_LABELS).indexOf(dir);
    return known >= 0 ? known : 100; // 未知目录整体排在已知分类后
  };
  return [...byDir.entries()]
    .map(([dir, rows]) => ({
      dir,
      label: DIR_LABELS[dir] ?? (dir === '' ? WIKI_OTHER_LABEL : `📁 ${dir}`),
      pages: rows.sort((a, b) => a.file.localeCompare(b.file)),
    }))
    .sort((a, b) => rank(a.dir) - rank(b.dir) || a.dir.localeCompare(b.dir));
}

/** v11-C5 GET /api/wiki/preview 响应面（与服务端 http.ts preview 区一致） */
export interface WikiPreviewRes {
  gate: { ok: boolean; reason?: string };
  kind: 'green' | 'counterexample';
  page: { file: string; markdown: string } | null;
  repo: string;
  visibility?: 'public' | 'private';
}

/** 发布前是否必须先勾「我确认公开」：preview 缓存说 public，或 publish 409 现场告知 */
export function needsPublicConfirm(preview: Pick<WikiPreviewRes, 'visibility'> | null, serverSaysPublic: boolean): boolean {
  return preview?.visibility === 'public' || serverSaysPublic;
}
