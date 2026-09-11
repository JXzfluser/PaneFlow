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
  return { id, type: 'agent', label, config: { agentKind: 'pi', prompt, ...extra } };
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
      '为项目补全 README（简介/安装/运行/测试）与 CHANGELOG（首个版本记录）。上游自测结论：{{verify.artifact.summary}}。完成后写结果文件。',
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

export const BUILTIN_TEMPLATES: DagGraph[] = [
  parallelModuleDev,
  standardDevFlow,
  riskApprovalFlow,
  bugFixPipeline,
  roleTeamReview,
  researchCompare,
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
