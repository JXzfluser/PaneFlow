import { describe, expect, it } from 'vitest';
import { groupWikiPages, needsPublicConfirm, WIKI_GROUP_CAP } from './wiki-sediment';

describe('v11-C5 groupWikiPages：页列表按 file 顶级目录分组', () => {
  it('分类目录各成一组、未分目录归「其他」垫底；组内按文件名排序', () => {
    const groups = groupWikiPages([
      { file: 'summaries/login-fix-9f8e7d.md', title: '登录页 修复' },
      { file: '旧扁平页.md', title: '旧页' },
      { file: 'concepts/kanban-a1b2c3.md', title: '看板' },
      { file: 'summaries/export-bug-ab12cd.md', title: '导出兜底' },
    ]);
    expect(groups.map((g) => g.dir)).toEqual(['summaries', 'concepts', '']);
    expect(groups[1]!.label).toContain('concepts');
    expect(groups[2]!.label).toBe('其他');
    expect(groups[0]!.pages.map((p) => p.file)).toEqual(['summaries/export-bug-ab12cd.md', 'summaries/login-fix-9f8e7d.md']);
    expect(groups[2]!.pages.map((p) => p.file)).toEqual(['旧扁平页.md']);
  });

  it('未知目录按字典序排在已知分类后、「其他」前；空列表回空', () => {
    const groups = groupWikiPages([
      { file: 'playbooks/x.md', title: 'X' },
      { file: 'faq/y.md', title: 'Y' },
      { file: 'syntheses/s.md', title: 'S' },
    ]);
    expect(groups.map((g) => g.dir)).toEqual(['syntheses', 'faq', 'playbooks']);
    expect(groupWikiPages([])).toEqual([]);
  });

  it('每组展示上限 5：组内排序后 slice(0, CAP) 截前 5，其余仅计数', () => {
    const pages = Array.from({ length: 7 }, (_, i) => ({ file: `summaries/p${i}.md`, title: `P${i}` }));
    const [g] = groupWikiPages(pages);
    expect(g!.pages).toHaveLength(7);
    expect(g!.pages.slice(0, WIKI_GROUP_CAP).map((p) => p.file)).toEqual([
      'summaries/p0.md',
      'summaries/p1.md',
      'summaries/p2.md',
      'summaries/p3.md',
      'summaries/p4.md',
    ]);
    expect(WIKI_GROUP_CAP).toBe(5);
  });

  it('v11-C3b：citedBy 引用列表随页透传，分组不加工不丢', () => {
    const groups = groupWikiPages([
      { file: 'summaries/a.md', title: 'A', citedBy: ['r-1', 'r-2'] },
      { file: 'summaries/b.md', title: 'B' },
    ]);
    expect(groups[0]!.pages[0]!.citedBy).toEqual(['r-1', 'r-2']);
    expect(groups[0]!.pages[1]!.citedBy).toBeUndefined();
  });
});

describe('v11-C5 needsPublicConfirm：public 勾选门', () => {
  it('preview 缓存 public 或 publish 409 现场告知 → 需要勾选；private/未知 → 不需要', () => {
    expect(needsPublicConfirm({ visibility: 'public' }, false)).toBe(true);
    expect(needsPublicConfirm({ visibility: 'private' }, false)).toBe(false);
    expect(needsPublicConfirm({}, true)).toBe(true);
    expect(needsPublicConfirm({ visibility: 'private' }, true)).toBe(true); // 可见性以服务端现场告知为准
    expect(needsPublicConfirm(null, false)).toBe(false);
  });
});
