import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_CONTRACT_TEMPLATES,
  appendTemplateFeedback,
  loadContractLibrary,
  matchContractTemplate,
  renderContractTemplateBlock,
  templateSha,
  type ContractTemplate,
} from './contract-templates.js';

/** v8-M6 契约模板与断言语式库：模板=空间文本资产，可覆盖内置、命中选择、实例化渲染、判例回流 */

function spaceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ct-'));
}

describe('v8-M6 契约骨架模板（a）', () => {
  it('内置种子骨架齐活且形状合法（id/标题/断言面/提问）', () => {
    const ids = BUILTIN_CONTRACT_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('bugfix');
    expect(ids).toContain('docs');
    expect(ids).toContain('generic');
    for (const t of BUILTIN_CONTRACT_TEMPLATES) {
      expect(t.assertions.length).toBeGreaterThan(1);
      expect(t.questions.length).toBeGreaterThan(0);
    }
  });

  it('templateSha 稳定且随内容变（留痕 id@sha 的前提）', () => {
    const t = BUILTIN_CONTRACT_TEMPLATES[0]!;
    expect(templateSha(t)).toBe(templateSha(structuredClone(t)));
    const edited: ContractTemplate = { ...t, assertions: [...t.assertions, { assertion: '新增一条', verify_method: 'v' }] };
    expect(templateSha(edited)).not.toBe(templateSha(t));
  });

  it('空间文件按 id 覆盖内置模板；保留文件不混入模板清单', () => {
    const dir = spaceDir();
    const td = path.join(dir, 'contract-templates');
    fs.mkdirSync(td, { recursive: true });
    const mine: ContractTemplate = {
      id: 'bugfix',
      title: '缺陷修复（本队版）',
      matchKeywords: ['bug', '修复'],
      assertions: [{ assertion: '自定断言一', verify_method: 'v1' }, { assertion: '自定断言二', verify_method: 'v2' }],
      questions: ['自定提问？'],
    };
    fs.writeFileSync(path.join(td, 'bugfix.json'), JSON.stringify(mine));
    fs.writeFileSync(path.join(td, 'team-only.json'), JSON.stringify({ ...mine, id: 'team-only', title: '队内类型' }));
    fs.writeFileSync(path.join(td, 'assertion-patterns.json'), JSON.stringify(['「X 在 Y 下仍可得结果」']));
    fs.writeFileSync(path.join(td, 'clarify-questions.json'), JSON.stringify(['灰度范围？']));
    fs.writeFileSync(path.join(td, 'broken.json'), '{不是 json');

    const lib = loadContractLibrary(dir);
    const bugfix = lib.templates.find((t) => t.template.id === 'bugfix')!;
    expect(bugfix.source).toBe('space');
    expect(bugfix.template.title).toBe('缺陷修复（本队版）');
    expect(lib.templates.find((t) => t.template.id === 'docs')!.source).toBe('builtin');
    expect(lib.templates.find((t) => t.template.id === 'team-only')).toBeTruthy();
    expect(lib.assertionPatterns).toEqual(['「X 在 Y 下仍可得结果」']);
    expect(lib.clarifyQuestions).toEqual(['灰度范围？']);
  });

  it('matchContractTemplate：关键词命中最多者胜；零命中返回 null（宁缺毋滥）', () => {
    const lib = loadContractLibrary(spaceDir());
    expect(matchContractTemplate('修复登录页崩溃的 bug，附报错日志', lib)?.template.id).toBe('bugfix');
    expect(matchContractTemplate('整理部署手册文档', lib)?.template.id).toBe('docs');
    expect(matchContractTemplate('给官网换个配色', lib)).toBeNull();
  });

  it('渲染实例化指令块：含骨架断言面、id@sha 留痕要求与语式库引用', () => {
    const dir = spaceDir();
    const td = path.join(dir, 'contract-templates');
    fs.mkdirSync(td, { recursive: true });
    fs.writeFileSync(path.join(td, 'assertion-patterns.json'), JSON.stringify(['句式甲']));
    const lib = loadContractLibrary(dir);
    const hit = matchContractTemplate('修复崩溃 bug', lib)!;
    const block = renderContractTemplateBlock(hit, lib);
    expect(block).toContain(`「${hit.template.id}@${hit.sha}」`);
    expect(block).toContain('复现步骤在修复后不再触发原症状');
    expect(block).toContain('句式甲');
    expect(block).toContain(`"template": "${hit.template.id}@${hit.sha}"`);
  });
});

describe('v8-M6 判例回流', () => {
  it('门内被追问/拒绝的内容追加为 JSONL 判例（含模板戳），失败不抛出', () => {
    const dir = spaceDir();
    appendTemplateFeedback(dir, { kind: 'negotiate', runId: 'r1', nodeId: 'planner', template: 'bugfix@aaa', note: '把 AC-2 改具体' });
    appendTemplateFeedback(dir, { kind: 'reject', runId: 'r1', nodeId: 'planner', template: null, assertions: ['AC-1: x'] });
    const lines = fs.readFileSync(path.join(dir, 'contract-feedback.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBe(2);
    expect(lines[0]!.kind).toBe('negotiate');
    expect(lines[0]!.template).toBe('bugfix@aaa');
    expect(lines[1]!.kind).toBe('reject');
    expect(lines[0]!.at).toBeTruthy();
    // 目录不存在时静默（回流不是执行路径）
    expect(() => appendTemplateFeedback(path.join(dir, 'ghost', 'deep'), { kind: 'x' })).not.toThrow();
  });
});

describe('v8-M6 GET /api/contract-templates', () => {
  it('列内置骨架 + 空间文件位置（文本资产可改的入口提示）', async () => {
    const { buildHttpServer } = await import('../api/http.js');
    const { Store } = await import('./store.js');
    const dataDir = spaceDir();
    const engine = { onChange: () => {}, listRuns: () => [], getRun: () => undefined } as never;
    const { app } = await buildHttpServer({
      engine,
      store: new Store(dataDir),
      ops: {} as never,
      herdrSocketPath: path.join(dataDir, 'herdr.sock'),
      dataDir,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/contract-templates', headers: { host: '127.0.0.1:4310' } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { dir: string; templates: { id: string; sha: string; source: string }[] };
      expect(body.templates.map((t) => t.id)).toEqual(['bugfix', 'docs', 'generic']);
      expect(body.templates[0]!.sha).toMatch(/^[0-9a-f]{8}$/);
      expect(body.dir).toBe(path.join(dataDir, 'spaces', 'default', 'contract-templates'));
    } finally {
      await app.close();
    }
  });
});
