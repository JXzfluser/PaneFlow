import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { agentBinaryName, isAgentKind } from './agent-kinds.js';

interface CacheEntry {
  at: number;
  status: BinaryPresence;
  /** 只有 `unknown` 才有：没探出来的原因（健康文案由它出，不在消费面再猜一遍） */
  why?: string;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
const POSIX_PROBE_TIMEOUT_MS = 3000;

/**
 * v14 A3-2：本机一个可执行文件的存在性，**三态**。
 * `unknown` 是这一片新增的那一态，而且它必须存在：
 *  - 旧的 `probeBinary` 把「sh 三秒没答话」和「command -v 说没有」都收成 `false`——对 `agentsInstalled`
 *    那份清单无所谓（少列一枚，与今天一字不差），但注册中心的健康点照这个口径画就是把**「未探得」画成「没装」**
 *    （红点替机器造结论）；
 *  - R4 的姿态 2 早就给 `model` 通道写死了这条（超时落 `unknown`，见 `registry-health.ts`）——
 *    agent 通道同一条尺，不能因为它探的是本地文件就免检。
 */
export type BinaryPresence = 'live' | 'missing' | 'unknown';

export interface BinaryProbe {
  status: BinaryPresence;
  /** `unknown` 的一句原因；其余两态不给（缺键=没有这句话，不是空串） */
  why?: string;
  at: number;
  cached: boolean;
}

/** win32 的 env 键名大小写不稳（PATH/Path 都出现过）；注入的纯对象区分大小写——兜底不区分大小写找 */
function lookupEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === key) return v;
  return undefined;
}

/** 默认可执行文件视图：真实文件系统上「存在且是文件」（目录名撞车不算命中）。 */
function win32FileExists(p: string): boolean {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * v13-E2（v6-oss-landing §#4 沉淀方案）：win32 探测走 PATH × PATHEXT 纯枚举。
 * win32 没有 sh，旧「command -v」路在那儿恒 false（agentsInstalled 恒空的根因）；
 * 起 cmd/where 又是把结果交给环境运气——不起 shell，纯 fs 判定。
 * env / fileExists 可注入供单测锁三态；生产走默认值（win32 真机可达）。
 *
 * 「PATH 读不到」这一支 v14 A3-2 起算 `unknown` 而不是 `missing`：没有搜索路径就是**无从枚举**，
 * 说「没装」是替机器下结论。（枚举跑完了、到处都没有，才是 `missing`。）
 */
export function probeWin32Presence(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = win32FileExists,
): { status: BinaryPresence; why?: string } {
  const pathVar = lookupEnv(env, 'PATH');
  if (!pathVar) return { status: 'unknown', why: '环境变量 PATH 读不到，没有可枚举的搜索路径' };
  const pathExt = lookupEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  const exts = ['', ...pathExt.split(';').map((e) => e.trim()).filter(Boolean)];
  for (const dir of pathVar.split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      if (fileExists(path.win32.join(dir, bin + ext))) return { status: 'live' };
    }
  }
  return { status: 'missing' };
}

/** 既有布尔出口（`agentsInstalled` 那一侧的语义）：`unknown` 归「没探到」，与今天一字不差 */
export function probeWin32Binary(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = win32FileExists,
): boolean {
  return probeWin32Presence(bin, env, fileExists).status === 'live';
}

/** 非 win32：`sh -c command -v`。超时与起不了 shell 都是 `unknown`，只有 sh 明确答「没这个命令」才是 `missing` */
function probePosixPresence(
  bin: string,
  timeoutMs = POSIX_PROBE_TIMEOUT_MS,
): Promise<{ status: BinaryPresence; why?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { status: BinaryPresence; why?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ status: 'unknown', why: `探测超时（${Math.round(timeoutMs / 1000)} 秒内 sh 没答话）` }),
      timeoutMs,
    );
    execFile('sh', ['-c', `command -v ${JSON.stringify(bin)} >/dev/null 2>&1`], (err) => {
      if (!err) return done({ status: 'live' });
      const code = (err as NodeJS.ErrnoException).code;
      // 起不了 sh（ENOENT/EACCES…）＝无从问它；跑得起来但退出码非零（number）才是「它说没有」
      if (typeof code === 'number') return done({ status: 'missing' });
      return done({ status: 'unknown', why: `本机 sh 探测没跑起来：${code ?? (err as Error).message}` });
    });
  });
}

/**
 * 单个可执行文件的三态探测，**60 秒缓存**（与 `detectInstalledAgents` 同一份缓存、同一个时效——
 * 两处各缓存一份迟早给出两个答案，而 R4 要的正是「健康点与首屏那份清单同一次呼吸」）。
 * `refresh:true` 绕开缓存（`/api/registry/health?refresh=1` 的落点）。
 */
export async function probeBinaryPresence(bin: string, opts: { refresh?: boolean } = {}): Promise<BinaryProbe> {
  const hit = cache.get(bin);
  if (hit && !opts.refresh && Date.now() - hit.at < TTL_MS) {
    return { status: hit.status, ...(hit.why ? { why: hit.why } : {}), at: hit.at, cached: true };
  }
  const probed = process.platform === 'win32' ? probeWin32Presence(bin) : await probePosixPresence(bin);
  const at = Date.now();
  cache.set(bin, { at, status: probed.status, ...(probed.why ? { why: probed.why } : {}) });
  return { status: probed.status, ...(probed.why ? { why: probed.why } : {}), at, cached: false };
}

/** Which agent kinds have a local binary on PATH（逐枚 60 秒缓存；`unknown` 不算装着）. */
export async function detectInstalledAgents(kinds: string[]): Promise<string[]> {
  const results = await Promise.all(
    kinds.map(async (kind) => {
      const bin = agentBinaryName(kind);
      return (await probeBinaryPresence(bin)).status === 'live' ? kind : null;
    }),
  );
  return results.filter((k): k is string => k !== null);
}

export function clearAgentProbeCache(): void {
  cache.clear();
}

/** 自动推荐优先级（用户裁决：装了 pi 就默认 pi；claude 常遇未登录，排最后） */
export const RECOMMEND_PRIORITY = ['pi', 'opencode', 'codex', 'claude'] as const;

/** 本机装了哪个优先用哪个；全都没装返回 null（调用方兜底）。 */
export async function recommendAgentKind(): Promise<string | null> {
  const installed = await detectInstalledAgents([...RECOMMEND_PRIORITY]);
  for (const kind of RECOMMEND_PRIORITY) {
    if (installed.includes(kind)) return kind;
  }
  return null;
}

/**
 * v19 打磨：「自动派活（不点名成员）」这一路会落到哪个引擎——四态读数。
 * 抽成单源函数是因为这条梯原本长在 `/api/dispatch` 路由里：派单口要用它接单，
 * 挑人下拉也要在派单**之前**照渲同一枚结论。两处各写一遍就会给出两个答案。
 * 层级与 engine.resolveAgentKind 的前两级同尺（项目默认 > 本机实探），
 * 但不含「节点/角色自绑」那两级——那要到 graph 就位（起单现场）才解得出，
 * 所以读数文案明说「各步若自绑岗位，仍以该岗的引擎为准」，不拿这一枚冒充整单结论。
 */
export type AutoEngineVia = 'project-default' | 'probed' | 'none' | 'unknown';

export interface AutoEngineRead {
  /** 实探/档案解得出的那枚引擎；`none`/`unknown` 时为 null（null 是正读数「没有」，不是空串） */
  agentKind: string | null;
  via: AutoEngineVia;
  /** server 现成的一句人话：这枚值从哪来（网页与 CLI 只照渲，不另造措辞） */
  note: string;
}

export async function resolveAutoAgentKind(
  profileDefault: string | undefined,
  recommend: () => Promise<string | null | undefined> = recommendAgentKind,
): Promise<AutoEngineRead> {
  const declared = profileDefault?.trim();
  if (declared && isAgentKind(declared)) {
    return {
      agentKind: declared,
      via: 'project-default',
      note: `引擎按项目默认解析 → ${declared}（各步若自绑岗位，仍以该岗的引擎为准）`,
    };
  }
  const probed = (await recommend()) ?? null;
  if (probed) {
    return {
      agentKind: probed,
      via: 'probed',
      note: `项目没配默认引擎，按本机实探落到 → ${probed}（各步若自绑岗位，仍以该岗的引擎为准）`,
    };
  }
  return {
    agentKind: null,
    via: 'none',
    note: '现在派不出单：项目没配默认引擎，本机实探也全空——装一枚引擎或在「项目」里配默认引擎',
  };
}
