import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RegistryEntry } from '@paneflow/shared';
import { RegistryStore } from './registry.js';
import { guardEquipRefs, resolveEquipSlots } from './registry-equip.js';
import { matchRules } from './rules.js';
import { resolveSkillRefs } from './skills.js';

/**
 * v14 A5-5b 装备槽两写法的**消费面与保存面**。
 *
 * 条目全部走真注册表（`RegistryStore.add` 落盘再 `readView()` 读回），不手搓 spec：
 * 这一片的全部风险在「引用对象到底能不能解出那篇文档」，把条目形状桩掉就只剩在证自己的假设。
 * 三组断言各有分工：①裸串一支**与 v13-W1 逐字节同源**（判据不许在这里被重写一遍）；
 * ②`{kind,id}` 一支只在同项目落地、坏格子进披露不进注入；③保存面只判定点引用，读不出＝500。
 */

const POOL = ['skills/deploy.md', 'skills/review.md'];

/** 一台 dataDir：demo 项目登记「部署技能」＋「评审清单（只在 review 仓生效）」，another 项目各登记一篇同名 */
function seeded(): { dataDir: string; entries: RegistryEntry[] } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-equip-'));
  const reg = new RegistryStore(dataDir);
  const add = (raw: Record<string, unknown>): void => {
    const r = reg.add(raw);
    if (!r.ok) throw new Error(`fixture 登记失败：${r.why}`);
  };
  add({ kind: 'skill', name: 'deploy', spec: { space: 'demo', file: 'skills/deploy.md' } });
  add({ kind: 'skill', name: 'review', spec: { space: 'demo', file: 'skills/review.md' } });
  // 跨项目同名：`spec.file` 是引用写法之一，两枚条目会同名撞车——落地必须只认本单那枚
  add({ kind: 'skill', name: 'deploy-other', spec: { space: 'other', file: 'skills/deploy.md' } });
  add({ kind: 'rule', name: 'review-checklist', spec: { space: 'demo', file: 'docs/review.md', repo: 'review' } });
  return { dataDir, entries: reg.readView().entries };
}

const ctx = (entries: readonly RegistryEntry[], over: Partial<Parameters<typeof resolveEquipSlots>[1]> = {}) => ({
  spaceId: 'demo',
  skillPool: POOL,
  entries,
  ...over,
});

describe('注入面：{kind,id} 定点引用', () => {
  it('整枚 id 命中：注的是条目 spec.file，装备账里落的是路径不是引用', () => {
    const { entries } = seeded();
    const got = resolveEquipSlots({ skills: [{ kind: 'skill', id: 'skill:deploy' }] }, ctx(entries));
    expect(got.skills).toEqual(['skills/deploy.md']);
    expect(got.unknownSkills).toEqual([]);
  });

  it('slug 与 spec.file 两种写法都认（与 R2 引用账同一把尺，不在这里另立形状）', () => {
    const { entries } = seeded();
    for (const id of ['deploy', 'skills/deploy.md']) {
      expect(resolveEquipSlots({ skills: [{ kind: 'skill', id }] }, ctx(entries)).skills).toEqual(['skills/deploy.md']);
    }
  });

  it('同项目才算落地：两枚同名条目里只取本单那枚，挂在别的项目的那枚进披露', () => {
    const { entries } = seeded();
    const mine = resolveEquipSlots({ skills: [{ kind: 'skill', id: 'skill:deploy' }] }, ctx(entries, { spaceId: 'demo' }));
    expect(mine.skills).toEqual(['skills/deploy.md']);
    // 引用指向另一项目的条目：相对路径按本单主仓根读就是跨根读——不注，说清为什么
    const other = resolveEquipSlots({ skills: [{ kind: 'skill', id: 'skill:deploy-other' }] }, ctx(entries));
    expect(other.skills).toEqual([]);
    expect(other.unknownSkills).toHaveLength(1);
    expect(other.unknownSkills[0]!.label).toBe('skill:deploy-other');
    expect(other.unknownSkills[0]!.why).toContain('不属于本单所在项目');
    expect(other.unknownSkills[0]!.why).toContain('other');
  });

  it('enabled:false 的条目不凑装备（留着但不再被选≠可用）；解析不到的 id 进披露不进注入', () => {
    const seededDir = seeded();
    const reg = new RegistryStore(seededDir.dataDir);
    const off = reg.update('skill:review', { enabled: false });
    if (!off.ok) throw new Error(off.why);
    const entries = reg.readView().entries;
    const got = resolveEquipSlots(
      { skills: [{ kind: 'skill', id: 'skill:review' }, { kind: 'skill', id: 'skill:ghost' }] },
      ctx(entries),
    );
    expect(got.skills).toEqual([]);
    expect(got.unknownSkills.map((m) => m.label)).toEqual(['skill:review', 'skill:ghost']);
    expect(got.unknownSkills[0]!.why).toContain('解析不到可用');
    expect(got.unknownSkills[1]!.why).toContain('解析不到可用');
  });

  it('rule 引用带条目声明的作用域进候选，收窄归 matchRules 那一把尺（这里不重算 glob）', () => {
    const { entries } = seeded();
    const got = resolveEquipSlots({ rules: [{ kind: 'rule', id: 'rule:review-checklist' }] }, ctx(entries));
    expect(got.rules).toEqual([{ file: 'docs/review.md', repo: 'review' }]);
    // 仓外的节点目录：matchRules 把它筛掉——引用不越作用域，也不是注入现场替条目放宽标准
    const inside = matchRules(got.rules, '/root', '/root/review/src');
    const outside = matchRules(got.rules, '/root', '/root/other');
    expect(inside.map((r) => r.file)).toEqual(['docs/review.md']);
    expect(outside).toEqual([]);
  });

  it('格子与轴对不上：{kind:rule} 塞技能格只披露（照 kind 去解=技能槽吃进约定文档）', () => {
    const { entries } = seeded();
    const got = resolveEquipSlots({ skills: [{ kind: 'rule', id: 'rule:review-checklist' }] }, ctx(entries));
    expect(got.skills).toEqual([]);
    expect(got.unknownSkills[0]!.why).toContain("这一格只认 {kind:'skill'}");
  });

  it('脏形状 fail-closed 到披露面：未知键、空 id、数组都各有那句为什么', () => {
    const { entries } = seeded();
    const got = resolveEquipSlots(
      { skills: [{ kind: 'skill', filed: 'x' }, { kind: 'skill', id: '  ' }, ['skills/deploy.md'], 42] },
      ctx(entries),
    );
    expect(got.skills).toEqual([]);
    const whys = got.unknownSkills.map((m) => m.why);
    expect(whys[0]).toContain('含未知键');
    expect(whys[1]).toContain('缺 id');
    expect(whys[2]).toContain('既不是非空字符串');
    expect(whys[3]).toContain('既不是非空字符串');
    // 披露的 label 是**槽原文**的可读形（`[object Object]` 那种回显没法拿去对账）
    expect(got.unknownSkills[0]!.label).toContain('filed');
  });
});

describe('注入面：裸相对路径与 v13-W1 同源', () => {
  it('逐格比对 resolveSkillRefs 的结果（池子尺没被重写第二遍）', () => {
    const { entries } = seeded();
    for (const refs of [
      ['skills/deploy.md'],
      ['skills/deploy.md', 'ghost.md', 'skills/review.md'],
      ['', 'skills/../x.md', 'skills/review.md'],
      ['skills/review.md', 'skills/deploy.md'],
    ]) {
      const legacy = resolveSkillRefs(POOL, refs);
      const got = resolveEquipSlots({ skills: refs }, ctx(entries));
      expect(got.skills).toEqual(legacy.files);
      expect(got.unknownSkills.map((m) => m.label)).toEqual(legacy.unknown);
    }
  });

  it('两写法混挂按声明顺序落账（顺序是 roleSha 的取材，重排=改指纹）', () => {
    const { entries } = seeded();
    const got = resolveEquipSlots(
      { skills: ['skills/review.md', { kind: 'skill', id: 'skill:deploy' }, 'skills/review.md'] },
      ctx(entries),
    );
    expect(got.skills).toEqual(['skills/review.md', 'skills/deploy.md']);
  });

  it('空间轴已注过的文档不注第二遍（岗位引用同一篇=去重，与 v13-W1 同一条优先级）', () => {
    const { entries } = seeded();
    const got = resolveEquipSlots({ skills: [{ kind: 'skill', id: 'skill:deploy' }] }, ctx(entries, { alreadyCovered: new Set(['skills/deploy.md']) }));
    expect(got.skills).toEqual([]);
    expect(got.unknownSkills).toEqual([]); // 去重不是「没落地」：这篇已经注过了，不该起 ⚠
  });

  it('裸路径的岗位文档：脏的自此进 unknownRules 披露（从前静默跳过=一条通道都没有）', () => {
    const { entries } = seeded();
    const got = resolveEquipSlots({ rules: ['docs/a.md', '', '../up.md'] }, ctx(entries));
    expect(got.rules).toEqual([{ file: 'docs/a.md' }]);
    expect(got.unknownRules.map((m) => m.label)).toEqual(['（空串）', '../up.md']);
  });
});

describe('保存面：guardEquipRefs', () => {
  it('定点引用解析不到＝400，拒句点名岗与那一格的键路径', () => {
    const { entries } = seeded();
    const gate = guardEquipRefs(entries, [
      { id: 'r-arm', skills: [{ kind: 'skill', id: 'skill:ghost' }] },
      { id: 'r-ok', rules: [{ kind: 'rule', id: 'rule:review-checklist' }] },
    ]);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe(400);
      expect(gate.error).toContain('岗「r-arm」的 skills[0]');
      expect(gate.error).toContain('skill:ghost');
      expect(gate.error).toContain('先在「注册中心」登记');
      // 好的那一格不进拒句：把两格一起点名，人就分不清该改哪儿
      expect(gate.error).not.toContain('r-ok');
    }
  });

  it('裸串不判（池子语义今天就不判死活）——一并拒等于替存量名册改判据', () => {
    const { entries } = seeded();
    expect(guardEquipRefs(entries, [{ id: 'r-old', skills: ['ghost.md'], rules: ['docs/never-registered.md'] }])).toEqual({ ok: true });
  });

  it('解析得到就放行；脏形状归形状闸（PUT 那一步已经 400），这里不重复拦', () => {
    const { entries } = seeded();
    expect(guardEquipRefs(entries, [{ id: 'r-arm', skills: [{ kind: 'skill', id: 'skills/deploy.md' }] }])).toEqual({ ok: true });
    expect(guardEquipRefs(entries, [{ id: 'r-dirty', skills: [{ kind: 'skill', filed: 'x' }] }])).toEqual({ ok: true });
  });

  it('注册表空表＝解析不到（读不出由调用方给 500，不在这里冒充「没有悬挂」）', () => {
    const gate = guardEquipRefs([], [{ id: 'r-arm', skills: [{ kind: 'skill', id: 'skill:deploy' }] }]);
    expect(gate.ok).toBe(false);
  });
});
