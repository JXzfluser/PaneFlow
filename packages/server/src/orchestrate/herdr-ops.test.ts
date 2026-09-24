import { describe, expect, it } from 'vitest';
import { HerdrConnectionError, type HerdrClient } from '../herdr/client.js';
import { HerdrRequestError } from '../herdr/client.js';
import { isAgentNotFoundError, RealHerdrOps } from './herdr-ops.js';

/**
 * v13-S2 「agent 已没」判据的生产路实证：engine 只对 probeAgent 的三态读数负责，
 * 而三态怎么从 herdr 的真实应答里长出来，全押在这层映射上——所以这层必须自己测，
 * 不能让「engine 测试里 monkeypatch 一个 gone」冒充生产可达（那是假绿的一种）。
 */
function opsWith(agentGet: () => Promise<unknown>): RealHerdrOps {
  const client = { agentGet } as unknown as HerdrClient;
  return new RealHerdrOps(client);
}

describe('RealHerdrOps.probeAgent 三态映射（v13-S2 判据源头）', () => {
  it('答得上来就原样给状态', async () => {
    await expect(opsWith(async () => ({ agent: { agent_status: 'working' } })).probeAgent('a1')).resolves.toBe('working');
  });

  it('not_found 类错误码 → gone（agent 不存在与 pane 不存在都算「这个 target 没了」）', async () => {
    for (const code of ['not_found', 'agent_not_found', 'pane_not_found']) {
      const ops = opsWith(async () => {
        throw new HerdrRequestError(code, 'nope');
      });
      await expect(ops.probeAgent('a1')).resolves.toBe('gone');
    }
  });

  it('超时 / 传输错 / 其它错误码 → null（没答上话不是证据，宁缺毋假）', async () => {
    const cases: unknown[] = [
      new HerdrRequestError('timeout', 'agent.get timed out after 30000ms'),
      new HerdrRequestError('invalid_request', 'bad target'),
      new HerdrConnectionError('connect failed: socket hang up'),
      new Error('破烂'),
    ];
    for (const err of cases) {
      const ops = opsWith(async () => {
        throw err;
      });
      await expect(ops.probeAgent('a1')).resolves.toBeNull();
    }
  });

  it('应答里没有状态字段 → null（判据不齐不判死）', async () => {
    await expect(opsWith(async () => ({})).probeAgent('a1')).resolves.toBeNull();
    await expect(opsWith(async () => ({ agent: {} })).probeAgent('a1')).resolves.toBeNull();
  });

  it('isAgentNotFoundError 只认结构化错误码，不认 message 里的人话', () => {
    expect(isAgentNotFoundError(new HerdrRequestError('not_found', 'no such agent'))).toBe(true);
    // 错误消息里恰好含 not_found 字样，但 code 不是——不判
    expect(isAgentNotFoundError(new HerdrRequestError('timeout', 'upstream said not_found'))).toBe(false);
    expect(isAgentNotFoundError(new Error('herdr not_found: 伪装成人话'))).toBe(false);
    expect(isAgentNotFoundError(undefined)).toBe(false);
  });

  it('getAgentStatus 语义不变：任何错误仍压成 null（放行 not_found 只开在 probeAgent 一条路上）', async () => {
    const ops = opsWith(async () => {
      throw new HerdrRequestError('not_found', 'nope');
    });
    await expect(ops.getAgentStatus('a1')).resolves.toBeNull();
  });
});
