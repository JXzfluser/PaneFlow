import type { CliIo } from './types.js';

/** 最小着色：只给状态词上色，别做 TUI。NO_COLOR / 非 TTY 时自动退纯文本 */
export function paint(io: CliIo, code: string, s: string): string {
  return io.color ? `\x1b[${code}m${s}\x1b[0m` : s;
}

/** run/node state → 展示符号（红=失败族，黄=门/排队，绿=完成）。纯展示映射，无判定语义 */
export function stateMark(io: CliIo, state: string): string {
  if (state === 'completed') return paint(io, '32', '✔ completed');
  if (state === 'failed' || state === 'cancelled' || state === 'completed-with-failures') {
    return paint(io, '31', `✘ ${state}`);
  }
  if (state === 'blocked' || state === 'paused' || state === 'queued') return paint(io, '33', `⏸ ${state}`);
  if (state === 'skipped') return paint(io, '90', `↷ ${state}`);
  return paint(io, '36', `● ${state}`);
}

/** ISO 时间戳 → 本地 HH:MM:SS（坏值原样回显，不抛） */
export function hhmmss(iso: string | undefined): string {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
}

/** ms → 人读时长（1h23m / 45s / 12s） */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}
