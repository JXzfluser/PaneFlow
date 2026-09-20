import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';

/**
 * v9-K wiki 沉淀 + 首驾-llmwiki（Issue #6）+ Issue #7 落点改造：绿 run + 用户点赞 →
 * 蒸馏成 llm-wiki 风格页（七字段 frontmatter + 分类目录）+ index/log 记账，
 * push 到**主仓默认分支的 `llm-wiki/` 目录**（只依赖 Contents 权限，细粒度 PAT 可推；
 * 不再走 `<repo>.wiki.git`——dotcom 上该仓库需网页人工初始化且不支持细粒度 PAT）。
 * K2 读回复用同一缓存目录，只认 `llm-wiki/` 子树。
 * 所有 git/网络失败都抛可读错误（失败可见不吞）。
 */

export type WikiType = 'concept' | 'entity' | 'summary' | 'synthesis';

const WIKI_DIRS: Record<WikiType, string> = {
  concept: 'concepts',
  entity: 'entities',
  summary: 'summaries',
  synthesis: 'syntheses',
};

export interface WikiPageDraft {
  /** 相对 wiki 仓库根的路径，如 `summaries/修登录页样式-abc123.md` */
  file: string;
  markdown: string;
  /** index.md 一行条目：markdown 相对链接 + 一行摘要（按 file 路径去重） */
  indexEntry: string;
  /** log.md 一条只追加记录：ISO 时间 + run id + 落页路径 */
  logNote: string;
}

function clip(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function sanitizeTitle(s: string): string {
  return s.replace(/[/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run';
}

/** 文件名 slug：sanitize + 小写 + 只留字母数字/中文/连字符（llm-wiki 小写连字符约定） */
function slugify(s: string): string {
  const out = sanitizeTitle(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'run';
}

/** frontmatter 值安全：折行压平、去双引号 */
function fmVal(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
}

/** 产物 extra.assertionResults 里最后一份带结果的（验收/终审节点覆盖实现节点的自测） */
export function latestAssertionResults(run: RunRecord): { id: string; status: string; evidence: string }[] {
  let best: { id: string; status: string; evidence: string }[] = [];
  for (const n of Object.values(run.nodes)) {
    const raw = (n.artifact?.extra as Record<string, unknown> | undefined)?.assertionResults;
    if (!Array.isArray(raw)) continue;
    const rows = raw
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
      .filter((x) => typeof x.id === 'string' && typeof x.status === 'string')
      .map((x) => ({
        id: String(x.id),
        status: String(x.status),
        evidence: typeof x.evidence === 'string' ? x.evidence : '',
      }));
    if (rows.length) best = rows;
  }
  return best;
}

/** 绿 run 判据（K3 宁缺毋滥的门面）：completed + 全节点 done + 无兜底产物 + 断言无 fail */
export function publishableRun(run: RunRecord | undefined): { ok: boolean; reason?: string } {
  if (!run) return { ok: false, reason: '找不到该 run' };
  if (run.state !== 'completed') return { ok: false, reason: `只有跑完且绿的单能沉淀（当前状态：${run.state}）` };
  const nodes = Object.values(run.nodes);
  if (nodes.some((n) => n.unverified)) return { ok: false, reason: '有节点的产物来自终端兜底（未经验证），不沉淀' };
  const failed = latestAssertionResults(run).filter((r) => r.status === 'fail');
  if (failed.length) return { ok: false, reason: `验收断言有 ${failed.length} 条未过，不沉淀` };
  return { ok: true };
}

/**
 * 纯函数：run → llm-wiki 页。七字段 frontmatter（title/type/tags/created/updated/
 * sources/confidence，缺省有确定兜底）+ pf-* 溯源扩展键 + 断言表 + 节点结论 + 经验账本 + 双链；
 * 附 index 条目与 log 记录两条记账字符串。
 */
export function renderWikiPage(
  run: RunRecord,
  opts: { repo: string; now?: string; type?: WikiType },
): WikiPageDraft {
  const now = opts.now ?? new Date().toISOString();
  const type: WikiType = opts.type ?? 'summary';
  const slug = `${slugify(run.dagName)}-${run.runId.slice(-6).toLowerCase()}`;
  const file = `${WIKI_DIRS[type]}/${slug}.md`;
  const pageTitle = fmVal(`${run.dagName}（run ${run.runId}）`);
  const results = latestAssertionResults(run);
  const sources = [`paneflow:run/${run.runId}`, `repo:${opts.repo}`, `dag:${fmVal(run.dagName)}`];
  if (run.prUrl) sources.push(fmVal(run.prUrl));
  const confidence = results.length && results.every((r) => r.status === 'ok') ? 'high' : 'medium';
  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: "${pageTitle}"`);
  lines.push(`type: ${type}`);
  lines.push(`tags: [paneflow, run-record${run.spaceId ? `, ${fmVal(run.spaceId)}` : ''}]`);
  lines.push(`created: ${run.startedAt || now}`);
  lines.push(`updated: ${now}`);
  lines.push(`sources: [${sources.map((s) => `"${s}"`).join(', ')}]`);
  lines.push(`confidence: ${confidence}`);
  lines.push(`pf-run: ${run.runId}`);
  lines.push(`pf-repo: ${opts.repo}`);
  lines.push(`pf-dag: ${fmVal(run.dagName)}`);
  if (run.spaceId) lines.push(`pf-space: ${run.spaceId}`);
  if (run.contract) lines.push(`pf-contract-source: ${run.contract.source}`);
  lines.push(`pf-published: ${now}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${run.dagName}（run \`${run.runId}\`）`);
  lines.push('');
  lines.push(`> 本页由 PaneFlow 从一条绿 run 自动沉淀。同类单子看 [[${sanitizeTitle(run.dagName)}]]，总入口 [[Home]]。`);
  lines.push('');
  lines.push('## 任务与交付');
  lines.push(`- 工作目录：\`${run.cwd}\``);
  if (run.issueId) lines.push(`- 关联 Issue：#${run.issueId}`);
  if (run.prUrl) lines.push(`- 交付 PR：${run.prUrl}`);
  const steps = Object.values(run.nodes).filter((n) => n.agentName);
  lines.push(`- 执行节点 ${steps.length} 个：${steps.map((n) => `${n.nodeId}(${n.agentName})`).join('、') || '—'}`);
  lines.push('');
  if (run.contract?.assertions.length) {
    lines.push('## 契约与验收结论');
    lines.push('');
    lines.push('| AC | 断言 | 结果 | 证据 |');
    lines.push('| --- | --- | --- | --- |');
    for (const a of run.contract.assertions) {
      const r = results.find((x) => x.id === a.id);
      lines.push(
        `| ${a.id} | ${clip(a.assertion.replace(/\|/g, '\\|'), 120)} | ${r ? (r.status === 'ok' ? '✅ ok' : `❌ ${r.status}`) : '—'} | ${clip((r?.evidence || '').replace(/\|/g, '\\|').replace(/\n/g, ' '), 160)} |`,
      );
    }
    lines.push('');
  }
  const summaries = steps.filter((n) => n.artifact?.summary);
  if (summaries.length) {
    lines.push('## 各节点结论');
    for (const n of summaries) lines.push(`- **${n.nodeId}**：${clip(String(n.artifact!.summary).replace(/\n+/g, ' '), 300)}`);
    lines.push('');
  }
  lines.push('## 经验账本');
  if (run.cost) {
    const mins = (run.cost.totalMs / 60000).toFixed(1);
    const tokens = run.cost.tokens ? `in ${run.cost.tokens.input} / out ${run.cost.tokens.output}` : 'unknown（agent 未自报，不估算）';
    lines.push(`- 用时 ${mins} 分钟 · 重试 ${run.cost.retries} 次 · tokens ${tokens}`);
  }
  if (run.variables && Object.keys(run.variables).length) {
    lines.push(`- 实填变量：${Object.entries(run.variables).map(([k, v]) => `\`${k}=${clip(v, 60)}\``).join(' · ')}`);
  }
  lines.push(`- 时间：起 ${run.startedAt.slice(0, 16).replace('T', ' ')}${run.finishedAt ? ` · 止 ${run.finishedAt.slice(0, 16).replace('T', ' ')}` : ''}`);
  lines.push('');
  const total = run.contract?.assertions.length ?? results.length;
  const passed = results.filter((r) => r.status === 'ok').length;
  const digest = total ? `${passed}/${total} 条验收通过` : '无验收断言';
  return {
    file,
    markdown: lines.join('\n'),
    indexEntry: `- [${pageTitle}](${file}) —— ${digest}（run \`${run.runId}\`，${now.slice(0, 10)}）`,
    logNote: `- ${now} · run \`${run.runId}\` → \`${file}\`（${digest}）`,
  };
}

/** index.md 合并（纯函数）：同 file 路径的旧条目原位替换（去重），没有则追加 */
export function mergeWikiIndex(
  existing: string,
  entry: { file: string; line: string },
): string {
  if (!existing.trim()) return `# 索引\n\n${entry.line}\n`;
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.includes(`](${entry.file})`));
  if (i >= 0) {
    lines[i] = entry.line;
    return lines.join('\n');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n${entry.line}\n`;
}

/** log.md 追加（纯函数）：只追加不改动，旧记录逐字保留 */
export function appendWikiLog(existing: string, note: string): string {
  if (!existing.trim()) return `# 沉淀日志\n\n${note}\n`;
  return `${existing.replace(/\s+$/, '')}\n${note}\n`;
}

// -- GitHub 可见性 + git 操作 -------------------------------------------------

const API = 'https://api.github.com';

export async function checkRepoVisibility(
  repo: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'public' | 'private'> {
  const res = await fetchImpl(`${API}/repos/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
  const body = (await res.json()) as { private?: boolean };
  return body.private ? 'private' : 'public';
}

export function wikiCacheDir(dataDir: string, repo: string): string {
  return path.join(dataDir, 'wiki-cache', repo.replace(/[^a-zA-Z0-9._-]+/g, '_'));
}

/** Issue #7：沉淀落点 = 主仓默认分支的 `llm-wiki/` 目录（只依赖 Contents 权限，细粒度 PAT 可推） */
export const WIKI_ROOT = 'llm-wiki';

/**
 * v11-C0：零网络读本地缓存克隆的当前分支——直接读 .git/HEAD 符号引用
 * （wikiState 是同步函数，不复用 syncWikiCache 里的 async git rev-parse）。
 * 缓存不存在 / detached HEAD / 读不到一律回退 'main'。
 */
export function readWikiCacheBranch(dataDir: string, repo: string): string {
  try {
    const head = fs.readFileSync(path.join(wikiCacheDir(dataDir, repo), '.git', 'HEAD'), 'utf8').trim();
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? 'main';
  } catch {
    return 'main';
  }
}

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} 失败：${(stderr || err.message).trim().slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

function repoPlainUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function repoAuthUrl(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/**
 * clone/更新主仓缓存到默认分支最新（shallow + sparse 只物化 llm-wiki/ 子树）。
 * token 不进 .git/config：操作完把 origin 洗回无密钥地址。返回本地所在分支（=克隆时的默认分支）。
 */
export async function syncWikiCache(o: { dataDir: string; repo: string; token?: string; maxAgeMs?: number }): Promise<{ branch: string }> {
  const dir = wikiCacheDir(o.dataDir, o.repo);
  const marker = path.join(dir, '.pf-synced');
  const fresh = (() => {
    try {
      return Date.now() - fs.statSync(marker).mtimeMs < (o.maxAgeMs ?? 5 * 60_000);
    } catch {
      return false;
    }
  })();
  const plain = repoPlainUrl(o.repo);
  const remote = o.token ? repoAuthUrl(o.repo, o.token) : plain;
  if (!fresh) {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git(['clone', '--depth', '1', '--sparse', remote, dir]);
    } else {
      await git(['remote', 'set-url', 'origin', plain], dir).catch(() => undefined);
      await git(['fetch', '--depth', '1', remote, 'HEAD'], dir);
      await git(['reset', '--hard', 'FETCH_HEAD'], dir);
    }
    await git(['sparse-checkout', 'set', WIKI_ROOT], dir);
    await git(['remote', 'set-url', 'origin', plain], dir).catch(() => undefined);
    fs.writeFileSync(marker, new Date().toISOString());
  }
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).catch(() => 'main')).trim() || 'main';
  return { branch };
}

function readIf(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** 一次落点尝试：同步 → 写页（llm-wiki/<分类>/）→ index/log 记账 → commit → push 默认分支。失败抛错（不吞）。 */
async function publishAttempt(o: {
  dataDir: string;
  repo: string;
  token: string;
  page: WikiPageDraft;
}): Promise<{ url: string; cacheDir: string; files: string[]; branch: string }> {
  const { branch } = await syncWikiCache({ dataDir: o.dataDir, repo: o.repo, token: o.token, maxAgeMs: 0 });
  const dir = wikiCacheDir(o.dataDir, o.repo);
  const root = path.join(dir, WIKI_ROOT);
  const pageAbs = path.join(root, o.page.file);
  fs.mkdirSync(path.dirname(pageAbs), { recursive: true });
  fs.writeFileSync(pageAbs, o.page.markdown);
  fs.writeFileSync(path.join(root, 'index.md'), mergeWikiIndex(readIf(path.join(root, 'index.md')), { file: o.page.file, line: o.page.indexEntry }));
  fs.writeFileSync(path.join(root, 'log.md'), appendWikiLog(readIf(path.join(root, 'log.md')), o.page.logNote));
  const files = [`${WIKI_ROOT}/${o.page.file}`, `${WIKI_ROOT}/index.md`, `${WIKI_ROOT}/log.md`];
  await git(['add', '--', ...files], dir);
  await git(['commit', '-m', `PaneFlow 沉淀: ${o.page.file}`], dir).catch((e: Error) => {
    if (!/nothing to commit/i.test(e.message)) throw e;
  });
  await git(['push', repoAuthUrl(o.repo, o.token), `HEAD:${branch}`], dir);
  return {
    url: `https://github.com/${o.repo}/blob/${branch}/${WIKI_ROOT}/${o.page.file}`,
    cacheDir: dir,
    files,
    branch,
  };
}

/**
 * Issue #7 发布：落点为主仓 `llm-wiki/` 目录（只吃 Contents 权限，不再依赖 `<repo>.wiki.git`）。
 * push 撞远端前移（交付链刚推过 main）时重同步再试一次，仍失败才抛。
 */
export async function publishWikiPage(o: {
  dataDir: string;
  repo: string;
  token: string;
  page: WikiPageDraft;
}): Promise<{ url: string; cacheDir: string; files: string[] }> {
  try {
    return await publishAttempt(o);
  } catch (e) {
    const msg = (e as Error).message;
    if (!/git push 失败/.test(msg)) throw e;
    return await publishAttempt(o);
  }
}

// -- K2 读回：本地页挑选 + 摘要 -------------------------------------------------

export interface WikiPage {
  /** 相对 `llm-wiki/` 落点根的路径：嵌套页如 `summaries/x.md`，扁平页如 `y.md` */
  file: string;
  title: string;
  text: string;
}

const PAGE_CAP = 64;
const PAGE_BYTES = 32 * 1024;

/** 记账文件不参与读回/摘录（任何层级都排除） */
function isBookkeeping(rel: string): boolean {
  const base = path.basename(rel);
  return base === 'index.md' || base === 'log.md';
}

/** 递归收集 .md 相对路径（跳过 .git/隐藏项）；旧扁平页与分类目录页混放也能列全 */
function walkMarkdown(dir: string, rel: string, out: string[]): void {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkMarkdown(path.join(dir, e.name), r, out);
    else if (e.name.endsWith('.md') && !isBookkeeping(r)) out.push(r);
  }
}

function titleFromPath(rel: string): string {
  return path.basename(rel).replace(/\.md$/, '').replace(/-/g, ' ');
}

/** 从缓存的主仓 `llm-wiki/` 子树读 md 页：frontmatter title 优先，缺省回退文件名；正文留给摘要。落点缺失/为空返回空不抛。 */
export function readWikiPages(dataDir: string, repo: string): WikiPage[] {
  const dir = path.join(wikiCacheDir(dataDir, repo), WIKI_ROOT);
  const files: string[] = [];
  walkMarkdown(dir, '', files);
  return files.sort().slice(0, PAGE_CAP).map((rel) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, rel), 'utf8').slice(0, PAGE_BYTES);
    } catch {
      return { file: rel, title: titleFromPath(rel), text: '' };
    }
    const fm = text.startsWith('---\n') ? /^---\n([\s\S]*?)\n---/.exec(text)?.[1] : undefined;
    const fmTitle = fm ? /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm)?.[1]?.trim() : undefined;
    const body = text.replace(/^---[\s\S]*?---\n?/, '');
    return { file: rel, title: fmTitle || titleFromPath(rel), text: body };
  });
}

function tokens(q: string): string[] {
  return (q.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fa5]{2,8}/g) ?? []).filter((t) => t.length >= 2);
}

/** 与需求文本相关度 top-N：标题命中加权，正文按出现次数；无命中返回空（宁缺毋滥） */
export function pickWikiExcerpts(
  pages: WikiPage[],
  query: string,
  limit = 3,
): { label: string; text: string }[] {
  const ts = tokens(query);
  if (!ts.length) return [];
  const scored = pages
    .map((p) => {
      const hay = `${p.title}\n${p.text}`.toLowerCase();
      const titleHay = p.title.toLowerCase();
      let score = 0;
      for (const t of ts) {
        if (titleHay.includes(t)) score += 3;
        let i = -1;
        let n = 0;
        while ((i = hay.indexOf(t, i + 1)) >= 0 && n < 6) {
          n++;
          score += 1;
        }
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(({ p }) => {
    const para =
      p.text
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .find((s) => s && !s.startsWith('#') && !s.startsWith('>')) ?? p.text.trim();
    return { label: `wiki 沉淀页（${p.file}）`, text: clip(para.replace(/\n+/g, ' '), 240) };
  });
}
