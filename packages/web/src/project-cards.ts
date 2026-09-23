/** v10-V 项目视图的纯函数件：卡片事实 + 排序（web 测试无 DOM 库，逻辑收在这层） */

export interface ProjectLite {
  id: string;
  name: string;
  createdAt?: string;
  rootCwd?: string;
  description?: string;
  team?: { roleId: string }[];
}

export interface ProjectCardFacts {
  /** 主仓状态：配了没 / 未配（未配时卡片标警告色） */
  rootState: 'configured' | 'missing';
  /** 班底徽标文案，bot 阵容词汇 */
  teamBadge: string;
  hasTeam: boolean;
  /** 一句话说明缺省文案 */
  blurb: string;
}

export function projectCardFacts(p: ProjectLite): ProjectCardFacts {
  const n = p.team?.length ?? 0;
  return {
    rootState: p.rootCwd ? 'configured' : 'missing',
    teamBadge: n > 0 ? `班底 ${n} bot 在岗` : '班底还没装填',
    hasTeam: n > 0,
    blurb: p.description?.trim() || '还没有一句话说明——到档案里补上',
  };
}

/** 当前项目置顶，其余保持服务端顺序（已按 createdAt 排好） */
export function sortProjectsCurrentFirst(list: ProjectLite[], currentId: string): ProjectLite[] {
  return [...list].sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : 0));
}
