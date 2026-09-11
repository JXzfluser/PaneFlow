import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDag } from '@paneflow/shared';
import { BUILTIN_TEMPLATES, seedBuiltinTemplates } from './builtin-templates.js';
import { Store } from './store.js';

describe('builtin templates', () => {
  it('contains six scenario templates, all passing DAG validation', () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(6);
    for (const t of BUILTIN_TEMPLATES) {
      const issues = validateDag(t).filter((i) => i.level === 'error');
      expect(issues, `${t.name}: ${issues.map((i) => i.message).join(';')}`).toEqual([]);
    }
  });

  it('every agent node has agentKind and prompt; fanin uses requireAll not onFail', () => {
    for (const t of BUILTIN_TEMPLATES) {
      for (const n of t.nodes) {
        if (n.type === 'agent') {
          expect(n.config.agentKind, `${t.name}/${n.id}`).toBeTruthy();
          expect(n.config.prompt, `${t.name}/${n.id}`).toBeTruthy();
        }
        if (n.type === 'fanin') expect(n.config.onFail).toBeUndefined();
      }
    }
  });

  it('blackboard references in prompts point at real upstream node ids', () => {
    const ref = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)/g;
    for (const t of BUILTIN_TEMPLATES) {
      const ids = new Set(t.nodes.map((n) => n.id));
      for (const n of t.nodes) {
        for (const m of n.config.prompt?.matchAll(ref) ?? []) {
          expect(ids.has(m[1]!), `${t.name}/${n.id} 引用了不存在的节点 ${m[1]}`).toBe(true);
        }
      }
    }
  });

  it('seeds idempotently and never overwrites user edits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-seed-'));
    const store = new Store(dir);
    const seed = () => seedBuiltinTemplates((id) => store.getGraph(id), (g) => store.saveGraph(g));
    expect(seed()).toHaveLength(6);
    expect(seed()).toEqual([]); // second boot: nothing new
    // user edits a builtin → third boot must not clobber it
    const edited = store.getGraph('builtin-standard-dev-flow')!;
    edited.nodes[1]!.label = '用户改过的名字';
    store.saveGraph(edited);
    expect(seed()).toEqual([]);
    expect(store.getGraph('builtin-standard-dev-flow')!.nodes[1]!.label).toBe('用户改过的名字');
  });
});
