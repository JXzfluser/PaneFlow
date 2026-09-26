import { request } from './client.js';
import { resolveBaseUrl } from './config.js';
import { hhmmss, humanMs, paint, stateMark } from './format.js';
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT,
  parseDuration,
  watchRun,
} from './watch.js';
import {
  EXIT_OK,
  EXIT_RED,
  type CliIo,
  type DispatchResult,
  type EnvProbeView,
  type RegistryEntryView,
  type RegistryListView,
  type RunView,
} from './types.js';

/** 与 release launcher（bin/paneflow.mjs）的路由表同源：这几枚子命令走 CLI，其余起 server */
export const CLI_SUBCOMMANDS = ['dispatch', 'runs', 'status', 'watch', 'approve', 'replay', 'experiments', 'env', 'registry'] as const;

/** v13-W2 注入字节读数为人话（`injected=12.3KB`）；纯格式换算，不是判据 */
function kBytes(n: number): string {
  return `${(n / 1024).toFixed(1)}KB`;
}

/** 带值的长选项；不在列的 --xxx 视为布尔开关（目前只有 --json） */
const VALUE_FLAGS = new Set(['url', 'repo', 'issue', 'timeout', 'interval', 'space', 'times', 'arm', 'suite', 'flag', 'path', 'kind', 'from']);

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
  '  paneflow dispatch "<一句话>" [--repo owner/name] [--issue N] [--space S] [--suite S] [--arm A] [--flag F] [--url U] [--json]',
  '                                                              --suite/--arm/--flag 打实验标（进 experiment 体键，判据全在 server：只给 arm/flag 不给 suite 由 server 400 指路）',
  '  paneflow runs [--json]',
  '  paneflow status <runId> [--json]',
  '  paneflow watch <runId> [--timeout 30m] [--interval 3000]   退出码：0 全绿 / 1 有红 / 2 超时 / 3 停在审批门',
  '  paneflow approve <runId> <nodeId>                          批准（CLI 绝不替你批）',
  '  paneflow replay <runId> [--times N] [--suite S] [--arm A] [--flag F] [--allow-side-effects] [--from-failed]   同契约复跑（穿透同 issue 锁，仅 replay 显式发起）',
  '                                                              源单带副作用默认拒绝；--allow-side-effects 显式穿透，--from-failed 只重跑失败/未执行节点',
  '  paneflow experiments [--suite S] [--json]                  实验收数表（只读 server 落盘）',
  '  paneflow env probe <目录> [--space S] [--json]             v14-E1 环境发现器（**纯只读**）：探 git 仓/约定文档/skills/规则候选/机检候选/CI/worktree，',
  '                                                              每项带依据（发现自哪个相对路径）；只产草案不落盘（登记是 E2），七类判据全在 server',
  '  paneflow registry list [--kind <k>] [--json]               v14-A1/A2 注册中心：一屏看全部能力条目（label/被引用数全由 server 算好）',
  '  paneflow registry get <id> [--json]                        单条详情（含「谁在用」的逐处出处）',
  '  paneflow registry refs <id> [--json]                       「谁在用这一项」纯读反查（缺 refs 键＝引用账没读出来，不等于没人用）',
  '  paneflow registry add --from <草案.json> [--json]          脚本/agent 专用的登记通道（日常登记走网页「注册中心」表单；脏形状由 server 400 一句人话指路）',
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
      case 'replay':
        return await cmdReplay(io, baseUrl, args);
      case 'experiments':
        return await cmdExperiments(io, baseUrl, args);
      case 'env':
        return await cmdEnv(io, baseUrl, args);
      case 'registry':
        return await cmdRegistry(io, baseUrl, args);
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
  const body: {
    task: string;
    issueId?: string;
    experiment?: { suite?: string; arm?: string; flag?: string };
  } = { task };
  if (repo && !issue) throw new Error('--repo 只在配合 --issue 时有意义（issue 归属仓）');
  if (issue && !/^\d+$/.test(issue)) throw new Error(`--issue 需为数字编号，收到：${issue}`);
  if (issue && repo) {
    // server 端 parseIssueRef 只从任务文本认 repo——把规范 issue URL 拼进去即可，
    // 不另发明 body 字段（issueId 留空让文本解析通道生效）
    body.task = `${task}\n\n（关联 Issue：https://github.com/${repo}/issues/${issue}）`;
  } else if (issue) {
    body.issueId = issue;
  }
  // 实验标纯透传（R4：CLI 不判「这算不算实验单」——只给 arm/flag 不给 suite 之类，
  // 由 server 400 指路，错误文案原样带出）；一个都没给=体零新增，今日语义不变
  const experiment: { suite?: string; arm?: string; flag?: string } = {};
  for (const k of ['suite', 'arm', 'flag'] as const) {
    const v = args.flags[k]?.trim();
    if (v) experiment[k] = v;
  }
  if (Object.keys(experiment).length) body.experiment = experiment;
  const q = args.flags.space ? `?space=${encodeURIComponent(args.flags.space)}` : '';
  // 120s 专项超时：带 issue 的派发要在服务端现抓 GitHub 正文，代理链路常 >15s；
  // 默认 15s 会把「已建成单」报成失败（假超时真建单，无人值守脚本据此重试=重复建单，摩擦账 #23）
  const { body: res } = await request<DispatchResult>(io, baseUrl, 'POST', `/api/dispatch${q}`, body, 120_000);
  if (jsonOr(args)) {
    dump(io, res);
    return EXIT_OK;
  }
  io.out(`${paint(io, '32', '✔ 已派活')} run ${paint(io, '1', res.runId)}${res.issueId ? ` · Issue #${res.issueId}${res.issueFetched ? '（正文已拉取）' : '（正文未取到，按描述执行）'}` : ''}`);
  if (res.note) io.out(`  ! ${res.note}`);
  // 打标回执：只渲染 server 回显的 experiment 字段（终态落不收落表由 server 定，这里零判据）
  if (res.experiment?.suite) {
    io.out(
      `  ${paint(io, '33', `实验标: ${res.experiment.suite}${res.experiment.arm ? `/臂 ${res.experiment.arm}` : ''}${res.experiment.flag ? ` · flag=${res.experiment.flag}` : ''}`)}（终态自动落收数表：paneflow experiments --suite ${res.experiment.suite}）`,
    );
  }
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
  // RunView 之外的两枚 v13-W3 新键就地声明（types.ts 不在本片所有权内；形状即 server 落册形状，零判据）
  const { body: run } = await request<
    RunView & {
      declares?: { roleId: string; faces?: Record<string, boolean> }[];
      declareViolations?: { roleId: string; face: string; seen: string }[];
    }
  >(io, baseUrl, 'GET', `/api/runs/${encodeURIComponent(runId)}`);
  if (jsonOr(args)) {
    dump(io, run);
    return EXIT_OK;
  }
  io.out(`run ${paint(io, '1', run.runId)} · ${run.dagName ?? '-'} · ${stateMark(io, run.state)}${run.issueId ? ` · Issue #${run.issueId}` : ''}`);
  // v12-V1 harness 披露行：只渲染 server 返回字段（R4），缺项跳过、整缺不显示。
  // v13-V2 等臂读数追加两枚 bit：读回=<有/无(结局)>（server 扫 graph 实态算好的，
  // false 也是正读数所以照显）+ 骨架#（剥注入块+归一路径后的指纹，两臂相等=只差读回块）。
  const h = run.harness;
  if (h && (h.graphSha || h.agentKind)) {
    const bits = [
      h.graphSha ? `graph#${h.graphSha}` : '',
      h.agentKind ? `kind=${h.agentKind}` : '',
      h.model ? `model=${h.model}` : '',
      h.gwProfile ? `档位=${h.gwProfile}` : '',
      h.readback === undefined
        ? ''
        : `读回=${h.readback ? '有' : '无'}${h.readbackOutcome ? `(${h.readbackOutcome})` : ''}`,
      h.skeletonSha ? `骨架#${h.skeletonSha}` : '',
      h.ctxSha ? `上下文#${h.ctxSha}` : '',
      // v13-W2 岗位两枚 bit：roleSha=「哪一岗挂哪几篇」的内容指纹（换装备=换指纹，
      // 岗位级 A/B 自此复用 V2 等臂机制），injected=实注字节的 KB 读数（G1 降重账）——
      // 都是 server 注入现场算好落册的账，CLI 零判据；旧单缺键整缺不显（不拿 0 冒充）
      h.roleSha ? `roleSha=${h.roleSha}` : '',
      h.injectedBytes === undefined ? '' : `injected=${kBytes(h.injectedBytes)}`,
    ].filter(Boolean);
    io.out(`  harness: ${bits.join(' · ')}`);
  }
  // v12-S1a 副作用行：同样零判据——账是 server 算好落册的，这里只照单渲染
  const se = run.sideEffects;
  if (se) {
    const bits = [
      se.issuesCreated?.length ? `建单${se.issuesCreated.map((n) => `#${n}`).join('、')}` : '',
      se.issuePatched?.length ? `回写${se.issuePatched.map((n) => `#${n}`).join('、')}` : '',
      se.prUrl ? `PR ${se.prUrl}` : '',
      se.pushedAt ? `已推送 ${se.pushedAt}` : '',
    ].filter(Boolean);
    if (bits.length) io.out(`  ${paint(io, '33', `副作用: ${bits.join(' · ')}`)}`);
  }
  // v13-B2 ③对账层的落差行：detail 是 server 收口时算好的一句人话，这里零判据只照读——
  // 整缺=无落差（含「没学家规」），绝不在 CLI 侧比 expected/actual 自造判定（铁律 R4）
  if (run.deliveryViolations?.length) {
    for (const v of run.deliveryViolations) {
      io.out(`  ${paint(io, '33', `⚠ deliveryViolation: ${v.detail}（只标不拦）`)}`);
    }
  }
  // v13-B2 ①机检层的场级账：家规命中且真建过隔离工作目录才有键（整缺≠建了零个）。
  // 「基点」位只在真拉新支时有值——挂既有支/续用残留目录都没有「拉」这一步，server 就不写，
  // 这里照单缺省成「未拉新支」，不拿家规声明的 branchFrom 冒充实测基点。
  const deliveryByNode = new Map((run.deliveryWorktrees ?? []).map((w) => [w.nodeId, w]));
  // v13-W3 授权行 + 授权对账行：declares/declareViolations 都是 server 收口时算好落册的账
  // （岗库 × 实绑 × 副作用账），这里零判据只渲染——没声明/无落差/旧单整缺不显示（不拿空账冒充）
  if (run.declares?.length) {
    const detail = run.declares
      .map((d) => `岗「${d.roleId}」${Object.entries(d.faces ?? {}).map(([f, v]) => `${f}=${v}`).join(' · ')}`)
      .join('；');
    io.out(`  授权: ${detail}（声明非强制，锁在 agent CLI 侧）`);
  }
  if (run.declareViolations?.length) {
    io.out(
      `  ${paint(io, '33', `⚠ 授权对账: ${run.declareViolations
        .map((v) => `岗「${v.roleId}」声明 ${v.face}=false · 实见「${v.seen}」`)
        .join('；')}`)}`,
    );
  }
  // v12-V2 人等分行：验证税入账同样零判据——waitMs/计数都是放门时 server 结算落册的账
  const attn = run.attention;
  if (attn) {
    const waitMin = ((Number.isFinite(attn.waitMs) ? attn.waitMs! : 0) / 60_000).toFixed(1);
    const g = attn.gates;
    io.out(
      `  人等分: 等待 ${waitMin} 分 · 批 ${g?.approve ?? 0}/驳 ${g?.reject ?? 0}/补料 ${g?.input ?? 0}`,
    );
  }
  const gate = run.awaitingApproval;
  if (gate?.waiting) io.out(`  ${paint(io, '33', `⏸ 等待审批：${gate.nodeIds.join('、')}`)}`);
  for (const n of Object.values(run.nodes ?? {})) {
    io.out(`  ${stateMark(io, n.state)}  ${n.nodeId}${n.error ? `  ${paint(io, '31', n.error.slice(0, 120))}` : ''}`);
    // v13-S2 掐断账：这一轮尝试被引擎中途掐断过（超时/重试/停止/停机/agent 已没），
    // 只呈 server 字段不自造判据——夜跑后看清「哪一轮、为什么、掐时它正干什么」
    const ab = (n.abandonments ?? []).at(-1);
    if (ab) io.out(`    ⚡ 第 ${ab.attempt} 轮尝试已掐断（${ab.trigger} · 掐时状态 ${ab.agentStatus}）`);
    // v13-W1 装备行：这一岗实发吃进 prompt 的文档数（计数与 scope 都是 server 注入现场
    // 落册的账，这里零判据）；scope=space 且绑了角色=「未配装备正吃空间全量」，按红黄警示显出来
    const eq = n.equip;
    if (eq) {
      const bits = `技能 ${eq.skills?.length ?? 0} · 岗位文档 ${eq.rules?.length ?? 0}`;
      io.out(
        eq.scope === 'space' && eq.role
          ? `    ${paint(io, '33', `⚠ 装备: ${bits} —— 该角色未配装备，正吃空间全量`)}`
          : `    装备: ${bits}${eq.role ? ` · 岗 ${eq.role}` : ''}`,
      );
      if (eq.unknownSkills?.length) {
        io.out(
          `    ${paint(io, '33', `⚠ 装备引用不在登记清单，已跳过：${eq.unknownSkills.join('、')}`)}`,
        );
      }
    }
    const dw = deliveryByNode.get(n.nodeId);
    if (dw) {
      const pull =
        dw.pullMode === 'new-branch'
          ? `基点 ${dw.baseRef ?? '未记'}${dw.baseSource === 'contract' ? '（契约优先）' : ''}`
          : dw.pullMode === 'attach-existing-branch'
            ? '挂既有分支·未拉新支'
            : '续用残留目录·未建支未拉基点';
      io.out(
        `    交付: 分支 ${dw.expectedBranch} · ${pull} · PR→${dw.prTarget} · ` +
          `家规第 ${dw.ruleIndex + 1} 条（${dw.matchedBy === 'repo' ? '精确仓' : '通配副'}）`,
      );
    }
    // v13-K1 产物行：命名产物清单（sha/bytes 是 server 读原文实算的机检口径，不是 agent 自报值）。
    // shelved=false 是正读数（被 run 级字节上限拒了），照实标出来——下游引用这份之前得知道它在不在架上
    if (n.products?.length) {
      const bits = n.products.map((p) => {
        const tag = `${p.name}(${p.sha}·${kBytes(p.bytes)})`;
        return p.shelved ? tag : `${tag}⚠未上架${p.shelfError ? `：${p.shelfError}` : ''}`;
      });
      const line = `产物: ${bits.join(' · ')}`;
      io.out(`    ${n.products.some((p) => !p.shelved) ? paint(io, '33', line) : line}`);
    }
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

// -- replay / experiments（v11-E1，薄壳：判据全在 server，这里只透传与打印） ----

async function cmdReplay(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  requirePos(args, 1, 'paneflow replay <runId>');
  const runId = args.positional[0]!;
  const times = args.flags.times !== undefined ? Number(args.flags.times) : 1;
  if (!Number.isInteger(times) || times < 1 || times > 20) {
    throw new Error(`--times 需为 1~20 的整数，收到：${args.flags.times}`);
  }
  const body: { times: number; suite?: string; arm?: string; flag?: string; allowSideEffects?: boolean; fromFailed?: boolean } = { times };
  for (const k of ['suite', 'arm', 'flag'] as const) {
    const v = args.flags[k]?.trim();
    if (v) body[k] = v;
  }
  // v12-S1b/S3 两旗标：纯透传布尔键（判据全在 server——副作用门禁、resume 合流都在这）
  if (args.bools.has('allow-side-effects')) body.allowSideEffects = true;
  if (args.bools.has('from-failed')) body.fromFailed = true;
  const { body: res } = await request<{ runs: { runId: string; state: string }[]; error?: string }>(
    io,
    baseUrl,
    'POST',
    `/api/runs/${encodeURIComponent(runId)}/replay`,
    body,
  );
  if (jsonOr(args)) {
    dump(io, res);
    return res.error ? EXIT_RED : EXIT_OK;
  }
  for (const r of res.runs) {
    io.out(`${paint(io, '32', '✔ 复跑已起')} ${paint(io, '1', r.runId)}（源自 ${runId} · ${r.state}）`);
  }
  if (res.error) io.err(`${paint(io, '31', '✘')} ${res.error}`);
  if (res.runs.length) {
    io.out(`  跟进：paneflow watch ${res.runs[0]!.runId}；收数：paneflow experiments${body.suite ? ` --suite ${body.suite}` : ''}`);
  }
  return res.error ? EXIT_RED : EXIT_OK;
}

async function cmdExperiments(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  const q = args.flags.suite ? `?suite=${encodeURIComponent(args.flags.suite)}` : '';
  const { body } = await request<{
    tables: { suite: string; date: string; file: string; rows: string[] }[];
  }>(io, baseUrl, 'GET', `/api/experiments${q}`);
  if (jsonOr(args)) {
    dump(io, body);
    return EXIT_OK;
  }
  if (!body.tables.length) {
    io.out('（暂无实验收数——dispatch/replay 带 --suite 起单才会落表）');
    return EXIT_OK;
  }
  for (const t of body.tables) {
    // v13-V3 行数如实口径：server 零加工直呈、rows 含表头行（CLI 读列名用），
    // 计数只算数据行——旧口径把表头算进「N 行」是现成的谎报。行照样全打。
    const dataRows = t.rows.filter((r) => !/^\|\s*runId\s*\|/.test(r));
    io.out(`${t.file}（${dataRows.length} 行，不含表头）`);
    for (const row of t.rows) io.out(`  ${row}`);
  }
  return EXIT_OK;
}

// -- env（v14-E1 环境发现器：薄壳透传，七类判据全在 server 的 ./env-probe.ts） ----

async function cmdEnv(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  const verb = args.positional[0];
  if (verb !== 'probe') {
    throw new Error(`paneflow env 目前只有 probe（E1 纯只读发现器）：paneflow env probe <目录>`);
  }
  // 目录可给位置参数（`env probe <目录>`，与可感面一致）或 --path；两条通道都只是参数编排，不是判据
  const dir = args.positional[1] ?? args.flags.path;
  if (!dir) throw new Error('参数不足：paneflow env probe <目录>');
  const q = args.flags.space ? `?space=${encodeURIComponent(args.flags.space)}` : '';
  // --space 原样透传（E1 判据与空间无关，server 不消费它；E2 登记目标空间才用它）
  const { body: res } = await request<EnvProbeView>(io, baseUrl, 'POST', `/api/env/probe${q}`, { path: dir }, 60_000);
  if (jsonOr(args)) {
    dump(io, res);
    return EXIT_OK;
  }
  // 探测失败是**读数**不是客户端错误：server 回 200 带 error，这里照说、不另判（R4）
  if (res.error) io.out(`${paint(io, '33', '✘')} ${res.error}`);
  if (res.root) io.out(`  git 仓根：${res.root}`);
  if (res.summary) {
    io.out(`  ${paint(io, '32', '发现')}：${res.summary}${res.agentsAvailable?.length ? ` · 本机可用 agent：${res.agentsAvailable.join(', ')}` : ''}`);
  }
  // 草案逐条列（items 是 E2 勾选的输入，人读也得看到依据；detail/evidence 全是 server 字段）
  for (const i of res.items ?? []) io.out(`    ${i.kind} · ${i.name} —— ${i.detail}（依据：${i.evidence}）`);
  for (const m of res.missing ?? []) io.out(`    ${paint(io, '90', `缺项：${m}`)}`);
  io.out(`  草案直取：paneflow env probe ${res.path} --json（逐项带依据、stdout 干净可直接 | jq；登记进空间是 E2 的事，本片只探不落盘）`);
  return EXIT_OK;
}

// -- registry（v14-A1/A2 注册中心）--------------------------------------------
// 薄壳到不能再薄：条目说什么（`label`）、谁在用（`refs`）、这版认识哪些类型（`knownKinds`）、
// 盘面有几条不认（`rejected`）全是 server 字段。这里唯一的工作是**排版**与「缺键就不渲染那一句」。

/** 来源chip：`source` 是三枚定值，未知值原样画（server 日后加一枚不许把薄壳炸红） */
const SOURCE_CN: Record<string, string> = { builtin: '出厂', user: '登记', discovered: '探得' };

/**
 * 一条引用出处一行。`face` 原样画（`gateway`/`space`/…）——中文对照表住在 server 的 400 文案里，
 * 这里再抄一份就是第二份事实源，改天两边措辞分叉没人发现。
 */
const refLine = (r: { face: string; id: string; name: string; via: string }): string =>
  `${r.face} · ${r.name}（${r.id}）· ${r.via}`;

/** 条目一行：id + server 的人话标签 + 来源 + 启用态 + 「被 N 处用」（refs 缺键＝不知道，不渲染那一句） */
function entryLine(io: CliIo, e: RegistryEntryView): string {
  const bits = [`  ${e.id}`, e.label ?? e.name, SOURCE_CN[e.source] ?? e.source];
  if (!e.enabled) bits.push(paint(io, '33', '已禁用'));
  if (e.refs) bits.push(e.refs.length ? `被 ${e.refs.length} 处用` : '没人用');
  else bits.push(paint(io, '90', '引用账未读出'));
  return bits.join('  ');
}

function renderEntry(io: CliIo, e: RegistryEntryView): void {
  io.out(entryLine(io, e));
  io.out(`  登记于 ${e.createdAt}${e.updatedAt && e.updatedAt !== e.createdAt ? ` · 改于 ${e.updatedAt}` : ''}`);
  if (!e.refs) {
    io.out(`  ${paint(io, '33', '「谁在用」没读出来——这是不知道，不是没人用（引用账扫不出时 server 就不给 refs 键）')}`);
    return;
  }
  if (!e.refs.length) {
    io.out('  谁在用：一处也没有（正读数）');
    return;
  }
  io.out(`  谁在用（${e.refs.length} 处）：`);
  for (const r of e.refs) io.out(`    ${refLine(r)}`);
}

async function cmdRegistry(io: CliIo, baseUrl: string, args: Args): Promise<number> {
  const verb = args.positional[0];
  switch (verb) {
    case 'list': {
      const q = args.flags.kind ? `?kind=${encodeURIComponent(args.flags.kind)}` : '';
      const { body } = await request<RegistryListView>(io, baseUrl, 'GET', `/api/registry${q}`);
      if (jsonOr(args)) {
        dump(io, body);
        return EXIT_OK;
      }
      io.out(
        `注册表 schema v${body.schema?.version ?? '?'}${body.schema?.writtenBy ? `（由 ${body.schema.writtenBy} 写）` : '（本机版本戳还没落盘=一条没登记过）'} · 这版认识：${body.knownKinds.join('/')}`,
      );
      if (!body.entries.length) {
        io.out('  （一张表都还没登记——日常登记走网页「注册中心」表单，脚本走 `paneflow registry add --from <草案.json>`）');
      }
      // 分组只按 `kind` 字段排（值域由 server 说），组名原样：CLI 不维护第二份「类型→人话」表
      for (const kind of [...new Set(body.entries.map((e) => e.kind))]) {
        io.out(`· ${kind}（${body.entries.filter((e) => e.kind === kind).length} 项）`);
        for (const e of body.entries.filter((x) => x.kind === kind)) io.out(entryLine(io, e));
      }
      for (const r of body.rejected) io.out(`  ${paint(io, '33', `⚠ 本机不认（只披露不清除）：${r.id} —— ${r.why}`)}`);
      const s = body.refSummary;
      if (s) {
        io.out(
          `引用账：扫过 ${s.scanned} 处跨面裸串引用 · 指向已迁类型却查不到条目 ${s.dangling.length} 处 · 指向未迁类型 ${s.unmigrated.reduce((n, u) => n + u.refs, 0)} 处（未迁的不判死活）`,
        );
        for (const d of s.dangling) io.out(`    ${paint(io, '33', `悬挂：${d.kind} → ${d.target}`)}`);
      }
      return EXIT_OK;
    }
    case 'get':
    case 'refs': {
      requirePos(args, 2, `paneflow registry ${verb} <id>`);
      const id = args.positional[1]!;
      const { body } = await request<{ entry: RegistryEntryView }>(io, baseUrl, 'GET', `/api/registry/${encodeURIComponent(id)}`);
      if (jsonOr(args)) {
        // `refs` 只回引用那一格——机器判据要的是「有没有人在用」，不是整条信封
        dump(io, verb === 'refs' ? { id: body.entry.id, refs: body.entry.refs ?? null } : body.entry);
        return EXIT_OK;
      }
      if (verb === 'refs') {
        if (!body.entry.refs) {
          io.out('引用账没读出来（不知道 ≠ 没人用）——server 扫不到就不给 refs 键，这里不替你猜');
          return EXIT_OK;
        }
        if (!body.entry.refs.length) io.out('一处也没有在用（正读数：这条现在删得掉）');
        for (const r of body.entry.refs) io.out(`  ${refLine(r)}`);
        return EXIT_OK;
      }
      renderEntry(io, body.entry);
      return EXIT_OK;
    }
    case 'add': {
      const from = args.flags.from;
      if (!from) throw new Error('参数不足：paneflow registry add --from <草案.json>（表单登记走网页「注册中心」，这条是脚本/agent 通道）');
      const text = io.readFile(from);
      if (text === null) throw new Error(`草案读不出：${from}`);
      let draft: unknown;
      try {
        draft = JSON.parse(text);
      } catch (err) {
        throw new Error(`草案不是合法 JSON（${from}）：${(err as Error).message}`);
      }
      // 体形状/值域/撞 id 全是 server 的 400 一句话（ApiError 原文抛出），这里不预校验——预校验就是第二份判据
      const { body } = await request<{ entry: RegistryEntryView }>(io, baseUrl, 'POST', '/api/registry', draft);
      if (jsonOr(args)) {
        dump(io, body.entry);
        return EXIT_OK;
      }
      io.out(`已登记：${body.entry.id}`);
      renderEntry(io, body.entry);
      return EXIT_OK;
    }
    default:
      throw new Error('paneflow registry 目前只有 list / get / refs / add 四枚（改和删走网页「注册中心」，写端守卫的中文解释由 server 给出）');
  }
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
