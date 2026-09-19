import type { CheckSpec, DagGraph } from '@paneflow/shared';

export interface DispatchOptions {
  task: string;
  issueId?: string;
  cwd: string;
  /** 当前空间的模板清单（Planner 从中选择；受理流水线自身会被排除） */
  templateList: { name: string; description?: string }[];
  /** 空间主仓根（给 Planner 的上下文） */
  rootCwd?: string;
  /**
   * 编排预告（A3）：Planner 选完骨架后停在人工门禁上，等用户确认再执行。
   * 开启时 planner 节点的 onFail 会切成 abort —— 用户「取消」= 拒绝门禁，
   * 该节点失败并终止整条下发；否则仅靠 onFail=continue 会照常路由下去。
   */
  preview?: boolean;
  /** E'：Planner 节点用的 agent 类型（空间档案 defaultAgentKind）；空值回落 DISPATCH_AGENT_KIND */
  plannerAgentKind?: string;
  /** G1：已拉取的 Issue 真身（正文/评论），注入 Planner 上下文——贴链接零手抄 */
  issueContext?: IssueView;
  /** M1：服务端机检出的「验收标准」条目（非空=契约已在手，不设接单门） */
  contractAssertions?: string[];
}

/** G1：Issue 读取器的出参形状（http 路由与下发注入共用） */
export interface IssueView {
  number: number;
  repo: string;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  comments: { author: string; body: string }[];
}

/**
 * G1：从自由文本识别 issue 引用——完整 GitHub URL（带 repo）或独立的 #123。
 * 光秃秃的数字不算引用（「修复 308 个 bug」不是 issue 308）。
 */
export function parseIssueRef(text: string): { number: number; repo?: string } | null {
  const url = text.match(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/i);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const hash = text.match(/(?:^|\s)#(\d{1,7})(?=$|\s)/);
  if (hash) return { number: Number(hash[1]) };
  return null;
}

/** 防模板引擎注入：issue 正文里的 {{ }} 会污染提示词渲染 */
function debraces(s: string): string {
  return s.replace(/\{\{|\}\}/g, '');
}

/**
 * M1·DoR 机检：从自由文本（任务描述/Issue 正文）提取「验收标准」小节的条目。
 * 锚点与 M4 回写的 ISSUE_TEMPLATE 同源；条目 = 小节内的列表/编号行，遇到
 * 下一小节标题或段落正文即止。返回剥掉 {{ }} 的断言文本数组（可为空）。
 */
export function extractAcceptance(text: string): string[] {
  const m = text.match(/^#{1,6}[ \t]*(验收标准|验收条件|Acceptance Criteria)[ \t]*$/im);
  if (!m || m.index === undefined) return [];
  const out: string[] = [];
  for (const line of text.slice(m.index + m[0].length).split('\n')) {
    if (/^#{1,6}\s/.test(line)) break;
    const item = line.match(/^\s*(?:[-*]|\d+[.、)])\s+(.+?)\s*$/);
    if (item) {
      out.push(debraces(item[1]!));
      continue;
    }
    // 列表已开始后遇到非列表非空行 = 小节结束了（下一段正文）
    if (out.length && line.trim() !== '') break;
  }
  return out.filter((s) => s !== '');
}

const MAX_TASK_LEN = 4000;

/** Planner agent 缺省类型（E' 后可被空间档案 defaultAgentKind 覆盖） */
export const DISPATCH_AGENT_KIND = 'claude';

/**
 * 智能下发：把一句任务描述变成一个三节点临时编排
 *   [Planner 路由决策] → [pipeline 路由执行] → 结束
 * Planner 产出 extra.suggestedTemplate（命中模板）或直接落到
 * builtin-generic-issue-delivery 兜底骨架（task 作为参数传入，动态扇出展开）。
 * 拓扑恒为策展骨架——AI 只选编排与填参（确定性红线 D3）。
 */
export function buildDispatchGraph(opts: DispatchOptions): DagGraph {
  // 防模板引擎注入：剥掉 {{ }} 并限长
  const task = opts.task.replace(/\{\{|\}\}/g, '').trim().slice(0, MAX_TASK_LEN);
  const tplList = opts.templateList
    .map((t) => `- ${t.name}${t.description ? ` —— ${t.description}` : ''}`)
    .join('\n');

  const issueBlock = opts.issueContext
    ? [
        '',
        `关联 Issue #${opts.issueContext.number}（${opts.issueContext.repo}，${opts.issueContext.state}）——这是需求的真身，以它为准：`,
        `标题：${debraces(opts.issueContext.title)}`,
        `正文：\n${debraces(opts.issueContext.body).slice(0, 8000) || '（空）'}`,
        ...(opts.issueContext.comments.length
          ? [`讨论补充（评论 ${opts.issueContext.comments.length} 条）：`, ...opts.issueContext.comments.slice(-5).map((c) => `- ${c.author}：${debraces(c.body).slice(0, 1500)}`)]
          : []),
        '',
      ].join('\n')
    : '';

  // M1 接单门：机检有「验收标准」→ 直接当契约注入（不设门）；无 → Planner 先立约 + 契约确认门
  const inputContract = (opts.contractAssertions ?? []).map((s) => s.trim()).filter(Boolean);
  const hasInputContract = inputContract.length > 0;
  const contractBlock = hasInputContract
    ? [
        '',
        `输入已含可机检的验收标准 ${inputContract.length} 条——这就是本单契约，执行方将逐条核对：`,
        ...inputContract.map((a, i) => `- AC-${i + 1}: ${a}`),
        'extra.contract.assertions 原样透传以上条目（id 用 AC-N，assertion 用原文，verify_method 写你建议的核对方式）；extra.contract.questions 无疑问可留空。',
      ].join('\n')
    : [
        '',
        '输入未见可机检的「验收标准」小节——按 DoR 先立约再派工：',
        'extra.contract = { assertions: [{id:"AC-1", assertion:"一句可判真假的验收断言", verify_method:"如何核对"}, …（至少 2 条）], questions: ["必须向需求方澄清的问题", …] }。',
        '运行会停在契约接单门等你方与人工对齐：断言要具体到能被机器或人工逐条核验，提问直击模糊点。',
      ].join('\n');
  const checks: CheckSpec[] = [];
  if (!hasInputContract) checks.push({ type: 'contract' });
  if (opts.preview) {
    checks.push({
      type: 'manual',
      prompt: '编排预告：确认步骤计划后放行执行；拒绝则终止本次下发。',
    });
  }

  const plannerPrompt = [
    '你是 PaneFlow 的任务下发规划员。用户任务描述：',
    `"""${task}"""`,
    issueBlock,
    contractBlock,
    '当前空间可用的交付模板（ID — 说明）：',
    tplList || '（无）',
    opts.rootCwd ? `空间主仓根：${opts.rootCwd}` : '',
    '',
    '请决策并把结论写入结果文件 .herdr/artifacts/planner.json 的 extra 字段：',
    `1. extra.taskBrief：用一两句话向执行 Agent 清晰重述这个任务（必填；${opts.issueContext ? '必须包含 Issue 正文中的验收要点，执行 Agent 看不到 Issue 全文' : '禁止照抄原始描述'}）`,
    `2. extra.suggestedTemplate：若任务与某个模板高度匹配写其精确 ID；否则写 builtin-generic-issue-delivery（通用交付骨架，会把任务拆解为并行子任务执行）`,
    opts.issueId ? `3. extra.issue_id：${opts.issueId}` : '',
    '4. aligned：写 true（决策完成）',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    version: 1,
    name: `dispatch-${Date.now().toString(36)}`,
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      {
        id: 'planner',
        type: 'agent',
        label: 'Planner · 下发规划',
        config: {
          agentKind: opts.plannerAgentKind || DISPATCH_AGENT_KIND,
          prompt: plannerPrompt,
          clarify: { maxRounds: 2 },
          retryCount: 1,
          onFail: opts.preview ? 'abort' : 'continue', // 非预告模式：planner 失败时 route 的兜底模板仍会执行
          ...(checks.length ? { checks } : {}),
        },
      },
      {
        id: 'route',
        type: 'pipeline',
        label: '路由执行',
        config: {
          pipeline: {
            template: '{{planner.artifact.extra.suggestedTemplate}}',
            fallbackTemplate: 'builtin-generic-issue-delivery',
            params: { task, ...(opts.issueId ? { issue_id: opts.issueId } : {}), cwd: opts.cwd },
            mode: 'wait',
          },
        },
      },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'd1', source: 'start', target: 'planner' },
      { id: 'd2', source: 'planner', target: 'route' },
      { id: 'd3', source: 'route', target: 'end' },
    ],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      description: `智能下发：${task.slice(0, 80)}`,
    },
  };
}
