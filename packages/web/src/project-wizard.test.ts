import { describe, expect, it } from 'vitest';
import {
  createSpaceFailNote,
  idCollisionNote,
  probeBodyFailNote,
  probeFailNote,
  registerFailNote,
  registerZeroNote,
  spacesReadNote,
  teamSeedFailNote,
  teamSeedOkNote,
} from './project-wizard.js';

/**
 * v19 步骤二十三：新建项目向导那两下的措辞。
 * 这一片从前只有底部控制台一句（`收尾登记失败：…`）+ 失败就把窗关掉，而且把「建档案」与「只读扫描」
 * 两发请求合成一句——档案其实已经落笔时，合句把「建成了」说成「没走通」。
 */
describe('createSpaceFailNote（第一发：建档案）', () => {
  it('server 给了人话：原话照渲，不裹上「创建/扫描」这种把两发合起来的说法', () => {
    const err = { status: 400, payload: { error: '项目 ID 只能包含字母/数字/-/_（≤32 字符）' } };
    expect(createSpaceFailNote(err)).toBe('项目档案没建成：项目 ID 只能包含字母/数字/-/_（≤32 字符）');
    expect(createSpaceFailNote(err)).not.toMatch(/扫描/);
  });

  it('连不上与只回码两种读法各说各的，落点那句只说读不到、不替 server 断言盘上没动', () => {
    expect(createSpaceFailNote({ message: 'fetch failed' })).toBe(
      '项目档案没建成：连不上本机服务（server 没在跑？）',
    );
    expect(createSpaceFailNote({ status: 500, payload: {} })).toBe(
      '项目档案没建成：server 回 500 且没给原因（档案建没建成不确定，到「项目」页刷新看清单里有没有多出一枚）',
    );
  });

  it('从前那句「已被占用」永远不会出现：server 对在册 id 是覆写名字，不是报错', () => {
    for (const err of [{ status: 400, payload: { error: '缺少项目名称' } }, { status: 503, payload: {} }]) {
      expect(createSpaceFailNote(err)).not.toMatch(/已存在|已被占用/);
    }
  });
});

describe('probeFailNote / probeBodyFailNote（第二发：只读扫描，缺 ≠ 零）', () => {
  it('扫描那一发失败走**读**尺子：裸码句带「这是没读成」，且不扯档案建没建', () => {
    expect(probeFailNote({ status: 502, payload: {} })).toBe(
      '这个目录没扫成：server 回 502 且没给原因（这是没读成，不是「没有内容」）',
    );
    expect(probeFailNote({ status: 400, payload: { error: '路径要写成绝对路径' } })).toBe(
      '这个目录没扫成：路径要写成绝对路径',
    );
    expect(probeFailNote({ status: 502, payload: {} })).not.toMatch(/档案|项目没建/);
  });

  it('server 回 200 但体里带 error：server 原话打头 + 一句诚实尾巴，不画成「这里没东西」', () => {
    expect(probeBodyFailNote('目录读不动：EACCES 权限不够')).toBe(
      '目录读不动：EACCES 权限不够——这是没读成，不是「这里没东西」',
    );
    // server 的原话里已有点明动词的那半句，这里不重复前缀（两处各说一遍同一件事就是绕口）
    expect(probeBodyFailNote('这个目录读不到：目录不存在（/tmp/nope）')).toBe(
      '这个目录读不到：目录不存在（/tmp/nope）——这是没读成，不是「这里没东西」',
    );
    for (const note of [probeBodyFailNote('甲'), probeFailNote({ status: 502, payload: {} })]) {
      expect(note).not.toMatch(/没探出|没有可登记|未发现/);
    }
  });
});

describe('registerFailNote / teamSeedFailNote（收尾那两发各说各的）', () => {
  it('登记那发的落点是项目档案，不是「盘上文件」——措辞跟着读数的位置走', () => {
    expect(registerFailNote({ status: 400, payload: { error: '目录读不动' } })).toBe(
      '这几项没登记进去：目录读不动',
    );
    expect(registerFailNote({ status: 500, payload: {} })).toContain(
      '（这几项进没进档案不确定，刷新看项目档案的读数）',
    );
  });

  it('200 却报 0 项：这一发没把勾选项接进档案，占住红色那一格而不是不发绿句就完事', () => {
    expect(registerZeroNote(4)).toContain('这几项没登记进去');
    expect(registerZeroNote(4)).toContain('你要登记的是 4 项');
    expect(registerZeroNote(4)).not.toMatch(/已登记|登记好了|接进来了$/);
  });

  it('班底那发失败只说班底：登记已经成了的事不归它否认（组件把两句分开摆）', () => {
    const note = teamSeedFailNote({ status: 500, payload: { error: '名册写不动' } });
    expect(note).toBe('首发班底没装填：名册写不动');
    expect(note).not.toMatch(/登记|这几项/);
    expect(teamSeedFailNote({ status: 503, payload: {} })).toContain(
      '（班底装没装不确定，刷新看项目档案的班底读数）',
    );
  });

  it('班底成了的那句只到 server 交回的档案，不替「能跑任务」背书', () => {
    expect(teamSeedOkNote(5)).toBe('首发班底已装填 5 位（server 交回的档案里带的数）');
    // 回执没带班底那一格：不画成 0 位
    expect(teamSeedOkNote(null)).toBe('首发班底这一发 server 收了（回执没带班底位序，以项目档案的读数为准）');
    expect(teamSeedOkNote(5)).not.toMatch(/可以派|跑起来|开始干活/);
  });
});

describe('idCollisionNote（第①步的撞车预检：判据是 server 的 upsert 语义，清单只当取材）', () => {
  const SPACES = [{ id: 'catalog', name: '商品目录服务' }];

  it('同 id 不同名才喊：把话说到「会把已有那枚改名」，不谎称 server 会拦', () => {
    const note = idCollisionNote(SPACES, 'catalog', '订单中心');
    expect(note).toContain('已经是「商品目录服务」的档案');
    expect(note).toContain('会把它的名字改成「订单中心」');
    expect(note).toContain('server 认 ID 不认名');
    expect(note).not.toMatch(/已存在|已被占用|不能创建|创建失败/);
  });

  it('三种不喊：清单还没读到（不知道≠不会撞）／查无此 id／名字就是那一枚档案自己', () => {
    expect(idCollisionNote(null, 'catalog', '订单中心')).toBeNull();
    expect(idCollisionNote(SPACES, 'orders', '订单中心')).toBeNull();
    expect(idCollisionNote(SPACES, 'catalog', '  商品目录服务  ')).toBeNull();
    expect(idCollisionNote(SPACES, '', '订单中心')).toBeNull();
    expect(idCollisionNote(SPACES, 'catalog', '   ')).toBeNull();
  });

  it('项目清单读不出：说读不出，并明说这一枚 ID 就此判不了', () => {
    expect(spacesReadNote({ status: 500, payload: { error: '清单扫不动' } })).toBe(
      '项目清单读不出：清单扫不动——所以这一枚 ID 撞没撞档案判不了',
    );
    expect(spacesReadNote({ status: 502, payload: {} })).toContain('这是没读成');
  });
});
