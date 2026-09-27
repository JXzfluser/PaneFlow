import {
  equipSlotIssueOf,
  equipSlotLabel,
  isRoleEquipRef,
  type RegistryEntry,
  type RoleEquipRef,
  type RuleRegistrySpec,
  type SkillRegistrySpec,
} from '@paneflow/shared';
import { matchedEntries, type RawReference } from './registry-refs.js';
import { resolveSkillRefs } from './skills.js';
import type { SpaceRule } from './rules.js';

/**
 * v14-A5-5b 角色装备槽的**消费面与保存面**：`Role.skills` / `Role.rules` 自这一片起接受两种写法
 * （裸相对路径＝v13-W1 现役；`{kind,id}`＝注册表定点引用）。语义与为什么并存见 shared 的
 * `RoleEquipSlot` 注释块，这里只落它两件事：
 *
 *  1. **一槽怎么落进注入清单**（`resolveEquipSlots`，注入现场用）：裸串照走 v13-W1 那把池子尺
 *     （`resolveSkillRefs`，一字不改其行为），引用对象走 R2 那把尺（`matchedEntries` → descriptor 的
 *     `refKeys`/`matches`）——两把尺都在别处已经存在，本模块只做「按声明顺序分发 + 把落不了地的报出来」，
 *     **不自造第三把匹配判据**（铁律：预检、引用账、注入现场若是三把尺，就会出现「引用账说在用、注入说没有」）。
 *  2. **一槽能不能存进名册**（`guardEquipRefs`，`PUT /api/roles` 用）：引用对象指向注册表里解析不到的条目
 *     就是悬挂，入库那一刻拒（R2 写端拒悬挂的同一条姿态装到角色库这一面；裸串不判——池子语义今天就不判死活）。
 *
 * 三条诚实边界：
 *  - **顺序是账的一部分**：装备账 `skills`/`rules` 按注入顺序落册，`roleSha` 又按它的取材算指纹，
 *    所以这里逐槽按声明顺序处理，绝不先把两写法分组再拼（那会让存量纯裸串的名册换指纹）；
 *  - **引用只在同项目落地**：`spec.file` 是相对**那个项目主仓根**的路径，本单在别的项目时按本单根去读
 *    就是跨根拿相对路径——判不出来读错了谁，所以 `spec.space ≠ 本单空间` 的条目算「落不了地」，进披露不进注入；
 *  - **落不了地只披露不拦**（评审 R5 同款）：跑单不许因为一格坏引用而红，网页/CLI 看得见那格没吃进什么。
 */

/** 一槽落不了地的原因（披露面的 `why`；`label` 是槽原文，两写法共用同一句措辞归 shared） */
export interface EquipSlotMiss {
  label: string;
  why: string;
}

export interface EquipSlotResolution {
  /** 可注的技能文档路径（相对本单主仓根，按声明顺序、已去重） */
  skills: string[];
  /** 岗位文档**候选**（带条目声明的作用域）；作用域收窄归 `matchRules`，这里不替它判命中 */
  rules: SpaceRule[];
  /** 没落地的技能槽（原文 + 一句为什么） */
  unknownSkills: EquipSlotMiss[];
  /** 没落地的岗位文档槽（原文 + 一句为什么） */
  unknownRules: EquipSlotMiss[];
}

export interface EquipSlotContext {
  /** 本单所属项目 id（`SpaceProfile.id`）；定点引用只在它等于条目的 `spec.space` 时落地 */
  spaceId: string | undefined;
  /** 本单的技能登记清单（`profile.skills`）——裸串那一路的池子，只问「在不在」 */
  skillPool: readonly string[] | undefined;
  /** 注册表整表读数（`readView().entries`：用户登记项 + 视图现算项），由调用方给，本模块不开第二条读盘路 */
  entries: readonly RegistryEntry[];
  /** 发引用的是哪一枚岗（只进 `RawReference` 的出处格，给 descriptor 的 `matches` 用；不参与命中判定） */
  roleId?: string;
  /**
   * 空间/目录轴已经注过的文档路径：同一篇不注两遍（v13-W1 起岗位文档槽与 `matchRules` 命中按 file
   * 去重、空间侧优先）。裸串那一路今天就在做这件事，形状照旧。
   */
  alreadyCovered?: ReadonlySet<string>;
}

/** 一格的原文引用（`kind` 由槽自己声明，`target` 是槽里那枚 id） */
function refFromSlot(roleId: string | undefined, via: string, kind: string, target: string): RawReference {
  return { face: 'role', id: roleId ?? '', name: roleId ?? '（无岗名）', via, kind, target };
}

/** 条目里的路径能不能拿相对主仓根去读（`..` 一律不取：与 `buildSkillBlock` 的 `safeJoin` 同一把尺） */
const injectable = (file: unknown): file is string =>
  typeof file === 'string' && !!file.trim() && !file.includes('..');

/**
 * 一枚 `{kind,id}` → 它落地的文档路径（可能多枚条目同指一篇，去重后逐枚取）。
 * 返回 `[]` 且 `miss` 给一句为什么。
 */
function resolveRef(
  ref: { kind: 'skill' | 'rule'; id: string },
  ctx: EquipSlotContext,
  via: string,
): { files: { file: string; spec: SkillRegistrySpec | RuleRegistrySpec }[]; miss?: EquipSlotMiss } {
  const hits = matchedEntries(ctx.entries, refFromSlot(ctx.roleId, via, ref.kind, ref.id)).filter(
    // `enabled:false` 是「留着但不再被选」，拿它凑装备槽就是假绿（预检那一侧同一条判序）
    (e) => e.enabled,
  );
  if (!hits.length) {
    return {
      files: [],
      // 「解析不到」而不是「本机没有这一枚」：注册表整表读不动时调用方给的是空表，那也是解析不到——
      // 两种情况下都不注，这句都不过火（宁缺毋假：绝不按「已注入」落账）
      miss: { label: equipSlotLabel(ref), why: `注册表里解析不到可用的「${ref.kind}」条目（${ref.id}）` },
    };
  }
  const landed: { file: string; spec: SkillRegistrySpec | RuleRegistrySpec }[] = [];
  const others: string[] = [];
  for (const e of hits) {
    const spec = e.spec as SkillRegistrySpec | RuleRegistrySpec;
    if (ctx.spaceId === undefined || spec.space !== ctx.spaceId) {
      others.push(`「${e.name}」挂在项目「${spec.space}」`);
      continue;
    }
    if (!injectable(spec.file)) {
      others.push(`「${e.name}」的 spec.file 没法按主仓根去读（空串或含 ..）`);
      continue;
    }
    if (!landed.some((l) => l.file === spec.file)) landed.push({ file: spec.file, spec });
  }
  if (!landed.length) {
    return {
      files: [],
      miss: {
        label: equipSlotLabel(ref),
        why: `命中的条目不属于本单所在项目（${others.join('、')}），跨项目拿相对路径读文档不在注入面的口径里`,
      },
    };
  }
  return { files: landed };
}

/**
 * 一批装备槽 → 注入清单 + 落不了地的披露。**纯函数**（`entries` 与池子都由调用方给）。
 * 槽原文是 `unknown[]`：名册是可以手编的，脏形状也要有地方说清（今天它是静默跳过，这一片起显出来）。
 */
export function resolveEquipSlots(
  slots: { skills?: readonly unknown[]; rules?: readonly unknown[] },
  ctx: EquipSlotContext,
): EquipSlotResolution {
  const skills: string[] = [];
  const rules: SpaceRule[] = [];
  const unknownSkills: EquipSlotMiss[] = [];
  const unknownRules: EquipSlotMiss[] = [];
  const covered = ctx.alreadyCovered ?? new Set<string>();

  const pushSkill = (file: string): void => {
    if (skills.includes(file) || covered.has(file)) return;
    skills.push(file);
  };
  const pushRule = (rule: SpaceRule): void => {
    if (covered.has(rule.file) || rules.some((r) => r.file === rule.file)) return;
    rules.push(rule);
  };

  const walk = (
    list: readonly unknown[] | undefined,
    kind: 'skill' | 'rule',
    via: (i: number) => string,
  ): void => {
    const miss = kind === 'skill' ? unknownSkills : unknownRules;
    (list ?? []).forEach((raw, i) => {
      const slotVia = via(i);
      if (typeof raw === 'string') {
        // **裸串一支不重写判据**：技能照旧调 `resolveSkillRefs`（v13-W1 的池子尺，逐槽调一次而已，
        // 判据仍是那一处），岗位文档照旧的「是路径就交给约定通道」。这样存量纯裸串名册在两写法
        // 并存之后**逐字节不变**（注入顺序、unknownSkills 原文、roleSha 取材全一致）——
        // 变了的只有新那几格，和下面明确说明的一处新增披露。
        if (kind === 'skill') {
          const one = resolveSkillRefs(ctx.skillPool, [raw]);
          if (one.files.length) pushSkill(one.files[0]!);
          // 空串与不在池子里的裸串：今天就是「不注、只披露」，措辞照 shared 那一句（不再各写一遍）
          else if (one.unknown.length) miss.push({ label: one.unknown[0]!, why: '不在本项目的技能登记清单里' });
          return;
        }
        // 岗位文档这一路今天**没有任何披露通道**（脏路径静默跳过），所以新增 `unknownRules` 不会
        // 改动任何已落册的读数：老名册里干净的路径走的是同一条 pushRule，脏的从来就没进账。
        if (!raw || raw.includes('..')) {
          miss.push({ label: raw ? raw : '（空串）', why: '不是可按主仓根去读的路径' });
          return;
        }
        pushRule({ file: raw });
        return;
      }
      const issue = equipSlotIssueOf(raw);
      if (issue) {
        miss.push({ label: equipSlotLabel(raw), why: `形状不认：${issue}` });
        return;
      }
      // 上面 `issue` 为空且不是字符串 ⇒ 必是 `equipSlotIssueOf` 认下的 `{kind,id}`（同一枚判据，这里只窄化形状）
      const ref = raw as RoleEquipRef;
      if (ref.kind !== kind) {
        // `{kind:'rule',id}` 塞进技能格（或反之）：条目本身可能是好的，但它注的不是这一轴的文档，
        // 照它的 kind 去解析就变成「技能槽里吃进一篇约定文档」——那是把两轴的账搅成一锅。
        miss.push({ label: equipSlotLabel(raw), why: `这一格只认 {kind:'${kind}'}（收到 kind='${ref.kind}'）` });
        return;
      }
      const { files, miss: why } = resolveRef(ref, ctx, slotVia);
      if (why) {
        miss.push(why);
        return;
      }
      for (const f of files) {
        if (kind === 'skill') pushSkill(f.file);
        else {
          const spec = f.spec as RuleRegistrySpec;
          pushRule({ file: f.file, ...(spec.repo ? { repo: spec.repo } : {}), ...(spec.pathsGlob ? { pathsGlob: spec.pathsGlob } : {}), ...(spec.note ? { note: spec.note } : {}) });
        }
      }
    });
  };

  walk(slots.skills, 'skill', (i) => `skills[${i}]`);
  walk(slots.rules, 'rule', (i) => `rules[${i}]`);
  return { skills, rules, unknownSkills, unknownRules };
}

export type EquipRefGuard = { ok: true } | { ok: false; code: 400 | 500; error: string };

/** 名册里所有 `{kind,id}` 槽（保存面的遍历口径与注入面同一份：都只看 `isRoleEquipRef` 认下的那些） */
function pinnedSlots(roles: readonly { id: string; skills?: readonly unknown[]; rules?: readonly unknown[] }[]): {
  roleId: string;
  via: string;
  ref: { kind: 'skill' | 'rule'; id: string };
}[] {
  const out: { roleId: string; via: string; ref: { kind: 'skill' | 'rule'; id: string } }[] = [];
  for (const r of roles) {
    for (const k of ['skills', 'rules'] as const) {
      (r[k] ?? []).forEach((raw, i) => {
        if (isRoleEquipRef(raw)) out.push({ roleId: r.id, via: `${k}[${i}]`, ref: { kind: raw.kind, id: raw.id } });
      });
    }
  }
  return out;
}

/**
 * 保存面：这一批名册里的**定点引用**能不能解析到条目。
 * 只判引用对象——裸串指向的是「本项目的池子里的一枚路径」，它今天在名册里就可以指一篇还没登记的文档
 * （跑单时落 `unknownSkills` 披露），把它一并拒掉等于给存量名册改判据（那是另一次迁移，不是这一片）。
 * 注册表读不出＝**500 不放行**（A5-5a 同一条姿态：读不出降级成「没有悬挂」就是给写入开绿灯）。
 */
export function guardEquipRefs(
  entries: readonly RegistryEntry[],
  roles: readonly { id: string; skills?: readonly unknown[]; rules?: readonly unknown[] }[],
): EquipRefGuard {
  const gaps: string[] = [];
  for (const { roleId, via, ref } of pinnedSlots(roles)) {
    const found = matchedEntries(entries as RegistryEntry[], refFromSlot(roleId, via, ref.kind, ref.id));
    if (found.length) continue;
    gaps.push(`岗「${roleId}」的 ${via} → ${equipSlotLabel(ref)}`);
  }
  if (!gaps.length) return { ok: true };
  return {
    ok: false,
    code: 400,
    error: `装备槽里有注册表解析不到的定点引用：${gaps.join('、')}——先在「注册中心」登记那一枚（或把它换回相对路径/删掉这一格）再存名册。`,
  };
}
