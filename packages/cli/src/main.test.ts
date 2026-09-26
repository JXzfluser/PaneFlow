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

  it('v13-B2 status 交付行+落差行：家规账逐节点照单渲染（没拉新支就不编基点），落差行只照 server 的 detail；没账整缺不显', async () => {
    const base = {
      runId: 'r-dlv',
      state: 'completed',
      dagName: 'g',
      nodes: { b: { nodeId: 'b', state: 'done' }, c: { nodeId: 'c', state: 'done' } },
    };
    const { fetchImpl } = stubFetch([
      {
        body: {
          ...base,
          deliveryWorktrees: [
            {
              nodeId: 'b',
              ruleIndex: 0,
              matchedBy: 'repo',
              pullMode: 'new-branch',
              baseRef: 'main',
              baseSource: 'rule',
              expectedBranch: 'fix/issue-123',
              prTarget: 'main',
              actualBranch: 'fix/issue-123',
            },
            // 挂既有支=没有「拉」这一步：账上没 baseRef，渲染就不许出现基点字样
            {
              nodeId: 'c',
              ruleIndex: 2,
              matchedBy: 'space',
              pullMode: 'attach-existing-branch',
              expectedBranch: 'wt/wild-1',
              prTarget: 'release/v1.4',
            },
          ],
          deliveryViolations: [
            {
              kind: 'branch-name',
              detail: '节点「c」的隔离工作目录实分支名「side/track」（游离 HEAD，detached） ≠ 家规第 3 条渲染的「wt/wild-1」',
            },
          ],
        },
      },
      // 契约优先：baseSource=contract 要说清基点来自本单契约，不是空间家规
      {
        body: {
          ...base,
          deliveryWorktrees: [
            {
              nodeId: 'b',
              ruleIndex: 0,
              matchedBy: 'repo',
              pullMode: 'new-branch',
              baseRef: 'rel-9',
              baseSource: 'contract',
              expectedBranch: 'fix/issue-123',
              prTarget: 'main',
            },
          ],
        },
      },
      // 没配家规/没建 worktree 的单：两键整缺 → 两行都不显（缺≠「按家规建了零个」）
      { body: base },
    ]);
    const full = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-dlv'], full.io)).toBe(0);
    const out = full.lines.join('\n');
    expect(out).toContain('交付: 分支 fix/issue-123 · 基点 main · PR→main · 家规第 1 条（精确仓）');
    expect(out).toContain('交付: 分支 wt/wild-1 · 挂既有分支·未拉新支 · PR→release/v1.4 · 家规第 3 条（通配副）');
    expect(out).toContain('⚠ deliveryViolation: 节点「c」的隔离工作目录实分支名「side/track」');
    expect(out).toContain('（只标不拦）');
    const contract = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-dlv'], contract.io)).toBe(0);
    expect(contract.lines.join('\n')).toContain('交付: 分支 fix/issue-123 · 基点 rel-9（契约优先） · PR→main');
    // 老单/没学家规：两键整缺 → 两行都不显（缺≠「按家规建了零个」）
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-dlv'], legacy.io)).toBe(0);
    const lOut = legacy.lines.join('\n');
    expect(lOut).not.toContain('交付:');
    expect(lOut).not.toContain('deliveryViolation');
  });

  it('v13-K1 status 产物行：命名产物清单照单渲染（sha·KB 都是 server 实算），未上架的件照实标注；没产物整缺不显', async () => {
    const base = {
      runId: 'r-k1',
      state: 'completed',
      dagName: 'g',
      nodes: {
        b: {
          nodeId: 'b',
          state: 'done',
          products: [
            { name: 'plan.md', kind: 'doc', sha: 'a1b2c3', bytes: 4300, shelved: true },
            {
              name: 'test-report.md',
              kind: 'doc',
              sha: 'd4e5f6',
              bytes: 9000,
              shelved: false,
              shelfError: 'over-run-cap（已用 32 MiB / 上限 32 MiB）',
            },
          ],
        },
      },
    };
    // 没声明/不是 git 仓的单：products 整缺 → 产物行不显（缺≠「产了零件」）
    const { fetchImpl } = stubFetch([{ body: base }, { body: { ...base, nodes: { b: { nodeId: 'b', state: 'done' } } } }]);
    const full = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-k1'], full.io)).toBe(0);
    expect(full.lines.join('\n')).toContain(
      '产物: plan.md(a1b2c3·4.2KB) · test-report.md(d4e5f6·8.8KB)⚠未上架：over-run-cap（已用 32 MiB / 上限 32 MiB）',
    );
    const legacy = makeIo({ fetch: fetchImpl });
    expect(await main(['status', 'r-k1'], legacy.io)).toBe(0);
    expect(legacy.lines.join('\n')).not.toContain('产物:');
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

describe('env probe（v14-E1 环境发现器：零判据，只画 server 给的草案）', () => {
  const payload = {
    path: '/Users/x/code/my-repo',
    root: '/Users/x/code/my-repo',
    summary: 'git 仓 origin=my-org/my-repo · 约定文档 2 · 技能 3 篇 · 机检候选 pnpm test、pnpm typecheck',
    items: [
      { kind: 'repo', name: 'my-org/my-repo', detail: 'origin=git@github.com:my-org/my-repo.git → my-org/my-repo', evidence: '.git/config' },
      { kind: 'doc', name: 'AGENTS.md', detail: '1234 字节（只报存在与大小，未读内容）', evidence: 'AGENTS.md' },
      { kind: 'skill', name: 'export.md', detail: '96 字节（只报存在与大小，未读内容）', evidence: 'skills/export.md' },
      { kind: 'check', name: '多套 lockfile 并存', detail: '探到 pnpm-lock.yaml、yarn.lock——按 pnpm>yarn>npm 取 pnpm（只披露不拦）', evidence: 'pnpm-lock.yaml · yarn.lock' },
      { kind: 'worktree', name: 'wt-one', detail: '额外 worktree：/tmp/wt-one', evidence: '.git/worktrees/' },
    ],
    missing: ['没有 CI workflow（未探到 .github/workflows/*.yml 或 *.yaml）'],
    agentsAvailable: ['pi', 'opencode'],
  };

  it('人读一行「发现：」照读 server 的 summary + root + agents，缺项逐条列出', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: payload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['env', 'probe', '/Users/x/code/my-repo', '--url', 'http://x:1'], io)).toBe(0);
    expect(calls[0]!.url).toBe('http://x:1/api/env/probe');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ path: '/Users/x/code/my-repo' });
    const out = lines.join('\n');
    expect(out).toContain('发现：git 仓 origin=my-org/my-repo · 约定文档 2 · 技能 3 篇 · 机检候选 pnpm test、pnpm typecheck');
    expect(out).toContain('本机可用 agent：pi, opencode');
    expect(out).toContain('git 仓根：/Users/x/code/my-repo');
    expect(out).toContain('缺项：没有 CI workflow');
    expect(out).toContain('草案直取：paneflow env probe /Users/x/code/my-repo --json');
  });

  it('--space 进 query（E1 判据与空间无关，server 不消费）；--path 与位置参数同义', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: payload }, { body: payload }]);
    const { io } = makeIo({ fetch: fetchImpl });
    expect(await main(['env', 'probe', '/tmp/a', '--space', 'demo'], io)).toBe(0);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4310/api/env/probe?space=demo');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ path: '/tmp/a' });
    expect(await main(['env', 'probe', '--path', '/tmp/b'], io)).toBe(0);
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ path: '/tmp/b' });
  });

  it('--json：stdout 干净可 JSON.parse（原样回 API 负载，一条人读都不掺）', async () => {
    const { fetchImpl } = stubFetch([{ body: payload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['env', 'probe', '/tmp/a', '--json'], io)).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual(payload);
  });

  it('现场读不到：server 给的是 200 读数（items 全空 + error），CLI 照说不炸、不自己判目录存不存在', async () => {
    const { fetchImpl } = stubFetch([
      { body: { path: '/tmp/nope', items: [], missing: [], error: '这个目录读不到：目录不存在（/tmp/nope）', agentsAvailable: [] } },
    ]);
    const { io, lines, errLines } = makeIo({ fetch: fetchImpl });
    expect(await main(['env', 'probe', '/tmp/nope'], io)).toBe(0);
    expect(lines.join('\n')).toContain('这个目录读不到：目录不存在（/tmp/nope）');
    expect(errLines.join('\n')).toBe('');
  });

  it('草案逐条列且带依据（items 是 E2 勾选的输入，人读也要看得见每项从哪来）', async () => {
    const { fetchImpl } = stubFetch([{ body: payload }]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['env', 'probe', '/Users/x/code/my-repo'], io)).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('repo · my-org/my-repo —— origin=git@github.com:my-org/my-repo.git → my-org/my-repo（依据：.git/config）');
    expect(out).toContain('check · 多套 lockfile 并存 —— 探到 pnpm-lock.yaml、yarn.lock——按 pnpm>yarn>npm 取 pnpm（只披露不拦）（依据：pnpm-lock.yaml · yarn.lock）');
    expect(out).toContain('worktree · wt-one —— 额外 worktree：/tmp/wt-one（依据：.git/worktrees/）');
  });

  it('缺键不渲染：无 root/无 agents/无缺项时零新增行（宁缺毋假，不拿空串占位）', async () => {
    const { fetchImpl } = stubFetch([
      { body: { path: '/tmp/plain', items: [], missing: [], summary: '未发现任何可登记项（原因见缺项）' } },
    ]);
    const { io, lines } = makeIo({ fetch: fetchImpl });
    expect(await main(['env', 'probe', '/tmp/plain'], io)).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('发现：未发现任何可登记项');
    expect(out).not.toContain('git 仓根');
    expect(out).not.toContain('本机可用 agent');
    expect(out).not.toContain('缺项：');
    // 一条草案都没有时不硬凑草案行（items=[] 是正读数）
    expect(out.split('\n').filter((l) => l.trim().startsWith('repo ·'))).toHaveLength(0);
  });

  it('脏输入与 server 指路：缺路径退 1 不发请求；400 的 error 原样带出退 1；未知动词退 1', async () => {
    const { io, errLines } = makeIo();
    expect(await main(['env'], io)).toBe(1);
    expect(await main(['env', 'probe'], io)).toBe(1);
    expect(await main(['env', 'drop', '/tmp/a'], io)).toBe(1);
    expect(errLines.join('\n')).toContain('paneflow env probe');
    const { fetchImpl } = stubFetch([{ status: 400, body: { error: 'path 必须是绝对路径（相对路径不猜基准）：a/b' } }]);
    const bad = makeIo({ fetch: fetchImpl });
    expect(await main(['env', 'probe', 'a/b'], bad.io)).toBe(1);
    expect(bad.errLines.join('\n')).toContain('必须是绝对路径');
    // 三处必动之一（v14 §X2）：USAGE 里点不到就等于命令不存在
    const h = makeIo();
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.lines.join('\n')).toContain('paneflow env probe');
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
