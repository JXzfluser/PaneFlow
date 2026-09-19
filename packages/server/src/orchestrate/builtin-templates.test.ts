import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyVariables, lintUnresolvedRefs, validateDag } from '@paneflow/shared';
import { BUILTIN_TEMPLATES, seedBuiltinTemplates } from './builtin-templates.js';
import { Store } from './store.js';

describe('builtin templates', () => {
  it('contains nine built-in templates, all passing DAG validation', () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(9);
    for (const t of BUILTIN_TEMPLATES) {
      const issues = validateDag(t).filter((i) => i.level === 'error');
      expect(issues, `${t.name}: ${issues.map((i) => i.message).join(';')}`).toEqual([]);
    }
  });

  it('every agent node has a prompt and no钉死 agentKind（AE：类型交给解析链）; fanin uses requireAll not onFail', () => {
    for (const t of BUILTIN_TEMPLATES) {
      for (const n of t.nodes) {
        if (n.type === 'agent') {
          expect(n.config.agentKind, `${t.name}/${n.id}`).toBeUndefined();
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
      const declaredVars = new Set((t.variables ?? []).map((v) => v.key));
      for (const n of t.nodes) {
        for (const m of n.config.prompt?.matchAll(ref) ?? []) {
          if (m[1] === 'item') continue; // 动态扇出的条目变量，非节点引用
          if (declaredVars.has(m[1]!)) continue; // 已声明的模板变量
          expect(ids.has(m[1]!), `${t.name}/${n.id} 引用了不存在的节点 ${m[1]}`).toBe(true);
        }
      }
    }
  });

  it('G2 输入面闭环：变量填值后 lint 无未解析引用（含 label/嵌套字段）', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const values: Record<string, string> = { run_id: 'abc12345' };
      for (const v of t.variables ?? []) values[v.key] = v.default ?? '测试输入';
      const { graph, missing } = applyVariables(t, values);
      expect(missing, `${t.name}: 必填变量未覆盖`).toEqual([]);
      expect(lintUnresolvedRefs(graph), `${t.name} 有未解析 {{}}`).toEqual([]);
    }
  });

  it('G2 无死声明：每个声明的变量都在模板某处被 {{引用}}', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const hay = JSON.stringify({ ...t, variables: undefined });
      for (const v of t.variables ?? []) {
        expect(hay.includes(`{{${v.key}}}`), `${t.name} 声明了未使用的变量 ${v.key}`).toBe(true);
      }
    }
  });

  it('seeds idempotently and never overwrites user edits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-seed-'));
    const store = new Store(dir);
    const seed = () => seedBuiltinTemplates((id) => store.getGraph(id), (g) => store.saveGraph(g));
    expect(seed()).toHaveLength(9);
    expect(seed()).toEqual([]); // second boot: nothing new
    // user edits a builtin → third boot must not clobber it
    const edited = store.getGraph('builtin-standard-dev-flow')!;
    edited.nodes[1]!.label = '用户改过的名字';
    store.saveGraph(edited);
    expect(seed()).toEqual([]);
    expect(store.getGraph('builtin-standard-dev-flow')!.nodes[1]!.label).toBe('用户改过的名字');
  });
});
