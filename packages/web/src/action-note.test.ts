import { describe, expect, it } from 'vitest';
import { keepActionNote } from './action-note.js';

/**
 * 动作点读数的寿命判据（v19 步骤十六）。这一枚管的是「这句还该不该挂在屏幕上」——
 * 预检句描述此刻那一格，那一格一改它就是旧话；写失败句是过去的事实，不随编辑作废。
 * 两条都不许靠计时器，所以判据是纯函数，能在这里钉死。
 */
describe('keepActionNote：预检句跟读数走，写失败句不跟', () => {
  it('没读数时原样返回 null', () => {
    expect(keepActionNote(null, 'graph#a')).toBeNull();
  });

  it('预检句：它描述的那一维没变就留着', () => {
    const cur = { tone: 'fail', text: '无法启动：开始节点必须有且仅有一个（当前 0 个）', ctx: 'graph#a' } as const;
    expect(keepActionNote(cur, 'graph#a')).toBe(cur);
  });

  it('预检句：那一维一变（画布修好了）就撤下——旧话挂在屏幕上比没有读数更坏', () => {
    const cur = { tone: 'fail', text: '无法启动：开始节点必须有且仅有一个（当前 0 个）', ctx: 'graph#a' } as const;
    expect(keepActionNote(cur, 'graph#b')).toBeNull();
  });

  it('写失败句/未配置提示：不带 ctx，编辑画布不洗它（那是刚才那一按）', () => {
    const cur = { tone: 'fail', text: '模板没保存（画布上的改动还在）：模板名只能包含字母/数字/-/_' } as const;
    expect(keepActionNote(cur, 'graph#totally-different')).toBe(cur);
    const warn = { tone: 'warn', text: '模板云端同步未启用' } as const;
    expect(keepActionNote(warn, 'anything-else')).toBe(warn);
  });

  it('预检句的空读数也是正读数：ctx 从「空目录」变成「有目录」才算变，两边都非空才比得出', () => {
    const cur = { tone: 'fail', text: '请先填写流水线工作目录', ctx: '' } as const;
    expect(keepActionNote(cur, '')).toBe(cur);
    expect(keepActionNote(cur, '/repo/app')).toBeNull();
  });
});
