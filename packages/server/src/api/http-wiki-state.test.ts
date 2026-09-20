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
function buildServer(dataDir: string, readGhCliToken?: () => Promise<string>) {
  return buildHttpServer({
    engine: { onChange: () => {}, getRun: () => undefined } as unknown as Engine,
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
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
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
      expect(res.json()).toEqual({ repo: 'me/repo', branch: 'main', pageCount: 0, pages: [], syncedAt: '' });
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
        pages: [{ file: 'Login-Fix.md', title: 'Login Fix' }],
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
