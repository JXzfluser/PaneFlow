import { splitRegistryId, type RegistryDescriptor, type RegistryEntry, type RegistryKind } from '@paneflow/shared';

/**
 * v14 A1（R1）Descriptor 表：**一 kind 一模块**的落地处（决议 §十.5）。
 *
 * 这张表守的是「新 kind 忘了挂号」——类型是 mapped over `RegistryKind`，
 * `RegistrySpecMap` 加成员而这里不补一枚，编译期就红（shared 的 `SPEC_PARSERS` 用同一招）。
 *
 * `probe`（只读第五动词）本片**不声明**：A1 没有任何调用它的面，先立槽就是死码（家规：死码清零）。
 * 它的实现属于 R4 探测单通道——那边一有「现役注册项还在不在」的读端，这枚槽随调用点一起落。
 */

/** `model`：把网关探针读到的型号从一次性清单变成长得出回来的常用项；`label` 同时喂 API 与 CLI */
export const modelDescriptor: RegistryDescriptor<'model'> = {
  kind: 'model',
  label(entry) {
    const parts = [entry.spec.model];
    if (entry.spec.gatewayProfile) parts.push(`档=${entry.spec.gatewayProfile}`);
    if (entry.spec.freeModel) parts.push('免费位');
    if (entry.spec.note) parts.push(entry.spec.note);
    return parts.join(' · ');
  },
  /**
   * 现役配置里指向一枚模型条目的写法只有三种：整枚 id、id 的 slug 段、以及 spec 里的型号原值
   * （今天落册的引用就是网关档 `freeModel` 那串型号名，见 `registry-refs.ts`）。
   * 登记时起的中文名不是引用写法——所以它进不了这张表，别拿 label 当匹配键。
   */
  refKeys(entry) {
    const slug = splitRegistryId(entry.id)?.slug;
    return [entry.id, entry.spec.model, ...(slug ? [slug] : [])];
  },
};

export const REGISTRY_DESCRIPTORS: { [K in RegistryEntry['kind']]: RegistryDescriptor<K> } = {
  model: modelDescriptor,
};

/** 按条目 kind 查人话标签（读端每条都过这里，所以 `label` 只可能有一份口径） */
export function registryLabel(entry: RegistryEntry): string {
  const table = REGISTRY_DESCRIPTORS as Record<string, RegistryDescriptor<RegistryKind>>;
  const descriptor = table[entry.kind];
  // 认不出的 kind 走不到这里（`load()` 整条不认）；兜 name 只为防将来加 kind 时这里漏挂号，不返空串冒充标签
  return descriptor ? descriptor.label(entry) : entry.name;
}
