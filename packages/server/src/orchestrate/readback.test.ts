import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph, RunRecord } from '@paneflow/shared';
import { Engine } from './engine.js';
import type { EngineOptions } from './engine.js';
import { Store } from './store.js';
import { FakeHerdrOps } from './fake-ops.js';
import { WIKI_ROOT, wikiCacheDir } from '../api/wiki.js';
import { writeGithubSettings } from '../api/github-cred.js';
import {
  buildReadbackBlock,
  loadReadbackPages,
  LOW_CONFIDENCE_PENALTY,
  makeWikiCacheRefresher,
  rankReadbackPages,
  READBACK_BLOCK_BUDGET,
  resolveRunRepo,
  weightByConfidence,
  type ReadbackPage,
} from './readback.js';

const OPTS: EngineOptions = {
  workspaceLabelPrefix: 'paneflow-',
  promptConfirmWindowMs: 0,
  reconcileIntervalMs: 60_000,
  defaultNodeTimeoutMs: 1_200,
  agentStartTimeoutMs: 5_000,
  agentReadyTimeoutMs: 5_000,
  recommendAgentKind: async () => 'reco',
};

const REPO = 'me/repo';

/** 种缓存：直写 wikiCacheDir 下的 md（最省办法，零网络零 git） */
function seedPage(
  dataDir: string,
  file: string,
  o: { title: string; confidence?: string; body: string },
): void {
  const abs = path.join(wikiCacheDir(dataDir, REPO), WIKI_ROOT, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const fm = [`title: "${o.title}"`, 'type: summary', ...(o.confidence ? [`confidence: ${o.confidence}`] : [])].join('\n');
  fs.writeFileSync(abs, `---\n${fm}\n---\n\n${o.body}\n`);
}

/** impl（该注入）+ review（不该注入）+ 词面不相关页共存的一图流 */
function readbackGraph(): DagGraph {
  return {
    version: 1,
    name: 'readback-test',
    nodes: [
      { id: 'start', type: 'start', label: '开始', config: {} },
      {
        id: 'impl',
        type: 'agent',
        label: '实现',
        config: { agentKind: 'fake', prompt: '实现 login outbox 重试逻辑。参见 {{design.artifact.summary}}' },
      },
      {
        id: 'review',
        type: 'agent',
        label: '评审',
        config: { agentKind: 'fake', prompt: '评审 login outbox 重试逻辑的 diff' },
      },
      { id: 'end', type: 'end', label: '结束', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'impl' },
      { id: 'e2', source: 'impl', target: 'review' },
      { id: 'e3', source: 'review', target: 'end' },
    ],
    metadata: { createdAt: '', updatedAt: '' },
  };
}

let ops: FakeHerdrOps;
let dataDir: string;
let store: Store;

beforeEach(() => {
  ops = new FakeHerdrOps();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-readback-'));
  store = new Store(dataDir);
});

function makeEngine(extra: Partial<EngineOptions> = {}): Engine {
  return new Engine(ops, store, { ...OPTS, ...extra });
}

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('condition not met in time'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function runToCompletion(engine: Engine, graph: DagGraph): Promise<RunRecord> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cwd-'));
  const run = await engine.startRun(graph, cwd);
  await waitFor(() => engine.getRun(run.runId)!.state !== 'running');
  return engine.getRun(run.runId)!;
}

describe('readback 纯函数', () => {
  it('resolveRunRepo：cwd origin > 契约 repo > 默认仓；全认不出为 null', () => {
    expect(
      resolveRunRepo({
        cwd: '/x',
        contractRepo: 'a/b',
        defaultRepo: 'c/d',
        readRemote: () => 'git@github.com:owner/name.git',
      }),
    ).toBe('owner/name');
    expect(resolveRunRepo({ cwd: '/x', contractRepo: 'a/b', defaultRepo: 'c/d', readRemote: () => null })).toBe('a/b');
    expect(resolveRunRepo({ cwd: '/x', defaultRepo: 'c/d', readRemote: () => null })).toBe('c/d');
    expect(resolveRunRepo({ cwd: '/x', readRemote: () => 'https://gitea.internal/a/b.git' })).toBeNull();
    // 非法 owner/repo 样式（含路径穿越/空格）不吃
    expect(resolveRunRepo({ cwd: '/x', defaultRepo: '../evil', readRemote: () => null })).toBeNull();
  });

  it('rankReadbackPages：词面不相关的页不入选；k=3 截断', () => {
    const mk = (file: string, text: string): ReadbackPage => ({
      file,
      title: file,
      text,
      frontmatter: {},
    });
    const pages = [
      mk('a.md', 'login outbox 重试的经验'),
      mk('b.md', 'login 超时补偿'),
      mk('c.md', 'outbox 投递语义'),
      mk('d.md', '量子隧穿与弦论'),
      mk('e.md', '重试退避表'),
    ];
    const hit = rankReadbackPages(pages, '实现 login outbox 重试 逻辑').map((p) => p.file);
    expect(hit).not.toContain('d.md');
    expect(hit.length).toBeLessThanOrEqual(3);
    expect(new Set(hit).size).toBe(hit.length);
    // 零命中的查询宁缺毋滥
    expect(rankReadbackPages(pages, '量子化学')).toEqual([]);
    expect(rankReadbackPages(pages, '')).toEqual([]);
  });

  it('rankReadbackPages：weightOf 钩子——入参吃到 frontmatter 全量且影响排序（降权接入形状），排序器自身不判 low', () => {
    const pages: ReadbackPage[] = [
      { file: 'hi.md', title: 'login 经验', text: 'login login 更多命中', frontmatter: { confidence: 'high' } },
      { file: 'low.md', title: 'login 教训', text: 'login 相关正文', frontmatter: { confidence: 'low' } },
    ];
    // 默认权重：命中多的 hi.md 在前
    expect(rankReadbackPages(pages, 'login')[0]!.file).toBe('hi.md');
    // 钩子拿到 frontmatter（confidence 可见）并降权 hi → 次序翻转：证明接入点通
    const seen: Record<string, string>[] = [];
    const weighted = rankReadbackPages(pages, 'login', 3, (fm) => {
      seen.push(fm);
      return fm.confidence === 'high' ? 0.1 : 1;
    });
    expect(seen.length).toBe(pages.length);
    expect(seen.every((fm) => 'confidence' in fm)).toBe(true);
    expect(weighted[0]!.file).toBe('low.md');
  });

  it('weightByConfidence（V5① 降权单源）：只罚 low，high/medium/无字段一律恒权 1', () => {
    expect(LOW_CONFIDENCE_PENALTY).toBe(0.4);
    expect(weightByConfidence({ confidence: 'low' })).toBe(LOW_CONFIDENCE_PENALTY);
    // 大小写/空白宽容：手写 frontmatter 的 ' Low ' 也是反面教材，不该因笔误漏罚
    expect(weightByConfidence({ confidence: 'LOW' })).toBe(LOW_CONFIDENCE_PENALTY);
    expect(weightByConfidence({ confidence: ' Low ' })).toBe(LOW_CONFIDENCE_PENALTY);
    // 有值但非 low = 恒权；旧页整缺 confidence 也是恒权（「不知道」≠「不可信」）
    const notLow: Record<string, string>[] = [
      { confidence: 'high' },
      { confidence: 'medium' },
      { confidence: 'medium-high' },
      {},
      { type: 'summary' },
    ];
    for (const fm of notLow) expect(weightByConfidence(fm)).toBe(1);
  });

  it('rankReadbackPages + weightByConfidence：词面最强的 low 页被降权挤出 top-3（k 截断真吃权重）', () => {
    const hit = 'login login';
    const pages: ReadbackPage[] = [
      { file: 'low.md', title: 'login outbox 重试逻辑', text: 'login outbox 重试逻辑 login outbox 重试逻辑', frontmatter: { confidence: 'low' } },
      { file: 'a.md', title: 'login outbox 笔记', text: hit, frontmatter: { confidence: 'high' } },
      { file: 'b.md', title: 'login outbox 笔记', text: hit, frontmatter: {} },
      { file: 'c.md', title: 'login outbox 笔记', text: hit, frontmatter: { confidence: 'medium' } },
    ];
    const q = '实现 login outbox 重试逻辑';
    // 对照：不降权时 low.md 命中最多、稳居第一并占掉一个名额
    expect(rankReadbackPages(pages, q, 3).map((p) => p.file)).toEqual(['low.md', 'a.md', 'b.md']);
    // 降权后 low.md 掉出名额，三张正页全进
    expect(rankReadbackPages(pages, q, 3, weightByConfidence).map((p) => p.file)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('buildReadbackBlock：confidence 透传、剥 {{}}、总预算封顶', () => {
    const long = 'x'.repeat(400);
    const pages: ReadbackPage[] = [
      { file: 's/a.md', title: '登录页修复', text: `正文 {{run_id}} ${long}`, frontmatter: { confidence: 'high' } },
      { file: 's/b.md', title: '重试退避', text: long, frontmatter: {} },
      { file: 's/c.md', title: '无 fm', text: long, frontmatter: {} },
    ];
    const { block, used } = buildReadbackBlock(pages);
    expect(block).toContain('## 相关沉淀（PaneFlow wiki）');
    expect(block).toContain('confidence=high');
    expect(block).not.toContain('{{run_id}}');
    expect(used.map((p) => p.file)).toEqual(['s/a.md', 's/b.md', 's/c.md']);
    expect(block.length).toBeLessThanOrEqual(READBACK_BLOCK_BUDGET);
    // 预算装不下时截尾，used 只记实际进块的页
    const tight = buildReadbackBlock(pages, 400);
    expect(tight.block).not.toBe('');
    expect(tight.used.length).toBeLessThan(pages.length);
    expect(tight.block.length).toBeLessThanOrEqual(400);
    // 一行都放不下 = 空块
    expect(buildReadbackBlock(pages, 10).block).toBe('');
  });

  it('loadReadbackPages：读不到缓存目录返回空、不抛；frontmatter 全量入页', () => {
    expect(loadReadbackPages(dataDir, 'no/such')).toEqual([]);
    seedPage(dataDir, 'summaries/login-fix.md', { title: '登录页修复', confidence: 'high', body: '先查 session 过期。' });
    const pages = loadReadbackPages(dataDir, REPO);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toBe('登录页修复');
    expect(pages[0]!.frontmatter).toMatchObject({ type: 'summary', confidence: 'high' });
    expect(pages[0]!.text).toContain('先查 session 过期');
  });

  it('makeWikiCacheRefresher：无 token = 静默不刷（不抛、不建 git 操作）', async () => {
    // dataDir 无 github.json 存储 PAT，gh 兜底注入为抛错 = 无凭据环境
    const refresh = makeWikiCacheRefresher(dataDir, async () => {
      throw new Error('gh 未登录');
    });
    await expect(refresh(REPO)).resolves.toBeUndefined();
    // 无 token 即不会走到 clone：缓存目录根本不该被创建
    expect(fs.existsSync(wikiCacheDir(dataDir, REPO))).toBe(false);
  });
});

describe('Engine v11-C3a wiki 读回注入', () => {
  it('off：prompt 无沉淀块、无留痕、不刷缓存', async () => {
    writeGithubSettings(dataDir, { defaultRepo: REPO });
    seedPage(dataDir, 'summaries/login-fix.md', {
      title: '登录页修复',
      body: 'login outbox 重试的实战沉淀：先查 session 过期再加重试退避。',
    });
    let refreshed = 0;
    const engine = makeEngine({
      wikiReadback: 'off',
      wikiCacheRefresh: async () => {
        refreshed += 1;
      },
    });
    const run = await runToCompletion(engine, readbackGraph());
    expect(run.state).toBe('completed');
    expect(run.wikiReadback).toBeUndefined();
    expect(ops.prompts.every((p) => !p.text.includes('相关沉淀'))).toBe(true);
    expect(refreshed).toBe(0);
  });

  it('env PF_WIKI_READBACK=off 同样关闸（opts 未显式注入时）', async () => {
    writeGithubSettings(dataDir, { defaultRepo: REPO });
    seedPage(dataDir, 'summaries/login-fix.md', { title: '登录页修复', body: 'login outbox 重试沉淀。' });
    process.env.PF_WIKI_READBACK = 'off';
    try {
      const engine = makeEngine({ wikiCacheRefresh: async () => undefined });
      const run = await runToCompletion(engine, readbackGraph());
      expect(run.wikiReadback).toBeUndefined();
      expect(ops.prompts.every((p) => !p.text.includes('相关沉淀'))).toBe(true);
    } finally {
      delete process.env.PF_WIKI_READBACK;
    }
  });

  it('on（缺省默认开）：块进 prompt 尾部、留痕入 RunRecord 且随盘持久化、起跑刷一次缓存', async () => {
    writeGithubSettings(dataDir, { defaultRepo: REPO });
    seedPage(dataDir, 'summaries/login-fix.md', {
      title: '登录页修复经验',
      confidence: 'high',
      body: 'login outbox 重试的实战沉淀：先查 session 过期，再配指数退避。',
    });
    seedPage(dataDir, 'concepts/quantum.md', { title: '量子隧穿', body: '与本单毫无关系的物理笔记。' });
    const refreshed: string[] = [];
    const engine = makeEngine({ wikiCacheRefresh: async (repo) => void refreshed.push(repo) });
    const run = await runToCompletion(engine, readbackGraph());
    expect(run.state).toBe('completed');

    // ①注入进的是 impl（plan/impl 类），review 不吃注入
    const implPrompt = ops.prompts.find((p) => p.text.includes('实现 login outbox'))!;
    expect(implPrompt.text).toContain('## 相关沉淀（PaneFlow wiki）');
    expect(implPrompt.text).toContain('登录页修复经验');
    expect(implPrompt.text).toContain('confidence=high');
    expect(implPrompt.text).not.toContain('量子隧穿');
    const reviewPrompt = ops.prompts.find((p) => p.text.includes('评审 login outbox'))!;
    expect(reviewPrompt.text).not.toContain('相关沉淀');
    // 块在 prompt 尾部（任务本体在前）
    expect(implPrompt.text.indexOf('## 相关沉淀')).toBeGreaterThan(implPrompt.text.indexOf('实现 login outbox'));

    // ②留痕形态：repo + 节点→页清单（C3b 回链数据源）
    expect(run.wikiReadback).toEqual({
      repo: REPO,
      nodes: [{ nodeId: 'impl', pages: [{ file: 'summaries/login-fix.md', title: '登录页修复经验' }] }],
    });
    // ③持久化：盘上 run JSON 带同一份留痕（saveRun 全量序列化，新字段零成本落盘）
    const onDisk = store.getRun(run.runId);
    expect(onDisk?.wikiReadback).toEqual(run.wikiReadback);
    // ④起跑异步刷缓存一次（注入本身不吃网络）
    await waitFor(() => refreshed.length > 0);
    expect(refreshed).toEqual([REPO]);
    // ⑤透明性：run 事件时间线可见
    expect((run.events ?? []).some((e) => e.text.includes('沉淀读回（C3a）'))).toBe(true);
  });

  it('无缓存：静默跳过不破 run，但仍异步刷一次（下次吃到）', async () => {
    writeGithubSettings(dataDir, { defaultRepo: REPO });
    const refreshed: string[] = [];
    const engine = makeEngine({ wikiCacheRefresh: async (repo) => void refreshed.push(repo) });
    const run = await runToCompletion(engine, readbackGraph());
    expect(run.state).toBe('completed');
    expect(run.wikiReadback).toBeUndefined();
    expect(ops.prompts.every((p) => !p.text.includes('相关沉淀'))).toBe(true);
    await waitFor(() => refreshed.length > 0);
    expect(refreshed).toEqual([REPO]);
  });

  it('无仓（无 remote/契约/默认仓）：整段静默跳过，连刷新都不起', async () => {
    let refreshed = 0;
    const engine = makeEngine({
      wikiCacheRefresh: async () => {
        refreshed += 1;
      },
    });
    const run = await runToCompletion(engine, readbackGraph());
    expect(run.state).toBe('completed');
    expect(run.wikiReadback).toBeUndefined();
    expect(refreshed).toBe(0);
  });

  it('词面不相关：有缓存有仓但零命中 = 不注入不留痕，宁缺毋滥', async () => {
    writeGithubSettings(dataDir, { defaultRepo: REPO });
    seedPage(dataDir, 'concepts/quantum.md', { title: '量子隧穿', body: '纯物理，与代码无关。' });
    const engine = makeEngine({ wikiCacheRefresh: async () => undefined });
    const run = await runToCompletion(engine, readbackGraph());
    expect(run.state).toBe('completed');
    expect(run.wikiReadback).toBeUndefined();
    expect(ops.prompts.every((p) => !p.text.includes('相关沉淀'))).toBe(true);
  });

  it('多节点各挑各的：impl 与 plan 命中不同页，留痕按节点分列', async () => {
    writeGithubSettings(dataDir, { defaultRepo: REPO });
    seedPage(dataDir, 'summaries/login-fix.md', { title: '登录页修复', body: 'login outbox 重试经验。' });
    seedPage(dataDir, 'summaries/schema-mig.md', { title: '库表迁移', body: 'migration 灰度双写的拆分经验。' });
    const graph: DagGraph = {
      ...readbackGraph(),
      name: 'readback-multi',
      nodes: [
        { id: 'start', type: 'start', label: '开始', config: {} },
        { id: 'plan', type: 'agent', label: '规划', config: { agentKind: 'fake', prompt: '把 migration 灰度双写拆成小步' } },
        { id: 'impl', type: 'agent', label: '实现', config: { agentKind: 'fake', prompt: '实现 login outbox 重试' } },
        { id: 'end', type: 'end', label: '结束', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'plan' },
        { id: 'e2', source: 'plan', target: 'impl' },
        { id: 'e3', source: 'impl', target: 'end' },
      ],
    };
    const engine = makeEngine({ wikiCacheRefresh: async () => undefined });
    const run = await runToCompletion(engine, graph);
    expect(run.state).toBe('completed');
    const trace = run.wikiReadback!;
    expect(trace.repo).toBe(REPO);
    expect(trace.nodes.map((n) => n.nodeId).sort()).toEqual(['impl', 'plan']);
    expect(trace.nodes.find((n) => n.nodeId === 'plan')!.pages[0]!.file).toBe('summaries/schema-mig.md');
    expect(trace.nodes.find((n) => n.nodeId === 'impl')!.pages[0]!.file).toBe('summaries/login-fix.md');
  });

  it('V5① 降权在注入现场生效：同一语料只改 confidence，low 页从榜首让位给正页', async () => {
    writeGithubSettings(dataDir, { defaultRepo: REPO });
    const hit = (times: number) => 'login outbox 重试逻辑 实现 参见 '.repeat(times).trim();
    // 种子刻意让 low 页词面命中更多（3 遍 vs 2 遍）：不降权时它必占榜首
    const seed = (lowConfidence: boolean) => {
      seedPage(dataDir, 'summaries/lesson-low.md', {
        title: '登录 outbox 重试逻辑',
        ...(lowConfidence ? { confidence: 'low' } : {}),
        body: hit(3),
      });
      seedPage(dataDir, 'summaries/lesson-good.md', {
        title: '登录 outbox 重试实践',
        confidence: 'high',
        body: hit(2),
      });
    };
    const firstOf = async (lowConfidence: boolean): Promise<string[]> => {
      seed(lowConfidence);
      const engine = makeEngine({ wikiCacheRefresh: async () => undefined });
      const run = await runToCompletion(engine, readbackGraph());
      expect(run.state).toBe('completed');
      return run.wikiReadback!.nodes.find((n) => n.nodeId === 'impl')!.pages.map((p) => p.file);
    };

    // 降权前（页面没打 confidence）：词面强者居首
    expect(await firstOf(false)).toEqual(['summaries/lesson-low.md', 'summaries/lesson-good.md']);
    // 只把 low 标记加上——两页正文一字未动，次序即翻转：降权吃进了真实注入路
    const marked = await firstOf(true);
    expect(marked).toEqual(['summaries/lesson-good.md', 'summaries/lesson-low.md']);
    // 只降排序权、不隐去反面教材：low 页仍在块内且置信身份照旧透传
    // （ops 跨两轮累计，取最后一次实发的 impl prompt）
    const implPrompt = ops.prompts.filter((p) => p.text.includes('实现 login outbox')).at(-1)!;
    expect(implPrompt.text).toContain('登录 outbox 重试逻辑');
    expect(implPrompt.text).toContain('confidence=low');
    // 实发次序与留痕同源：good 在前、low 在后
    expect(implPrompt.text.indexOf('登录 outbox 重试实践')).toBeLessThan(implPrompt.text.indexOf('登录 outbox 重试逻辑'));
  });
});
