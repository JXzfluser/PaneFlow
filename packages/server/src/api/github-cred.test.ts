import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gh-'));
}

type FetchHandler = (url: string, method: string, body: unknown) => { status: number; json: unknown };

/** 对齐 github-sync.test.ts 的 makeFetch 语义（handler 分派 + 脚本化 json/status），
 *  并用 notifier.test.ts 的 vi.stubGlobal 挂到全局，锁定 http.ts 内真实 fetch 调用面。 */
function stubFetch(handler: FetchHandler): { requests: { url: string; method: string; body: unknown }[] } {
  const requests: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url: String(url), method, body });
    const r = handler(String(url), method, body);
    return new Response(JSON.stringify(r.json), { status: r.status });
  }));
  return { requests };
}

/** github 端点只消费 deps.dataDir；其余依赖以最小桩补齐（buildHttpServer 注册期无需真实实现）。 */
function buildServer(dataDir: string) {
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

describe('github endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /api/github/cred 无凭据文件时 tokenConfigured=false', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/github/cred' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ tokenConfigured: false, defaultRepo: '' });
    } finally {
      await app.close();
    }
  });

  it('PUT /api/github/cred 落盘 token 与 defaultRepo，GET 回读一致', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/github/cred',
        payload: { token: 'ghp_secret', defaultRepo: 'owner/repo' },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ saved: true, tokenConfigured: true });
      // GET 从磁盘回读，验证持久化
      const get = await app.inject({ method: 'GET', url: '/api/github/cred' });
      expect(get.json()).toEqual({ tokenConfigured: true, defaultRepo: 'owner/repo' });
    } finally {
      await app.close();
    }
  });

  it('create-issue 缺 token → 400', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'x' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('凭据');
    } finally {
      await app.close();
    }
  });

  it('create-issue 缺 title → 400', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      await app.inject({ method: 'PUT', url: '/api/github/cred', payload: { token: 't', defaultRepo: 'owner/repo' } });
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { repo: 'owner/repo' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('title');
    } finally {
      await app.close();
    }
  });

  it('create-issue 缺 repo 但有 defaultRepo → 以 defaultRepo 直调 GitHub 并返回 number/url', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      await app.inject({ method: 'PUT', url: '/api/github/cred', payload: { token: 't', defaultRepo: 'owner/repo' } });
      const { requests } = stubFetch(() => ({
        status: 201,
        json: { number: 42, html_url: 'https://github.com/owner/repo/issues/42' },
      }));
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'hello' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ number: 42, url: 'https://github.com/owner/repo/issues/42', repo: 'owner/repo' });
      // 直调目标 = defaultRepo，携带 title
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('https://api.github.com/repos/owner/repo/issues');
      expect(requests[0]!.method).toBe('POST');
      expect((requests[0]!.body as { title: string }).title).toBe('hello');
    } finally {
      await app.close();
    }
  });

  it('create-issue 缺 defaultRepo（且未携带 repo）→ 400', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      await app.inject({ method: 'PUT', url: '/api/github/cred', payload: { token: 't' } });
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'x' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('repo');
    } finally {
      await app.close();
    }
  });

  it('create-issue 透传 GitHub 401/403/404 的 message', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      await app.inject({ method: 'PUT', url: '/api/github/cred', payload: { token: 't', defaultRepo: 'owner/repo' } });
      for (const status of [401, 403, 404]) {
        stubFetch(() => ({ status, json: { message: `err-${status}` } }));
        const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'x' } });
        expect(res.statusCode).toBe(status);
        expect(res.json().error).toBe(`err-${status}`);
      }
    } finally {
      await app.close();
    }
  });

  it('create-issue fetch 拒绝（AbortSignal 超时路径）→ 502', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      await app.inject({ method: 'PUT', url: '/api/github/cred', payload: { token: 't', defaultRepo: 'owner/repo' } });
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('timeout: network down');
      }));
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 'x' } });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('timeout: network down');
    } finally {
      await app.close();
    }
  });
});