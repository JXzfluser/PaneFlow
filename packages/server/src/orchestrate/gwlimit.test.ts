import { describe, expect, it } from 'vitest';
import { envInt, gatewayHostOf, GwConcurrencyGate, looksLikeGatewayThrottle } from './gwlimit.js';

describe('v11-D1 gatewayHostOf（主机维度键）', () => {
  it('取 URL host（hostname:port），尾斜杠/路径无关', () => {
    expect(gatewayHostOf('http://gw.local:4444/')).toBe('gw.local:4444');
    expect(gatewayHostOf('https://router.free-gw.cn/v1/chat')).toBe('router.free-gw.cn');
    expect(gatewayHostOf('http://GW.Local:4444')).toBe('gw.local:4444');
  });
  it('空/不可解析 → null（免闸）', () => {
    expect(gatewayHostOf(undefined)).toBeNull();
    expect(gatewayHostOf('')).toBeNull();
    expect(gatewayHostOf('not a url')).toBeNull();
  });
});

describe('v11-D1 looksLikeGatewayThrottle（429/503 特征识别）', () => {
  it('真限流形态全命中', () => {
    const hits = [
      '启动失败：herdr: gateway responded HTTP 503 Service Unavailable',
      'agent_prompt_stalled（输出尾部：upstream error: 503 Service Unavailable, retry later）',
      'Request failed with status code 429',
      'HTTP 429 Too Many Requests',
      'API rate limit exceeded for key',
      'error: 429',
      '网关返回：请求过多，请稍后再试',
      '（输出尾部：限流中）',
      'too many requests',
      '503: service unavailable',
    ];
    for (const h of hits) expect(looksLikeGatewayThrottle(h), h).toBe(true);
  });
  it('非限流的失败信息不误伤（裸数字/无关错误）', () => {
    const misses = [
      '',
      '检查未通过：文件不存在 out.json',
      '503 files changed, 429 insertions(+)',
      '澄清循环 3 轮后仍未对齐（aligned=false）',
      '人工审批拒绝',
      'Error: something else 500',
      '等待节点完成超时',
    ];
    for (const m of misses) expect(looksLikeGatewayThrottle(m), m).toBe(false);
  });
});

describe('v11-D1 GwConcurrencyGate（在途并发闸 + 收紧窗）', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('cap=1：后到者等前者 release 才能过闸', async () => {
    const gate = new GwConcurrencyGate({ maxConcurrent: 1, tightenMs: 0, pollMs: 10 });
    expect(await gate.acquire('h')).toBe(true);
    let second = false;
    const p = gate.acquire('h').then((ok) => (second = ok));
    await wait(40);
    expect(second).toBe(false); // 还堵在闸上
    expect(gate.snapshot()['h']!.active).toBe(1);
    gate.release('h');
    await p;
    expect(second).toBe(true);
    expect(gate.snapshot()['h']!.active).toBe(1);
  });

  it('aborted 置真即放弃排队（返回 false 不记账）', async () => {
    const gate = new GwConcurrencyGate({ maxConcurrent: 1, tightenMs: 0, pollMs: 10 });
    await gate.acquire('h');
    let aborted = false;
    const p = gate.acquire('h', () => aborted).then((ok) => ok);
    await wait(30);
    aborted = true;
    expect(await p).toBe(false);
    gate.release('h');
    expect(gate.snapshot()['h']!.active).toBe(0);
  });

  it('penalize：收紧窗内不放新窗，窗满即放', async () => {
    const gate = new GwConcurrencyGate({ maxConcurrent: 4, tightenMs: 80, pollMs: 10 });
    const win = gate.penalize('h');
    expect(win).toBe(80);
    const t0 = Date.now();
    expect(await gate.acquire('h')).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it('连续命中窗口翻倍（封顶 8 倍），窗过期后重新起算——注入时钟保确定性', () => {
    let t = 1000;
    const gate = new GwConcurrencyGate({ maxConcurrent: 2, tightenMs: 100, pollMs: 10, now: () => t });
    expect(gate.penalize('h')).toBe(100); // 第 1 次
    expect(gate.penalize('h')).toBe(200); // 仍在上一窗口内 → 翻倍
    t = 1000 + 3000; // 窗口全部过期后再命中
    expect(gate.penalize('h')).toBe(100);
    t = 1000;
    gate.penalize('h'); gate.penalize('h'); gate.penalize('h'); gate.penalize('h');
    expect(gate.penalize('h')).toBe(800); // 封顶 8 倍
  });

  it('maxConcurrent=0：整闸关闭，acquire 即过且不记账', async () => {
    const gate = new GwConcurrencyGate({ maxConcurrent: 0, tightenMs: 10_000 });
    expect(gate.enabled).toBe(false);
    expect(await gate.acquire('h')).toBe(true);
    expect(await gate.acquire('h')).toBe(true);
    expect(gate.snapshot()['h']).toBeUndefined();
    expect(gate.penalize('h')).toBe(0);
  });
});

describe('v11-D1 envInt（PF_* 缺省语义）', () => {
  it('未设/非数字回落默认；0 与负数如实返回（0=关闸）', () => {
    delete process.env.PF_GW_TEST_X;
    expect(envInt('PF_GW_TEST_X', 2)).toBe(2);
    process.env.PF_GW_TEST_X = '0';
    expect(envInt('PF_GW_TEST_X', 2)).toBe(0);
    process.env.PF_GW_TEST_X = 'abc';
    expect(envInt('PF_GW_TEST_X', 7)).toBe(7);
    delete process.env.PF_GW_TEST_X;
  });
});
