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
import { readGatewayRoster, type GatewayProfile } from '../api/gateway.js';
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
 * 所以这里必须给得到 dataDir。参数写成对象而不是裸字符串：现盘的三枚（`role` 吃 `roles.json`、
 * `template` 吃 `graphs/`、`gateway-profile` 吃 `gateway.json`）各自的根都在 dataDir 下，
 * 届时加键不动调用方。
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
 * `template`（v14 A5-4b-2）：`graphs/*.json` 那张模板盘的渲版。与 `role` 同属**正身在盘上**的视图 kind，
 * 判据同源、脏法不同（这里脏的是「一张图读不出」而不是「名册读不出」，所以披露逐文件出）：
 *  1. **机器值是文件名去 `.json`，不是图内的 `graph.name`**：引擎取图走 `store.getGraph(id)`，那个 id
 *     正是文件名；两者不一致时（手拷进来的图、改名没改文件名的图）跟着 `graph.name` 说就会做出
 *     「注册表里有这张、派活时拿不到」的假账。所以条目一律按文件名渲，并把不一致**披露出来**
 *     （那一格正是引擎真取不到图的格子，说出来才有得可修）；
 *  2. **读不出的图不渲条目**：JSON 坏/顶层不是对象/`nodes` 不是数组时，「节点数」这格没有读数——
 *     拿 `0` 冒充就是「一张空模板」，而空图（`nodes: []`）是**另一种正读数**，两者必须分家。
 *     图在盘上这个事实由披露句承载（「这张图画不出来」），不由条目承载；
 *  3. **图的内容一概不进 spec**：节点、边、`requires` 各有正身（`validateDag`、预检、`graphSha`），
 *     抄进注册表就是第二份会腐烂的副本。`nodes`（节点数）与 `description`（元数据里那句说明）
 *     只是让这一行能解释自己。
 */
function templateEntries(ctx: ViewContext): ViewBuild {
  const dir = path.join(ctx.dataDir, 'graphs');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], disclosures: [] };
    return {
      entries: [],
      disclosures: [{ id: 'graphs/', why: `模板目录读不出（${(err as Error).message}）：「模板」这一组因此一条也渲不出来——这不是「本机没有模板」，是那一格读不动。` }],
    };
  }
  const entries: RegistryEntry[] = [];
  const disclosures: { id: string; why: string }[] = [];
  // 键是**条目 id**（`registryId` 归一后的 slug）不是文件名：`a b.json` 与 `a-b.json` 是两个引擎都
  // 取得到的文件（手改盘面写得出空格，`saveGraph` 的名正则只拦新建那一侧），却归一成同一枚条目 id——
  // 注册表只能说一枚。大小写异名（`Foo`/`foo`）在大小写敏感的卷上同理撞车，只是 macOS 默认盘根本存不下两个文件。
  const byEntryId = new Map<string, string>();
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const stem = file.slice(0, -'.json'.length);
    if (!stem) {
      disclosures.push({ id: `graphs/${file}`, why: '这个文件名去掉了 `.json` 就什么都不是（`graphs/.json`）：引擎按文件名取图，这张图谁也叫不到——只披露不清除。' });
      continue;
    }
    const id = registryId('template', stem);
    const prior = byEntryId.get(id);
    if (prior !== undefined) {
      disclosures.push({
        id,
        why:
          `两张图在注册表里归一成同一枚条目 id（${id}）：「${prior}」与「${stem}」（文件名不同、slug 相同）。` +
          '引擎两张都取得到，但注册表只渲第一条（说「有两枚 template:x」就是假账）——把其中一枚改名。',
      });
      continue;
    }
    const built = readGraphFile(path.join(dir, file), file);
    if (!built.ok) {
      disclosures.push({ id: `graphs/${file}`, why: built.why });
      continue;
    }
    byEntryId.set(id, stem);
    if (built.innerName !== undefined && built.innerName !== stem) {
      disclosures.push({
        id,
        why:
          `这张图的文件名是「${stem}」而图里写的 name 是「${built.innerName}」：条目按**文件名**渲（引擎就是按文件名取图的），` +
          '两处不一致时模板改名要连文件一起改，否则画布选名与派活取图会指到不同的地方。',
      });
    }
    const raw = {
      id,
      kind: 'template' as const,
      name: stem,
      source: 'user' as const,
      enabled: true,
      createdAt: BOOT_AT,
      updatedAt: BOOT_AT,
      spec: { nodes: built.nodes, ...(built.description ? { description: built.description } : {}) },
    };
    const norm = normalizeRegistryEntry(raw);
    if (!norm.ok) throw new Error(`模板盘算出了不合法的条目（${stem}）：${norm.why}`);
    entries.push(norm.value);
  }
  return { entries, disclosures };
}

/**
 * 单张图的严格读法：给出节点数＋那句说明＋图内 name；读不出就给一句能行动的 why。
 * 只读，红线：视图面永不写盘（也不建目录——`Store` 构造期的 `mkdirSync` 是运行面的事）。
 */
function readGraphFile(
  file: string,
  basename: string,
): { ok: true; nodes: number; description?: string; innerName?: string } | { ok: false; why: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, why: `这张图读不动（${(err as Error).message}）：不渲条目——「读不出」不等于「本机没这张模板」。` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, why: `这张图的 JSON 读不出（${(err as Error).message}）：引擎同样打不开它，所以这里不渲条目、只披露。` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, why: `期望图对象，读到 ${basename} 顶层是 ${Array.isArray(parsed) ? 'array' : typeof parsed}：不渲条目。` };
  }
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.nodes)) {
    return { ok: false, why: `${basename} 的 nodes 不是数组（缺或类型不对）：节点数没有读数，拿 0 冒充就是「一张空模板」——那是另一种正读数，两者必须分家。` };
  }
  const metadata = o.metadata;
  const description =
    metadata !== null && typeof metadata === 'object' && typeof (metadata as { description?: unknown }).description === 'string'
      ? (metadata as { description: string }).description.trim()
      : '';
  const innerName = typeof o.name === 'string' ? o.name.trim() : undefined;
  return { ok: true, nodes: (o.nodes as unknown[]).length, ...(description ? { description } : {}), ...(innerName !== undefined ? { innerName } : {}) };
}

/**
 * `gateway-profile`（v14 A5-4b-2）：网关盘 `profiles[]` 的渲版。逐条判据同 `role`（同一族「镜子不替数据编话」）：
 *  - 机器值是**档 id 原样**：`SpaceProfile.gatewayProfile`、`model.spec.gatewayProfile` 与文档级 `current`
 *    发的都是这一串，认不出它等于把现网所有钉档洗成悬挂；
 *  - 没有可用 id（非对象/id 缺/空/非串）与同 id 的第二行都不渲条目、只披露（`readGateway` 的 `find`
 *    只会用第一条，注册表说「有两个」而运行面只认一个是假账）；
 *  - **`apiKey` 在这一面根本不出现**：条目只带 `keyConfigured` 布尔（R1 边界②：密钥只在盘上流转，
 *    任何以网关盘为输入的推导器都不许把它带进返回值——`/api/gateway` 列表面同一姿态）；
 *  - 「现在生效的是哪一档」（`GatewayDoc.current`）是**文档级**读数，不进任何条目：换档不是能力面变了，
 *    把它塞进某一档的 spec 会让换档抖出 specSha。
 */
function gatewayProfileEntries(ctx: ViewContext): ViewBuild {
  const roster = readGatewayRoster(ctx.dataDir);
  if (!roster.ok) {
    return {
      entries: [],
      disclosures: [
        {
          id: 'gateway.json',
          why: `网关配置读不出（${roster.why}）：「网关档」这一组因此一条也渲不出来——这不是「本机没有档」，是那盘读不动。`,
        },
      ],
    };
  }
  const entries: RegistryEntry[] = [];
  const disclosures: { id: string; why: string }[] = [];
  const seen = new Map<string, number>();
  roster.rows.forEach((row, i) => {
    const maybe = row as Partial<GatewayProfile> | null | undefined;
    const id = typeof maybe?.id === 'string' ? maybe.id : '';
    if (!id) {
      disclosures.push({
        id: `gateway.json profiles[${i}]`,
        why: '这一档没有可用的 id（不是对象，或 id 缺/空/非串）：任何钉档都指不到它，所以这里不渲条目——只披露不清除，要留要删去网关那一面。',
      });
      return;
    }
    const prior = seen.get(id);
    if (prior !== undefined) {
      disclosures.push({
        id: registryId('gateway-profile', id),
        why:
          `网关盘上有两枚 id「${id}」的档（第 ${prior + 1} 条与第 ${i + 1} 条）：读端只认第一条（与 ` +
          '`readGateway` 的 find 同一把尺），第二条没渲成条目——去网关那一面把其中一枚改名或删掉。',
      });
      return;
    }
    seen.set(id, i);
    const label = typeof maybe?.name === 'string' ? maybe.name.trim() : '';
    if (!label) {
      disclosures.push({
        id: registryId('gateway-profile', id),
        why: `档位「${id}」在盘上没有档名：注册中心这一行只能拿 id 称呼它（这不是替它起的名字）。`,
      });
    }
    const optional = (key: 'baseUrl' | 'freeModel'): string | undefined => {
      const v = maybe?.[key];
      if (v === undefined) return undefined;
      const trimmed = typeof v === 'string' ? v.trim() : '';
      if (!trimmed) {
        disclosures.push({
          id: registryId('gateway-profile', id),
          why: `档位「${id}」的 ${key} 不是可用的串（空或类型不对）：这一格没当值渲，也没当「没配」——去网关那一面看清那一格。`,
        });
        return undefined;
      }
      return trimmed;
    };
    const baseUrl = optional('baseUrl');
    const freeModel = optional('freeModel');
    const raw = {
      id: registryId('gateway-profile', id),
      kind: 'gateway-profile' as const,
      name: id,
      // 档是用户在本机配的，不是版本自带的（`source` 说出处；可写性由 `view` 标说，两条判据早已分家）
      source: 'user' as const,
      // 信封的 enabled 吃盘上那一格：`enabled` 缺省=配了就用（与 `upsertGatewayProfile` 的 ?? true 同一把尺）
      enabled: maybe?.enabled !== false,
      createdAt: BOOT_AT,
      updatedAt: BOOT_AT,
      spec: {
        label: label || id,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(freeModel !== undefined ? { freeModel } : {}),
        keyConfigured: Boolean(maybe?.apiKey),
      },
    };
    const norm = normalizeRegistryEntry(raw);
    if (!norm.ok) throw new Error(`网关盘算出了不合法的条目（${id}）：${norm.why}`);
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
  template: templateEntries,
  'gateway-profile': gatewayProfileEntries,
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
 * 措辞**必须逐 kind 给**：前三枚的正身是代码（成员与配置由版本决定），后三枚（`role`/`template`/
 * `gateway-profile`）的正身是用户数据（岗位在角色库、模板在画布那一面、档在网关那一面各已有写路径）。
 * 拿「内置出厂项、由版本决定」去拒岗位的写请求，就是当着用户的面说假话——那一枚岗是他自己建的。
 */
const VIEW_HOME: { [K in (typeof REGISTRY_VIEW_KINDS)[number]]: string } = {
  'agent-kind': '版本自带的 agent 类型清单（成员与配置由代码决定）',
  'node-type': '画布的节点类型清单（成员与配置由代码决定）',
  'check-type': '机检类型清单（成员与配置由代码决定）',
  role: '角色库那一面（岗位在那儿建、改、删；注册表只是它的镜子）',
  template: '编排模板那一面（模板在那儿存、改、删；注册表只是它的镜子）',
  'gateway-profile': '网关设置那一面（档位在那儿配、改、删；注册表只是它的镜子）',
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
