import type { RunSideEffects } from '@paneflow/shared';

/**
 * v12-S1a/S1b 副作用账目的纯函数小工具：清单判空 + 可读摘要。
 * 定位与 v12-V1 harness.ts 同款——判据全在 server（R4：CLI 只渲染不判断），
 * S1b 的 replay 门禁与透明性事件、拒绝文案都从这里取同一份「副作用清单」表述。
 */

/** 是否带在册副作用（任一非空键，含 prUrl/pushedAt）——S1b 门禁的唯一判据 */
export function hasSideEffects(se: RunSideEffects | undefined): boolean {
  if (!se) return false;
  return Boolean(
    (se.issuesCreated?.length ?? 0) > 0 ||
      (se.issuePatched?.length ?? 0) > 0 ||
      se.prUrl ||
      se.pushedAt,
  );
}

/**
 * 可读清单（供拒绝文案/透明性事件拼句，键缺即整项跳过、绝不编值）：
 * 建单#12 · 回写#7 · PR <url> · 已推送 <时刻>。空账返回空数组。
 */
export function sideEffectsSummary(se: RunSideEffects | undefined): string[] {
  if (!se) return [];
  const nums = (list?: number[]) => (list ?? []).map((n) => `#${n}`).join('、');
  return [
    se.issuesCreated?.length ? `建单${nums(se.issuesCreated)}` : '',
    se.issuePatched?.length ? `回写${nums(se.issuePatched)}` : '',
    se.prUrl ? `PR ${se.prUrl}` : '',
    se.pushedAt ? `已推送 ${se.pushedAt}` : '',
  ].filter(Boolean);
}
