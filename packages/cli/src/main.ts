import { request } from './client.js';
import { resolveBaseUrl } from './config.js';
import { hhmmss, humanMs, paint, stateMark } from './format.js';
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT,
  parseDuration,
  watchRun,
} from './watch.js';
import { EXIT_OK, EXIT_RED, type CliIo, type DispatchResult, type RunView } from './types.js';

/** 与 release launcher（bin/paneflow.mjs）的路由表同源：这几枚子命令走 CLI，其余起 server */
export const CLI_SUBCOMMANDS = ['dispatch', 'runs', 'status', 'watch', 'approve'] as const;

/** 带值的长选项；不在列的 --xxx 视为布尔开关（目前只有 --json） */
const VALUE_FLAGS = new Set(['url', 'repo', 'issue', 'timeout', 'interval', 'space']);

interface Args {
  positional: string[];
  flags: Record<string, string>;
  bools: Set<string>;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], flags: {}, bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      args.positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
    if (eq >= 0) {
      args.flags[name] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      args.flags[name] = next;
      i++;
    } else {
      args.bools.add(name);
    }
  }
  return args;
}

const USAGE = [
  '用法：paneflow <子命令> [参数]',
  '',
  '  paneflow dispatch "<一句话>" [--repo owner/name] [--issue N] [--space S] [--url U] [--json]',
  '  paneflow runs [--json]',
  '  paneflow status <runId> [--json]',
  '  paneflow watch <runId> [--timeout 30m] [--interval 3000]   退出码：0 全绿 / 1 有红 / 2 超时 / 3 停在审批门',
  '  paneflow approve <runId> <nodeId>                          批准（CLI 绝不替你批）',
  '',
  '地址解析：--url > $PANEFLOW_URL > ~/.paneflow/cli.json 的 url > http://127.0.0.1:4310',
  '远程模式带令牌：$PANEFLOW_TOKEN → Authorization: Bearer',
].join('\n');

/**
 * 统一入口（release bin 与 dev tsx 都调这里），返回 process.exitCode。
 * 业务判断全在 server：这里只做参数编排 + HTTP 转发 + 结果打印。
 */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.out(USAGE);
    return cmd ? EXIT_OK : EXIT_RED;
  }
  if (!(CLI_SUBCOMMANDS as readonly string[]).includes(cmd)) {
    io.err(`未知子命令：${cmd}\n\n${USAGE}`);
    return EXIT_RED;
  }
  const args = parseArgs(rest);
  const baseUrl = resolveBaseUrl(io, args.flags.url);
  try {
    switch (cmd) {
      case 'dispatch':
        return await cmdDispatch(io, baseUrl, args);
      case 'runs':
        return await cmdRuns(io, baseUrl, args);
      case 'status':
        return await cmdStatus(io, baseUrl, args);
      case 'approve':
        return await cmdApprove(io, baseUrl, args);
      case 'watch':
        return await cmdWatch(io, baseUrl, args);
    }
  } catch (err) {
    io.err(`${paint(io, '31', '✘')} ${(err as Error).message}`);
    return EXIT_RED;
  }
  return EXIT_RED;
}

function requirePos(args: Args, n: number, hint: string): void {
  if (args.positional.length < n) throw new Error(`参数不足：${hint}`);
}

function jsonOr(args: Args): boolean {
  return args.bools.has('json');
}

function dump(io: CliIo, payload: unknown): void {
  io.out(JSON.stringify(payload, null, 2));
}

// -- dispatch --------------------------------------------------------------

async function cmdDispatch(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  requirePos(args, 1, 'paneflow dispatch "<一句话>"');
  const task = args.positional[0]!;
  const repo = args.flags.repo?.trim();
  const issue = args.flags.issue?.trim();
  const body: { task: string; issueId?: string } = { task };
  if (repo && !issue) throw new Error('--repo 只在配合 --issue 时有意义（issue 归属仓）');
  if (issue && !/^\d+$/.test(issue)) throw new Error(`--issue 需为数字编号，收到：${issue}`);
  if (issue && repo) {
    // server 端 parseIssueRef 只从任务文本认 repo——把规范 issue URL 拼进去即可，
    // 不另发明 body 字段（issueId 留空让文本解析通道生效）
    body.task = `${task}\n\n（关联 Issue：https://github.com/${repo}/issues/${issue}）`;
  } else if (issue) {
    body.issueId = issue;
  }
  const q = args.flags.space ? `?space=${encodeURIComponent(args.flags.space)}` : '';
  const { body: res } = await request<DispatchResult>(io, baseUrl, 'POST', `/api/dispatch${q}`, body);
  if (jsonOr(args)) {
    dump(io, res);
    return EXIT_OK;
  }
  io.out(`${paint(io, '32', '✔ 已派活')} run ${paint(io, '1', res.runId)}${res.issueId ? ` · Issue #${res.issueId}${res.issueFetched ? '（正文已拉取）' : '（正文未取到，按描述执行）'}` : ''}`);
  if (res.note) io.out(`  ! ${res.note}`);
  const c = res.contract;
  if (c) {
    io.out(
      `  契约：${
        c.mode === 'extracted'
          ? `机检 ${c.assertions} 条`
          : c.mode === 'autofilled'
            ? `AI 补约 ${c.assertions} 条（停在契约门等确认）`
            : `无——Planner 立约 + 契约门${c.template ? `（模板 ${c.template}）` : ''}`
      }`,
    );
  }
  for (const n of res.nodes ?? []) {
    io.out(`  节点 ${n.id} · ${n.name}${n.dependsOn?.length ? ` ← ${n.dependsOn.join(', ')}` : ''}`);
  }
  io.out(`  跟进：paneflow watch ${res.runId}；细看：paneflow status ${res.runId}`);
  return EXIT_OK;
}

// -- runs -------------------------------------------------------------------

async function cmdRuns(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  const { body } = await request<{ runs: RunView[] }>(io, baseUrl, 'GET', '/api/runs');
  if (jsonOr(args)) {
    dump(io, body);
    return EXIT_OK;
  }
  if (!body.runs.length) {
    io.out('（暂无 run）');
    return EXIT_OK;
  }
  for (const r of body.runs) {
    const dur = r.startedAt
      ? humanMs((r.finishedAt ? Date.parse(r.finishedAt) : Date.now()) - Date.parse(r.startedAt))
      : '-';
    io.out(
      `  ${stateMark(io, r.state)}  ${r.runId}  ${r.dagName ?? '-'}${r.issueId ? `  #${r.issueId}` : ''}  ${hhmmss(r.startedAt)}  ${dur}`,
    );
  }
  return EXIT_OK;
}

// -- status ---------------------------------------------------------------

async function cmdStatus(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  requirePos(args, 1, 'paneflow status <runId>');
  const runId = args.positional[0]!;
  const { body: run } = await request<RunView>(io, baseUrl, 'GET', `/api/runs/${encodeURIComponent(runId)}`);
  if (jsonOr(args)) {
    dump(io, run);
    return EXIT_OK;
  }
  io.out(`run ${paint(io, '1', run.runId)} · ${run.dagName ?? '-'} · ${stateMark(io, run.state)}${run.issueId ? ` · Issue #${run.issueId}` : ''}`);
  const gate = run.awaitingApproval;
  if (gate?.waiting) io.out(`  ${paint(io, '33', `⏸ 等待审批：${gate.nodeIds.join('、')}`)}`);
  for (const n of Object.values(run.nodes ?? {})) {
    io.out(`  ${stateMark(io, n.state)}  ${n.nodeId}${n.error ? `  ${paint(io, '31', n.error.slice(0, 120))}` : ''}`);
  }
  if (run.cost?.totalMs !== undefined) io.out(`  用时 ${humanMs(run.cost.totalMs)}${run.prUrl ? ` · ${run.prUrl}` : ''}`);
  return EXIT_OK;
}

// -- approve --------------------------------------------------------------

async function cmdApprove(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  requirePos(args, 2, 'paneflow approve <runId> <nodeId>');
  const [runId, nodeId] = args.positional as [string, string];
  const { body } = await request<{ delivered: boolean }>(
    io,
    baseUrl,
    'POST',
    `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approve`,
    { action: 'approve' },
  );
  io.out(`${paint(io, '32', '✔ 已批准')} ${runId} / ${nodeId}${body?.delivered ? '（已送达审批位）' : ''}`);
  return EXIT_OK;
}

// -- watch ------------------------------------------------------------------

async function cmdWatch(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  requirePos(args, 1, 'paneflow watch <runId>');
  const runId = args.positional[0]!;
  const timeoutMs = parseDuration(args.flags.timeout ?? DEFAULT_TIMEOUT);
  const intervalMs = args.flags.interval !== undefined ? parseDuration(args.flags.interval) : DEFAULT_INTERVAL_MS;
  io.out(`watch ${runId} @ ${baseUrl}（timeout ${args.flags.timeout ?? DEFAULT_TIMEOUT}，间隔 ${intervalMs}ms）`);
  return watchRun(io, baseUrl, runId, { timeoutMs, intervalMs });
}
