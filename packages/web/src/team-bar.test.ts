import { describe, expect, it } from 'vitest';
import { addableRoles, assigneeOptions } from './team-bar.js';

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

/** v19-R4：「谁来干」候选的纯函数口径——只列接得住单的人，陈列过滤不搬家判据 */
describe('assigneeOptions', () => {
  const roles = [
    { id: 'std-planner', name: '规划', agentKind: 'claude' },
    { id: 'std-implementer', name: '实现', agentKind: 'pi' },
    { id: 'no-engine', name: '没配引擎的岗' },
  ];

  it('角色悬空或没配引擎的成员不进下拉；在册有引擎的按班底顺序列出', () => {
    const out = assigneeOptions(
      [{ roleId: 'std-implementer' }, { roleId: 'ghost' }, { roleId: 'no-engine' }, { roleId: 'std-planner' }],
      roles,
    );
    expect(out.map((o) => o.roleId)).toEqual(['std-implementer', 'std-planner']);
    expect(out[0]!.label).toBe('实现（pi）');
    expect(out[0]!.agentKind).toBe('pi');
  });

  it('alias 是人的称呼优先当显示名，岗位与引擎留在括号里', () => {
    const out = assigneeOptions([{ roleId: 'std-planner', alias: '小规' }], roles);
    expect(out).toEqual([{ roleId: 'std-planner', label: '小规（规划 · claude）', agentKind: 'claude' }]);
  });

  it('agentKind 只有空白的岗按没配处理（不摆选了必被 server 拒的选项）', () => {
    expect(assigneeOptions([{ roleId: 'x' }], [{ id: 'x', name: '空格岗', agentKind: '  ' }])).toEqual([]);
  });
});
