import { describe, expect, it } from 'vitest';
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
import { buildReferenceIndex, type RawReference } from './registry-refs.js';
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
    // T4 起有第二类用户登记项：两枚都登记上，这一格才真把「四类全在表上时按挂号序排」钉住
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
