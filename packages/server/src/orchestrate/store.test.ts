import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, DEFAULT_SPACE } from './store.js';
import type { DagGraph, RunRecord } from '@paneflow/shared';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store-'));
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
