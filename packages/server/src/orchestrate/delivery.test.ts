import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.js';
import type { DeliveryRule } from './delivery.js';
import { validateDelivery } from './delivery.js';

/**
 * v13-B1 交付约定块入空间：delivery 声明位的类型卫生 + 校验 + 档案往返。
 * 两副样本家规即需求文档 P5 的验收形状——占位符 `{issue}`/`{version}` 当不透明字符串存，
 * B1 不做任何解析（解析与引擎消费在 B2）。
 */

const BUG_HOUSE: DeliveryRule = {
  repo: 'web-console',
  branchFrom: 'main',
  branchName: 'fix/issue-{issue}',
  prTarget: 'main',
  gates: ['对齐先行', 'PR 前', '关单前'],
  note: 'bug 单家规：驳回开 Bug 链回主 Issue（回边是既有件，gates 只声明不新造执行件）',
};

const FEATURE_HOUSE: DeliveryRule = {
  repo: 'web-console',
  branchFrom: 'main',
  branchName: 'feature/v{version}-{issue}',
  prTarget: 'release/v{version}',
  note: 'feature 单家规：{version} 取自起单模板变量（解析通道归 B2）',
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-delivery-'));
}

describe('validateDelivery（PUT 机检，姿态对齐 rules 校验收紧：宁拒不错放）', () => {
  it('合法形状放行：两副样本家规 / 无 repo 全空间副 / 仅必填三字段 / gates 空数组', () => {
    expect(validateDelivery([BUG_HOUSE, FEATURE_HOUSE])).toBeNull();
    expect(validateDelivery([{ branchFrom: 'main', branchName: 'fix/{issue}', prTarget: 'main' }])).toBeNull();
    expect(validateDelivery([{ ...BUG_HOUSE, gates: [] }])).toBeNull();
    expect(validateDelivery([])).toBeNull(); // 显式清空数组是合法写端语义
  });

  it('非数组整拒', () => {
    for (const bad of ['nope', 42, {}, null, undefined, true]) {
      const err = validateDelivery(bad);
      expect(err, JSON.stringify(bad)).toBeTypeOf('string');
      expect(err!).toContain('delivery 必须是');
    }
  });

  it('条目级非法全拒：非对象项 / 必填三字段缺失或空串 / 未知键 / repo·gates·note 破烂', () => {
    const cases: { item: unknown; msg: string }[] = [
      { item: 'fix/issue-{issue}', msg: '第 1 项不是对象' },
      { item: null, msg: '第 1 项不是对象' },
      { item: [{ branchFrom: 'main', branchName: 'b', prTarget: 'main' }], msg: '第 1 项不是对象' },
      { item: { branchFrom: 'main', branchName: 'b' }, msg: 'prTarget 必须是非空字符串' },
      { item: { branchName: 'b', prTarget: 'main' }, msg: 'branchFrom 必须是非空字符串' },
      { item: { branchFrom: 'main', prTarget: 'main' }, msg: 'branchName 必须是非空字符串' },
      { item: { branchFrom: '  ', branchName: 'b', prTarget: 'main' }, msg: 'branchFrom 必须是非空字符串' },
      { item: { branchFrom: 'main', branchName: '', prTarget: 'main' }, msg: 'branchName 必须是非空字符串' },
      { item: { ...FEATURE_HOUSE, branchTo: 'main' }, msg: '含未知键：branchTo' },
      { item: { branchFrom: 'main', branchName: 'b', prTarget: 'main', repo: '' }, msg: 'repo 给出时须为非空字符串' },
      { item: { branchFrom: 'main', branchName: 'b', prTarget: 'main', repo: 7 }, msg: 'repo 给出时须为非空字符串' },
      { item: { branchFrom: 'main', branchName: 'b', prTarget: 'main', gates: '三道人闸' }, msg: 'gates 必须是非空字符串数组' },
      { item: { branchFrom: 'main', branchName: 'b', prTarget: 'main', gates: ['PR 前', '  '] }, msg: 'gates 必须是非空字符串数组' },
      { item: { branchFrom: 'main', branchName: 'b', prTarget: 'main', note: 42 }, msg: 'note 必须是字符串' },
    ];
    for (const { item, msg } of cases) {
      const err = validateDelivery([item]);
      expect(err, JSON.stringify(item)).toContain(msg);
    }
  });
});

describe('档案往返：旧 JSON 照读、delivery 原样存取、不 bump schema', () => {
  it('两副样本家规 writeProfile→readProfile 原样往返（含磁盘与 listSpaces）', () => {
    const dir = tmp();
    const store = new Store(dir, 'demo');
    store.writeProfile({ ...store.readProfile(), delivery: [BUG_HOUSE, FEATURE_HOUSE] });
    // 模拟重启：新 Store 实例读回
    const fresh = new Store(dir, 'demo');
    expect(fresh.readProfile().delivery).toEqual([BUG_HOUSE, FEATURE_HOUSE]);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'spaces', 'demo', 'profile.json'), 'utf8')) as {
      delivery: DeliveryRule[];
    };
    expect(raw.delivery[1]?.branchName).toBe('feature/v{version}-{issue}');
    expect(raw.delivery[1]?.prTarget).toBe('release/v{version}');
    expect(Store.listSpaces(dir).find((s) => s.id === 'demo')?.delivery).toEqual([BUG_HOUSE, FEATURE_HOUSE]);
  });

  it('红线：新建档案没有 delivery 键；读写其余字段照常，不被静默塞入空数组', () => {
    const dir = tmp();
    const store = new Store(dir, 'demo');
    const created = store.readProfile();
    expect('delivery' in created).toBe(false);
    store.writeProfile({ ...created, description: '老档案' });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'spaces', 'demo', 'profile.json'), 'utf8')) as Record<string, unknown>;
    expect('delivery' in raw).toBe(false);
    expect(raw.description).toBe('老档案');
  });
});
