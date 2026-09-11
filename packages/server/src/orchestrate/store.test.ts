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
  it('migrates legacy flat layout into the default space once', () => {
    const root = tmpRoot();
    // legacy flat layout
    fs.mkdirSync(path.join(root, 'templates'));
    fs.mkdirSync(path.join(root, 'runs'));
    fs.writeFileSync(path.join(root, 'templates', 'old.json'), JSON.stringify(graph('old')));
    fs.writeFileSync(path.join(root, 'runs', 'r1.json'), JSON.stringify({ runId: 'r1' }));

    const store = new Store(root); // triggers migration
    expect(store.getGraph('old')?.name).toBe('old');
    expect(fs.existsSync(path.join(root, 'spaces', DEFAULT_SPACE, 'templates', 'old.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'templates'))).toBe(false); // legacy removed
    // second construction must not double-migrate or fail
    new Store(root);
    expect(store.listGraphs()).toHaveLength(1);
  });

  it('isolates templates and runs per space', () => {
    const root = tmpRoot();
    const a = new Store(root, 'alpha');
    const b = new Store(root, 'beta');
    a.saveGraph(graph('only-in-alpha'));
    expect(a.getGraph('only-in-alpha')).not.toBeNull();
    expect(b.getGraph('only-in-alpha')).toBeNull();
    const run = { runId: 'r9', state: 'completed' } as unknown as RunRecord;
    a.saveRun(run);
    expect(a.getRun('r9')).not.toBeNull();
    expect(b.getRun('r9')).toBeNull();
    expect(new Store(root).listRuns()).toEqual([]); // default space unaffected
  });

  it('lists spaces with profiles and creates named spaces', () => {
    const root = tmpRoot();
    new Store(root); // default materialized
    Store.createSpace(root, 'demo', '演示空间');
    const spaces = Store.listSpaces(root);
    const demo = spaces.find((s) => s.id === 'demo');
    expect(demo?.name).toBe('演示空间');
    expect(spaces.find((s) => s.id === DEFAULT_SPACE)?.name).toBe('默认空间');
  });

  it('rejects invalid space ids', () => {
    const root = tmpRoot();
    expect(() => new Store(root, '../evil')).toThrow(/非法空间/);
    expect(() => new Store(root, 'a b')).toThrow(/非法空间/);
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
