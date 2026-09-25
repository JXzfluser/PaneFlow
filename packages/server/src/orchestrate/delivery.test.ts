import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';
import { Store } from './store.js';
import type { DeliveryRule } from './delivery.js';
import {
  buildDeliveryBlock,
  declaredGateNames,
  hasHumanGate,
  matchDeliveryRule,
  normalizeDeliveryRules,
  planDelivery,
  renderDeliveryTemplate,
  repoRelOf,
  validateDelivery,
} from './delivery.js';

/**
 * v13-B1 交付约定块入空间：delivery 声明位的类型卫生 + 校验 + 档案往返。
 * 两副样本家规即需求文档 P5 的验收形状——占位符 `{issue}`/`{version}` 在盘面当不透明字符串存
 * （写入面永不解析）。v13-B2 起读取面才渲染并消费：本文件下半校的是 B2 三层共用的判据
 * （匹配/渲染/文案/纯图账），引擎现场与状态判定归 engine.test.ts。
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
  note: 'feature 单家规：{version} 取自起单模板变量（B2 起读取面渲染）',
};

/** 只有精确仓条目（没有通配副兜底）——校「不命中就不消费」用 */
const SCOPED_ONLY: DeliveryRule = { ...BUG_HOUSE };
/** 必填三字段齐、其余全缺的最小家规 */
const MINIMAL_HOUSE: DeliveryRule = { branchFrom: 'main', branchName: 'b', prTarget: 'main' };

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

// ---------------------------------------------------------------------------
// v13-B2 读取面判据（三层消费者共用：①机检 createWorktree / ②注入 resolveContext / ③收口对账）
// ---------------------------------------------------------------------------

describe('v13-B2 占位符渲染：{issue}/{run_id}/起单变量三取材，解析不到如实上报', () => {
  it('解析到的替换、解析不到的留字面并列进 missing（去重按出现序）', () => {
    const r = renderDeliveryTemplate('feature/v{version}-{issue}', {
      issueId: '123',
      variables: { version: '1.4' },
    });
    expect(r).toEqual({ value: 'feature/v1.4-123', missing: [] });
    // 同一占位符出现两次只报一次名；两个都缺则并列
    const miss = renderDeliveryTemplate('{issue}/{issue}-{version}', { runId: 'ab12cd34' });
    expect(miss.value).toBe('{issue}/{issue}-{version}');
    expect(miss.missing).toEqual(['issue', 'version']);
    // {run_id} 走 runId 取材（与图内 {{run_id}} 内置变量同名同源）
    expect(renderDeliveryTemplate('pf/{run_id}', { runId: 'ab12cd34' }).value).toBe('pf/ab12cd34');
  });

  it('实填变量优先于内置取材（与 applyVariables 的 builtinVars 展开同 precedence）', () => {
    const r = renderDeliveryTemplate('fix/issue-{issue}', { issueId: '123', variables: { issue: '900' } });
    expect(r.value).toBe('fix/issue-900');
    expect(r.missing).toEqual([]);
  });

  it('不是占位符的字面一律不动：空花括号/非法名/花括号不成对都原样保留（家规是配置不是脚本）', () => {
    for (const raw of ['fix/{}-x', 'fix/{9bad}', 'fix/{issue', 'fix/{a b}', 'fix/{a.b}']) {
      const r = renderDeliveryTemplate(raw, { issueId: '123' });
      expect(r.value).toBe(raw);
      expect(r.missing).toEqual([]);
    }
  });

  it('空串/纯空白的取材视同解析不到（绝不渲染出 fix/issue- 这种半截分支名）', () => {
    const r = renderDeliveryTemplate('fix/issue-{issue}', { issueId: '   ', variables: { version: '' } });
    expect(r.value).toBe('fix/issue-{issue}');
    expect(r.missing).toEqual(['issue']);
  });
});

describe('v13-B2 按仓匹配：与 rules.matchRules 同一把尺，精确条目优先于通配副', () => {
  const WILD: DeliveryRule = { branchFrom: 'main', branchName: 'wt/wild-{issue}', prTarget: 'main' };
  const SCOPED: DeliveryRule = { ...BUG_HOUSE, branchName: 'wt/scoped-{issue}' };

  it('同仓两副：repo 精确条目赢，即使通配副排在前面（数组顺序不决定优先级）', () => {
    const m = matchDeliveryRule([WILD, SCOPED], 'web-console');
    expect(m?.matchedBy).toBe('repo');
    expect(m?.index).toBe(1);
    expect(m?.rule.branchName).toBe('wt/scoped-{issue}');
  });

  it('仓不在任何精确条目里 → 通配副兜住；只有精确条目且不匹配 → undefined（不消费）', () => {
    expect(matchDeliveryRule([SCOPED, WILD], 'other-repo')?.matchedBy).toBe('space');
    expect(matchDeliveryRule([SCOPED], 'other-repo')).toBeUndefined();
    expect(matchDeliveryRule([SCOPED], 'other-repo')?.rule).toBeUndefined();
  });

  it('嵌套路径按目录前缀算命中（rel 在 repo 目录内即命中，同 matchRules）', () => {
    expect(matchDeliveryRule([SCOPED], 'web-console/apps/admin')?.matchedBy).toBe('repo');
    expect(matchDeliveryRule([SCOPED], 'web-consoleX')?.matchedBy).toBeUndefined();
    // 尾斜杠不挑刺
    expect(matchDeliveryRule([{ ...SCOPED, repo: 'web-console/' }], 'web-console')?.matchedBy).toBe('repo');
  });

  it('主仓根未配置 / 目标不在仓内（rel 归一成空）→ 只有通配副能命中', () => {
    expect(matchDeliveryRule([SCOPED, WILD], '')?.matchedBy).toBe('space');
    expect(matchDeliveryRule([SCOPED], '')).toBeUndefined();
  });

  it('repoRelOf 与 rules 同款归一：同根=空、仓内=目录名（/ 分隔）、仓外=空、无主仓根=空', () => {
    const root = path.join(path.sep, 'work', 'space');
    expect(repoRelOf(root, path.join(root, 'svc', 'sub'))).toBe('svc/sub');
    expect(repoRelOf(root, root)).toBe('');
    expect(repoRelOf(root, path.join(path.sep, 'elsewhere', 'svc'))).toBe('');
    expect(repoRelOf(undefined, root)).toBe('');
  });
});

describe('v13-B2 读端清洗 + planDelivery：脏条目整条不取，契约 branch 压过空间 branchFrom', () => {
  it('normalizeDeliveryRules：必填三字段坏掉/形状破烂的条目丢弃，合法条目保序（写侧已 fail-closed，这里兜手改盘面）', () => {
    const dirty = [
      BUG_HOUSE,
      { branchFrom: '', branchName: 'b', prTarget: 'main' },
      { branchFrom: 'main', branchName: 'b' },
      'fix/issue-1',
      null,
      [{ branchFrom: 'main', branchName: 'b', prTarget: 'main' }],
      { ...FEATURE_HOUSE, repo: 7 },
      { ...FEATURE_HOUSE, gates: ['PR 前', '  '] },
      { branchFrom: 'main', branchName: 'ok', prTarget: 'main' },
    ];
    expect(normalizeDeliveryRules(dirty).map((r) => r.branchName)).toEqual([BUG_HOUSE.branchName, 'ok']);
    expect(normalizeDeliveryRules(undefined)).toEqual([]);
    expect(normalizeDeliveryRules({})).toEqual([]);
    expect(normalizeDeliveryRules([])).toEqual([]);
  });

  it('无命中条目 → planDelivery 返回 undefined（兼容带死判据：三层一条都不走）', () => {
    const ctx = { issueId: '123', runId: 'ab12cd34', variables: { version: '1.4' } };
    expect(planDelivery({ rules: [], repoRel: 'web-console', ctx })).toBeUndefined();
    expect(
      planDelivery({ rules: [SCOPED_ONLY], repoRel: 'other', ctx }),
    ).toBeUndefined();
  });

  it('契约给了 branch 就压过空间 branchFrom（契约优先于空间），没给则守家规', () => {
    const ctx = { issueId: '123', variables: { version: '1.4' } };
    const plain = planDelivery({ rules: [BUG_HOUSE], repoRel: 'web-console', ctx })!;
    expect(plain.baseRef).toBe('main');
    expect(plain.baseSource).toBe('rule');
    expect(plain.branchName).toBe('fix/issue-123');
    const overridden = planDelivery({ rules: [BUG_HOUSE], repoRel: 'web-console', contractBranch: 'release/v1.4', ctx })!;
    expect(overridden.baseRef).toBe('release/v1.4');
    expect(overridden.baseSource).toBe('contract');
    // 覆盖只作用于基点：分支名仍按家规渲染（家规的命名权不许被契约悄悄换掉）
    expect(overridden.branchName).toBe('fix/issue-123');
    // 破烂契约值（空白）= 没给，照守家规
    expect(planDelivery({ rules: [BUG_HOUSE], repoRel: 'web-console', contractBranch: '  ', ctx })!.baseSource).toBe('rule');
  });

  it('未解析按字段各自入账（文案要指认是哪个模板没渲染开）', () => {
    const plan = planDelivery({ rules: [FEATURE_HOUSE], repoRel: 'web-console', ctx: { runId: 'ab12cd34' } })!;
    expect(plan.unresolved.map((u) => u.field).sort()).toEqual(['branchName', 'prTarget']);
    expect(plan.unresolved.find((u) => u.field === 'prTarget')?.raw).toBe('release/v{version}');
    expect(plan.unresolved.find((u) => u.field === 'prTarget')?.names).toEqual(['version']);
    // branchFrom 无占位符 → 不在未解析名单里
    expect(plan.baseRef).toBe('main');
  });
});

describe('v13-B2 注入块文案 + 纯图人闸判据', () => {
  const ctx = { issueId: '123', runId: 'ab12cd34', variables: { version: '1.4' } };

  it('渲染后的约定块要素齐备且措辞诚实：基点/分支名/PR 目标/gates 逐条名/note，且不代跑 push·建 PR', () => {
    const plan = planDelivery({ rules: [BUG_HOUSE], repoRel: 'web-console', ctx })!;
    const block = buildDeliveryBlock(plan);
    expect(block).toContain('交付约定（本项目家规，仓「web-console」（相对主仓根），档案 delivery 第 1 条）');
    expect(block).toContain('- 拉出基点：main（来源=空间家规）');
    expect(block).toContain('- 分支名：fix/issue-123（家规模板 fix/issue-{issue}）');
    expect(block).toContain('- PR 目标分支：main（家规模板 main）'); // B4：prTarget 自此进注入块
    expect(block).toContain('「对齐先行」、「PR 前」、「关单前」');
    expect(block).toContain('- 家规备注：bug 单家规');
    // 诚实边界（同 W3「声明非强制」口径）
    expect(block).toContain('PaneFlow 只声明与对账、不代跑 git push 也不代建 PR');
    expect(block).toContain('落差只照不拦（PR 目标分支的核验在人闸位）');
    expect(block.endsWith('---\n')).toBe(true);
  });

  it('占位符没渲染开：块里如实写出是哪个模板缺什么 + fail-closed 预告（不假称已按约定命名）', () => {
    const plan = planDelivery({ rules: [FEATURE_HOUSE], repoRel: 'web-console', ctx: { issueId: '7' } })!;
    const block = buildDeliveryBlock(plan);
    expect(block).toContain('⚠ 占位符未解析');
    expect(block).toContain('branchName 模板「feature/v{version}-{issue}」的 {version}');
    expect(block).toContain('prTarget 模板「release/v{version}」的 {version}');
    expect(block).toContain('fail-closed 拒建');
    expect(block).toContain('绝不静默回退');
  });

  it('契约覆盖基点时文案点明来源（读的人能 recon 出基点是哪来的）', () => {
    const block = buildDeliveryBlock(
      planDelivery({ rules: [BUG_HOUSE], repoRel: 'web-console', contractBranch: 'release/v1.4', ctx })!,
    );
    expect(block).toContain('- 拉出基点：release/v1.4（来源=本单契约覆盖，契约优先于空间）');
  });

  it('hasHumanGate：manual/契约/分支守卫检查与 clarify 澄清轮都算人闸；纯 agent/start/end 图不算', () => {
    const g = (checks: unknown[], clarify = false): DagGraph =>
      ({
        version: 1,
        name: 'g',
        nodes: [
          { id: 'start', type: 'start', label: '开始', config: {} },
          {
            id: 'impl',
            type: 'agent',
            label: '实现',
            config: { prompt: '干活', checks, ...(clarify ? { clarify: { maxRounds: 2 } } : {}) },
          },
        ],
        edges: [],
        metadata: { createdAt: '', updatedAt: '' },
      }) as unknown as DagGraph;
    expect(hasHumanGate(g([]))).toBe(false);
    expect(hasHumanGate(g([{ type: 'file-exists', path: 'a.md' }, { type: 'command', run: 'pnpm test' }]))).toBe(false);
    expect(hasHumanGate(g([{ type: 'manual', prompt: '看一眼' }]))).toBe(true);
    expect(hasHumanGate(g([{ type: 'contract' }]))).toBe(true);
    expect(hasHumanGate(g([{ type: 'delivery-branch' }]))).toBe(true);
    expect(hasHumanGate(g([], true))).toBe(true);
    // 破烂图（nodes 不是数组/缺 config）不许炸判据：读不出人闸就是没有
    expect(hasHumanGate(undefined)).toBe(false);
    expect(hasHumanGate({ nodes: null } as unknown as DagGraph)).toBe(false);
    expect(hasHumanGate({ version: 1, name: 'x', nodes: [{ id: 'a', type: 'agent', label: 'a' }] as never, edges: [], metadata: { createdAt: '', updatedAt: '' } } as DagGraph)).toBe(false);
  });

  it('declaredGateNames：非空字符串才计入（空数组=没声明，不是落差）', () => {
    expect(declaredGateNames(BUG_HOUSE)).toEqual(['对齐先行', 'PR 前', '关单前']);
    expect(declaredGateNames({ ...BUG_HOUSE, gates: [] })).toEqual([]);
    expect(declaredGateNames({ ...BUG_HOUSE, gates: ['  ', '关单前'] })).toEqual(['关单前']);
    expect(declaredGateNames(MINIMAL_HOUSE)).toEqual([]);
  });
});
