/** v9-N3 排队卡的渲染条件（纯函数，测试锁死）：为什么等 + 排第几。 */
export interface QueueSnapshot {
  cap: number;
  running: { runId: string; title: string }[];
  queued: { runId: string; title: string; position: number }[];
}

export function queuedReasonText(queue: QueueSnapshot | null, runId: string): string {
  if (!queue) return '排队中：等并发额度空出后自动开跑。';
  const entry = queue.queued.find((x) => x.runId === runId);
  if (!entry) return '排队中：位次刷新中，额度空出即开跑。';
  if (queue.running.length === 0) return `排队中：你排第 ${entry.position} 位，额度将空，稍候自动开跑。`;
  const occ = queue.running.map((r) => `「${r.title}」`).join('、');
  return `并发额度 ${queue.cap} 已占满（占用：${occ}）· 你排第 ${entry.position} 位，前面的单终态后自动开跑。`;
}
