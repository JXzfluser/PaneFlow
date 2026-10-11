import { describe, expect, it } from 'vitest';
import {
  assigneeEquipBrief,
  autoEngineBrief,
  autoEngineFix,
  buildMemberCards,
  type AutoEngineWire,
  type TeamViewInputs,
} from './team-view.js';

function inputs(over: Partial<TeamViewInputs> = {}): TeamViewInputs {
  return {
    team: [{ roleId: 'r-deliver', alias: '交付手' }],
    roles: [{ id: 'r-deliver', name: '交付岗', agentKind: 'claude', skills: ['a.md'], rules: [] }],
    agentsInstalled: ['claude', 'pi'],
    recommendedAgentKind: 'pi',
    defaultAgentKind: 'pi',
    gateway: { enabled: true, current: 'default', freeModel: 'glm-4.5-air' },
    profiles: {},
    ...over,
  };
}

describe('buildMemberCards（R3 三问三答，零新判据）', () => {
  it('在：岗上引擎已装 → 亮卡，presence 写明来源', () => {
    const [c] = buildMemberCards(inputs());
    expect(c!.presence).toBe('on');
    expect(c!.dim).toBe(false);
    expect(c!.presenceLine).toContain('claude 已装（岗上指定）');
    expect(c!.display).toBe('交付手');
    expect(c!.equipLine).toBe('技能 1 · 岗位文档 0（配置账，尚无实注记录）');
    expect(c!.equipTitle).toContain('实注账要等这岗真上过单');
    expect(c!.modelLine).toBe('走网关档「default」 · 免费模型 glm-4.5-air');
  });

  it('v19-M1 岗位配了模型 → modelLine 显岗位值（覆盖网关兜底）；没配这格走原读数', () => {
    const [c] = buildMemberCards(
      inputs({ roles: [{ id: 'r-deliver', name: '交付岗', agentKind: 'claude', model: 'gpt-4o' }] }),
    );
    expect(c!.modelLine).toBe('模型 gpt-4o（岗位专属，覆盖网关兜底）');
    const [noGw] = buildMemberCards(
      inputs({ gateway: null, roles: [{ id: 'r-deliver', name: '交付岗', model: '  gpt-4o  ' }] }),
    );
    // 岗位值优先于「网关读数不可得」——配了模型这事实不因网关读不到而消失（值先 trim 再显）
    expect(noGw!.modelLine).toBe('模型 gpt-4o（岗位专属，覆盖网关兜底）');
  });

  it('v19 装备实注账压配置账：有 equip 落册就报实注，两本账在 title 里各说各的', () => {
    const [c] = buildMemberCards(
      inputs({
        profiles: {
          'r-deliver': {
            runs: 4,
            equip: { n: 3, skills: 5, rules: 2, fullSpace: 1, misses: 2 },
          },
        },
      }),
    );
    expect(c!.equipLine).toBe('实注 技能 5 · 岗位文档 2 · 3 次上场 · ⚠ 1 格吃项目全量 · ⚠ 2 格没落地');
    expect(c!.equipTitle).toContain('配置账（岗位声明的装备槽）：技能 1 · 岗位文档 0');
    // 干净账：两枚 ⚠ 都不画
    const [clean] = buildMemberCards(
      inputs({ profiles: { 'r-deliver': { runs: 1, equip: { n: 1, skills: 2, rules: 0, fullSpace: 0, misses: 0 } } } }),
    );
    expect(clean!.equipLine).toBe('实注 技能 2 · 岗位文档 0 · 1 次上场');
    // 没配装备槽但实注账在（吃项目全量那类）：配置那行不冒充零格
    const [noSlot] = buildMemberCards(
      inputs({
        roles: [{ id: 'r-deliver', name: '交付岗', agentKind: 'claude' }],
        profiles: { 'r-deliver': { runs: 1, equip: { n: 1, skills: 6, rules: 3, fullSpace: 1, misses: 0 } } },
      }),
    );
    expect(noSlot!.equipTitle).toContain('配置账：这岗没配装备槽');
  });

  it('不在：引擎没装 → 灰卡带点亮条件（需求稿原话形状）', () => {
    const [c] = buildMemberCards(inputs({ agentsInstalled: ['pi'] }));
    expect(c!.presence).toBe('off');
    expect(c!.dim).toBe(true);
    expect(c!.presenceLine).toBe('claude CLI 未装：装好即自动点亮');
  });

  it('解析链：岗没指定 → 项目默认 → 推荐；三路全空=unknown 不编引擎', () => {
    const bySpace = buildMemberCards(inputs({ roles: [{ id: 'r-deliver', name: '交付岗' }] }))[0]!;
    expect(bySpace.kindSource).toBe('space');
    const noDefault = buildMemberCards(inputs({ roles: [{ id: 'r-deliver', name: '交付岗' }], defaultAgentKind: '' }))[0]!;
    expect(noDefault.kindSource).toBe('recommended');
    const none = buildMemberCards(
      inputs({ roles: [{ id: 'r-deliver', name: '交付岗' }], defaultAgentKind: '', recommendedAgentKind: null, agentsInstalled: [] }),
    )[0]!;
    expect(none.presence).toBe('unknown');
    expect(none.agentKind).toBeNull();
  });

  it('履历缺账各说各话：没这份账 ≠ 干得差（runs=0 与读不到分家）', () => {
    const fresh = buildMemberCards(inputs({ profiles: { 'r-deliver': { runs: 0 } } }))[0]!;
    expect(fresh.trackLine).toBe('还没上过单——第一次派活后这里就有账');
    const unknown = buildMemberCards(inputs({ profiles: { 'r-deliver': undefined } }))[0]!;
    expect(unknown.trackLine).toContain('读不到');
    const withLedger = buildMemberCards(
      inputs({
        profiles: {
          'r-deliver': {
            runs: 5,
            passRate: { n: 4, passed: 3 },
            rework: { rejected: 0, capped: 0 },
            attention: { n: 2, waitMs: 252_000, gates: { approve: 2, reject: 0, input: 0 } },
          },
        },
      }),
    )[0]!;
    expect(withLedger.trackLine).toBe('上过 5 单 · 收口 3/4 绿 · 打回 0 次 · 你为他等 4.2 分');
    // rework 整键缺省：不报 0 冒充「实测零返工」
    const noRework = buildMemberCards(inputs({ profiles: { 'r-deliver': { runs: 2 } } }))[0]!;
    expect(noRework.trackLine).not.toContain('打回');
  });

  it('悬空成员不吞人：岗不在角色库明说，display 回落 alias/id', () => {
    const [c] = buildMemberCards(inputs({ roles: [], team: [{ roleId: 'r-ghost', alias: '老王' }] }));
    expect(c!.roleName).toContain('已无此岗');
    expect(c!.display).toBe('老王');
    expect(c!.equipLine).toContain('岗不在角色库');
  });

  it('网关读不到 ≠ 没启网关——不可得就说不可得', () => {
    const [c] = buildMemberCards(inputs({ gateway: null }));
    expect(c!.modelLine).toBe('网关读数不可得');
    const off = buildMemberCards(inputs({ gateway: { enabled: false } }))[0]!;
    expect(off.modelLine).toContain('引擎自带');
  });

  it('派活挑人读数与班底卡同一句措辞；没账的两种读法分开说', () => {
    const eq = { n: 2, skills: 6, rules: 3, fullSpace: 1, misses: 1 };
    const brief = assigneeEquipBrief(eq, 2)!;
    // 与班底卡的 equipLine 逐字相同：措辞只住一处，两处不许各写一遍
    const card = buildMemberCards(inputs({ profiles: { 'r-deliver': { runs: 2, equip: eq } } }))[0]!;
    expect(brief.text).toBe(card.equipLine);
    expect(brief.tone).toBe('warn');
    expect(assigneeEquipBrief({ n: 1, skills: 2, rules: 0, fullSpace: 0, misses: 0 }, 1)!.tone).toBe('ok');
    // 没上过单 ≠ 上过单但没落装备账：两种读法不能合成一句含糊话
    expect(assigneeEquipBrief(undefined, 0)).toEqual({ text: '这岗还没上过单：实注账第一次派活后才落', tone: 'dim' });
    expect(assigneeEquipBrief(undefined, 3)).toEqual({ text: '有 3 单履历，但没落装备账（注入现场没走到，或旧单）', tone: 'dim' });
    // 岗级账本身没回来 → 不画（宁缺毋假）
    expect(assigneeEquipBrief(undefined, undefined)).toBeNull();
  });
});

describe('autoEngineBrief（选「自动」时的引擎读数：整句人话由 server 组，浏览器只挑颜色）', () => {
  const wire = (over: Partial<AutoEngineWire> = {}): AutoEngineWire => ({
    agentKind: 'pi',
    via: 'project-default',
    note: '引擎按项目默认解析 → pi（各步若自绑岗位，仍以该岗的引擎为准）',
    ...over,
  });

  it('note 逐字照渲，措辞不在浏览器重拼一遍', () => {
    const b = autoEngineBrief(wire())!;
    expect(b.text).toBe('引擎按项目默认解析 → pi（各步若自绑岗位，仍以该岗的引擎为准）');
    expect(b.tone).toBe('ok');
  });

  it('四态四色：none=派不出单才告警；probed/unknown 是中性读数不是毛病', () => {
    expect(autoEngineBrief(wire({ via: 'probed', note: '按本机实探落到 → codex' }))!.tone).toBe('dim');
    expect(autoEngineBrief(wire({ via: 'unknown', agentKind: null, note: '档案读不动' }))!.tone).toBe('dim');
    expect(autoEngineBrief(wire({ via: 'none', agentKind: null, note: '现在派不出单' }))!.tone).toBe('warn');
  });

  it('读数没回来 / server 没给这句话 → 不画行，绝不自己补一句「默认引擎」', () => {
    expect(autoEngineBrief(null)).toBeNull();
    expect(autoEngineBrief(undefined)).toBeNull();
    expect(autoEngineBrief({ agentKind: null, via: 'none', note: '  ' })).toBeNull();
  });
});

describe('autoEngineFix（派不出单的修复卡提前到起单之前，动作与墙后那张同尺）', () => {
  const none: AutoEngineWire = { agentKind: null, via: 'none', note: '现在派不出单' };

  it('实探链全空 ≠ 本机没引擎：装了 qodercli 那一类就先给「用这些干」', () => {
    expect(autoEngineFix(none, ['qodercli', 'hermes'])).toEqual({ offer: ['qodercli', 'hermes'] });
  });

  it('一枚都没装才落到「去装 + 重新探」，不摆一排空按钮', () => {
    expect(autoEngineFix(none, [])).toEqual({ install: true, retry: true });
  });

  it('其余三态没有墙：不画修复行（有默认/实探有值/档案读不动都不该冒按钮）', () => {
    for (const via of ['project-default', 'probed', 'unknown'] as const) {
      expect(autoEngineFix({ agentKind: 'pi', via, note: 'x' }, ['qodercli'])).toBeNull();
    }
    expect(autoEngineFix(null, ['qodercli'])).toBeNull();
  });

  it('挑了成员就不看这一路：读数与修复都跟着「自动」那条选择走', () => {
    // 选择器决定的是读哪本账（岗级装备账 vs 项目引擎梯），这里锁住两本账不互相顶替
    expect(autoEngineBrief(none)!.text).toBe('现在派不出单');
    expect(assigneeEquipBrief({ n: 1, skills: 1, rules: 0, fullSpace: 0, misses: 0 }, 1)!.text).toContain('实注');
  });
});
