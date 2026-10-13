import { describe, expect, it } from 'vitest';
import {
  batchDispatchNotes,
  gateReleaseNote,
  queuePromoteNote,
  readFailureNote,
  writeFailureNote,
} from './write-outcome.js';

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

  it('起单那两枚换自己的落点说法：它不是在「改」什么，说「改没改成」是句听不懂的话', () => {
    const err = { status: 503, message: 'POST /api/dispatch → 503', payload: {} };
    expect(writeFailureNote('这单没发出去', err, '这单起没起不确定，刷新看单列的读数')).toBe(
      '这单没发出去：server 回 503 且没给原因（这单起没起不确定，刷新看单列的读数）',
    );
    expect(writeFailureNote('这批没发出去', err, '这批起没起不确定，刷新看单列的读数')).toBe(
      '这批没发出去：server 回 503 且没给原因（这批起没起不确定，刷新看单列的读数）',
    );
  });

  it('换了说法也不换口径：只说落点读不到，绝不替 server 断言起没起', () => {
    const err = { status: 500, message: 'POST /api/dispatch/batch → 500', payload: {} };
    const note = writeFailureNote('这批没发出去', err, '这批起没起不确定，刷新看单列的读数');
    expect(note).not.toMatch(/一定没|肯定没|一单没起|已经起了|没落盘/);
    // 尾巴只在 5xx 那一路出现：4xx 与「server 给了原因」那两路本来就有确定说法，不叠第二句
    expect(writeFailureNote('这批没发出去', { status: 400, payload: {} }, '这批起没起不确定')).toBe(
      '这批没发出去：server 回 400 且没给原因',
    );
    expect(writeFailureNote('这批没发出去', { status: 400, payload: { error: '一次最多 20 个 issue' } }, '这批起没起不确定')).toBe(
      '这批没发出去：一次最多 20 个 issue',
    );
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

describe('gateReleaseNote（放门成了也要在动作点上说一句，四面共用这一枚）', () => {
  it('三种按键各说各的话，但都只到「server 收了这一发」', () => {
    expect(gateReleaseNote('approve')).toBe('已放行——server 收了这一发（等这一步的账推上来）');
    expect(gateReleaseNote('reject')).toBe('已驳回——server 收了这一发（等这一步的账推上来）');
    expect(gateReleaseNote('input')).toBe('指令已送到——server 收了这一发（等这一步的账推上来）');
  });

  it('不替后面的状态背书：句子里不承诺这一格最后跑成什么', () => {
    // 200 只等于「等门的引擎被叫醒了」；节点收口成什么是账本推上来之后的事
    for (const a of ['approve', 'reject', 'input'] as const) {
      expect(gateReleaseNote(a)).not.toMatch(/已完|已通过|成功结束/);
    }
  });
});

describe('queuePromoteNote（插队成了也说一句，但不替排队读数背书）', () => {
  it('只到「server 收了这一发」，位次怎么翻由下一次排队读数说', () => {
    expect(queuePromoteNote()).toBe('插队这一发 server 收了（位次等下一次排队读数）');
  });

  it('不声称已经站到队首：那是排队读数的事，不是这一发的回执', () => {
    expect(queuePromoteNote()).not.toMatch(/已是队首|已到队首|已插到队首/);
  });
});

describe('batchDispatchNotes（200 但带残缺：成了几单与哪几单没起，一维一行）', () => {
  it('整批都起了：只有绿色那句，且不替后面的状态背书', () => {
    expect(
      batchDispatchNotes({ dispatched: 5, queued: 2, failed: [] }),
    ).toEqual({ ok: '这批起了 5 单（其中 2 单排队，位次在看板）', fail: null });
    expect(batchDispatchNotes({ dispatched: 5, queued: 0, failed: [] }).ok).toBe('这批起了 5 单');
    // 「起了」到 server 建单为止：跑成什么是账本推上来之后的事
    for (const ok of ['这批起了 5 单', '这批起了 5 单（其中 2 单排队，位次在看板）']) {
      expect(ok).not.toMatch(/跑成|完成|成功结束/);
    }
  });

  it('半批漏了：两句同时在，绿的只说成了的、红的逐单照抄 server 原话', () => {
    const r = {
      dispatched: 3,
      queued: 0,
      failed: [
        { issue: 163, error: 'Issue 读取失败：gh: Not Found' },
        { issue: 165, error: '并发闸忙不过来' },
      ],
    };
    expect(batchDispatchNotes(r)).toEqual({
      ok: '这批起了 3 单',
      fail: '这 2 单没起：#163 Issue 读取失败：gh: Not Found；#165 并发闸忙不过来',
    });
  });

  it('一单都没起：不发绿色那句——「起了 0 单」借的是成功的形状', () => {
    expect(batchDispatchNotes({ dispatched: 0, queued: 0, failed: [{ issue: 7, error: '没读到这一单' }] })).toEqual({
      ok: null,
      fail: '这 1 单没起：#7 没读到这一单',
    });
  });

  it('server 只给了码没写原因：明说它没写，不留个空尾巴让人猜', () => {
    expect(batchDispatchNotes({ dispatched: 1, queued: 0, failed: [{ issue: 9, error: '  ' }] }).fail).toBe(
      '这 1 单没起：#9 server 没写原因',
    );
  });
});
