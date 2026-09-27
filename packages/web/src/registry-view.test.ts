import { describe, expect, it } from 'vitest';
import {
  buildRegistryPayload,
  formFieldsFor,
  formatWhen,
  groupEntriesByKind,
  healthDot,
  healthIndex,
  healthTitle,
  isViewEntry,
  kindGroupLabel,
  missingRequiredFields,
  probeNote,
  refCountOf,
  refNote,
  refRows,
  rejectedSummary,
  registrableKinds,
  requirementBadge,
  requirementDetail,
  spaceDocCandidates,
  spaceRepoCandidates,
  sourceLabel,
  specRows,
  whenLabels,
  type RegistryCheckRow,
  type RegistryEntryView,
  type RegistryProbeResponse,
} from './registry-view';

const entry = (over: Partial<RegistryEntryView> = {}): RegistryEntryView => ({
  id: 'model:gpt-4o',
  kind: 'model',
  name: 'GPT-4o 常用',
  source: 'user',
  enabled: true,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  spec: { model: 'gpt-4o' },
  label: 'gpt-4o',
  ...over,
});

describe('v14-X1 注册中心分组与文案（判据全在 server，这里只渲给到的）', () => {
  /** 组名只从 server 的 `kindLabels` 来——这里给的是「server 说了什么」的桩，不是 web 自己的表 */
  const LABELS = { model: '模型', 'agent-kind': 'Agent 引擎' };

  it('knownKinds 立牌：空组也在——空表是正读数不是错误，不画报错', () => {
    const groups = groupEntriesByKind([], ['model'], [], LABELS);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('model');
    expect(groups[0]!.label).toBe('模型');
    expect(groups[0]!.entries).toEqual([]);
  });

  /**
   * 单一词表（A3-2 决议）：web 里不留 kind→中文名 那份表。
   * 所以「server 没给 labels」必须是**看得见**的「未知类型」，而不是悄悄回落成中文——
   * 回落了就是两张表还在，只是这一版没测到。
   */
  it('组名只认 server 给的 labels：没给就明说未知，绝不回落成 web 自带的中文名', () => {
    expect(kindGroupLabel('model')).toBe('未知类型：model');
    expect(kindGroupLabel('model', LABELS)).toBe('模型');
    expect(groupEntriesByKind([], ['model'], [])[0]!.label).toBe('未知类型：model');
  });

  it('分组按 server 给的 knownKinds 顺序，条目按 kind 归位', () => {
    const groups = groupEntriesByKind([entry(), entry({ id: 'x:1', kind: 'other' as never })], ['model'], [], LABELS);
    expect(groups.map((g) => g.kind)).toEqual(['model', 'other']);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['model:gpt-4o']);
  });

  it('未知 kind 不静默吞：条目里有 knownKinds 之外的 kind 时追加成组并标明未知', () => {
    const groups = groupEntriesByKind([entry({ kind: 'rule' as never })], ['model'], [], LABELS);
    expect(groups.map((g) => g.kind)).toEqual(['model', 'rule']);
    expect(kindGroupLabel('rule', LABELS)).toContain('未知类型');
    expect(kindGroupLabel('rule', LABELS)).toContain('rule');
    expect(groups[1]!.label).toBe('未知类型：rule');
  });

  it('source 三态中文定死；没挂号的来源值原样披露而不是画成空', () => {
    expect(sourceLabel('builtin')).toBe('出厂');
    expect(sourceLabel('user')).toBe('登记');
    expect(sourceLabel('discovered')).toBe('探得');
    expect(sourceLabel(' alien')).toContain('未识别来源');
    expect(sourceLabel(' alien')).toContain(' alien');
  });

  it('rejected 一句总述带计数与「不计入下表」；空 rejected 不给话（不凭空造警告）', () => {
    expect(rejectedSummary([])).toBeNull();
    const text = rejectedSummary([{ id: 'bad:1', why: '不认的能力类型「bad」' }]);
    expect(text).toContain('1 条');
    expect(text).toContain('不计入下表');
  });
});

describe('v14-X1 表单长法与 POST 体组装', () => {
  it('model 长出四键、model 必填；没挂号的 kind 不临场发明字段', () => {
    expect(formFieldsFor('model')!.map((f) => f.key)).toEqual(['model', 'gatewayProfile', 'freeModel', 'note']);
    expect(formFieldsFor('model')!.find((f) => f.key === 'model')!.required).toBe(true);
    // `rule`/`repo` 自 A5-2/A5-3 起有表单长法了；仍未迁的那一类照旧不猜形状
    expect(formFieldsFor('rule')!.map((f) => f.key)).toEqual(['space', 'file', 'repo', 'pathsGlob', 'note']);
    expect(formFieldsFor('repo')!.map((f) => f.key)).toEqual(['space', 'dir', 'origin', 'note']);
    expect(formFieldsFor('role')).toBeNull();
  });

  /**
   * v14 A5-1：`skill` 自此有表单长法了。钉两件事：
   *  ①**所属项目是 select**（作用域是这一枚 spec 的立命之本，让人手打项目 id 就是等错账）；
   *  ②**文档路径是 text 而非 select**——候选只是 datalist，登记一篇「还没进项目清单」的新技能
   *    必须是可达路径（先立账后写文），把候选收成白名单就等于把这条路堵死。
   */
  it('skill 三键：space 选项目（options=spaces）、file 是自由文本带候选（list=space-docs）', () => {
    expect(formFieldsFor('skill')!.map((f) => f.key)).toEqual(['space', 'file', 'note']);
    const space = formFieldsFor('skill')!.find((f) => f.key === 'space')!;
    expect(space).toMatchObject({ type: 'select', required: true, options: 'spaces' });
    expect(formFieldsFor('skill')!.find((f) => f.key === 'file')).toMatchObject({
      type: 'text',
      required: true,
      list: 'space-docs',
    });
    // model 那两枚老候选键也一并挂号——同一条「能选不打」的路，不再各写各的
    expect(formFieldsFor('model')!.find((f) => f.key === 'model')).toMatchObject({ list: 'models' });
    expect(formFieldsFor('model')!.find((f) => f.key === 'gatewayProfile')).toMatchObject({ options: 'gateway-profiles' });
  });

  /**
   * v14 A5-2：`rule` 的表单长法。钉的是「作用域那两枚可选键怎么进来」：
   *  ①`file` 与 skill 共用同一个候选池（`space-docs`）——候选问的是「这个根下有哪些文档路径」，
   *    不问登记成哪一类，另起一个 `rule-files` 池就是逼同一篇文档在两个清单里各登记一次；
   *  ②`repo` 的候选是**已登记的仓库目录名**（`space-repos`），但仍是 text 不是 select——目录可以
   *    还没进 `repos[]`（先克隆后登记是常态），收成白名单就把这条路堵死了。
   */
  it('rule 五键：space 选项目、file 与 repo 各自带候选（space-docs / space-repos）、pathsGlob 原样存', () => {
    expect(formFieldsFor('rule')!.map((f) => f.key)).toEqual(['space', 'file', 'repo', 'pathsGlob', 'note']);
    expect(formFieldsFor('rule')!.find((f) => f.key === 'space')).toMatchObject({ type: 'select', required: true });
    expect(formFieldsFor('rule')!.find((f) => f.key === 'file')).toMatchObject({ type: 'text', required: true, list: 'space-docs' });
    expect(formFieldsFor('rule')!.find((f) => f.key === 'repo')).toMatchObject({ type: 'text', list: 'space-repos' });
    expect(formFieldsFor('rule')!.find((f) => f.key === 'pathsGlob')).toMatchObject({ type: 'text' });
    // 必填只有两枚：作用域是可选收窄，把 repo 当必填就会逼出「为了登记而先登记仓」的空动作
    expect(missingRequiredFields('rule', 'x', { space: 'demo' })).toEqual(['文档路径']);
    expect(missingRequiredFields('rule', 'x', { space: 'demo', file: ' docs/x.md ' })).toEqual([]);
  });

  /**
   * v14 A5-3：`repo` 的表单长法。这一格要钉的是**两枚标识分开放**：
   *  ①`dir`（相对项目根的目录名，`repos[]`／作用域收窄／家规三处写的都是它）必填，候选来自档案
   *    已登记的 `repos[]`——但仍是 text 不是 select，理由与 `rule.repo` 同一条：先克隆后登记是常态；
   *  ②`origin`（`owner/repo` 或完整 remote URL，派活时 `--repo` 认的就是它）选填。
   * 把两枚塞进一个框，`repos[]` 那套引用或 `--repo` 那套引用就会有一半从此指不到条目。
   */
  it('repo 四键：dir 必填带 space-repos 候选、origin 选填（两套命名空间各占一格）', () => {
    expect(formFieldsFor('repo')!.find((f) => f.key === 'space')).toMatchObject({ type: 'select', required: true, options: 'spaces' });
    expect(formFieldsFor('repo')!.find((f) => f.key === 'dir')).toMatchObject({ type: 'text', required: true, list: 'space-repos' });
    expect(formFieldsFor('repo')!.find((f) => f.key === 'origin')).toMatchObject({ type: 'text' });
    expect(missingRequiredFields('repo', 'x', { space: 'demo' })).toEqual(['仓库目录']);
    expect(missingRequiredFields('repo', 'x', { space: 'demo', dir: 'packages/web' })).toEqual([]);
  });

  it('missingRequiredFields 只问必填：没填名字与型号时报出中文名', () => {
    expect(missingRequiredFields('model', '', {})).toEqual(['显示名', '型号']);
    expect(missingRequiredFields('model', ' 甲 ', { model: 'gpt-4o' })).toEqual([]);
    expect(missingRequiredFields('skill', 'x', { space: 'demo' })).toEqual(['文档路径']);
  });

  it('buildRegistryPayload：可选键空了整键不发（宁缺键不空键），只会长出 spec 四键里的', () => {
    const p = buildRegistryPayload('model', ' 甲 ', {
      model: ' gpt-4o ',
      gatewayProfile: '   ',
      freeModel: false,
      note: '',
    });
    expect(p).toEqual({ kind: 'model', name: '甲', spec: { model: 'gpt-4o' } });
    const full = buildRegistryPayload('model', '甲', {
      model: 'gpt-4o',
      gatewayProfile: 'p-main',
      freeModel: true,
      note: '留作对照',
    });
    expect(full!.spec).toEqual({ model: 'gpt-4o', gatewayProfile: 'p-main', freeModel: true, note: '留作对照' });
    expect(Object.keys(full!.spec)).toEqual(['model', 'gatewayProfile', 'freeModel', 'note']);
  });

  it('必填没填时拒组装（返回 null），未知 kind 也拒（不猜形状）', () => {
    expect(buildRegistryPayload('model', '甲', { model: '  ' })).toBeNull();
    expect(buildRegistryPayload('rule', '甲', {})).toBeNull();
    // `role` 是 A5-4 那一棒的替身（今天还没进表）：不猜形状就不该长出任何 spec 键
    expect(buildRegistryPayload('role', '甲', { dir: 'x' })).toBeNull();
  });

  /** A5-1：skill 的组装只可能长出 `{space,file,note?}` 那一形状（多一发就是 server 400） */
  it('buildRegistryPayload(skill)：note 空则整键不发，填了才跟着走', () => {
    expect(buildRegistryPayload('skill', 'x', { space: ' demo ', file: ' skills/x/SKILL.md ', note: '  ' })).toEqual({
      kind: 'skill',
      name: 'x',
      spec: { space: 'demo', file: 'skills/x/SKILL.md' },
    });
    expect(buildRegistryPayload('skill', 'x', { space: 'demo', file: 'a.md', note: '还没写正文' })!.spec).toEqual({
      space: 'demo',
      file: 'a.md',
      note: '还没写正文',
    });
    expect(buildRegistryPayload('skill', 'x', { space: '', file: 'a.md' })).toBeNull();
  });

  /**
   * v14 A5-2：rule 的组装只可能长出 `{space,file,repo?,pathsGlob?,note?}`。这里额外钉的是
   * 作用域两枚可选键的**原样**语义：pathsGlob 前端不展开也不改写（展开的判据住在 `rules.ts`），
   * 传过去是什么就是什么——在这儿顺手「规范化」一下，就等于在 web 造了第二把尺。
   */
  it('buildRegistryPayload(rule)：作用域键空了整键不发；pathsGlob 原样透传', () => {
    expect(buildRegistryPayload('rule', 'x', { space: ' demo ', file: ' docs/a.md ', repo: '', pathsGlob: '   ' })).toEqual({
      kind: 'rule',
      name: 'x',
      spec: { space: 'demo', file: 'docs/a.md' },
    });
    expect(
      buildRegistryPayload('rule', 'x', { space: 'demo', file: 'a.md', repo: 'packages/web', pathsGlob: 'src/**', note: '只守前端' })!.spec,
    ).toEqual({ space: 'demo', file: 'a.md', repo: 'packages/web', pathsGlob: 'src/**', note: '只守前端' });
    expect(buildRegistryPayload('rule', 'x', { space: 'demo', file: '' })).toBeNull();
  });

  /**
   * v14 A5-3：repo 的组装只可能长出 `{space,dir,origin?,note?}`。这里钉的是 `origin` 的
   * **原样**语义：完整 remote URL 不在前端剪成 `owner/repo`——归一只有 server 那一把尺
   * （`parseGithubRemote`），这里顺手剪一下就是第二处判据，两处迟早给出两个答案。
   */
  it('buildRegistryPayload(repo)：origin 原样透传（不剪 URL），空了整键不发', () => {
    expect(buildRegistryPayload('repo', 'x', { space: ' demo ', dir: ' packages/web ', origin: '', note: '  ' })).toEqual({
      kind: 'repo',
      name: 'x',
      spec: { space: 'demo', dir: 'packages/web' },
    });
    expect(
      buildRegistryPayload('repo', 'x', {
        space: 'demo',
        dir: 'packages/web',
        origin: 'https://github.com/my-org/web.git',
        note: '前端仓',
      })!.spec,
    ).toEqual({ space: 'demo', dir: 'packages/web', origin: 'https://github.com/my-org/web.git', note: '前端仓' });
    expect(buildRegistryPayload('repo', 'x', { space: 'demo', dir: '' })).toBeNull();
  });

  /** v14-T4：`mcp` 是第二类可登记 kind——表单长三键，但**只登记不探测**（没有健康点那一格） */
  it('mcp 长出三键且 command 必填；args 空了整键不发', () => {
    expect(formFieldsFor('mcp')!.map((f) => f.key)).toEqual(['command', 'args', 'note']);
    expect(missingRequiredFields('mcp', '', {})).toEqual(['显示名', '启动命令']);
    expect(buildRegistryPayload('mcp', ' 文件服务 ', { command: ' npx ', args: '   ', note: '' })).toEqual({
      kind: 'mcp',
      name: '文件服务',
      spec: { command: 'npx' },
    });
    expect(buildRegistryPayload('mcp', '甲', { command: '' })).toBeNull();
    // 出厂清单类（视图 kind）不进下拉：选了也登记不了，那是假可点。
    // 名单本身由 server 的 `knownKinds` 给（web 不抄表），A5-3 起 model/skill/rule/repo/mcp 都在登记侧占格
    expect(
      registrableKinds(['model', 'skill', 'rule', 'repo', 'agent-kind', 'node-type', 'mcp'], ['agent-kind', 'node-type']),
    ).toEqual(['model', 'skill', 'rule', 'repo', 'mcp']);
  });
});

/**
 * v14 A5-1/A5-2 的候选来源：路径候选只能从**项目档案实读回来的字段**里并（skills / conventionFiles /
 * rules[].file 三源），web 不猜文件名也不扫盘——猜来的候选会让人登记一篇本机根本没有的文档。
 * 候选池按「这个根下有哪些文档」算，不按登记类别算，所以 `skill` 与 `rule` 共用它。
 */
describe('v14 A5-1 spaceDocCandidates（登记表单的路径候选）', () => {
  it('三源并集 + 去空去重 + 排序（稳定顺序，不随档案键序抖）', () => {
    const got = spaceDocCandidates(
      [
        { id: 'demo', skills: ['skills/b/SKILL.md', ' docs/a.md ', 'skills/b/SKILL.md'], conventionFiles: ['AGENTS.md'] },
        { id: 'other', rules: [{ file: 'docs/rule.md' }] },
      ],
      'demo',
    );
    expect(got).toEqual(['AGENTS.md', 'docs/a.md', 'skills/b/SKILL.md']);
    // 三源都在账上：约定文档与目录规则的路径同样是「这台机器上真有一篇文档」的出处；
    // 只关联了仓库、没写文档路径的那条规则不贡献候选（它没有路径可候选）
    expect(
      spaceDocCandidates(
        [{ id: 'demo', conventionFiles: ['AGENTS.md'], rules: [{ file: 'docs/rule.md' }, {}] }],
        'demo',
      ),
    ).toEqual(['AGENTS.md', 'docs/rule.md']);
    // 只给所选项目的：别家的路径不是这一枚的候选
    expect(spaceDocCandidates([{ id: 'other', skills: ['z.md'] }], 'demo')).toEqual([]);
  });

  it('没选项目 / 项目不在册 / 档案一个字段都没配 → 空数组（表单据此说「还没有候选，路径仍可直填」）', () => {
    expect(spaceDocCandidates([{ id: 'demo', skills: ['a.md'] }], '')).toEqual([]);
    expect(spaceDocCandidates([{ id: 'demo', skills: ['a.md'] }], 'ghost')).toEqual([]);
    expect(spaceDocCandidates([{ id: 'demo' }], 'demo')).toEqual([]);
    expect(spaceDocCandidates([], 'demo')).toEqual([]);
  });
});

/**
 * v14 A5-2/A5-3：仓库目录名候选只吃档案里的 `repos[]`（那是这个空间**已登记**的目录名）。
 * 两个使用方共用它：`rule.spec.repo`（作用域收窄）与 `repo.spec.dir`（登记一枚仓本身）。
 * 档案没配 repos 时给空数组——表单据此说「直接填目录名即可」，绝不拿目录扫盘或猜一个。
 */
describe('v14 A5-2/A5-3 spaceRepoCandidates（规则作用域与仓库登记的目录候选）', () => {
  it('去空去重排序；没配 repos 的档案给空数组', () => {
    expect(
      spaceRepoCandidates([{ id: 'demo', repos: ['packages/web', ' packages/web ', 'packages/server', ''] }], 'demo'),
    ).toEqual(['packages/server', 'packages/web']);
    expect(spaceRepoCandidates([{ id: 'demo', skills: ['a.md'] }], 'demo')).toEqual([]);
    expect(spaceRepoCandidates([{ id: 'other', repos: ['x'] }], 'demo')).toEqual([]);
  });
});

describe('v14-X1 只读 spec 与前向兼容读数', () => {
  it('spec 渲成 标签→值 的行数组（不是可编辑文本团），布尔给 是/否，未知键原样挂出', () => {
    const rows = specRows({ model: 'gpt-4o', freeModel: true, custom: 7 });
    expect(rows).toEqual([
      { key: 'model', label: '型号', text: 'gpt-4o' },
      { key: 'freeModel', label: '免费位', text: '是' },
      { key: 'custom', label: 'custom', text: '7' },
    ]);
    expect(specRows('怪形状')[0]!.text).toBe('怪形状');
    // A5-3：`dir` 与 `origin` 各有各的中文名——两枚混成一个标签，详情里就看不出这枚条目说的是本地目录还是远端仓
    expect(specRows({ space: 'demo', dir: 'packages/web', origin: 'my-org/web' })).toEqual([
      { key: 'space', label: '所属项目', text: 'demo' },
      { key: 'dir', label: '仓库目录', text: 'packages/web' },
      { key: 'origin', label: '远端仓', text: 'my-org/web' },
    ]);
    // A5-4：spec 里的第一枚布尔。布尔渲染成「是/否」是这里既有的口径，但**列名必须是人话**——
    // 详情里画一行 `machine: false` 等于把 server 的字段名当措辞甩给用户。
    expect(specRows({ label: '人工确认', hint: '引擎不判', machine: false })).toEqual([
      { key: 'label', label: '显示名', text: '人工确认' },
      { key: 'hint', label: '说明', text: '引擎不判' },
      { key: 'machine', label: '引擎实跑', text: '否' },
    ]);
  });

  it('refs：键不在就什么都不画——缺 ≠ 0（引用账没读出来不是「没人用」）', () => {
    expect(refCountOf(entry())).toBeNull();
    // 引用者形状与 server 的 RegistryReferrer 一致（face/id/name/via），别拿假形状喂测试
    expect(refCountOf(entry({ refs: [{ face: 'gateway', id: 'p-free', name: '免费档', via: 'freeModel' }] } as never))).toBe(1);
    expect(refCountOf(entry({ refs: 3 } as never))).toBe(3);
    expect(refCountOf(entry({ refs: null } as never))).toBeNull();
  });

  it('R4 三态：live 绿 / missing 红 / 其余一律灰，没读数就不画——探不通绝不并成「不在」', () => {
    expect(healthDot(undefined)).toBeNull();
    expect(healthDot({ status: 'live', detail: '在清单里' })).toBe('ok');
    expect(healthDot({ status: 'missing', detail: '清单里没有' })).toBe('bad');
    expect(healthDot({ status: 'unknown', detail: 'HTTP 503' })).toBe('unknown');
    // server 日后加一枚枚举值：落灰、原样，不就近并进红点（那等于替人判死）
    expect(healthDot({ status: 'degraded', detail: '' })).toBe('unknown');
    expect(healthTitle(undefined)).toBeUndefined();
    expect(healthTitle({ status: 'unknown', detail: '未探得：「档」HTTP 503' })).toBe('未探得：「档」HTTP 503');
    expect(healthTitle({ status: 'live', detail: '在', cached: true })).toBe('在（缓存读数）');
    expect(healthTitle({ status: 'missing', detail: '  ' })).toBe('状态「missing」（server 没给解释）');
  });

  it('healthIndex：没有探针通道的 kind 整键不给 → 表上天然没有点（不是画成灰点）', () => {
    const res = {
      at: '2026-09-26T12:00:00.000Z',
      entries: [
        { id: 'model:a', health: { status: 'live', detail: '在', at: 'x', cached: false } },
        { id: 'role:r-x' },
      ],
      dangling: [],
    } as never;
    const idx = healthIndex(res);
    expect(healthDot(idx.get('model:a'))).toBe('ok');
    expect(idx.has('role:r-x')).toBe(false);
    expect(healthDot(idx.get('role:r-x'))).toBeNull();
  });

  it('时间戳：能读则读成人话，读不出原样挂出，空才是空', () => {
    expect(formatWhen('2026-09-01T08:00:00.000Z')).toMatch(/^2026-09-0\d \d{2}:\d{2}$/);
    expect(formatWhen('不是时间')).toBe('不是时间');
    expect(formatWhen(undefined)).toBe('');
  });
});

/**
 * v14-T3 模板卡上那一行「需要：…」。四态各有归宿，混一件就是假账：
 * 命中 ✓ / 缺口 ✗ / 还判不了 ? / 预检没读出 …（绝不画 ✓）/ 没带槽 什么都不画。
 */
describe('requirementBadge / requirementDetail（能力槽读数排版）', () => {
  const row = (over: Partial<RegistryCheckRow> = {}): RegistryCheckRow => ({
    template: 'flow',
    slots: [{ kind: 'model', id: 'gpt-4o-mini', verdict: 'ok', why: '用「小4号」' }],
    need: [{ kind: 'model', label: '模型', declared: 1, judged: 1, gaps: 0 }],
    missing: [],
    unjudged: [],
    malformed: [],
    ok: true,
    ...over,
  });

  it('命中画 ✓、缺口画 ✗：文案吃 server 的分组计数，前端不自己数', () => {
    expect(requirementBadge(row(), 1)).toEqual({ text: '需要：模型 1', tone: 'ok' });
    expect(
      requirementBadge(
        row({
          ok: false,
          // 「判不了的那一组」今天只能用 `role` 喂（`repo` 自 A5-3 起有探针、有判定，`judged: 0` 是它发不出的读数）
          need: [
            { kind: 'model', label: '模型', declared: 1, judged: 1, gaps: 1 },
            { kind: 'role', label: '角色', declared: 2, judged: 0, gaps: 0 },
          ],
        }),
        3,
      ),
    ).toEqual({ text: '需要：模型 1 · 角色 2', tone: 'gap' });
  });

  it('整组都判不了 = pending（画问号）：它既不是缺口也不是命中，红绿都不对', () => {
    const r = row({
      slots: [{ kind: 'role', id: 'r-deliver', verdict: 'unjudged', why: '还没迁进注册表' }],
      need: [{ kind: 'role', label: '角色', declared: 1, judged: 0, gaps: 0 }],
      unjudged: [{ kind: 'role', id: 'r-deliver', verdict: 'unjudged', why: '还没迁进注册表' }],
    });
    expect(requirementBadge(r, 1).tone).toBe('pending');
    // 一半命中一半判不了 → 按命中说（有真读数就别挂问号）
    expect(requirementBadge({ ...r, slots: [...r.slots, { kind: 'model', verdict: 'ok', why: '用「小4号」' }] }, 2).tone).toBe('ok');
  });

  it('预检没读出不冒充 ✓：模板自己说了要几项，就当「不知道」明说', () => {
    expect(requirementBadge(undefined, 2)).toEqual({ text: '需要 2 项 · 预检没读出', tone: 'unknown' });
    expect(requirementBadge(undefined, 0)).toEqual({ text: '', tone: 'none' }); // 没声明也没读数：这一格不画
  });

  it('slots 空数组是正读数「没带槽」，与「预检没读出」（row undefined）分家', () => {
    expect(requirementBadge(row({ slots: [], need: [] }), 0)).toEqual({
      text: '没带能力槽',
      tone: 'none',
    });
  });

  it('detail 一行一槽：✓/✗/?/⚠ 四种标记 + server 的缺因原文；认不出的 verdict 原样画不猜标记', () => {
    const detail = requirementDetail(
      row({
        slots: [
          { kind: 'model', id: 'gpt-4o-mini', verdict: 'ok', why: '用「小4号」' },
          { kind: 'model', id: 'gpt-9', verdict: 'missing', why: '注册表里没有' },
          { kind: 'role', verdict: 'unjudged', why: '这一类还判不了' },
          { kind: 'model', verdict: 'malformed', why: '声明形状不认' },
          { kind: 'model', verdict: 'probed-elsewhere', why: '未来新值' },
        ],
      }),
    );
    expect(detail.split('\n')).toEqual([
      '✓ model → gpt-4o-mini：用「小4号」',
      '✗ model → gpt-9：注册表里没有',
      '? role：这一类还判不了',
      '⚠ model：声明形状不认',
      'probed-elsewhere model：未来新值',
    ]);
  });
});

describe('v14-A3-2 内置清单视图项的消费面（只认 server 给的 view 标，不拿 source 猜）', () => {
  const viewEntry = (over: Partial<RegistryEntryView> = {}): RegistryEntryView =>
    entry({ id: 'agent-kind:pi', kind: 'agent-kind' as never, name: 'pi', source: 'builtin', view: true, ...over });

  it('条目级：view 是 server 的读数；缺键（旧 server）按可写条目渲染', () => {
    expect(isViewEntry(viewEntry())).toBe(true);
    expect(isViewEntry(entry())).toBe(false);
    // source 是出处、view 是可写性：拿 builtin 推「不可删」会把未来的 discovered 出厂项一起判死
    expect(isViewEntry(entry({ source: 'builtin' }))).toBe(false);
  });

  it('分组级：出厂那一组整组标 view，且以 server 的 viewKinds 为准（空组也说清「不用登记」）', () => {
    const groups = groupEntriesByKind([viewEntry()], ['model', 'agent-kind'], ['agent-kind'], {
      model: '模型',
      'agent-kind': 'Agent 引擎',
    });
    expect(groups.map((g) => [g.kind, g.view, g.label])).toEqual([
      ['model', false, '模型'],
      ['agent-kind', true, 'Agent 引擎'],
    ]);
    // 出厂组一枚货都没探到时仍立牌并说明——不能因为它空就当普通空组劝人来登记
    const empty = groupEntriesByKind([], ['agent-kind'], ['agent-kind'], { 'agent-kind': 'Agent 引擎' });
    expect(empty[0]).toMatchObject({ view: true, entries: [] });
  });

  it('登记下拉里不挂出厂 kind：挂上去就是「点开却登记不了」的假可点', () => {
    expect(registrableKinds(['model', 'agent-kind'], ['agent-kind'])).toEqual(['model']);
    expect(registrableKinds(['model', 'agent-kind'])).toEqual(['model', 'agent-kind']); // 旧 server 缺键：不猜
  });

  it('两枚时刻的表头分家：出厂项没有登记时刻，说「登记于」是假话', () => {
    expect(whenLabels(false)).toMatchObject({ created: '登记于', updated: '改于', note: '' });
    expect(whenLabels(true).created).not.toContain('登记');
    expect(whenLabels(true).note).toContain('版本自带');
  });
});

/**
 * v14-X1 全量第一件：详情抽屉里的「引用者清单」。
 * web 只把 server 随条目发下的 `refs` 排版成人话，零判据：`face` 原样画（中文对照表住在
 * server 的 400 文案里，这里再抄一份就是两张表——CLI 同一把尺）。
 */
describe('refRows / refNote（引用者清单：缺、空、有货是三件事）', () => {
  const withRefs = (refs: unknown) => entry({ refs } as never);

  it('逐条出处：face · 「名字」（id） · via 三段，与 CLI registry refs 同一份账', () => {
    const rows = refRows(
      withRefs([
        { face: 'gateway', id: 'p-free', name: '免费档', via: 'freeModel' },
        { face: 'role', id: 'r-deliver', name: '交付岗', via: 'model' },
      ]),
    )!;
    expect(rows.map((r) => r.text)).toEqual([
      'gateway · 「免费档」（p-free） · freeModel',
      'role · 「交付岗」（r-deliver） · model',
    ]);
    // key 稳定且逐行不同（React 列表不能拿文案当 key：两条同出处是合法读数）
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('引用者字段缺谁就不画谁，形状不认也不吞：整行仍在，条数照实', () => {
    const rows = refRows(withRefs([{ face: 'template' }, { via: 'x' }, null]))!;
    expect(rows.map((r) => r.text)).toEqual(['template', '（出处形状不认） · x', '（出处形状不认）']);
    expect(refNote(entry(), rows)).toBe('被 3 处引用——删除/停用时 server 会拿这份清单拒你。');
  });

  it('缺键 vs 空数组：一个是「没扫出来」（绝不给删除开绿灯），一个是正读数「没人用」', () => {
    expect(refRows(entry())).toBeNull();
    expect(refNote(entry(), null)).toContain('不是「没人用」');
    expect(refNote(entry(), [])).toContain('没人用（这是正读数');
    // 数值型 refs（server 只给计数的日子）不是数组 → 清单不画，但 count 那一格照读
    expect(refRows(withRefs(3))).toBeNull();
    expect(refCountOf(withRefs(3))).toBe(3);
  });
});

/**
 * v14-X1 全量第二件：行内「探一次」的回执文案。
 * 四种读数四句话，健康那一格只吃 `health`，这里补它说不出来的三件事。
 */
describe('probeNote（单枚探针回执：失败 / 无通道 / 有读数 分得开）', () => {
  const res = (over: Partial<RegistryProbeResponse> = {}): RegistryProbeResponse => ({
    at: '2026-09-26T12:00:00.000Z',
    entry: entry(),
    ...over,
  });

  it('没点过不画占位；请求失败原话挂出（失败优先于读数——两样都在时报的是那件坏消息）', () => {
    expect(probeNote(undefined, null)).toBe('');
    expect(probeNote(res(), '网关 503')).toBe('探针没回话：网关 503');
    expect(probeNote(undefined, '网络断了')).toBe('探针没回话：网络断了');
  });

  it('回了却没 health 键 = 这一类没有探针通道，不是「不健康」（拿它画灰点是替人判死）', () => {
    const note = probeNote(res(), null);
    expect(note).toContain('没有探针通道');
    // 通道缺失不等于读数缺失：这里不硬造 status，健康那一格因此天然不画
    expect(res().health).toBeUndefined();
    expect(healthDot(res().health)).toBeNull();
  });

  it('有读数时只说「刚探过」并把人话留在上一格（同一段话不贴两遍）；时刻读不出原样挂', () => {
    const note = probeNote(res({ health: { status: 'live', detail: '在清单里' } }), null);
    expect(note).toContain('刚探过一次');
    expect(note).toContain('读数见上一格');
    expect(note).not.toContain('在清单里');
    expect(note).toMatch(/2026-09-2\d/);
    expect(probeNote(res({ at: '不是时间', health: { status: 'unknown', detail: '' } }), null)).toContain('不是时间');
  });
});
