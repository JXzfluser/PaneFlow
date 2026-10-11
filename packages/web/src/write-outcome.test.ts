import { describe, expect, it } from 'vitest';
import { readFailureNote, writeFailureNote } from './write-outcome.js';

describe('writeFailureNote（写操作失败要说在人眼下，不再只落底部控制台）', () => {
  it('server 给了人话：原话照渲，浏览器不另编一句判词', () => {
    const err = {
      status: 403,
      message: '跨站请求被拒绝（同源之外需配置 PF_CORS_ORIGINS）',
      payload: { error: '跨站请求被拒绝（同源之外需配置 PF_CORS_ORIGINS）' },
    };
    expect(writeFailureNote('班底没改动', err)).toBe(
      '班底没改动：跨站请求被拒绝（同源之外需配置 PF_CORS_ORIGINS）',
    );
  });

  it('server 只回了码没说原因：明说没给原因，不拿「→ 500」这种形状糊过去', () => {
    expect(
      writeFailureNote('这一下没落档', { status: 400, message: 'PUT /api/spaces/default → 400', payload: {} }),
    ).toBe('这一下没落档：server 回 400 且没给原因');
  });

  it('5xx 且无原因：落点不可考就不替它保证盘上没动，给人一句可自查的下一步', () => {
    expect(
      writeFailureNote('班底没改动', { status: 500, message: 'PUT /api/spaces/default → 500', payload: {} }),
    ).toBe('班底没改动：server 回 500 且没给原因（改没改成不确定，刷新看盘上的读数）');
  });

  it('连不上（无 status）：说的是连不上，不拿 Failed to fetch 冒充原因', () => {
    expect(writeFailureNote('首发没装上', new TypeError('Failed to fetch'))).toBe(
      '首发没装上：连不上本机服务（server 没在跑？）',
    );
  });
});

describe('readFailureNote（读失败 ≠ 没有内容：两种画法得分开）', () => {
  it('server 给人话时与写侧同一句法', () => {
    expect(readFailureNote('通道列表没读出来', { status: 404, payload: { error: '找不到这枚条目' } })).toBe(
      '通道列表没读出来：找不到这枚条目',
    );
  });

  it('只回码没说原因：明说是没读成，不让空列表冒充「还没有通道」', () => {
    expect(readFailureNote('沉淀页没读出来', { status: 502, message: 'GET /api/wiki/state → 502', payload: {} })).toBe(
      '沉淀页没读出来：server 回 502 且没给原因（这是没读成，不是「没有内容」）',
    );
  });
});
