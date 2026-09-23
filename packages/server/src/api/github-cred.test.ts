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
 *  并用 vi.stubGlobal 挂到全局，锁定 http.ts 内真实 fetch 调用面。 */
function stubFetch(handler: FetchHandler): { requests: { url: string; method: string; body: unknown; headers?: Record<string, string> }[] } {
  const requests: { url: string; method: string; body: unknown; headers?: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url: String(url), method, body, headers: init?.headers });
    const r = handler(String(url), method, body);
    return new Response(JSON.stringify(r.json), { status: r.status });
  }));
  return { requests };
}

/** github 端点只消费 deps.dataDir + readGhCliToken；其余依赖以最小桩补齐（buildHttpServer 注册期无需真实实现）。 */
function buildServer(
  dataDir: string,
  readGhCliToken?: () => Promise<string>,
  lookupGithubLogin?: (token: string) => Promise<string | null>,
) {
  return buildHttpServer({
    engine: { onChange: () => {}, getRun: () => undefined } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    // U2：默认注入「gh 未登录」桩，避免测试受本机钥匙串状态摆布
    readGhCliToken: readGhCliToken ?? (async () => { throw new Error('gh not logged in (test stub)'); }),
    // v10-X：登录名探测同理默认桩为「探不到」，防测试真打 api.github.com
    lookupGithubLogin: lookupGithubLogin ?? (async () => null),
  });
}

describe('github endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /api/github/cred 无凭据且 gh 未登录 → source=none', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/github/cred' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        tokenConfigured: false,
        defaultRepo: '',
        source: 'none',
        tokenTail: '',
        ghLoggedIn: false,
      });
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
      // GET 从磁盘回读，验证持久化（U2：带来源与尾号）
      const get = await app.inject({ method: 'GET', url: '/api/github/cred' });
      expect(get.json()).toEqual({
        tokenConfigured: true,
        defaultRepo: 'owner/repo',
        source: 'stored-pat',
        tokenTail: 'cret',
        ghLoggedIn: false,
      });
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
describe('v9-D1 importFromGhCli（gh 一键导入，失败给最小权限 PAT 指引）', () => {
  it('gh 已登录：token 落盘且不动已有 defaultRepo', async () => {
    const dir = tmp();
    const { writeGithubSettings, readGithubSettings, importFromGhCli } = await import('./github-cred.js');
    writeGithubSettings(dir, { defaultRepo: 'me/repo' });
    const r = await importFromGhCli(dir, async () => 'ghp_from_cli');
    expect(r).toEqual({ ok: true, defaultRepo: 'me/repo' });
    expect(readGithubSettings(dir)).toEqual({ token: 'ghp_from_cli', defaultRepo: 'me/repo' });
  });

  it('gh 未装/未登录 → ok:false，错误里带路 A（brew+login）与路 B（Fine-grained 最小权限）', async () => {
    const { importFromGhCli } = await import('./github-cred.js');
    const r = await importFromGhCli(tmp(), async () => {
      throw new Error('spawn gh ENOENT');
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('gh auth login');
    expect(r.error).toContain('Fine-grained');
    expect(r.error).toContain('Contents:RW');
  });

  it('gh 登录但 token 为空 → 提示 gh auth status，且不写盘', async () => {
    const dir = tmp();
    const { importFromGhCli, readGithubSettings } = await import('./github-cred.js');
    const r = await importFromGhCli(dir, async () => '   ');
    expect(r.ok).toBe(false);
    expect(readGithubSettings(dir)).toEqual({});
  });
});

describe('v10-U2 凭据来源可见 + gh 兜底 + 解绑', () => {
  it('describeGithubCred 三态：stored-pat 带尾号 / gh-cli / none', async () => {
    const { describeGithubCred, writeGithubSettings } = await import('./github-cred.js');
    const noGh = async () => {
      throw new Error('no gh');
    };
    const okGh = async () => ' ghs_login ';
    const dir = tmp();
    expect(await describeGithubCred(dir, noGh)).toEqual({ source: 'none', tokenTail: '', ghLoggedIn: false });
    expect(await describeGithubCred(dir, okGh)).toEqual({ source: 'gh-cli', tokenTail: '', ghLoggedIn: true });
    writeGithubSettings(dir, { token: 'ghp_mysecret99', defaultRepo: 'a/b' });
    expect(await describeGithubCred(dir, okGh)).toEqual({ source: 'stored-pat', tokenTail: 'et99', ghLoggedIn: true });
  });

  it('resolveGithubToken：存储优先（gh 不被调用）→ gh 兜底 → 双空 null', async () => {
    const { resolveGithubToken, writeGithubSettings } = await import('./github-cred.js');
    let ghCalls = 0;
    const gh = async () => {
      ghCalls++;
      return 'ghtok';
    };
    const dir = tmp();
    writeGithubSettings(dir, { token: 'stored' });
    expect(await resolveGithubToken(dir, gh)).toBe('stored');
    expect(ghCalls).toBe(0);
    writeGithubSettings(dir, {});
    expect(await resolveGithubToken(dir, gh)).toBe('ghtok');
    expect(
      await resolveGithubToken(dir, async () => {
        throw new Error('no gh');
      }),
    ).toBeNull();
    expect(await resolveGithubToken(dir, async () => '  ')).toBeNull();
  });

  it('POST unlink：只清 PAT，defaultRepo 留着；GET 随即回落 source=gh-cli', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir, async () => 'ghtok12345');
    try {
      await app.inject({ method: 'PUT', url: '/api/github/cred', payload: { token: 'ghp_ab', defaultRepo: 'me/repo' } });
      const r = await app.inject({ method: 'POST', url: '/api/github/cred/unlink' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ unlinked: true, defaultRepo: 'me/repo' });
      const get = await app.inject({ method: 'GET', url: '/api/github/cred' });
      expect(get.json()).toMatchObject({ tokenConfigured: false, source: 'gh-cli', tokenTail: '', ghLoggedIn: true, defaultRepo: 'me/repo' });
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'github.json'), 'utf8'))).toEqual({ defaultRepo: 'me/repo' });
    } finally {
      await app.close();
    }
  });

  it('create-issue 无存储 PAT → gh 登录态兜底直调（Authorization 用 gh token）', async () => {
    const dir = tmp();
    const { writeGithubSettings } = await import('./github-cred.js');
    writeGithubSettings(dir, { defaultRepo: 'owner/repo' }); // 只有仓库，没有 token
    const { app } = await buildServer(dir, async () => 'ghtok-9527');
    try {
      const { requests } = stubFetch(() => ({ status: 201, json: { number: 7, html_url: 'https://gh/o/r/i/7' } }));
      const res = await app.inject({ method: 'POST', url: '/api/github/create-issue', payload: { title: 't' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ number: 7 });
      expect(requests[0]!.headers?.Authorization).toBe('Bearer ghtok-9527');
    } finally {
      await app.close();
    }
  });

  it('wiki publish 无存储 PAT 也过凭据门（gh 兜底后进到 repo/绿单门，不再报未配置）', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir, async () => 'ghtok');
    try {
      const res = await app.inject({ method: 'POST', url: '/api/wiki/publish', payload: { runId: 'x' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('找不到'); // 凭据门已过（gh 兜底），卡在查无此 run
      expect(res.json().error).not.toContain('凭据');
    } finally {
      await app.close();
    }
  });
});

describe('v10-X 登录名显示（@user）', () => {
  it('describeGithubCred：有可用 token 才探登录名；探不到不带 login 键', async () => {
    const { describeGithubCred, writeGithubSettings } = await import('./github-cred.js');
    const noGh = async () => {
      throw new Error('no gh');
    };
    let probed: string[] = [];
    const lookup = async (t: string) => {
      probed.push(t);
      return 'octocat';
    };
    const dir = tmp();
    // 无凭据：不探测（零网络）
    expect(await describeGithubCred(dir, noGh, lookup)).toEqual({ source: 'none', tokenTail: '', ghLoggedIn: false });
    expect(probed).toEqual([]);
    // gh 登录态兜底：用 gh token 探
    expect(await describeGithubCred(dir, async () => 'ghtok ', lookup)).toEqual({
      source: 'gh-cli',
      tokenTail: '',
      ghLoggedIn: true,
      login: 'octocat',
    });
    expect(probed).toEqual(['ghtok']);
    // 存储 PAT 优先：用存储 token 探
    probed = [];
    writeGithubSettings(dir, { token: 'ghp_mysecret99' });
    const r = await describeGithubCred(dir, async () => 'ghtok', lookup);
    expect(r).toMatchObject({ source: 'stored-pat', login: 'octocat' });
    expect(probed).toEqual(['ghp_mysecret99']);
    // 探不到 → login 键整个缺席（前端据缺席显示「没探到」）
    expect(await describeGithubCred(dir, noGh, async () => null)).toEqual({
      source: 'stored-pat',
      tokenTail: 'et99',
      ghLoggedIn: false,
    });
  });

  it('GET /api/github/cred 透传 login；探测失败时字段缺席', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir, undefined, async () => 'flow-zfl');
    try {
      await app.inject({ method: 'PUT', url: '/api/github/cred', payload: { token: 'ghp_x1', defaultRepo: 'a/b' } });
      const get = await app.inject({ method: 'GET', url: '/api/github/cred' });
      expect(get.json()).toMatchObject({ source: 'stored-pat', login: 'flow-zfl' });
    } finally {
      await app.close();
    }
    const { app: app2 } = await buildServer(dir); // 默认桩=探不到
    try {
      const get = await app2.inject({ method: 'GET', url: '/api/github/cred' });
      expect(get.json()).not.toHaveProperty('login');
    } finally {
      await app2.close();
    }
  });

  it('githubApiLogin：GET /user 取 login；401/网络炸都返回 null 不抛', async () => {
    const { githubApiLogin } = await import('./github-cred.js');
    const ok = async (url: string) => {
      expect(url).toBe('https://api.github.com/user');
      return new Response(JSON.stringify({ login: 'cat' }), { status: 200 });
    };
    expect(await githubApiLogin('t', ok as typeof fetch)).toBe('cat');
    expect(await githubApiLogin('t', (async () => new Response('{}', { status: 401 })) as typeof fetch)).toBeNull();
    expect(await githubApiLogin('t', (async () => {
      throw new Error('timeout');
    }) as typeof fetch)).toBeNull();
  });
});
