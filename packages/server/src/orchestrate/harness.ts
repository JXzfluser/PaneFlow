import crypto from 'node:crypto';
import type { DagGraph, NodeEquip, RunHarness } from '@paneflow/shared';
import { READBACK_HEADER } from './readback.js';

/**
 * v12-V1 harness 披露的纯函数小工具：稳定序列化指纹 + replay 漂移比对。
 * 定位与 v8-M6 契约模板同款——「起单实发配置」要有可机检的字节身份，
 * 但只披露与比对、不参与编排判据（评审 R5：漂移只发事件不拦）。
 */

/**
 * 键序递归排序的规范化 JSON 序列化（JSON.stringify 默认按插入序，键序不稳定）：
 * 对象键按码点升序、undefined 成员按 JSON 语义折成 null/丢弃——保证同一 graph
 * 两次序列化逐字节一致，sha 才可复算比对。
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const parts = Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 内容指纹：规范化 JSON 的 sha256 前 8 位（与契约模板 templateSha 同口径） */
export function contentSha(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// v13-V2 等臂机检：读回块实扫 + 骨架指纹（纯函数，判据只在这里，engine 只喂现场值）
// ---------------------------------------------------------------------------

/**
 * I2 经验块首尾行的前缀单源（engine.buildExperienceBlock 拼这两行时必须引用这里的常量，
 * 防「文案改了剥不掉」）。剥块只认这两个锚点，块中间内容一概不管。
 */
export const EXPERIENCE_BLOCK_HEAD_PREFIX = '【上次经验 · I2 自动注入';
export const EXPERIENCE_BLOCK_TAIL_PREFIX = '——以上是历史经验参考';

/**
 * 读回块实扫：graph 里是否真有读回块——判据=任一字符串值存在独占一行且逐字等于
 * READBACK_HEADER 的行（注入姿势就是行首表头，测试同源）。这是「实发是什么」的唯一
 * 口径：不读 env、不看留痕，replay 带进来的旧块同样照出。
 */
export function graphHasReadbackBlock(graph: unknown): boolean {
  const seen = (s: string): boolean => s.split('\n').some((line) => line === READBACK_HEADER);
  const walk = (o: unknown): boolean => {
    if (typeof o === 'string') return seen(o);
    if (Array.isArray(o)) return o.some(walk);
    if (o && typeof o === 'object') return Object.values(o).some(walk);
    return false;
  };
  return walk(graph);
}

/**
 * 从 prompt 里剥掉运行期注入块（只认引擎自己的注入姿势，块内内容不再入 sha）：
 * ① 读回块：表头独占一行命中 → 连同其后直到首个空行/末尾的整段（desc+逐行摘录）丢弃；
 * ② I2 经验块：以 EXPERIENCE_BLOCK_HEAD_PREFIX 起头的行命中 → 丢弃直到
 *    EXPERIENCE_BLOCK_TAIL_PREFIX 起头的尾行（含尾行）；找不到尾行则剥到末尾。
 * 双份堆叠（replay 二次追加）也逐块剥净。base prompt 里用户恰好手写过同款行首=一起剥，
 * 两臂同规则不伤等臂比对。
 */
export function stripInjectionBlocks(prompt: string): string {
  const lines = prompt.split('\n');
  const out: string[] = [];
  /** 块两侧各有 \n\n 缝：剥整块后连挤的空行收一枚（前文/后文接缝与无块臂逐字节同款） */
  const collapseSeam = (nextIsBlank: boolean) => {
    if (nextIsBlank && out.length && out[out.length - 1] === '') out.pop();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === READBACK_HEADER) {
      while (i < lines.length && lines[i] !== '') i++; // 跳表头+desc+摘录，落在空行或末尾
      collapseSeam(i < lines.length);
      i--; // 交给 for 的 i++：停在空行本身（保留分隔）
      continue;
    }
    if (line.startsWith(EXPERIENCE_BLOCK_HEAD_PREFIX)) {
      let j = i + 1;
      while (j < lines.length && !lines[j]!.startsWith(EXPERIENCE_BLOCK_TAIL_PREFIX)) j++;
      collapseSeam(j < lines.length - 1);
      i = j; // 连同尾行一起丢（j 越界=剥到末尾）
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trimEnd();
}

/** 骨架归一的单枚字面量：value（本次实发的具体值）折成 token（模板占位符原文） */
export interface SkeletonLiteral {
  token: string;
  value: string;
}

/**
 * 骨架化（skeletonSha 的前半段算法）：structuredClone 后全串归一两类噪声——
 * ① prompt 字段里的运行期注入块（stripInjectionBlocks；读回/I2 只进 config.prompt）；
 * ② 每次必然不同的字面量：调用方喂 run_id/draft_dir 的实际值（含 replay 血缘链上
 *    各祖先 run 的旧值——在册 graph 里是旧 run 烧进 prompt 的字面量，applyVariables
 *    不再触碰它们），折回 {{run_id}}/{{draft_dir}} 占位原文。长值先换（draft_dir
 *    路径尾巴含 run_id，先换短的后一半就没了）。
 */
export function skeletonGraph<T>(graph: T, literals: SkeletonLiteral[]): T {
  const clean = structuredClone(graph);
  const sorted = literals.filter((l) => l.value).sort((a, b) => b.value.length - a.value.length);
  const normalize = (s: string): string => {
    let out = s;
    for (const l of sorted) out = out.split(l.value).join(l.token);
    return out;
  };
  const walk = (o: unknown, key: string | undefined): unknown => {
    if (typeof o === 'string') return key === 'prompt' ? normalize(stripInjectionBlocks(o)) : normalize(o);
    if (Array.isArray(o)) return o.map((v) => walk(v, undefined));
    if (o && typeof o === 'object') {
      const rec: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) rec[k] = walk(v, k);
      return rec;
    }
    return o;
  };
  return walk(clean, undefined) as T;
}

/**
 * 骨架指纹：skeletonGraph 归一后的 contentSha（复用本模块 v12-V1 的指纹口径）。
 * 等臂判据的分子：两臂 fresh dispatch 只差读回块 → 本值相等；动了真拓扑 → 不等。
 */
export function skeletonSha(graph: DagGraph, literals: SkeletonLiteral[]): string {
  return contentSha(skeletonGraph(graph, literals));
}

// ---------------------------------------------------------------------------
// v13-V4 ctxSha 注入留痕：注入面指纹的构成与漂移比对（纯函数，判据只在这里）
// ---------------------------------------------------------------------------

/**
 * ctxSha 的取材形状——三块构成钉死在此单源（engine 只喂注入现场的实读值）：
 * ① files：resolveContext 注入现场实读成功的文件集，绝对路径 → 逐文件内容指纹
 *    （contentSha 口径）；没配任何约定文档/技能时为空对象——仍算得出确定指纹，
 *    「什么都没注入」也是正读数；
 * ② gwThrottleRetries / ③ nodeTimeoutMsDefault：两枚 env 级运行旋钮——同模板
 *    同档案但旋钮不同的真实混淆因子，并入同一指纹。
 */
export interface CtxFingerprintInput {
  files: Record<string, string>;
  gwThrottleRetries: number;
  nodeTimeoutMsDefault: number;
}

/** 注入面指纹：规范化结构的 contentSha（键序由 canonicalJson 归一，可复算）。 */
export function computeCtxSha(ctx: CtxFingerprintInput): string {
  return contentSha(ctx);
}

/**
 * v13-V4 ctxSha 进 replay 漂移比对面（评审 R5：只披露不拦，与 model/钉档/skeletonSha 同款）。
 * 与 harnessDriftDiffs 分家：ctxSha 的当前值要到注入现场才存在（起单时读文件=假账，
 * 见 engine.noteContextInjection），比对只能在指纹落册时点做，喂进来的就是两侧在册值。
 * 任一侧缺键（v13-V4 前的旧单/旧记录）返回 null 跳过比对，宁缺毋假；相等返回 null。
 */
export function ctxShaDriftDiff(
  source: RunHarness | undefined,
  current: RunHarness | undefined,
): string | null {
  if (!source?.ctxSha || !current?.ctxSha) return null;
  if (source.ctxSha === current.ctxSha) return null;
  return `上下文 #${source.ctxSha}→#${current.ctxSha}（约定文档/技能实读集或运行旋钮已变）`;
}

// ---------------------------------------------------------------------------
// v13-W2 岗位指纹 roleSha：角色 + 实解析装备的内容指纹（纯函数，构成只在这里）
// ---------------------------------------------------------------------------

/**
 * v13-W2 岗位指纹 roleSha 的取材形状——构成钉死在此单源（engine 只喂注入现场的装备账）：
 * 每枚条目=一岗实发吃进的东西：
 *  · role：节点绑的角色 id（没绑=null——「没岗」和「有岗」是两回事，不混同一指纹）；
 *  · skills / rules：注入现场**解析出的路径集**（按注入顺序，路径本身入指纹）。
 *    刻意**不**逐文件算内容指纹——文件改了是 ctxSha 的账（V4 已占坑），本键只证
 *    「哪一岗挂哪几篇」这格配置，于是「同装备同指纹」不被文档编辑噪声打破（判据外延自 V2）；
 *  · unknownSkills：装备槽引用了登记清单外的项（虽不注入，但它变了=这岗的配置确实被改过）；
 *  · unknownRules（v14-A5-5b）：同一枚判序给岗位文档槽——它从前没有披露通道，所以只在非空时才进取材，
 *    干净名册与旧单的 roleSha 逐字节不变（宁缺毋假：不给没落册的格子补一枚空数组冒充「配过」）。
 * scope（role/space 兼容带）不入指纹：它由「槽有没有配过」推得、与路径集冗余，
 * 算进去会让「配了一格内容等价的槽」也换指纹，破「同装备=同指纹」那半条判据。
 * `misses`（v14-A5-5b 那句「为什么没落地」的明细）同样不入指纹，理由比 scope 更硬：它的取材是
 * **注册表整表**——改一个毫不相关项目的条目，就能让这一岗的 roleSha 抖一下，那是拿别人的账冒充这岗的配置。
 */
export interface RoleEquipFingerprint {
  role: string | null;
  skills: string[];
  rules: string[];
  unknownSkills?: string[];
  unknownRules?: string[];
}

/** NodeEquip → 指纹取材：装备账是注入现场落册的现成结构，这里只做剥字段与归一 */
export function roleFingerprint(equip: NodeEquip): RoleEquipFingerprint {
  return {
    role: equip.role ?? null,
    skills: [...equip.skills],
    rules: [...equip.rules],
    ...(equip.unknownSkills?.length ? { unknownSkills: [...equip.unknownSkills] } : {}),
    ...(equip.unknownRules?.length ? { unknownRules: [...equip.unknownRules] } : {}),
  };
}

/**
 * 岗位指纹：把一单里各节点的装备取材（按整条目去重后排序）并成一枚 contentSha。
 * 口径：①去重——同一岗位挂在多个节点上不重复记账；②排序——「同一批装备挂在不同节点上」
 * 不额外换指纹（节点拓扑是 skeletonSha 的账）。单角色单岗时等价于那一格取材直接取 sha
 * （测试据此现算比对）。
 */
export function computeRoleSha(equips: readonly NodeEquip[]): string {
  const uniq = [...new Set(equips.map((e) => canonicalJson(roleFingerprint(e))))].sort();
  return contentSha(uniq);
}

const show = (v: string | undefined, none: string) => v || none;

/**
 * replay 漂移比对（评审 R5：只披露不拦）。比对面：
 * ① 钉档/model 两个闸口（v12-V1 原有）；
 * ② skeletonSha（v13-V2 改判）——剥注入块+归一路径字面量后仍不等，才是「两臂
 *    差的不是读回块而是真拓扑」的机器证据。任一侧缺键（v13-V2 前的旧单）跳过，
 *    宁缺毋假。
 * 不比的：graphSha 与 readback/readbackOutcome——graphSha 被注入块改写，注入块
 * 本体变必变，证不了「只差读回块」；readback 差值正是 A/B 的受测变量（v13-V2
 * 裁决：fresh dispatch 两臂 readback 不等=实验设计，不是漂移）。ctxSha 也不在此比
 * ——它的当前值要到注入现场才存在，起单时点上没有（v13-V4 分家，见 ctxShaDriftDiff）。
 * 原记录无 harness=旧单无从比，返回空。每项差异给「原→今」可读文案。
 */
export function harnessDriftDiffs(
  source: RunHarness | undefined,
  current: RunHarness | undefined,
): string[] {
  if (!source || !current) return [];
  const diffs: string[] = [];
  if ((source.gwProfile ?? undefined) !== (current.gwProfile ?? undefined)) {
    diffs.push(`钉档 ${show(source.gwProfile, '未钉')}→${show(current.gwProfile, '未钉')}`);
  }
  if ((source.model ?? undefined) !== (current.model ?? undefined)) {
    diffs.push(`model ${show(source.model, '未设')}→${show(current.model, '未设')}`);
  }
  if (source.skeletonSha && current.skeletonSha && source.skeletonSha !== current.skeletonSha) {
    diffs.push(`骨架 #${source.skeletonSha}→#${current.skeletonSha}（剥注入块后真拓扑已变）`);
  }
  return diffs;
}
