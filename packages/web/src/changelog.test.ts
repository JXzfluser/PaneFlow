import { describe, expect, it } from 'vitest';
import { changelogVerNum, parseChangelog, recentChangelog } from './changelog.js';

const SAMPLE = [
  '# 更新记录',
  '',
  '每条一个版本，一句人话。',
  '',
  '## v18 · 控制面骨干',
  '',
  '这版让你能：手机上远程批门。',
  '',
  '- 项目新建向导。',
  '- 看板视图。',
  '',
  '## v17 · 登记去手填',
  '',
  '这版让你能：从清单里选。',
  '',
  '- 网关型号一键导入。',
].join('\n');

describe('parseChangelog', { timeout: 20000 }, () => {
  it('总标题与引言不开条，版本节按序拆出 ver/title/lead/items', () => {
    const es = parseChangelog(SAMPLE);
    expect(es).toHaveLength(2);
    expect(es[0]).toEqual({ ver: 'v18', title: '控制面骨干', lead: '这版让你能：手机上远程批门。', items: ['项目新建向导。', '看板视图。'] });
    expect(es[1]?.ver).toBe('v17');
  });

  it('乱序文档也按版本数字倒序；没版本标的节不开条（不是版本条目）', () => {
    const es = parseChangelog(['## v9 · 旧', '', 'x', '', '## v10 · 新', '', 'y', '', '## beta · 说不清', '', 'z'].join('\n'));
    expect(es.map((e) => e.ver)).toEqual(['v10', 'v9']);
    expect(es.map((e) => e.lead)).toEqual(['y', 'x']);
    expect(Number.isNaN(changelogVerNum('beta'))).toBe(true);
  });

  it('缺 lead 或 items 不编造——空数组/空串是正读数', () => {
    const es = parseChangelog('## v3 · 只有题眼\n');
    expect(es[0]).toEqual({ ver: 'v3', title: '只有题眼', lead: '', items: [] });
  });

  it('recentChangelog 只截前 N，不重排', () => {
    const es = parseChangelog(SAMPLE);
    expect(recentChangelog(es, 1).map((e) => e.ver)).toEqual(['v18']);
    expect(recentChangelog(es, 5)).toHaveLength(2);
  });
});
