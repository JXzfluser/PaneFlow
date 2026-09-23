import { describe, expect, it } from 'vitest';
import { projectCardFacts, sortProjectsCurrentFirst, type ProjectLite } from './project-cards.js';

const seed: ProjectLite[] = [
  { id: 'alpha', name: 'Alpha', createdAt: '2026-09-01', rootCwd: '/x', team: [{ roleId: 'r1' }, { roleId: 'r2' }] },
  { id: 'beta', name: 'Beta', createdAt: '2026-09-02' },
  { id: 'current', name: '当前项目', createdAt: '2026-09-03', team: [] },
];

describe('v10-V project-cards', () => {
  it('sortProjectsCurrentFirst：当前置顶、其余保持服务端顺序、不改原数组', () => {
    const sorted = sortProjectsCurrentFirst(seed, 'current');
    expect(sorted.map((p) => p.id)).toMatchInlineSnapshot(`
      [
        "current",
        "alpha",
        "beta",
      ]
    `);
    expect(seed.map((p) => p.id)).toEqual(['alpha', 'beta', 'current']);
  });

  it('无当前命中时原样返回', () => {
    expect(sortProjectsCurrentFirst(seed, 'nope').map((p) => p.id)).toEqual(['alpha', 'beta', 'current']);
  });

  it('卡片事实：配齐 vs 空项目（bot 词汇：班底 N bot 在岗 / 班底还没装填）', () => {
    expect(projectCardFacts(seed[0]!)).toMatchInlineSnapshot(`
      {
        "blurb": "还没有一句话说明——到档案里补上",
        "hasTeam": true,
        "rootState": "configured",
        "teamBadge": "班底 2 bot 在岗",
      }
    `);
    expect(projectCardFacts(seed[1]!)).toEqual({
      rootState: 'missing',
      teamBadge: '班底还没装填',
      hasTeam: false,
      blurb: '还没有一句话说明——到档案里补上',
    });
  });
});
