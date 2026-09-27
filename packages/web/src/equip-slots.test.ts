import { describe, expect, it } from 'vitest';
import type { RoleEquipSlot } from '@paneflow/shared';
import { hasEquipRef, keepValidSlots, removeEquipSlot, splitEquipSlots, toggleEquipRef } from './equip-slots.js';

/**
 * v14-A5-5b 勾选面的分流判序。
 * 这里每一刀都对着「一格两种写法并存」的那个真实形状来钉：
 * 裸串走 v13-W1 的池子尺、`{kind,id}` 走注册表尺，界面既要说清各自的毛病，
 * 也不能让一个动作顺手改掉另一类。
 */
const options = ['skills/deploy.md', 'docs/review.md'];

describe('装备槽勾选面（v14-A5-5b 两写法并存）', () => {
  it('分流：refs 只收 {kind,id}，「清单外」那句话只数裸串', () => {
    const sel: RoleEquipSlot[] = ['skills/deploy.md', 'ghost.md', { kind: 'skill', id: 'deploy' }];
    const r = splitEquipSlots(sel, options);
    expect(r.bare).toEqual(['skills/deploy.md', 'ghost.md']);
    expect(r.refs).toEqual([{ kind: 'skill', id: 'deploy' }]);
    expect(r.unknown).toEqual(['ghost.md']);
  });

  it('定点引用不算「清单外」——项目勾选清单本来就不含它，说了就是假话', () => {
    const sel: RoleEquipSlot[] = [{ kind: 'rule', id: 'role-checklist' }];
    expect(splitEquipSlots(sel, options).unknown).toEqual([]);
  });

  it('脏形状（空串）不参与勾选对照，但也不被硬判成引用', () => {
    const sel: RoleEquipSlot[] = ['', 'skills/deploy.md'];
    const r = splitEquipSlots(sel, options);
    expect(r.unknown).toEqual(['']);
    expect(r.refs).toEqual([]);
  });

  it('取消勾选只剔同名裸串，不碰引用那一格', () => {
    const sel: RoleEquipSlot[] = [{ kind: 'skill', id: 'deploy' }, 'ghost.md', 'skills/deploy.md'];
    expect(removeEquipSlot(sel, 'skills/deploy.md')).toEqual([
      { kind: 'skill', id: 'deploy' },
      'ghost.md',
    ]);
  });

  it('「摘掉」引用按 kind+id 配对剔，同名的另一类写法留下', () => {
    const sel: RoleEquipSlot[] = ['deploy', { kind: 'skill', id: 'deploy' }];
    expect(removeEquipSlot(sel, { kind: 'skill', id: 'deploy' })).toEqual(['deploy']);
    expect(removeEquipSlot(sel, { kind: 'rule', id: 'deploy' })).toEqual(sel);
  });

  it('「清掉」只清清单外的裸串：引用与清单内的勾选项一律留下', () => {
    const sel: RoleEquipSlot[] = [
      { kind: 'skill', id: 'deploy' },
      'ghost.md',
      'skills/deploy.md',
      'another/bad.md',
    ];
    expect(keepValidSlots(sel, options)).toEqual([{ kind: 'skill', id: 'deploy' }, 'skills/deploy.md']);
  });

  it('全干净的槽：清掉是空操作（不拿「一键清理」名义改动没毛病的格子）', () => {
    const sel: RoleEquipSlot[] = ['skills/deploy.md', { kind: 'rule', id: 'x' }];
    expect(keepValidSlots(sel, options)).toEqual(sel);
  });

  it('定点引用的勾选：认 kind+id 成对，不认对象相等；同名的裸串不算已勾', () => {
    const sel: RoleEquipSlot[] = ['skill:deploy', { kind: 'skill', id: 'skill:deploy' }];
    expect(hasEquipRef(sel, { kind: 'skill', id: 'skill:deploy' })).toBe(true);
    expect(hasEquipRef(sel, { kind: 'rule', id: 'skill:deploy' })).toBe(false);
    expect(hasEquipRef(['skill:deploy'], { kind: 'skill', id: 'skill:deploy' })).toBe(false);
  });

  it('勾选一枚引用：没勾上追加、已勾上摘掉，且绝不产生第二枚同一格', () => {
    const ref = { kind: 'skill' as const, id: 'skill:deploy' };
    const added = toggleEquipRef(['ghost.md'], ref);
    expect(added).toEqual(['ghost.md', ref]);
    expect(toggleEquipRef(added, ref)).toEqual(['ghost.md']);
    // 手编名册里可能躺着两枚同一引用：勾选框是「有没有」这一个读数，取消一次就把重复的并入零，
    // 而不是留下第二枚让人以为「还勾着」
    const dup = [...added, ref];
    expect(toggleEquipRef(dup, ref)).toEqual(['ghost.md']);
  });

  it('同一枚条目的另一种写法（slug 段）在勾选面上是「没勾」——照 id 原样比对，不替人归一', () => {
    // server 侧两枚写法都指得到那一条目（`skillDescriptor.refKeys`＝整枚 id／slug／`spec.file`），
    // 但勾选面把 id 归一成整枚 id 就等于替人改写了那枚岗的账（保存后落盘的字节变了）；
    // 于是这里照字面比对：那格显示未勾，勾上去是**追加第二枚写法**，两枚都留着照旧解析得到
    const sel: RoleEquipSlot[] = [{ kind: 'skill', id: 'deploy' }];
    expect(hasEquipRef(sel, { kind: 'skill', id: 'skill:deploy' })).toBe(false);
    expect(toggleEquipRef(sel, { kind: 'skill', id: 'skill:deploy' })).toEqual([
      { kind: 'skill', id: 'deploy' },
      { kind: 'skill', id: 'skill:deploy' },
    ]);
    // 摘掉时按 kind+id 成对剔：动整枚 id 那一枚，slug 写法留下（不顺手替人清理另一种拼法）
    expect(removeEquipSlot(sel, { kind: 'skill', id: 'skill:deploy' })).toEqual(sel);
  });
});
