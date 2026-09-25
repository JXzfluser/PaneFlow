import { describe, expect, it } from 'vitest';
import { main, parseArgs } from './main.js';
import { fakeClock, makeIo, stubFetch } from './fixtures.js';

const dispatchPayload = {
  runId: 'run-77',
  issueId: '12',
  issueFetched: true,
  contract: { mode: 'extracted', assertions: 3 },
  nodes: [
    { id: 'start', name: '开始', type: 'start', dependsOn: [] },
    { id: 'planner', name: 'Planner · 下发规划', type: 'agent', dependsOn: ['start'] },
    { id: 'route', name: '路由执行', type: 'pipeline', dependsOn: ['planner'] },
    { id: 'end', name: '结束', type: 'end', dependsOn: ['route'] },
  ],
};

describe('parseArgs', () => {
  it('值选项/布尔/--k=v/位置参数混排', () => {
    const a = parseArgs(['加个导出', '--repo', 'o/r', '--issue=12', '--json', '--timeout', '30m']);
    expect(a.positional).toEqual(['加个导出']);
    expect(a.flags).toEqual({ repo: 'o/r', issue: '12', timeout: '30m' });
    expect(a.bools.has('json')).toBe(true);
  });
});

describe('dispatch', () => {
  it('--issue + --repo：拼规范 issue URL 进任务文本（server 端 parseIssueRef 认 repo），不带 body.issueId', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: dispatchPayload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    const code = await main(['dispatch', '给导出加兜底', '--repo', 'o/r', '--issue', '12', '--url', 'http://x:1'], io);
    expect(code).toBe(0);
    expect(calls[0]!.url).toBe('http://x:1/api/dispatch');
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.issueId).toBeUndefined();
    expect(body.task).toContain('给导出加兜底');
    expect(body.task).toContain('https://github.com/o/r/issues/12');
  });

  it('只 --issue：走 body.issueId 通道（默认仓/候选仓由 server 决定）', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: dispatchPayload }]);
    const { io } = makeIo({ fetch: fetchImpl });
    await main(['dispatch', '看单办事', '--issue', '12', '--space', 'demo'], io);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4310/api/dispatch?space=demo');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ task: '看单办事', issueId: '12' });
  });

  it('人读模式打印 runId + 节点清单摘要（id/name/deps）+ 契约方式', async () => {
    const { fetchImpl } = stubFetch([{ body: dispatchPayload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    await main(['dispatch', '活'], io);
    const out = lines.join('\n');
    expect(out).toContain('run-77');
    expect(out).toContain('Issue #12（正文已拉取）');
    expect(out).toContain('机检 3 条');
    expect(out).toContain('节点 planner · Planner · 下发规划 ← start');
    expect(out).toContain('节点 end · 结束 ← route');
  });

  it('--json：stdout 干净可 JSON.parse（原样回 API 负载）', async () => {
    const { fetchImpl } = stubFetch([{ body: dispatchPayload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    await main(['dispatch', '活', '--json'], io);
    expect(JSON.parse(lines.join('\n'))).toEqual(dispatchPayload);
  });

  it('--repo 缺 --issue / server 报 400：退 1 并把 server 的 error 原样说', async () => {
    const { io, errLines } = makeIo();
    expect(await main(['dispatch', '活', '--repo', 'o/r'], io)).toBe(1);
    expect(errLines.join('\n')).toContain('--repo');
    const { fetchImpl } = stubFetch([{ status: 400, body: { error: '缺少工作目录（项目未配置 rootCwd 且未指定）' } }]);
    const bad = makeIo({ fetch: fetchImpl });
    expect(await main(['dispatch', '活'], bad.io)).toBe(1);
    expect(bad.errLines.join('\n')).toContain('缺少工作目录');
  });

  it('实验标透传：--suite/--arm/--flag 进 body.experiment；回执渲染 server 回显字段；不带=体零新增', async () => {
    const payload = { runId: 'run-88', issueFetched: false, experiment: { suite: 'c4', arm: 'a', flag: 'readback=off' } };
    const { fetchImpl, calls } = stubFetch([{ body: payload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['dispatch', '活', '--suite', 'c4', '--arm', 'a', '--flag', 'readback=off'], io)).toBe(0);
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      task: '活',
      experiment: { suite: 'c4', arm: 'a', flag: 'readback=off' },
    });
    expect(lines.join('\n')).toContain('实验标: c4/臂 a · flag=readback=off');
    expect(lines.join('\n')).toContain('paneflow experiments --suite c4');
    // 不带实验标：body 零新增键（今日语义，对照上面精确断言）
    const plain = stubFetch([{ body: { runId: 'run-89' } }]);
    const p = makeIo({ fetch: plain.fetchImpl });
    expect(await main(['dispatch', '活'], p.io)).toBe(0);
    expect(JSON.parse(plain.calls[0]!.init.body!)).toEqual({ task: '活' });
    expect(p.lines.join('\n')).not.toContain('实验标');
  });

  it('只给 --arm 不给 --suite：CLI 不判、原样透传，server 400 指路照单带出退 1（R4 零判据）', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 400, body: { error: 'experiment 必须带非空 suite 才算实验标（只给 arm/flag 不进收数表；suite 给了就得是非空字符串）' } },
    ]);
    const { io, errLines } = makeIo({ fetch: fetchImpl });
    expect(await main(['dispatch', '活', '--arm', 'b'], io)).toBe(1);
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ task: '活', experiment: { arm: 'b' } });
    expect(errLines.join('\n')).toContain('必须带非空 suite');
  });
});

describe('runs / status / approve', () => {
  it('runs 人读列表每行带状态与 runId；--json 原样负载', async () => {
    const payload = { runs: [{ runId: 'a', state: 'running', dagName: 'demo', startedAt: new Date(0).toISOString() }] };
    const { fetchImpl } = stubFetch([{ body: payload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl, now: () => 1 });
    expect(await main(['runs', '--url', 'http://x:1'], io)).toBe(0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('running');
    expect(lines[0]).toContain('a');
    const json = makeIo({ fetch: fetchImpl });
    expect(await main(['runs', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.lines.join('\n'))).toEqual(payload);
  });

  it('status 列节点 state 与审批门；--json 原样', async () => {
    const runPayload = {
      runId: 'r-9',
      state: 'running',
      dagName: 'dispatch-x',
      nodes: {
        plan: { nodeId: 'plan', state: 'done' },
        contract: { nodeId: 'contract', state: 'blocked', blockedPrompt: '确认契约？' },
      },
      awaitingApproval: { waiting: true, nodeIds: ['contract'] },
    };
    const { fetchImpl, calls } = stubFetch([{ body: runPayload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-9'], io)).toBe(0);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4310/api/runs/r-9');
    const out = lines.join('\n');
    expect(out).toContain('等待审批：contract');
    expect(out).toContain('plan');
    const json = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-9', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.lines.join('\n'))).toEqual(runPayload);
  });

  it('v12-V1 status harness 行：只渲染 server 返回字段——全量一行、缺项跳过、旧 run 无 harness 不显示', async () => {
    const base = { runId: 'r-h', state: 'completed', dagName: 'g', nodes: {} };
    const { fetchImpl } = stubFetch([
      { body: { ...base, harness: { graphSha: 'a1b2c3d4', agentKind: 'pi', model: 'free-m', gwProfile: 'gwb' } } },
      { body: { ...base, harness: { graphSha: 'a1b2c3d4', agentKind: 'pi' } } },
      { body: base },
    ]);
    const full = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h'], full.io)).toBe(0);
    expect(full.lines.join('\n')).toContain('harness: graph#a1b2c3d4 · kind=pi · model=free-m · 档位=gwb');
    const partial = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h'], partial.io)).toBe(0);
    expect(partial.lines.join('\n')).toContain('harness: graph#a1b2c3d4 · kind=pi');
    expect(partial.lines.join('\n')).not.toContain('读回'); // v13-V2 前的旧读数：缺项跳过，不补假值
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h'], legacy.io)).toBe(0);
    expect(legacy.lines.join('\n')).not.toContain('harness');
  });

  it('v13-V2 status 等臂读数：读回=有/无(结局)·骨架#照单渲染；读回=无（false）是正读数照显；只有实态没结局不猜', async () => {
    const base = { runId: 'r-h2', state: 'completed', dagName: 'g', nodes: {} };
    const { fetchImpl } = stubFetch([
      {
        body: {
          ...base,
          harness: { graphSha: 'g1', agentKind: 'pi', readback: true, readbackOutcome: 'injected', skeletonSha: 'sk111111' },
        },
      },
      {
        body: {
          ...base,
          harness: { graphSha: 'g2', agentKind: 'pi', readback: false, readbackOutcome: 'switch-off', skeletonSha: 'sk111111' },
        },
      },
      { body: { ...base, harness: { graphSha: 'g3', agentKind: 'pi', readback: true } } },
    ]);
    const on = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h2'], on.io)).toBe(0);
    expect(on.lines.join('\n')).toContain('harness: graph#g1 · kind=pi · 读回=有(injected) · 骨架#sk111111');
    const off = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h2'], off.io)).toBe(0);
    expect(off.lines.join('\n')).toContain('harness: graph#g2 · kind=pi · 读回=无(switch-off) · 骨架#sk111111');
    const odd = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h2'], odd.io)).toBe(0);
    expect(odd.lines.join('\n')).toContain('harness: graph#g3 · kind=pi · 读回=有');
    expect(odd.lines.join('\n')).not.toContain('骨架#');
  });

  it('v13-V4 status 上下文#：server 给了就照渲染，旧单缺键整缺不显（CLI 零判据不猜）', async () => {
    const base = { runId: 'r-h4', state: 'completed', dagName: 'g', nodes: {} };
    const { fetchImpl } = stubFetch([
      {
        body: {
          ...base,
          harness: { graphSha: 'g4', agentKind: 'pi', readback: false, readbackOutcome: 'no-pages', skeletonSha: 'sk4', ctxSha: 'cx4' },
        },
      },
      { body: { ...base, harness: { graphSha: 'g5', agentKind: 'pi', skeletonSha: 'sk5' } } },
    ]);
    const withCtx = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h4'], withCtx.io)).toBe(0);
    expect(withCtx.lines.join('\n')).toContain('harness: graph#g4 · kind=pi · 读回=无(no-pages) · 骨架#sk4 · 上下文#cx4');
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h4'], legacy.io)).toBe(0);
    expect(legacy.lines.join('\n')).not.toContain('上下文#');
  });

  it('v13-W2 status 岗位两枚 bit：roleSha 照渲染 + injected 走 KB（一位小数），旧单缺键整缺不显；0 是正读数照显', async () => {
    const base = { runId: 'r-w2', state: 'completed', dagName: 'g', nodes: {} };
    const { fetchImpl } = stubFetch([
      {
        body: {
          ...base,
          harness: {
            graphSha: 'g1', agentKind: 'pi', readback: false, readbackOutcome: 'no-pages',
            ctxSha: 'cx1', roleSha: 'rl2a', injectedBytes: 12595,
          },
        },
      },
      { body: { ...base, harness: { graphSha: 'g2', agentKind: 'pi', ctxSha: 'cx2' } } },
      { body: { ...base, harness: { graphSha: 'g3', agentKind: 'pi', roleSha: 'rl3', injectedBytes: 0 } } },
    ]);
    const armed = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-w2'], armed.io)).toBe(0);
    expect(armed.lines.join('\n')).toContain(
      'harness: graph#g1 · kind=pi · 读回=无(no-pages) · 上下文#cx1 · roleSha=rl2a · injected=12.3KB',
    );
    // v13-W2 前的旧单：两键都没给就整缺不显（CLI 不拿 0 冒充「读了零」）
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-w2'], legacy.io)).toBe(0);
    expect(legacy.lines.join('\n')).not.toContain('roleSha');
    expect(legacy.lines.join('\n')).not.toContain('injected=');
    // 0 是 server 的正读数（整单一个字都没注），照显 0.0KB
    const zero = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-w2'], zero.io)).toBe(0);
    expect(zero.lines.join('\n')).toContain('roleSha=rl3 · injected=0.0KB');
  });

  it('v12-S1a status 副作用行：只渲染 server 落册账——全量一行、缺项跳过、无账/空账整缺不显示', async () => {
    const base = { runId: 'r-se', state: 'completed', dagName: 'g', nodes: {} };
    const { fetchImpl } = stubFetch([
      {
        body: {
          ...base,
          sideEffects: {
            issuesCreated: [12, 31],
            issuePatched: [7],
            prUrl: 'https://github.com/o/r/pull/3',
            pushedAt: '2026-09-22T02:03:04.000Z',
          },
        },
      },
      { body: { ...base, sideEffects: { prUrl: 'https://github.com/o/r/pull/3' } } },
      { body: { ...base, sideEffects: {} } },
      { body: base },
    ]);
    const full = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-se'], full.io)).toBe(0);
    expect(full.lines.join('\n')).toContain(
      '副作用: 建单#12、#31 · 回写#7 · PR https://github.com/o/r/pull/3 · 已推送 2026-09-22T02:03:04.000Z',
    );
    const partial = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-se'], partial.io)).toBe(0);
    const pOut = partial.lines.join('\n');
    expect(pOut).toContain('副作用: PR https://github.com/o/r/pull/3');
    expect(pOut).not.toContain('建单');
    const empty = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-se'], empty.io)).toBe(0);
    expect(empty.lines.join('\n')).not.toContain('副作用');
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-se'], legacy.io)).toBe(0);
    expect(legacy.lines.join('\n')).not.toContain('副作用');
  });

  it('v13-W3 status 授权行+对账行：只渲染 server 收口落册账——有声明一行、有落差一行、整缺不显示', async () => {
    const base = { runId: 'r-decl', state: 'completed', dagName: 'g', nodes: {} };
    const { fetchImpl } = stubFetch([
      {
        body: {
          ...base,
          declares: [{ roleId: 'r-deliver', faces: { gitPush: false, prOpen: true } }],
          declareViolations: [
            { roleId: 'r-deliver', face: 'gitPush', seen: '已推送 2026-09-22T02:03:04.000Z' },
          ],
        },
      },
      // 只声明无落差：对账行整缺
      { body: { ...base, declares: [{ roleId: 'r-clean', faces: { gitPush: false } }] } },
      // 老单/没声明：两键都缺 → 两行都不显（不拿空账冒充「声明了零面」）
      { body: base },
    ]);
    const both = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-decl'], both.io)).toBe(0);
    const out = both.lines.join('\n');
    expect(out).toContain('授权: 岗「r-deliver」gitPush=false · prOpen=true（声明非强制，锁在 agent CLI 侧）');
    expect(out).toContain('⚠ 授权对账: 岗「r-deliver」声明 gitPush=false · 实见「已推送 2026-09-22T02:03:04.000Z」');
    const quiet = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-decl'], quiet.io)).toBe(0);
    const qOut = quiet.lines.join('\n');
    expect(qOut).toContain('授权: 岗「r-clean」gitPush=false');
    expect(qOut).not.toContain('授权对账');
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-decl'], legacy.io)).toBe(0);
    const lOut = legacy.lines.join('\n');
    expect(lOut).not.toContain('授权');
    expect(lOut).not.toContain('declareViolation');
  });

  it('v12-V2 status 人等分行：server 落册账照单渲染——全量一行、怪账补零、无 attention 整缺不显示', async () => {
    const base = { runId: 'r-at', state: 'completed', dagName: 'g', nodes: {} };
    const { fetchImpl } = stubFetch([
      { body: { ...base, attention: { waitMs: 252_000, gates: { approve: 2, reject: 0, input: 1 } } } },
      { body: { ...base, attention: { waitMs: 60_000 } } }, // 怪 server：gates 缺键按 0 补，不崩
      { body: base },
    ]);
    const full = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-at'], full.io)).toBe(0);
    expect(full.lines.join('\n')).toContain('人等分: 等待 4.2 分 · 批 2/驳 0/补料 1');
    const partial = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-at'], partial.io)).toBe(0);
    expect(partial.lines.join('\n')).toContain('人等分: 等待 1.0 分 · 批 0/驳 0/补料 0');
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-at'], legacy.io)).toBe(0);
    expect(legacy.lines.join('\n')).not.toContain('人等分');
  });

  it('v13-S2 status 掐断账行：节点带 abandonments 就报最新一笔（轮次/触发/掐时状态），无账不显示', async () => {
    const ab = [
      { at: '2026-09-24T10:00:00.000Z', attempt: 1, trigger: 'settle-timeout', agentStatus: 'working', agentName: 'a-impl-1' },
      { at: '2026-09-24T10:20:00.000Z', attempt: 2, trigger: 'agent-gone', agentStatus: 'unknown', agentName: 'a-impl-2' },
    ];
    const { fetchImpl } = stubFetch([
      {
        body: {
          runId: 'r-ab',
          state: 'failed',
          dagName: 'g',
          nodes: { impl: { nodeId: 'impl', state: 'failed', abandonments: ab } },
        },
      },
      { body: { runId: 'r-ab', state: 'completed', dagName: 'g', nodes: { impl: { nodeId: 'impl', state: 'done' } } } },
    ]);
    const withLedger = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-ab'], withLedger.io)).toBe(0);
    const out = withLedger.lines.join('\n');
    // 只呈最新一笔（第 2 轮 agent-gone），且是 server 字段原样、CLI 不自造判据
    expect(out).toContain('第 2 轮尝试已掐断（agent-gone · 掐时状态 unknown）');
    expect(out).not.toContain('第 1 轮');
    const noLedger = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-ab'], noLedger.io)).toBe(0);
    expect(noLedger.lines.join('\n')).not.toContain('已掐断');
  });

  it('approve POST 审批端点、体是 {action:"approve"}；409 时把 server 指路原样带出', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { delivered: true } }]);
    const { io } = makeIo({ fetch: fetchImpl });
    expect(await main(['approve', 'r-9', 'contract'], io)).toBe(0);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4310/api/runs/r-9/nodes/contract/approve');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ action: 'approve' });
    const denied = stubFetch([{ status: 409, body: { error: '该节点当前未在等待审批' } }]);
    const bad = makeIo({ fetch: denied.fetchImpl });
    expect(await main(['approve', 'r-9', 'contract'], bad.io)).toBe(1);
    expect(bad.errLines.join('\n')).toContain('未在等待审批');
  });

  it('watch 命令接线：解析 --timeout 后把 watchRun 的退出码原样透传', async () => {
    const { fetchImpl } = stubFetch([{ body: { runId: 'r-1', state: 'completed' } }]);
    const { io } = makeIo({ fetch: fetchImpl, ...fakeClock() });
    expect(await main(['watch', 'r-1', '--timeout', '5s'], io)).toBe(0);
    // 默认 30m：pending 一次后 3s 间隔远小于 deadline → 需要时钟推进；只测非法 timeout 直接退 1
    const bad = makeIo({ fetch: fetchImpl });
    expect(await main(['watch', 'r-1', '--timeout', 'abc'], bad.io)).toBe(1);
  });
});

describe('replay / experiments（v11-E1）', () => {
  it('replay：--times/--suite/--arm/--flag 原样进 body，人读列每份复跑单', async () => {
    const payload = { runs: [{ runId: 'a1', state: 'running' }, { runId: 'a2', state: 'running' }] };
    const { fetchImpl, calls } = stubFetch([{ body: payload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['replay', 'src-9', '--times', '2', '--suite', 'c4', '--arm', 'a', '--url', 'http://x:1'], io)).toBe(0);
    expect(calls[0]!.url).toBe('http://x:1/api/runs/src-9/replay');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ times: 2, suite: 'c4', arm: 'a' });
    const out = lines.join('\n');
    expect(out).toContain('✔ 复跑已起 a1（源自 src-9 · running）');
    expect(out).toContain('paneflow watch a1');
    expect(out).toContain('paneflow experiments --suite c4');
  });

  it('replay：--times 越界/非数在 CLI 侧就拒（不发请求）；缺省只发 times:1；半路 error 退 1', async () => {
    const { io, errLines } = makeIo();
    expect(await main(['replay', 'src-9', '--times', '21'], io)).toBe(1);
    expect(await main(['replay', 'src-9', '--times', 'abc'], io)).toBe(1);
    expect(errLines.join('\n')).toContain('1~20');
    const { fetchImpl, calls } = stubFetch([
      { body: { runs: [{ runId: 'a1', state: 'running' }], error: '第 2/3 份起单失败：锁' } },
    ]);
    const partial = makeIo({ fetch: fetchImpl });
    expect(await main(['replay', 'src-9', '--times', '3'], partial.io)).toBe(1);
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ times: 3 });
    expect(partial.errLines.join('\n')).toContain('第 2/3 份起单失败');
  });

  it('v12-S1b/S3 --allow-side-effects / --from-failed 布尔旗标进 body（按下才加键，旧命令体零新增）', async () => {
    const payload = { runs: [{ runId: 'a1', state: 'running' }] };
    const { fetchImpl, calls } = stubFetch([{ body: payload }, { body: payload }]);
    const { io } = makeIo({ fetch: fetchImpl });
    expect(await main(['replay', 'src-9', '--from-failed', '--allow-side-effects', '--suite', 'c4'], io)).toBe(0);
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ times: 1, suite: 'c4', allowSideEffects: true, fromFailed: true });
    // server 拒绝态（400）：薄壳不判断，把两行指路文案原样带出、退 1
    const denied = stubFetch([{ status: 400, body: { error: '源 run x 有副作用（建单#12）——直接重放会二次副作用\n显式穿透加 --allow-side-effects；只重跑失败/未执行节点加 --from-failed' } }]);
    const bad = makeIo({ fetch: denied.fetchImpl });
    expect(await main(['replay', 'src-9', '--times', '2'], bad.io)).toBe(1);
    expect(bad.errLines.join('\n')).toContain('--allow-side-effects');
    // 不带旗标：body 零新增键（对照既有测试的 {times} 精确断言已覆盖）
    const { io: io2 } = makeIo({ fetch: fetchImpl });
    expect(await main(['replay', 'src-9'], io2)).toBe(0);
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ times: 1 });
  });

  it('experiments：行数只算数据行（v13-V3 去表头谎报）；表头/行照打；空表给指路文案；--suite 进 query；--json 原样', async () => {
    const rows = [
      '| runId | arm | flag | state | 断言 pass/total | 重试 | 墙钟秒 | token in | token out | replayOf | harness | 人等分 |',
      '| a1 | on | - | completed | 2/2 | 0 | 90 | 12000 | 3400 | - | a1b2c3d4·pi | 4.2 |',
    ];
    const payload = { tables: [{ suite: 'c4', date: '2026-09-21', file: 'experiments/c4/2026-09-21.md', rows }] };
    const { fetchImpl, calls } = stubFetch([{ body: payload }, { body: { tables: [] } }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['experiments', '--suite', 'c4', '--url', 'http://x:1'], io)).toBe(0);
    expect(calls[0]!.url).toBe('http://x:1/api/experiments?suite=c4');
    const out = lines.join('\n');
    expect(out).toContain('experiments/c4/2026-09-21.md（1 行，不含表头）'); // 表头不再被算进账
    expect(out).toContain('| runId | arm |'); // 表头行照样打出来（读列名用）
    expect(out).toContain('| a1 | on | - | completed |'); // 新 token 列原样渲染（行直呈）
    const empty = makeIo({ fetch: fetchImpl });
    expect(await main(['experiments'], empty.io)).toBe(0);
    expect(calls[1]!.url).toBe('http://127.0.0.1:4310/api/experiments');
    expect(empty.lines.join('\n')).toContain('暂无实验收数');
    const json = makeIo({ fetch: stubFetch([{ body: payload }]).fetchImpl });
    expect(await main(['experiments', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.lines.join('\n'))).toEqual(payload); // --json 原样直呈，不受行数口径影响
  });
});

describe('入口守护', () => {
  it('未知子命令与 help', async () => {
    const { io, errLines } = makeIo();
    expect(await main(['rm', '-rf'], io)).toBe(1);
    expect(errLines.join('\n')).toContain('未知子命令');
    const h = makeIo();
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.lines.join('\n')).toContain('paneflow watch');
  });
});
