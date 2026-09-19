import { describe, expect, it } from 'vitest';
import { buildDispatchGraph, DISPATCH_AGENT_KIND, extractAcceptance, parseIssueRef, type IssueView } from './dispatch.js';
import { BUILTIN_TEMPLATES } from '../orchestrate/builtin-templates.js';
import { applyVariables, validateDag } from '@paneflow/shared';

describe('buildDispatchGraph', () => {
  const templateList = [
    { name: 'builtin-bug-fix-pipeline', description: '修复型' },
    { name: 'builtin-generic-issue-delivery', description: '交付型兜底' },
  ];

  it('generates a valid 3-node orchestration embedding the task', () => {
    const g = buildDispatchGraph({ task: '探索项目成熟度并建 Issue', cwd: '/tmp/x', templateList });
    expect(validateDag(g).filter((i) => i.level === 'error')).toEqual([]);
    expect(g.nodes.map((n) => n.type)).toEqual(['start', 'agent', 'pipeline', 'end']);
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.prompt).toContain('探索项目成熟度并建 Issue');
    expect(planner.config.prompt).toContain('builtin-generic-issue-delivery');
    // 路由参数携带原始任务（兜底骨架经 variables.task 接收）
    const route = g.nodes.find((n) => n.id === 'route')!;
    expect(route.config.pipeline!.params!.task).toBe('探索项目成熟度并建 Issue');
    expect(route.config.pipeline!.fallbackTemplate).toBe('builtin-generic-issue-delivery');
  });

  it('strips template-injection braces from the task', () => {
    const g = buildDispatchGraph({ task: '做 {{evil}} 事', cwd: '/tmp/x', templateList });
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.prompt).not.toContain('{{evil}}');
    expect(planner.config.prompt).toContain('evil');
  });

  it('caps oversized task input', () => {
    const g = buildDispatchGraph({ task: 'x'.repeat(9999), cwd: '/tmp/x', templateList });
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.prompt!.length).toBeLessThan(6000);
  });

  it('task survives variable pass-through to the route params', () => {
    const g = buildDispatchGraph({ task: 'demo 任务', issueId: '9', cwd: '/tmp/x', templateList });
    // 下发 run 启动时 applyVariables(graph, {task}) 不破坏结构
    const { graph: applied } = applyVariables(g, { task: 'demo 任务' });
    expect(applied.nodes.length).toBe(g.nodes.length);
    expect(validateDag(applied).filter((i) => i.level === 'error')).toEqual([]);
  });

  it("E'：planner agent 取档案默认值，空值回落缺省 claude", () => {
    const g = buildDispatchGraph({ task: 't', cwd: '/tmp/x', templateList, plannerAgentKind: 'codex' });
    expect(g.nodes.find((n) => n.id === 'planner')!.config.agentKind).toBe('codex');
    const g2 = buildDispatchGraph({ task: 't', cwd: '/tmp/x', templateList, plannerAgentKind: '' });
    expect(g2.nodes.find((n) => n.id === 'planner')!.config.agentKind).toBe(DISPATCH_AGENT_KIND);
  });

  it('route params keys are declared variables of the fallback template (G: 静默丢弃防线)', () => {
    // applyVariables 只替换模板已声明的变量——params 传了未声明的键会被静默丢掉
    const g = buildDispatchGraph({ task: 't', issueId: '9', cwd: '/tmp/x', templateList });
    const route = g.nodes.find((n) => n.id === 'route')!;
    const generic = BUILTIN_TEMPLATES.find((t) => t.name === route.config.pipeline!.fallbackTemplate)!;
    const declared = new Set((generic.variables ?? []).map((v) => v.key));
    declared.add('cwd'); // params.cwd 走 startRun 第三参，不是模板变量
    for (const key of Object.keys(route.config.pipeline!.params!)) {
      expect(declared.has(key), `兜底模板未声明参数 ${key}，会被静默丢弃`).toBe(true);
    }
    expect(declared.has('task')).toBe(true);
  });
});

describe('v8-G1 parseIssueRef', () => {
  it('识别完整 GitHub URL（带 repo）', () => {
    const r = parseIssueRef('按 https://github.com/acme/app/issues/308 的要求优化台账汇总');
    expect(r).toEqual({ repo: 'acme/app', number: 308 });
  });

  it('识别独立的 #123（走默认 repo）', () => {
    expect(parseIssueRef('修复 #162 登录页布局')).toEqual({ number: 162 });
    expect(parseIssueRef('#7')).toEqual({ number: 7 });
  });

  it('裸数字不算引用；词内的 #N 也不算', () => {
    expect(parseIssueRef('修复 308 个 bug')).toBeNull();
    expect(parseIssueRef('C#5 语法')).toBeNull();
    expect(parseIssueRef('')).toBeNull();
  });
});

describe('v8-G1 Issue 正文注入 Planner', () => {
  const issue: IssueView = {
    number: 308,
    repo: 'acme/app',
    state: 'open',
    title: '台账汇总性能优化',
    body: '需要逐条验证结果。\n验收：{{evil}} 每条断言有证据',
    url: 'https://github.com/acme/app/issues/308',
    labels: ['perf'],
    comments: [
      { author: 'alice', body: '先测 10 万行' },
      { author: 'bob', body: '注意内存上限' },
    ],
  };
  const templateList = [{ name: 't1', description: 'd' }];

  it('plannerPrompt 含标题/正文/评论，且要求 taskBrief 覆盖验收要点', () => {
    const g = buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, issueContext: issue, issueId: '308' });
    const prompt = g.nodes.find((n) => n.id === 'planner')!.config.prompt!;
    expect(prompt).toContain('关联 Issue #308（acme/app，open）');
    expect(prompt).toContain('台账汇总性能优化');
    expect(prompt).toContain('先测 10 万行');
    expect(prompt).toContain('注意内存上限');
    expect(prompt).toContain('必须包含 Issue 正文中的验收要点');
  });

  it('issue 正文里的 {{ }} 被剥掉（防模板注入）', () => {
    const g = buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, issueContext: issue });
    const prompt = g.nodes.find((n) => n.id === 'planner')!.config.prompt!;
    expect(prompt).not.toContain('{{evil}}');
    expect(prompt).toContain('evil');
  });

  it('无 issueContext 时保持原语式（禁止照抄原始描述）', () => {
    const g = buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList });
    const prompt = g.nodes.find((n) => n.id === 'planner')!.config.prompt!;
    expect(prompt).toContain('禁止照抄原始描述');
    expect(prompt).not.toContain('关联 Issue');
  });
});

describe('v8-M1 extractAcceptance（DoR 机检）', () => {
  it('提取「## 验收标准」小节内的列表与编号条目，止于下一标题', () => {
    const text = [
      '做个报表。',
      '## 验收标准',
      '- 10 万行 3 秒内出结果',
      '* 导出 CSV 可被 Excel 打开',
      '1. 内存峰值不超过 512MB',
      '',
      '## 背景',
      '- 这条不算',
    ].join('\n');
    expect(extractAcceptance(text)).toEqual([
      '10 万行 3 秒内出结果',
      '导出 CSV 可被 Excel 打开',
      '内存峰值不超过 512MB',
    ]);
  });

  it('英文锚点 Acceptance Criteria 亦可；小节内混入正文段落即截断', () => {
    const text = 'x\n### Acceptance Criteria\n- ok1\n说明性文字\n- ok2\n';
    expect(extractAcceptance(text)).toEqual(['ok1']);
  });

  it('无锚点小节 / 锚点后无条目 → 空（触发立约门）', () => {
    expect(extractAcceptance('修复登录页布局')).toEqual([]);
    expect(extractAcceptance('## 验收标准\n（待定）')).toEqual([]);
  });

  it('条目里的 {{ }} 被剥掉（防注入）', () => {
    expect(extractAcceptance('## 验收标准\n- {{evil}} 生效')).toEqual(['evil 生效']);
  });
});

describe('v8-M1 契约门装配（buildDispatchGraph）', () => {
  const templateList = [{ name: 't1' }];
  const planner = (opts: Partial<import('./dispatch.js').DispatchOptions>) =>
    buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, ...opts }).nodes.find((n) => n.id === 'planner')!;

  it('有机检契约 → prompt 逐条列 AC 且【不】设 contract 门', () => {
    const p = planner({ contractAssertions: ['3 秒内出结果', '导出不崩'] });
    expect(p.config.prompt).toContain('这就是本单契约');
    expect(p.config.prompt).toContain('- AC-2: 导出不崩');
    expect((p.config.checks ?? []).some((c) => c.type === 'contract')).toBe(false);
  });

  it('无契约 → 设 contract 门且 prompt 要求先立约', () => {
    const p = planner({ contractAssertions: [] });
    expect(p.config.prompt).toContain('先立约再派工');
    expect(p.config.checks).toEqual([{ type: 'contract' }]);
  });

  it('contract 门排在编排预告 manual 门之前', () => {
    const p = planner({ preview: true });
    expect((p.config.checks ?? []).map((c) => c.type)).toEqual(['contract', 'manual']);
  });

  it('有输入契约 + preview → 只剩 preview 的 manual 门', () => {
    const p = planner({ preview: true, contractAssertions: ['一条'] });
    expect((p.config.checks ?? []).map((c) => c.type)).toEqual(['manual']);
  });
});
