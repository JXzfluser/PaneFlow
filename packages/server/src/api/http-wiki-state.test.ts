import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';
import { wikiCacheDir } from './wiki.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wiki-state-'));
}

/** v10-X 状态路由只吃 dataDir（+sync 的凭据门）；其余依赖最小桩 */
function buildServer(
  dataDir: string,
  readGhCliToken?: () => Promise<string>,
  listRuns: () => unknown[] = () => [],
) {
  return buildHttpServer({
    engine: { onChange: () => {}, getRun: () => undefined, listRuns } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    readGhCliToken: readGhCliToken ?? (async () => { throw new Error('gh not logged in (test stub)'); }),
    lookupGithubLogin: async () => null,
  });
}

function seedCache(dataDir: string, repo: string, files: Record<string, string>, syncedAt?: string): string {
  // Issue #7 落点：页在主仓缓存的 llm-wiki/ 子树下
  const dir = path.join(wikiCacheDir(dataDir, repo), 'llm-wiki');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const abs = path.join(dir, name);
    // v11-C3b 用例喂嵌套路径（summaries/x.md）——父目录先保
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (syncedAt) fs.writeFileSync(path.join(path.dirname(dir), '.pf-synced'), syncedAt);
  return dir;
}

describe('v10-X GET /api/wiki/state（沉淀可见化：只读本地缓存，零网络）', () => {
  it('缺默认仓且没带 repo → 400 指路设置页', async () => {
    const { app } = await buildServer(tmp());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/wiki/state' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('默认仓库');
    } finally {
      await app.close();
    }
  });

  it('有默认仓但缓存为空 → pageCount=0（还没沉淀过，不是错误）；无缓存 branch 回退 main', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ defaultRepo: 'me/repo' }));
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/wiki/state' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        repo: 'me/repo',
        branch: 'main',
        pageCount: 0,
        pages: [],
        citedRunCount: 0, // v11-C3b：无 run 留痕 → 零引用
        syncedAt: '',
      });
    } finally {
      await app.close();
    }
  });

  it('缓存有页 → 列表 + 同步时间；?repo= 可覆盖默认仓', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ defaultRepo: 'me/repo' }));
    seedCache(dir, 'other/repo', { 'Login-Fix.md': '---\npf-run: x\n---\n\n# 修复登录\n' }, '2026-09-19T02:00:00.000Z');
    const { app } = await buildServer(dir);
    try {
      const def = await app.inject({ method: 'GET', url: '/api/wiki/state' });
      expect(def.json()).toMatchObject({ repo: 'me/repo', pageCount: 0 });
      const res = await app.inject({ method: 'GET', url: `/api/wiki/state?repo=${encodeURIComponent('other/repo')}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        repo: 'other/repo',
        branch: 'main', // 缓存没 .git（伪缓存）→ 读不到分支，回退 main
        pageCount: 1,
        pages: [{ file: 'Login-Fix.md', title: 'Login Fix', citedBy: [] }],
        citedRunCount: 0,
        syncedAt: '2026-09-19T02:00:00.000Z',
      });
    } finally {
      await app.close();
    }
  });

  it('缓存克隆 .git/HEAD 有符号分支 → branch 跟随；detached HEAD 回退 main（零网络）', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ defaultRepo: 'me/repo' }));
    seedCache(dir, 'me/repo', { 'A.md': '# A\n' });
    const gitDir = path.join(wikiCacheDir(dir, 'me/repo'), '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    const head = path.join(gitDir, 'HEAD');
    const { app } = await buildServer(dir);
    try {
      fs.writeFileSync(head, 'ref: refs/heads/feature/x\n');
      expect((await app.inject({ method: 'GET', url: '/api/wiki/state' })).json()).toMatchObject({ branch: 'feature/x' });
      fs.writeFileSync(head, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
      expect((await app.inject({ method: 'GET', url: '/api/wiki/state' })).json()).toMatchObject({ branch: 'main' });
    } finally {
      await app.close();
    }
  });
});

describe('v11-C3b GET /api/wiki/state 的引用回链（citedBy/citedRunCount 读时聚合，零新增写路径）', () => {
  const trace = (runId: string, repo: string, files: [string, string][], nodeId = 'impl') => ({
    runId,
    wikiReadback: { repo, nodes: [{ nodeId, pages: files.map(([file, title]) => ({ file, title })) }] },
  });

  function seeded(listRuns: () => unknown[]) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ defaultRepo: 'me/repo' }));
    seedCache(dir, 'me/repo', {
      'summaries/登录修复.md': '---\ntitle: 登录修复\n---\n\n# 登录修复\n',
      'concepts/样式守则.md': '---\ntitle: 样式守则\n---\n\n# 样式守则\n',
    });
    return buildServer(dir, undefined, listRuns);
  }
  it('run 留痕命中页 → pages.citedBy 带 runId、顶层 citedRunCount 记数；未命中页空数组', async () => {
    const { app } = await seeded(() => [trace('r-1', 'me/repo', [['summaries/登录修复.md', '登录修复']])]);
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/wiki/state' })).json();
      expect(body.pages).toEqual([
        { file: 'concepts/样式守则.md', title: '样式守则', citedBy: [] },
        { file: 'summaries/登录修复.md', title: '登录修复', citedBy: ['r-1'] },
      ]);
      expect(body.citedRunCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('同 run 多节点引同一页 = 记 1 次；多 run 引同页 citedBy 全列（字典序）', async () => {
    const { app } = await seeded(() => [
      {
        runId: 'r-9',
        wikiReadback: {
          repo: 'me/repo',
          nodes: [
            { nodeId: 'plan', pages: [{ file: 'concepts/样式守则.md', title: '样式守则' }] },
            { nodeId: 'impl', pages: [{ file: 'concepts/样式守则.md', title: '样式守则' }] },
          ],
        },
      },
      trace('r-a', 'me/repo', [['concepts/样式守则.md', '样式守则']]),
    ]);
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/wiki/state' })).json();
      const page = body.pages.find((p: { file: string }) => p.file === 'concepts/样式守则.md');
      expect(page.citedBy).toEqual(['r-9', 'r-a']);
      expect(body.citedRunCount).toBe(2); // per-run set：r-9 双节点只算 1
    } finally {
      await app.close();
    }
  });

  it('repo 不串：别的仓的留痕不进本仓 citedBy；无留痕的 run 不计数', async () => {
    const { app } = await seeded(() => [
      trace('r-x', 'other/repo', [['concepts/样式守则.md', '样式守则']]), // 同名文件也不许串
      { runId: 'r-empty', wikiReadback: { repo: 'me/repo', nodes: [] } },
    ]);
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/wiki/state' })).json();
      expect(body.pages.every((p: { citedBy: string[] }) => p.citedBy.length === 0)).toBe(true);
      expect(body.citedRunCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe('v10-X POST /api/wiki/sync（显式拉远端；测试不碰真 git）', () => {
  it('无凭据 → 400（凭据门文案）', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ defaultRepo: 'me/repo' }));
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/wiki/sync', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('凭据');
    } finally {
      await app.close();
    }
  });

  it('有凭据但缺默认仓 → 400', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir, async () => 'ghtok');
    try {
      const res = await app.inject({ method: 'POST', url: '/api/wiki/sync', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('仓库');
    } finally {
      await app.close();
    }
  });
});
