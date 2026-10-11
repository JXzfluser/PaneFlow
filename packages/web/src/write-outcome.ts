/**
 * 一次请求失败后要说的那句人话，落在人按下按钮的那一处。
 *
 * 从前这类句子只写进底部控制台，界面看上去就是「点了没反应」；设置页与任务页各抄一份措辞又会
 * 长成两张脸。判据仍不住浏览器：server 给了原话就照渲，这里只负责把「有原因 / 只回了码 /
 * 压根没连上」三种读法分开说清，绝不合成一句搪塞。
 */

type Readable = 'offline' | { said: string } | { bare: number };

function readable(err: unknown): Readable {
  const e = err as { status?: number; payload?: { error?: unknown } };
  if (typeof e?.status !== 'number') return 'offline';
  const said = typeof e.payload?.error === 'string' ? e.payload.error.trim() : '';
  return said ? { said } : { bare: e.status };
}

export function writeFailureNote(action: string, err: unknown): string {
  const r = readable(err);
  if (r === 'offline') return `${action}：连不上本机服务（server 没在跑？）`;
  if ('said' in r) return `${action}：${r.said}`;
  // 5xx 且无原因：写端是「先校验后落笔」，但这一发的落点不可考，就不替它保证盘上没动
  return r.bare >= 500
    ? `${action}：server 回 ${r.bare} 且没给原因（改没改成不确定，刷新看盘上的读数）`
    : `${action}：server 回 ${r.bare} 且没给原因`;
}

/** 读路径的同一句法：失败不等于「没有内容」，两种画法得分开 */
export function readFailureNote(action: string, err: unknown): string {
  const r = readable(err);
  if (r === 'offline') return `${action}：连不上本机服务（server 没在跑？）`;
  if ('said' in r) return `${action}：${r.said}`;
  return `${action}：server 回 ${r.bare} 且没给原因（这是没读成，不是「没有内容」）`;
}
