import { describe, expect, it } from 'vitest';
import { fakeClock, makeIo, stubFetch } from './fixtures.js';
import { awaitingApprovalOf, decideRun, parseDuration, watchRun } from './watch.js';
import type { RunView } from './types.js';

const run = (partial: Partial<RunView>): RunView => ({ runId: 'r-1', state: 'running', ...partial });

describe('parseDuration', () => {
  it('简写与纯数字', () => {
    expect(parseDuration('60s')).toBe(60_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
    expect(parseDuration('1500ms')).toBe(1500);
    expect(parseDuration('45')).toBe(45_000); // 纯数字按秒
    expect(parseDuration('0')).toBe(0); // 0 = 不限
    expect(parseDuration(' 1.5m ')).toBe(90_000);
  });
  it('非法格式抛错', () => {
    expect(() => parseDuration('30x')).toThrow(/时长格式非法/);
    expect(() => parseDuration('-5')).toThrow(/时长格式非法/);
    expect(() => parseDuration('m')).toThrow(/时长格式非法/);
  });
});

describe('decideRun 终局判定（退出码四态）', () => {
  it('completed → green(0)', () => {
    expect(decideRun(run({ state: 'completed' }))).toMatchObject({ kind: 'green' });
  });
  it('failed / cancelled → red(1)，带失败节点明细', () => {
    const d = decideRun(
      run({
        state: 'failed',
        nodes: {
          impl: { nodeId: 'impl', state: 'failed', error: 'exit 1' },
          plan: { nodeId: 'plan', state: 'done' },
        },
      }),
    );
    expect(d.kind).toBe('red');
    expect(d.badNodes?.map((n) => n.nodeId)).toEqual(['impl']);
    expect(decideRun(run({ state: 'cancelled' })).kind).toBe('red');
  });
  it('completed-with-failures → red：D3 前瞻，按字面量判红（即便 server 还没实现该态）', () => {
    const d = decideRun(
      run({
        state: 'completed-with-failures',
        nodes: { impl: { nodeId: 'impl', state: 'failed' } },
      }),
    );
    expect(d.kind).toBe('red');
    expect(d.badNodes?.map((n) => n.nodeId)).toEqual(['impl']);
  });
  it('审批门聚合字段 waiting → gate(3)', () => {
    const d = decideRun(
      run({ awaitingApproval: { waiting: true, nodeIds: ['planner', 'contract'] } }),
    );
    expect(d).toMatchObject({ kind: 'gate', nodeIds: ['planner', 'contract'] });
  });
  it('老 server 无聚合字段：按节点 state 等价推导兜底', () => {
    const stalled = run({
      nodes: {
        plan: { nodeId: 'plan', state: 'done' },
        contract: { nodeId: 'contract', state: 'blocked' },
      },
    });
    expect(awaitingApprovalOf(stalled)).toEqual({ waiting: true, nodeIds: ['contract'] });
    // 还有在跑的节点 = 没停门（并行分支推进中），继续等
    const moving = run({
      nodes: {
        a: { nodeId: 'a', state: 'blocked' },
        b: { nodeId: 'b', state: 'working' },
      },
    });
    expect(awaitingApprovalOf(moving).waiting).toBe(false);
    expect(decideRun(moving).kind).toBe('pending');
    // paused（F2 重启后的待批）也算门信号——approve 会 409 指路续跑，判 3 交人
    expect(
      awaitingApprovalOf(run({ nodes: { a: { nodeId: 'a', state: 'paused' } } })).nodeIds,
    ).toEqual(['a']);
  });
  it('running / queued 无门 → pending', () => {
    expect(decideRun(run({})).kind).toBe('pending');
    expect(decideRun(run({ state: 'queued' })).kind).toBe('pending');
  });
});

describe('watchRun 轮询与退出码', () => {
  const base = 'http://127.0.0.1:4310';

  it('0：先 pending 后 completed', async () => {
    const { io, lines } = makeIo({
      ...fakeClock(),
      fetch: stubFetch([
        { body: run({}) },
        { body: run({ state: 'completed' }) },
      ]).fetchImpl,
    });
    const code = await watchRun(io, base, 'r-1', { timeoutMs: 60_000, intervalMs: 1000 });
    expect(code).toBe(0);
    expect(lines.at(-1)).toContain('全绿');
  });

  it('1：failed 红，stdout 列失败节点', async () => {
    const { io, lines } = makeIo({
      ...fakeClock(),
      fetch: stubFetch([
        {
          body: run({
            state: 'completed-with-failures',
            nodes: { impl: { nodeId: 'impl', state: 'failed', error: '测试没跑过' } },
          }),
        },
      ]).fetchImpl,
    });
    const code = await watchRun(io, base, 'r-1', { timeoutMs: 60_000, intervalMs: 1000 });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('impl');
    expect(lines.join('\n')).toContain('测试没跑过');
  });

  it('3：停在审批门，stdout 给待批 nodeId 且绝不自动 approve', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: run({
          nodes: { contract: { nodeId: 'contract', state: 'blocked' } },
          awaitingApproval: { waiting: true, nodeIds: ['contract'] },
        }),
      },
    ]);
    const { io, lines } = makeIo({ ...fakeClock(), fetch: fetchImpl });
    const code = await watchRun(io, base, 'r-1', { timeoutMs: 60_000, intervalMs: 1000 });
    expect(code).toBe(3);
    const out = lines.join('\n');
    expect(out).toContain('contract');
    expect(out).toContain('不替你过门');
    // 全程只有 GET，没有任何 POST（CLI 绝不替人批）
    expect(calls.every((c) => c.init.method === undefined || c.init.method === 'GET')).toBe(true);
  });

  it('2：超时退出，带最后状态；请求失败不致命（继续轮询直到 deadline）', async () => {
    const { io, errLines } = makeIo({
      ...fakeClock(),
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const code = await watchRun(io, base, 'r-1', { timeoutMs: 2500, intervalMs: 1000 });
    expect(code).toBe(2);
    expect(errLines.join('\n')).toContain('ECONNREFUSED');
  });

  it('拿到 404 视为错误即退（runId 打错不空转到超时）', async () => {
    const { io } = makeIo({
      ...fakeClock(),
      fetch: stubFetch([{ status: 404, body: { error: 'not found' } }]).fetchImpl,
    });
    await expect(watchRun(io, base, 'nope', { timeoutMs: 60_000, intervalMs: 1000 })).rejects.toThrow(
      /not found/,
    );
  });
});
