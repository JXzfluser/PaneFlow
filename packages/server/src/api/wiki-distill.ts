import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import { gatewayOpenaiBase, readGateway } from './gateway.js';
import { ghCliToken, readGithubSettings, resolveGithubToken } from './github-cred.js';
import {
  latestAssertionResults,
  publishableRun,
  publishWikiPages,
  slugify,
  syncWikiCache,
  wikiCacheDir,
  WIKI_ROOT,
  type WikiPageDraft,
} from './wiki.js';
import { resolveRunRepo } from '../orchestrate/readback.js';

/**
 * v11-C1 蒸馏 + concept 旧页改写（知识复利写端升级）。
 * 沉淀不再只会每 run 堆一页流水账（summaries/）：把 run 里可泛化的经验蒸进
 * concepts/ 主题页，同主题第二次出现时**改写旧页**（created 保留、updated 真前进），
 * 这是 C4 实证的前置。
 * 分层：
 * - `distillEntries`：唯一的 LLM 触网面（服务端直连网关 /v1/chat/completions，
 *   照 gateway.ts probeGatewayModels 同款姿势，fetchImpl 注入可测）——
 *   不起 pane/agent 进程（重、占 D1 配额、不可测）；一切失败回空数组=静默弃，
 *   **绝不阻塞或弄红任何收口路径**。
 * - `planDistill`：纯函数蒸馏核——entries + 既有 concepts 页清单 → 页操作集
 *   （命中→改写；未命中→新建），index 条目按 file 去重（改写不增条：C1 核心验收）。
 * - `buildDistillPreview` / `autoDistillRun`：编排队列（手动端点回预览、
 *   绿 run 收口后自动路一次 commit 多文件 push）。
 */

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

/** LLM 提取的一条可泛化经验（topic=主题归一化的锚；evidenceRun 缺省回落本单） */
export interface DistillEntry {
  topic: string;
  statement: string;
  evidenceRun?: string;
}

/** 一条页操作：新页（create）或改写页（update），面与 WikiPageDraft 对齐可直接进发布队列 */
export interface DistillPageOp extends WikiPageDraft {
  action: 'create' | 'update';
  topic: string;
  /** 本次并入的新条目数（改写时 ≥1 才出操作——全重复不出空操作） */
  added: number;
}

/** 本地缓存里的一张既有 concept 页（planDistill 的匹配输入） */
export interface ConceptPage {
  /** 相对 `llm-wiki/` 落点根，如 `concepts/重试退避.md` */
  file: string;
  slug: string;
  title: string;
  created: string;
  updated: string;
  frontmatter: Record<string, string>;
  /** frontmatter 之后的正文原文 */
  body: string;
}

// ---------------------------------------------------------------------------
// 主题归一化与命中规则
// ---------------------------------------------------------------------------

/**
 * 主题归一化：与落盘文件名同一把尺子（wiki.ts slugify——sanitize + 小写 +
 * 只留字母数字/中文/连字符），在此之上比较时再抹掉连字符——中文词间的空格会被
 * slugify 打成 `-`，「登录页样式 守则」与「登录页样式守则」必须算同一主题。
 * 命中规则（任一条即算命中既有页 → 走改写）：
 * ①归一化后 topic === 页文件 slug；
 * ②归一化后互为包含（topic ⊆ 页 slug 或 页 slug ⊆ topic）——中文没有词形变化，
 *   「重试退避策略」与「重试退避」这类近义必须归同一页，否则复利永远聚不起来。
 */
export function matchConceptPage(topic: string, pages: ConceptPage[]): ConceptPage | undefined {
  const t = slugify(topic).replace(/-/g, '');
  if (!t) return undefined;
  return pages.find((p) => {
    const s = p.slug.replace(/-/g, '');
    return Boolean(s) && (s === t || s.includes(t) || t.includes(s));
  });
}

// ---------------------------------------------------------------------------
// 既有 concept 页读取（零网络，只吃本地缓存克隆）
// ---------------------------------------------------------------------------

function parseFmBlock(fmRaw: string | undefined): Record<string, string> {
  const fm: Record<string, string> = {};
  if (!fmRaw) return fm;
  for (const line of fmRaw.split('\n')) {
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (m) fm[m[1]!] = m[2]!.trim();
  }
  return fm;
}

/** 从本地缓存的 `llm-wiki/concepts/` 读既有主题页；落点缺失/为空返回空不抛。 */
export function listConceptPages(dataDir: string, repo: string): ConceptPage[] {
  const root = path.join(wikiCacheDir(dataDir, repo), WIKI_ROOT, 'concepts');
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const out: ConceptPage[] = [];
  for (const name of names.slice(0, 64)) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(root, name), 'utf8').slice(0, 64 * 1024);
    } catch {
      continue;
    }
    const fmBlock = raw.startsWith('---\n') ? /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] : undefined;
    const frontmatter = parseFmBlock(fmBlock);
    const body = raw.replace(/^---[\s\S]*?---\n?/, '');
    const title = (frontmatter.title ?? '').replace(/^["']|["']$/g, '');
    out.push({
      file: `concepts/${name}`,
      slug: name.replace(/\.md$/, ''),
      title: title || name.replace(/\.md$/, ''),
      created: frontmatter.created ?? '',
      updated: frontmatter.updated ?? '',
      frontmatter,
      body,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 纯函数蒸馏核：entries → 页操作集
// ---------------------------------------------------------------------------

const ENTRIES_HEADING = '## 经验条目';

function q(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
}

/** 从 `key: ["a", "b"]` 形态的 frontmatter 值拆出字符串数组 */
function fmList(v: string | undefined): string[] {
  if (!v) return [];
  const inner = /^\[(.*)\]$/.exec(v)?.[1] ?? '';
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** 正文里已入册的经验陈述（剥「- 」前缀与「（来源: …）」后缀，空白归一） */
function existingStatements(body: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, '');
  return body
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => {
      const m = /^- (.*)（来源:/.exec(l);
      return norm(m ? m[1]! : l.slice(2));
    });
}

function renderEntriesFile(o: {
  title: string;
  tags: string;
  created: string;
  updated: string;
  sources: string[];
  runs: string[];
  repo: string;
  statements: { text: string; runId: string; date: string }[];
  preamble: string;
}): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: "${q(o.title)}"`);
  lines.push('type: concept');
  lines.push(`tags: [${o.tags}]`);
  lines.push(`created: ${o.created}`);
  lines.push(`updated: ${o.updated}`);
  lines.push(`sources: [${o.sources.map((s) => `"${q(s)}"`).join(', ')}]`);
  lines.push('confidence: high');
  lines.push(`pf-repo: ${q(o.repo)}`);
  lines.push(`pf-runs: [${o.runs.join(', ')}]`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${o.title}`);
  lines.push('');
  lines.push(o.preamble);
  lines.push('');
  lines.push(ENTRIES_HEADING);
  lines.push('');
  for (const s of o.statements) lines.push(`- ${s.text}（来源: run \`${s.runId}\` · ${s.date}）`);
  lines.push('');
  return lines.join('\n');
}

const CREATE_PREAMBLE =
  '> PaneFlow 蒸馏主题页：从绿 run 蒸出的可泛化经验，同主题再出现时改写本页累积。条目须有 run 证据背书；推翻旧条目请新增条目说明，别直接删。';

/**
 * 纯函数蒸馏核：一次 run 蒸出的 entries + 既有 concept 页清单 → 页操作集。
 * - 命中（matchConceptPage 规则）→ **改写**：原 created/title/tags 逐字保留、
 *   `updated=now`，新经验按行并入「## 经验条目」列表（陈述词面行级去重，全重复不出空操作）；
 * - 未命中 → 新建 `concepts/<slug>.md`；
 * - 每操作一条 log 记账；index 条目按 file 生成——改写与原页同 file，
 *   mergeWikiIndex 原位替换 → **index 不增条**（C1 核心验收）。
 */
export function planDistill(o: {
  run: RunRecord;
  repo: string;
  entries: DistillEntry[];
  existing: ConceptPage[];
  now?: string;
}): DistillPageOp[] {
  const now = o.now ?? new Date().toISOString();
  const today = now.slice(0, 10);
  // 同主题多条 entry 聚到同一页（命中页优先，其次首条 topic 的 slug）
  const groups = new Map<string, { hit?: ConceptPage; topic: string; items: DistillEntry[] }>();
  for (const e of o.entries) {
    const topic = e.topic.trim();
    const statement = e.statement.trim();
    if (!topic || !statement) continue;
    const hit = matchConceptPage(topic, o.existing);
    const key = hit ? hit.file : `concepts/${slugify(topic)}.md`;
    const g = groups.get(key) ?? { hit, topic, items: [] };
    g.items.push(e);
    groups.set(key, g);
  }
  const ops: DistillPageOp[] = [];
  for (const [file, g] of groups) {
    const runId = o.run.runId;
    if (!g.hit) {
      const rendered = g.items.map((e) => ({ text: e.statement.trim(), runId: e.evidenceRun?.trim() || runId, date: today }));
      const markdown = renderEntriesFile({
        title: g.topic,
        tags: `paneflow, concept${o.run.spaceId ? `, ${q(o.run.spaceId)}` : ''}`,
        created: now,
        updated: now,
        sources: [`paneflow:run/${runId}`, `repo:${o.repo}`],
        runs: [runId],
        repo: o.repo,
        statements: rendered,
        preamble: CREATE_PREAMBLE,
      });
      ops.push({
        action: 'create',
        topic: g.topic,
        added: rendered.length,
        file,
        markdown,
        indexEntry: `- [${q(g.topic)}](${file}) —— 经验条目 ${rendered.length} 条（run \`${runId}\`，${today}）`,
        logNote: `- ${now} · 蒸馏 run \`${runId}\` → \`${file}\`（新建 +${rendered.length} 条）`,
      });
      continue;
    }
    // 改写路：行级去重——页上已有的陈述（词面空白归一后相等）不再并入
    const seen = new Set(existingStatements(g.hit.body));
    const fresh: { text: string; runId: string; date: string }[] = [];
    const seenBatch = new Set<string>();
    for (const e of g.items) {
      const text = e.statement.trim();
      const norm = text.replace(/\s+/g, '');
      if (seen.has(norm) || seenBatch.has(norm)) continue;
      seenBatch.add(norm);
      fresh.push({ text, runId: e.evidenceRun?.trim() || runId, date: today });
    }
    if (!fresh.length) continue;
    const addLines = fresh.map((f) => `- ${f.text}（来源: run \`${f.runId}\` · ${f.date}）`);
    // 正文合并策略：新条目作为 bullet 行追加进「## 经验条目」小节末尾
    // （小节缺失则整节补在页尾）；小节外的原有内容逐字保留。
    const bodyTrimmed = g.hit.body.replace(/\s+$/, '');
    const bodyLines = bodyTrimmed.split('\n');
    const hIdx = bodyLines.findIndex((l) => l.trim() === ENTRIES_HEADING);
    let mergedBody: string;
    if (hIdx < 0) {
      mergedBody = `${bodyTrimmed}\n\n${ENTRIES_HEADING}\n\n${addLines.join('\n')}\n`;
    } else {
      let end = hIdx + 1;
      while (end < bodyLines.length && !/^##\s/.test(bodyLines[end]!)) end++;
      let ins = end;
      while (ins > hIdx + 1 && bodyLines[ins - 1]!.trim() === '') ins--;
      const lines = [...bodyLines];
      lines.splice(ins, 0, ...addLines);
      mergedBody = `${lines.join('\n')}\n`;
    }
    // frontmatter：created/title/tags 逐字保留；updated 前进；sources/pf-runs 并集
    const title = g.hit.frontmatter.title ? g.hit.frontmatter.title.replace(/^["']|["']$/g, '') : g.hit.title;
    const tags = g.hit.frontmatter.tags ?? 'paneflow, concept';
    const created = g.hit.created || g.hit.updated || now;
    const sources = [...new Set([...fmList(g.hit.frontmatter.sources), `paneflow:run/${runId}`, `repo:${o.repo}`])];
    const runs = [...new Set([...fmList(g.hit.frontmatter['pf-runs']), runId])];
    const statements = mergedBody
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => {
        const m = /^- (.*)（来源: run `([^`]+)` · ([\d-]+)）/.exec(l);
        return m ? { text: m[1]!, runId: m[2]!, date: m[3]! } : { text: l.slice(2), runId, date: today };
      });
    const preamble =
      bodyTrimmed
        .split('\n')
        .filter((l) => l.startsWith('>'))
        .join('\n') || CREATE_PREAMBLE;
    const markdown = renderEntriesFile({
      title,
      tags,
      created,
      updated: now,
      sources,
      runs,
      repo: o.repo,
      statements,
      preamble,
    });
    ops.push({
      action: 'update',
      topic: g.topic,
      added: fresh.length,
      file,
      markdown,
      // 与原页同 file → mergeWikiIndex 原位替换，index 条目数不变（C1 核心验收）
      indexEntry: `- [${q(title)}](${file}) —— 经验条目 ${statements.length} 条（run \`${runId}\`，${today}）`,
      logNote: `- ${now} · 蒸馏 run \`${runId}\` → \`${file}\`（改写 +${fresh.length} 条）`,
    });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// LLM 提取（唯一触网面；失败=空数组静默弃）
// ---------------------------------------------------------------------------

const DISTILL_SYSTEM =
  '你是软件研发经验蒸馏器。输入是一条已验收通过的 run 的事实面与既有主题页清单。' +
  '只输出一个 JSON 数组（不要代码块之外的任何文字、不要解释），形如 ' +
  '[{"topic":"主题词","statement":"可泛化经验","evidenceRun":"run id"}]，最多 5 条。' +
  '规矩：statement 必须带这条 run 里的具体证据（断言结论/实测数字/踩过的坑），禁空话套话（如「要写好测试」「注意边界」）；' +
  'topic 用简短主题词（2~14 字）；主题在既有清单里已有同名/近义页时，必须复用既有主题词——这会改写旧页而不是另起新页。';

function clip(s: string, cap: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** 从 run 记录拼经验蒸馏的事实面输入（wrapup/验收产物 + 契约 + 读回留痕） */
export function distillRunBrief(run: RunRecord, existingTitles: string[], readbackFiles: string[]): string {
  const parts: string[] = [];
  parts.push(`【run】${run.dagName}（id: ${run.runId}）${run.issueId ? ` issue #${run.issueId}` : ''}`);
  const assertions = run.contract?.assertions ?? [];
  const results = latestAssertionResults(run);
  if (assertions.length) {
    parts.push('【契约断言与实测结果】');
    for (const a of assertions) {
      const r = results.find((x) => x.id === a.id);
      parts.push(`- ${a.id} ${clip(a.assertion, 120)} → ${r ? `${r.status}：${clip(r.evidence, 160)}` : '没跑'}`);
    }
  }
  const summaries = Object.values(run.nodes).filter((n) => n.artifact?.summary);
  if (summaries.length) {
    parts.push('【节点结论】');
    for (const n of summaries) parts.push(`- ${n.nodeId}：${clip(String(n.artifact!.summary), 300)}`);
  }
  const tail = [...summaries].reverse().find((n) => n.artifact?.outputTail)?.artifact?.outputTail;
  if (tail) parts.push(`【终端尾部（截断）】${clip(tail, 600)}`);
  parts.push(`【既有 concept 主题页】${existingTitles.length ? existingTitles.join('、') : '（无——这是第一批主题页）'}`);
  if (readbackFiles.length) parts.push(`【本单起跑时真读过的沉淀页】${readbackFiles.join('、')}`);
  parts.push('请只输出 JSON 数组。');
  return parts.join('\n');
}

/** 从 LLM 回文本里抠出 JSON 数组（容忍代码围栏/前后闲话）；任何解析失败回空 */
export function parseDistillReply(text: string): DistillEntry[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
      .map((x) => ({
        topic: typeof x.topic === 'string' ? x.topic.trim() : '',
        statement: typeof x.statement === 'string' ? x.statement.trim() : '',
        evidenceRun: typeof x.evidenceRun === 'string' ? x.evidenceRun.trim() : undefined,
      }))
      .filter((e) => e.topic.length >= 2 && e.statement.length >= 4)
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * 一次网关 chat/completions 调用蒸出 entries。**永不抛**：解析失败/超时/
 * HTTP 非 2xx/网关未配一律回空数组=静默弃——蒸馏是纯加分项，绝不阻塞或弄红收口路径。
 */
export async function distillEntries(
  run: RunRecord,
  opts: {
    dataDir: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    existingTitles?: string[];
    readbackFiles?: string[];
  },
): Promise<DistillEntry[]> {
  try {
    const base = gatewayOpenaiBase(opts.dataDir);
    const g = readGateway(opts.dataDir);
    if (!base || !g.apiKey) return [];
    const user = distillRunBrief(run, opts.existingTitles ?? [], opts.readbackFiles ?? []);
    const res = await (opts.fetchImpl ?? fetch)(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${g.apiKey}` },
      body: JSON.stringify({
        model: g.freeModel || 'auto',
        messages: [
          { role: 'system', content: DISTILL_SYSTEM },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 2000,
        stream: false,
      }),
      // 蒸馏在收口后/手动请求里跑：90s 封顶，超时=静默弃，不吊着调用方
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return [];
    const entries = parseDistillReply(content);
    // evidenceRun 缺省/被模型编造都洗成本单 id：蒸馏证据链只认这一单
    return entries.map((e) => ({ ...e, evidenceRun: run.runId }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 编排：预览（手动端点）与自动蒸（绿 run 收口后）
// ---------------------------------------------------------------------------

export interface DistillPreview {
  entries: DistillEntry[];
  ops: DistillPageOp[];
  /** 查询失败原因（同步缓存炸了等）——手动端点据此回 502 + reason */
  error?: string;
}

type SyncFn = (o: { dataDir: string; repo: string; token: string; maxAgeMs?: number }) => Promise<{ branch: string }>;

export interface DistillDeps {
  fetchImpl?: typeof fetch;
  sync?: SyncFn;
  readGhCliToken?: () => Promise<string>;
  publish?: typeof publishWikiPages;
  now?: string;
  /** 注入点：readRemote 供测试绕开真实 git（resolveRunRepo 探针） */
  readRemote?: (dir: string) => string | null;
}

/** 同步缓存（保 concept 清单新鲜）→ 读既有页 → LLM 提取 → 纯函数规划。同步失败回 error 不抛。 */
export async function buildDistillPreview(o: {
  dataDir: string;
  run: RunRecord;
  repo: string;
  token: string;
}, deps: DistillDeps = {}): Promise<DistillPreview> {
  const { dataDir, run, repo, token } = o;
  try {
    await (deps.sync ?? syncWikiCache)({ dataDir, repo, token, maxAgeMs: 0 });
  } catch (e) {
    return { entries: [], ops: [], error: `刷新 wiki 缓存失败：${(e as Error).message}` };
  }
  const existing = listConceptPages(dataDir, repo);
  const readbackFiles = [...new Set((run.wikiReadback?.nodes ?? []).flatMap((n) => n.pages.map((p) => p.file)))];
  const entries = await distillEntries(run, {
    dataDir,
    fetchImpl: deps.fetchImpl,
    existingTitles: existing.map((p) => p.title),
    readbackFiles,
  });
  const ops = planDistill({ run, repo, entries, existing, now: deps.now });
  return { entries, ops };
}

/**
 * v11-C1 自动蒸开关：默认 **off**（与 C3a 读回「默认 on」恰好相反）。
 * 理由：读端只吃本地缓存、默认开零风险面；写端的自动路会在**未经用户点头**时
 * 直接 push main——「宁缺毋滥」的门风（C2）不动，开关等 C4 实证（改写概念页
 * 是否真提升读端）说话后再由人决定开不开。env PF_WIKI_DISTILL=on 显式开。
 */
export function autoDistillEnabled(opt: 'on' | 'off' | undefined): boolean {
  return (opt ?? process.env.PF_WIKI_DISTILL ?? 'off').trim().toLowerCase() === 'on';
}

export interface DistillOutcome {
  ok: boolean;
  reason?: string;
  entries: DistillEntry[];
  ops: DistillPageOp[];
  pushed?: { url: string; files: string[] };
}

/**
 * 自动路执行体（绿 run 收口后 fire-and-forget 调）：门复用 publishableRun fail-closed
 * 绿门——不绿的单不蒸；无凭据/认不出仓/蒸出空操作集都静默收场。
 * **永不 reject**：任何意外都折进 outcome.reason，收口路径吃不到异常。
 */
export async function autoDistillRun(
  dataDir: string,
  run: RunRecord,
  deps: DistillDeps = {},
): Promise<DistillOutcome> {
  const empty: DistillOutcome = { ok: false, entries: [], ops: [] };
  try {
    const gate = publishableRun(run);
    if (!gate.ok) return { ...empty, reason: `门不过不蒸：${gate.reason}` };
    const token = await resolveGithubToken(dataDir, deps.readGhCliToken ?? ghCliToken);
    if (!token) return { ...empty, reason: '无 GitHub 凭据，跳过自动蒸' };
    const repo = resolveRunRepo({
      cwd: run.cwd,
      contractRepo: run.contract?.repo,
      defaultRepo: readGithubSettings(dataDir).defaultRepo,
      ...(deps.readRemote ? { readRemote: deps.readRemote } : {}),
    });
    if (!repo) return { ...empty, reason: '认不出蒸馏目标仓（cwd origin / 契约 repo / 默认仓全落空）' };
    const preview = await buildDistillPreview({ dataDir, run, repo, token }, deps);
    if (preview.error) return { ...empty, reason: preview.error };
    if (!preview.ops.length) return { ok: true, entries: preview.entries, ops: [] };
    const r = await (deps.publish ?? publishWikiPages)({ dataDir, repo, token, pages: preview.ops });
    return { ok: true, entries: preview.entries, ops: preview.ops, pushed: { url: r.url, files: r.files } };
  } catch (e) {
    return { ...empty, reason: `自动蒸失败（已静默）：${(e as Error).message}` };
  }
}
