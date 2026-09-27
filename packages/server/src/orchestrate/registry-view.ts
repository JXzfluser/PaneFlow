import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeRegistryEntry,
  registryId,
  REGISTRY_VIEW_KINDS,
  NODE_TYPE_CATALOG,
  CHECK_TYPE_CATALOG,
  type RegistryEntry,
} from '@paneflow/shared';
import { AGENT_KINDS, agentBinaryName } from '../api/agent-kinds.js';
import { rolesPath, type Role } from './roles.js';

/**
 * v14 A3-2（R3）：**视图 kind** 的现算清单——条目由注册表现算出来，`entries.json` 里永远没有它们。
 *
 * 为什么要这一层，而不是把 18 枚 agent 类型一次性 `add` 进盘：
 *  - **只有一份事实源**（前置-1 合一的那张表就是它）。搬进盘＝同一件事两处存，改代码那片从此不再生效，
 *    而它才是真正决定「能不能起这个 agent」的地方；
 *  - **删/禁用没有意义**：出厂清单里没有的 kind 本机跑不了，用户把视图条目禁了也拦不住节点配置里写它。
 *    与其给一个不生效的开关，不如整条不接（写入面拒，见 `RegistryStore.add`）。
 *
 * 视图条目**不填时刻**是不可能的（信封要求字符串），所以这里给的是**本机进程启动时刻**，
 * 含义如实：「这台机器这次运行从什么时候开始看见这一项」。它不是登记时刻——视图项没有逐条登记时刻
 * （出厂清单没有，`roles.json` 那份名册也没记「这个岗是哪天建的」），界面与文案都不拿它当登记账。
 * 取一次进程级常量而不是每次 `new Date()`：
 * 每条请求都抖一下的读数没法比较，也就没法当断言。
 */
const BOOT_AT = new Date().toISOString();

/**
 * 现算要吃的上下文。A5-4b-1 之前视图 kind 的正身全在代码里，builders 不需要任何输入；
 * `role` 是**第一枚「条目由现盘现算」**的视图 kind（名册 `roles.json` 是用户数据，不是出厂清单），
 * 所以这里必须给得到 dataDir。参数写成对象而不是裸字符串：下一枚现盘视图（`template` 吃 `graphs/`、
 * `gateway-profile` 吃 `gateway.json`）要的也许不止这一枚，届时加键不动调用方。
 */
export interface ViewContext {
  dataDir: string;
}

/**
 * 一次现算的产出：条目，外加**读得出但读不干净**那部分的披露。
 *
 * 披露为什么要跟着条目一起出（而不是让 builder 抛）：视图项的正身是用户数据，用户的盘可以是脏的
 * （手编 `roles.json` 是这个项目文档里明写过的正常操作），一次脏盘不该把整张注册表打成 500、
 * 更不该连带把 `startRun` 的预检闸口一起打断——那是拿别人的脏数据罚这一单。但「一条都没渲出来」
 * 也不能冒充「本机没有岗位」，所以这些句子并进 `readView()` 的 `rejected` 那一格（只披露不清除，
 * 网页与 CLI 已经在渲它），与 `load()` 对单条脏记录的处理同一姿势。
 */
export interface ViewBuild {
  entries: RegistryEntry[];
  disclosures: { id: string; why: string }[];
}

/** 现算一组成员条目；抛错＝出厂数据本身脏（编程错，不是用户数据错），让它响 */
type ViewBuilder = (ctx: ViewContext) => ViewBuild;

/** 出厂/代码来源的 builders 都不产披露（它们的正身是编译期常量，脏了是编程错、直接抛） */
function codeBuilt(entries: RegistryEntry[]): ViewBuild {
  return { entries, disclosures: [] };
}

function agentKindEntries(): ViewBuild {
  return codeBuilt(
    AGENT_KINDS.map((kind) => {
      const raw = {
        id: registryId('agent-kind', kind),
        kind: 'agent-kind' as const,
        name: kind,
        source: 'builtin' as const,
        enabled: true,
        createdAt: BOOT_AT,
        updatedAt: BOOT_AT,
        spec: { binary: agentBinaryName(kind) },
      };
      const norm = normalizeRegistryEntry(raw);
      if (!norm.ok) throw new Error(`出厂 agent 清单算出了不合法的条目（${kind}）：${norm.why}`);
      return norm.value;
    }),
  );
}

/**
 * `node-type`（v14 T1）：画布值域那张清单的渲版。这里**不新增事实**——`type/label/icon/group/hint`
 * 全部原样取自 `NODE_TYPE_CATALOG`，条目只是给它套上注册表信封（id、来源、引用账才因此接得上）。
 * 清单本身脏（少一枚类型、组名拼错）在这里会以 `normalizeRegistryEntry` 不合法的形式炸出来：
 * 那是编程错，不是用户数据错，抛出去比渲半张表诚实。
 */
function nodeTypeEntries(): ViewBuild {
  return codeBuilt(
    NODE_TYPE_CATALOG.map((row) => {
      const raw = {
        id: registryId('node-type', row.type),
        kind: 'node-type' as const,
        name: row.type,
        source: 'builtin' as const,
        enabled: true,
        createdAt: BOOT_AT,
        updatedAt: BOOT_AT,
        spec: {
          label: row.label,
          icon: row.icon,
          group: row.group,
          order: row.order,
          ...(row.hint ? { hint: row.hint } : {}),
        },
      };
      const norm = normalizeRegistryEntry(raw);
      if (!norm.ok) throw new Error(`出厂节点类型清单算出了不合法的条目（${row.type}）：${norm.why}`);
      return norm.value;
    }),
  );
}

/**
 * `check-type`（v14 A5-4）：机检值域那张清单的渲版，与 `node-type` 同一条边界——
 * 这里**不新增事实**：`type/label/hint/machine` 全原样取自 `CHECK_TYPE_CATALOG`
 * （`machine` 也不是这里判的，它就是 v13-V1 机检账用的同一枚派生值）。
 */
function checkTypeEntries(): ViewBuild {
  return codeBuilt(
    CHECK_TYPE_CATALOG.map((row) => {
      const raw = {
        id: registryId('check-type', row.type),
        kind: 'check-type' as const,
        name: row.type,
        source: 'builtin' as const,
        enabled: true,
        createdAt: BOOT_AT,
        updatedAt: BOOT_AT,
        spec: { label: row.label, hint: row.hint, machine: row.machine },
      };
      const norm = normalizeRegistryEntry(raw);
      if (!norm.ok) throw new Error(`出厂机检清单算出了不合法的条目（${row.type}）：${norm.why}`);
      return norm.value;
    }),
  );
}

/**
 * `role`（v14 A5-4b-1）：角色库名册的渲版。与前三枚视图 kind 的唯一不同是**正身是一张盘上的用户数据**，
 * 于是这里多三件事，都是「镜子不替数据编话」的同一族判据：
 *  1. **名册读不动 ≠ 没有岗位**：`roles.json` 解析失败/顶层不是数组时不给空表冒充读数，出一条披露
 *     （`registryViewEntries` 的产出并进 `readView().rejected`）。注意这与引擎侧 `loadRoles()` 的
 *     静默降级**刻意不同**：那条路要保起单不被人手滑的逗号打断（旁账不拦主路），这一面问的是
 *     「这台机器有什么能力」，把读不出画成「没有」就是它最典型的假读数——两处答的是两个问题，
 *     所以不是第二份判据；
 *  2. **条目的取舍与引擎同一把尺**：`roleById()` 用 `find(r => r.id === roleId)`，所以绑得上岗的判据只有
 *     「id 是非空串」与「同 id 取第一条」。名册里那些引擎永远绑不到的行（非对象/没有可用 id）才不渲条目，
 *     且照样披露；同 id 的第二行不渲（否则注册表说「有两个 std-planner」而引擎只会用第一个）；
 *  3. **岗名缺失不替用户起一个**：`name` 空时条目的 `spec.label` 回落用 id 顶（不然注册中心那一行只能
 *     画裸 id，读不出人话），同时出一条披露说清这不是岗名、是名册里那枚没起名。回落不是「猜名字」——
 *     引用写法本来就走 id 那一侧，label 不进 `refKeys`。
 * `env`/`prePrompt`/`skills[]`/`rules[]`/`declares` 都不进 spec（`env` 可能含密钥；余下几样各自已有账：
 * 装备在 `equip`、声明在 W3、历史表现在 W4），这一枚只是「有这个名字的岗」的镜子。
 */
function roleEntries(ctx: ViewContext): ViewBuild {
  const roster = readRoleRoster(ctx.dataDir);
  if (!roster.ok) {
    return {
      entries: [],
      disclosures: [
        {
          id: 'roles.json',
          why: `角色库读不出（${roster.why}）：「角色」这一组因此一条也渲不出来——这不是「本机没有岗位」，是名册读不动。`,
        },
      ],
    };
  }
  const entries: RegistryEntry[] = [];
  const disclosures: { id: string; why: string }[] = [];
  const seen = new Map<string, number>();
  roster.roles.forEach((row, i) => {
    // 名册是用户数据：一行可以不是对象、可以缺 id、可以把 id 写成数字。逐格收窄，不整体断言
    const maybe = row as Partial<Role> | null | undefined;
    const id = typeof maybe?.id === 'string' ? maybe.id.trim() : '';
    if (!id) {
      disclosures.push({
        id: `roles.json[${i}]`,
        why: '名册这一条没有可用的 id（不是对象，或 id 缺/空/非串）：引擎也永远绑不到它，所以这里不渲条目——只披露不清除，要留要删去角色库。',
      });
      return;
    }
    const prior = seen.get(id);
    if (prior !== undefined) {
      disclosures.push({
        id: registryId('role', id),
        why:
          `名册里有两枚 id「${id}」的岗位（第 ${prior + 1} 条与第 ${i + 1} 条）：读端只认第一条（与引擎的 find 同一把尺），` +
          '第二条没渲成条目——去角色库把其中一枚改名或删掉，别让两枚岗共用一个身份。',
      });
      return;
    }
    seen.set(id, i);
    // 走到这里 `maybe` 必是对象（它的 `id` 是串），但 TS 跟不住这条推链，所以三格各自收窄一次
    const label = typeof maybe?.name === 'string' ? maybe.name.trim() : '';
    if (!label) {
      disclosures.push({
        id: registryId('role', id),
        why: `岗位「${id}」在名册里没有岗名：注册中心这一行只能拿 id 称呼它（这不是替它起的名字）。`,
      });
    }
    const pinned = typeof maybe?.agentKind === 'string' ? maybe.agentKind.trim() : '';
    if (maybe?.agentKind !== undefined && !pinned) {
      disclosures.push({
        id: registryId('role', id),
        why: `岗位「${id}」的 agentKind 不是可用的串（空或类型不对）：这一枚没当钉档渲，也没当「没钉」——去角色库看清那一格。`,
      });
    }
    const raw = {
      id: registryId('role', id),
      kind: 'role' as const,
      // 机器值放 `name`（与 node-type/check-type 同形）：名册里的 id **原样**存这里，
      // 而 id 里的 slug 是小写化结果（`registryId` 那把尺），大写 id 靠 `refKeys` 吃 `entry.name` 才指得回来
      name: id,
      // 岗位是用户登记的，不是版本自带的——`source` 说的是出处，视图项的可写性由 `view` 标说（两条判据早已分家）
      source: 'user' as const,
      enabled: true,
      createdAt: BOOT_AT,
      updatedAt: BOOT_AT,
      spec: { label: label || id, ...(pinned ? { agentKind: pinned } : {}) },
    };
    const norm = normalizeRegistryEntry(raw);
    if (!norm.ok) throw new Error(`角色库名册算出了不合法的条目（${id}）：${norm.why}`);
    entries.push(norm.value);
  });
  return { entries, disclosures };
}

/**
 * 名册的严格读法（只读，红线：视图面永不写盘）。三种读数分开：
 *  - `ENOENT`＝还没建过角色库，是**正读数**（空名册、无披露）；
 *  - 读得动但解析不出/顶层不是数组＝**读不出**（调用方出披露，不渲空表冒充「没有岗位」）；
 *  - 拿到数组就交给调用方逐条判（脏行只披露那一条，其余照给——同 `load()` 对 `entries.json` 的姿态）。
 */
function readRoleRoster(dataDir: string): { ok: true; roles: unknown[] } | { ok: false; why: string } {
  let text: string;
  try {
    text = fs.readFileSync(rolesPath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, roles: [] };
    return { ok: false, why: (err as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, why: `JSON 读不出：${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, why: `期望岗位数组，读到 ${path.basename(rolesPath(dataDir))} 顶层是 ${typeof parsed}` };
  }
  return { ok: true, roles: parsed as unknown[] };
}

/**
 * kind → 现算函数。表本身 mapped over `REGISTRY_VIEW_KINDS`：**挂号了却没 builders = 编译期红，
 * 反之多写了没挂号的 builder 也是**（shared 的 `SPEC_PARSERS`/`REGISTRY_DESCRIPTORS` 同一招）。
 */
const VIEW_BUILDERS: { [K in (typeof REGISTRY_VIEW_KINDS)[number]]: ViewBuilder } = {
  'agent-kind': agentKindEntries,
  'node-type': nodeTypeEntries,
  'check-type': checkTypeEntries,
  role: roleEntries,
};

/**
 * 全部视图条目＋披露（本次调用现算，不缓存：出厂清单是编译期常量，名册读一次盘的代价也比缓存判据便宜）。
 * 返回的是 `ViewBuild` 而不是裸条目数组：调用方（`RegistryStore.readView()`）要把 `disclosures` 并进
 * `rejected` 那一格，只拿条目的话「名册读不动」和「本机没有岗位」就成同一张空表了。
 */
export function registryViewEntries(ctx: ViewContext): ViewBuild {
  const builds = Object.values(VIEW_BUILDERS).map((build) => build(ctx));
  return {
    entries: builds.flatMap((b) => b.entries),
    disclosures: builds.flatMap((b) => b.disclosures),
  };
}

/**
 * kind → 正身在哪儿。视图 kind 的**拒写文案**与**盘上残记录的披露文案**（`registry.ts` 的
 * `shadowedOnDiskWhy`）问的是同一件事——这一类的成员由谁决定——所以两处吃同一张表：写两份措辞迟早分叉，
 * 而没人会去比对两句拒答。
 *
 * 措辞**必须逐 kind 给**：前三枚的正身是代码（成员与配置由版本决定），`role` 的正身是角色库
 * （用户数据，由那一面决定）。拿「内置出厂项、由版本决定」去拒岗位的写请求，就是当着用户的面说假话——
 * 那一枚岗是他自己建的。
 */
const VIEW_HOME: { [K in (typeof REGISTRY_VIEW_KINDS)[number]]: string } = {
  'agent-kind': '版本自带的 agent 类型清单（成员与配置由代码决定）',
  'node-type': '画布的节点类型清单（成员与配置由代码决定）',
  'check-type': '机检类型清单（成员与配置由代码决定）',
  role: '角色库那一面（岗位在那儿建、改、删；注册表只是它的镜子）',
};

/** 正身句子取值；调用方只在 `isRegistryViewKind` 为真之后进来（判据在 shared），表外 kind 不是这里要拦的事 */
export function viewHomeOf(kind: string): string {
  return VIEW_HOME[kind as keyof typeof VIEW_HOME];
}

/** 视图 kind 的写入面文案（`add`/`update`/`remove` 三处共用一句，不在三处各写一遍）。
 *  判据本身在 shared（`isRegistryViewKind`）——这里只出文案，不开第二份清单。 */
export function viewKindWriteWhy(action: string, kind: string): string {
  return (
    `「${kind}」是视图 kind：条目由${viewHomeOf(kind)}现算出来，注册表${action}不了它。` +
    '写入面不代造本机没有的东西，也不给用户造一个关掉就好的假开关。'
  );
}
