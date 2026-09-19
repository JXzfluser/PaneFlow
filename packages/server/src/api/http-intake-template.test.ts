import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { INTAKE_TEMPLATE_PATH, intakeTemplateMarkdown } from './dispatch.js';
import { writeGithubSettings } from './github-cred.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/** M4 接单模板回写：Contents API 探存在→新建/更新/护栏/无变化四路 */
function stubFetch(script: Array<{ status: number; json: unknown }>) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url: String(url), method, body });
      const r = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return new Response(JSON.stringify(r.json), { status: r.status });
    }),
  );
  return calls;
}

async function build(dir: string) {
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dir, 'herdr.sock'),
    dataDir: dir,
  });
}

function tmpWithCred(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-m4-'));
  writeGithubSettings(dir, { token: 'ghp_test', defaultRepo: 'acme/repo' });
  return dir;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('v8-M4 POST /api/github/intake-template', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('无凭据 → 400；repo 非法 → 400', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-m4-bare-'));
    const { app } = await build(bare);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/github/intake-template',
        headers: { host: '127.0.0.1:4310' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/凭据/);
    } finally {
      await app.close();
    }
    const dir = tmpWithCred();
    const s = await build(dir);
    try {
      const res = await s.app.inject({
        method: 'POST',
        url: '/api/github/intake-template',
        headers: { host: '127.0.0.1:4310' },
        payload: { repo: 'not-a-repo' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/repo/);
    } finally {
      await s.app.close();
    }
  });

  it('不存在（404）→ 新建：PUT 不带 sha，写默认路径', async () => {
    const calls = stubFetch([{ status: 404, json: { message: 'Not Found' } }, { status: 201, json: {} }]);
    const { app } = await build(tmpWithCred());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/github/intake-template',
        headers: { host: '127.0.0.1:4310' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ written: true, updated: false, repo: 'acme/repo', path: INTAKE_TEMPLATE_PATH });
      expect(calls[0]!.url).toBe(`https://api.github.com/repos/acme/repo/contents/${INTAKE_TEMPLATE_PATH}`);
      expect(calls[1]!.method).toBe('PUT');
      expect(calls[1]!.body).not.toHaveProperty('sha');
      expect(Buffer.from(String(calls[1]!.body!.content), 'base64').toString('utf8')).toBe(intakeTemplateMarkdown());
    } finally {
      await app.close();
    }
  });

  it('已存在且内容不同：不带 overwrite → 409；带 overwrite → 携 sha 更新', async () => {
    const exist = { status: 200, json: { sha: 'abc123', content: b64('# 别人的模板\n') } };
    // inject#1 只读探一次；inject#2 再读探一次后 PUT
    const calls = stubFetch([exist, exist, { status: 200, json: {} }]);
    const { app } = await build(tmpWithCred());
    try {
      const guard = await app.inject({
        method: 'POST',
        url: '/api/github/intake-template',
        headers: { host: '127.0.0.1:4310' },
        payload: {},
      });
      expect(guard.statusCode).toBe(409);
      expect(guard.json().error).toMatch(/overwrite/);
      expect(calls).toHaveLength(1); // 只探读，未写入

      const forced = await app.inject({
        method: 'POST',
        url: '/api/github/intake-template',
        headers: { host: '127.0.0.1:4310' },
        payload: { overwrite: true, repo: 'other/repo' },
      });
      expect(forced.statusCode).toBe(200);
      expect(forced.json()).toMatchObject({ written: true, updated: true, repo: 'other/repo' });
      expect(calls[2]!.body).toMatchObject({ sha: 'abc123' });
    } finally {
      await app.close();
    }
  });

  it('内容已是最新 → unchanged，不发 PUT', async () => {
    const calls = stubFetch([{ status: 200, json: { sha: 's1', content: b64(intakeTemplateMarkdown()) } }]);
    const { app } = await build(tmpWithCred());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/github/intake-template',
        headers: { host: '127.0.0.1:4310' },
        payload: { overwrite: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ written: false, unchanged: true });
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
