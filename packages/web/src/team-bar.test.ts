import { describe, expect, it } from 'vitest';
import { addableRoles } from './team-bar.js';

/** v10-U3b：班底条下拉可添加项的纯函数口径 */
describe('addableRoles', () => {
  const roles = [
    { id: 'std-planner', name: '规划' },
    { id: 'std-implementer', name: '实现' },
    { id: 'custom-qa', name: '测试外包' },
  ];

  it('已在班底的被排除；空班底返回全库', () => {
    expect(addableRoles(roles, [{ roleId: 'std-planner' }]).map((r) => r.id)).toMatchInlineSnapshot(`
      [
        "std-implementer",
        "custom-qa",
      ]
    `);
    expect(addableRoles(roles, [])).toEqual(roles);
  });

  it('悬空 roleId（库中已删）不产生任何排除，也不进可添加列', () => {
    expect(addableRoles(roles, [{ roleId: 'ghost' }])).toEqual(roles);
    expect(addableRoles([], [{ roleId: 'ghost' }])).toEqual([]);
  });

  it('alias 成员同样按 roleId 去重', () => {
    expect(addableRoles(roles, [{ roleId: 'custom-qa', alias: '小王' }]).map((r) => r.id)).toEqual([
      'std-planner',
      'std-implementer',
    ]);
  });
});
