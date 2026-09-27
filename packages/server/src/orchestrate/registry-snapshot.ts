import { REGISTRY_KINDS, type RegistryEntry, type RunCapabilityRef } from '@paneflow/shared';
import { contentSha } from './harness.js';
import { matchesTarget, type RawReference } from './registry-refs.js';

/**
 * v14 R5 逐单能力快照：**这一单**起单现场吃到了哪几枚注册表条目，把整份 `spec` 抄进 run 记录。
 *
 * 为什么是副本而不是引用（§二 R5 判死 v0.1 `regSha=活行内容指纹` 的那一条）：
 * 引用活行＝今天编辑一条配置，所有历史 run 的「当时用了什么」跟着改写，历史自此不可考；
 * 快照自带原文，条目被改了甚至被删了，这一单读到的还是它起单时那一份。
 *
 * 三条姿态：
 *  1. **只快照已迁进表的 kind**：指向 `role`/`check-type`/`template`… 的裸串今天表里没有这一类，
 *     快照它们就是拿注册表外的形状冒充注册表读数（与 R2 的 `unmigrated` 同一把尺）；
 *  2. **悬挂引用不进快照**：指向表内 kind 却解析不到条目，是 T3 预检的账（「这单会缺什么」），
 *     不在这里重复一份判据；快照只回答「实际吃进了什么」；
 *  3. **返回 null＝整键不给**，不返回空数组：`[]` 是正断言「扫过了、一条已迁能力都没吃」，
 *     而「没走到注册消费面」与它是两件事（宁缺毋假）。今天已迁进表的是登记项五枚（`model`、
 *     `skill`(A5-1)、`rule`(A5-2)、`repo`(A5-3)、`mcp`(T4)）与两枚**视图 kind**
 *     （A3-2 的 `agent-kind`、T1 的 `node-type`：条目由出厂清单现算、不落盘，所以调用方必须喂
 *     `readView().entries`——只喂 `load()` 会把这两类静默读成「没吃到」，cap# 就此漏账）；
 *     样张里那枚「技能 2」自 A5-1 起真可能出现（`skill` 进了表），「机检 3」还要等 `check-type` 迁入——
 *     那是波次问题，不是这里少写了；
 *  4. **`enabled: false` 的条目不进快照**（不算「这一单在用的能力」）。取舍写实：停用是注册表里
 *     唯一表达「这项能力不再现役」的键，把它算进能力面会让「一臂启用/一臂停用」的 cap# 相等，
 *     等臂第四枚判据就此漏掉一次真实的能力面变更——宁可少记一条，不可漏报一次变更。
 */
export interface CapabilitySnapshot {
  refs: RunCapabilityRef[];
  /**
   * 整单能力面指纹（`cap#`）：**不含 `via`**——等臂比对问的是「两臂吃了同一组能力没有」，
   * 引用出自哪一格不是能力面的差异（同 id 集合 ∧ 逐条 specSha 相等＝能力面相同）。
   */
  sha: string;
}

/**
 * `entries` 与 `raw` 都由调用方给（引擎现场：本单出场 graph + 该单空间档案 + 实绑角色 + 生效网关档）。
 * 匹配走 Descriptor 的 `refKeys`（`matchesTarget`，与 R2 反向引用账同一支），这里不认识任何 spec 形状。
 */
export function capabilitySnapshot(
  entries: RegistryEntry[],
  raw: RawReference[],
): CapabilitySnapshot | null {
  const known = new Set<string>(REGISTRY_KINDS);
  const hits = new Map<string, { entry: RegistryEntry; via: Set<string> }>();
  for (const ref of raw) {
    if (!known.has(ref.kind)) continue;
    const matched = entries.filter(
      (e) => e.kind === ref.kind && e.enabled !== false && matchesTarget(e, ref.target, { face: ref.face, id: ref.id }),
    );
    if (!matched.length) continue;
    // 一枚裸串同时命中两枚条目（`skill`/`rule` 的相对路径、`repo` 的目录名都会跨空间撞）：
    // 正向账**不猜**是哪一枚。记一条=宣称这一单读了那个文件，那是多出来的一个结论（宁缺毋假）；
    // 反向账相反，逐条记全（`registry-refs.ts: matchedEntries` 那段）——两边问的不是同一个问题。
    if (matched.length > 1) continue;
    const entry = matched[0]!;
    const cur = hits.get(entry.id) ?? { entry, via: new Set<string>() };
    cur.via.add(`${ref.face}·${ref.via}`);
    hits.set(entry.id, cur);
  }
  if (!hits.size) return null;
  const refs: RunCapabilityRef[] = [...hits.values()]
    .map(({ entry, via }) => ({
      kind: entry.kind,
      id: entry.id,
      // 规范化后的内容指纹（键序无关，口径同 graphSha/templateSha）：同 id 而此值变＝中间改过配置
      specSha: contentSha(entry.spec),
      // 整份抄写（深拷贝）：条目日后被编辑/删除，这一单读到的还是起单时那一份
      spec: structuredClone(entry.spec),
      via: [...via].sort(),
    }))
    .sort((a, b) => `${a.kind}\u0000${a.id}`.localeCompare(`${b.kind}\u0000${b.id}`));
  return { refs, sha: contentSha(refs.map(({ kind, id, specSha, spec }) => ({ kind, id, specSha, spec }))) };
}
