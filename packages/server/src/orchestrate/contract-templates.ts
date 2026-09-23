import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * v8-M6 契约模板与断言语式库：约定 = 空间目录里的可修改文本资产（JSON 文件），
 * 不建编辑器、不发明 DSL；引擎只负责「选→填差异→盖 id@sha 戳」。
 * 空间资产目录：<spaceDir>/contract-templates/*.json（按 id 覆盖内置模板）；
 * 保留文件名 assertion-patterns.json（断言语式库）与 clarify-questions.json（澄清问题库）。
 */

export interface ContractTemplate {
  id: string;
  title: string;
  /** 命中任一关键词即视为该活类型（用于自动选骨架；多选错不如不选，宁缺毋滥） */
  matchKeywords: string[];
  /** 预填断言面骨架：实例化时照抄再按本单差异修订 */
  assertions: { assertion: string; verify_method: string }[];
  scopeNotes?: string;
  budget?: { maxMinutes?: number; maxTokens?: number };
  /** 该类型任务的默认澄清提问（DoR 不合格时按库出题） */
  questions: string[];
}

export interface LoadedTemplate {
  template: ContractTemplate;
  /** 内容指纹（规范化 JSON 的 sha256 前 8 位）；留痕 id@sha 的 sha */
  sha: string;
  source: 'builtin' | 'space';
  file?: string;
}

export const CONTRACT_TEMPLATE_DIRNAME = 'contract-templates';
const RESERVED_FILES = new Set(['assertion-patterns.json', 'clarify-questions.json']);

/** 内置种子骨架（M1 v0 的「引擎内置极简骨架」在 M6 里的正式化——就是三个可被覆盖的文本模板） */
export const BUILTIN_CONTRACT_TEMPLATES: ContractTemplate[] = [
  {
    id: 'bugfix',
    title: '缺陷修复',
    matchKeywords: ['bug', '修复', '报错', '崩溃', '异常', 'defect', 'fix'],
    assertions: [
      { assertion: '复现步骤在修复后不再触发原症状', verify_method: '按缺陷报告的复现步骤逐条执行，记录实际输出' },
      { assertion: '根因位置有针对性回归测试且通过', verify_method: '运行项目测试命令，贴出新增/修改的用例名与结果' },
      { assertion: '同类入口无回归（相邻功能抽查）', verify_method: '列出抽查的相邻功能与结论' },
    ],
    scopeNotes: '只修根因，不顺手重构；改动面与缺陷直接相关',
    questions: ['复现步骤/报错日志能给一份吗？', '期望行为是什么（修成什么样算好）？', '影响范围：哪些入口/场景要一并查？'],
  },
  {
    id: 'docs',
    title: '文档撰写/整理',
    matchKeywords: ['文档', 'README', '说明', '手册', 'docs', '教程'],
    assertions: [
      { assertion: '目标文档存在且覆盖需求列出的全部主题小节', verify_method: '按主题清单逐节核对文件内容' },
      { assertion: '文档内命令/路径示例可直接执行（无占位假路径）', verify_method: '抽抄示例命令在文档所述环境跑一遍' },
      { assertion: '与现状一致：不描述不存在的功能/接口', verify_method: '对照代码抽查文中提到的接口名/行为' },
    ],
    scopeNotes: '只动文档面；不改代码与配置',
    questions: ['目标读者是谁（使用者/维护者）？', '写到哪个文件/目录？', '有必须对齐的既有文风或模板吗？'],
  },
  {
    id: 'generic',
    title: '通用交付',
    matchKeywords: [],
    assertions: [
      { assertion: '任务描述中的每个显式要求都有对应产出', verify_method: '逐条对照任务描述列出 要求→产出 位置' },
      { assertion: '产出可被独立核验（给出文件路径/命令/链接）', verify_method: '按产出说明的核验方式执行一遍' },
    ],
    scopeNotes: '不做任务之外的事；拿不准的进 questions',
    questions: ['完成判据是什么（怎么算做好了）？', '交付物落在哪里（目录/分支/Issue）？'],
  },
];

/** 内容指纹：规范化（键序稳定靠 JSON.stringify 调用方保证；这里排序键）后 sha256 前 8 位 */
export function templateSha(t: ContractTemplate): string {
  const canonical = JSON.stringify(t, Object.keys(t).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function isValidTemplate(v: unknown): v is ContractTemplate {
  const t = v as ContractTemplate;
  return !!t && typeof t.id === 'string' && typeof t.title === 'string' && Array.isArray(t.assertions)
    && t.assertions.every((a) => typeof a?.assertion === 'string');
}

export interface ContractLibrary {
  templates: LoadedTemplate[];
  /** 断言语式库（b）：可复用 AC 句式，人改库、align 从库中选 */
  assertionPatterns: string[];
  /** 澄清问题库（c）：DoR 不合格时按库出题 */
  clarifyQuestions: string[];
  dir: string;
}

/** 加载空间契约资产：内置骨架 + <spaceDir>/contract-templates/ 覆盖与语式/问题库 */
export function loadContractLibrary(spaceDir: string): ContractLibrary {
  const dir = path.join(spaceDir, CONTRACT_TEMPLATE_DIRNAME);
  const byId = new Map<string, LoadedTemplate>();
  for (const t of BUILTIN_CONTRACT_TEMPLATES) {
    byId.set(t.id, { template: t, sha: templateSha(t), source: 'builtin' });
  }
  let assertionPatterns: string[] = [];
  let clarifyQuestions: string[] = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json') || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.name === 'assertion-patterns.json') {
        const v = readJsonSafe<unknown>(full);
        assertionPatterns = Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
        continue;
      }
      if (ent.name === 'clarify-questions.json') {
        const v = readJsonSafe<unknown>(full);
        clarifyQuestions = Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
        continue;
      }
      if (RESERVED_FILES.has(ent.name)) continue;
      const v = readJsonSafe<unknown>(full);
      if (!isValidTemplate(v) || RESERVED_FILES.has(v.id)) continue;
      byId.set(v.id, { template: v, sha: templateSha(v), source: 'space', file: full });
    }
  } catch {
    // 目录不存在 = 只有内置骨架
  }
  return {
    templates: [...byId.values()].sort((a, b) => a.template.id.localeCompare(b.template.id)),
    assertionPatterns,
    clarifyQuestions,
    dir,
  };
}

/** 关键词择骨架：命中数最多者胜；零命中不选（宁缺毋滥，选错骨架比没骨架更误导） */
export function matchContractTemplate(text: string, lib: ContractLibrary): LoadedTemplate | null {
  const lower = text.toLowerCase();
  let best: LoadedTemplate | null = null;
  let bestHits = 0;
  for (const lt of lib.templates) {
    const hits = lt.template.matchKeywords.filter((k) => k && lower.includes(k.toLowerCase())).length;
    if (hits > bestHits) {
      best = lt;
      bestHits = hits;
    }
  }
  return best;
}

/** 渲染注入 Planner/align 提示词的「契约骨架实例化」文本块（含留痕要求） */
export function renderContractTemplateBlock(lt: LoadedTemplate, lib: ContractLibrary): string {
  const t = lt.template;
  const lines = [
    `本单命中契约骨架模板「${t.id}@${lt.sha}」（${t.title}）——照抄以下骨架再按本单差异修订，不要从零自由发挥：`,
    ...t.assertions.map((a, i) => `- AC-${i + 1}: ${a.assertion}（验证方法：${a.verify_method || '待补'}）`),
    ...(t.scopeNotes ? [`边界默认：${t.scopeNotes}`] : []),
    ...(t.budget?.maxMinutes ? [`预算默认：≤${t.budget.maxMinutes} 分钟`] : []),
    ...(t.budget?.maxTokens ? [`预算默认：≤${t.budget.maxTokens} tokens`] : []),
    ...(t.questions.length ? [`该类型任务的标配澄清提问（有疑问才带出）：`, ...t.questions.map((q) => `❓ ${q}`)] : []),
  ];
  if (lib.assertionPatterns.length) {
    lines.push('可复用的断言语式库（合适就拿来替换骨架措辞）：', ...lib.assertionPatterns.slice(0, 15).map((p) => `- ${p}`));
  }
  if (lib.clarifyQuestions.length) {
    lines.push('澄清问题库（挑与本单相关的）：', ...lib.clarifyQuestions.slice(0, 10).map((q) => `❓ ${q}`));
  }
  lines.push('实例化后的契约里请原样带上 "template": "' + `${t.id}@${lt.sha}"（留痕：本单按哪版约定干的）。`);
  return lines.join('\n');
}

/** 判例回流（M5 最轻起步）：门内被追问/拒绝的内容记成 JSONL，人读后可去改模板文件 */
export function appendTemplateFeedback(spaceDir: string, entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      path.join(spaceDir, 'contract-feedback.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch {
    // 回流失败不阻断主流程（判例不是执行路径）
  }
}
