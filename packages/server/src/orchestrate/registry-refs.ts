import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY_KINDS, type DagGraph, type DagNodeConfig, type RegistryDescriptor, type RegistryEntry, type RegistryRefContext } from '@paneflow/shared';
import { Store, type SpaceProfile } from './store.js';
import { loadRoles, type Role } from './roles.js';
import { readGatewayDoc, type GatewayDoc } from '../api/gateway.js';
import { REGISTRY_DESCRIPTORS } from './registry-descriptors.js';

/**
 * v14 A2（R2）引用索引：**纯读推导**「谁在用这一项能力」，零新写路径
 * （先例=v13-V1 `machineCheckTally`：从既有落盘形状读时算，不建第二份事实源）。
 *
 * 为什么现在能扫、且只有这一份口径：跨面引用今天全是**裸字符串**（§一 第 3 读数：悬挂引用没有一处在写入面被拒过）。
 * 本模块把那批裸串按「哪个面的哪个键指向哪类能力」列成一张表（`SOURCES`），扫描即遍历这张表——
 * 将来某面迁进注册表（把裸串换成 `{kind,id}`），改的是这张表的一行，不是散在各处的 if。
 *
 * 三条姿态（都是 宁缺毋假 的具体化）：
 *  1. **只有已迁进表的 kind 才有「悬挂」可言**：指向 `gateway-profile`/`role`/`skill`… 的裸串今天不判死活
 *     （表里没有这一类，判「不存在」就是拿空白冒充断言）→ 进 `unmigrated`，只给计数与出处；
 *  2. 一条引用**指向表内 kind 且解析不到条目**才叫 dangling——它才是「删了会断」的那类账；
 *  3. 匹配用 Descriptor 的 `refKeys`（每 kind 自报「哪些裸串算指向我」），扫面侧不认识任何 spec 形状。
 */

/** 引用者是谁：面 + 条目 + 具体哪个键（`via` 是人能按图索骥去改的位置） */
export interface RegistryReferrer {
  face: 'space' | 'role' | 'template' | 'gateway';
  id: string;
  name: string;
  via: string;
}

export interface RawReference extends RegistryReferrer {
  kind: string;
  target: string;
}

export interface ReferenceIndex {
  /** 已迁 kind 的条目 → 引用者（注册中心「被 N 处使用」与详情列的来源） */
  byEntry: { entryId: string; kind: string; refs: RegistryReferrer[] }[];
  /** 指向已迁 kind 却解析不到条目：这才是可断的账 */
  dangling: { kind: string; target: string; by: RegistryReferrer[] }[];
  /** 指向尚未迁进表的 kind：只披露计数，绝不判死活（姿态 1） */
  unmigrated: { kind: string; targets: string[]; refs: number }[];
  /** 扫过的原始引用条数（含未迁 kind）——「这次扫描确实看了盘面」的自证 */
  scanned: number;
}

type Source = (dataDir: string) => RawReference[];

/**
 * 下面几支 `refsFromX` 是**纯函数**（一份档案 → 它发出的裸串引用），`SOURCES` 里的四支只是
 * 它们套上读盘的薄壳。为什么拆：v14 R5 的能力快照要问的是「**这一单**实发吃了哪些引用」，
 * 拿的是内存里的 run.graph / 该单的空间档案，不是全盘面重扫一遍——两头共用同一支抽取器，
 * 「哪个键算哪类能力」这张表自此只有一处（拆成两份迟早对不上，那就是第二份判据）。
 * 唯一的例外是 `refsFromRequires`：它只挂反向账，不进实发快照（原因写在那一支的注释里）。
 */

export function refsFromSpace(sp: SpaceProfile): RawReference[] {
  const out: RawReference[] = [];
  const by = { face: 'space' as const, id: sp.id, name: sp.name };
  const push = (kind: string, target: string | undefined, via: string): void => {
    if (target) out.push({ ...by, via, kind, target });
  };
  push('agent-kind', sp.defaultAgentKind, 'defaultAgentKind');
  push('gateway-profile', sp.gatewayProfile, 'gatewayProfile');
  (sp.team ?? []).forEach((m, i) => push('role', m.roleId, `team[${i}].roleId`));
  (sp.skills ?? []).forEach((s, i) => push('skill', s, `skills[${i}]`));
  (sp.repos ?? []).forEach((r, i) => push('repo', r, `repos[${i}]`));
  (sp.rules ?? []).forEach((r, i) => {
    push('rule', r.file, `rules[${i}].file`);
    push('repo', r.repo, `rules[${i}].repo`);
  });
  (sp.delivery ?? []).forEach((d, i) => push('repo', d.repo, `delivery[${i}].repo`));
  return out;
}

export function refsFromRole(role: Role): RawReference[] {
  const out: RawReference[] = [];
  const by = { face: 'role' as const, id: role.id, name: role.name };
  if (role.agentKind) out.push({ ...by, via: 'agentKind', kind: 'agent-kind', target: role.agentKind });
  (role.skills ?? []).forEach((s, i) => out.push({ ...by, via: `skills[${i}]`, kind: 'skill', target: s }));
  (role.rules ?? []).forEach((r, i) => out.push({ ...by, via: `rules[${i}]`, kind: 'rule', target: r }));
  return out;
}

/**
 * 一张模板/一次实发 graph → 它的节点级裸串引用。
 * `name` 由调用方给：在册模板传 `graph.name`（也就是 `pipeline.template` 指向的那枚），
 * run 的出场 graph 同样传它的 `graph.name`——两处同一枚键，反查才对得上。
 */
export function refsFromGraph(graph: DagGraph, name: string): RawReference[] {
  const out: RawReference[] = [];
  const by = { face: 'template' as const, id: name, name };
  graph.nodes.forEach((node, i) => {
    const cfg: DagNodeConfig = node.config ?? {};
    out.push({ ...by, via: `nodes[${i}].type`, kind: 'node-type', target: node.type });
    if (cfg.role) out.push({ ...by, via: `nodes[${i}].config.role`, kind: 'role', target: cfg.role });
    if (cfg.agentKind) out.push({ ...by, via: `nodes[${i}].config.agentKind`, kind: 'agent-kind', target: cfg.agentKind });
    if (cfg.pipeline?.template) out.push({ ...by, via: `nodes[${i}].config.pipeline.template`, kind: 'template', target: cfg.pipeline.template });
    if (cfg.pipeline?.fallbackTemplate)
      out.push({ ...by, via: `nodes[${i}].config.pipeline.fallbackTemplate`, kind: 'template', target: cfg.pipeline.fallbackTemplate });
    (cfg.checks ?? []).forEach((c, j) => out.push({ ...by, via: `nodes[${i}].config.checks[${j}].type`, kind: 'check-type', target: c.type }));
  });
  return out;
}

/**
 * 一张模板的**声明**引用（v14-T3 的 `requires`）——单列一支，不并进 `refsFromGraph`。
 * 为什么分家：`refsFromGraph` 同时喂 R5 的运行能力快照（「这一单实发吃了哪些能力」），
 * 而 `requires` 是作者写下的「这单**需要**什么」，今天没有任何执行面消费它——并进去就是拿
 * 声明冒充实发（机检/自报双口径的同一条教训）。这里只进 R2 的反向引用账，回答的问题是
 * 「删掉这枚条目会让哪张模板的预检从此红着」，那正是「删了会断」的账。
 *
 * 只统计**写了 id** 的槽：没 id 的槽是「这一类里随便一枚」，删哪枚都不构成对它的定点引用。
 */
export function refsFromRequires(graph: DagGraph, name: string): RawReference[] {
  const by = { face: 'template' as const, id: name, name };
  return (graph.requires ?? [])
    .map((r, i) => ({ ref: r, via: `requires[${i}].id` }))
    .filter(({ ref }) => typeof ref.id === 'string' && ref.id)
    .map(({ ref, via }) => ({ ...by, via, kind: String(ref.kind), target: ref.id as string }));
}

/**
 * 网关文档 → `current` 与逐档 `freeModel` 的引用。只读文档、不读密钥——`apiKey` 在本模块的
 * 任何输出里都不存在（R1 边界②：密钥禁入 spec，也禁入引用面与快照）。
 */
export function refsFromGatewayDoc(doc: GatewayDoc): RawReference[] {
  const out: RawReference[] = [];
  if (doc.current) {
    const cur = doc.profiles.find((p) => p.id === doc.current);
    out.push({ face: 'gateway', id: doc.current, name: cur?.name ?? doc.current, via: 'current', kind: 'gateway-profile', target: doc.current });
  }
  for (const p of doc.profiles) {
    if (p.freeModel) out.push({ face: 'gateway', id: p.id, name: p.name, via: 'freeModel', kind: 'model', target: p.freeModel });
  }
  return out;
}

const spaceRefs: Source = (dataDir) => Store.listSpaces(dataDir).flatMap(refsFromSpace);

const roleRefs: Source = (dataDir) => loadRoles(dataDir).flatMap(refsFromRole);

const templateRefs: Source = (dataDir) =>
  readStoredGraphs(dataDir).flatMap((g) => [...refsFromGraph(g, g.name), ...refsFromRequires(g, g.name)]);

/**
 * 只读地拿模板，**不 new Store**：`Store` 的构造期会 `mkdir` 并补写默认项目档案
 * （`store.ts:191-205`），一个自称纯读的推导器不该有这种写副作用。
 * 口径与 `Store.listGraphs()` 对齐：只取 `*.json`、坏文件跳过（那里也是 `readJson` 返回 null 就滤掉）。
 * 目录读不动则**照抛**——由路由层渲成「引用账扫不出」500，绝不降级成「零引用」放行删除。
 *
 * v14-T3 起这枚也供预检路由用（`GET /api/registry/check` 要遍历在册模板）：预检与引用账
 * 看的是同一堆模板文件，开第二条读盘路＝迟早两边数的模板不一样。
 */
export function readStoredGraphs(dataDir: string): DagGraph[] {
  const graphsDir = path.join(dataDir, 'graphs');
  if (!fs.existsSync(graphsDir)) return []; // 一个模板也没有＝正读数（新装机器）
  const out: DagGraph[] = [];
  for (const f of fs.readdirSync(graphsDir).filter((x) => x.endsWith('.json')).sort()) {
    let graph: unknown;
    try {
      graph = JSON.parse(fs.readFileSync(path.join(graphsDir, f), 'utf8')) as unknown;
    } catch {
      continue;
    }
    if (graph && typeof graph === 'object' && typeof (graph as DagGraph).name === 'string' && Array.isArray((graph as DagGraph).nodes)) {
      out.push(graph as DagGraph);
    }
  }
  return out;
}

/** 网关档的 `freeModel` 与 `current`（§一 第 13 行：模型今天只作为网关档的 freeModel 字段活着） */
const gatewayRefs: Source = (dataDir) => refsFromGatewayDoc(readGatewayDoc(dataDir));

/** 一张表列尽现役裸串引用面；新面进表只加一行，不改判据 */
const SOURCES: Source[] = [spaceRefs, roleRefs, templateRefs, gatewayRefs];

export function scanRawReferences(dataDir: string): RawReference[] {
  return SOURCES.flatMap((src) => src(dataDir));
}

/**
 * 一条裸串是不是指向我这一枚条目（由 Descriptor 自报口径；未挂号的 kind 不匹配任何条目）。
 * `ref` 给的是引用出处（哪一面、哪一枚档案发的）——只有声明了 `matches` 的 kind 用得上它，
 * 用途见 `registry-descriptors.ts` 里 `skill` 那一枚的注释。
 * **导出给 R5 的快照器共用**：反向引用账与正向快照必须是同一把匹配尺，两份迟早给出两个答案。
 */
export function matchesTarget(entry: RegistryEntry, target: string, ref?: RegistryRefContext): boolean {
  const descriptor = (REGISTRY_DESCRIPTORS as unknown as Record<string, RegistryDescriptor | undefined>)[entry.kind];
  if (!descriptor) return false;
  const keys = descriptor.refKeys(entry);
  if (!keys.includes(target)) {
    // 这一 kind 声明了 target 的归一写法（今天只有 `repo`：远端仓既可能是 URL 也可能是 `owner/repo`）：
    // 原样对不上时再拿归一名试一次。归一只在这一处发生、只按 kind 自己报的那把尺，
    // 且**不放宽**任何判据——它对不上的还是对不上，只是不再把同一枚仓的两种拼法当成两回事。
    const norm = descriptor.normalizeTarget?.(target);
    if (norm === undefined || norm === target || !keys.includes(norm)) return false;
  }
  return descriptor.matches ? descriptor.matches(entry, target, ref ?? { face: '', id: '' }) : true;
}

/**
 * 一条裸串的**全部**命中条目（`matchesTarget` 的复数版，反向账用它）。
 * 为什么反向要"全都算"而正向快照只取一枚（`registry-snapshot.ts`）：两边问的不是一个问题——
 * 反向问「删了会断谁」，多报只是多挡一次删除（可绕：先改引用再删），漏报则是静默把现役配置剪断；
 * 正向问「这一单实发吃了哪枚」，两枚都记就是宣称它读了两个文件，那是**多出来的一个结论**，不是保守。
 */
export function matchedEntries(entries: RegistryEntry[], ref: RawReference): RegistryEntry[] {
  return entries.filter((e) => e.kind === ref.kind && matchesTarget(e, ref.target, { face: ref.face, id: ref.id }));
}

/**
 * 建索引。`entries` 由调用方给（读面是 `RegistryStore.readView().entries`——用户登记项 + 出厂视图项；
 * 只喂 `load()` 的话 `agent-kind` 一类永远读成悬挂）——本模块不读注册表，
 * 免得在扫描器里再开一条读盘路（同一份数据两个读端＝迟早对不上）。
 */
export function buildReferenceIndex(entries: RegistryEntry[], raw: RawReference[]): ReferenceIndex {
  const byEntry = entries.map((e) => ({ entryId: e.id, kind: e.kind, refs: [] as RegistryReferrer[] }));
  const slot = new Map(byEntry.map((b) => [b.entryId, b]));
  const danglingByKey = new Map<string, { kind: string; target: string; by: RegistryReferrer[] }>();
  const unmigratedByKey = new Map<string, { kind: string; targets: Set<string>; refs: number }>();
  const known = new Set<string>(REGISTRY_KINDS);

  for (const ref of raw) {
    if (!known.has(ref.kind)) {
      const cur = unmigratedByKey.get(ref.kind) ?? { kind: ref.kind, targets: new Set<string>(), refs: 0 };
      cur.targets.add(ref.target);
      cur.refs += 1;
      unmigratedByKey.set(ref.kind, cur);
      continue;
    }
    const hits = matchedEntries(entries, ref);
    if (hits.length) {
      // 一枚裸串命中多枚条目（`skill` 的相对路径跨空间可撞）时**逐条记全**：见 `matchedEntries` 那段
      // 「反向多报只是多挡一次删除，漏报才是静默剪断现役配置」。宁可不漂亮，不放过一条真引用。
      for (const hit of hits) slot.get(hit.id)?.refs.push({ face: ref.face, id: ref.id, name: ref.name, via: ref.via });
      continue;
    }
    const key = `${ref.kind}\u0000${ref.target}`;
    const cur = danglingByKey.get(key) ?? { kind: ref.kind, target: ref.target, by: [] };
    cur.by.push({ face: ref.face, id: ref.id, name: ref.name, via: ref.via });
    danglingByKey.set(key, cur);
  }

  for (const b of byEntry) b.refs.sort((x, y) => `${x.face}:${x.id}:${x.via}`.localeCompare(`${y.face}:${y.id}:${y.via}`));
  return {
    byEntry,
    dangling: [...danglingByKey.values()].sort((a, b) => `${a.kind}${a.target}`.localeCompare(`${b.kind}${b.target}`)),
    unmigrated: [...unmigratedByKey.values()]
      .map((u) => ({ kind: u.kind, targets: [...u.targets].sort(), refs: u.refs }))
      .sort((a, b) => b.refs - a.refs || a.kind.localeCompare(b.kind)),
    scanned: raw.length,
  };
}

export function readReferenceIndex(dataDir: string, entries: RegistryEntry[]): ReferenceIndex {
  return buildReferenceIndex(entries, scanRawReferences(dataDir));
}

export function refsForEntry(index: ReferenceIndex, entryId: string): RegistryReferrer[] {
  return index.byEntry.find((b) => b.entryId === entryId)?.refs ?? [];
}
