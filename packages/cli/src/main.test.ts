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
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-h'], legacy.io)).toBe(0);
    expect(legacy.lines.join('\n')).not.toContain('harness');
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

  it('experiments：人读按表列文件+行；空表给指路文案；--suite 进 query；--json 原样', async () => {
    const rows = ['| runId | arm | flag | state | 断言 pass/total | 重试 | 墙钟秒 | replayOf |', '| a1 | on | - | completed | 2/2 | 0 | 90 | - |'];
    const payload = { tables: [{ suite: 'c4', date: '2026-09-21', file: 'experiments/c4/2026-09-21.md', rows }] };
    const { fetchImpl, calls } = stubFetch([{ body: payload }, { body: { tables: [] } }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['experiments', '--suite', 'c4', '--url', 'http://x:1'], io)).toBe(0);
    expect(calls[0]!.url).toBe('http://x:1/api/experiments?suite=c4');
    const out = lines.join('\n');
    expect(out).toContain('experiments/c4/2026-09-21.md（2 行）');
    expect(out).toContain('| a1 | on | - | completed |');
    const empty = makeIo({ fetch: fetchImpl });
    expect(await main(['experiments'], empty.io)).toBe(0);
    expect(calls[1]!.url).toBe('http://127.0.0.1:4310/api/experiments');
    expect(empty.lines.join('\n')).toContain('暂无实验收数');
    const json = makeIo({ fetch: stubFetch([{ body: payload }]).fetchImpl });
    expect(await main(['experiments', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.lines.join('\n'))).toEqual(payload);
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
