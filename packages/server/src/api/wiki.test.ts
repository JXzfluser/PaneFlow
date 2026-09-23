import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import {
  aggregateWikiCitations,
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

  it('v11-C3b：citations 命中本页 file → frontmatter 带 pf-cited-by；未命中/未传一律省略键', () => {
    const cited = renderWikiPage(greenRun(), {
      repo: 'me/app',
      citations: { 'summaries/修登录页样式-abc123.md': ['r-1', 'r-2'], '别的页.md': ['r-x'] },
    });
    expect(cited.markdown).toContain('pf-cited-by: r-1, r-2');
    expect(cited.markdown).not.toContain('r-x');
    const bare = renderWikiPage(greenRun(), { repo: 'me/app', citations: { '其他.md': ['r-9'] } });
    expect(bare.markdown).not.toContain('pf-cited-by');
    expect(renderWikiPage(greenRun(), { repo: 'me/app' }).markdown).not.toContain('pf-cited-by');
  });
});

// -- v11-C3b 引用回链聚合纯函数（读时算、零写路径；路由面断言见 http-wiki-state.test.ts） ----
describe('v11-C3b aggregateWikiCitations（per-run set 去重 / repo 隔离 / 空留痕弃）', () => {
  it('同 run 多节点引同一页只记 1 次；无节点留痕不入 citedRunCount', () => {
    const runs = [
      {
        runId: 'r1',
        wikiReadback: {
          repo: 'me/app',
          nodes: [
            { nodeId: 'plan', pages: [{ file: 'x.md', title: 'X' }] },
            { nodeId: 'impl', pages: [{ file: 'x.md', title: 'X' }] },
          ],
        },
      },
      { runId: 'r2', wikiReadback: { repo: 'me/app', nodes: [] } },
    ] as unknown as RunRecord[];
    const idx = aggregateWikiCitations(runs, 'me/app');
    expect(idx.byFile).toEqual({ 'x.md': ['r1'] });
    expect(idx.citedRunCount).toBe(1);
  });

  it('repo 隔离：file 同名也不串仓；缺留痕的 run 忽略；runId 输出字典序稳定', () => {
    const runs = [
      { runId: 'b', wikiReadback: { repo: 'me/app', nodes: [{ nodeId: 'n', pages: [{ file: 'x.md', title: '' }] }] } },
      { runId: 'a', wikiReadback: { repo: 'other/repo', nodes: [{ nodeId: 'n', pages: [{ file: 'x.md', title: '' }] }] } },
      { runId: 'c' },
    ] as unknown as RunRecord[];
    expect(aggregateWikiCitations(runs, 'me/app')).toEqual({ byFile: { 'x.md': ['b'] }, citedRunCount: 1 });
    expect(aggregateWikiCitations([], 'me/app')).toEqual({ byFile: {}, citedRunCount: 0 });
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

  it('v11-C2 正门 fail-closed：断言 0 条通过一律拒（没跑≠绿），≥1 条 ok 才放行', () => {
    // 首驾 ba2751bf 钻空场景：completed 但 0/6 断言「没跑」——无断言行照拒
    const neverRan = greenRun();
    neverRan.nodes.verify!.artifact!.extra = {};
    const v1 = publishableRun(neverRan);
    expect(v1.ok).toBe(false);
    expect(v1.reason).toContain('断言没跑≠绿');
    expect(v1.reason).toContain('没有跑过任何验收断言');
    // 只有 n/a（等价没跑）也拒
    const allNa = greenRun();
    allNa.nodes.verify!.artifact!.extra = {
      assertionResults: [
        { id: 'AC-1', status: 'n/a', evidence: '没法验' },
        { id: 'AC-2', status: 'n/a', evidence: '跳过' },
      ],
    };
    const v2 = publishableRun(allNa);
    expect(v2.ok).toBe(false);
    expect(v2.reason).toContain('0 条实打实通过');
    expect(v2.reason).toContain('断言没跑≠绿');
    // 1 ok + 1 n/a：有实打实通过的行，放行（宁缺毋滥门对部分绿仍由 fail 判据把住）
    const oneOk = greenRun();
    oneOk.nodes.verify!.artifact!.extra = {
      assertionResults: [
        { id: 'AC-1', status: 'ok', evidence: '截图无差' },
        { id: 'AC-2', status: 'n/a', evidence: '环境缺 e2e' },
      ],
    };
    expect(publishableRun(oneOk).ok).toBe(true);
  });

  it('v11-C2 completed-with-failures：正门拒并指路侧门', () => {
    const v = publishableRun(greenRun({ state: 'completed-with-failures' }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('completed-with-failures');
    expect(v.reason).toContain('counterexample');
  });

  it('v11-C2 反面教材侧门两向：failed / completed-with-failures 可走；绿单不许走侧门', () => {
    // 侧门收 failed（哪怕 0 条断言跑过——教训不要求绿）
    const failed = greenRun({ state: 'failed' });
    failed.nodes.verify!.artifact!.extra = {
      assertionResults: [{ id: 'AC-2', status: 'fail', evidence: '用例红' }],
    };
    expect(publishableRun(failed, 'counterexample').ok).toBe(true);
    // 正门对它关着（两向之一：failed 进不了正门）
    expect(publishableRun(failed).ok).toBe(false);
    // 侧门收 completed-with-failures
    expect(publishableRun(greenRun({ state: 'completed-with-failures' }), 'counterexample').ok).toBe(true);
    // 两向之二：能过正门的绿单不许走侧门（只准进侧门不准混进正门的对偶——反例标签不许贴正页）
    const cwGreen = publishableRun(greenRun(), 'counterexample');
    expect(cwGreen.ok).toBe(false);
    expect(cwGreen.reason).toContain('正门');
    // running 之类的中间态两边都进不去
    expect(publishableRun(greenRun({ state: 'running' }), 'counterexample').reason).toContain('侧门');
    expect(publishableRun(undefined, 'counterexample').reason).toContain('找不到');
  });
});

describe('v11-C2 反面教材侧门页三特征（frontmatter low / 正文首行警示 / index ⚠）', () => {
  function failedRun() {
    const run = greenRun({ runId: 'run-fail99', state: 'failed' });
    run.nodes.verify!.artifact!.extra = {
      assertionResults: [
        { id: 'AC-1', status: 'ok', evidence: '自测过了' },
        { id: 'AC-2', status: 'fail', evidence: '终审红：processed=1 < 2' },
      ],
    };
    return run;
  }

  it('特征一+二+三齐；断言表/记账面复用不变', () => {
    const { file, markdown, indexEntry, logNote } = renderWikiPage(failedRun(), {
      repo: 'me/app',
      now: '2026-09-19T03:00:00Z',
      kind: 'counterexample',
    });
    // 一：frontmatter confidence: low + counterexample 标签
    expect(markdown).toContain('confidence: low');
    expect(markdown).toContain('tags: [paneflow, run-record, demo, counterexample]');
    // 二：正文页首一行固定警示
    const body = markdown.replace(/^---[\s\S]*?---\n+/, '');
    expect(body.split('\n')[0]).toMatch(/^> ⚠ 反面教材/);
    // 三：index 条目 ⚠ 前缀，条目面复用（`](file)` 仍在，mergeWikiIndex 去重语义不变）
    expect(indexEntry.startsWith('- ⚠ [')).toBe(true);
    expect(indexEntry).toContain(`](${file})`);
    expect(mergeWikiIndex('- ⚠ [旧](summaries/x.md) —— a', { file: 'summaries/y.md', line: indexEntry })).toContain('⚠');
    // 同页重复沉淀：index 按 file 原位替换，不产生第二条 ⚠ 条目
    const again = `- ⚠ [再沉淀](${file}) —— 1/2 条验收通过（重发）`;
    const dedup = mergeWikiIndex(`${indexEntry}\n`, { file, line: again });
    expect(dedup.split(`](${file})`).length - 1).toBe(1);
    expect(dedup).toContain('重发');
    expect(dedup).not.toContain('run `run-fail99`，');
    // log 照记（同面）
    expect(logNote).toContain('run `run-fail99`');
    expect(logNote).toContain('1/2 条验收通过');
    // 同风格：断言表把 fail 摆在页上
    expect(markdown).toContain('❌ fail');
  });

  it('正门页（缺省 kind）三特征一概不带——旧行为零回归', () => {
    const { markdown, indexEntry } = renderWikiPage(greenRun(), { repo: 'me/app' });
    expect(markdown).toContain('confidence: high');
    expect(markdown).not.toContain('⚠');
    expect(indexEntry.startsWith('- ⚠')).toBe(false);
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

// -- v11-C2 路由侧门门：kind 解析 + 两向校验（真 push 链路仍留实机，门在可见性检查前） ----
describe('v11-C2 POST /api/wiki/publish kind 门', () => {
  async function inject(dir: string, run: RunRecord, payload: Record<string, unknown>) {
    const { app } = await buildServer(dir, run);
    try {
      return await app.inject({ method: 'POST', url: '/api/wiki/publish', payload });
    } finally {
      await app.close();
    }
  }

  it('0-pass 拒正门；failed 进不了正门/能过侧门校验；绿单不许走侧门；非法 kind 400', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ token: 'ghp_t', defaultRepo: 'me/app' }));
    // 正门 fail-closed：completed 但断言一条没跑 → 400「断言没跑≠绿」
    const neverRan = greenRun();
    neverRan.nodes.verify!.artifact!.extra = {};
    const r1 = await inject(dir, neverRan, { runId: 'run-abc123' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toContain('断言没跑≠绿');
    // failed 走正门 → 400（两向之一）
    const failed = greenRun({ state: 'failed' });
    const r2 = await inject(dir, failed, { runId: 'run-abc123' });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toContain('绿的单');
    // failed 走侧门：过门校验，随后撞可见性查询（fetch stub private 后才会真 push——这里只 stub 401，
    // 证明门已放行、请求推进到可见性步）——两向之二
    vi.stubGlobal('fetch', (async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'Bad credentials' })) as unknown as typeof fetch);
    try {
      const r3 = await inject(dir, failed, { runId: 'run-abc123', kind: 'counterexample' });
      expect(r3.statusCode).toBe(502); // 门已过，死于查可见性（零真 git/网络推送）
      expect(r3.json().error).toContain('查仓库可见性失败');
    } finally {
      vi.unstubAllGlobals();
    }
    // 绿单不许走侧门（只准进侧门不准进正门的对偶互斥校验）
    const r4 = await inject(dir, greenRun(), { runId: 'run-abc123', kind: 'counterexample' });
    expect(r4.statusCode).toBe(400);
    expect(r4.json().error).toContain('正门');
    // 非法 kind
    const r5 = await inject(dir, greenRun(), { runId: 'run-abc123', kind: 'lesson' });
    expect(r5.statusCode).toBe(400);
    expect(r5.json().error).toContain('counterexample');
  });
});
// -- v11-C2 读回降权：confidence: low 页排序靠后但不丢；旧页无 confidence 视为正页 ----
describe('v11-C2 wiki 读回降权（反面教材页排序靠后、唯一反例不丢、旧页兼容）', () => {
  const page = (file: string, title: string, text: string, confidence?: string) => ({ file, title, text, confidence });

  it('同分正页优先；低分正页仍压过高命中反例（折半降权）；只有一页反例照样入选且 label 明示', () => {
    const green = page('summaries/g.md', '登录页样式', '登录页 登录页 样式 修法讲登录页样式。');
    const counter = page('summaries/c.md', '登录页样式', '登录页 登录页 样式 教训讲登录页样式。', 'low');
    // 同分：正页在前
    const same = pickWikiExcerpts([counter, green], '登录页 样式', 2);
    expect(same.map((h) => h.label)).toEqual(['wiki 沉淀页（summaries/g.md）', expect.stringContaining('反面教材')]);
    // 反例命中更多（多次出现）也被折半压到正页后
    const noisyCounter = page('summaries/c2.md', '登录页样式', '登录页 登录页 登录页 登录页 登录页 登录页 登录页 登录页 样式。', 'low');
    const weakGreen = page('summaries/g2.md', '登录页', '正文：登录页 登录页 登录页 登录页 样式。');
    const mixed = pickWikiExcerpts([noisyCounter, weakGreen], '登录页 样式', 2);
    expect(mixed[0]!.label).toContain('summaries/g2.md');
    expect(mixed[1]!.label).toContain('反面教材');
    expect(mixed[1]!.label).toContain('勿照抄');
    // 只有一页反例：别丢——它可能就是唯一相关经验
    const only = pickWikiExcerpts([counter], '登录页 样式');
    expect(only).toHaveLength(1);
    expect(only[0]!.label).toContain('summaries/c.md');
    // 无命中的反例照旧宁缺毋滥
    expect(pickWikiExcerpts([counter], '完全无关的zzq词')).toEqual([]);
  });

  it('readWikiPages 写/兼容读：新页 confidence 入字段；旧页（无 confidence/无 frontmatter 键）视为正页不降权', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wiki-low-'));
    const repo = 'me/app';
    const root = path.join(wikiCacheDir(dir, repo), 'llm-wiki');
    fs.mkdirSync(path.join(root, 'summaries'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'summaries', '登录页样式-反例-ab12cd.md'),
      '---\ntitle: "踩坑（run r-1）"\nconfidence: low\ntags: [paneflow, run-record, counterexample]\n---\n\n> ⚠ 反面教材：带失败收口。\n\n# 踩坑\n\n正文：登录页样式的失败教训。',
    );
    fs.writeFileSync(
      path.join(root, 'summaries', '登录页样式-正例-ef3456.md'),
      '---\ntitle: "绿单（run r-2）"\nconfidence: high\n---\n\n# 绿单\n\n正文：登录页样式的成功修法。',
    );
    // 旧页：Issue #6 时代 frontmatter 没有 confidence——兼容读，视为正页
    fs.writeFileSync(
      path.join(root, '旧扁平沉淀页.md'),
      '---\ntitle: "旧页（run r-0）"\n---\n\n旧页正文也讲登录页样式。',
    );
    const pages = readWikiPages(dir, repo);
    expect(pages.find((p) => p.file.includes('反例'))!.confidence).toBe('low');
    expect(pages.find((p) => p.file.includes('正例'))!.confidence).toBe('high');
    expect(pages.find((p) => p.file === '旧扁平沉淀页.md')!.confidence).toBeUndefined();
    // 反例与旧页同分：旧页（正页面）排前，反例排后但不丢
    const hits = pickWikiExcerpts(pages, '登录页 样式', 3);
    expect(hits).toHaveLength(3);
    expect(hits[2]!.label).toContain('反例');
    expect(hits.slice(0, 2).every((h) => !h.label.includes('反面教材'))).toBe(true);
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
    engine: { onChange: () => {}, getRun: () => run, listRuns: () => [] } as unknown as Engine,
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
