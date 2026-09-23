/**
 * 内置模板的中文显示名（B2）。
 *
 * 为什么放在前端而不是模板 metadata：`seedBuiltinTemplates` 是**幂等**的
 * （`get(name) === null` 才写入），给已有安装补 `metadata.title` 不会生效。
 * 内置模板是一组固定集合，用一张表最省事，且对老数据立即生效。
 * 用户自建模板仍然显示用户自己起的名字。
 */

export interface TemplateLabel {
  /** 中文标题 */
  title: string;
  /** 一句用途 */
  use: string;
}

const BUILTIN: Record<string, TemplateLabel> = {
  'builtin-generic-issue-delivery': {
    title: '通用交付骨架',
    use: '对齐需求 → 拆解 → 并行实现 → 汇总 → 逐条验收 → 归档',
  },
  'builtin-issue-triage': {
    title: 'Issue 受理分诊',
    use: '探索现状 → 建规范 Issue → 路由到交付流程',
  },
  'builtin-parallel-module-dev': {
    title: '模块并行开发',
    use: '接口 / 前端 / 测试 / 文档四路并行，统一汇总',
  },
  'builtin-standard-dev-flow': {
    title: '标准开发流水线',
    use: '初始化 → 编码 → 自测修复 → 文档归档',
  },
  'builtin-risk-approval-flow': {
    title: '高危操作审批',
    use: '依赖升级 / 破坏性重构默认阻塞，人工放行',
  },
  'builtin-bug-fix-pipeline': {
    title: 'Bug 修复流水线',
    use: '复现 → 溯源分析 → 修复编码 → 回归验证',
  },
  'builtin-role-team-review': {
    title: '团队分工评审',
    use: '开发 → 评审 → 测试 → 归档，多角色协作',
  },
  'builtin-research-compare': {
    title: '双路方案调研',
    use: '两路并行调研 → 汇总对比给出推荐',
  },
};

export function isBuiltinTemplate(name: string): boolean {
  return name.startsWith('builtin-');
}

export function templateLabel(name: string, description?: string): TemplateLabel {
  const hit = BUILTIN[name];
  if (hit) return hit;
  return {
    title: name.replace(/^builtin-/, '').replace(/-/g, ' '),
    use: description?.trim() || '',
  };
}
