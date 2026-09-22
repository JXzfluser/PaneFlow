import crypto from 'node:crypto';
import type { RunHarness } from '@paneflow/shared';

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

const show = (v: string | undefined, none: string) => v || none;

/**
 * replay 漂移比对（只比 model/档位两个闸口；graphSha 恒等不比，agentKind 是 graph
 * 内配置+同一解析链，不在本片比对面）：原记录无 harness=旧单无从比，返回空；
 * 每项差异给出「原→今」可读文案，供透明性事件直接拼句。
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
  return diffs;
}
