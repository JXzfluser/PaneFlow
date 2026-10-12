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

/**
 * 一次写请求失败后要说的那句。`pending` 是**这一枚动词**落点不可考时的人话（「改没改成不确定…」只在
 * 真的在「改」什么东西时说不通，起单那两枚要的是「这单起没起」）——只换尾巴的说法，不换判据：
 * 浏览器仍然只说「这一发的落点读不到」，绝不替 server 断言盘上动没动。缺省沿用全站那句旧话。
 */
export function writeFailureNote(action: string, err: unknown, pending?: string): string {
  const r = readable(err);
  if (r === 'offline') return `${action}：连不上本机服务（server 没在跑？）`;
  if ('said' in r) return `${action}：${r.said}`;
  // 5xx 且无原因：写端是「先校验后落笔」，但这一发的落点不可考，就不替它保证盘上没动
  return r.bare >= 500
    ? `${action}：server 回 ${r.bare} 且没给原因（${pending ?? '改没改成不确定，刷新看盘上的读数'}）`
    : `${action}：server 回 ${r.bare} 且没给原因`;
}

/** 读路径的同一句法：失败不等于「没有内容」，两种画法得分开 */
export function readFailureNote(action: string, err: unknown): string {
  const r = readable(err);
  if (r === 'offline') return `${action}：连不上本机服务（server 没在跑？）`;
  if ('said' in r) return `${action}：${r.said}`;
  return `${action}：server 回 ${r.bare} 且没给原因（这是没读成，不是「没有内容」）`;
}

/**
 * 批门按下之后成了要说的那句（v19 步骤十三）。200 说的是「这一发 server 收了、等门的引擎被叫醒了」，
 * 而门从画面上撤下要等账本推上来——中间那段窗口以前是纯静默，人只能猜自己那一下按没按到。
 * 措辞单源：四面（看板卡 / 审阅队列 / 审批卡 / 契约门）共用这一枚函数，免得长成四张脸。
 */
export function gateReleaseNote(action: 'approve' | 'reject' | 'input'): string {
  if (action === 'approve') return '已放行——server 收了这一发（等这一步的账推上来）';
  if (action === 'reject') return '已驳回——server 收了这一发（等这一步的账推上来）';
  return '指令已送到——server 收了这一发（等这一步的账推上来）';
}

/**
 * 插队（提到队首）成了要说的那句（v19 步骤十四）。server 认了这一刻，卡上「你排第 N 位」
 * 要等下一次排队读数才翻过来——那段窗口从前是纯静默，按钮弹回原样就像没按到。
 * 刻意不写「已是队首」：位次真不真到 1，只有排队读数说了算，这句只到「收了这一发」。
 */
export function queuePromoteNote(): string {
  return '插队这一发 server 收了（位次等下一次排队读数）';
}
