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

/**
 * v19-R4 派活挑人的「谁来干」候选：班底成员 × 角色库里解析得出引擎的岗。
 * 只列接得住单的人（角色悬空/没配引擎的成员不进下拉）——选择器不摆「选了必被拒」的选项；
 * server 派单口照旧按同三条独立复核（这里只是陈列过滤，不是判据搬家）。
 * 显示名优先 alias（人给 TA 起的称呼），标点是岗位与引擎，全在人话层。
 */
export function assigneeOptions(
  team: TeamMemberLite[],
  roles: TeamRoleLite[],
): { roleId: string; label: string; agentKind: string }[] {
  const out: { roleId: string; label: string; agentKind: string }[] = [];
  for (const m of team) {
    const r = roles.find((x) => x.id === m.roleId);
    const kind = r?.agentKind?.trim();
    if (!r || !kind) continue;
    const display = m.alias?.trim() && m.alias.trim() !== r.name ? m.alias.trim() : r.name;
    const label = display === r.name ? `${r.name}（${kind}）` : `${display}（${r.name} · ${kind}）`;
    out.push({ roleId: m.roleId, label, agentKind: kind });
  }
  return out;
}
