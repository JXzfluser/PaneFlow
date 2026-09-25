import fs from 'node:fs';
import path from 'node:path';
import { DECLARE_FACES, type DeclareFace, type RoleDeclaredFaces } from '@paneflow/shared';
import type { SpaceRule } from './rules.js';

export interface Role {
  id: string;
  name: string;
  /** 默认 agent kind（节点未显式配置时使用） */
  agentKind?: string;
  /** 角色前置提示（渲染在节点 prompt 之前） */
  prePrompt?: string;
  /** 角色级环境变量（如模型网关地址；节点 env 覆盖此处） */
  env?: Record<string, string>;
  /**
   * v13-W1 岗位装备·技能槽。**引用**语义：只列本空间 skills 登记清单里的路径
   * （清单外的引用跳过不注、落进节点 equip.unknownSkills 只披露）。
   * 键缺省=未配槽 → 沿用「空间全量注入」的现状一字不变（兼容带，不强迁）；
   * 显式 []=配过槽且该岗不吃技能文档（评审/验收岗常见的正是这个）。
   */
  skills?: string[];
  /**
   * v13-W1 岗位装备·岗位文档槽（评审清单类家规）。注入 = matchRules 命中的空间规则
   * ∪ 本槽（按 file 去重，空间侧优先）。路径同 rules.file，相对主仓根，含 `..` 的一律不取。
   */
  rules?: string[];
  /**
   * v13-W3 授权声明三面（gitPush / prOpen / issueWrite，皆布尔）。**PaneFlow 不造沙箱**：
   * 17 动词协议面无切钩子，能力锁归 agent CLI 侧——本槽只做三事：①诚实措辞注进 prompt
   * （「声明非强制」）；②收口时与副作用账对账落落差（只照不拦）；③status 可见。
   * 为什么只有三面：引擎唯一的副作用账是 run 级 RunSideEffects（issuesCreated/issuePatched/
   * prUrl/pushedAt），三面与它恰一对一可核对；需求文档省略号里的 writeScope **刻意不进**——
   * 路径维在账上没有可核对的键，登进来就是一张永远抓不到落差的脸，「声明了却对不了账」
   * 正是本片要防的静默失效。键缺省=没声明=今天的行为一字不变；显式 true 也是正断言（只是永不违例）。
   */
  declares?: RoleDeclaredFaces;
}

/**
 * v13-W1 兼容带判据：这一格配过没有——**只看键在不在**（[] 是「配了且清空」，不是没配）。
 * 未配装备的角色/未绑角色的节点照旧吃空间全量，status 因此要显出来「正在吃全量」。
 */
export function roleEquipConfigured(role: Role | undefined): boolean {
  return !!role && (role.skills !== undefined || role.rules !== undefined);
}

/**
 * v13-W3 声明的读端清洗：只认三面布尔。roles.json 是手编库，脏面值/脏面一律不取
 * （入库面 PUT /api/roles 已 fail-closed 拒过——这枚是兜住手改盘面的降级，不是第二道校验）；
 * 全缺 → undefined（宁缺毋假：不拿空声明冒充「声明过」）。
 */
export function normalizeDeclares(declares: unknown): RoleDeclaredFaces | undefined {
  if (!declares || typeof declares !== 'object' || Array.isArray(declares)) return undefined;
  const out: RoleDeclaredFaces = {};
  for (const face of DECLARE_FACES) {
    const v = (declares as Record<string, unknown>)[face];
    if (typeof v === 'boolean') out[face] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 三面的人话（注入 prompt 与收口事件共用同一取材；true/false 两向措辞） */
const DECLARE_FACE_TEXT: Record<DeclareFace, { yes: string; no: string }> = {
  gitPush: { yes: '可向远程仓库推送提交（git push）', no: '不向远程仓库推送提交（git push）' },
  prOpen: { yes: '可创建 Pull Request', no: '不创建 Pull Request' },
  issueWrite: { yes: '可建 Issue、可覆写其正文', no: '不建 Issue、不覆写 Issue 正文' },
};

/**
 * v13-W3 ①声明注入：把本岗声明渲染进 prompt——**措辞诚实**（这是声明不是强制：PaneFlow
 * 不造沙箱、不在协议面拦能力，真能力锁配在 agent CLI 侧）。没声明 → ''（注入块与现状
 * 逐字节相同，兼容带零成本）。
 */
export function buildDeclareBlock(role: Role | undefined): string {
  const faces = normalizeDeclares(role?.declares);
  if (!faces) return '';
  const lines = DECLARE_FACES.filter((f) => faces[f] !== undefined).map(
    (f) => `- ${f}=${faces[f] ? 'true' : 'false'}：本岗声明${faces[f] ? DECLARE_FACE_TEXT[f].yes : DECLARE_FACE_TEXT[f].no}`,
  );
  return (
    `岗位授权声明（声明非强制——PaneFlow 不造沙箱，也不在协议面拦能力，真正的能力锁配在你自己的 agent CLI 侧；` +
    `请按下列本岗自报的授权边界行事，收口时会与本单副作用账对账、落差只照不拦）：\n${lines.join('\n')}\n---\n`
  );
}

const PER_FILE_CAP = 100 * 1024;
const TOTAL_CAP = 250 * 1024;

export function rolesPath(dataDir: string): string {
  return path.join(dataDir, 'roles.json');
}

export function loadRoles(dataDir: string): Role[] {
  try {
    const arr = JSON.parse(fs.readFileSync(rolesPath(dataDir), 'utf8')) as Role[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveRoles(dataDir: string, roles: Role[]): void {
  fs.writeFileSync(rolesPath(dataDir), JSON.stringify(roles, null, 2));
}

/**
 * v9-B1 标准五连班底（规划/实现/评审/验收/沉淀）：新空间一键装填的内置模板。
 * id 固定 std-*；ensureStandardRoles 只补缺不覆盖——用户改过的同名角色受保护。
 */
export const STANDARD_TEAM_ROLES: Role[] = [
  {
    id: 'std-planner',
    name: '规划',
    prePrompt:
      '你是本班的规划手：把需求拆成可独立交付的小步，写清每步的产出与验收口径；不亲自实现，只把路铺直。',
  },
  {
    id: 'std-implementer',
    name: '实现',
    prePrompt:
      '你是本班的实现手：严格按分配到的步骤改代码，遵守仓库既有约定与分支规范，小步提交，不越界改动。',
  },
  {
    id: 'std-reviewer',
    name: '评审',
    prePrompt:
      '你是本班的评审：对着契约与diff挑问题（正确性/边界/回归风险），只提可执行的修改意见，不亲自改代码。',
  },
  {
    id: 'std-verifier',
    name: '验收',
    prePrompt:
      '你是本班的验收员：逐条核对验收标准（AC），能跑测试就跑测试，给出每条「过/不过」的实证依据，不放水。',
  },
  {
    id: 'std-curator',
    name: '沉淀',
    prePrompt:
      '你是本班的知识沉淀员：把这一单踩过的坑、验证过的做法整理成可复用的短文档，写清适用边界。',
  },
];

/** 把缺失的标准角色补写进全局角色库（按 id 去重，不动已存在的），返回五连全部 */
export function ensureStandardRoles(dataDir: string): Role[] {
  const existing = loadRoles(dataDir);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const added = STANDARD_TEAM_ROLES.filter((s) => !byId.has(s.id));
  if (added.length) saveRoles(dataDir, [...existing, ...added]);
  return STANDARD_TEAM_ROLES.map((s) => byId.get(s.id) ?? s);
}

/**
 * Build the convention context block injected before every agent prompt of a
 * space: entries resolved relative to profile.rootCwd, capped per-file and in
 * total. M3: entries are scoped rules (file + optional note) or plain paths
 * (legacy). Returns '' when nothing configured or nothing matched.
 * v13-W1：`onInject` 把「哪几篇真的进了 prompt」报回给调用方落装备账——
 * 读失败与超总预算被跳过的都不报（报了就是假账）。
 */
export function buildConventionBlock(
  rootCwd: string | undefined,
  entries: (string | SpaceRule)[] | undefined,
  readFile: (p: string) => string | null,
  onInject?: (file: string) => void,
): string {
  if (!rootCwd || !entries?.length) return '';
  const parts: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const rule = typeof entry === 'string' ? { file: entry } : entry;
    const rel = rule.file;
    if (rel.includes('..')) continue;
    const content = readFile(path.resolve(rootCwd, rel));
    if (content === null) continue;
    const clipped = content.length > PER_FILE_CAP ? `${content.slice(0, PER_FILE_CAP)}\n…（超长截断）` : content;
    if (total + clipped.length > TOTAL_CAP) {
      parts.push(`<约定文档 name="${rel}">（超出总预算未注入）</约定文档>`);
      break;
    }
    total += clipped.length;
    onInject?.(rel);
    const note = rule.note ? ` note="${rule.note}"` : '';
    parts.push(`<约定文档 name="${rel}"${note}>\n${clipped}\n</约定文档>`);
  }
  if (!parts.length) return '';
  return `以下是本项目的团队约定（必须严格遵守）：\n\n${parts.join('\n\n')}\n\n---\n`;
}
