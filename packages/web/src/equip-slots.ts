import { isRoleEquipRef, type RoleEquipRef, type RoleEquipSlot } from '@paneflow/shared';

/**
 * v14-A5-5b 装备槽勾选面的三刀判序。
 * 判据不住这儿：什么是合法引用、两写法各走哪把尺，全在 shared 的 `equipSlotIssueOf`/
 * `isRoleEquipRef` 与 server 的 `resolveEquipSlots`；这里只做「一格里两种写法并存时，
 * 哪一个动作碰哪一类」的分流——而最容易踩空的一格是「清掉」：它从前把清单外的项一键抹掉，
 * 现在裸串的毛病不该顺手把定点引用也洗了。
 */

/** 一格槽清单的分流：`unknown` 只数裸串（引用不在项目勾选清单里，说它「清单外」是假话） */
export function splitEquipSlots(
  selected: readonly RoleEquipSlot[],
  optionPaths: readonly string[],
): { bare: string[]; refs: RoleEquipRef[]; unknown: string[] } {
  const bare = selected.filter((s): s is string => typeof s === 'string');
  return {
    bare,
    refs: selected.filter((s): s is RoleEquipRef => isRoleEquipRef(s)),
    unknown: bare.filter((p) => !optionPaths.includes(p)),
  };
}

/** 摘掉一格：勾选框取消＝剔那一枚裸串；引用行「摘掉」＝只剔那一枚 `{kind,id}` */
export function removeEquipSlot(
  selected: readonly RoleEquipSlot[],
  slot: RoleEquipSlot,
): RoleEquipSlot[] {
  return selected.filter((x) =>
    typeof slot === 'string'
      ? x !== slot
      : !(isRoleEquipRef(x) && x.kind === slot.kind && x.id === slot.id),
  );
}

/** 「清掉」那一下：只清清单外的裸串，引用与清单内的勾选项一律留下 */
export function keepValidSlots(
  selected: readonly RoleEquipSlot[],
  optionPaths: readonly string[],
): RoleEquipSlot[] {
  return selected.filter((x) => typeof x !== 'string' || optionPaths.includes(x));
}

/** 这一枚引用是不是已经在这格上（比对按 `kind`+`id` 成对，不按对象引用相等） */
export function hasEquipRef(
  selected: readonly RoleEquipSlot[],
  ref: { kind: RoleEquipRef['kind']; id: string },
): boolean {
  return selected.some((x) => isRoleEquipRef(x) && x.kind === ref.kind && x.id === ref.id);
}

/** 定点引用的勾选：同一枚不重复塞（重复会渲成两行一样的 chip，摘一次只掉一枚，是假象） */
export function toggleEquipRef(
  selected: readonly RoleEquipSlot[],
  ref: { kind: RoleEquipRef['kind']; id: string },
): RoleEquipSlot[] {
  return hasEquipRef(selected, ref) ? removeEquipSlot(selected, ref) : [...selected, ref];
}
