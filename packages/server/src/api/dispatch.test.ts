import { describe, expect, it } from 'vitest';
import {
  buildDispatchGraph,
  candidateRepos,
  DISPATCH_NO_AGENT_ERROR,
  DispatchAgentKindError,
  extractAcceptance,
  intakeTemplateMarkdown,
  parseGithubRemote,
  parseIssueRef,
  type IssueView,
} from './dispatch.js';
import { BUILTIN_TEMPLATES } from '../orchestrate/builtin-templates.js';
import { applyVariables, validateDag } from '@paneflow/shared';

// v13-E2 fail-closed：buildDispatchGraph 不再回落缺省 claude——所有测试统一显式给 Planner kind
const KIND = { plannerAgentKind: 'pi' };

describe('buildDispatchGraph', () => {
  const templateList = [
    { name: 'builtin-bug-fix-pipeline', description: '修复型' },
    { name: 'builtin-generic-issue-delivery', description: '交付型兜底' },
  ];

  it('generates a valid 3-node orchestration embedding the task', () => {
    const g = buildDispatchGraph({ task: '探索项目成熟度并建 Issue', cwd: '/tmp/x', templateList, ...KIND });
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
    const g = buildDispatchGraph({ task: '做 {{evil}} 事', cwd: '/tmp/x', templateList, ...KIND });
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.prompt).not.toContain('{{evil}}');
    expect(planner.config.prompt).toContain('evil');
  });

  it('caps oversized task input', () => {
    const g = buildDispatchGraph({ task: 'x'.repeat(9999), cwd: '/tmp/x', templateList, ...KIND });
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.prompt!.length).toBeLessThan(6000);
  });

  it('task survives variable pass-through to the route params', () => {
    const g = buildDispatchGraph({ task: 'demo 任务', issueId: '9', cwd: '/tmp/x', templateList, ...KIND });
    // 下发 run 启动时 applyVariables(graph, {task}) 不破坏结构
    const { graph: applied } = applyVariables(g, { task: 'demo 任务' });
    expect(applied.nodes.length).toBe(g.nodes.length);
    expect(validateDag(applied).filter((i) => i.level === 'error')).toEqual([]);
  });

  it("E'：planner agent 取显式指定；v13-E2 起空值 fail-closed，不再兜底缺省 claude", () => {
    const g = buildDispatchGraph({ task: 't', cwd: '/tmp/x', templateList, plannerAgentKind: 'codex' });
    expect(g.nodes.find((n) => n.id === 'planner')!.config.agentKind).toBe('codex');
    // 改判 v6「兜底 claude」裁决（gate0 实测 claude 开箱即挂→猜了必红）：
    // 未给 kind / 空串 / 全空白一律拒绝起单，且报错带指路文案
    expect(() => buildDispatchGraph({ task: 't', cwd: '/tmp/x', templateList, plannerAgentKind: '' })).toThrowError(
      DISPATCH_NO_AGENT_ERROR,
    );
    expect(() => buildDispatchGraph({ task: 't', cwd: '/tmp/x', templateList })).toThrow(DispatchAgentKindError);
    try {
      buildDispatchGraph({ task: 't', cwd: '/tmp/x', templateList, plannerAgentKind: '   ' });
      expect.unreachable('全空白也应 fail-closed');
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchAgentKindError);
      expect((err as DispatchAgentKindError).statusCode).toBe(400);
      expect((err as Error).message).toContain('不再猜测回落');
      expect((err as Error).message).toContain('/api/health');
    }
  });

  it('route params keys are declared variables of the fallback template (G: 静默丢弃防线)', () => {
    // applyVariables 只替换模板已声明的变量——params 传了未声明的键会被静默丢掉
    const g = buildDispatchGraph({ task: 't', issueId: '9', cwd: '/tmp/x', templateList, ...KIND });
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
    const g = buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, issueContext: issue, issueId: '308', ...KIND });
    const prompt = g.nodes.find((n) => n.id === 'planner')!.config.prompt!;
    expect(prompt).toContain('关联 Issue #308（acme/app，open）');
    expect(prompt).toContain('台账汇总性能优化');
    expect(prompt).toContain('先测 10 万行');
    expect(prompt).toContain('注意内存上限');
    expect(prompt).toContain('必须包含 Issue 正文中的验收要点');
  });

  it('issue 正文里的 {{ }} 被剥掉（防模板注入）', () => {
    const g = buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, issueContext: issue, ...KIND });
    const prompt = g.nodes.find((n) => n.id === 'planner')!.config.prompt!;
    expect(prompt).not.toContain('{{evil}}');
    expect(prompt).toContain('evil');
  });

  it('无 issueContext 时保持原语式（禁止照抄原始描述）', () => {
    const g = buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, ...KIND });
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

  it('M4 勾选框格式（- [ ] / - [x]）只取断言本体', () => {
    const text = '## 验收标准\n- [ ] AC-1：页面响应 <1s\n- [x] 已完成项也收\n';
    expect(extractAcceptance(text)).toEqual(['AC-1：页面响应 <1s', '已完成项也收']);
  });

  it('M4 同源咬合：回写的接单模板自身能过机检', () => {
    expect(extractAcceptance(intakeTemplateMarkdown())).toEqual(['AC-1：', 'AC-2：']);
  });
});

describe('v8-M1 契约门装配（buildDispatchGraph）', () => {
  const templateList = [{ name: 't1' }];
  const planner = (opts: Partial<import('./dispatch.js').DispatchOptions>) =>
    buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, ...KIND, ...opts }).nodes.find((n) => n.id === 'planner')!;

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

  // N2 三级序列的第三形态：AI 补出的草案契约——注入 AC 但门保留（需人确认）
  it('autofilled 契约（contractGate）→ prompt 标「AI 起草」且 contract 门保留', () => {
    const p = planner({ contractAssertions: ['导出 10 万行不超时'], contractGate: true });
    expect(p.config.prompt).toContain('AI 依需求起草的契约草案 1 条');
    expect(p.config.prompt).toContain('- AC-1: 导出 10 万行不超时');
    expect(p.config.checks).toEqual([{ type: 'contract' }]);
  });

  it('autofilled + preview → contract 门在前、manual 门在后', () => {
    const p = planner({ preview: true, contractAssertions: ['一条'], contractGate: true });
    expect((p.config.checks ?? []).map((c) => c.type)).toEqual(['contract', 'manual']);
  });
});

describe('v8-M6 契约骨架模板装配（buildDispatchGraph）', () => {
  const templateList = [{ name: 't1' }];
  const tpl = { stamp: 'bugfix@1a2b3c4d', block: '本单命中契约骨架模板「bugfix@1a2b3c4d」（缺陷修复）——照抄骨架再填差异' };
  const planner = (opts: Partial<import('./dispatch.js').DispatchOptions>) =>
    buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, ...KIND, ...opts }).nodes.find((n) => n.id === 'planner')!;

  it('gate 模式 + 命中模板 → 骨架块注入立约指令且 contract 门带 id@sha 戳', () => {
    const p = planner({ contractTemplate: tpl });
    expect(p.config.prompt).toContain('本单命中契约骨架模板「bugfix@1a2b3c4d」');
    expect(p.config.prompt).toContain('先立约再派工');
    expect(p.config.checks).toEqual([{ type: 'contract', template: 'bugfix@1a2b3c4d' }]);
  });

  it('extracted 模式优先：有输入契约时模板不注入（机检 AC 就是契约，不需要骨架）', () => {
    const p = planner({ contractAssertions: ['3 秒内出结果'], contractTemplate: tpl });
    expect(p.config.prompt).not.toContain('契约骨架模板');
    expect((p.config.checks ?? []).some((c) => c.type === 'contract')).toBe(false);
  });
});

describe('v9-B2 编排绑班底（buildDispatchGraph）', () => {
  const templateList = [{ name: 't1' }];
  const team = [
    { roleId: 'std-implementer', name: '实现' },
    { roleId: 'std-planner', name: '规划', alias: '阿规' },
    { roleId: 'std-curator', name: '沉淀' },
  ];
  const build = (opts: Partial<import('./dispatch.js').DispatchOptions> = {}) =>
    buildDispatchGraph({ task: '优化导出', cwd: '/tmp/x', templateList, ...KIND, ...opts });

  it('带班底下发：planner 节点 role ∈ team，且优先取「规划」位', () => {
    const g = build({ team });
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(team.map((t) => t.roleId)).toContain(planner.config.role);
    expect(planner.config.role).toBe('std-planner');
  });

  it('没有规划位时回落名册第一位', () => {
    const g = build({ team: team.filter((t) => t.roleId !== 'std-planner') });
    expect(g.nodes.find((n) => n.id === 'planner')!.config.role).toBe('std-implementer');
  });

  it('planner prompt 点名册：人数/别名/roleId 可见，且禁止虚构名册外人', () => {
    const p = build({ team }).nodes.find((n) => n.id === 'planner')!.config.prompt!;
    expect(p).toContain('本空间班底名册（执行人员仅此 3 位');
    expect(p).toContain('- 阿规（roleId: std-planner）');
    expect(p).toContain('不要虚构名册外的');
  });

  it('空班底=回退旧行为：不绑 role，编排预告里明说未配班底', () => {
    const g = build({ team: [], preview: true });
    const planner = g.nodes.find((n) => n.id === 'planner')!;
    expect(planner.config.role).toBeUndefined();
    expect(planner.config.prompt).not.toContain('班底名册');
    const manual = (planner.config.checks ?? []).find((c) => c.type === 'manual');
    expect(manual?.prompt).toContain('未配班底');
  });

  it('有班底时编排预告写「班底 N 人成军」', () => {
    const g = build({ team, preview: true });
    const manual = (g.nodes.find((n) => n.id === 'planner')!.config.checks ?? []).find((c) => c.type === 'manual');
    expect(manual?.prompt).toContain('班底 3 人成军：实现、阿规、沉淀');
  });
});

describe('v8-I1 技能索引进 Planner + repos 候选仓解析', () => {
  const templateList = [{ name: 't1' }];
  const plannerPrompt = (opts: Partial<import('./dispatch.js').DispatchOptions>) =>
    buildDispatchGraph({ task: '优化', cwd: '/tmp/x', templateList, ...KIND, ...opts }).nodes.find((n) => n.id === 'planner')!.config.prompt!;

  it('skillIndex 非空 → 索引一行一项并给出 skill:<name> 引用写法', () => {
    const p = plannerPrompt({
      skillIndex: [
        { name: 'deploy', description: '灰度发布做法' },
        { name: 'triage' },
      ],
    });
    expect(p).toContain('本空间技能库 2 项');
    expect(p).toContain('- deploy —— 灰度发布做法');
    expect(p).toContain('- triage');
    expect(p).toContain('引用写法 skill:<name>');
  });

  it('无技能 → 不出现技能库字样', () => {
    expect(plannerPrompt({})).not.toContain('技能库');
    expect(plannerPrompt({ skillIndex: [] })).not.toContain('技能库');
  });

  it('parseGithubRemote：scp 式 / ssh:// / https:// 都认，非 GitHub 不认', () => {
    expect(parseGithubRemote('git@github.com:acme/app.git')).toBe('acme/app');
    expect(parseGithubRemote('ssh://git@github.com/acme/app')).toBe('acme/app');
    expect(parseGithubRemote('https://github.com/acme/app.git')).toBe('acme/app');
    expect(parseGithubRemote('https://github.com/acme/app/')).toBe('acme/app');
    expect(parseGithubRemote('https://gitea.example.com/a/b.git')).toBeNull();
    expect(parseGithubRemote('git@gitlab.com:x/y.git')).toBeNull();
    expect(parseGithubRemote('')).toBeNull();
  });

  it('candidateRepos：按登记顺序解析 origin、去重、读不到如实跳过', () => {
    const remotes: Record<string, string | null> = {
      '/root/alpha': 'git@github.com:o/alpha.git',
      '/root/beta': 'https://github.com/o/alpha.git', // 同 owner/repo 去重
      '/root/gamma': null, // 无 origin / 非 git 目录
      '/root/delta': 'git@notgithub.com:x/y.git',
    };
    const readRemote = (dir: string) => remotes[dir] ?? null;
    expect(candidateRepos(['alpha', 'beta', 'gamma', '../evil', 'delta'], '/root', readRemote)).toEqual(['o/alpha']);
    expect(candidateRepos(undefined, '/root', readRemote)).toEqual([]);
    expect(candidateRepos(['alpha'], undefined, readRemote)).toEqual([]);
  });
});
