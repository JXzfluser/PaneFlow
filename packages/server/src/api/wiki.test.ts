import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import {
  appendWikiLog,
  checkRepoVisibility,
  latestAssertionResults,
  mergeWikiIndex,
  pickWikiExcerpts,
  publishableRun,
  readWikiPages,
  renderWikiPage,
  wikiCacheDir,
} from './wiki.js';

function greenRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-abc123',
    dagName: '修登录页样式',
    state: 'completed',
    cwd: '/work/app',
    spaceId: 'demo',
    startedAt: '2026-09-19T01:00:00.000Z',
    finishedAt: '2026-09-19T01:12:00.000Z',
    graph: { version: 1, name: 'g', nodes: [], edges: [] } as unknown as RunRecord['graph'],
    nodes: {
      impl: { nodeId: 'impl', state: 'done', attempts: 1, agentName: 'pi', artifact: { summary: '改了三处样式', extra: {} } as unknown as RunRecord['nodes'][string]['artifact'] },
      verify: {
        nodeId: 'verify',
        state: 'done',
        attempts: 1,
        agentName: 'claude',
        artifact: {
          summary: '全部通过',
          extra: {
            assertionResults: [
              { id: 'AC-1', status: 'ok', evidence: '截图比对无差' },
              { id: 'AC-2', status: 'ok', evidence: 'e2e 绿' },
            ],
          },
        } as unknown as RunRecord['nodes'][string]['artifact'],
      },
    },
    contract: {
      source: 'input',
      assertions: [
        { id: 'AC-1', assertion: '登录页在移动端不破版', verify_method: '截图' },
        { id: 'AC-2', assertion: 'e2e 登录用例绿', verify_method: '命令' },
      ],
    } as RunRecord['contract'],
    cost: { totalMs: 720_000, byNode: {}, retries: 0, tokens: null },
    ...over,
  } as RunRecord;
}

describe('v9-K1 + 首驾-llmwiki renderWikiPage（七字段 frontmatter + 分类目录 + 记账，纯函数）', () => {
  it('AC-1/AC-2：落 summaries/ 小写 slug；frontmatter 七字段齐 + pf-* 溯源 + 验收表 + [[双链]]', () => {
    const { file, markdown, indexEntry, logNote } = renderWikiPage(greenRun(), { repo: 'me/app', now: '2026-09-19T02:00:00Z' });
    expect(file).toBe('summaries/修登录页样式-abc123.md');
    expect(markdown).toContain('title: "修登录页样式（run run-abc123）"');
    expect(markdown).toContain('type: summary');
    expect(markdown).toContain('tags: [paneflow, run-record, demo]');
    expect(markdown).toContain('created: 2026-09-19T01:00:00.000Z');
    expect(markdown).toContain('updated: 2026-09-19T02:00:00Z');
    expect(markdown).toContain('sources: ["paneflow:run/run-abc123", "repo:me/app", "dag:修登录页样式"]');
    expect(markdown).toContain('confidence: high');
    expect(markdown).toContain('pf-run: run-abc123');
    expect(markdown).toContain('pf-repo: me/app');
    expect(markdown).toContain('pf-contract-source: input');
    expect(markdown).toContain('| AC-1 | 登录页在移动端不破版 | ✅ ok | 截图比对无差 |');
    expect(markdown).toContain('[[修登录页样式]]');
    expect(markdown).toContain('unknown（agent 未自报，不估算）');
    expect(markdown).toContain('改了三处样式');
    expect(indexEntry).toContain('](summaries/修登录页样式-abc123.md)');
    expect(indexEntry).toContain('2/2 条验收通过');
    expect(logNote).toContain('2026-09-19T02:00:00Z');
    expect(logNote).toContain('run `run-abc123`');
  });

  it('AC-1 缺省兜底 + AC-2 大小写：无契约/无断言 → confidence medium；英文标题洗成小写连字符', () => {
    const bare = greenRun({ contract: undefined, cost: undefined });
    bare.nodes.verify!.artifact!.extra = {};
    const { markdown } = renderWikiPage(bare, { repo: 'me/app', now: '2026-09-19T02:00:00Z' });
    expect(markdown).toContain('confidence: medium');
    expect(markdown).toContain('created: 2026-09-19T01:00:00.000Z');
    expect(markdown).toContain('sources: ["paneflow:run/run-abc123", "repo:me/app", "dag:修登录页样式"]');
    const eng = renderWikiPage(greenRun({ dagName: 'Fix Login Page!', spaceId: undefined }), { repo: 'me/app' });
    expect(eng.file).toBe('summaries/fix-login-page-abc123.md');
    expect(eng.markdown).toContain('tags: [paneflow, run-record]');
  });

  it('latestAssertionResults 取最后一份带结果的产物（终审覆盖自测）', () => {
    const run = greenRun();
    run.nodes.impl!.artifact!.extra = {
      assertionResults: [{ id: 'AC-1', status: 'fail', evidence: '初测未过' }],
    };
    expect(latestAssertionResults(run).find((x) => x.id === 'AC-1')!.status).toBe('ok');
  });
});

describe('首驾-llmwiki AC-3 index/log 记账（纯函数：新增 + 去重 + 只追加）', () => {
  const e1 = { file: 'summaries/a.md', line: '- [A](summaries/a.md) —— 摘要A' };
  const e2 = { file: 'summaries/b.md', line: '- [B](summaries/b.md) —— 摘要B' };

  it('mergeWikiIndex：空索引建头；新条目追加；同 file 重复沉淀原位替换不产生重复条目', () => {
    const first = mergeWikiIndex('', e1);
    expect(first).toContain('# 索引');
    const second = mergeWikiIndex(first, e2);
    expect(second).toContain('摘要A');
    expect(second).toContain('摘要B');
    const replaced = mergeWikiIndex(second, { file: e1.file, line: '- [A2](summaries/a.md) —— 新摘要' });
    expect(replaced).toContain('新摘要');
    expect(replaced).not.toContain('摘要A');
    expect(replaced.split('summaries/a.md').length - 1).toBe(1);
    expect(replaced).toContain('摘要B');
  });

  it('appendWikiLog：建头 + 旧记录逐字保留、只追加', () => {
    const first = appendWikiLog('', '- 2026-09-19T02:00:00Z · run `r1` → `summaries/a.md`');
    const second = appendWikiLog(first, '- 2026-09-20T02:00:00Z · run `r2` → `summaries/b.md`');
    expect(second).toContain('# 沉淀日志');
    expect(second.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
    expect(second.indexOf('r1')).toBeLessThan(second.indexOf('r2'));
  });
});

describe('v9-K3 publishableRun 门（宁缺毋滥）', () => {
  it('绿 + 断言全过 → ok；非 completed / 未验证产物 / 断言 fail / 缺 run 各拒并给原因', () => {
    expect(publishableRun(greenRun()).ok).toBe(true);
    expect(publishableRun(undefined).reason).toContain('找不到');
    expect(publishableRun(greenRun({ state: 'failed' })).reason).toContain('绿的单');
    const unverifiable = greenRun();
    unverifiable.nodes.impl!.unverified = true;
    expect(publishableRun(unverifiable).reason).toContain('兜底');
    const failedAssertion = greenRun();
    failedAssertion.nodes.verify!.artifact!.extra = {
      assertionResults: [{ id: 'AC-2', status: 'fail', evidence: '用例红' }],
    };
    expect(publishableRun(failedAssertion).reason).toContain('未过');
  });
});

describe('v9-K1 checkRepoVisibility', () => {
  const fakeFetch = (body: unknown, ok = true, status = 200) =>
    (async () =>
      ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;

  it('private:true → private；false → public；HTTP 失败抛错', async () => {
    expect(await checkRepoVisibility('a/b', 't', fakeFetch({ private: true }))).toBe('private');
    expect(await checkRepoVisibility('a/b', 't', fakeFetch({ private: false }))).toBe('public');
    await expect(checkRepoVisibility('a/b', 't', fakeFetch({ message: 'Bad credentials' }, false, 401))).rejects.toThrow('401');
  });
});

describe('v9-K2 + Issue #7 wiki 读回（只认主仓 llm-wiki/ 子树，嵌套+扁平混放兼容）', () => {
  it('readWikiPages 从缓存 llm-wiki/ 子树读 md；pickWikiExcerpts 按词命中打分、无命中原样返回空', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wiki-'));
    const repo = 'me/app';
    const cache = path.join(wikiCacheDir(dir, repo), 'llm-wiki');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(
      path.join(cache, '登录页样式修复.md'),
      '---\npf-run: x\n---\n\n# 登录页样式修复\n\n> 引用行不算正文\n\n正文第一段讲移动端破版的修法。',
    );
    fs.writeFileSync(path.join(cache, '无关页.md'), '---\n---\n\ndeployment notes here');
    const pages = readWikiPages(dir, repo);
    expect(pages).toHaveLength(2);
    const hit = pickWikiExcerpts(pages, '登录页 样式 又破版了 移动端');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.label).toContain('登录页样式修复.md');
    expect(hit[0]!.text).toContain('正文第一段');
    expect(hit[0]!.text).not.toContain('引用行');
    expect(pickWikiExcerpts(pages, '完全无关的zzq词')).toEqual([]);
    expect(readWikiPages(dir, 'no/such')).toEqual([]);
  });

  it('AC-4：llm-wiki/ 下混放 summaries/ 嵌套页与扁平页——列全不抛错，index/log 记账不进摘录池；缓存根散页不算数', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wiki-mix-'));
    const repo = 'me/app';
    const cache = wikiCacheDir(dir, repo);
    const root = path.join(cache, 'llm-wiki');
    fs.mkdirSync(path.join(root, 'summaries'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'summaries', '部署-checkout-流-ab12cd.md'),
      '---\ntitle: "部署 checkout 流（run r-9）"\ntype: summary\n---\n\n# 部署 checkout 流\n\n正文讲 checkout 部署的踩坑与修法。',
    );
    fs.writeFileSync(path.join(root, '旧扁平沉淀页.md'), '---\npf-run: old\n---\n\n旧页正文也讲 checkout 流程。');
    fs.writeFileSync(path.join(root, 'index.md'), '# 索引\n\n- [部署 checkout 流](summaries/部署-checkout-流-ab12cd.md) —— 摘要');
    fs.writeFileSync(path.join(root, 'log.md'), '# 沉淀日志\n\n- 2026-09-19T02:00:00Z · run `r-9` → `summaries/部署-checkout-流-ab12cd.md`');
    // 缓存根（llm-wiki/ 外）散落的仓内文档不参与读回
    fs.writeFileSync(path.join(cache, 'README.md'), '# 主仓 README\n\ncheckout 流程说明。');
    const pages = readWikiPages(dir, repo);
    expect(pages.map((p) => p.file).sort()).toEqual(['summaries/部署-checkout-流-ab12cd.md', '旧扁平沉淀页.md']);
    expect(pages.find((p) => p.file.startsWith('summaries/'))!.title).toBe('部署 checkout 流（run r-9）');
    const hits = pickWikiExcerpts(pages, 'checkout 部署 流程');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.label.includes('summaries/'))).toBe(true);
  });
});

// -- 路由门：无凭据 400 / 非绿 400 / public 未确认 409（真 push 链路留实机） ----
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import { vi } from 'vitest';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wikirt-'));
}

function buildServer(dataDir: string, run: RunRecord | undefined) {
  return buildHttpServer({
    engine: { onChange: () => {}, getRun: () => run } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    // U2：不注入的话无存储 PAT 用例会真调本机 gh——固定为未登录，保 400 门可测
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
  });
}

describe('v9-K1 POST /api/wiki/publish 路由门', () => {
  it('无凭据 400；非绿 400；公开仓未确认 409（含 needsConfirm），确认文案对全世界可读', async () => {
    const dir = tmpDir();
    const { app } = await buildServer(dir, undefined);
    try {
      const r = await app.inject({ method: 'POST', url: '/api/wiki/publish', payload: { runId: 'x' } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain('凭据');
    } finally {
      await app.close();
    }
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ token: 'ghp_t', defaultRepo: 'me/app' }));
    const { app: app2 } = await buildServer(dir, greenRun({ state: 'running' }));
    try {
      const r = await app2.inject({ method: 'POST', url: '/api/wiki/publish', payload: { runId: 'x' } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain('绿的单');
    } finally {
      await app2.close();
    }
    vi.stubGlobal('fetch', (async () => ({ ok: true, status: 200, json: async () => ({ private: false }) })) as unknown as typeof fetch);
    const { app: app3 } = await buildServer(dir, greenRun());
    try {
      const r = await app3.inject({ method: 'POST', url: '/api/wiki/publish', payload: { runId: 'run-abc123' } });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ needsConfirm: true, visibility: 'public' });
      expect(r.json().error).toContain('对全世界可读');
    } finally {
      await app3.close();
      vi.unstubAllGlobals();
    }
  });
});
