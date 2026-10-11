/**
 * v19-R3 「班底」目的地的纯陈列层（单测口子）。
 * 铁律：零新判据——每个读数都直读既有 API 返回字段（health/gateway/spaces/roles/roles/:id/profile），
 * 这里只做「三问三答」的组装：他在不在 / 他会干什么 / 最近干得怎么样。
 * 缺键明说不省略（与 CLI 诚实边界同款）：读不到的账写「读不到」，不画灰卡冒充「他不行」。
 */
import type { TeamMemberLite, TeamRoleLite } from './team-bar.js';
import { waitLabel } from './credentials.js';

/** GET /api/roles/:id/profile 的 overall 线上形状（只声明 web 要读的字段；判据住在 server） */
export interface RoleOverallMetrics {
  runs: number;
  passRate?: { n: number; passed: number };
  nodePassRate?: { n: number; done: number; failed: number };
  attention?: { n: number; waitMs: number; gates: { approve: number; reject: number; input: number } };
  rework?: { rejected: number; capped: number };
  /** 装备实注账（v19 起 server role-profile 汇总）：判据住在 server，这里只照渲 */
  equip?: { n: number; skills: number; rules: number; fullSpace: number; misses: number };
}

export interface TeamViewRole extends TeamRoleLite {
  skills?: unknown[];
  rules?: unknown[];
  /** v19-M1 岗位模型覆盖（有值即优先于网关兜底显示在 modelLine 上） */
  model?: string;
}

export interface TeamViewInputs {
  team: (TeamMemberLite & { note?: string })[];
  roles: TeamViewRole[];
  /** GET /api/health → env.agentsInstalled */
  agentsInstalled: string[];
  /** GET /api/health → recommendedAgentKind（可缺） */
  recommendedAgentKind?: string | null;
  /** 项目档案 defaultAgentKind（可缺） */
  defaultAgentKind?: string;
  /** GET /api/gateway（读不到传 null——卡上写「网关读数不可得」，不猜） */
  gateway: { enabled: boolean; current?: string; freeModel?: string } | null;
  /** roleId → GET /api/roles/:id/profile 的 overall；没取到/取失败传 undefined */
  profiles: Record<string, RoleOverallMetrics | undefined>;
}

export interface MemberCard {
  roleId: string;
  /** 人给他的称呼：alias 优先，回落岗名，再回落 id（不编名） */
  display: string;
  roleName: string;
  note?: string;
  /** 解析出的引擎（岗位 > 项目默认 > 推荐）；null=三路全空 */  agentKind: string | null;
  kindSource: 'role' | 'space' | 'recommended' | 'none';
  /** 在不在：on=引擎已装 · off=引擎没装 · unknown=三路解析不出引擎 */
  presence: 'on' | 'off' | 'unknown';
  presenceLine: string;
  modelLine: string;
  equipLine: string;
  /** 悬停说清这行数字出自哪本账（配置槽 vs 注入现场实注） */
  equipTitle: string;
  trackLine: string;
  /** 灰卡（off/unknown）——点亮条件写进 presenceLine */
  dim: boolean;
}

/** 实注账的画法（班底卡与派活挑人共用，措辞不许两处各写一遍） */
export function equipReadoutBits(eq: NonNullable<RoleOverallMetrics['equip']>): string[] {
  const bits = [`实注 技能 ${eq.skills} · 岗位文档 ${eq.rules} · ${eq.n} 次上场`];
  if (eq.fullSpace) bits.push(`⚠ ${eq.fullSpace} 格吃项目全量`);
  if (eq.misses) bits.push(`⚠ ${eq.misses} 格没落地`);
  return bits;
}

export interface AssigneeBrief {
  text: string;
  /** warn=有 ⚠ 笔 · dim=这岗还没有实注账 · ok=干净读数 */
  tone: 'ok' | 'warn' | 'dim';
}

/**
 * 派活挑人时的装备读数：人挑完岗，在按下「开始」之前看见 TA 上次实际吃了什么。
 * runs 来自同一份岗级账（缺=server 没回这岗的账 → 不画，宁缺毋假）。
 */
export function assigneeEquipBrief(
  eq: RoleOverallMetrics['equip'],
  runs: number | undefined,
): AssigneeBrief | null {
  if (eq) {
    const bits = equipReadoutBits(eq);
    return { text: bits.join(' · '), tone: bits.length > 1 ? 'warn' : 'ok' };
  }
  if (runs === 0) return { text: '这岗还没上过单：实注账第一次派活后才落', tone: 'dim' };
  if (runs) return { text: `有 ${runs} 单履历，但没落装备账（注入现场没走到，或旧单）`, tone: 'dim' };
  return null;
}

/** `GET /api/dispatch/auto-engine` 的载荷：整句人话由 server 组（`note`），浏览器只挑颜色 */
export interface AutoEngineWire {
  agentKind: string | null;
  via: 'project-default' | 'probed' | 'none' | 'unknown';
  note: string;
}

/**
 * 选「自动（按项目默认）」时那行不再是空的：这单会落到哪个引擎、从哪一级解析出来的，
 * 判据在 server 的 `resolveAutoAgentKind`（与派单口同一条梯），这里只照渲 `note`。
 * 读数没回来/端点不可得（旧构建 404）→ null 不画，绝不写一句「默认引擎」猜。
 */
export function autoEngineBrief(read: AutoEngineWire | null | undefined): AssigneeBrief | null {
  if (!read || typeof read.note !== 'string' || !read.note.trim()) return null;
  const tone = read.via === 'none' ? 'warn' : read.via === 'project-default' ? 'ok' : 'dim';
  return { text: read.note, tone };
}

/**
 * 「自动这一路派不出单」该怎么一步修好——判序与旧 400 指路卡同尺，只是提前到按下「开始」之前：
 * 实探链（pi/opencode/codex/claude）全空不等于本机没有引擎，qodercli/hermes 那一类照样能干活，
 * 所以先给「用这些干」（点了=写进项目默认），一枚都没装才落到「去装 + 重新探」。
 * 其余三态（有默认 / 实探有值 / 档案读不动）返回 null：没有墙就没有修复卡，不摆空按钮。
 */
export function autoEngineFix(
  read: AutoEngineWire | null | undefined,
  installedKinds: string[],
): { offer: string[] } | { install: true; retry: true } | null {
  if (!read || read.via !== 'none') return null;
  if (installedKinds.length) return { offer: installedKinds };
  return { install: true, retry: true };
}

/** 名册里的悬空成员（roleId 不在角色库）也要有卡——明说「岗已不在名册」，不静默吞人 */
export function buildMemberCards(inp: TeamViewInputs): MemberCard[] {
  return inp.team.map((m) => {
    const role = inp.roles.find((r) => r.id === m.roleId);
    const alias = m.alias?.trim();
    const display = alias || role?.name || m.roleId;
    const roleName = role?.name ?? '（角色库里已无此岗）';

    const kindFromRole = role?.agentKind?.trim() || '';
    const kindFromSpace = inp.defaultAgentKind?.trim() || '';
    const kindFromReco = inp.recommendedAgentKind?.trim() || '';
    const agentKind = kindFromRole || kindFromSpace || kindFromReco || null;
    const kindSource: MemberCard['kindSource'] = kindFromRole ? 'role' : kindFromSpace ? 'space' : kindFromReco ? 'recommended' : 'none';

    let presence: MemberCard['presence'];
    let presenceLine: string;
    if (!agentKind) {
      presence = 'unknown';
      presenceLine = '这台机器还没探到可用引擎：装上任一 CLI（或给项目设默认引擎）即自动点亮';
    } else if (inp.agentsInstalled.includes(agentKind)) {
      presence = 'on';
      presenceLine = kindSource === 'role' ? `${agentKind} 已装（岗上指定）` : `${agentKind} 已装（跟项目默认）`;
    } else {
      presence = 'off';
      presenceLine = kindSource === 'role' ? `${agentKind} CLI 未装：装好即自动点亮` : `${agentKind} CLI 未装：换岗上引擎或装好即点亮`;
    }

    const gw = inp.gateway;
    // v19-M1 解析链「节点 > 角色 > 网关兜底」在班底卡的面：岗位配了模型就显岗位值，
    // 没配才显网关读数（引擎吃不吃这值由 server 方言表判，卡上不替引擎作保）
    const roleModel = role?.model?.trim() || '';
    const modelLine = roleModel
      ? `模型 ${roleModel}（岗位专属，覆盖网关兜底）`
      : !gw
        ? '网关读数不可得'
        : gw.enabled
          ? `走网关档${gw.current ? `「${gw.current}」` : ''}${gw.freeModel ? ` · 免费模型 ${gw.freeModel}` : ''}`
          : '网关未启用：吃引擎自带模型';

    const prof = inp.profiles[m.roleId];
    // 「会干什么」有两本账：配置=岗位声明的装备槽，实注=注入现场落册的 equip（server 汇总）。
    // 有实注就报实注（实态压名义，与 role-profile 的样本归属同一把尺），没上账才回落配置值并明说来源。
    const configBits =
      role && (role.skills !== undefined || role.rules !== undefined)
        ? `技能 ${role.skills?.length ?? 0} · 岗位文档 ${role.rules?.length ?? 0}`
        : null;
    const eq = prof?.equip;
    let equipLine: string;
    let equipTitle: string;
    if (!role) {
      equipLine = '岗不在角色库：装备无从解析';
      equipTitle = '班底名册还指着这枚岗，但角色库里已经没有它——先补岗或把他换到在册的岗上。';
    } else if (eq) {
      equipLine = equipReadoutBits(eq).join(' · ');
      equipTitle = [
        '装备实注账：注入现场真喂进 prompt 的文档计数（读失败/超预算的不算），判据在 server。',
        configBits ? `配置账（岗位声明的装备槽）：${configBits}` : '配置账：这岗没配装备槽，吃项目全量约定文档',
      ].join('\n');
    } else {
      equipLine = configBits ? `${configBits}（配置账，尚无实注记录）` : '没配装备槽：吃项目全量约定文档';
      equipTitle = '实注账要等这岗真上过单才有（v13-W1 起注入现场落册）；这里的数字是岗位声明的装备槽。';
    }

    let trackLine: string;
    if (prof === undefined) {
      trackLine = '履历读不到（server 没回这岗的账）';
    } else if (prof.runs === 0) {
      trackLine = '还没上过单——第一次派活后这里就有账';
    } else {
      const bits: string[] = [`上过 ${prof.runs} 单`];
      if (prof.passRate) bits.push(`收口 ${prof.passRate.passed}/${prof.passRate.n} 绿`);
      if (prof.nodePassRate) bits.push(`他的格 ${prof.nodePassRate.done}/${prof.nodePassRate.n} 过`);
      if (prof.rework) bits.push(prof.rework.rejected ? `被打回 ${prof.rework.rejected} 次` : '打回 0 次');
      if (prof.attention) bits.push(`你为他等 ${waitLabel(prof.attention.waitMs)}`);
      trackLine = bits.join(' · ');
    }

    return {
      roleId: m.roleId,
      display,
      roleName,
      note: m.note?.trim() || undefined,
      agentKind,
      kindSource,
      presence,
      presenceLine,
      modelLine,
      equipLine,
      equipTitle,
      trackLine,
      dim: presence !== 'on',
    };
  });
}
