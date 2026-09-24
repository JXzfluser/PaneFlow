import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, DEFAULT_SPACE } from './store.js';
import { buildHttpServer } from '../api/http.js';
import type { Engine } from './engine.js';
import type { HerdrOps } from './herdr-ops.js';
import type { DagGraph, RunRecord } from '@paneflow/shared';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store-'));
}

function runRecord(runId: string, startedAt = '2026-01-01T00:00:00.000Z'): RunRecord {
  return { runId, state: 'completed', startedAt } as unknown as RunRecord;
}

function graph(name: string): DagGraph {
  return {
    version: 1,
    name,
    nodes: [{ id: 'start', type: 'start', label: '开始', config: {} }],
    edges: [],
    metadata: { createdAt: '', updatedAt: '' },
  };
}

describe('Store (Space-aware)', () => {
  it('migrates legacy flat layout into the default space once（模板再并入全局 graphs/）', () => {
    const root = tmpRoot();
    // legacy flat layout
    fs.mkdirSync(path.join(root, 'templates'));
    fs.mkdirSync(path.join(root, 'runs'));
    fs.writeFileSync(path.join(root, 'templates', 'old.json'), JSON.stringify(graph('old')));
    fs.writeFileSync(path.join(root, 'runs', 'r1.json'), JSON.stringify({ runId: 'r1' }));

    const store = new Store(root); // triggers migration
    expect(store.getGraph('old')?.name).toBe('old');
    // v10-Y：flat → default space → 全局 graphs/，两处旧模板目录都不该有文件
    expect(fs.existsSync(path.join(root, 'graphs', 'old.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'templates'))).toBe(false); // legacy removed
    expect(fs.existsSync(path.join(root, 'spaces', DEFAULT_SPACE, 'templates'))).toBe(false);
    // second construction must not double-migrate or fail
    new Store(root);
    expect(store.listGraphs()).toHaveLength(1);
  });

  it('v10-Y 模板是全局资产：A 项目存的 B 项目直接可见；运行记录仍按项目隔离', () => {
    const root = tmpRoot();
    const a = new Store(root, 'alpha');
    const b = new Store(root, 'beta');
    a.saveGraph(graph('shared-flow'));
    expect(b.getGraph('shared-flow')).not.toBeNull();
    expect(b.listGraphs().map((g) => g.name)).toContain('shared-flow');
    const run = { runId: 'r9', state: 'completed' } as unknown as RunRecord;
    a.saveRun(run);
    expect(a.getRun('r9')).not.toBeNull();
    expect(b.getRun('r9')).toBeNull();
    expect(new Store(root).listRuns()).toEqual([]); // default space unaffected
  });

  it('v10-Y 一次性合并：各项目同名模板取 updatedAt 新者，输者归档 pre-global 不删', () => {
    const root = tmpRoot();
    const mk = (space: string, g: DagGraph) => {
      const dir = path.join(root, 'spaces', space, 'templates');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${g.name}.json`), JSON.stringify(g));
    };
    const old = graph('dup');
    old.metadata.updatedAt = '2026-01-01T00:00:00.000Z';
    const fresh = graph('dup');
    fresh.metadata.updatedAt = '2026-06-06T00:00:00.000Z';
    const unique = graph('solo');
    mk('alpha', old);
    mk('beta', fresh);
    mk('beta', unique);
    const store = new Store(root, 'alpha'); // 构造触发合并
    expect(store.getGraph('dup')).not.toBeNull();
    expect(store.getGraph('dup')!.metadata.updatedAt).toBe('2026-06-06T00:00:00.000Z'); // 新者胜
    expect(store.listGraphs().map((g) => g.name).sort()).toEqual(['dup', 'solo']);
    // 旧版被新版顶替后归档在顶替者（beta）的 pre-global 里，可回捞不删
    expect(fs.existsSync(path.join(root, 'spaces', 'beta', 'templates.pre-global', 'dup.json.older'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'spaces', 'alpha', 'templates'))).toBe(false); // 旧目录已撤
  });

  it('lists spaces with profiles and creates named spaces', () => {
    const root = tmpRoot();
    new Store(root); // default materialized
    Store.createSpace(root, 'demo', '演示空间');
    const spaces = Store.listSpaces(root);
    const demo = spaces.find((s) => s.id === 'demo');
    expect(demo?.name).toBe('演示空间');
    expect(spaces.find((s) => s.id === DEFAULT_SPACE)?.name).toBe('默认项目');
  });

  it('rejects invalid space ids', () => {
    const root = tmpRoot();
    expect(() => new Store(root, '../evil')).toThrow(/非法项目/);
    expect(() => new Store(root, 'a b')).toThrow(/非法项目/);
  });

  it('U3 读侧词面迁移：老档案写死的「默认空间」显示为「默认项目」，盘上档案不改写', () => {
    const root = tmpRoot();
    new Store(root);
    const p = path.join(root, 'spaces', DEFAULT_SPACE, 'profile.json');
    const prof = JSON.parse(fs.readFileSync(p, 'utf8')) as { name: string };
    prof.name = '默认空间';
    fs.writeFileSync(p, JSON.stringify(prof));
    expect(Store.listSpaces(root).find((s) => s.id === DEFAULT_SPACE)?.name).toBe('默认项目');
    expect((JSON.parse(fs.readFileSync(p, 'utf8')) as { name: string }).name).toBe('默认空间');
  });

  it('profile round-trips via readProfile/writeProfile', () => {
    const root = tmpRoot();
    const store = new Store(root, 'proj');
    const p = store.readProfile();
    p.rootCwd = '/some/repo';
    store.writeProfile(p);
    expect(new Store(root, 'proj').readProfile().rootCwd).toBe('/some/repo');
  });
});

// -- v13-S5 账本原子写与失败可见 -----------------------------------------------

describe('v13-S5 账本原子写与失败可见', () => {
  let errSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    Store.persistFailures = 0;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) as unknown as typeof errSpy;
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  const loggedPaths = (): string[] => errSpy.mock.calls.map((c) => String(c[0]));

  it('正常路径往返读写不破：覆盖写生效、无 tmp 残留、归档/反归档走同一 helper', () => {
    const root = tmpRoot();
    const store = new Store(root, 'alpha');
    const runsDir = path.join(root, 'spaces', 'alpha', 'runs');
    store.saveRun(runRecord('rt', '2026-01-01T00:00:00.000Z'));
    store.saveRun(runRecord('rt', '2026-02-02T00:00:00.000Z')); // tmp+rename 覆盖写
    expect(store.getRun('rt')?.startedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(fs.readdirSync(runsDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(Store.persistFailures).toBe(0);
    expect(store.archiveRun('rt')).toBe(true);
    expect(store.unarchiveRun('rt')?.startedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(store.getRun('rt')?.archived).toBe(false);
    expect(Store.persistFailures).toBe(0);
    expect(new Store(root, 'alpha').getRun('rt')).not.toBeNull(); // 新实例读盘一致
  });

  it('saveRun 写盘失败：旧账本仍完整可读 · persistFailures 递增 · console.error 带目标路径实账', () => {
    const root = tmpRoot();
    const store = new Store(root, 'alpha');
    const runsDir = path.join(root, 'spaces', 'alpha', 'runs');
    store.saveRun(runRecord('r1', '2026-01-01T00:00:00.000Z'));
    // 目录改只读：tmp 都开不出来——模拟 ENOSPC 一类的真实写失败
    fs.chmodSync(runsDir, 0o500);
    try {
      expect(() => store.saveRun(runRecord('r2', '2026-02-02T00:00:00.000Z'))).toThrow();
    } finally {
      fs.chmodSync(runsDir, 0o755);
    }
    expect(Store.persistFailures).toBe(1);
    expect(loggedPaths().some((m) => m.includes(path.join('runs', 'r2.json')))).toBe(true);
    // 原子性实证：失败只伤新写，旧账本分毫未动
    expect(store.getRun('r1')?.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(store.getRun('r2')).toBeNull();
    // 盘恢复后可继续正常写
    store.saveRun(runRecord('r2', '2026-02-02T00:00:00.000Z'));
    expect(store.getRun('r2')?.startedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(Store.persistFailures).toBe(1);
  });

  it('rename 顶不动目标（路径是目录）→ 残留 .tmp 物证计入 scanCorruptRuns 损坏信号', () => {
    const root = tmpRoot();
    const store = new Store(root, 'alpha');
    store.saveRun(runRecord('r1'));
    const target = path.join(root, 'spaces', 'alpha', 'runs', 'r1.json');
    fs.rmSync(target);
    fs.mkdirSync(target); // 同名目录挡位，rename 覆盖必失败
    expect(() => store.saveRun(runRecord('r1'))).toThrow();
    expect(Store.persistFailures).toBe(1);
    const tmps = fs
      .readdirSync(path.join(root, 'spaces', 'alpha', 'runs'))
      .filter((f) => f.endsWith('.tmp'));
    expect(tmps).toHaveLength(1); // tmp 刻意不删：写崩留痕
    expect(Store.scanCorruptRuns(root)).toEqual({ total: 1, spaces: [{ spaceId: 'alpha', count: 1 }] });
  });

  it('corruptRuns：坏 JSON/非对象结构/无 runId 均计数（含 archive/），按 spaceId 聚合；干净库=0 的正断言', () => {
    const root = tmpRoot();
    const a = new Store(root, 'alpha');
    const b = new Store(root, 'beta');
    a.saveRun(runRecord('ok1'));
    b.saveRun(runRecord('ok2'));
    fs.writeFileSync(path.join(root, 'spaces', 'alpha', 'runs', 'broken.json'), '{not-json');
    fs.writeFileSync(path.join(root, 'spaces', 'alpha', 'runs', 'arr.json'), '[1,2,3]');
    fs.writeFileSync(path.join(root, 'spaces', 'alpha', 'runs', 'no-runid.json'), '{"foo":1}');
    fs.mkdirSync(path.join(root, 'spaces', 'alpha', 'runs', 'archive'));
    fs.writeFileSync(path.join(root, 'spaces', 'alpha', 'runs', 'archive', 'gone.json'), 'garbage');
    expect(Store.scanCorruptRuns(root)).toEqual({ total: 4, spaces: [{ spaceId: 'alpha', count: 4 }] });
    // 干净库：spaces 目录在、扫过、零损坏 → 是 {total:0} 的正断言而不是 null
    const clean = tmpRoot();
    new Store(clean, 'alpha');
    expect(Store.scanCorruptRuns(clean)).toEqual({ total: 0, spaces: [] });
  });

  it('扫描本身拿不到 → null 而不是 []：spaces 目录缺失/无读取权限', () => {
    expect(Store.scanCorruptRuns(tmpRoot())).toBeNull(); // 全新空目录：没查过=查不了
    const root = tmpRoot();
    new Store(root, 'alpha');
    const spacesDir = path.join(root, 'spaces');
    fs.chmodSync(spacesDir, 0o000);
    try {
      expect(Store.scanCorruptRuns(root)).toBeNull();
    } finally {
      fs.chmodSync(spacesDir, 0o755);
    }
  });

  it('GET /api/health 透传两标量：persistFailures 内存计数 + corruptRuns 按空间聚合', async () => {
    const root = tmpRoot();
    const store = new Store(root, 'alpha');
    store.saveRun(runRecord('good'));
    fs.writeFileSync(path.join(root, 'spaces', 'alpha', 'runs', 'bad.json'), '{broken');
    const runsDir = path.join(root, 'spaces', 'alpha', 'runs');
    fs.chmodSync(runsDir, 0o500);
    try {
      store.saveRun(runRecord('boom'));
    } catch {
      /* 预期照抛：helper 已记实账 */
    } finally {
      fs.chmodSync(runsDir, 0o755);
    }
    const { app } = await buildHttpServer({
      engine: { onChange: () => {} } as unknown as Engine,
      store: {} as unknown as Store,
      ops: {} as unknown as HerdrOps,
      herdrSocketPath: path.join(root, 'herdr.sock'),
      dataDir: root,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:4310' } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { persistFailures?: unknown; corruptRuns?: unknown };
      expect(body.persistFailures).toBe(1);
      expect(body.corruptRuns).toEqual({ total: 1, spaces: [{ spaceId: 'alpha', count: 1 }] });
    } finally {
      await app.close();
    }
  });
});
