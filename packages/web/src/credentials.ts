/**
 * v19-R5 验收凭据：一单收口后「为什么信这条绿」的一张卡。
 * 判据零自造——机检走 shared.machineCheckTally（与 server/CLI 同一把尺），
 * 其余全部纯读 RunRecord 既有落册字段；缺键的条目明说「没这份账」而不是省略
 * （诚实边界与 CLI 同款：缺 ≠ 零，0 才是正断言）。
 */
import { machineCheckTally, type RunRecord } from '@paneflow/shared';

export type CredJump = 'shelf' | 'timeline' | 'pr' | null;

export interface CredLine {
  /** 账名（机检 / 产物 / 人等分 / 外部动作 / 打回） */
  key: string;
  /** 一句人话 + 数字 */
  text: string;
  /** 原始账读数（title 里给人核对，不藏在别处） */
  title: string;
  jump: CredJump;
}

/** 产物架清单（GET /api/runs/:id/artifacts 的既有形状，这里只消费不加工） */
export interface ShelfInfo {
  exists: boolean;
  files: { name: string; source?: 'workspace' | 'shelf'; sha?: string; shelved?: boolean }[];
}

export function credTerminalState(state: RunRecord['state']): boolean {
  return ['completed', 'completed-with-failures', 'failed', 'cancelled'].includes(state);
}

/** 等待时长的读数画法（分/小时自适应）——凭据卡与班底卡共用一把尺 */
export function waitLabel(ms: number): string {
  const m = ms / 60_000;
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (m < 60) return `${m.toFixed(1)} 分`;
  return `${(m / 60).toFixed(1)} 小时`;
}

function machineCheckLine(run: RunRecord): CredLine {
  const t = machineCheckTally(run);
  if (!t) {
    return {
      key: '机检',
      text: '机检账拿不到（图与账对不上，或账本上线前的旧单）',
      title: 'machineCheckTally 拿不到时整键省略——0 是正断言，「不知道」不是 0，这里不替你判。',
      jump: null,
    };
  }
  if (t.nodes === 0) {
    return {
      key: '机检',
      text: '这单没装机检项（0 项，不是漏跑）',
      title: `机检 0 项：图里各节点 checks[] 都没有引擎跑得动的型（manual 不算，引擎跑不了它）。`,
      jump: null,
    };
  }
  if (t.allPassed) {
    return {
      key: '机检',
      text: `机检 ${t.items} 项实跑全过`,
      title: `machineCheckTally: items=${t.items} nodes=${t.nodes} verified=${t.verified} allPassed=true\n（done 本身即实跑证据：引擎门禁保证 done ⇒ 该节点机检全过）`,
      jump: 'timeline',
    };
  }
  return {
    key: '机检',
    text: `机检 ${t.items} 项 · 只有 ${t.verified}/${t.nodes} 格实跑通过`,
    title: `machineCheckTally: items=${t.items} nodes=${t.nodes} verified=${t.verified} allPassed=false（未全过的格按节点状态可查）`,
    jump: 'timeline',
  };
}

function shelfLine(shelf: ShelfInfo | undefined): CredLine {
  if (shelf === undefined) {
    return { key: '产物', text: '产物架读数读取中…', title: 'GET /api/runs/:id/artifacts 在路上，不等它不画数。', jump: null };
  }
  if (!shelf.exists) {
    return {
      key: '产物',
      text: '这单没落过产物文件',
      title: '产物架两侧（工作区/架上）都是空——「没产零件」是正读数，不是省略。',
      jump: 'shelf',
    };
  }
  const shelved = shelf.files.filter((f) => f.source === 'shelf').length;
  const unshelved = shelf.files.filter((f) => f.shelved === false).length;
  const bits = [`${shelf.files.length} 件`];
  if (shelved) bits.push(`${shelved} 件已上架`);
  if (unshelved) bits.push(`⚠ ${unshelved} 件没上架`);
  return {
    key: '产物',
    text: `产物 ${bits.join(' · ')}${shelved ? '（sha 可点验）' : ''}`,
    title: `产物清单（一处清单两个来源：workspace 随 worktree 回收蒸发、shelf 是引擎上架副本带台账指纹）。点开看逐件明细。`,
    jump: 'shelf',
  };
}

function attentionLine(run: RunRecord): CredLine {
  const a = run.attention;
  if (!a) {
    return {
      key: '人等分',
      text: '没有等待账（没被门拦过，或这份账上线前的旧单）',
      title: 'attention 缺键 ≠ 零等待：放门结算才落册，账上没有就是账上没有。',
      jump: null,
    };
  }
  const g = a.gates;
  return {
    key: '人等分',
    text: `全程你等待 ${waitLabel(a.waitMs)} · 批 ${g.approve}/驳 ${g.reject}/补料 ${g.input}`,
    title: `attention 原始账: waitMs=${a.waitMs} gates={approve:${g.approve}, reject:${g.reject}, input:${g.input}}（Σ 各轮放门等待时长，只在两端时刻皆可考时累加）`,
    jump: 'timeline',
  };
}

function sideEffectsLine(run: RunRecord): CredLine {
  const se = run.sideEffects;
  if (!se || (!se.issuesCreated?.length && !se.issuePatched?.length && !se.prUrl && !se.pushedAt)) {
    return {
      key: '外部动作',
      text: se ? '没有对外部系统的写账' : '没有副作用账（没发生外部写，或模板没报=引擎不可见）',
      title: 'sideEffects 只记引擎可见的证据（建单/覆写/PR/推送），pushedAt 为自报口径；缺账不替「没干过」背书。',
      jump: null,
    };
  }
  const bits: string[] = [];
  if (se.issuesCreated?.length) bits.push(`建单 ${se.issuesCreated.map((n) => `#${n}`).join(' ')}`);
  if (se.issuePatched?.length) bits.push(`覆写 ${se.issuePatched.map((n) => `#${n}`).join(' ')}`);
  if (se.prUrl) bits.push('PR 已开');
  if (se.pushedAt) bits.push(`已推送 ${se.pushedAt.slice(0, 16).replace('T', ' ')}`);
  return {
    key: '外部动作',
    text: `外部动作：${bits.join(' · ')}`,
    title: `sideEffects 原始账: ${JSON.stringify(se)}`,
    jump: se.prUrl ? 'pr' : 'timeline',
  };
}

function reworkLine(run: RunRecord): CredLine {
  const reworked = Object.values(run.nodes)
    .map((n) => ({ id: n.nodeId, rs: n.rejections ?? [] }))
    .filter((x) => x.rs.length > 0);
  const total = reworked.reduce((s, x) => s + x.rs.length, 0);
  if (!total) {
    return {
      key: '打回',
      text: '打回账没落笔（零返工，或这是账本上线前的旧单）',
      title: 'rejections 落在被拒方节点上；从没被打回与 K2 前的旧单在账上同形，这里不替你分辨。',
      jump: null,
    };
  }
  const last = reworked[reworked.length - 1]!.rs[reworked[reworked.length - 1]!.rs.length - 1];
  return {
    key: '打回',
    text: `被打回 ${total} 次${last ? `（最近：${last.reviewer} 否决${last.action === 'capped' ? ' · 上限已达' : ''}）` : ''}`,
    title: [
      `打回账：审查岗经否决回边把货退回重做过 ${total} 次（重试/掐断是引擎自己再跑，打回是这件件被否了）`,
      ...reworked.map((x) => `· ${x.id} 被打回 ${x.rs.length} 次`),
    ].join('\n'),
    jump: 'timeline',
  };
}

function equipLine(run: RunRecord): CredLine {
  const eqNodes = Object.values(run.nodes).filter((n) => n.equip);
  if (!eqNodes.length) {
    return {
      key: '装备',
      text: '没有装备账（注入现场没走到，或这份账上线前的旧单）',
      title: 'equip 在注入现场整册落账：缺 ≠ 吃了零——非 agent 节点、档案不可读、v13-W1 前的旧单都是缺键，这里不替你分辨。',
      jump: null,
    };
  }
  let skills = 0;
  let rules = 0;
  let fullSpace = 0;
  let misses = 0;
  const roles = new Set<string>();
  const models = new Set<string>();
  const detail: string[] = [];
  for (const n of eqNodes) {
    const e = n.equip!;
    const sk = e.skills?.length ?? 0;
    const ru = e.rules?.length ?? 0;
    skills += sk;
    rules += ru;
    if (e.role) roles.add(e.role);
    if (e.model) models.add(e.model);
    // 与 CLI 装备行同一把尺：scope=space 且绑了岗=这格没配装备、实际吃项目全量
    const eatsFull = e.scope === 'space' && !!e.role;
    if (eatsFull) fullSpace += 1;
    // 没落地格的计数：新账读 misses（逐格带 why），旧账回落 unknownSkills（那时唯一的没落地原因就是清单外引用）
    const nodeMiss = e.misses?.length ?? e.unknownSkills?.length ?? 0;
    misses += nodeMiss;
    detail.push(
      `· ${n.nodeId} 技能 ${sk} · 文档 ${ru}${eatsFull ? '（⚠ 岗未配装备，吃项目全量）' : ''}${e.role ? ` · 岗 ${e.role}` : ''}${e.model ? ` · 模型 ${e.model}` : ''}${nodeMiss ? ` · 没落地 ${nodeMiss} 格` : ''}`,
    );
  }
  const bits = [`实注 技能 ${skills} · 岗位文档 ${rules}`];
  if (roles.size) bits.push(`${roles.size} 岗`);
  if (models.size) bits.push(`模型 ${[...models].join('/')}`);
  if (fullSpace) bits.push(`⚠ ${fullSpace} 格岗未配装备吃全量`);
  if (misses) bits.push(`⚠ ${misses} 格装备没落地`);
  return {
    key: '装备',
    text: bits.join(' · '),
    title: [`装备账（server 注入现场落册，这里只汇总不改判）：`, ...detail].join('\n'),
    jump: 'timeline',
  };
}

/** 一张凭据卡 = 六行账；顺序=「东西对不对→交付了没→怎么干的→你花了多少→动了外面什么→返过工没」 */
export function buildCredentialLines(run: RunRecord, shelf: ShelfInfo | undefined): CredLine[] {
  return [machineCheckLine(run), shelfLine(shelf), equipLine(run), attentionLine(run), sideEffectsLine(run), reworkLine(run)];
}
