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
