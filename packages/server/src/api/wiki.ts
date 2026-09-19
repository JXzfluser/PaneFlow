import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';

/**
 * v9-K wiki 沉淀：绿 run + 用户点赞 → 蒸馏成带 frontmatter/双链的 md 页，
 * 浅克龙 `<repo>.wiki.git` 写页后 push。K2 读回复用同一缓存目录。
 * 所有 git/网络失败都抛可读错误（失败可见不吞）。
 */

export interface AssertionRow {
  id: string;
  assertion: string;
  status: string;
  evidence: string;
}

export interface WikiPageDraft {
  file: string;
  markdown: string;
}

function clip(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function sanitizeTitle(s: string): string {
  return s.replace(/[/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run';
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

/** 纯函数：run → wiki 页（frontmatter + 断言表 + 节点结论 + 经验账本 + 双链） */
export function renderWikiPage(run: RunRecord, opts: { repo: string; now?: string }): WikiPageDraft {
  const now = opts.now ?? new Date().toISOString();
  const title = `${sanitizeTitle(run.dagName)}-${run.runId.slice(-6)}`;
  const file = `${title}.md`;
  const results = latestAssertionResults(run);
  const lines: string[] = [];
  lines.push('---');
  lines.push(`pf-run: ${run.runId}`);
  lines.push(`pf-repo: ${opts.repo}`);
  lines.push(`pf-dag: ${run.dagName}`);
  if (run.spaceId) lines.push(`pf-space: ${run.spaceId}`);
  if (run.contract) lines.push(`pf-contract-source: ${run.contract.source}`);
  lines.push(`pf-published: ${now}`);
  lines.push('tags: [paneflow, run-record]');
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
  return { file, markdown: lines.join('\n') };
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

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} 失败：${(stderr || err.message).trim().slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

function authUrl(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.wiki.git`;
}

/** clone/pull wiki 仓库到缓存目录（token 不进 .git/config：clone 后把 origin 洗回无密钥地址） */
export async function syncWikiCache(o: { dataDir: string; repo: string; token?: string; maxAgeMs?: number }): Promise<void> {
  const dir = wikiCacheDir(o.dataDir, o.repo);
  const marker = path.join(dir, '.pf-synced');
  const fresh = (() => {
    try {
      return Date.now() - fs.statSync(marker).mtimeMs < (o.maxAgeMs ?? 5 * 60_000);
    } catch {
      return false;
    }
  })();
  const plain = `https://github.com/${o.repo}.wiki.git`;
  const remote = o.token ? authUrl(o.repo, o.token) : plain;
  if (!fresh) {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git(['clone', '--depth', '1', remote, dir]);
    } else {
      await git(['fetch', '--depth', '1', remote, 'master'], dir);
      await git(['reset', '--hard', 'FETCH_HEAD'], dir);
    }
    await git(['remote', 'set-url', 'origin', plain], dir).catch(() => undefined);
    fs.writeFileSync(marker, new Date().toISOString());
  }
}

/** K1 发布：同步缓存 → 写页 → commit → push。任何一步失败都抛（不吞）。 */
export async function publishWikiPage(o: {
  dataDir: string;
  repo: string;
  token: string;
  page: WikiPageDraft;
}): Promise<{ url: string; cacheDir: string }> {
  await syncWikiCache({ dataDir: o.dataDir, repo: o.repo, token: o.token, maxAgeMs: 0 });
  const dir = wikiCacheDir(o.dataDir, o.repo);
  fs.writeFileSync(path.join(dir, o.page.file), o.page.markdown);
  await git(['add', o.page.file], dir);
  await git(['commit', '-m', `PaneFlow 沉淀: ${o.page.file}`], dir).catch((e: Error) => {
    if (!/nothing to commit/i.test(e.message)) throw e;
  });
  await git(['push', authUrl(o.repo, o.token), 'HEAD:master'], dir);
  return {
    url: `https://github.com/${o.repo}/wiki/${o.page.file.replace(/\.md$/, '')}`,
    cacheDir: dir,
  };
}

// -- K2 读回：本地页挑选 + 摘要 -------------------------------------------------

export interface WikiPage {
  file: string;
  title: string;
  text: string;
}

const PAGE_CAP = 64;
const PAGE_BYTES = 32 * 1024;

/** 从缓存目录读 md 页（不含 frontmatter 的正文留给摘要） */
export function readWikiPages(dataDir: string, repo: string): WikiPage[] {
  const dir = wikiCacheDir(dataDir, repo);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  return files.slice(0, PAGE_CAP).map((f) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, PAGE_BYTES);
    } catch {
      return { file: f, title: f.replace(/\.md$/, ''), text: '' };
    }
    const body = text.replace(/^---[\s\S]*?---\n?/, '');
    return { file: f, title: f.replace(/\.md$/, '').replace(/-/g, ' '), text: body };
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
