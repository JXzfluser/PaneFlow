import { describe, expect, it } from 'vitest';
import { ADVANCED_FIELDS, ONBOARDING_STEPS } from './onboarding';

describe('v9-N4 三步新手路径结构（快照锁死）', () => {
  it('恰好三步：说一句 → 确认 → 开跑，各带一句人话提示', () => {
    expect(ONBOARDING_STEPS.map((s) => `${s.no}. ${s.title}`).join('\n')).toMatchInlineSnapshot(`
      "1. ① 说一句
      2. ② 确认
      3. ③ 开跑"
    `);
    expect(ONBOARDING_STEPS.map((s) => s.hint).join('\n')).toMatchInlineSnapshot(`
      "用大白话写你要干什么；写不利索就点 ✨，AI 替你补成完整需求单
      先给你看这单的「验收标准」和步骤计划，你点头才算数
      确认后自动执行；进度、花费、产出随时能看，不打扰你"
    `);
  });

  it('首屏步骤文案无内部术语（Planner/骨架/下发/Agent 一律不许出现）', () => {
    const all = ONBOARDING_STEPS.map((s) => `${s.title}${s.hint}`).join('');
    expect(all).not.toMatch(/Planner|骨架|下发|Agent|编排|契约门|接单门/i);
  });

  it('高级字段折叠清单：工作目录/关联 Issue/确认编排开关', () => {
    expect([...ADVANCED_FIELDS]).toEqual(['工作目录', '关联 Issue', '执行前先确认编排']);
  });
});
