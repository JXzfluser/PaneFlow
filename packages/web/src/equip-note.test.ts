import { describe, expect, it } from 'vitest';
import type { NodeEquip } from '@paneflow/shared';
import { equipLines } from './equip-note.js';

/**
 * v19 打磨：装备账网页可见面 = CLI `paneflow status` 同款画法（判据在 server，这里只锁渲染口径）。
 */

const eq = (over: Partial<NodeEquip> = {}): NodeEquip => ({
  scope: 'role',
  skills: ['docs/a.md', 'docs/b.md'],
  rules: ['docs/r.md'],
  ...over,
});

describe('v19 打磨 equipLines（岗位装备账的清单视图行）', () => {
  it('整键缺省=注入现场没走到——回空数组，不拿零行冒充「吃了零」', () => {
    expect(equipLines(undefined)).toEqual([]);
  });

  it('干净岗位账：技能/文档计数 + 岗名 + 模型（后两枚非空才上）', () => {
    expect(equipLines(eq({ role: 'r-impl', model: 'gpt-4o' }))).toEqual([
      { text: '装备: 技能 2 · 岗位文档 1 · 岗 r-impl · 模型 gpt-4o', warn: false },
    ]);
    expect(equipLines(eq())).toEqual([{ text: '装备: 技能 2 · 岗位文档 1', warn: false }]);
  });

  it('scope=space 且绑了角色=吃空间全量，升级为警示行（与 CLI 同措辞）', () => {
    const [line] = equipLines(eq({ scope: 'space', role: 'r-x' }));
    expect(line?.warn).toBe(true);
    expect(line?.text).toBe('⚠ 装备: 技能 2 · 岗位文档 1 —— 该角色未配装备，正吃空间全量');
  });

  it('misses 逐格一行，why 是 server 原话一字不动', () => {
    const lines = equipLines(
      eq({
        misses: [
          { axis: 'skill', slot: 'skill:ghost', why: '解析不到可用条目' },
          { axis: 'rule', slot: 'docs/gone.md', why: '不在登记清单' },
        ],
      }),
    );
    expect(lines.map((l) => l.text)).toEqual([
      '装备: 技能 2 · 岗位文档 1',
      '⚠ 装备没落地，已跳过：skill:ghost —— 解析不到可用条目',
      '⚠ 装备没落地，已跳过：docs/gone.md —— 不在登记清单',
    ]);
    expect(lines.slice(1).every((l) => l.warn)).toBe(true);
  });

  it('旧账没有 misses 明细才回落 v13-W1「不在登记清单」原话；有明细时不双画', () => {
    expect(equipLines(eq({ unknownSkills: ['ghost-a', 'ghost-b'] }))).toEqual([
      { text: '装备: 技能 2 · 岗位文档 1', warn: false },
      { text: '⚠ 装备引用不在登记清单，已跳过：ghost-a、ghost-b', warn: true },
    ]);
    const withMisses = equipLines(
      eq({ unknownSkills: ['ghost-a'], misses: [{ axis: 'skill', slot: 'ghost-a', why: '不属于本单所在项目' }] }),
    );
    expect(withMisses.some((l) => l.text.includes('不在登记清单'))).toBe(false);
  });

  it('空数组是正读数（确实一个都没注），与整键缺分的家规在计数上如实画 0', () => {
    expect(equipLines(eq({ skills: [], rules: [] }))).toEqual([
      { text: '装备: 技能 0 · 岗位文档 0', warn: false },
    ]);
  });
});
