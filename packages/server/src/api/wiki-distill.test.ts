import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import {
  autoDistillEnabled,
  autoDistillRun,
  buildDistillPreview,
  distillEntries,
  distillRunBrief,
  listConceptPages,
  matchConceptPage,
  parseDistillReply,
  planDistill,
  type ConceptPage,
} from './wiki-distill.js';
import { mergeWikiIndex, publishWikiPages, readWikiPages, wikiCacheDir } from './wiki.js';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

// 真实 git/网络全 mock：execFile/execFileSync 只记账不执行（发布路的 commit 面靠 fs + 调用记录断言）；
// failPush>0 可脚本化「push 被远端前移」的前 N 次失败，验证重试语义。
const h = vi.hoisted(() => ({
  gitCalls: [] as { cmd: string; args: string[] }[],
  failPush: 0,
}));
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    h.gitCalls.push({ cmd, args: args.map(String) });
    if (String(args[0]) === 'push' && h.failPush > 0) {
      h.failPush--;
      process.nextTick(() => cb(new Error('git push 失败：rejected (fetch first)'), '', ''));
      return;
    }
    process.nextTick(() => cb(null, '', ''));
  },
  execFileSync: () => '',
}));

function tmpDir(prefix = 'pf-distill-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
    wikiReadback: { repo: 'me/app', nodes: [{ nodeId: 'impl', pages: [{ file: 'summaries/旧单-def456.md', title: '旧单' }] }] },
    ...over,
  } as RunRecord;
}

/** 网关配置写盘（含密钥字段仅本地 tmp，测直连 URL/模型解析） */
function seedGateway(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'gateway.json'),
    JSON.stringify({
      profiles: [{ id: 'default', name: '默认档', baseUrl: 'https://gw.test/v1', apiKey: 'sk-test', freeModel: 'test-free', enabled: true }],
      current: 'default',
    }),
  );
}

const chatStubs: { urls: string[]; bodies: string[] } = { urls: [], bodies: [] };

function chatFetch(content: string, opts: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async (_url: unknown, init?: unknown) => {
    chatStubs.urls.push(String(_url));
    chatStubs.bodies.push(String((init as { body?: string } | undefined)?.body ?? ''));
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
}

const noSync = async () => ({ branch: 'main' });

// ---------------------------------------------------------------------------
// 纯函数蒸馏核：planDistill / matchConceptPage
// ---------------------------------------------------------------------------

describe('v11-C1 planDistill 纯函数核（命中→改写；未命中→新建；去重；记账面）', () => {
  const run = greenRun();

  it('未命中 → 新建 concepts/<slug>.md：type concept + 七字段 + 经验条目 + index/log 记账', () => {
    const ops = planDistill({
      run,
      repo: 'me/app',
      entries: [{ topic: '重试退避策略', statement: '429 退避必须指数递增加抖动，本单实测把网关重试失败率从 12% 降到 0（AC-2 e2e 证据）' }],
      existing: [],
      now: '2026-09-19T02:00:00.000Z',
    });
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.action).toBe('create');
    expect(op.file).toBe('concepts/重试退避策略.md');
    expect(op.markdown).toContain('type: concept');
    expect(op.markdown).toContain('title: "重试退避策略"');
    expect(op.markdown).toContain('created: 2026-09-19T02:00:00.000Z');
    expect(op.markdown).toContain('updated: 2026-09-19T02:00:00.000Z');
    expect(op.markdown).toContain('sources: ["paneflow:run/run-abc123", "repo:me/app"]');
    expect(op.markdown).toContain('## 经验条目');
    expect(op.markdown).toContain('（来源: run `run-abc123` · 2026-09-19）');
    expect(op.indexEntry).toBe('- [重试退避策略](concepts/重试退避策略.md) —— 经验条目 1 条（run `run-abc123`，2026-09-19）');
    expect(op.logNote).toContain('新建 +1 条');
  });

  it('命中（slug 相等）→ 改写：created 保留、updated 前进、新条目并入、sources/pf-runs 并集', () => {
    const first = planDistill({
      run,
      repo: 'me/app',
      entries: [{ topic: '重试退避策略', statement: '退避要指数递增加抖动，实测 429 失败率 12%→0' }],
      existing: [],
      now: '2026-09-19T02:00:00.000Z',
    })[0]!;
    const dir = tmpDir();
    const abs = path.join(wikiCacheDir(dir, 'me/app'), 'llm-wiki', first.file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, first.markdown);
    const existing = listConceptPages(dir, 'me/app');
    expect(existing).toHaveLength(1);
    expect(existing[0]!.title).toBe('重试退避策略');

    const run2 = greenRun({ runId: 'run-xyz789' });
    const ops = planDistill({
      run: run2,
      repo: 'me/app',
      entries: [{ topic: '重试退避策略', statement: '窗口上限设 60s，超限请求直接快速失败' }],
      existing,
      now: '2026-09-20T02:00:00.000Z',
    });
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.action).toBe('update');
    expect(op.file).toBe('concepts/重试退避策略.md');
    expect(op.markdown).toContain('created: 2026-09-19T02:00:00.000Z');
    expect(op.markdown).toContain('updated: 2026-09-20T02:00:00.000Z');
    expect(op.markdown).toContain('实测 429 失败率 12%→0（来源: run `run-abc123` · 2026-09-19）');
    expect(op.markdown).toContain('窗口上限设 60s，超限请求直接快速失败（来源: run `run-xyz789` · 2026-09-20）');
    expect(op.markdown).toContain('pf-runs: [run-abc123, run-xyz789]');
    expect(op.markdown).toContain('"paneflow:run/run-xyz789"');
    expect(op.logNote).toContain('改写 +1 条');
    // index 条目与原页同 file → mergeWikiIndex 原位替换：不增条（C1 核心验收）
    const idx = mergeWikiIndex(first.indexEntry + '\n', { file: op.file, line: op.indexEntry });
    expect(idx.split('concepts/重试退避策略.md').length - 1).toBe(1);
    expect(idx).toContain('经验条目 2 条');
  });

  it('去重：页上已有同词面陈述 → 不出空操作；标题互为包含（归一化后）也算命中', () => {
    const hitPage: ConceptPage = {
      file: 'concepts/登录页样式.md',
      slug: '登录页样式',
      title: '登录页样式',
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-01T00:00:00.000Z',
      frontmatter: { title: '"登录页样式"', created: '2026-09-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z', tags: 'paneflow, concept' },
      body: '# 登录页样式\n\n> 引言\n\n## 经验条目\n\n- 移动端断点用 container query（来源: run `r-old` · 2026-09-01）\n',
    };
    // 归一化包含：「登录页样式守则」⊇ slug「登录页样式」→ 命中
    expect(matchConceptPage('登录页样式 守则', [hitPage])?.file).toBe('concepts/登录页样式.md');
    expect(matchConceptPage('完全不搭的主题', [hitPage])).toBeUndefined();
    // 全重复 → 零操作
    const dup = planDistill({
      run,
      repo: 'me/app',
      entries: [{ topic: '登录页样式', statement: '移动端断点用 container query' }],
      existing: [hitPage],
      now: '2026-09-21T00:00:00.000Z',
    });
    expect(dup).toEqual([]);
    // 新旧混合：只有新陈述入页，旧行逐字保留
    const mixed = planDistill({
      run,
      repo: 'me/app',
      entries: [
        { topic: '登录页样式', statement: '移动端断点用 container query' },
        { topic: '登录页样式', statement: '表单错误态必须带 aria-live 播报' },
      ],
      existing: [hitPage],
      now: '2026-09-21T00:00:00.000Z',
    });
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.markdown).toContain('aria-live');
    expect(mixed[0]!.markdown).toContain('container query');
    expect(mixed[0]!.markdown.match(/^- /gm)).toHaveLength(2);
    expect(mixed[0]!.markdown).toContain('created: 2026-09-01T00:00:00.000Z');
    expect(mixed[0]!.markdown).toContain('> 引言');
  });

  it('同批多条同主题聚到一页；空 topic/statement 被过滤', () => {
    const ops = planDistill({
      run,
      repo: 'me/app',
      entries: [
        { topic: '契约先行', statement: '先立 AC 再动手，本单 2/2 断言机检过' },
        { topic: '契约先行', statement: 'verify 节点只对着契约核对，不被沉淀带偏路径' },
        { topic: '', statement: '垃圾条目' },
      ],
      existing: [],
      now: '2026-09-19T02:00:00.000Z',
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.action).toBe('create');
    expect(ops[0]!.added).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// LLM 提取：一切失败=空数组静默弃
// ---------------------------------------------------------------------------

describe('v11-C1 distillEntries（网关直连 /v1/chat/completions；失败静默弃不抛）', () => {
  beforeEach(() => {
    chatStubs.urls = [];
    chatStubs.bodies = [];
  });

  it('网关未配置 → 不触网直接空', async () => {
    expect(await distillEntries(greenRun(), { dataDir: tmpDir(), fetchImpl: chatFetch('[]') })).toEqual([]);
    expect(chatStubs.urls).toEqual([]);
  });

  it('正常提取：代码围栏 JSON 也吃得下；evidenceRun 被编造也洗成本单 id；喂给模型的 brief 带契约断言与既有主题', async () => {
    const dir = tmpDir();
    seedGateway(dir);
    const entries = await distillEntries(greenRun(), {
      dataDir: dir,
      fetchImpl: chatFetch(
        '好的：\n```json\n[{"topic":"登录页样式守则","statement":"移动端断点用 container query，实测 iOS Safari 100vh 坑消失","evidenceRun":"编造的id"},{"topic":"太短","statement":"好"}]\n```',
      ),
      existingTitles: ['重试退避策略'],
      readbackFiles: ['summaries/旧单-def456.md'],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      topic: '登录页样式守则',
      statement: '移动端断点用 container query，实测 iOS Safari 100vh 坑消失',
      evidenceRun: 'run-abc123',
    });
    expect(chatStubs.urls[0]).toBe('https://gw.test/v1/chat/completions');
    expect(chatStubs.bodies[0]).toContain('"model":"test-free"');
    const brief = distillRunBrief(greenRun(), ['重试退避策略'], ['summaries/旧单-def456.md']);
    expect(brief).toContain('AC-1 登录页在移动端不破版 → ok：截图比对无差');
    expect(brief).toContain('重试退避策略');
    expect(brief).toContain('summaries/旧单-def456.md');
  });

  it('破烂 JSON / 非 JSON / HTTP 红 / fetch 炸：全部回空数组绝不抛', async () => {
    const dir = tmpDir();
    seedGateway(dir);
    expect(parseDistillReply('我想不到经验')).toEqual([]);
    expect(parseDistillReply('[{"topic":"x"}, 坏, ]')).toEqual([]);
    expect(await distillEntries(greenRun(), { dataDir: dir, fetchImpl: chatFetch('not json at all') })).toEqual([]);
    expect(await distillEntries(greenRun(), { dataDir: dir, fetchImpl: chatFetch('[]', { ok: false, status: 500 }) })).toEqual([]);
    expect(await distillEntries(greenRun(), { dataDir: dir, fetchImpl: (async () => { throw new Error('timeout'); }) as unknown as typeof fetch })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 集成：同主题两单 → concepts 恰一页 + updated>created + index 不增条（git 全 mock）
// ---------------------------------------------------------------------------

describe('v11-C1 蒸馏→多文件发布集成（同主题两单：恰一页、改写不增 index 条）', () => {
  it('两单先后落库：concepts/ 恰一页、一次 commit 带全部文件、log 两记', async () => {
    const dir = tmpDir();
    seedGateway(dir);
    const cache = wikiCacheDir(dir, 'me/app');
    const root = path.join(cache, 'llm-wiki');
    fs.mkdirSync(path.join(cache, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'summaries'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.md'), '# 索引\n\n- [旧单](summaries/旧单-def456.md) —— 摘要\n');
    fs.writeFileSync(path.join(root, 'log.md'), '# 沉淀日志\n\n- 旧记录\n');

    const run1 = greenRun();
    const p1 = await buildDistillPreview(
      { dataDir: dir, run: run1, repo: 'me/app', token: 'ghp_t' },
      {
        sync: noSync,
        now: '2026-09-19T02:00:00.000Z',
        fetchImpl: chatFetch('[{"topic":"登录页样式守则","statement":"container query 断点实测干掉 iOS 100vh 坑（AC-1 截图比对无差）"}]'),
      },
    );
    expect(p1.error).toBeUndefined();
    expect(p1.ops).toHaveLength(1);
    expect(p1.ops[0]!.action).toBe('create');
    h.gitCalls.length = 0;
    const r1 = await publishWikiPages({ dataDir: dir, repo: 'me/app', token: 'ghp_t', pages: p1.ops });
    expect(r1.files).toEqual(['llm-wiki/concepts/登录页样式守则.md', 'llm-wiki/index.md', 'llm-wiki/log.md']);
    const add = h.gitCalls.find((c) => c.args[0] === 'add');
    expect(add?.args.slice(1)).toEqual(['--', ...r1.files]);
    expect(h.gitCalls.filter((c) => c.args[0] === 'commit')).toHaveLength(1);
    expect(h.gitCalls.some((c) => c.args[0] === 'push')).toBe(true);

    // 第二单：同主题（标题互为包含的近义 topic）→ 改写旧页
    const run2 = greenRun({ runId: 'run-xyz789' });
    const p2 = await buildDistillPreview(
      { dataDir: dir, run: run2, repo: 'me/app', token: 'ghp_t' },
      {
        sync: noSync,
        now: '2026-09-20T02:00:00.000Z',
        fetchImpl: chatFetch('[{"topic":"登录页样式 守则","statement":"错误态必须带 aria-live，终审 e2e 补抓通过"}]'),
      },
    );
    expect(p2.ops).toHaveLength(1);
    expect(p2.ops[0]!.action).toBe('update');
    await publishWikiPages({ dataDir: dir, repo: 'me/app', token: 'ghp_t', pages: p2.ops });

    // concepts 恰一页；updated 真前进了且 created 是第一次的
    const conceptFiles = fs.readdirSync(path.join(root, 'concepts'));
    expect(conceptFiles).toEqual(['登录页样式守则.md']);
    const page = fs.readFileSync(path.join(root, 'concepts', '登录页样式守则.md'), 'utf8');
    expect(page).toContain('created: 2026-09-19T02:00:00.000Z');
    expect(page).toContain('updated: 2026-09-20T02:00:00.000Z');
    expect(page).toContain('container query');
    expect(page).toContain('aria-live');
    // index：旧 summaries 条目还在 + concepts 文件只出现一次（改写原位替换不增条）
    const indexText = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    expect(indexText).toContain('summaries/旧单-def456.md');
    expect(indexText.split('concepts/登录页样式守则.md').length - 1).toBe(1);
    // log：只追加——旧记录在、两次蒸馏各记一条
    const logText = fs.readFileSync(path.join(root, 'log.md'), 'utf8');
    expect(logText).toContain('- 旧记录');
    expect(logText).toContain('新建 +1 条');
    expect(logText).toContain('改写 +1 条');
    // 读端可见：readWikiPages 认出该 concept 页（C3a/C4 消费面）
    expect(readWikiPages(dir, 'me/app').some((p) => p.file === 'concepts/登录页样式守则.md')).toBe(true);
  });

  it('一次 commit 多文件（新页+改写混合）；push 被远端前移时重同步重试一次语义保持', async () => {
    const dir = tmpDir();
    const cache = wikiCacheDir(dir, 'me/app');
    const root = path.join(cache, 'llm-wiki');
    fs.mkdirSync(path.join(root, 'concepts'), { recursive: true });
    fs.mkdirSync(path.join(cache, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'concepts', '登录页样式.md'),
      '---\ntitle: "登录页样式"\ntype: concept\ntags: [paneflow, concept]\ncreated: 2026-09-01T00:00:00.000Z\nupdated: 2026-09-01T00:00:00.000Z\nsources: ["paneflow:run/r-old"]\nconfidence: high\n---\n\n# 登录页样式\n\n> 引言\n\n## 经验条目\n\n- container query 断点（来源: run `r-old` · 2026-09-01）\n',
    );
    const run = greenRun({ runId: 'run-multi01' });
    const ops = planDistill({
      run,
      repo: 'me/app',
      entries: [
        { topic: '登录页样式', statement: '错误态必须带 aria-live 播报' },
        { topic: '并发闸', statement: '同网关主机在途 ≤2，撞 429 收紧窗口 15s' },
      ],
      existing: listConceptPages(dir, 'me/app'),
      now: '2026-09-22T02:00:00.000Z',
    });
    expect(ops.map((o) => o.action).sort()).toEqual(['create', 'update']);
    h.gitCalls.length = 0;
    h.failPush = 1; // 第一次 push 红（交付链刚推过 main）→ 重试放行
    const r = await publishWikiPages({ dataDir: dir, repo: 'me/app', token: 'ghp_t', pages: ops });
    expect(h.gitCalls.filter((c) => c.args[0] === 'push')).toHaveLength(2);
    expect(r.files).toEqual([
      'llm-wiki/concepts/登录页样式.md',
      'llm-wiki/concepts/并发闸.md',
      'llm-wiki/index.md',
      'llm-wiki/log.md',
    ]);
    // 两次落点尝试各 commit 一次；git add 一次带全量文件（多文件一 commit）
    expect(h.gitCalls.filter((c) => c.args[0] === 'commit')).toHaveLength(2);
    const adds = h.gitCalls.filter((c) => c.args[0] === 'add');
    expect(adds[0]!.args.slice(1)).toEqual(['--', ...r.files]);
    // 两页都落了；index 里改写页条目原位替换（并发闸新增一条）
    expect(fs.readFileSync(path.join(root, 'concepts', '登录页样式.md'), 'utf8')).toContain('aria-live');
    const indexText = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    expect(indexText.split('concepts/登录页样式.md').length - 1).toBe(1);
    expect(indexText).toContain('concepts/并发闸.md');
  });
});

// ---------------------------------------------------------------------------
// 触发双路：开关 + 自动蒸执行体
// ---------------------------------------------------------------------------

describe('v11-C1 自动路（开关默认 off + autoDistillRun fail-closed 永不抛）', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('开关：env 未设/非 on → off（默认关：自动推 main 未经用户点头，等 C4 实证）；opts 优先于 env', () => {
    delete process.env.PF_WIKI_DISTILL;
    expect(autoDistillEnabled(undefined)).toBe(false);
    expect(autoDistillEnabled(undefined)).toBe(false);
    vi.stubEnv('PF_WIKI_DISTILL', 'on');
    expect(autoDistillEnabled(undefined)).toBe(true);
    expect(autoDistillEnabled('off')).toBe(false);
    vi.stubEnv('PF_WIKI_DISTILL', 'off');
    expect(autoDistillEnabled('on')).toBe(true);
    vi.unstubAllEnvs();
  });

  it('门不过（0-pass 断言没跑）→ 不蒸：LLM/publish 都不碰', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ token: 'ghp_t', defaultRepo: 'me/app' }));
    seedGateway(dir);
    const neverRan = greenRun();
    neverRan.nodes.verify!.artifact!.extra = {};
    const publish = vi.fn();
    const out = await autoDistillRun(dir, neverRan, { publish, fetchImpl: chatFetch('[]'), sync: noSync, readRemote: () => null });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('门不过');
    expect(publish).not.toHaveBeenCalled();
  });

  it('绿单全链：提取→规划→一次多页 push；无网关（entries 空）静默收场；publish 炸也只进 outcome 不抛', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ token: 'ghp_t', defaultRepo: 'me/app' }));
    seedGateway(dir);
    const publish = vi.fn(
      async (o: { dataDir: string; repo: string; token: string; pages: { file: string }[] }) => ({
        url: 'u',
        cacheDir: o.dataDir,
        files: ['llm-wiki/concepts/x.md'],
      }),
    );
    const out = await autoDistillRun(
      dir,
      greenRun(),
      {
        sync: noSync,
        readRemote: () => null,
        now: '2026-09-19T02:00:00.000Z',
        publish,
        fetchImpl: chatFetch('[{"topic":"契约先行","statement":"先立 AC 后动手：本单 2/2 断言机检绿，零返工"}]'),
      },
    );
    expect(out.ok).toBe(true);
    expect(out.ops).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0].pages).toHaveLength(1);
    // 无凭据仓（resolveRunRepo 三路全空）→ 静默跳过
    const noRepo = await autoDistillRun(tmpDir(), greenRun(), { readGhCliToken: async () => { throw new Error('no gh'); }, readRemote: () => null });
    expect(noRepo.ok).toBe(false);
    expect(noRepo.reason).toContain('凭据');
    // LLM 回破烂 → 空操作集：不 publish 不炸
    const garbage = await autoDistillRun(
      dir,
      greenRun(),
      { sync: noSync, readRemote: () => null, publish, fetchImpl: chatFetch('这不是JSON[[{') },
    );
    expect(garbage.ok).toBe(true);
    expect(garbage.ops).toEqual([]);
    // publish 抛错 → 折进 outcome（收口路径永不吃到异常）
    const boom = await autoDistillRun(dir, greenRun(), {
      sync: noSync,
      readRemote: () => null,
      publish: (async () => { throw new Error('push 被拒'); }) as unknown as typeof publishWikiPages,
      fetchImpl: chatFetch('[{"topic":"契约先行","statement":"先立 AC 后动手：本单 2/2 断言机检绿"}]'),
    });
    expect(boom.ok).toBe(false);
    expect(boom.reason).toContain('自动蒸失败');
  });
});

// ---------------------------------------------------------------------------
// 手动端点：POST /api/wiki/distill（预览路 + 失败路）
// ---------------------------------------------------------------------------

describe('v11-C1 POST /api/wiki/distill 手动端点（预览两路）', () => {
  async function inject(dir: string, run: RunRecord | undefined, payload: Record<string, unknown>, sync?: typeof noSync) {
    const { app } = await buildHttpServer({
      engine: { onChange: () => {}, getRun: () => run } as unknown as Engine,
      store: {} as unknown as Store,
      ops: {} as unknown as HerdrOps,
      herdrSocketPath: path.join(dir, 'herdr.sock'),
      dataDir: dir,
      readGhCliToken: async () => { throw new Error('test: gh not logged in'); },
      ...(sync ? { wikiDistillSync: sync } : {}),
    });
    try {
      return await app.inject({ method: 'POST', url: '/api/wiki/distill', payload });
    } finally {
      await app.close();
    }
  }

  it('路一：门不过/无单/无凭据各有 reason；路二：绿单回操作集预览（零 push）；同步炸 → 502 带原因', async () => {
    const dir = tmpDir();
    // 找不到 run
    const r0 = await inject(dir, undefined, { runId: 'nope' });
    expect(r0.statusCode).toBe(404);
    // 0-pass fail-closed 不蒸
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ token: 'ghp_t', defaultRepo: 'me/app' }));
    const neverRan = greenRun();
    neverRan.nodes.verify!.artifact!.extra = {};
    const r1 = await inject(dir, neverRan, { runId: 'run-abc123' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toContain('断言没跑≠绿');
    // 无凭据
    const dirNoCred = tmpDir();
    const r2 = await inject(dirNoCred, greenRun(), { runId: 'run-abc123', repo: 'me/app' });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toContain('凭据');
    // 预览成功路：只规划不 push（本用例 fetch 只会被 LLM 调用打到）
    seedGateway(dir);
    vi.stubGlobal('fetch', chatFetch('[{"topic":"登录页样式守则","statement":"container query 断点实测干掉 iOS 100vh 坑"}]'));
    try {
      const r3 = await inject(dir, greenRun(), { runId: 'run-abc123' }, noSync);
      expect(r3.statusCode).toBe(200);
      const body = r3.json();
      expect(body.ok).toBe(true);
      expect(body.ops).toHaveLength(1);
      expect(body.ops[0].action).toBe('create');
      expect(body.ops[0].file).toBe('concepts/登录页样式守则.md');
      expect(body.ops[0].markdown).toContain('type: concept');
      // 预览端点绝没写页
      expect(fs.existsSync(path.join(wikiCacheDir(dir, 'me/app'), 'llm-wiki', 'concepts'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    // 查询（同步）失败 → 回 reason 的 502
    const r4 = await inject(dir, greenRun(), { runId: 'run-abc123' }, async () => { throw new Error('远端不可达'); });
    expect(r4.statusCode).toBe(502);
    expect(r4.json().error).toContain('刷新 wiki 缓存失败');
  });
});
