import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeRegistryEntry,
  REGISTRY_SCHEMA_VERSION,
  registryId,
  splitRegistryId,
  parseAgentKindSpec,
  parseModelSpec,
  parseRegistrySpec,
} from '@paneflow/shared';
import { AGENT_KINDS } from '../api/agent-kinds.js';
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
 *
 * 三条最容易在实施时被洗掉的姿态，各有专测：
 *  1. **只读**——`readView()` 合进来的条目一个字节都不落盘（落了就是台账里多一份「本机有哪些 agent」，
 *     而真正决定能不能起 agent 的是代码那张表）；
 *  2. **视图赢**——手塞进 `entries.json` 的 `agent-kind` 那条不生效，且要出现在 `rejected` 里说清为什么
 *     （静默吞掉就是「盘上明明有、表上看不见」那种查三天的账）；
 *  3. **写入面拒**——`add`/`update`/`remove` 三动词对视图 kind 全关（不拒就等于给用户造一个不生效的假开关）。
 */
describe('v14 A3-2 视图条目 readView（出厂清单现算，不落盘）', () => {
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
    expect(view.entries).toHaveLength(AGENT_KINDS.length);
    expect(view.entries.every((e) => e.kind === 'agent-kind' && e.source === 'builtin' && e.enabled)).toBe(true);
    expect(new Set(view.entries.map((e) => e.name))).toEqual(new Set(AGENT_KINDS));
    // spec 由 `agentBinaryName` 现算：异名那几枚（antigravity）与 kind 不同，别拿 kind 冒充探测名
    expect(view.entries.find((e) => e.name === 'antigravity-cli')?.spec).toEqual({ binary: 'antigravity' });
    expect(fs.existsSync(path.join(dir, 'registry', 'entries.json'))).toBe(false);
    // 而写路径吃的仍是 `load()`：盘上就是零条
    expect(store.list()).toEqual([]);
  });

  it('用户登记的 model 排在前屏（compareEntries 吃 REGISTRY_KINDS 顺序，出厂那 18 行不糊住自己的账）', () => {
    const store = storeAt(tmp());
    store.add(MODEL);
    const ids = store.readView().entries.map((e) => e.id);
    expect(ids[0]).toBe('model:gpt-4o-mini');
    expect(ids).toHaveLength(AGENT_KINDS.length + 1);
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
    expect(view.entries).toHaveLength(AGENT_KINDS.length); // 出厂项一枚不少，手写那枚一枚不掺
    expect(view.rejected.map((r) => r.id)).toEqual(['agent-kind:myth']);
    expect(view.rejected[0]!.why).toContain('读端只看出厂项');
    expect(view.rejected[0]!.why).toContain('DELETE');
    // 清账路真的通：删的是盘上那条，删完出厂项照在（视图项拆不掉）
    const removed = store.remove('agent-kind:myth');
    expect(removed.ok).toBe(true);
    expect(store.readView().rejected).toEqual([]);
    expect(store.readView().entries).toHaveLength(AGENT_KINDS.length);
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
