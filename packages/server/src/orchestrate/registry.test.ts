import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeRegistryEntry,
  DAG_NODE_TYPES,
  NODE_TYPE_CATALOG,
  NODE_TYPE_GROUPS,
  parseNodeTypeSpec,
  parseMcpSpec,
  parseRepoSpec,
  parseRuleSpec,
  parseSkillSpec,
  REGISTRY_KINDS,
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_VIEW_KINDS,
  registryId,
  splitRegistryId,
  parseAgentKindSpec,
  parseModelSpec,
  parseRegistrySpec,
  type RegistryEntry,
} from '@paneflow/shared';
import { AGENT_KINDS } from '../api/agent-kinds.js';
import { entryHealth } from '../api/registry-health.js';
import { REGISTRY_DESCRIPTORS } from './registry-descriptors.js';
import { requirementKindLabel } from './registry-check.js';
import { matchesTarget, buildReferenceIndex, type RawReference } from './registry-refs.js';
import { detectAppVersion, RegistryStore } from './registry.js';

/**
 * v14 A1（R1）注册内核判据单测：信封清洗（shared）+ 落盘层姿态（server）各占一半——
 * 两侧共用同一份 `normalizeRegistryEntry`，所以这里红一条就等于两面同时红（§十.4「只可能有一份口径」）。
 *
 * 三条最容易在实施时被洗掉的姿态，各有专测：
 *  1. 空表是**正读数**（没登记过 ≠ 坏了），但盘读不出**绝不**渲成空表；
 *  2. 版本戳只拒**高于**本版认识的（等号放行），且拒的文案要能让人行动（指名谁写的、怎么回滚）；
 *  3. id 由 name 确定性推出（随机值=同一件事登记两次得到两条账，E2 一次事务登记就此失去幂等）。
 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-registry-'));
const storeAt = (dir: string): RegistryStore => new RegistryStore(dir);
const MODEL = { kind: 'model', name: 'gpt-4o-mini', spec: { model: 'gpt-4o-mini', gatewayProfile: 'free' } };

describe('注册条目清洗 normalizeRegistryEntry（§十.3/§十.4/§十.6）', () => {
  it('name 缺 id：按 <kind>:<slug> 生成，source/enabled/时间戳由服务端补齐', () => {
    const r = normalizeRegistryEntry(MODEL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('model:gpt-4o-mini');
    expect(r.value.source).toBe('user');
    expect(r.value.enabled).toBe(true);
    expect(Date.parse(r.value.createdAt)).not.toBeNaN();
  });

  it('中文名回落确定性散列 id，且同一名字两次算得同一枚（E2 幂等地基）', () => {
    const a = registryId('model', '免费小模型');
    expect(a.startsWith('model:u')).toBe(true);
    expect(a).toBe(registryId('model', ' 免费小模型 '));
    expect(splitRegistryId(a)).toEqual({ kind: 'model', slug: a.slice(6) });
  });

  it('未知 kind → 整条不认，文案当场列出这版认识哪些', () => {
    const r = normalizeRegistryEntry({ kind: 'plugin', name: 'x', spec: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toContain('不认的能力类型「plugin」');
    expect(r.why).toContain('model');
  });

  it('spec 未知键即拒（拼错的 gatewayProfile 会静默失效，宁拒不错放）', () => {
    expect(parseModelSpec({ model: 'm', gatewayProfilee: 'free' }).ok).toBe(false);
    const r = parseRegistrySpec('model', { model: 'm', freeModel: 'yes' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toContain('freeModel 必须是布尔值');
  });

  it('id 前缀与 kind 不一致 → 拒（id 是历史引用的锚，不许自说自话）', () => {
    const r = normalizeRegistryEntry({ ...MODEL, id: 'skill:gpt-4o-mini' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toContain('kind 前缀');
  });

  it('enabled 只认布尔：null/0 不拿来冒充 false（三态里没有「不知道」这一档）', () => {
    expect(normalizeRegistryEntry({ ...MODEL, enabled: null }).ok).toBe(false);
    expect(normalizeRegistryEntry({ ...MODEL, enabled: false }).ok).toBe(true);
  });
});

describe('RegistryStore 落盘姿态（§十.1/§十.2）', () => {
  it('没登记过：空表是正读数，且不落任何文件（读操作不写盘）', () => {
    const dir = tmp();
    const store = new RegistryStore(dir, '9.9.9');
    expect(store.load()).toEqual({ entries: [], rejected: [] });
    expect(store.readSchema()).toBeNull();
    expect(fs.existsSync(path.join(dir, 'registry'))).toBe(false);
  });

  it('首次写入补版本戳（含 writtenBy），此后 add 幂等失败于 id 冲突', () => {
    const dir = tmp();
    const store = new RegistryStore(dir, '0.3.0-test');
    const first = store.add(MODEL);
    expect(first.ok).toBe(true);
    expect(store.readSchema()).toEqual({ version: REGISTRY_SCHEMA_VERSION, writtenBy: '0.3.0-test' });
    const second = store.add(MODEL);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.why).toContain('已存在');
    expect(store.list('model')).toHaveLength(1);
  });

  it('writtenBy 拿不到版本＝整键不写，不拿 dev 冒充读数', () => {
    const dir = tmp();
    storeAt(dir).add(MODEL);
    expect(fs.existsSync(path.join(dir, 'registry', 'entries.json'))).toBe(true);
    expect(storeAt(dir).readSchema()).toEqual({ version: REGISTRY_SCHEMA_VERSION });
  });

  it('版本戳高于本版 → 三个写动词全拒（schemaTooNew），读端照读不炸', () => {
    const dir = tmp();
    const store = new RegistryStore(dir, '0.3.0-test');
    store.add(MODEL);
    fs.writeFileSync(path.join(dir, 'registry', 'schema.json'), `${JSON.stringify({ version: 99, writtenBy: '9.0.0' })}\n`);
    const gate = RegistryStore.assertSchemaOk(store.readSchema());
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.schemaTooNew).toBe(true);
    expect(gate.why).toContain('9.0.0');
    expect(gate.why).toContain('还原整个 registry/ 目录快照');
    expect(store.add({ kind: 'model', name: 'other', spec: { model: 'other' } }).ok).toBe(false);
    expect(store.update('model:gpt-4o-mini', { enabled: false }).ok).toBe(false);
    expect(store.remove('model:gpt-4o-mini').ok).toBe(false);
    expect(store.list('model')).toHaveLength(1);
  });

  it('版本戳等于本版 → 放行（拒的是「更高」，不是「有戳」）', () => {
    expect(RegistryStore.assertSchemaOk({ version: REGISTRY_SCHEMA_VERSION, writtenBy: '0.2.0' }).ok).toBe(true);
  });

  it('戳文件脏成读不出 = null（不知道），不当成版本 0 也不当成版本 99', () => {
    const dir = tmp();
    const store = new RegistryStore(dir);
    store.add(MODEL);
    fs.writeFileSync(path.join(dir, 'registry', 'schema.json'), 'not json');
    expect(store.readSchema()).toBeNull();
    expect(RegistryStore.assertSchemaOk(null).ok).toBe(true);
  });

  it('表文件读不出 = 抛，不渲空表；单条脏 = 进 rejected 只披露，其余照给', () => {
    const dir = tmp();
    const store = new RegistryStore(dir);
    store.add(MODEL);
    fs.writeFileSync(path.join(dir, 'registry', 'entries.json'), '{"entries": 坏');
    expect(() => store.load()).toThrow(/注册表读不出/);
    fs.writeFileSync(
      path.join(dir, 'registry', 'entries.json'),
      `${JSON.stringify({ entries: [MODEL, { kind: 'plugin', name: 'x', spec: {} }, { id: 'model:ok-2', kind: 'model', name: 'ok-2', spec: { model: 'ok-2' } }] })}\n`,
    );
    const snap = store.load();
    expect(snap.entries.map((e) => e.id)).toEqual(['model:gpt-4o-mini', 'model:ok-2']);
    expect(snap.rejected).toHaveLength(1);
    expect(snap.rejected[0]!.id).toBe('plugin:x');
    expect(snap.rejected[0]!.why).toContain('不认的能力类型');
  });

  it('rejected 里连 id 都读不出的条目也有名有姓（第几条），不渲成无名氏', () => {
    const dir = tmp();
    const store = new RegistryStore(dir);
    fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'registry', 'entries.json'), `${JSON.stringify({ entries: [42] })}\n`);
    expect(store.load().rejected[0]!.id).toBe('entries[0]');
  });

  it('update 只认三键：未知键拒、找不到拒、改 spec 生效且 createdAt 不动', () => {
    const dir = tmp();
    const store = new RegistryStore(dir);
    store.add(MODEL);
    const before = store.get('model:gpt-4o-mini')!;
    expect(store.update('model:gpt-4o-mini', { enable: false }).ok).toBe(false);
    expect(store.update('model:nope', { enabled: false }).ok).toBe(false);
    const r = store.update('model:gpt-4o-mini', { spec: { model: 'gpt-4o' }, enabled: false });
    expect(r.ok).toBe(true);
    const after = store.get('model:gpt-4o-mini')!;
    expect(after.spec).toEqual({ model: 'gpt-4o' });
    expect(after.enabled).toBe(false);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.id).toBe(before.id);
  });

  it('remove 找不到=失败读数（不静默成功），删掉后 list 少一条', () => {
    const dir = tmp();
    const store = new RegistryStore(dir);
    store.add(MODEL);
    expect(store.remove('model:nope').ok).toBe(false);
    expect(store.remove('model:gpt-4o-mini').ok).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('detectAppVersion 向上找到本仓根清单（三种落点里最难的一种：源码跑）', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'paneflow', version: '1.2.3' })}\n`);
    expect(detectAppVersion(path.join(dir, 'lib', 'nested'))).toBe('1.2.3');
    expect(detectAppVersion(path.join(os.tmpdir(), 'no-such-pkg-dir-xyz'))).toBeUndefined();
  });
});

/**
 * v14 A3-2（R3）视图 kind：`agent-kind` 的条目由出厂清单**现算**，盘上永远没有它们。
 * （T1 起了第二枚视图 kind `node-type`，同一套姿态在下一格里对节点清单再钉一遍。）
 *
 * 三条最容易在实施时被洗掉的姿态，各有专测：
 *  1. **只读**——`readView()` 合进来的条目一个字节都不落盘（落了就是台账里多一份「本机有哪些 agent」，
 *     而真正决定能不能起 agent 的是代码那张表）；
 *  2. **视图赢**——手塞进 `entries.json` 的 `agent-kind` 那条不生效，且要出现在 `rejected` 里说清为什么
 *     （静默吞掉就是「盘上明明有、表上看不见」那种查三天的账）；
 *  3. **写入面拒**——`add`/`update`/`remove` 三动词对视图 kind 全关（不拒就等于给用户造一个不生效的假开关）。
 */
describe('v14 A3-2 视图条目 readView（出厂清单现算，不落盘）', () => {
  /** 按 kind 取格：视图 kind 会一批批加进来（T1 加了 node-type），拿 `view.entries` 总数下断言的账每迁一类都要改一次 */
  const ofKind = (entries: RegistryEntry[], kind: string): RegistryEntry[] => entries.filter((e) => e.kind === kind);

  it('agent-kind 的 spec 形状：只认 binary 一键，且必须非空', () => {
    expect(parseAgentKindSpec({ binary: 'pi' })).toEqual({ ok: true, value: { binary: 'pi' } });
    // 拼错的键会静默失效（读端永远读不到它）——宁拒不错放
    const unknown = parseAgentKindSpec({ binary: 'pi', bin: 'p' });
    if (unknown.ok) throw new Error('未知键竟然被认下了');
    expect(unknown.why).toContain('未知键 bin');
    expect(parseAgentKindSpec({ binary: '  ' }).ok).toBe(false);
    expect(parseAgentKindSpec('pi').ok).toBe(false);
  });

  it('一条没登记：视图项在表上、盘上无文件（读操作不写盘，出厂清单不抄进台账）', () => {
    const dir = tmp();
    const store = storeAt(dir);
    const view = store.readView();
    const agents = ofKind(view.entries, 'agent-kind');
    expect(agents).toHaveLength(AGENT_KINDS.length);
    expect(agents.every((e) => e.source === 'builtin' && e.enabled)).toBe(true);
    expect(new Set(agents.map((e) => e.name))).toEqual(new Set(AGENT_KINDS));
    // spec 由 `agentBinaryName` 现算：异名那几枚（antigravity）与 kind 不同，别拿 kind 冒充探测名
    expect(agents.find((e) => e.name === 'antigravity-cli')?.spec).toEqual({ binary: 'antigravity' });
    // 表上除出厂 agent 外只有出厂节点清单——视图项只可能来自 `REGISTRY_VIEW_KINDS`，不认的 kind 一条不许冒出来
    expect([...new Set(view.entries.map((e) => e.kind))].sort()).toEqual([...REGISTRY_VIEW_KINDS].sort());
    expect(fs.existsSync(path.join(dir, 'registry', 'entries.json'))).toBe(false);
    // 而写路径吃的仍是 `load()`：盘上就是零条
    expect(store.list()).toEqual([]);
  });

  it('用户登记的 model 排在前屏（compareEntries 吃 REGISTRY_KINDS 顺序，出厂那几十行不糊住自己的账）', () => {
    const store = storeAt(tmp());
    store.add(MODEL);
    // 每一类**登记项**都得挂号，否则「序」这条断言会把没登记的那一类静默跳过
    // （A5-1 起有 skill、A5-2 起有 rule、A5-3 起有 repo：新迁一类就在这一格多 add 一条）
    store.add({ kind: 'skill', name: '技能 x', spec: { space: 'demo', file: 'skills/x/SKILL.md' } });
    store.add({ kind: 'rule', name: '约定 x', spec: { space: 'demo', file: 'docs/x.md' } });
    store.add({ kind: 'repo', name: '前端仓', spec: { space: 'demo', dir: 'packages/web' } });
    store.add({ kind: 'mcp', name: 'fs-server', spec: { command: 'mcp-fs' } });
    const entries = store.readView().entries;
    expect(entries[0]!.id).toBe('model:gpt-4o-mini');
    // 分组序＝挂号序：写死总数的断言在这类里没意义（迁一类加一批），序才是这一格要钉的东西
    expect([...new Set(entries.map((e) => e.kind))]).toEqual([...REGISTRY_KINDS]);
  });

  it('盘上手写的 agent-kind 那条：视图赢、进 rejected 说清怎么清，且 DELETE 清得掉', () => {
    const dir = tmp();
    const store = storeAt(dir);
    fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'registry', 'entries.json'),
      JSON.stringify({ entries: [{ id: 'agent-kind:myth', kind: 'agent-kind', name: 'myth', source: 'user', enabled: true, createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z', spec: { binary: 'myth' } }] }),
      'utf8',
    );
    const view = store.readView();
    expect(view.entries.some((e) => e.id === 'agent-kind:myth')).toBe(false);
    expect(ofKind(view.entries, 'agent-kind')).toHaveLength(AGENT_KINDS.length); // 出厂项一枚不少，手写那枚一枚不掺
    expect(view.rejected.map((r) => r.id)).toEqual(['agent-kind:myth']);
    expect(view.rejected[0]!.why).toContain('读端只看出厂项');
    expect(view.rejected[0]!.why).toContain('DELETE');
    // 清账路真的通：删的是盘上那条，删完出厂项照在（视图项拆不掉）
    const removed = store.remove('agent-kind:myth');
    expect(removed.ok).toBe(true);
    expect(store.readView().rejected).toEqual([]);
    expect(ofKind(store.readView().entries, 'agent-kind')).toHaveLength(AGENT_KINDS.length);
  });

  it('三动词对视图 kind 全拒，且拒得没落盘（登记不了的类不在这里开第二条写路）', () => {
    const dir = tmp();
    const store = storeAt(dir);
    const add = store.add({ kind: 'agent-kind', name: 'my-agent', spec: { binary: 'my-agent' } });
    expect(add.ok).toBe(false);
    expect(add.why).toContain('内置能力清单');
    expect(store.update('agent-kind:pi', { enabled: false }).ok).toBe(false);
    expect(store.remove('agent-kind:pi').ok).toBe(false);
    expect(fs.existsSync(path.join(dir, 'registry'))).toBe(false);
    expect(store.list('agent-kind')).toEqual([]);
  });
});

/**
 * v14 T1：`node-type` 是第二枚视图 kind——画布值域那张清单（`shared/dag.ts: NODE_TYPE_CATALOG`）套上
 * 注册表信封。这一格钉三件事，缺一不可：
 *  1. **清单与值域一枚不多一枚不少**（两枚名单各长各的＝注册中心亮着一型、画布拖不出来，或反过来）；
 *  2. **条目只是信封**，画法字段原样取自清单（这里现算第二套措辞，就是 web 硬编码那份的老错）；
 *  3. 视图 kind 的老三条（不落盘 / 三动词拒 / 手写那条进 rejected）对这一类同样成立——
 *     注册表对「用户能不能自己加一型节点」的回答必须是**不能**，而界面上每一处都得读得到这个「不能」。
 */
describe('v14 T1 节点类型清单进表（node-type 视图条目）', () => {
  const nodeRows = (entries: RegistryEntry[]): RegistryEntry[] => entries.filter((e) => e.kind === 'node-type');

  it('清单锁住值域：每一型一枚、机器值不重名、中文措辞不重名', () => {
    expect(NODE_TYPE_CATALOG.map((r) => r.type).sort()).toEqual([...DAG_NODE_TYPES].sort());
    expect(new Set(NODE_TYPE_CATALOG.map((r) => r.type)).size).toBe(NODE_TYPE_CATALOG.length);
    expect(new Set(NODE_TYPE_CATALOG.map((r) => r.label)).size).toBe(NODE_TYPE_CATALOG.length);
    for (const row of NODE_TYPE_CATALOG) {
      expect(NODE_TYPE_GROUPS).toContain(row.group);
      expect(Number.isFinite(row.order)).toBe(true);
      expect(row.label.trim()).toBe(row.label);
      expect(row.label).not.toBe('');
    }
  });

  it('node-type 的 spec 形状：五键白名单，画法字段少一个都不放行', () => {
    const good = { label: '开始', icon: '▶', group: 'basic', order: 3 };
    // 清洗结果只从 ok 分支取：判据脏了就直接抛，别让断言对着 union 类型打马虎
    const value = (raw: unknown) => {
      const r = parseNodeTypeSpec(raw);
      if (!r.ok) throw new Error(r.why);
      return r.value;
    };
    expect(parseNodeTypeSpec(good)).toEqual({ ok: true, value: good });
    expect(value({ ...good, hint: '  ' })).toEqual(good); // 空 hint 整键不发，不占「有解释」的读数
    expect(value({ ...good, hint: '一句人话' })).toEqual({ ...good, hint: '一句人话' });
    for (const [bad, why] of [
      [{ ...good, oder: 1 }, 'oder'],
      [{ icon: '▶', group: 'basic', order: 3 }, 'label'],
      [{ label: '开始', group: 'basic', order: 3 }, 'icon'],
      [{ label: '开始', icon: '▶', group: 'c0re', order: 3 }, 'group'],
      [{ label: '开始', icon: '▶', group: 'basic', order: '3' }, 'order'],
      [{ label: '开始', icon: '▶', group: 'basic', order: Number.NaN }, 'order'],
    ] as const) {
      const r = parseNodeTypeSpec(bad);
      if (r.ok) throw new Error(`脏形状被认下了：${JSON.stringify(bad)}`);
      expect(r.why).toContain(why);
    }
  });

  it('一条没登记：出厂六型全在表上、画法原样取自清单、盘上无文件', () => {
    const dir = tmp();
    const store = storeAt(dir);
    const rows = nodeRows(store.readView().entries);
    expect(rows).toHaveLength(NODE_TYPE_CATALOG.length);
    expect(rows.every((e) => e.source === 'builtin' && e.enabled && e.name === e.id.split(':')[1])).toBe(true);
    // 逐字段对回清单：条目不许在这里发明措辞（画布与注册中心说同一句话，靠的是同一份数据）
    for (const row of NODE_TYPE_CATALOG) {
      const entry = rows.find((e) => e.name === row.type);
      expect(entry?.spec).toEqual({ label: row.label, icon: row.icon, group: row.group, order: row.order, ...('hint' in row ? { hint: row.hint } : {}) });
    }
    expect(store.list('node-type')).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'registry', 'entries.json'))).toBe(false);
  });

  it('三动词对 node-type 全拒：这一类的成员由版本决定，注册表不代造引擎跑不了的节点', () => {
    const dir = tmp();
    const store = storeAt(dir);
    const add = store.add({ kind: 'node-type', name: 'my-type', spec: { label: '我的节点', icon: '★', group: 'core', order: 1 } });
    expect(add.ok).toBe(false);
    expect(add.why).toContain('内置能力清单');
    expect(store.update('node-type:agent', { enabled: false }).ok).toBe(false);
    expect(store.remove('node-type:agent').ok).toBe(false);
    // 拒得干净：一个字节没落盘，出厂项一枚不少（假开关一个也不给）
    expect(nodeRows(store.readView().entries)).toHaveLength(NODE_TYPE_CATALOG.length);
    expect(fs.existsSync(path.join(dir, 'registry'))).toBe(false);
  });
});

describe('v14 T4 mcp 进表：只有声明账，探针刻意不做', () => {
  const GOOD = { command: '/usr/local/bin/mcp-fs', args: '/srv/data --read-only', note: '只读文件' };
  const rows = (entries: RegistryEntry[]): RegistryEntry[] => entries.filter((e) => e.kind === 'mcp');
  /** 清洗器给的是 union（收窄要到 kind 才成立）；测试里手窄一次，不为断言在生产码上开 cast */
  const mcpEntry = (name: string, spec: Record<string, unknown>): RegistryEntry<'mcp'> => {
    const e = normalizeRegistryEntry({ kind: 'mcp', name, spec });
    if (!e.ok) throw new Error(e.why);
    return e.value as RegistryEntry<'mcp'>;
  };
  const value = (raw: unknown) => {
    const r = parseMcpSpec(raw);
    if (!r.ok) throw new Error(r.why);
    return r.value;
  };

  it('挂号：认识它（可判预检死活），但它**不是**视图 kind（三动词该接、该落盘）', () => {
    expect(REGISTRY_KINDS).toContain('mcp');
    expect(REGISTRY_VIEW_KINDS).not.toContain('mcp');
  });

  it('spec 形状：三键白名单；command 非空是硬要求；args/note 空串整键不发', () => {
    expect(parseMcpSpec(GOOD)).toEqual({ ok: true, value: GOOD });
    expect(value({ command: ' npx ', args: '  ', note: '' })).toEqual({ command: 'npx' });
    for (const [bad, why] of [
      [{ command: 'x', transport: 'stdio' }, 'transport'], // 只有 stdio 一条路，预留第二值=猜语义
      [{ command: '  ' }, 'command'],
      [{ args: '-y' }, 'command'],
      [{ command: 'x', args: ['-y'] }, 'args'],
      [{ command: 'x', comand: 'y' }, 'comand'],
    ] as const) {
      const r = parseMcpSpec(bad);
      if (r.ok) throw new Error(`脏形状被认下了：${JSON.stringify(bad)}`);
      expect(r.why).toContain(why);
    }
  });

  it('add 真落盘、update/remove 认它：视图 kind 那条拒路不误伤登记项', () => {
    const dir = tmp();
    const store = storeAt(dir);
    const added = store.add({ kind: 'mcp', name: 'fs-server', spec: { command: 'mcp-fs', args: '/srv/data' } });
    expect(added.ok).toBe(true);
    const id = added.entry?.id ?? '';
    expect(id).toBe('mcp:fs-server');
    expect(fs.existsSync(path.join(dir, 'registry', 'entries.json'))).toBe(true);
    expect(rows(store.readView().entries).map((e) => e.id)).toEqual([id]);
    expect(store.update(id, { enabled: false }).ok).toBe(true);
    expect(rows(store.readView().entries)[0]?.enabled).toBe(false);
    expect(store.remove(id).ok).toBe(true);
    expect(rows(store.readView().entries)).toEqual([]);
  });

  it('label 说的就是那行启动命令；中文 name 走确定性散列 id（同 E2 幂等地基）', () => {
    const e = mcpEntry('文件服务', GOOD);
    expect(REGISTRY_DESCRIPTORS.mcp.label(e)).toBe(`${GOOD.command} ${GOOD.args} · ${GOOD.note}`);
    expect(splitRegistryId(e.id)?.slug).toMatch(/^u[0-9a-z]+$/);
    expect(mcpEntry('文件服务', GOOD).id).toBe(e.id);
  });

  it('引用写法只认 id 与 slug：command 不算（拿它匹配=把「同命令的另一枚」读成「正在用这枚」）', () => {
    const e = mcpEntry('fs-server', GOOD);
    expect(REGISTRY_DESCRIPTORS.mcp.refKeys(e)).toEqual(['mcp:fs-server', 'fs-server']);
    expect(REGISTRY_DESCRIPTORS.mcp.refKeys(e)).not.toContain(GOOD.command);
  });

  it('没有探针通道：mcp 条目整键不给健康读数（v13:285 不自实现 MCP 客户端，宁缺毋假）', async () => {
    expect(await entryHealth(tmp(), mcpEntry('fs-server', GOOD), {})).toBeUndefined();
  });

  it('引用账与预检词表：requires 槽按 id 命中这一枚，组名出自单一词表', () => {
    const stored = normalizeRegistryEntry({ kind: 'mcp', name: 'fs-server', spec: GOOD });
    const twin = normalizeRegistryEntry({ kind: 'mcp', name: 'other', spec: GOOD }); // 同 command 的另一枚
    if (!stored.ok || !twin.ok) throw new Error('条目清洗不该拒');
    const raw: RawReference[] = [
      { face: 'template', id: 'tpl', name: 'tpl', via: 'requires[0].id', kind: 'mcp', target: 'mcp:fs-server' },
    ];
    const idx = buildReferenceIndex([stored.value, twin.value], raw);
    const hit = idx.byEntry.find((b) => b.entryId === 'mcp:fs-server');
    expect(hit?.refs.map((r) => `${r.face}·${r.via}`)).toEqual(['template·requires[0].id']);
    expect(idx.byEntry.find((b) => b.entryId === 'mcp:other')?.refs).toEqual([]);
    expect(idx.dangling).toEqual([]);
    expect(requirementKindLabel('mcp')).toBe('MCP 服务');
  });
});

/**
 * v14 A5-1：`skill` 进表。这一类与前几枚的不同处只有一件——**它的身份离不开作用域**：
 * 同一枚相对路径在两个项目根下是两个文件。三条判据各有专测：作用域住在 spec（信封没动，schema 不 bump）、
 * 探针真去那个根读一次（三态各归各，读不动≠不存在）、跨条目撞键时反向账记全而正向账不猜。
 */
describe('v14 A5-1 skill 进表：作用域住在 spec，探针真去那个根读一次', () => {
  const skill = (spec: Record<string, unknown>, name?: string): RegistryEntry<'skill'> => {
    const e = normalizeRegistryEntry({ kind: 'skill', name: name ?? String(spec.file), spec });
    if (!e.ok) throw new Error(e.why);
    return e.value as RegistryEntry<'skill'>;
  };
  /** 一枚「有根、且有货」的项目：rootCwd 指向真临时目录，里面真放一篇 `skills/x/SKILL.md` */
  const root = tmp();
  fs.mkdirSync(path.join(root, 'skills/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills/x/SKILL.md'), '# 技能\n');
  /** 探针通道要吃项目档案，就按 `store.ts` 的盘面形状真写（不桩：桩了就只证了自己的假设） */
  const dataDir = tmp();
  const writeSpace = (id: string, rootCwd?: string): void => {
    fs.mkdirSync(path.join(dataDir, 'spaces', id), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'spaces', id, 'profile.json'),
      JSON.stringify({ id, name: `项目 ${id}`, createdAt: '2026-01-01T00:00:00.000Z', ...(rootCwd ? { rootCwd } : {}) }),
    );
  };
  writeSpace('demo', root);
  writeSpace('noroot');
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('挂号：认识它（预检自此判得了死活），且它是登记项不是视图项', () => {
    expect(REGISTRY_KINDS).toContain('skill');
    expect(REGISTRY_VIEW_KINDS).not.toContain('skill');
  });

  it('spec 形状：space+file 都得非空，note 空串整键不发，未知键照拒（flie 拼错=这篇从此探不到）', () => {
    expect(parseSkillSpec({ space: 'demo', file: 'skills/x/SKILL.md', note: '写作规范' })).toEqual({
      ok: true,
      value: { space: 'demo', file: 'skills/x/SKILL.md', note: '写作规范' },
    });
    const v = parseSkillSpec({ space: ' demo ', file: ' a/b.md ', note: '  ' });
    if (!v.ok) throw new Error(v.why);
    expect(v.value).toEqual({ space: 'demo', file: 'a/b.md' }); // note 全空=整键不发（宁缺键不空键）
    for (const [bad, why] of [
      [{ space: 'demo' }, 'file'],
      [{ file: 'a.md' }, 'space'], // 「没有主人的技能」：相对路径没有基准，后续一条都兑现不了
      [{ space: '  ', file: 'a.md' }, 'space'],
      [{ space: 'demo', file: '  ' }, 'file'],
      [{ space: 'demo', flie: 'a.md' }, 'flie'],
      [{ space: 'demo', file: 'a.md', note: 7 }, 'note'],
      ['skills/a.md', '{space, file, note?}'],
    ] as const) {
      const r = parseSkillSpec(bad);
      if (r.ok) throw new Error(`脏形状被认下了：${JSON.stringify(bad)}`);
      expect(r.why).toContain(why);
    }
  });

  it('登记时**不判** space 在不在、file 有没有：那是引用账与探针的账（写入面判存在=先立账后写文那条常态路被堵死）', () => {
    const store = storeAt(tmp());
    const added = store.add({ kind: 'skill', name: '技能 x', spec: { space: '没有这个项目', file: '不存在/的路径.md' } });
    expect(added.ok).toBe(true);
    expect(store.readView().entries.filter((e) => e.kind === 'skill')).toHaveLength(1);
  });

  it('label 把作用域说在句子里：只画相对路径会让两个空间的两篇同名文件在界面上长得一模一样', () => {
    expect(REGISTRY_DESCRIPTORS.skill.label(skill({ space: 'demo', file: 'skills/x/SKILL.md' }))).toBe(
      '[项目 demo] skills/x/SKILL.md',
    );
    expect(
      REGISTRY_DESCRIPTORS.skill.label(skill({ space: 'demo', file: 'skills/x/SKILL.md', note: '写作规范' })),
    ).toBe('[项目 demo] skills/x/SKILL.md · 写作规范');
  });

  it('引用写法三枚同权：整枚 id、slug、`spec.file` 原值（今天档案里落册的正是第三枚）', () => {
    const e = skill({ space: 'demo', file: 'skills/x/SKILL.md' }, 'skill-x');
    expect(REGISTRY_DESCRIPTORS.skill.refKeys(e)).toEqual(['skill:skill-x', 'skill-x', 'skills/x/SKILL.md']);
    expect(splitRegistryId(e.id)?.slug).toBe('skill-x'); // 拉丁名不散列：档案里那串路径从此有反查
  });

  it('探针三态各归各：读得到=live（报字节数）、根下没有=missing、没配根/没有那枚项目=unknown', async () => {
    const live = await entryHealth(dataDir, skill({ space: 'demo', file: 'skills/x/SKILL.md' }), {});
    expect(live).toMatchObject({ status: 'live', cached: false });
    // 字节数是探针**实读**算的（同 v13-K1 机检口径：读原文算，不信登记时自报）
    expect(live!.detail).toContain(`${fs.statSync(path.join(root, 'skills/x/SKILL.md')).size} 字节`);

    expect((await entryHealth(dataDir, skill({ space: 'demo', file: 'skills/none.md' }), {}))?.status).toBe('missing');
    // 越出主仓根=确定结论：注入现场（skills.ts 的 safeJoin）同一把尺，这种路径永远不会被注进节点
    expect((await entryHealth(dataDir, skill({ space: 'demo', file: '../escape.md' }), {}))?.status).toBe('missing');
    // 目录不是文件：注入现场读不出整篇内容，等于没有这篇
    expect((await entryHealth(dataDir, skill({ space: 'demo', file: 'skills/x' }), {}))?.status).toBe('missing');

    const noRoot = await entryHealth(dataDir, skill({ space: 'noroot', file: 'skills/x/SKILL.md' }), {});
    expect(noRoot).toMatchObject({ status: 'unknown' });
    expect(noRoot!.detail).toContain('rootCwd'); // 无从判就说无从判，绝不画成红点
    const noSpace = await entryHealth(dataDir, skill({ space: 'ghost', file: 'skills/x/SKILL.md' }), {});
    expect(noSpace).toMatchObject({ status: 'unknown' });
    expect(noSpace!.detail).toContain('不等于这篇技能不存在');
  });

  it('角色侧的撞键裸串记在**每一枚**条目上（多报只是多挡一次删除，漏报是静默剪断现役配置）', () => {
    const a = skill({ space: 'demo', file: 'shared/x.md' }, '甲');
    const b = skill({ space: 'other', file: 'shared/x.md' }, '乙');
    const idx = buildReferenceIndex([a, b], [
      // 角色是全局名册，它发的 `skills[i]` 不绑空间——这一路判不准是哪一枚，于是两枚都记
      { face: 'role', id: 'r-1', name: '岗', via: 'skills[0]', kind: 'skill', target: 'shared/x.md' },
    ]);
    expect(idx.byEntry.map((e) => e.refs.length)).toEqual([1, 1]);
    expect(idx.dangling).toEqual([]);
  });

  it('空间自己发的引用按主人收窄：A 项目那一格不算指着 B 项目的同名条目（判得准时不扩大多报）', () => {
    const mine = skill({ space: 'demo', file: 'shared/x.md' }, '甲');
    const theirs = skill({ space: 'other', file: 'shared/x.md' }, '乙');
    const idx = buildReferenceIndex([mine, theirs], [
      { face: 'space', id: 'demo', name: '演示项目', via: 'skills[0]', kind: 'skill', target: 'shared/x.md' },
    ]);
    expect(idx.byEntry.find((e) => e.entryId === mine.id)!.refs.map((r) => `${r.face}·${r.via}`)).toEqual([
      'space·skills[0]',
    ]);
    expect(idx.byEntry.find((e) => e.entryId === theirs.id)!.refs).toEqual([]);
    // 乙没被记上≠悬挂：悬挂账只收「一处都没指着」的裸串
    expect(idx.dangling).toEqual([]);
  });

  it('真落盘 + 启停删除照接（视图 kind 那条拒路不误伤登记项）', () => {
    const store = storeAt(tmp());
    const added = store.add({ kind: 'skill', name: '技能 x', spec: { space: 'demo', file: 'skills/x/SKILL.md' } });
    expect(added.ok).toBe(true);
    expect(added.entry?.id.startsWith('skill:')).toBe(true);
    const stored = store.readView().entries.filter((e) => e.kind === 'skill');
    expect(stored).toHaveLength(1);
    const id = stored[0]!.id;
    expect(store.update(id, { enabled: false }).ok).toBe(true);
    expect(store.readView().entries.find((e) => e.id === id)!.enabled).toBe(false);
    expect(store.remove(id).ok).toBe(true);
    expect(store.readView().entries.filter((e) => e.kind === 'skill')).toEqual([]);
  });

  it('预检词表：`需要：技能` 那一行从此有中文组名（KIND_CN 是全仓唯一一份措辞表）', () => {
    expect(requirementKindLabel('skill')).toBe('技能');
  });
});

/**
 * v14 A5-2：`rule` 进表。形状直接抄 `SpaceRule`（`orchestrate/rules.ts` 的注入侧档案字段）再加一枚
 * `space`——注册表里写的和档案里写的必须是同一串，两边各造一套词迟早对不上。
 *
 * 与 skill 分格写（不是塞进上面那一格）的理由只有两条是这一枚独有的：
 *  ①作用域那两枚可选键（`repo`/`pathsGlob`）**不进引用写法**：它们是注入现场的生效条件，
 *    判据住在 `matchRules`；把它们当引用就会让「同仓的另一条」冒领这一条的引用账；
 *  ②探针多问一句「作用域目录在不在」：根下没有那个目录=没有节点落得进去=这条约定永远不会注入，
 *    那是确定结论（missing），不是「探不到」（unknown）。`pathsGlob` 不判——没有具体节点目录可喂它。
 */
describe('v14 A5-2 rule 进表：作用域住在 spec，探针连作用域目录一起问', () => {
  const rule = (spec: Record<string, unknown>, name?: string): RegistryEntry<'rule'> => {
    const e = normalizeRegistryEntry({ kind: 'rule', name: name ?? String(spec.file), spec });
    if (!e.ok) throw new Error(e.why);
    return e.value as RegistryEntry<'rule'>;
  };
  /** 有根、有文档、也有那枚作用域目录的项目根 */
  const root = tmp();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'x.md'), '# 约定\n');
  fs.mkdirSync(path.join(root, 'packages', 'web'), { recursive: true });
  const dataDir = tmp();
  const writeSpace = (id: string, rootCwd?: string): void => {
    fs.mkdirSync(path.join(dataDir, 'spaces', id), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'spaces', id, 'profile.json'),
      JSON.stringify({ id, name: `项目 ${id}`, createdAt: '2026-01-01T00:00:00.000Z', ...(rootCwd ? { rootCwd } : {}) }),
    );
  };
  writeSpace('demo', root);
  writeSpace('noroot');
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('挂号：认识它（预检自此判得了死活），且它是登记项不是视图项', () => {
    expect(REGISTRY_KINDS).toContain('rule');
    expect(REGISTRY_VIEW_KINDS).not.toContain('rule');
  });

  it('spec 形状：space+file 必填、作用域空串照拒、note 空了整键不发、未知键照拒（pathGlob 拼错=这条从此不缩范围）', () => {
    expect(
      parseRuleSpec({ space: 'demo', file: 'docs/x.md', repo: 'packages/web', pathsGlob: 'src/**', note: '只守前端' }),
    ).toEqual({
      ok: true,
      value: { space: 'demo', file: 'docs/x.md', repo: 'packages/web', pathsGlob: 'src/**', note: '只守前端' },
    });
    const v = parseRuleSpec({ space: ' demo ', file: ' docs/x.md ', note: '  ' });
    if (!v.ok) throw new Error(v.why);
    expect(v.value).toEqual({ space: 'demo', file: 'docs/x.md' }); // note 全空=整键不发（与 model/skill 同一处理）
    for (const [bad, why] of [
      [{ space: 'demo' }, 'file'],
      [{ file: 'docs/x.md' }, 'space'], // 没有主人的约定：相对路径与相对目录都没有基准
      [{ space: 'demo', flie: 'a.md' }, 'flie'],
      [{ space: 'demo', file: 'a.md', pathGlob: 'src/**' }, 'pathGlob'],
      [{ space: 'demo', file: 'a.md', repo: 7 }, 'repo'],
      [{ space: 'demo', file: 'a.md', note: null }, 'note'],
      // 作用域空串**不**跟着 note 走：静默丢掉它＝把「只守某仓」悄悄放大成「整个项目都守」
      [{ space: 'demo', file: 'a.md', repo: '  ' }, 'repo'],
      [{ space: 'demo', file: 'a.md', pathsGlob: '' }, 'pathsGlob'],
      ['docs/x.md', '{space, file, repo?, pathsGlob?, note?}'],
    ] as const) {
      const r = parseRuleSpec(bad);
      if (r.ok) throw new Error(`脏形状被认下了：${JSON.stringify(bad)}`);
      expect(r.why).toContain(why);
    }
  });

  it('登记时**不判** space/文档/作用域目录存不存在：那是引用账与探针的账（写入面判存在=先立账后写文被堵死）', () => {
    const store = storeAt(tmp());
    const added = store.add({
      kind: 'rule',
      name: '约定 y',
      spec: { space: '没有这个项目', file: '不存在/的约定.md', repo: '没有这个目录' },
    });
    expect(added.ok).toBe(true);
    expect(store.readView().entries.filter((e) => e.kind === 'rule')).toHaveLength(1);
  });

  it('label 把作用域说在句子里：不收窄的「整个项目都守」与收窄到某仓/某目录，是三条不同的账', () => {
    expect(REGISTRY_DESCRIPTORS.rule.label(rule({ space: 'demo', file: 'docs/x.md' }))).toBe('[项目 demo] docs/x.md');
    expect(REGISTRY_DESCRIPTORS.rule.label(rule({ space: 'demo', file: 'docs/x.md', repo: 'packages/web' }))).toBe(
      '[项目 demo] docs/x.md（仅 packages/web 仓）',
    );
    expect(REGISTRY_DESCRIPTORS.rule.label(rule({ space: 'demo', file: 'docs/x.md', pathsGlob: 'src/**' }))).toBe(
      '[项目 demo] docs/x.md（目录 src/**）',
    );
    expect(
      REGISTRY_DESCRIPTORS.rule.label(rule({ space: 'demo', file: 'docs/x.md', repo: 'packages/web', pathsGlob: 'src/**', note: '前端' })),
    ).toBe('[项目 demo] docs/x.md（仅 packages/web 仓 + 目录 src/**） · 前端');
  });

  it('引用写法只有三枚（id/slug/spec.file）：作用域收窄键不进 `refKeys`——同仓的另一条不算引用了这一条', () => {
    const e = rule({ space: 'demo', file: 'docs/x.md', repo: 'packages/web', pathsGlob: 'src/**' }, 'rule-x');
    expect(REGISTRY_DESCRIPTORS.rule.refKeys(e)).toEqual(['rule:rule-x', 'rule-x', 'docs/x.md']);
  });

  it('探针：文档在且作用域目录在=live；没有那篇文档=missing；目录不存在=missing 并说清「永远不会被注入」', async () => {
    const live = await entryHealth(dataDir, rule({ space: 'demo', file: 'docs/x.md', repo: 'packages/web' }), {});
    expect(live).toMatchObject({ status: 'live', cached: false });
    expect(live!.detail).toContain(`${fs.statSync(path.join(root, 'docs', 'x.md')).size} 字节`);
    // 没有作用域键时不问目录（无收窄=整个项目都守，根在就行）
    expect((await entryHealth(dataDir, rule({ space: 'demo', file: 'docs/x.md' }), {}))?.status).toBe('live');
    expect((await entryHealth(dataDir, rule({ space: 'demo', file: 'docs/none.md' }), {}))?.status).toBe('missing');
    const noRepo = await entryHealth(dataDir, rule({ space: 'demo', file: 'docs/x.md', repo: 'packages/ghost' }), {});
    expect(noRepo).toMatchObject({ status: 'missing' });
    expect(noRepo!.detail).toContain('永远不会被注入'); // 文档活着但这条永远不生效——两句都在同一格说清
    // 越出根的作用域目录同样是确定结论，且绝不去 stat 根外的目录
    expect((await entryHealth(dataDir, rule({ space: 'demo', file: 'docs/x.md', repo: '../tmp' }), {}))?.status).toBe(
      'missing',
    );
    // pathsGlob 不判：没有具体节点目录可喂它，判了就是拿空白冒充断言
    expect((await entryHealth(dataDir, rule({ space: 'demo', file: 'docs/x.md', pathsGlob: 'nope/**' }), {}))?.status).toBe(
      'live',
    );
    const noRoot = await entryHealth(dataDir, rule({ space: 'noroot', file: 'docs/x.md' }), {});
    expect(noRoot).toMatchObject({ status: 'unknown' });
    expect((await entryHealth(dataDir, rule({ space: 'ghost', file: 'docs/x.md' }), {}))!.detail).toContain(
      '不等于这篇约定不存在',
    );
  });

  it('真落盘 + 启停删除照接（视图 kind 那条拒路不误伤登记项）', () => {
    const store = storeAt(tmp());
    const added = store.add({ kind: 'rule', name: '约定 x', spec: { space: 'demo', file: 'docs/x.md' } });
    expect(added.ok).toBe(true);
    expect(added.entry?.id.startsWith('rule:')).toBe(true);
    const stored = store.readView().entries.filter((e) => e.kind === 'rule');
    expect(stored).toHaveLength(1);
    const id = stored[0]!.id;
    expect(store.update(id, { enabled: false }).ok).toBe(true);
    expect(store.readView().entries.find((e) => e.id === id)!.enabled).toBe(false);
    expect(store.remove(id).ok).toBe(true);
    expect(store.readView().entries.filter((e) => e.kind === 'rule')).toEqual([]);
  });

  it('预检词表：`需要：规则` 那一行有中文组名（KIND_CN 是全仓唯一一份措辞表）', () => {
    expect(requirementKindLabel('rule')).toBe('规则');
  });
});

/**
 * v14 A5-3：`repo` 进表。这一类独有的毛病只有一件——**一盘两制**：
 * 档案侧（`repos[]`／`rules[].repo`／`delivery[].repo`）写的是相对主仓根的**目录名**，
 * 派活侧（`contract.repo`／`dispatch --repo`）写的是 GitHub 的 **`owner/repo`**。
 * 两枚命名空间都得住进一条账：只认目录名，则按 `owner/repo` 点名的声明永远判不到条目；
 * 只认 origin，则现网那三处裸串当场全洗成悬挂。所以 `refKeys` 四枚起步、origin 还额外归一出一枚，
 * 而**归一绝不写回数据**（条目里存的就是用户敲的那串）。
 *
 * 探针只问一件事：「这台机器上这个目录在不在」。**不实读 `.git/config` 核对 origin**——
 * 整表健康读数是一枚条目一次 subprocess 的话，注册中心首屏就成了 `git` 调用放大器；
 * 而 remote 的实读本来就归派发现场（`dispatch.ts: candidateRepos`），这里再读一遍是第二处判据。
 * 「没核」不等于「不符」，所以这一条只在 detail 里说一句，不进三态。
 */
describe('v14 A5-3 repo 进表：一盘两制两套写法，探针只问目录在不在', () => {
  const repo = (spec: Record<string, unknown>, name?: string): RegistryEntry<'repo'> => {
    const e = normalizeRegistryEntry({ kind: 'repo', name: name ?? String(spec.dir), spec });
    if (!e.ok) throw new Error(e.why);
    return e.value as RegistryEntry<'repo'>;
  };
  /** 有根的项目：`repos/app` 是个真仓（有 .git），`repos/plain` 只是目录，`repos/file` 是文件 */
  const root = tmp();
  fs.mkdirSync(path.join(root, 'repos', 'app', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'repos', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'repos', 'file'), '不是目录\n');
  const dataDir = tmp();
  const writeSpace = (id: string, rootCwd?: string): void => {
    fs.mkdirSync(path.join(dataDir, 'spaces', id), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'spaces', id, 'profile.json'),
      JSON.stringify({ id, name: `项目 ${id}`, createdAt: '2026-01-01T00:00:00.000Z', ...(rootCwd ? { rootCwd } : {}) }),
    );
  };
  writeSpace('demo', root);
  writeSpace('noroot');
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('挂号：认识它（预检自此判得了仓库槽的死活），且它是登记项不是视图项', () => {
    expect(REGISTRY_KINDS).toContain('repo');
    expect(REGISTRY_VIEW_KINDS).not.toContain('repo');
  });

  it('spec 形状：space+dir 必填、origin 空串照拒、note 空了整键不发、未知键照拒（dire 拼错=这枚仓从此探不到）', () => {
    expect(
      parseRepoSpec({ space: 'demo', dir: 'repos/app', origin: 'git@github.com:my-org/my-repo.git', note: '主仓' }),
    ).toEqual({
      ok: true,
      value: { space: 'demo', dir: 'repos/app', origin: 'git@github.com:my-org/my-repo.git', note: '主仓' },
    });
    const v = parseRepoSpec({ space: ' demo ', dir: ' repos/app ', note: '  ' });
    if (!v.ok) throw new Error(v.why);
    expect(v.value).toEqual({ space: 'demo', dir: 'repos/app' }); // note 全空=整键不发（与 model/skill/rule 同一处理）
    for (const [bad, why] of [
      [{ space: 'demo' }, 'dir'],
      [{ dir: 'repos/app' }, 'space'], // 没有主人的仓：相对目录名没有基准，探针连往哪找都不知道
      [{ space: '  ', dir: 'repos/app' }, 'space'],
      [{ space: 'demo', dir: '  ' }, 'dir'],
      [{ space: 'demo', dire: 'repos/app' }, 'dire'],
      [{ space: 'demo', dir: 'a', origin: 7 }, 'origin'],
      // origin 空串**不**跟着 note 走：它是引用写法之一，塞进引用账就是一条永远指不到的裸串
      [{ space: 'demo', dir: 'a', origin: '  ' }, 'origin'],
      [{ space: 'demo', dir: 'a', note: null }, 'note'],
      ['repos/app', '{space, dir, origin?, note?}'],
    ] as const) {
      const r = parseRepoSpec(bad);
      if (r.ok) throw new Error(`脏形状被认下了：${JSON.stringify(bad)}`);
      expect(r.why).toContain(why);
    }
  });

  it('登记时**不判**目录在不在、也不判 origin 与真仓符不符：先立账后克隆是常态（写入面判存在=把这条路堵死）', () => {
    const store = storeAt(tmp());
    const added = store.add({
      kind: 'repo',
      name: '还没克隆的仓',
      spec: { space: '没有这个项目', dir: '../../越界', origin: 'my-org/not-exist' },
    });
    expect(added.ok).toBe(true);
    expect(store.readView().entries.filter((e) => e.kind === 'repo')).toHaveLength(1);
  });

  it('label 两套命名空间都画：只画目录名时，派活写的 owner/repo 在界面上指认不出是同一枚仓', () => {
    expect(REGISTRY_DESCRIPTORS.repo.label(repo({ space: 'demo', dir: 'repos/app' }))).toBe('[项目 demo] repos/app');
    expect(
      REGISTRY_DESCRIPTORS.repo.label(repo({ space: 'demo', dir: 'repos/app', origin: 'my-org/my-repo' })),
    ).toBe('[项目 demo] repos/app（my-org/my-repo）');
    expect(
      REGISTRY_DESCRIPTORS.repo.label(repo({ space: 'demo', dir: 'repos/app', origin: 'my-org/my-repo', note: '主仓' })),
    ).toBe('[项目 demo] repos/app（my-org/my-repo） · 主仓');
  });

  it('引用写法：id/slug/目录名/origin 四枚同权，且 origin 存 URL 时归一名也算（一把尺，两种写法，零数据改写）', () => {
    const e = repo({ space: 'demo', dir: 'repos/app', origin: 'https://github.com/my-org/my-repo.git' }, 'main-app');
    expect(REGISTRY_DESCRIPTORS.repo.refKeys(e)).toEqual([
      'repo:main-app',
      'main-app',
      'repos/app',
      'https://github.com/my-org/my-repo.git',
      'my-org/my-repo',
    ]);
    // 归一只多列一枚键，条目里存的仍是原样（快照抄的是 spec，不是猜来的规范形）
    expect(e.spec.origin).toBe('https://github.com/my-org/my-repo.git');
  });

  /**
   * 反方向那一趟：条目登记的是 `owner/repo`（`candidateRepos` 外发给用户的正是这一形），
   * 而引用那头发来的是表单明写允许的完整 clone URL。只归一登记值、不归一 target，这一趟就悄悄指不到——
   * 预检画 `✗ 死缺` 拦下一次本来安全的起单，引用账把它算成 dangling 后又放行删除。
   * 假绿更狠的一种形态在最后一句：归一**认错了域**（自建 Gitea 的 URL 不是 GitHub 的尺能归的）时
   * 不许把它折进任何一枚 GitHub 仓，宁可指不到。
   */
  it('origin 存 `owner/repo` 时，发来的完整 URL 按同一把尺归一后照样指得到（两写法同权，非只单侧）', () => {
    const e = repo({ space: 'demo', dir: 'repos/app', origin: 'my-org/my-repo' }, 'main-app');
    const urls = ['https://github.com/my-org/my-repo.git', 'git@github.com:my-org/my-repo.git'];
    for (const target of [...urls, 'my-org/my-repo']) {
      expect(matchesTarget(e, target)).toBe(true);
    }
    // URL 那两枚**不在** `refKeys` 里：命中的路走的是 target 归一，不是把每种拼法都多存一份键
    // （否则登记面就得替用户改写数据，快照抄的也不再是用户写的那串字节）
    for (const target of urls) expect(REGISTRY_DESCRIPTORS.repo.refKeys(e).includes(target)).toBe(false);
    // 存原样这条不动：归一只发生在比对的一瞬间，条目与快照里的字节还是用户写的那串
    expect(e.spec.origin).toBe('my-org/my-repo');
    // 归一认错域 ⇒ 不指：自建域的 URL 与 GitHub 那枚仓不是同一个东西，硬折就是拿空白冒认
    expect(matchesTarget(e, 'https://git.internal.example.com/my-org/my-repo.git')).toBe(false);
    // 别的仓也不许借这趟归一路过：owner 不同就是不同仓
    expect(matchesTarget(e, 'https://github.com/other/my-repo.git')).toBe(false);
  });

  it('没有 origin 时不硬造归一名；origin 认不出 owner/repo（自建 Gitea 域）时只有原串那一枚', () => {
    expect(REGISTRY_DESCRIPTORS.repo.refKeys(repo({ space: 'demo', dir: 'repos/app' }, 'alpha'))).toEqual([
      'repo:alpha',
      'alpha',
      'repos/app',
    ]);
    expect(
      REGISTRY_DESCRIPTORS.repo
        .refKeys(repo({ space: 'demo', dir: 'x', origin: 'git@git.internal:g/r.git' }, 'beta'))
        .filter((k) => k.includes('git.internal')),
    ).toEqual(['git@git.internal:g/r.git']); // 认不出就不归一：`parseGithubRemote` 那一把尺不外扩
  });

  it('探针三态：目录在且见 .git=live；目录在但没 .git=live 并说清「登记的是目录不是仓」；没有=missing；没根/没项目=unknown', async () => {
    const live = await entryHealth(dataDir, repo({ space: 'demo', dir: 'repos/app' }), {});
    expect(live).toMatchObject({ status: 'live', cached: false });
    expect(live!.detail).toContain('是 git 工作区');

    const plain = await entryHealth(dataDir, repo({ space: 'demo', dir: 'repos/plain' }), {});
    expect(plain).toMatchObject({ status: 'live' }); // 目录确实在——是不是仓是另一句读数，不改三态
    expect(plain!.detail).toContain('没看到 .git');

    const gone = await entryHealth(dataDir, repo({ space: 'demo', dir: 'repos/ghost' }), {});
    expect(gone).toMatchObject({ status: 'missing' });
    expect(gone!.detail).toContain('要么还没克隆');

    // 越出主仓根=确定结论：派发与机检按同一把尺拿不到根外的目录，且绝不去 stat 根外
    expect((await entryHealth(dataDir, repo({ space: 'demo', dir: '../outside' }), {}))?.status).toBe('missing');
    // 是文件不是目录：节点进不去，等于没有这个仓
    expect((await entryHealth(dataDir, repo({ space: 'demo', dir: 'repos/file' }), {}))?.status).toBe('missing');

    const noRoot = await entryHealth(dataDir, repo({ space: 'noroot', dir: 'repos/app' }), {});
    expect(noRoot).toMatchObject({ status: 'unknown' });
    expect(noRoot!.detail).toContain('rootCwd');
    const noSpace = await entryHealth(dataDir, repo({ space: 'ghost', dir: 'repos/app' }), {});
    expect(noSpace).toMatchObject({ status: 'unknown' });
    expect(noSpace!.detail).toContain('不等于这个仓不存在'); // 未探得不是不可用
  });

  it('origin 只说「不实读核对」，绝不因为它对不上就画红：remote 的实读归派发现场那一把尺', async () => {
    const withOrigin = await entryHealth(
      dataDir,
      repo({ space: 'demo', dir: 'repos/app', origin: 'my-org/never-checked' }),
      {},
    );
    expect(withOrigin).toMatchObject({ status: 'live' });
    expect(withOrigin!.detail).toContain('origin「my-org/never-checked」按登记原样存，这一版探针不实读核对');
  });

  it('目录名跨空间可撞：空间自己发的按主人收窄（判得准），点名叫 origin 的不按空间收窄（那本来就是全局标识）', () => {
    const a = repo({ space: 'demo', dir: 'shared', origin: 'my-org/alpha' }, '甲');
    const b = repo({ space: 'other', dir: 'shared', origin: 'my-org/beta' }, '乙');
    const idx = buildReferenceIndex([a, b], [
      { face: 'space', id: 'demo', name: '项目 demo', via: 'repos[0]', kind: 'repo', target: 'shared' },
      // 角色/模板侧不绑空间：这一路判不准是哪一枚，于是两枚都记（多报只是多挡一次删除）
      { face: 'template', id: 'flow', name: 'flow', via: 'requires[0].id', kind: 'repo', target: 'shared' },
    ]);
    const refsOf = (entry: RegistryEntry) => idx.byEntry.find((x) => x.entryId === entry.id)?.refs.map((r) => r.via);
    expect(refsOf(a)).toEqual(['repos[0]', 'requires[0].id']);
    expect(refsOf(b)).toEqual(['requires[0].id']);
    expect(idx.dangling).toEqual([]);
    expect(idx.unmigrated).toEqual([]); // 自此「仓库」这一类不再是只披露计数的账
  });

  it('三处裸串（repos[]／rules[].repo／delivery[].repo）与按 origin 点名的声明都指得到条目，认不出的写法照进 dangling', () => {
    const e = repo({ space: 'demo', dir: 'packages/web', origin: 'my-org/web' }, '前端仓');
    const idx = buildReferenceIndex([e], [
      { face: 'space', id: 'demo', name: '项目', via: 'repos[0]', kind: 'repo', target: 'packages/web' },
      { face: 'space', id: 'demo', name: '项目', via: 'rules[0].repo', kind: 'repo', target: 'packages/web' },
      { face: 'space', id: 'demo', name: '项目', via: 'delivery[0].repo', kind: 'repo', target: 'packages/web' },
      { face: 'template', id: 'flow', name: 'flow', via: 'requires[0].id', kind: 'repo', target: 'my-org/web' },
      // 目录名不是 origin 的写法：空间侧按主人对得上，但仍不能拿它冒认另一枚仓
      { face: 'space', id: 'demo', name: '项目', via: 'repos[1]', kind: 'repo', target: 'packages/api' },
    ]);
    // 这一格要钉的是「四处都归到了这枚条目」，不是服务器内部那套排序（排序本身另有上面那格守）
    expect(idx.byEntry[0]!.refs.map((r) => r.via).sort()).toEqual([
      'delivery[0].repo',
      'repos[0]',
      'requires[0].id',
      'rules[0].repo',
    ]);
    expect(idx.dangling.map((d) => `${d.kind}:${d.target}`)).toEqual(['repo:packages/api']);
  });

  it('真落盘 + 启停删除照接（视图 kind 那条拒路不误伤登记项）', () => {
    const store = storeAt(tmp());
    const added = store.add({ kind: 'repo', name: '主仓', spec: { space: 'demo', dir: 'repos/app' } });
    expect(added.ok).toBe(true);
    expect(added.entry?.id.startsWith('repo:')).toBe(true);
    const stored = store.readView().entries.filter((x) => x.kind === 'repo');
    expect(stored).toHaveLength(1);
    const id = stored[0]!.id;
    expect(store.update(id, { enabled: false }).ok).toBe(true);
    expect(store.readView().entries.find((x) => x.id === id)!.enabled).toBe(false);
    expect(store.remove(id).ok).toBe(true);
    expect(store.readView().entries.filter((x) => x.kind === 'repo')).toEqual([]);
  });

  it('预检词表：`需要：仓库` 那一行有中文组名（KIND_CN 是全仓唯一一份措辞表）', () => {
    expect(requirementKindLabel('repo')).toBe('仓库');
  });
});
