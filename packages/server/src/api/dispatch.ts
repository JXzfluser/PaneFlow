import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  /**
   * N2：AI 自动补出来的契约——断言直接注入 Planner（同 M1 extracted 链路），
   * 但契约确认门保留：AI 起草的措辞需要人过目才派下游。
   */
  contractGate?: boolean;
  /** M6：命中的契约骨架模板（stamp=id@sha 留痕；block=注入 Planner 的实例化指令） */
  contractTemplate?: { stamp: string; block: string };
  /** I1：空间技能索引（名字+首行描述）——注入 Planner 上下文，契约/方案可引用 skill:<name> */
  skillIndex?: { name: string; description?: string }[];
  /**
   * v9-B2 空间班底（调用方已对着全局角色库解析好 name；悬空 roleId 应在调用处滤掉）：
   * 非空 → Planner 节点绑名册中的规划角色、prompt 点名册（拆步只从班底点人）；
   * 空 → 回退旧行为，且在编排预告里明说「未配班底」。
   */
  team?: { roleId: string; name: string; alias?: string }[];
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

/**
 * I1：从 git remote URL 认出 owner/repo——支持 scp 式 git@、ssh://、https:// 三种写法，
 * 结尾 .git 剥掉。认不出返回 null（自建 Gitea 域等一律不算 GitHub 候选）。
 */
export function parseGithubRemote(url: string): string | null {
  const s = url.trim();
  const m =
    s.match(/^(?:[^@/\s]+@)?github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/) ??
    s.match(/^ssh:\/\/(?:[^/\s]*@)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i) ??
    s.match(/^https?:\/\/(?:[^/\s]*@)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return m ? m[1]! : null;
}

/**
 * I1：#123 裸引用且没配默认仓时，按空间 repos 登记顺序从各仓 origin 解析候选 GitHub 仓。
 * readRemote 可注入（默认 `git -C <dir> remote get-url origin`），首个命中即返。
 */
export function candidateRepos(
  repos: string[] | undefined,
  rootCwd: string | undefined,
  readRemote: (repoDir: string) => string | null = defaultGitRemote,
): string[] {
  if (!rootCwd || !repos?.length) return [];
  const out: string[] = [];
  for (const rel of repos) {
    if (!rel || rel.includes('..')) continue;
    const url = readRemote(path.resolve(rootCwd, rel));
    if (!url) continue;
    const owner = parseGithubRemote(url);
    if (owner && !out.includes(owner)) out.push(owner);
  }
  return out;
}

function defaultGitRemote(repoDir: string): string | null {
  try {
    return execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch {
    return null;
  }
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
      // M4：模板用 DoR 勾选框（- [ ]），机检只认勾选框后的断言本体
      out.push(debraces(item[1]!.replace(/^\[[ xX]\]\s*/, '')));
      continue;
    }
    // 列表已开始后遇到非列表非空行 = 小节结束了（下一段正文）
    if (out.length && line.trim() !== '') break;
  }
  return out.filter((s) => s !== '');
}

/** M4：接单模板回写路径（GitHub Issue 表单模板目录，新建 Issue 时可选） */
export const INTAKE_TEMPLATE_PATH = '.github/ISSUE_TEMPLATE/paneflow-intake.md';

/**
 * M4·接单模板：回写给目标仓的 ISSUE_TEMPLATE。「验收标准」小节与上面
 * extractAcceptance 的锚点同源（改锚点必改这里，测试互相咬合）——
 * 让烂需求在源头就可检，模板本身就是给人看的 DoR checklist。
 */
export function intakeTemplateMarkdown(): string {
  return [
    '---',
    'name: PaneFlow 接单单（Intake）',
    'about: 写得出可验的「验收标准」才接单——PaneFlow 会按该小节机检立约，源头质量可检就不用回头 clarify。',
    "title: ''",
    "labels: ''",
    '---',
    '',
    '## 要做什么',
    '',
    '一句话说清：谁 / 在哪个仓或模块 / 要达成什么可观察的结果。',
    '',
    '## 验收标准',
    '',
    '逐条写**可验证的结果句**（能判真伪，不写形容词），一条一行；此小节会被 PaneFlow 机检为本单契约并逐条核对：',
    '',
    '- [ ] AC-1：',
    '- [ ] AC-2：',
    '',
    '## 边界（不动哪些）',
    '',
    '- 不改动：',
    '',
    '## 交付',
    '',
    '- 目标仓 / 期望分支：',
    '- 预算上限（可选）：',
    '',
  ].join('\n');
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

  // M1 接单门：机检有「验收标准」→ 直接当契约注入（不设门）；无 → Planner 先立约 + 契约确认门。
  // N2 改版：机检无但 AI 已补出草案（contractGate）→ 草案注入 + 门保留（AI 起草需人过目）。
  const inputContract = (opts.contractAssertions ?? []).map((s) => s.trim()).filter(Boolean);
  const hasInputContract = inputContract.length > 0;
  // M6：无机检契约时优先按骨架模板实例化（选骨架→填差异），替代现场自由发挥
  const tpl = !hasInputContract && opts.contractTemplate ? opts.contractTemplate : undefined;
  const contractBlock = hasInputContract
    ? [
        '',
        opts.contractGate
          ? `输入原本缺「验收标准」——以下为 AI 依需求起草的契约草案 ${inputContract.length} 条，运行会停在契约接单门等人工确认（确认后才派下游）：`
          : `输入已含可机检的验收标准 ${inputContract.length} 条——这就是本单契约，执行方将逐条核对：`,
        ...inputContract.map((a, i) => `- AC-${i + 1}: ${a}`),
        'extra.contract.assertions 原样透传以上条目（id 用 AC-N，assertion 用原文，verify_method 写你建议的核对方式）；extra.contract.questions 无疑问可留空。',
      ].join('\n')
    : [
        '',
        '输入未见可机检的「验收标准」小节——按 DoR 先立约再派工：',
        ...(tpl ? [`${tpl.block}`, ''] : []),
        'extra.contract = { assertions: [{id:"AC-1", assertion:"一句可判真假的验收断言", verify_method:"如何核对"}, …（至少 2 条）], questions: ["必须向需求方澄清的问题", …] }。',
        '运行会停在契约接单门等你方与人工对齐：断言要具体到能被机器或人工逐条核验，提问直击模糊点。',
      ].join('\n');
  // v9-B2 绑班底：planner 节点从名册取「规划」位（取不到就用第一位）；空班底不绑（旧行为）
  const team = opts.team ?? [];
  const plannerRole = team.length
    ? (team.find((m) => /规划|plan/i.test(`${m.alias ?? ''}${m.name}${m.roleId}`)) ?? team[0])!
    : undefined;
  const teamLine = team.length
    ? `班底 ${team.length} 人成军：${team.map((m) => m.alias || m.name).join('、')}（拆步派活只从这份名册点人）`
    : '未配班底：按默认班底执行（不绑角色）——想固定人设去「项目 → 编辑档案 → 班底」一键装填标准五连';
  const checks: CheckSpec[] = [];
  if (!hasInputContract || opts.contractGate) checks.push({ type: 'contract', ...(tpl ? { template: tpl.stamp } : {}) });
  if (opts.preview) {
    checks.push({
      type: 'manual',
      prompt: `编排预告：确认步骤计划后放行执行；拒绝则终止本次下发。（${teamLine}）`,
    });
  }

  // I1：技能索引块——契约/方案可引用技能（skill:<name>），仓库里长出来的复利入口
  const skillBlock = opts.skillIndex?.length
    ? [
        '',
        `本空间技能库 ${opts.skillIndex.length} 项（沉淀过的做法，立约与方案优先复用，引用写法 skill:<name>）：`,
        ...opts.skillIndex.map((s) => `- ${s.name}${s.description ? ` —— ${s.description}` : ''}`),
      ].join('\n')
    : '';

  // B2：班底名册块——规划员拆步派活只能点名册里的人（复用的第一层：人固定，人设随角色库走）
  const teamBlock = team.length
    ? [
        '',
        `本空间班底名册（执行人员仅此 ${team.length} 位，名册之外没有角色可用）：`,
        ...team.map((m) => `- ${m.alias || m.name}（roleId: ${m.roleId}）`),
        '拆解步骤、指定负责人时只用以上名册（写别名即可）；不要虚构名册外的“工程师/测试”人设。',
      ].join('\n')
    : '';

  const plannerPrompt = [
    '你是 PaneFlow 的任务下发规划员。用户任务描述：',
    `"""${task}"""`,
    issueBlock,
    contractBlock,
    '当前空间可用的交付模板（ID — 说明）：',
    tplList || '（无）',
    skillBlock,
    teamBlock,
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
          ...(plannerRole ? { role: plannerRole.roleId } : {}), // B2：planner 由班底里的规划位担当
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
