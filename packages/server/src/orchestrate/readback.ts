import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DagNode } from '@paneflow/shared';
import { readWikiPages, syncWikiCache, wikiCacheDir, WIKI_ROOT, type WikiPage } from '../api/wiki.js';
import { parseGithubRemote } from '../api/dispatch.js';
import { ghCliToken, readGithubSettings, resolveGithubToken } from '../api/github-cred.js';

/**
 * v11-C3a wiki 读回接入执行链：run 起跑时把目标仓本地 llm-wiki/ 缓存里与任务词面
 * 相关的 top-k 沉淀摘录，以「## 相关沉淀（PaneFlow wiki）」块附进 plan/impl 类
 * agent 节点的 prompt 尾部。
 * 红线：注入路径**零网络**——只读 syncWikiCache 落下的现成缓存，缺缓存即跳过；
 * 缓存新鲜度交给起跑时异步刷一次（makeWikiCacheRefresher，失败静默，不拖 run）。
 * 本模块只 import wiki.ts 的读侧弹药（readWikiPages/wikiCacheDir/syncWikiCache），
 * 不改其导出面；挑页在前端（enhance）口径之上包一层，把 frontmatter 全量带进
 * 排序入参——v11-C2 反面教材页降权落地时经 weightOf 挂钩接入，这里不做 low 判定。
 */

/** k=3：与 enhance 端 pickWikiExcerpts 的缺省档同源——起步 3 页够建立手感，再多挤占任务本体上下文 */
export const READBACK_K = 3;
/** 单页摘录限长：与 pickWikiExcerpts 的 240 字口径一致，只取首段正文 */
export const READBACK_PAGE_CAP = 240;
/** 块总预算（保守 ≤2400 字符）：k=3×240 + 标题/来源行本就在此带内，留余量给 C2 加权后可能的加页，防读回反客为主 */
export const READBACK_BLOCK_BUDGET = 2400;

/** 块标题（测试与留痕口径的单点定义） */
export const READBACK_HEADER = '## 相关沉淀（PaneFlow wiki）';

const READBACK_DESC =
  '以下摘录自本仓 llm-wiki/ 的历史沉淀（按与本节点任务词面相关度挑选），是经验参考不是本单需求——别因「沉淀里这么干过」就照抄路径：';

// ---------------------------------------------------------------------------
// 开关
// ---------------------------------------------------------------------------

/**
 * 缺省开（on）的三条理由（v11-C3a 裁决）：
 * 1. 复利管道的收益就在读端，默认关=建了管道没人吃、C4 A/B 的 on 臂还得先教用户开闸；
 * 2. 注入路径零网络、缺缓存/缺仓/缺页一律静默跳过——默认 on 没有拖垮 run 的风险面；
 * 3. C4 做 on/off A/B 要求两态可显式跑：env PF_WIKI_READBACK=off 或 EngineOptions
 *    注入即关，测试与实验都不受影响。
 */
export function readbackEnabled(opt: 'on' | 'off' | undefined): boolean {
  const v = (opt ?? process.env.PF_WIKI_READBACK ?? 'on').trim().toLowerCase();
  return v !== 'off';
}

// ---------------------------------------------------------------------------
// 目标仓推导
// ---------------------------------------------------------------------------

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

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** owner/repo 合格线：正则形状 + 拒路径穿越段（wikiCacheDir 兜底会洗字符，但别喂垃圾） */
function asOwnerRepo(s: string | undefined): string | null {
  const v = s?.trim();
  if (!v || !OWNER_REPO_RE.test(v)) return null;
  if (v.split('/').some((seg) => seg.startsWith('.'))) return null;
  return v;
}

/**
 * run 的目标仓认三路：cwd 的 origin remote（最贴本单）> 契约 repo（M2 立约锚点）
 * > 设置页默认仓兜底。认不出返回 null（调用方整段跳过读回）。
 */
export function resolveRunRepo(o: {
  cwd: string;
  contractRepo?: string;
  defaultRepo?: string;
  readRemote?: (dir: string) => string | null;
}): string | null {
  const url = (o.readRemote ?? defaultGitRemote)(o.cwd);
  if (url) {
    const r = parseGithubRemote(url);
    if (r) return r;
  }
  return asOwnerRepo(o.contractRepo) ?? asOwnerRepo(o.defaultRepo);
}

// ---------------------------------------------------------------------------
// 本地缓存读页（零网络）+ frontmatter 全量
// ---------------------------------------------------------------------------

/** 读回用页：readWikiPages 的正文之外，另带 frontmatter 全量（C2 降权入参、confidence 透传） */
export interface ReadbackPage extends WikiPage {
  /** frontmatter 扁平 key→原始 value 字符串（数组值按 yaml 行原文保留） */
  frontmatter: Record<string, string>;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const block = raw.startsWith('---\n') ? /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] : undefined;
  if (!block) return {};
  const fm: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (m) fm[m[1]!] = m[2]!.trim();
  }
  return fm;
}

/** 从本地缓存读页并补 frontmatter；落点缺失/为空返回空数组，绝不抛。 */
export function loadReadbackPages(dataDir: string, repo: string): ReadbackPage[] {
  const base = path.join(wikiCacheDir(dataDir, repo), WIKI_ROOT);
  return readWikiPages(dataDir, repo).map((p) => {
    let frontmatter: Record<string, string> = {};
    try {
      frontmatter = parseFrontmatter(fs.readFileSync(path.join(base, p.file), 'utf8').slice(0, 8192));
    } catch {
      // 读不到原文 = 无 frontmatter，正文照旧可用
    }
    return { ...p, frontmatter };
  });
}

// ---------------------------------------------------------------------------
// 相关性挑页（口径对齐 wiki.ts pickWikiExcerpts：标题命中加权、正文按出现次数、宁缺毋滥）
// ---------------------------------------------------------------------------

function tokens(q: string): string[] {
  return (q.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fa5]{2,8}/g) ?? []).filter((t) => t.length >= 2);
}

/** plan/impl 类节点 = 需要「前人经验」的主消费端；验收/汇总/受理类刻意不注入——
 *  verify 该只对着契约核对，不该被沉淀带偏路径，wrapup 是纯汇总。id/label/role 任一命中即算。 */
const READBACK_NODE_RE = /(plan|impl|implement|research|develop|build|coding|规划|实现|开发|调研|编码)/i;

export function isReadbackTarget(n: DagNode): boolean {
  if (n.type !== 'agent' || !n.config.prompt) return false;
  return [n.id, n.label, n.config.role ?? ''].some((s) => READBACK_NODE_RE.test(s));
}

/** 节点任务词面：prompt 剥掉运行期插值占位（{{x.artifact.y}} 是引用不是语义），附 label */
export function readbackQuery(n: DagNode): string {
  return `${(n.config.prompt ?? '').replace(/\{\{[^{}]*\}\}/g, ' ')} ${n.label}`;
}

/**
 * 词面相关度 top-k。weightOf 是 C2（反面教材页降权）预留钩子：入参含页 frontmatter
 * 全量，默认恒权 1——本模块不实现任何 low/confidence 判定，只透传。
 */
export function rankReadbackPages(
  pages: ReadbackPage[],
  query: string,
  limit = READBACK_K,
  weightOf: (frontmatter: Record<string, string>) => number = () => 1,
): ReadbackPage[] {
  const ts = tokens(query);
  if (!ts.length) return [];
  return pages
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
      return { p, score: score * weightOf(p.frontmatter) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}

// ---------------------------------------------------------------------------
// 注入块组装
// ---------------------------------------------------------------------------

/** 防沉淀页内容污染运行期插值与展示：剥 {{ }}、压平行数（同 I2 经验块的 sanitize 姿势） */
function safe(s: string, cap: number): string {
  const flat = s.replace(/\{\{|\}\}/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

function excerptOf(p: ReadbackPage): string {
  const para =
    p.text
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#') && !s.startsWith('>')) ?? p.text.trim();
  return safe(para, READBACK_PAGE_CAP);
}

/**
 * 「## 相关沉淀」块：每页一行「路径 + 标题 + confidence（透传，frontmatter 有就带）+ 摘录」。
 * used 只含真正进了块的页（预算截断的尾巴不入留痕）。一行都放不下返回 block=''。
 */
export function buildReadbackBlock(
  ranked: ReadbackPage[],
  budget: number = READBACK_BLOCK_BUDGET,
): { block: string; used: ReadbackPage[] } {
  const used: ReadbackPage[] = [];
  let total = READBACK_HEADER.length + READBACK_DESC.length + 2;
  for (const p of ranked) {
    const conf = p.frontmatter.confidence ? ` confidence=${safe(p.frontmatter.confidence, 16)}` : '';
    const line = `- \`${p.file}\`「${safe(p.title, 60)}」${conf}：${excerptOf(p)}`;
    if (total + line.length + 1 > budget) break;
    total += line.length + 1;
    used.push(p);
  }
  if (!used.length) return { block: '', used: [] };
  const lines = [
    READBACK_HEADER,
    READBACK_DESC,
    ...used.map((p) => {
      const conf = p.frontmatter.confidence ? ` confidence=${safe(p.frontmatter.confidence, 16)}` : '';
      return `- \`${p.file}\`「${safe(p.title, 60)}」${conf}：${excerptOf(p)}`;
    }),
  ];
  return { block: lines.join('\n'), used };
}

// ---------------------------------------------------------------------------
// 缓存后台刷新（唯一允许触网的路径；与注入解耦，失败静默）
// ---------------------------------------------------------------------------

/**
 * 默认刷新实现：resolveGithubToken（存储 PAT > gh 登录态）拿得到 token 才同步；
 * 新鲜度由 syncWikiCache 的 .pf-synced 标记（5min）天然去重。engine 侧对返回的
 * promise 只 fire-and-forget，这里任何失败都不向上冒。测试注入 wikiCacheRefresh 覆盖。
 */
export function makeWikiCacheRefresher(
  dataDir: string,
  readGhCliToken: () => Promise<string> = ghCliToken,
): (repo: string) => Promise<void> {
  return async (repo: string) => {
    try {
      const token = await resolveGithubToken(dataDir, readGhCliToken);
      if (!token) return; // 无 token = 不后台刷新（注入照旧吃现有缓存）
      await syncWikiCache({ dataDir, repo, token });
    } catch {
      // 静默：刷不动下次再刷，读回只是锦上添花
    }
  };
}

/** 供测试/展示：默认仓配置读取（github.json） */
export function defaultRepoOf(dataDir: string): string | undefined {
  return readGithubSettings(dataDir).defaultRepo;
}
