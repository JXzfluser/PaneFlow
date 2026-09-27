import { describe, expect, it } from 'vitest';
import type { RoleEquipSlot } from '@paneflow/shared';
import { keepValidSlots, removeEquipSlot, splitEquipSlots } from './equip-slots.js';

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
});
