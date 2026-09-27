import fs from 'node:fs';
import path from 'node:path';
import { probeCatalogProfiles } from './gateway-catalog.js';
import { readGatewayDoc } from './gateway.js';
import { probeBinaryPresence } from './env-check.js';
import { Store } from '../orchestrate/store.js';
import type { RegistryEntry } from '@paneflow/shared';

/**
 * v14 R4：注册表条目的**健康读数**（注册中心首屏那颗点，`GET /api/registry/health` 逐项带出）。
 * 这里就是 §十.5 说的「probe 槽随 R4 落」的那枚槽——一 kind 一枚通道，与 `SPEC_PARSERS`/
 * `DESCRIPTORS` 同一张分派表的形状（判据集中在 server 一处，消费面零判据）。
 *
 * 三条姿态，一条都不能松：
 *  1. **每类一条通道**——模型在不在，只经 `gateway-catalog.ts` 那份实探（同缓存、同时效、同密钥纪律）；
 *     agent 类型在不在，只经 `env-check.ts` 那份 PATH 探测（同缓存、同三态，也就是 `/api/health` 的
 *     `agentsInstalled` 吃的那一枚）。这里绝不自己 fetch `<base>/v1/models`、也绝不另起一次 `command -v`：
 *     第二条探针通道迟早和第一条读数不一致，
 *     注册中心从此一半表看网关、一半表看自己的旧账（v14 立项点名的 684 绿假账形状）。
 *  2. **三态**：`live`（实探清单里有）/ `missing`（探通了、清单里没有）/ `unknown`（没探通、档不存在、
 *     或压根没配档）。**超时与探不通一律 `unknown`，绝不并入 `missing`**——「未探得」不是「不可用」，
 *     把探针通道的故障画成红点就是替机器造一个不存在的结论（先例：`herdr-ops.ts:120-128 probeAgent`
 *     也只由明确错误码给 `gone`，答不上来返回 null）。
 *  3. **宁缺毋假**：这一类没有探针通道（今天的 template/role 等视图 kind）→ 整键不给，界面上什么都不画。
 *     「不知道这一类怎么探」和「探了说它不在」是两回事。
 */

/** `live`=在 · `missing`=实探清单里没有 · `unknown`=未探得（不等于不可用） */
export type HealthStatus = 'live' | 'missing' | 'unknown';

export interface EntryHealth {
  status: HealthStatus;
  /** 一句人话：为什么这么判、依据是哪一档的哪次实探。文案出自判据层，消费面只照读 */
  detail: string;
  /** 本次读数的时刻（缓存命中时是当初探的时刻，不是渲染时刻） */
  at: string;
  /** true=吃的缓存（不是这次现探的）；与 `/api/gateway/catalog` 的 `cached` 同语义 */
  cached: boolean;
}

/**
 * `model` 通道：条目 `spec.model`（可选钉 `spec.gatewayProfile`）对每档实探清单做成员检查。
 * 没钉档＝任一档里有即算在（登记时它从哪档探来不是判据）；钉了档＝只看那一档。
 */
async function modelHealth(dataDir: string, entry: RegistryEntry<'model'>, refresh: boolean): Promise<EntryHealth> {
  const model = entry.spec.model;
  const pinned = entry.spec.gatewayProfile;
  const doc = readGatewayDoc(dataDir);
  const targets = pinned ? doc.profiles.filter((p) => p.id === pinned) : doc.profiles;
  const now = Date.now();

  if (!targets.length) {
    // 档不存在与没配档都是「无从探」，不是「型号不存在」——画成红点就是探针自己造结论
    return {
      status: 'unknown',
      detail: pinned
        ? `钉着的网关档「${pinned}」在本机不存在：未探得，先改这一枚的归属档或去设置补档`
        : '本机没有配置网关档：未探得，不等于这枚模型不可用',
      cached: false,
      at: new Date(now).toISOString(),
    };
  }

  const probed = await probeCatalogProfiles(dataDir, targets, doc.current, { refresh });
  const stamp = Math.max(...probed.map((p) => p.probedAt));
  const hit = probed.find((p) => !p.error && p.models.includes(model));
  if (hit) {
    const free = hit.freeModel === model ? ' · 它正挂在免费位' : '';
    return {
      status: 'live',
      detail: `在「${hit.name}」的实探清单里（${hit.models.length} 枚中第 ${hit.models.indexOf(model) + 1} 枚${free}）`,
      cached: hit.cached,
      at: new Date(stamp).toISOString(),
    };
  }
  const dead = probed.filter((p) => p.error);
  if (dead.length) {
    // 有档没答上：既不能说在、也不能说不在，只说没探通，并把原因挂出来（人按这个位置去修）。
    // **超时正落在这里**——`probeGatewayModels` 带 6s AbortSignal，掐表中了一律 error 而非空清单，
    // 于是「未探得」与「清单里没有」从实现上就是两个状态（R4 那句「超时绝不并入 gone」的落点）。
    return {
      status: 'unknown',
      detail: `未探得：${dead.map((p) => `「${p.name}」${p.error}`).join('、')}（没探通不等于不可用）`,
      cached: dead.every((p) => p.cached),
      at: new Date(stamp).toISOString(),
    };
  }
  return {
    status: 'missing',
    detail: `${probed.map((p) => `「${p.name}」`).join('、')} 的实探清单（共 ${probed.reduce((n, p) => n + p.models.length, 0)} 枚）里都没有「${model}」`,
    cached: probed.every((p) => p.cached),
    at: new Date(stamp).toISOString(),
  };
}

/**
 * `agent-kind` 通道（v14 A3-2）：出厂清单里这一型的二进制在不在本机 PATH 上。
 * 三态直接抄 `probeBinaryPresence`——**那里的 `unknown` 就是这里的 `unknown`**（超时/sh 起不来/PATH 读不到
 * 都不是「没装」）。装没装永不进 `spec`（R1 边界：spec 是登记内容，探针结果是读数），所以这里每次现读、
 * 缓存只在探测层那一份。
 */
async function agentKindHealth(entry: RegistryEntry<'agent-kind'>, refresh: boolean): Promise<EntryHealth> {
  const bin = entry.spec.binary;
  const probed = await probeBinaryPresence(bin, { refresh });
  const detail =
    probed.status === 'live'
      ? `本机 PATH 上探到可执行文件「${bin}」，这一型可用`
      : probed.status === 'missing'
        ? `PATH 上逐个目录枚举完，没有「${bin}」这个可执行文件：本机没装这一型`
        : `未探得：${probed.why ?? '探测没给出原因'}（没探得不等于没装）`;
  return { status: probed.status, detail, cached: probed.cached, at: new Date(probed.at).toISOString() };
}

/**
 * `skill` 通道（v14 A5-1）：条目说的是「某项目根下有这篇可注入的技能文档」，那就去那个根下实读一次。
 * 三态的划法与家规一致：
 *  · **读到了=live**（顺带报字节数与改动时刻，人按这个位置判断是不是自己想要的那篇）；
 *  · **确实没有=missing**；越出主仓根也算 missing——注入现场（`orchestrate/skills.ts: safeJoin`）
 *    对这种路径就是跳过，「永远不会被注入」是一条确定结论，不是「没探通」；
 *  · **无从判=unknown**：项目档案里没这枚空间、空间没配 `rootCwd`（相对路径没有基准）、
 *    或 `stat` 抛的是权限/IO 错（读不动不等于不在）。
 * `refresh` 在这一枚是空参数：文件面没有缓存层，每次都是现探（`cached` 恒 false 因此是实话）。
 */
async function skillHealth(dataDir: string, entry: RegistryEntry<'skill'>): Promise<EntryHealth> {
  const { space, file } = entry.spec;
  const now = Date.now();
  const sp = Store.listSpaces(dataDir).find((x) => x.id === space);
  if (!sp) {
    return {
      status: 'unknown',
      detail: `项目档案里没有「${space}」这一枚，相对路径没有基准可比：未探得，不等于这篇技能不存在`,
      cached: false,
      at: new Date(now).toISOString(),
    };
  }
  const root = typeof sp.rootCwd === 'string' ? sp.rootCwd.trim() : '';
  if (!root) {
    return {
      status: 'unknown',
      detail: `项目「${sp.name}」没配主仓根（rootCwd），「${file}」没有基准可比：未探得`,
      cached: false,
      at: new Date(now).toISOString(),
    };
  }
  if (file.includes('..')) {
    return {
      status: 'missing',
      detail: `「${file}」越出了主仓根「${root}」：注入现场按同一把尺直接跳过，这篇永远不会被注进任何节点`,
      cached: false,
      at: new Date(now).toISOString(),
    };
  }
  const abs = path.resolve(root, file);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) {
      return {
        status: 'missing',
        detail: `「${abs}」在，但它不是文件（是目录或特殊节点）：注入现场读不出整篇内容，等于没有这篇`,
        cached: false,
        at: new Date(now).toISOString(),
      };
    }
    return {
      status: 'live',
      detail: `项目「${sp.name}」下读到了「${file}」（${st.size} 字节 · 改动于 ${st.mtime.toISOString()}）`,
      cached: false,
      at: new Date(now).toISOString(),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        status: 'missing',
        detail: `主仓根「${root}」下没有「${file}」这篇文件：登记与盘面已不一致，要么补文件要么停用它`,
        cached: false,
        at: new Date(now).toISOString(),
      };
    }
    return {
      status: 'unknown',
      detail: `读不动「${abs}」：${(err as Error).message}（读不动不等于不存在）`,
      cached: false,
      at: new Date(now).toISOString(),
    };
  }
}

/**
 * kind → 探针通道。没有条目的 kind 一律没有健康读数（整键不给，不画成未知）。
 *
 * **`mcp`（v14 T4）刻意不在这里**：探一台 MCP server 活着没有、有几个工具，需要一个真客户端去
 * 握手 + `tools/list`——而 v13:285 的既有裁决是不自实现 MCP 客户端。所以这一 kind 只有声明账
 * （`{command,args}` 登记的是「本机说有这台 server」），健康面**整键不给**。
 * 这不是漏写：把「没客户端可探」写成 `unknown` 已经是多给一个读数（`unknown` 的文档语义是
 * 「探了但没探通」），而画成 `missing` 就是替机器造一个不存在的结论。将来上客户端时，
 * 这枚通道随那条真探针路一起落（和 `node-type` 视图 kind 不给健康同一个处理）。
 */
const CHANNELS: Record<string, (dataDir: string, entry: RegistryEntry, refresh: boolean) => Promise<EntryHealth>> = {
  model: (dataDir, entry, refresh) => modelHealth(dataDir, entry as RegistryEntry<'model'>, refresh),
  skill: (dataDir, entry) => skillHealth(dataDir, entry as RegistryEntry<'skill'>),
  'agent-kind': (_dataDir, entry, refresh) => agentKindHealth(entry as RegistryEntry<'agent-kind'>, refresh),
};

/**
 * 逐条目算健康。没有通道的 kind 返回 `undefined`——路由据此**整键不给**（宁缺毋假）。
 * 通道自己不加 try/catch：`readGatewayDoc` 与 `probeGatewayModels` 已经把盘错与网络错收成了
 * 一句 error，再包一层就是给不会发生的路径写代码（真抛出来，让整次读数 500，比悄悄渲一颗点诚实）。
 */
export async function entryHealth(
  dataDir: string,
  entry: RegistryEntry,
  opts: { refresh?: boolean } = {},
): Promise<EntryHealth | undefined> {
  const channel = CHANNELS[entry.kind];
  if (!channel) return undefined;
  return channel(dataDir, entry, opts.refresh === true);
}
