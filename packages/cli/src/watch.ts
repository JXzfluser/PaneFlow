import { ApiError, request } from './client.js';
import { hhmmss, paint, stateMark } from './format.js';
import {
  EXIT_GATE,
  EXIT_OK,
  EXIT_RED,
  EXIT_TIMEOUT,
  type CliIo,
  type NodeRunView,
  type RunView,
} from './types.js';

export const DEFAULT_TIMEOUT = '30m';
export const DEFAULT_INTERVAL_MS = 3000;

/**
 * --timeout 简写解析：60s / 30m / 2h / 1500ms，纯数字按秒；0=不限。
 * 解析失败抛错（调用方给 usage）。
 */
export function parseDuration(text: string): number {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) throw new Error(`时长格式非法：${text}（可用 60s / 30m / 2h，纯数字按秒，0=不限）`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.round(n * factor);
}

/** D3（v11）前瞻：server 尚未实现该终态，但退出码契约按字面量先吃下——有红即 1 */
export const COMPLETED_WITH_FAILURES = 'completed-with-failures';

const ACTIVE_NODE_STATES = new Set(['working', 'starting', 'retrying', 'queued']);
const GATE_NODE_STATES = new Set(['blocked', 'paused']);

export interface RunDecision {
  kind: 'green' | 'red' | 'gate' | 'pending';
  /** kind==='gate' 时的待批节点 id（paused 也在列——审批上下文在，但需续跑） */
  nodeIds: string[];
  /** kind==='red' 时的失败/取消节点（人读明细用） */
  badNodes?: NodeRunView[];
}

/**
 * 终局判定：只看 server 字段。
 * 审批门优先读 v11-A1 只读聚合字段 awaitingApproval；老 server 无此字段时
 * 按节点 state（同样是 server 返回的字段）做等价推导，逻辑与 server 端一致。
 */
export function decideRun(run: RunView): RunDecision {
  const state = String(run.state);
  if (state === 'completed') return { kind: 'green', nodeIds: [] };
  if (state === 'failed' || state === 'cancelled' || state === COMPLETED_WITH_FAILURES) {
    const bad = Object.values(run.nodes ?? {}).filter(
      (n) => n.state === 'failed' || n.state === 'cancelled',
    );
    return { kind: 'red', nodeIds: [], badNodes: bad };
  }
  const gate = awaitingApprovalOf(run);
  if (gate.waiting) return { kind: 'gate', nodeIds: gate.nodeIds };
  return { kind: 'pending', nodeIds: [] };
}

export function awaitingApprovalOf(run: RunView): { waiting: boolean; nodeIds: string[] } {
  const agg = run.awaitingApproval;
  if (agg && typeof agg === 'object' && Array.isArray(agg.nodeIds)) {
    return { waiting: Boolean(agg.waiting), nodeIds: agg.nodeIds.map(String) };
  }
  const recs = Object.values(run.nodes ?? {});
  const nodeIds = recs.filter((n) => GATE_NODE_STATES.has(n.state)).map((n) => n.nodeId);
  const anyActive = recs.some((n) => ACTIVE_NODE_STATES.has(n.state));
  return {
    waiting: run.state === 'running' && nodeIds.length > 0 && !anyActive,
    nodeIds,
  };
}

/**
 * watch 主循环：轮询 → 判定 → 终态退。退出码即机器验收：
 * 0 全绿 / 1 有红 / 2 超时 / 3 停在审批门（打印待批 nodeId；CLI 绝不替人批）。
 */
export async function watchRun(
  io: CliIo,
  baseUrl: string,
  runId: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<number> {
  const deadline = opts.timeoutMs > 0 ? io.now() + opts.timeoutMs : Infinity;
  let last: RunView | undefined;
  for (;;) {
    try {
      const { body } = await request<RunView>(io, baseUrl, 'GET', `/api/runs/${encodeURIComponent(runId)}`);
      last = body;
      const d = decideRun(body);
      if (d.kind === 'green') {
        io.out(`${paint(io, '32', '✔ 全绿')} run ${body.runId}（${body.dagName ?? '-'}）· ${stateMark(io, body.state)}`);
        return EXIT_OK;
      }
      if (d.kind === 'red') {
        io.out(`${paint(io, '31', '✘ 有红')} run ${body.runId} · ${stateMark(io, body.state)}`);
        for (const n of d.badNodes ?? []) {
          io.out(`    ${n.nodeId}: ${stateMark(io, n.state)}${n.error ? ` —— ${n.error.slice(0, 160)}` : ''}`);
        }
        return EXIT_RED;
      }
      if (d.kind === 'gate') {
        io.out(`${paint(io, '33', '⏸ 停在审批门')} run ${body.runId} · 待批节点：`);
        for (const id of d.nodeIds) io.out(`    ${id}`);
        io.out(`  批准：paneflow approve ${body.runId} <nodeId>（CLI 不替你过门）`);
        return EXIT_GATE;
      }
      io.out(`  [${hhmmss(new Date(io.now()).toISOString())}] ${stateMark(io, body.state)} · ${nodeProgressLine(body)}`);
    } catch (err) {
      // runId 不存在：立刻退（main 统一报 1），不空转到超时
      if (err instanceof ApiError && err.status === 404) throw err;
      // 其余（网络抖断/服务瞬断）：报告后继续轮询——终态判定只认成功拿到的 run
      io.err(`  ! ${(err as Error).message}`);
    }
    if (io.now() + opts.intervalMs > deadline) {
      const seen = last ? `，最后状态 ${last.state}` : '';
      io.out(`${paint(io, '31', '⏱ 超时')}（${opts.timeoutMs / 1000}s 未达终态${seen}）`);
      return EXIT_TIMEOUT;
    }
    await io.sleep(opts.intervalMs);
  }
}

function nodeProgressLine(run: RunView): string {
  const recs = Object.values(run.nodes ?? {});
  if (!recs.length) return '-';
  const counts = new Map<string, number>();
  for (const n of recs) counts.set(n.state, (counts.get(n.state) ?? 0) + 1);
  return [...counts.entries()].map(([s, c]) => `${s}=${c}`).join(' ');
}
