import type { NodeEquip } from '@paneflow/shared';

/**
 * v19 打磨：岗位装备账在网页清单视图的可见面（纯函数，镜像 CLI `paneflow status` 的画法）。
 * 判据全在 server 注入现场（v13-W1/A5-5b 落册的账），这里只照渲字段（铁律 R4）：
 * - `equip` 整键缺省=注入现场没走到（非 agent 节点/档案不可读）——回空数组，不拿零行冒充「吃了零」；
 * - scope=space 且绑了角色=「该角色未配装备，正吃空间全量」，警示行；
 * - `misses[].why` 是 server 原话，逐格一行；旧单没有 misses 才回落 v13-W1 的「不在登记清单」措辞
 *   （拿新措辞去套旧账是假话：那时唯一的没落地原因就是清单外引用）。
 */

export interface EquipLine {
  text: string;
  warn: boolean;
}

export function equipLines(equip: NodeEquip | undefined): EquipLine[] {
  if (!equip) return [];
  const bits = `技能 ${equip.skills?.length ?? 0} · 岗位文档 ${equip.rules?.length ?? 0}`;
  const lines: EquipLine[] = [];
  if (equip.scope === 'space' && equip.role) {
    lines.push({ text: `⚠ 装备: ${bits} —— 该角色未配装备，正吃空间全量`, warn: true });
  } else {
    lines.push({
      text: `装备: ${bits}${equip.role ? ` · 岗 ${equip.role}` : ''}${equip.model ? ` · 模型 ${equip.model}` : ''}`,
      warn: false,
    });
  }
  if (equip.misses?.length) {
    for (const m of equip.misses) {
      lines.push({ text: `⚠ 装备没落地，已跳过：${m.slot} —— ${m.why}`, warn: true });
    }
  } else if (equip.unknownSkills?.length) {
    lines.push({
      text: `⚠ 装备引用不在登记清单，已跳过：${equip.unknownSkills.join('、')}`,
      warn: true,
    });
  }
  return lines;
}
