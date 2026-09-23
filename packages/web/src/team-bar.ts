/** v10-U3b 班底条的纯函数面（单测不碰 DOM） */

export interface TeamRoleLite {
  id: string;
  name: string;
  agentKind?: string;
}
export interface TeamMemberLite {
  roleId: string;
  alias?: string;
}

/** 全局角色库里还没进本班底的部分 = 下拉可添加项（悬空 roleId 不在库中，天然不挡添加） */
export function addableRoles(roles: TeamRoleLite[], team: TeamMemberLite[]): TeamRoleLite[] {
  const inTeam = new Set(team.map((m) => m.roleId));
  return roles.filter((r) => !inTeam.has(r.id));
}
