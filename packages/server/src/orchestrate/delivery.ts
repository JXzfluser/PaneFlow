import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';

/**
 * v13-B1 交付约定块（delivery）：空间档案的「家规」声明位。
 * 交付约定五要素——拉出基点 / 分支命名 / PR 目标 / 门禁 / 驳回流程——里本片装前三样 +
 * 人闸声明（gates）+ 备注（note）；驳回流程由既有件表达（K2 回边），不新造。
 * 条目形状对齐 rules 的挂载点先例（SpaceRule.repo 同款匹配语义：相对主仓根的仓库目录名，
 * 一仓一副）。占位符（`{issue}`/`{version}`…）在档案里当不透明字符串存——写入面（B1）
 * 一律不解析，读取面自 v13-B2 起才解析并消费。
 *
 * v13-B2 三层消费者（本文件给判据与渲染，引擎给现场；CLI 零判据，只看 server 返回的键）：
 *  ①机检层 engine.createWorktree——基点/分支名按家规**真**拉起。fail-closed 两处：
 *    基点在本地 refs/heads 与 refs/remotes/origin 两路都解析不到 → 拒建、节点即时红；
 *    占位符解析不到 → 拒建、节点即时红。两处都**绝不**静默回落 HEAD 或 `paneflow/<runId>-<nodeId>`
 *    命名（那正是需求文档点名的污染账与假绿账）。
 *  ②注入层 engine.resolveContext——渲染后的约定块进节点上下文通道（buildDeliveryBlock）：
 *    agent 每次提交/开 PR 都看得见家规。它是**运行时渲染的文本、不是实读文件**，所以进
 *    injectedBytes（实注字节）而不进 ctxSha（V4 的口径=注入现场实读的文件集）。
 *  ③对账层 engine.reconcileDelivery——实分支名 vs 渲染结果、家规 gates vs 图上人闸，
 *    落差结构化落 run.deliveryWorktrees / run.deliveryViolations + 一条聚合 warn 事件，
 *    **只照不拦**（W3 declareViolations 同族；PR 目标分支的核验在人闸位，那是人的事）。
 * 兼容带死判据：delivery 没命中条目 → 三层一条都不走（零新账、零新事件、零新 git 调用），
 * 引擎行为与 B1 之前一字不变——没学家规的空间不许突然起不了单。
 */

/** 条目允许键集合：未知键即拒（拼错字段=家规静默失效，宁拒不错放） */
const DELIVERY_KEYS = ['repo', 'branchFrom', 'branchName', 'prTarget', 'gates', 'note'] as const;

export interface DeliveryRule {
  /** 相对空间主仓根的仓库目录名；缺省=全空间副（B2 起按仓匹配消费，精确条目优先于通配副） */
  repo?: string;
  /** 拉出基点分支（如 "main"；可含占位符——B2 起建 worktree 现场渲染并按两路解析，解析不到即拒建） */
  branchFrom: string;
  /** 分支名模板（如 "fix/issue-{issue}"；盘面原样存，B2 起读取面渲染） */
  branchName: string;
  /** PR 目标分支（如 "release/v{version}"；B4：B2 起渲染后进注入块，引擎不代建 PR） */
  prTarget: string;
  /**
   * 人闸名声明（有哪几道、叫什么）；执行件仍是既有的人闸位（manual/契约/分支守卫检查或澄清轮），
   * 此处只入册 + 收口核对「声明了人闸而图上一道没编」（只照不拦）。
   */
  gates?: string[];
  /** 为什么/什么时候守这副家规（随注入块一起给 agent 看） */
  note?: string;
}

/**
 * PUT /api/spaces/:id 的 delivery 机检：合法返回 null；非法返回一句人话错误（400 文案）。
 * 姿态对齐 rules 既有校验（http.ts PUT：数组 + 每项对象 + 必备字段字符串），并按
 * 「宁拒不错放」收紧——必填三字段非空、未知键拒绝、repo/gates/note 给出时严类型。
 */
export function validateDelivery(raw: unknown): string | null {
  const SHAPE = 'delivery 必须是 {branchFrom, branchName, prTarget, repo?, gates?, note?} 条目数组';
  if (!Array.isArray(raw)) return SHAPE;
  for (let i = 0; i < raw.length; i += 1) {
    const x = raw[i];
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      return `${SHAPE}；第 ${i + 1} 项不是对象`;
    }
    const item = x as Record<string, unknown>;
    const unknown = Object.keys(item).filter((k) => !(DELIVERY_KEYS as readonly string[]).includes(k));
    if (unknown.length) {
      return `delivery 第 ${i + 1} 项含未知键：${unknown.join('/')}（只认 ${DELIVERY_KEYS.join('/')}）`;
    }
    for (const key of ['branchFrom', 'branchName', 'prTarget'] as const) {
      const v = item[key];
      if (typeof v !== 'string' || !v.trim()) {
        return `delivery 第 ${i + 1} 项的 ${key} 必须是非空字符串`;
      }
    }
    if (item.repo !== undefined && (typeof item.repo !== 'string' || !item.repo.trim())) {
      return `delivery 第 ${i + 1} 项的 repo 给出时须为非空字符串（相对主仓根的仓库目录名）`;
    }
    if (
      item.gates !== undefined &&
      (!Array.isArray(item.gates) || item.gates.some((g) => typeof g !== 'string' || !g.trim()))
    ) {
      return `delivery 第 ${i + 1} 项的 gates 必须是非空字符串数组（人闸只声明，执行件是既有的人闸位：manual/契约/分支守卫检查或澄清轮）`;
    }
    if (item.note !== undefined && typeof item.note !== 'string') {
      return `delivery 第 ${i + 1} 项的 note 必须是字符串`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// v13-B2 读取面：条目清洗 / 占位符渲染 / 按仓匹配 / 约定块文案（判据全在这里，引擎只给现场）
// ---------------------------------------------------------------------------

/** 必填三字段（家规的最小可消费形——手改盘面把这三样写坏的那条整条不取，宁缺毋假） */
const DELIVERY_REQUIRED = ['branchFrom', 'branchName', 'prTarget'] as const;

/**
 * 档案读端清洗：写入面（PUT /api/spaces/:id）已按 validateDelivery fail-closed 拒过一遍，
 * 这里只兜「手改 profile.json 的存量脏形」的降级（normalizeDeclares/worktreeRootFor 同款姿势）：
 * 必填三字段必须是非空字符串，脏条目整条丢弃（不拿半坏的家规当真家规）。
 * 数组本体不是数组 / 缺键 → 空数组 = 「没学家规」= 兼容带。
 */
export function normalizeDeliveryRules(raw: unknown): DeliveryRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is DeliveryRule => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const item = x as Record<string, unknown>;
    if (!DELIVERY_REQUIRED.every((k) => typeof item[k] === 'string' && (item[k] as string).trim())) return false;
    if (item.repo !== undefined && (typeof item.repo !== 'string' || !item.repo.trim())) return false;
    if (item.gates !== undefined && (!Array.isArray(item.gates) || item.gates.some((g) => typeof g !== 'string' || !g.trim())))
      return false;
    if (item.note !== undefined && typeof item.note !== 'string') return false;
    return true;
  });
}

/** 相对主仓根的仓库目录名（'/' 分隔）——与 rules.matchRules 同一把尺，同一取材 */
export function repoRelOf(rootCwd: string | undefined, absPath: string): string {
  if (!rootCwd) return '';
  const rel = path.relative(path.resolve(rootCwd), path.resolve(absPath)).split(path.sep).join('/');
  if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return '';
  return rel;
}

/** 渲染取材（起单在册的那几样，不是二次猜测）：{issue}=run.issueId、{run_id}=run.runId、其余=实填变量 */
export interface DeliveryRenderContext {
  issueId?: string;
  runId?: string;
  variables?: Record<string, string>;
}

export interface DeliveryFieldRender {
  /** 解析得到的占位符已替换；解析不到的原样留字面（只用于文案，绝不拿去建分支） */
  value: string;
  /** 解析不到的占位符名（去重、按出现序）；非空 = 机检层 fail-closed 的判据 */
  missing: string[];
}

/**
 * `{name}` 占位符渲染：`{issue}` 取 RunRecord.issueId、`{run_id}` 取 runId、其余取起单实填变量
 * （需求文档点名的 `{version}` 就在这里——applyTemplateVariables 那条通道）。
 * 变量优先于内置（与 applyVariables 的 builtinVars={...defaults, ...variables} 同 precedence）。
 * 刻意不支持嵌套/表达式：家规是配置，不是脚本。
 */
export function renderDeliveryTemplate(tpl: string, ctx: DeliveryRenderContext): DeliveryFieldRender {
  const missing: string[] = [];
  const value = tpl.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (whole, name: string) => {
    const v =
      ctx.variables?.[name] ?? (name === 'issue' ? ctx.issueId : name === 'run_id' ? ctx.runId : undefined);
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return s;
  });
  return { value, missing };
}

/** 命中的是哪一副家规、怎么命中的 */
export interface DeliveryMatch {
  rule: DeliveryRule;
  /** 档案 delivery 数组下标（对账账本据此指认「是哪一条家规」） */
  index: number;
  /** repo=repo 精确匹配条目优先；space=repo 缺省的通配副 */
  matchedBy: 'repo' | 'space';
}

/**
 * 按仓匹配（一仓一副）：`repo` 精确匹配的条目优先于 `repo` 缺省的通配副；两者皆无=不消费。
 * 尺与 rules.matchRules 逐字同款——repo 是相对主仓根的仓库目录名，节点/仓目录在其内才算命中；
 * 主仓根未配置或目标不在仓内时，只有通配副能命中（repoRelOf 把「不在仓内」归一成 ''）。
 */
export function matchDeliveryRule(rules: DeliveryRule[], repoRel: string): DeliveryMatch | undefined {
  for (let i = 0; i < rules.length; i += 1) {
    const r = rules[i]!;
    if (!r.repo) continue;
    const repo = r.repo.replace(/\/+$/, '');
    if (repoRel && (repoRel === repo || repoRel.startsWith(`${repo}/`))) return { rule: r, index: i, matchedBy: 'repo' };
  }
  const wildcard = rules.findIndex((r) => !r.repo);
  return wildcard === -1 ? undefined : { rule: rules[wildcard]!, index: wildcard, matchedBy: 'space' };
}

/** 家规字段维度（落差文案要指认是哪个模板没渲染开） */
export type DeliveryField = 'branchFrom' | 'branchName' | 'prTarget';

export interface DeliveryUnresolved {
  field: DeliveryField;
  /** 档案里的原样模板（照搬需求文档的「花括号原样进提示词=可见事故」口径） */
  raw: string;
  names: string[];
}

/** 一次命中 + 渲染的完整结果：三层消费者共用同一份，绝不允许两处算出两个值 */
export interface DeliveryPlan {
  match: DeliveryMatch;
  /** 拉出基点的渲染结果（契约覆盖已在此处生效：contract.branch 优先于 rule.branchFrom） */
  baseRef: string;
  /** 基点来源：contract=本单契约覆盖（契约优先于空间）；rule=空间家规 */
  baseSource: 'contract' | 'rule';
  /** 分支名渲染结果（未解析时保留字面，机检层据 unresolved 拒建） */
  branchName: string;
  /** PR 目标分支渲染结果（B4：注入块里的 prTarget 即此值） */
  prTarget: string;
  unresolved: DeliveryUnresolved[];
}

/**
 * 家规取材 + 渲染（纯函数，零 git/零 fs）：无命中条目 → undefined（= 兼容带，调用方按今日语义走）。
 * 基点覆盖：契约给了非空 branch 就压过空间 branchFrom（需求文档「契约优先于空间」的正身）。
 * 注：本仓 RunContract.branch 自 H1 起被解析但全仓零消费者（delivery-branch 守卫用的是
 * checks[].expectBranch，不是它），v13-B2 起它是家规基点的 per-run 覆盖口。
 */
export function planDelivery(opts: {
  rules: DeliveryRule[];
  repoRel: string;
  contractBranch?: string;
  ctx: DeliveryRenderContext;
}): DeliveryPlan | undefined {
  const match = matchDeliveryRule(opts.rules, opts.repoRel);
  if (!match) return undefined;
  const unresolved: DeliveryUnresolved[] = [];
  const renderField = (field: DeliveryField, raw: string): string => {
    const r = renderDeliveryTemplate(raw, opts.ctx);
    if (r.missing.length) unresolved.push({ field, raw, names: r.missing });
    return r.value;
  };
  const contractBranch = typeof opts.contractBranch === 'string' ? opts.contractBranch.trim() : '';
  const baseSource: DeliveryPlan['baseSource'] = contractBranch ? 'contract' : 'rule';
  const baseRaw = contractBranch || match.rule.branchFrom;
  const baseRef = renderField('branchFrom', baseRaw);
  const branchName = renderField('branchName', match.rule.branchName);
  const prTarget = renderField('prTarget', match.rule.prTarget);
  return { match, baseRef, baseSource, branchName, prTarget, unresolved };
}

/**
 * ②注入层文案：渲染后的交付约定块（约定通道里的运行时文本）。
 * 措辞诚实同 W3「声明非强制」口径——PaneFlow 只声明与对账，不代跑 push/建 PR（S6「操作系统的事」
 * 边界）；家规是**该守的约定**，不是引擎已代跑的动作。占位符没渲染开也如实写出来（不假称已按约定命名）。
 * 无命中条目时调用方根本不会走到这里（兼容带：注入块零新增）。
 */
export function buildDeliveryBlock(plan: DeliveryPlan): string {
  const { match } = plan;
  const scopeText =
    match.matchedBy === 'repo'
      ? `仓「${match.rule.repo}」（相对主仓根）`
      : '本空间通配副（档案 delivery 未限定 repo）';
  const lines: string[] = [
    `- 拉出基点：${plan.baseRef}${plan.baseSource === 'contract' ? '（来源=本单契约覆盖，契约优先于空间）' : '（来源=空间家规）'}`,
    `- 分支名：${plan.branchName}（家规模板 ${match.rule.branchName}）`,
    `- PR 目标分支：${plan.prTarget}（家规模板 ${match.rule.prTarget}）`,
  ];
  const gates = (match.rule.gates ?? []).filter((g) => g.trim());
  if (gates.length) lines.push(`- 人闸声明：${gates.map((g) => `「${g}」`).join('、')}——声明只说该有哪几道，图里编没编由收口对账核`);
  if (match.rule.note?.trim()) lines.push(`- 家规备注：${match.rule.note.trim()}`);
  if (plan.unresolved.length) {
    const detail = plan.unresolved.map((u) => `${u.field} 模板「${u.raw}」的 {${u.names.join('},{')}}`).join('；');
    lines.push(
      `- ⚠ 占位符未解析（${detail}）：{issue} 取本单 issueId、{run_id} 取 runId、其余取起单实填变量——` +
        `解析不到时引擎按家规建隔离工作目录会 fail-closed 拒建（节点即时红，绝不静默回退 paneflow/<run_id> 命名）`,
    );
  }
  return (
    `交付约定（本项目家规，${scopeText}，档案 delivery 第 ${match.index + 1} 条）——` +
    `PaneFlow 只声明与对账、不代跑 git push 也不代建 PR，下列约定请你在提交与开 PR 时自己遵守；` +
    `收口时引擎会与实态对账，落差只照不拦（PR 目标分支的核验在人闸位）：\n${lines.join('\n')}\n---\n`
  );
}

/**
 * ③对账层的纯图判据：本单的图里编了人闸没有。
 * 需求文档字面写「一个 approval 节点都没有」——按现实落：本仓 DagNodeType 六类里没有 approval
 * 节点类型，人在图上拦一道的真实形状是这四路（checks 的 manual/contract/delivery-branch
 * 与 clarify 澄清轮，都走 awaitGate 同一实现）。于是这里问的是「有没有任一节点挂了人闸位」。
 */
export function hasHumanGate(graph: DagGraph | undefined): boolean {
  const nodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
  return nodes.some((n) => {
    const cfg = n?.config ?? {};
    if (cfg.clarify) return true;
    const checks = Array.isArray(cfg.checks) ? cfg.checks : [];
    return checks.some((c) => c && (c.type === 'manual' || c.type === 'contract' || c.type === 'delivery-branch'));
  });
}

/** 家规声明的人闸名（清洗后；空数组=没声明，不是落差） */
export function declaredGateNames(rule: DeliveryRule): string[] {
  return (Array.isArray(rule.gates) ? rule.gates : []).filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim());
}
