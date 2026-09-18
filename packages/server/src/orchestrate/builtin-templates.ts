import type { DagGraph } from '@paneflow/shared';

/**
 * Built-in scenario templates mirroring the design doc's user scenarios (§10).
 * Seeded idempotently on server boot; users can edit/save/delete them like any
 * template. No saved positions — the canvas auto-layouts hierarchically.
 */

type N = DagGraph['nodes'][number];
type E = DagGraph['edges'][number];

const meta = (description: string): DagGraph['metadata'] => ({
  createdAt: '',
  updatedAt: '',
  description,
});

const start = (): N => ({ id: 'start', type: 'start', label: '开始', config: {} });
const end = (): N => ({ id: 'end', type: 'end', label: '结束', config: {} });
const fanout = (): N => ({ id: 'fork', type: 'fanout', label: '并行展开', config: {} });

function agent(id: string, label: string, prompt: string, extra: N['config'] = {}): N {
  return { id, type: 'agent', label, config: { agentKind: 'claude', prompt, ...extra } };
}

function graph(name: string, description: string, nodes: N[], edges: E[]): DagGraph {
  return { version: 1, name, nodes, edges, metadata: meta(description) };
}

const e = (id: string, source: string, target: string): E => ({ id, source, target });

// ---------------------------------------------------------------------------

/** 场景一：大型项目模块化并行开发（核心高频场景） */
const parallelModuleDev: DagGraph = graph(
  'builtin-parallel-module-dev',
  '大型项目模块化并行开发：接口 / 前端页面 / 测试 / 文档四路 Agent 真实并行，Fan-in 统一汇总（宽容模式：个别分支失败不影响整体）',
  [
    start(),
    fanout(),
    agent(
      'api',
      '接口开发',
      '你负责后端接口模块。在当前工作目录下完成：1) 阅读目录内已有代码与 README（若无可自述假设）；2) 实现一个简洁可运行的 HTTP API 服务（语言自选，附带启动说明）；3) 只创建属于接口模块的文件，不要动其他模块的文件。',
      { cwd: 'modules/api', retryCount: 1, onFail: 'continue' },
    ),
    agent(
      'web',
      '前端页面',
      '你负责前端模块。在当前工作目录下完成一个单页应用（可用纯 HTML/JS 或任意框架 CDN 版），实现 3 个核心页面雏形并本地可打开预览，附 README 说明。只创建属于前端模块的文件。',
      { cwd: 'modules/web', onFail: 'continue' },
    ),
    agent(
      'tests',
      '测试用例',
      '你负责测试模块。在当前工作目录下为「一个待开发的 HTTP API + 前端页面」编写完整的验收测试用例集（接口契约测试 + 页面交互测试框架脚本），先写测试后无实现也能跑通空跑模式。只创建属于测试模块的文件。',
      { cwd: 'modules/tests', onFail: 'continue' },
    ),
    agent(
      'docs',
      '项目文档',
      '你负责文档模块。在当前工作目录下产出：README.md（项目简介/目录结构/快速开始）与 docs/architecture.md（模块划分与接口约定草案）。只创建属于文档模块的文件。',
      { cwd: 'modules/docs', onFail: 'continue' },
    ),
    { id: 'merge', type: 'fanin', label: '汇总合并', config: { requireAll: false } },
    agent(
      'integrate',
      '集成检查',
      '四个模块的产出如下：\n接口：{{api.artifact.summary}}\n前端：{{web.artifact.summary}}\n测试：{{tests.artifact.summary}}\n文档：{{docs.artifact.summary}}\n请检查各模块产物是否互相矛盾（接口约定 vs 测试用例 vs 文档描述），把发现的问题与整合建议写入结果文件。',
      { retryCount: 0, onFail: 'continue' },
    ),
    end(),
  ],
  [
    e('e1', 'start', 'fork'),
    e('e2', 'fork', 'api'),
    e('e3', 'fork', 'web'),
    e('e4', 'fork', 'tests'),
    e('e5', 'fork', 'docs'),
    e('e6', 'api', 'merge'),
    e('e7', 'web', 'merge'),
    e('e8', 'tests', 'merge'),
    e('e9', 'docs', 'merge'),
    e('e10', 'merge', 'integrate'),
    e('e11', 'integrate', 'end'),
  ],
);

/** 场景二：标准化工程流水线固化复用 */
const standardDevFlow: DagGraph = graph(
  'builtin-standard-dev-flow',
  '标准化工程流水线：初始化 → 编码实现 → 自测修复 → 文档归档，一键固化重复开发流程',
  [
    start(),
    agent(
      'init',
      '初始化框架',
      '在当前工作目录初始化一个标准工程项目（语言/技术栈自选一个你最有把握的），包含：目录结构、依赖清单、lint/format 配置、git init 与首个 commit。完成后写结果文件。',
      { retryCount: 1 },
    ),
    agent(
      'code',
      '功能编码',
      '基于初始化结果实现核心功能：{{init.artifact.summary}}。要求：可运行、带最小 CLI 或入口、代码遵循项目 lint 规范。完成后写结果文件并列出创建/修改的文件。',
      { retryCount: 1 },
    ),
    agent(
      'verify',
      '自测与修复',
      '对当前项目跑 lint 与测试（没有测试就先补关键路径测试再跑），发现并修复所有报错，直到全部通过。把修复过程与最终通过状态写入结果文件。',
      { retryCount: 2, onFail: 'continue' },
    ),
    agent(
      'doc',
      '文档归档',
      '为项目补全 README（简介/安装/运行/测试）与 CHANGELOG（首个版本记录）。上游自测结论：{{verify.artifact.summary}}。完成后写结果文件。若工作目录是 git 仓库：将全部变更 git add 并提交（Conventional Commits 规范，正文注明关联 Issue）。',
      { onFail: 'continue' },
    ),
    end(),
  ],
  [
    e('e1', 'start', 'init'),
    e('e2', 'init', 'code'),
    e('e3', 'code', 'verify'),
    e('e4', 'verify', 'doc'),
    e('e5', 'doc', 'end'),
  ],
);

/** 场景三：高风险操作人工审批 */
const riskApprovalFlow: DagGraph = graph(
  'builtin-risk-approval-flow',
  '高危操作人工可控：依赖升级与破坏性重构默认 blocked，终端确认后人工放行，拒绝即终止',
  [
    start(),
    agent(
      'audit',
      '现状审计',
      '审计当前工作目录项目：列出依赖清单及每个依赖的当前版本与已知风险（可读 lock 文件/package manifest）。只读不写，结论写入结果文件。',
      { onFail: 'abort' },
    ),
    agent(
      'upgrade',
      '依赖升级（需审批）',
      '根据审计结论 {{audit.artifact.summary}} 执行依赖升级：先展示升级计划，随后逐项升级并处理 breaking changes。注意：升级属于高危操作，执行前若出现任何确认询问请如实展示等待人工处理。',
      { retryCount: 1, onFail: 'abort', approveKeys: ['enter'] },
    ),
    agent(
      'cleanup',
      '破坏性清理（需审批）',
      '清理升级后的冗余代码与废弃 API 调用（涉及删除文件与大改，属高危操作，删除前列出完整清单，任何删除确认都等待人工放行），随后跑通全部测试。结果写入结果文件。',
      { onFail: 'abort' },
    ),
    end(),
  ],
  [
    e('e1', 'start', 'audit'),
    e('e2', 'audit', 'upgrade'),
    e('e3', 'upgrade', 'cleanup'),
    e('e4', 'cleanup', 'end'),
  ],
);

/** 场景四：多步骤 Bug 调试修复流水线 */
const bugFixPipeline: DagGraph = graph(
  'builtin-bug-fix-pipeline',
  'Bug 调试修复流水线：复现 → 溯源分析 → 修复编码 → 回归验证，全程产物结构化交接可追溯',
  [
    start(),
    agent(
      'repro',
      '问题复现',
      '在当前工作目录：定位项目入口，理解项目用途，构造一个可稳定复现的缺陷场景（若无真实 bug，则人为注入一个典型缺陷再复现）。复现步骤与现象写入结果文件。',
      { retryCount: 1 },
    ),
    agent(
      'trace',
      '代码溯源',
      '针对以下复现现象做根因分析：{{repro.artifact.summary}}。要求：定位到具体文件与行级原因，给出修复方案建议（改哪里、怎么改、有何风险），不要实际修改代码。分析结论写入结果文件。',
      { onFail: 'abort' },
    ),
    agent(
      'fix',
      '修复编码',
      '按以下根因与方案实施修复：{{trace.artifact.summary}}。要求最小改动、修复后原复现步骤不再复现。修改的文件清单写入结果文件。',
      { retryCount: 2 },
    ),
    agent(
      'regress',
      '回归验证',
      '验证以下修复没有引入新问题：{{fix.artifact.summary}}。执行：原复现场景验证 + 项目现有测试全量跑通 + 边界情况抽查。验证结论写入结果文件（含最终 PASS/FAIL）。',
      { onFail: 'continue' },
    ),
    end(),
  ],
  [
    e('e1', 'start', 'repro'),
    e('e2', 'repro', 'trace'),
    e('e3', 'trace', 'fix'),
    e('e4', 'fix', 'regress'),
    e('e5', 'regress', 'end'),
  ],
);

/** 场景五：多 Agent 角色化团队协作 */
const roleTeamReview: DagGraph = graph(
  'builtin-role-team-review',
  'AI 研发团队分工：开发 → 评审 → 测试 → 归档，各角色产物经黑板结构化交接，模拟真实团队协作',
  [
    start(),
    agent(
      'dev',
      '开发工程师',
      '你是开发工程师。在当前工作目录实现一个指定小功能（自选：命令行 TODO 工具即可），要求功能完整可运行。只做实现，不写测试不写文档。交付说明写入结果文件。',
      { cwd: 'team/dev', retryCount: 1 },
    ),
    agent(
      'review',
      '代码评审员',
      '你是代码评审员，不改代码只提意见。评审对象：{{dev.artifact.summary}}。按 可读性/健壮性/安全/性能 四维度逐项给出 通过或修改意见，输出一份评审报告（评审意见可用文件写到当前目录）。评审结论写入结果文件。',
      { cwd: 'team/review', onFail: 'continue' },
    ),
    agent(
      'qa',
      '测试工程师',
      '你是测试工程师。针对开发交付的功能与评审意见（{{review.artifact.summary}}）编写并执行自动化测试：覆盖正常路径、边界与评审指出的风险点，全部跑通并输出测试报告。测试产物放在当前目录。结论写入结果文件。',
      { cwd: 'team/qa', retryCount: 1 },
    ),
    agent(
      'archivist',
      '文档归档员',
      '你是文档归档员。汇总本轮团队协作全过程：开发交付：{{dev.artifact.summary}}；评审结论：{{review.artifact.summary}}；测试结果：{{qa.artifact.summary}}。整理为 docs/team-report.md（谁做了什么/关键结论/遗留事项）。归档说明写入结果文件。',
      { cwd: 'team/docs', onFail: 'continue' },
    ),
    end(),
  ],
  [
    e('e1', 'start', 'dev'),
    e('e2', 'dev', 'review'),
    e('e3', 'review', 'qa'),
    e('e4', 'qa', 'archivist'),
    e('e5', 'archivist', 'end'),
  ],
);

/** 场景六：双路调研对比决策 */
const researchCompare: DagGraph = graph(
  'builtin-research-compare',
  '双路方案调研对比：两个调研 Agent 并行探索不同技术路线，汇总 Agent 对比权衡给出推荐',
  [
    start(),
    fanout(),
    agent(
      'planA',
      '调研路线A',
      '你是技术调研员，只调研「方案A：本地 SQLite + 单文件部署」路线：在本目录写 research/plan-a.md，评估维度为 开发成本/性能/运维复杂度/扩展性，各给评分(1-5)与理由。不比较其他方案，只深挖本路线。结论摘要写入结果文件。',
      { cwd: 'research/a', onFail: 'continue' },
    ),
    agent(
      'planB',
      '调研路线B',
      '你是技术调研员，只调研「方案B：Postgres + Docker Compose 部署」路线：在本目录写 research/plan-b.md，评估维度同开发成本/性能/运维复杂度/扩展性，各给评分(1-5)与理由。不比较其他方案，只深挖本路线。结论摘要写入结果文件。',
      { cwd: 'research/b', onFail: 'continue' },
    ),
    { id: 'merge', type: 'fanin', label: '对比汇总', config: { requireAll: true } },
    agent(
      'decide',
      '决策建议',
      '你是技术决策人。两路调研结论如下：\n方案A：{{planA.artifact.summary}}\n方案B：{{planB.artifact.summary}}\n请输出对比决策报告 research/decision.md：逐维度对比表、适用场景分界、最终推荐与理由。推荐结论写入结果文件。',
      { onFail: 'abort' },
    ),
    end(),
  ],
  [
    e('e1', 'start', 'fork'),
    e('e2', 'fork', 'planA'),
    e('e3', 'fork', 'planB'),
    e('e4', 'planA', 'merge'),
    e('e5', 'planB', 'merge'),
    e('e6', 'merge', 'decide'),
    e('e7', 'decide', 'end'),
  ],
);

// ---------------------------------------------------------------------------
// Issue 受理 → 路由 → 交付（三段式，用户场景：探索功能成熟度并创建 Issue）
// ---------------------------------------------------------------------------

/** 受理：探索项目 → 产出评估与 Issue 草稿 → 创建 Issue → 路由到交付模板 */
const issueTriage: DagGraph = graph(
  'builtin-issue-triage',
  'Issue 受理流水线：输入项目根目录与一句需求描述 → Agent 探索项目功能成熟度 → 创建规范 Issue → 按产出的建议模板路由到交付流程（无匹配则用通用兜底）',
  [
    start(),
    agent(
      'explore',
      '探索与评估',
      '项目根目录下探索该项目：读 README、docs、目录结构与关键代码，评估「功能成熟度」（已实现哪些能力/缺失哪些能力/明显的体验或工程缺口），围绕用户给的需求描述判断该做什么。用户描述会由运行参数 brief 提供。',
      { clarify: { maxRounds: 3 }, retryCount: 1, onFail: 'abort' },
    ),
    agent(
      'triage',
      '创建 Issue 并建议模板',
      '基于探索结论 {{explore.artifact.summary}}：\n1. 把需求整理为规范 Issue（背景/目标/验收标准/风险），将草稿写入文件 issue-draft.json，然后用 shell 调用本地编排服务创建（确定性，无需 gh 登录）：`curl -s -X POST http://127.0.0.1:4310/api/github/create-issue -H "Content-Type: application/json" -d @issue-draft.json`；记录返回 JSON 里的 number 与 url；\n2. 在结果文件的 extra.suggestedTemplate 写入建议的交付模板名（只能从以下精确 ID 中选：builtin-bug-fix-pipeline / builtin-parallel-module-dev / builtin-standard-dev-flow / builtin-role-team-review；都不合适才写 builtin-generic-issue-delivery）；\n3. 把 issue 编号写入 extra.issue_id。探索详情：{{explore.artifact.output}}',
      { retryCount: 2, onFail: 'abort' },
    ),
    {
      id: 'route',
      type: 'pipeline',
      label: '路由到交付流程',
      config: {
        pipeline: {
          template: '{{triage.artifact.extra.suggestedTemplate}}',
          fallbackTemplate: 'builtin-generic-issue-delivery',
          params: {
            issue_id: '{{triage.artifact.extra.issue_id}}',
          },
          mode: 'wait',
        },
      },
    },
    end(),
  ],
  [
    e('e1', 'start', 'explore'),
    e('e2', 'explore', 'triage'),
    e('e3', 'triage', 'route'),
    e('e4', 'route', 'end'),
  ],
);

/** 通用兜底：对齐（断言注入）→ 方案拆解（断言映射）→ 动态扇出并行实现（断言自测）→ 汇总 → 验收断言核对 → 归档收口 */
const genericDeliveryNodes: DagGraph['nodes'] = [
  start(),
  agent(
    'align',
    '需求对齐 + 验收断言注入',
    '你负责「需求对齐 + 验收断言注入」。围绕该 Issue（编号 {{issue_id}}，可能为空）做：\n' +
      '1. 读取本地需求源 issue-draft.json（在工作目录；含 背景/目标/验收标准/风险，由受理阶段起草）。若文件缺失，则以运行参数中的任务描述「{{task}}」为需求来源生成骨架（{{task}} 为空时按 Issue 标题／当前工作目录上下文推断），并落盘为 issue-draft.json。\n' +
      '2. 把需求拆解为显式、可测试的验收断言：每条断言为 AC-N 编号 + 可验证断言 + 验证方法。就地覆写 issue-draft.json 的「验收标准」小节为编号断言面（保留其余小节）：\n' +
      'AC-1：<可验证断言>（验证方法：<方法>）\n' +
      'AC-2：<可验证断言>（验证方法：<方法>）\n' +
      '...（N 通常 3-10 条，须覆盖需求全部关键点、可被下游实现/核对客观判定）\n' +
      '3. 构造远程 Issue 完整正文（背景/目标/验收标准/风险，验收标准用上面的 AC-N 断言面），用 shell 调本地编排服务的 update-issue 端点就地更新远程 Issue 正文（确定性、无需 gh 登录，省略 repo 时用已配置默认仓库）：\n' +
      'curl -s -X PATCH http://127.0.0.1:4310/api/github/update-issue -H "Content-Type: application/json" -d \'{"number":<issue 编号>,"body":"<完整正文>"}\'\n' +
      'issue 编号取 {{issue_id}}，为空则回退读 issue-draft.json 中的 number 字段；两者都拿不到就跳过远程更新（不改动远程 Issue）。远程更新失败不阻断交付，把原因记入结果文件 errors。\n' +
      '4. 结果文件写：summary=断言清单（Markdown 编号列表，每行 AC-N：<断言>（验证方法：<方法>），下游 plan/impl/verify 都照抄此清单）、extra.acceptance=[{id:"AC-1",assertion:"...",verify_method:"..."},...]（与 Markdown 面一一对应）、aligned=true。仍不确定的点可写入 extra.questions 并置 aligned=false 进入澄清轮。',
    { clarify: { maxRounds: 3 }, onFail: 'abort' },
  ),
  agent(
    'plan',
    '方案拆解 + 断言覆盖映射',
    '基于对齐结论 {{align.artifact.summary}}（内含验收断言清单）设计实现方案，并拆分为可并行执行的任务清单：按验收断言逐条映射任务覆盖——每条断言至少被一个任务承接，任务 brief 中内嵌其承接的断言（引用断言一律照抄自 {{align.artifact.summary}} 的 AC-N 编号断言条目：AC-N：<断言>（验证方法：<方法>），禁止插值任何数组字段，如 [object Object] 即引擎把数组 String 化的错误特征）。结果文件写 extra.tasks（数组，每项 {name, brief}，单任务不跨模块；brief 必须包含承接断言原文）；summary 写 方案要点 + 断言覆盖矩阵（逐条 AC-N → 承接任务名）。',
    { onFail: 'abort' },
  ),
  { id: 'fork', type: 'fanout', label: '按任务展开', config: { expand: { from: 'plan', field: 'extra.tasks' } } },
  agent(
    'impl',
    '实现 {{item.name}}',
    '实现任务「{{item.name}}」：{{item.brief}}。方案上下文：{{plan.artifact.summary}}。当前任务承接的验收断言已在任务 brief 中给出（AC-N 编号断言，照抄自 {{align.artifact.summary}}）。实现完成后按对应断言逐条自测，并在结果文件回写 extra.assertionResults=[{id,status,evidence}]：id 为 AC-N，status ∈ ok|fail|n/a，evidence 为可验证的自测证据（命令/输出/文件路径等），未满足的断言如实标 fail 并给出原因。在当前工作目录完成实现并自测，交付说明写入结果文件。',
    { retryCount: 1, onFail: 'continue' },
  ),
  { id: 'merge', type: 'fanin', label: '汇总验证', config: { requireAll: false } },
  agent(
    'verify',
    '验收断言核对',
    '验收断言核对。按需求对齐（align 阶段）注入的验收断言清单（见 {{align.artifact.summary}}：每行 AC-N：<断言>（验证方法：<方法>））逐条核对各实现分支的断言自测结果——各 {{impl.artifact.summary}} 的 extra.assertionResults=[{id,status,evidence}] 逐条核对：断言是否有分支承接、自测 status 是否 ok、evidence 是否充分客观。把核查汇总写入结果文件 extra.assertionResults=[{id,status,evidence}]（status ∈ ok|fail|n/a，evidence 注明核对依据与来源分支），summary 注明未满足项（若有；无则说明全部断言已满足）。引用断言一律照抄自 {{align.artifact.summary}}，禁止插值 extra.acceptance 数组（引擎 String 化会变成 [object Object]）。',
    { onFail: 'continue' },
  ),
  agent(
    'wrapup',
    '归档收口',
    '各任务结果：{{impl.artifact.summary}}；验收断言核对结论：{{verify.artifact.summary}}。汇总本轮交付（做了什么/遗留什么/验证情况）写入结果文件。若工作目录是 git 仓库且产生变更：git add -A 并提交（Conventional Commits，正文注明关联 Issue），再把交付摘要作为评论回贴到关联 Issue（gh issue comment）。',
    { onFail: 'continue' },
  ),
  end(),
];

// 通用兜底模板：变量 issue_id 由受理路线的 pipeline params.issue_id 注入（无编号时为空字符串，align 会回退跳过远程更新）；
// 变量 task 由智能下发路线的 pipeline params.task 注入（applyVariables 只替换已声明变量，故必须在此声明）
const genericDelivery: DagGraph = {
  ...graph(
    'builtin-generic-issue-delivery',
    '通用 Issue 交付兜底：需求对齐 + 验收断言注入 → 方案拆解（断言覆盖映射）→ 按任务动态扇出并行实现（断言自测）→ 汇总验证 → 验收断言核对 → 归档收口。没有专门模板时的自动流程',
    genericDeliveryNodes,
    [
      e('e1', 'start', 'align'),
      e('e2', 'align', 'plan'),
      e('e3', 'plan', 'fork'),
      e('e4', 'fork', 'impl'),
      e('e5', 'impl', 'merge'),
      e('e6', 'merge', 'verify'),
      e('e7', 'verify', 'wrapup'),
      e('e8', 'wrapup', 'end'),
    ],
  ),
  variables: [
    { key: 'issue_id', label: '主 Issue 编号', required: false },
    { key: 'task', label: '任务描述（智能下发注入）', required: false },
  ],
};

/** S5 数据治理批次（v6 Gate 0 骨架）：清单切批 → 动态扇出逐批处理 → 宽容扇入 → 机器判据终审 → 收口报告 */
const batchDataGovernance: DagGraph = {
  ...graph(
    'builtin-batch-data-governance',
    '数据治理批次：输入条目清单 → 按大小切批 → 逐批并行治理（输出目录约定隔离）→ 汇总 → 验收断言终审（机器判据）→ 批次总报告 batch-report.md',
    [
      start(),
      agent(
        'prepare',
        '读清单切批',
        '你是批次规划员。读取输入清单 {{batch_source}}（每行一条或 JSON 数组；相对路径按当前工作目录解析）。' +
          '按每批 {{batch_size}} 条切分，批次命名 batch-01、batch-02…（保持原顺序，ASCII 名）。' +
          '每批清单写成独立文件 output/_batches/<批次名>.json（数组）。' +
          '结果文件：extra.batches 为数组，每项 {name:"<批次名>", brief:"<批次名>：第 X-Y 条，共 N 条，清单文件 output/_batches/<批次名>.json"}；' +
          'summary 写"共 X 条切为 Y 批"。只做切分与落盘，不改写条目内容。' +
          '清单缺失或为空时如实失败（extra.batches 给空数组），不要虚构数据。',
        { retryCount: 1, onFail: 'abort' },
      ),
      { id: 'fork', type: 'fanout', label: '按批展开', config: { expand: { from: 'prepare', field: 'extra.batches', onEmpty: 'fail' } } },
      agent(
        'impl',
        '治理 {{item.name}}',
        '治理批次「{{item.name}}」：{{item.brief}}。' +
          '按以下要求逐条处理本批：{{batch_prompt}}。' +
          '产物隔离约定：本批全部输出只写入子目录 output/{{item.name}}/（克隆分支共享同一工作目录，目录约定是唯一隔离手段），批内条目一问一答/一进一出。' +
          '结果文件：extra.batch="{{item.name}}"、extra.processed=<处理条数>、extra.anomalies=[{entry,reason,advice}]（无异常则空数组）、summary 一段本批结论。' +
          '若你的运行环境可统计 token 用量，把 {input,output} 写入 extra.usage；拿不到就省略该字段，禁止编造。',
        { retryCount: 1, onFail: 'continue' },
      ),
      { id: 'merge', type: 'fanin', label: '批次汇总', config: { requireAll: false } },
      agent(
        'verify',
        '验收断言终审',
        '终审各批产物。注意：动态扇出分支的产物不聚合到黑板别名（引擎 G10 约束），' +
          '必须用 shell 直读文件：遍历 .herdr/artifacts/impl__*.json 逐个解析。' +
          '同时核对 output/ 下各批次目录与 output/_batches/ 清单的一致性。' +
          '按验收模板逐条形成断言：{{acceptance_template}}。' +
          '结果文件：extra.assertionResults=[{id:"AC-1",status:"ok|fail|n/a",evidence:"核对依据（含来源文件）"}]，' +
          '每条断言都必须给出客观证据（数量、文件路径、抽查样例），未满足如实标 fail；summary 写终审结论。',
        {
          retryCount: 1,
          onFail: 'abort',
          checks: [
            {
              // F1 后引擎验收机器门负责逐条判 fail；这里只兜底断言列表非空
              type: 'command',
              run:
                "node -e 'const r=JSON.parse(require(\"fs\").readFileSync(\".herdr/artifacts/verify.json\",\"utf8\"));const a=(r.extra&&r.extra.assertionResults)||[];if(!a.length){console.error(\"assertionResults 为空\");process.exit(1)}'",
            },
          ],
        },
      ),
      agent(
        'wrapup',
        '批次总报告',
        '各批终审结论：见 .herdr/artifacts/verify.json（直读文件，勿引用黑板别名）。' +
          '汇总本轮批次治理产出 output/batch-report.md：总条数/批次数、每批 处理数与异常数、断言核对表（AC-N/状态/证据）、' +
          '异常清单汇总与处置建议、产物目录索引。同时把报告要点写入结果文件 summary。',
        { retryCount: 1, onFail: 'continue', checks: [{ type: 'file-exists', path: 'output/batch-report.md' }] },
      ),
      end(),
    ],
    [
      e('e1', 'start', 'prepare'),
      e('e2', 'prepare', 'fork'),
      e('e3', 'fork', 'impl'),
      e('e4', 'impl', 'merge'),
      e('e5', 'merge', 'verify'),
      e('e6', 'verify', 'wrapup'),
      e('e7', 'wrapup', 'end'),
    ],
  ),
  variables: [
    { key: 'batch_source', label: '条目清单文件（行或 JSON 数组）', required: true },
    { key: 'batch_prompt', label: '治理要求（逐条怎么处理）', required: true },
    { key: 'batch_size', label: '每批条数', default: '50' },
    {
      key: 'acceptance_template',
      label: '验收断言模板',
      default:
        'AC-1 每批条目全部处理且有输出记录；AC-2 异常条目均有原因与处置建议；AC-3 批间无重复无遗漏（各批 processed 之和=总数）；AC-4 各批自报条数与 output/<批次>/ 实际产物一致',
    },
  ],
};

export const BUILTIN_TEMPLATES: DagGraph[] = [
  issueTriage,
  genericDelivery,
  parallelModuleDev,
  standardDevFlow,
  riskApprovalFlow,
  bugFixPipeline,
  roleTeamReview,
  researchCompare,
  batchDataGovernance,
];

/** Idempotent seeding: never overwrite a template the user edited/deleted. */
export function seedBuiltinTemplates(
  get: (id: string) => unknown,
  save: (graph: DagGraph) => void,
): string[] {
  const seeded: string[] = [];
  for (const t of BUILTIN_TEMPLATES) {
    if (get(t.name) === null) {
      save(t);
      seeded.push(t.name);
    }
  }
  return seeded;
}
