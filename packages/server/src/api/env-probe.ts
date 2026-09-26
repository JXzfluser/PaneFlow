import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { AGENT_KINDS } from './agent-kinds.js';
import { detectInstalledAgents } from './env-check.js';
import { parseGithubRemote } from './dispatch.js';

/**
 * v14-E1 环境发现器（**纯只读**）：给一个目录 → 探「本机/本仓确实有这些东西」→ 产**草案注册集**。
 *
 * 三条边界（写在这里，不散落到调用方）：
 *  1. **只读**：只 `stat`/`readdir` 与三条只读 git 查询（`rev-parse --show-toplevel` /
 *     `remote get-url origin` / `worktree list --porcelain`）——绝不 fetch/checkout/写盘，
 *     也绝不改 dataDir。登记是 E2 的事，本片产物是「草案」，不是落盘条目。
 *  2. **只报存在与大小，绝不回显内容**：`/api/env/probe` 在远程模式下带令牌可达，把约定文档正文
 *     回显出去就是信息泄露面。package.json 的内容只为「算出机检候选」而读，出口只有命令名。
 *  3. **判据与读现场分家**（照 env-check.ts 的 `probeWin32Binary` 先例）：`judgeEnvProbe` 是纯函数，
 *     单测喂注入的 `ProbeScene` 假视图锁三态；`probeEnvironment` 才接真实 fs/child_process。
 *
 * 宁缺毋假在这里的具体形状：
 *  - 没探到的类目进 `missing`（带一句为什么），**不进 `items` 占位**；
 *  - `items: []` 是正读数「一条依据都没探到」，而「现场读不到」是另一回事——那种情况只给
 *    `error` 一句人话且 `missing` 留空：读都没读到现场，逐类目说「没有」就是拿不知道冒充没有。
 *  - 依据（`evidence`）是 E1 的定义要求：每项必须说清「发现自哪个相对路径」，没依据的发现不入册。
 */

export type ProbeKind = 'repo' | 'doc' | 'skill' | 'rule' | 'check' | 'workflow' | 'worktree';

/** 一条有依据的发现 */
export interface ProbeItem {
  kind: ProbeKind;
  name: string;
  /** 人话读数（大小/URL/路径/候选命令）——不含被探文件的正文 */
  detail: string;
  /** 依据：发现自哪个相对路径（或哪份目录清单，见 rule 计数项的注释） */
  evidence: string;
}

export interface EnvProbeResult {
  /** 原样回显请求里的目录（绝对路径，判据在 http 路由的入参形状上把关） */
  path: string;
  /** git 仓根：是 git 仓才有；不是 git 仓=整键缺省，不是空串 */
  root?: string;
  /** server 算好的一句人话汇总（CLI 一行读数的唯一来源——计数住 server，CLI 零判据） */
  summary?: string;
  items: ProbeItem[];
  /** 没探到的类目 + 一句为什么 */
  missing: string[];
  /** 本机可用 agent CLI（复用 /api/health 的同一套实探与 60s 缓存）；[] 是正读数 */
  agentsAvailable?: string[];
  /** 现场读不到时的一句人话（探测失败是**读数**，不是客户端错误 → HTTP 200） */
  error?: string;
}

/** 只读 git 查询的三态返回值：`no-git`（本机没有 git 可执行）与 `failed`（有 git，但这目录不认/没远端）分开报 */
export type GitRead =
  | { ok: true; out: string }
  | { ok: false; cause: 'no-git' | 'failed'; reason: string };

export interface ProbeEntry {
  name: string;
  isDirectory: boolean;
}

/** 读现场注入面：生产走真实 fs/child_process，单测喂假视图 */
export interface ProbeScene {
  /** 列一层目录；读不到给一句人话原因 */
  readDir(dir: string): { entries: ProbeEntry[] } | { error: string };
  /** 普通文件的字节数；不存在/不是文件 → null（不猜） */
  fileSize(file: string): number | null;
  /** 文本文件（只为算机检候选读 package.json；内容不出判据、永不回显） */
  readText(file: string): string | null;
  /** 跑一条只读 git 查询（args 不含 `git` 本身，内部拼 `-C dir`） */
  git(dir: string, args: string[]): GitRead;
}

/** 仓根约定文档：各算一项（存在与大小） */
const CONVENTION_DOCS = ['AGENTS.md', 'CLAUDE.md', 'QODER.md'];
/** 技能目录（只数第一层的 *.md，见 judgeEnvProbe 的 skill 段注释） */
const SKILL_DIRS = ['skills', '.paneflow/skills'];
/** 包管理器：由 lockfile 判，顺序即优先级（多个并存取第一并另起一条披露） */
const LOCKFILES: { file: string; pm: string }[] = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
];
/**
 * 规则候选的逐篇上限。**为什么设**：候选口径是「仓根同级 md + docs/ 一层 md」，
 * 大仓（文档站、monorepo）随手几十上百篇，逐篇列出来既刷屏又淹掉真正要勾选的几篇；
 * 于是超出只报计数（计数项本身仍入册——总数是 E2 勾选界面要读的账），不静默截断。
 */
const RULE_SCAN_LIMIT = 20;

const KIND_ORDER: ProbeKind[] = ['repo', 'doc', 'skill', 'rule', 'check', 'workflow', 'worktree'];

/**
 * 相对路径的稳定序：按码位比，不用 localeCompare。
 * 这不是口味问题——ICU 序里大小写与标点的先后随 locale 变（`docs/x.md` 能排到 `README.md` 前头），
 * 草案集是要给人勾选、还要进 E2 一次事务的输入，顺序抖一下就是复验时的假差异。
 */
function byRelPath(a: { rel: string }, b: { rel: string }): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

function reasonOf(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === 'ENOENT') return '目录不存在';
  if (e?.code === 'ENOTDIR') return '不是目录';
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return `没有读取权限（${e.code}）`;
  return e?.message ? e.message : '读不到（原因未知）';
}

// -- 真实读现场（生产默认值） -------------------------------------------------

function realReadDir(dir: string): { entries: ProbeEntry[] } | { error: string } {
  try {
    return {
      entries: fs
        .readdirSync(dir, { withFileTypes: true })
        .map((d) => ({ name: d.name, isDirectory: d.isDirectory() })),
    };
  } catch (err) {
    return { error: reasonOf(err) };
  }
}

function realFileSize(file: string): number | null {
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    return st?.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function realReadText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function realGit(dir: string, args: string[]): GitRead {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return { ok: true, out: typeof out === 'string' ? out : '' };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // 本机压根没有 git 可执行 vs 有 git 但这目录不认——两者的缺项文案必须分开（后者才是真读数）
    if (code === 'ENOENT') return { ok: false, cause: 'no-git', reason: '本机 PATH 上没有 git 可执行' };
    return { ok: false, cause: 'failed', reason: 'git 未认（非零退出或无输出）' };
  }
}

export function realProbeScene(): ProbeScene {
  return { readDir: realReadDir, fileSize: realFileSize, readText: realReadText, git: realGit };
}

// -- 判据层（纯函数，无 IO） ---------------------------------------------------

interface Tallies {
  /** 归一后的仓标识（owner/repo，或认不出时的原始 URL）；没探到 origin 就是空串 */
  repo: string;
  docs: number;
  skills: number;
  /** 规则候选的**总数**（含因上限未逐篇列出的那些） */
  rules: number;
  checks: string[];
  workflows: number;
  worktrees: number;
}

/** 汇总一句人话：只拼探到的类目（0 不是「没有」，就不拼），全空时给一句诚实的总话 */
function buildSummary(t: Tallies, itemCount: number): string {
  const parts: string[] = [];
  if (t.repo) parts.push(`git 仓 origin=${t.repo}`);
  if (t.docs) parts.push(`约定文档 ${t.docs}`);
  if (t.skills) parts.push(`技能 ${t.skills} 篇`);
  if (t.rules) parts.push(`规则候选 ${t.rules} 篇`);
  if (t.checks.length) parts.push(`机检候选 ${t.checks.join('、')}`);
  if (t.workflows) parts.push(`CI workflow ${t.workflows} 个`);
  if (t.worktrees) parts.push(`额外 worktree ${t.worktrees} 个`);
  if (!parts.length) return itemCount ? `${itemCount} 项发现` : '未发现任何可登记项（原因见缺项）';
  return parts.join(' · ');
}

/**
 * 判据主体：喂一份现场视图，产草案。**不读真实现场、不探 agent**（那是 probeEnvironment 的活）。
 * 注意 `dir` 必须是绝对路径——形状把关在 http 路由，这里对脏路径只当读不到的现场处理。
 */
export function judgeEnvProbe(dir: string, scene: ProbeScene): EnvProbeResult {
  const dirRead = scene.readDir(dir);
  if ('error' in dirRead) {
    const msg = `这个目录读不到：${dirRead.error}（${dir}）`;
    return { path: dir, items: [], missing: [], error: msg };
  }

  const missing: string[] = [];
  const buckets = new Map<ProbeKind, ProbeItem[]>();
  const push = (kind: ProbeKind, item: ProbeItem) => {
    const list = buckets.get(kind) ?? [];
    list.push(item);
    buckets.set(kind, list);
  };
  const bucketOf = (kind: ProbeKind): ProbeItem[] => buckets.get(kind) ?? [];
  const tally: Tallies = { repo: '', docs: 0, skills: 0, rules: 0, checks: [], workflows: 0, worktrees: 0 };

  // 1) git 仓根：只读 rev-parse。**探的是仓根而不是传入的子目录**——约定文档/skills/lockfile
  //    的家规位置就在仓根，用户从子目录敲 probe 也该认到同一份现场；root 原样回显，不藏。
  const top = scene.git(dir, ['rev-parse', '--show-toplevel']);
  let root: string | undefined;
  if (top.ok && top.out.trim()) root = top.out.trim().split('\n')[0]!.trim();
  else if (!top.ok && top.cause === 'no-git') missing.push(`git 未探：${top.reason}（git 仓/worktree 两类无从谈起）`);
  else missing.push('不是 git 仓（git rev-parse --show-toplevel 未认这个目录）');
  const base = root ?? dir;

  // 2) repo：`git remote get-url origin` → 归一化 owner/repo（scp 式 git@、ssh://、https:// 三形态都认）
  if (root) {
    const remote = scene.git(base, ['remote', 'get-url', 'origin']);
    const url = remote.ok ? remote.out.trim().split('\n')[0]!.trim() : '';
    if (url) {
      const ownerRepo = parseGithubRemote(url);
      push('repo', {
        kind: 'repo',
        name: ownerRepo ?? url,
        detail: ownerRepo
          ? `origin=${url} → ${ownerRepo}`
          : `origin=${url}（非 GitHub 形态，未归一出 owner/repo）`,
        // 依据：远端 URL 的正身就存在仓根的 .git/config 里（不是 git 命令的临时输出）
        evidence: '.git/config',
      });
      tally.repo = ownerRepo ?? url;
    } else {
      missing.push('git 仓没有 origin 远端（git remote get-url origin 无输出）');
    }
  }

  // 3) doc 约定文档：只报存在与大小（**绝不回显内容**，见文件头第 2 条边界）
  for (const name of CONVENTION_DOCS) {
    const size = scene.fileSize(path.join(base, name));
    if (size === null) continue;
    push('doc', { kind: 'doc', name, detail: `${size} 字节（只报存在与大小，未读内容）`, evidence: name });
    tally.docs++;
  }
  if (!tally.docs) missing.push(`没有约定文档（${CONVENTION_DOCS.join(' / ')} 都不在仓根）`);

  // 4) skill：skills/ 或 .paneflow/skills/ **第一层**的 *.md，每篇一项。
  //    只数第一层是刻意口径：子目录形态（skills/<名>/SKILL.md）的判定要靠「目录里有没有 SKILL.md」
  //    这层额外约定，E2 勾选界面拿一篇篇 md 已够用；越界递归会在大仓里刷屏。
  const skillFiles: { rel: string; size: number }[] = [];
  let skillDirSeen = false;
  for (const rel of SKILL_DIRS) {
    const read = scene.readDir(path.join(base, rel));
    if ('error' in read) continue;
    skillDirSeen = true;
    for (const e of read.entries) {
      if (!e.isDirectory && e.name.endsWith('.md')) {
        const size = scene.fileSize(path.join(base, rel, e.name));
        if (size !== null) skillFiles.push({ rel: `${rel}/${e.name}`, size });
      }
    }
  }
  skillFiles.sort(byRelPath);
  for (const f of skillFiles) {
    push('skill', {
      kind: 'skill',
      name: path.basename(f.rel),
      detail: `${f.size} 字节（只报存在与大小，未读内容）`,
      evidence: f.rel,
    });
  }
  tally.skills = skillFiles.length;
  if (!skillFiles.length) {
    missing.push(
      skillDirSeen
        ? `技能目录存在但第一层没有 *.md（探过 ${SKILL_DIRS.join(' / ')}；子目录形态的 SKILL.md 不在本片口径内）`
        : `没有 skills 目录（未探到 ${SKILL_DIRS.join(' 或 ')}）`,
    );
  }

  // 5) rule 规则候选：仓根同级 md + docs/ 一层 md，逐篇上限 RULE_SCAN_LIMIT（见常量注释）
  const rootEntries = base === dir ? dirRead : scene.readDir(base);
  const ruleFiles: { rel: string; size: number }[] = [];
  if (!('error' in rootEntries)) {
    for (const e of rootEntries.entries) {
      // 隐藏文件与三枚约定文档都跳过：前者多半是工具产物，后者已经以 doc 类目入册，不重复计
      if (e.isDirectory || e.name.startsWith('.') || !e.name.endsWith('.md') || CONVENTION_DOCS.includes(e.name)) continue;
      const size = scene.fileSize(path.join(base, e.name));
      if (size !== null) ruleFiles.push({ rel: e.name, size });
    }
  }
  const docsRead = scene.readDir(path.join(base, 'docs'));
  if (!('error' in docsRead)) {
    for (const e of docsRead.entries) {
      if (e.isDirectory || !e.name.endsWith('.md')) continue;
      const size = scene.fileSize(path.join(base, 'docs', e.name));
      if (size !== null) ruleFiles.push({ rel: `docs/${e.name}`, size });
    }
  }
  ruleFiles.sort(byRelPath);
  tally.rules = ruleFiles.length;
  for (const f of ruleFiles.slice(0, RULE_SCAN_LIMIT)) {
    push('rule', {
      kind: 'rule',
      name: path.basename(f.rel),
      detail: `规则候选 · ${f.size} 字节（只报存在与大小，未读内容）`,
      evidence: f.rel,
    });
  }
  if (ruleFiles.length > RULE_SCAN_LIMIT) {
    const rest = ruleFiles.length - RULE_SCAN_LIMIT;
    push('rule', {
      kind: 'rule',
      name: `另 ${rest} 篇未逐项列出`,
      detail: `规则候选共 ${ruleFiles.length} 篇，逐篇上限 ${RULE_SCAN_LIMIT}（防大仓刷屏，只报计数）`,
      // 计数项没有单一出处文件：依据是目录清单本身。尖括号标出来，免得被当成相对路径去 stat
      evidence: '<目录清单：仓根同级 *.md + docs/*.md>',
    });
  }
  if (!ruleFiles.length) missing.push('没有规则候选（仓根同级与 docs/ 一层内没有其它 *.md）');

  // 6) check 机检候选：lockfile 定包管理器 + package.json scripts 定命令
  const locks = LOCKFILES.filter((l) => scene.fileSize(path.join(base, l.file)) !== null);
  const pm = locks[0]?.pm;
  if (locks.length > 1) {
    // 多套 lockfile 并存是**真读数**不是错误：登记时得知道这仓的包管理器有歧义
    push('check', {
      kind: 'check',
      name: '多套 lockfile 并存',
      detail: `探到 ${locks.map((l) => l.file).join('、')}——按 pnpm>yarn>npm 取 ${pm}（只披露不拦）`,
      evidence: locks.map((l) => l.file).join(' · '),
    });
  }
  const pkgRel = 'package.json';
  const pkgSize = scene.fileSize(path.join(base, pkgRel));
  if (pkgSize === null) {
    missing.push('没有 package.json（非 node 项目或未探到清单；本片不为机检候选硬造命令）');
  } else {
    const scripts = readPackageScripts(path.join(base, pkgRel), scene);
    if (scripts === null) {
      missing.push(`package.json 读不出 scripts（JSON 解析失败或 scripts 不是对象；机检候选不硬造）`);
    } else {
      for (const key of ['test', 'typecheck'] as const) {
        if (!Object.prototype.hasOwnProperty.call(scripts, key)) continue;
        const shown = pm ?? 'npm';
        const cmd = `${shown} ${key}`;
        push('check', {
          kind: 'check',
          name: cmd,
          detail: `package.json 的 scripts.${key} 在册（候选，未实跑）${pm ? '' : '；未探到 lockfile，命令按 npm 形态给'}`,
          evidence: pkgRel,
        });
        tally.checks.push(cmd);
      }
      if (!tally.checks.length) missing.push('package.json 的 scripts 里没有 test / typecheck（机检候选零）');
    }
  }
  if (!pm) missing.push(`没有 lockfile（未探到 ${LOCKFILES.map((l) => l.file).join(' / ')}，包管理器读数缺席）`);

  // 7) workflow：.github/workflows/ 一层 *.yml|*.yaml，每个文件一项（不提内容）
  const wfRel = '.github/workflows';
  const wfRead = scene.readDir(path.join(base, wfRel));
  let wfCount = 0;
  if (!('error' in wfRead)) {
    const wfFiles = wfRead.entries
      .filter((e) => !e.isDirectory && /\.(yml|yaml)$/i.test(e.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of wfFiles) {
      const size = scene.fileSize(path.join(base, wfRel, e.name));
      push('workflow', {
        kind: 'workflow',
        name: e.name,
        detail: `CI workflow${size === null ? '' : ` · ${size} 字节`}（未读内容）`,
        evidence: `${wfRel}/${e.name}`,
      });
      wfCount++;
    }
  }
  tally.workflows = wfCount;
  if (!wfCount) missing.push(`没有 CI workflow（未探到 ${wfRel}/*.yml 或 *.yaml）`);

  // 8) worktree：porcelain 行数 >1 才逐项列（只有本仓一条=没有额外 worktree，**不写空项占位**）
  if (root) {
    const wt = scene.git(base, ['worktree', 'list', '--porcelain']);
    if (wt.ok) {
      const paths = wt.out
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim())
        .filter(Boolean);
      const extras = paths.filter((p) => path.resolve(p) !== path.resolve(root));
      for (const p of extras) {
        push('worktree', {
          kind: 'worktree',
          name: path.basename(p) || p,
          detail: `额外 worktree：${p}`,
          // 依据：linked worktree 的 admin 目录正身在仓根 .git/worktrees/（同样是相对仓根的路径）
          evidence: '.git/worktrees/',
        });
      }
      tally.worktrees = extras.length;
    }
  }

  const items: ProbeItem[] = [];
  for (const kind of KIND_ORDER) items.push(...bucketOf(kind));
  const result: EnvProbeResult = { path: dir, items, missing };
  if (root) result.root = root;
  result.summary = buildSummary(tally, items.length);
  return result;
}

/** 只取 package.json 的 scripts 映射；读不到/形状不对一律 null（宁缺毋假，不猜命令） */
function readPackageScripts(file: string, scene: ProbeScene): Record<string, unknown> | null {
  const text = scene.readText(file);
  if (text === null) return null;
  try {
    const pkg = JSON.parse(text) as { scripts?: unknown };
    const s = pkg?.scripts;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    return s as Record<string, unknown>;
  } catch {
    return null;
  }
}

// -- 入口（接真实现场 + 复用既有 agent 实探缓存） -------------------------------

export interface ProbeOptions {
  /** 本机可用 agent 探测器；缺省复用 /api/health 那一套（AGENT_KINDS × PATH 实探，60s 缓存） */
  detectAgents?: () => Promise<string[]>;
  /** 读现场；缺省真实 fs/child_process */
  scene?: ProbeScene;
}

/**
 * 生产入口：判据 + 本机 agent 实探。**探测失败不是异常**——读不到现场时 judge 已经回了
 * 一句人话读数（HTTP 200），这里不抛；只有 `dir` 自身形状脏（相对路径）才由路由挡在 400。
 */
export async function probeEnvironment(dir: string, opts: ProbeOptions = {}): Promise<EnvProbeResult> {
  const result = judgeEnvProbe(dir, opts.scene ?? realProbeScene());
  const detect = opts.detectAgents ?? (() => detectInstalledAgents([...AGENT_KINDS]));
  // 实探本身不吃现场（PATH 上的二进制名），所以 error 读数下照样给——它是机器级事实，与目录无关
  result.agentsAvailable = await detect();
  return result;
}
