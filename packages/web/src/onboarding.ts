/** v9-N4 三步新手路径：首屏只讲这三步，其余全是高级项（默认折叠）。快照测试锁结构。 */
export const ONBOARDING_STEPS = [
  { no: 1, title: '① 说一句', hint: '用大白话写你要干什么；写不利索就点 ✨，AI 替你补成完整需求单' },
  { no: 2, title: '② 确认', hint: '先给你看这单的「验收标准」和步骤计划，你点头才算数' },
  { no: 3, title: '③ 开跑', hint: '确认后自动执行；进度、花费、产出随时能看，不打扰你' },
] as const;

/** 折叠进「高级选项」的字段——首屏不出现 */
export const ADVANCED_FIELDS = ['工作目录', '关联 Issue', '执行前先确认编排'] as const;
