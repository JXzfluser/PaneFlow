import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import {
  checkRepoVisibility,
  latestAssertionResults,
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

describe('v9-K1 renderWikiPage（frontmatter + 断言表 + 双链，纯函数）', () => {
  it('页面含 frontmatter 字段、验收表（✅ ok + 证据）与 [[双链]]', () => {
    const { file, markdown } = renderWikiPage(greenRun(), { repo: 'me/app', now: '2026-09-19T02:00:00Z' });
    expect(file).toBe('修登录页样式-abc123.md');
    expect(markdown).toContain('pf-run: run-abc123');
    expect(markdown).toContain('pf-repo: me/app');
    expect(markdown).toContain('pf-contract-source: input');
    expect(markdown).toContain('| AC-1 | 登录页在移动端不破版 | ✅ ok | 截图比对无差 |');
    expect(markdown).toContain('[[修登录页样式]]');
    expect(markdown).toContain('unknown（agent 未自报，不估算）');
    expect(markdown).toContain('改了三处样式');
  });

  it('latestAssertionResults 取最后一份带结果的产物（终审覆盖自测）', () => {
    const run = greenRun();
    run.nodes.impl!.artifact!.extra = {
      assertionResults: [{ id: 'AC-1', status: 'fail', evidence: '初测未过' }],
    };
    expect(latestAssertionResults(run).find((x) => x.id === 'AC-1')!.status).toBe('ok');
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

describe('v9-K2 wiki 读回（本地缓存页挑选，宁缺毋滥）', () => {
  it('readWikiPages 从缓存目录读 md；pickWikiExcerpts 按词命中打分、无命中原样返回空', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wiki-'));
    const repo = 'me/app';
    const cache = wikiCacheDir(dir, repo);
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
