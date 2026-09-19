import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gwd-'));
}

function buildServer(dataDir: string) {
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

describe('v9-D 网关多档与导入路由', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GET /api/gateway：旧扁平配置包成单档「默认档」且不回显 apiKey', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'gateway.json'), JSON.stringify({ baseUrl: 'http://gw', apiKey: 'sk-secret', enabled: true }));
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/gateway' });
      const body = res.json() as Record<string, unknown>;
      expect(body.current).toBe('default');
      expect(JSON.stringify(body.profiles)).not.toContain('sk-secret');
      expect((body.profiles as { name: string; keyConfigured: boolean }[])[0]).toMatchObject({ name: '默认档', keyConfigured: true });
    } finally {
      await app.close();
    }
  });

  it('POST /api/gateway/profile 校验：无名/坏 URL/无 key 都 400；成功则入档不切 current', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/gateway/profile', payload: { baseUrl: 'http://a', apiKey: 'k' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/gateway/profile', payload: { name: 'a', baseUrl: 'ftp://a', apiKey: 'k' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/gateway/profile', payload: { name: 'a', baseUrl: 'http://a' } })).statusCode).toBe(400);
      const first = await app.inject({ method: 'POST', url: '/api/gateway/profile', payload: { name: '甲', baseUrl: 'http://a', apiKey: 'ka' } });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: 'POST', url: '/api/gateway/profile', payload: { name: '乙', baseUrl: 'http://b', apiKey: 'kb' } });
      const get = await app.inject({ method: 'GET', url: '/api/gateway' });
      expect(get.json()).toMatchObject({ current: first.json().id }); // 新档不抢生效位
      expect(second.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('PUT /api/gateway/current：未知档 404；命中后 GET 的 baseUrl/freeModel 跟随切换', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const a = await app.inject({ method: 'POST', url: '/api/gateway/profile', payload: { name: 'A', baseUrl: 'http://a', apiKey: 'ka', freeModel: 'm-a' } });
      const b = await app.inject({ method: 'POST', url: '/api/gateway/profile', payload: { name: 'B', baseUrl: 'http://b', apiKey: 'kb', freeModel: 'm-b' } });
      expect((await app.inject({ method: 'PUT', url: '/api/gateway/current', payload: { id: 'nope' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'PUT', url: '/api/gateway/current', payload: { id: b.json().id } })).json()).toEqual({ ok: true, current: b.json().id });
      const get = await app.inject({ method: 'GET', url: '/api/gateway' });
      expect(get.json()).toMatchObject({ baseUrl: 'http://b', freeModel: 'm-b', current: b.json().id });
      expect(a.json().ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('POST /api/gateway/import：preview 只回掩码候选，带 names 才落盘为新档', async () => {
    const dir = tmp();
    const file = path.join(dir, 'switcher.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { name: '甲', settings: { env: { ANTHROPIC_BASE_URL: 'http://a', ANTHROPIC_AUTH_TOKEN: 'sk-aaaa1111' } } },
          { name: '乙', settings: { env: { ANTHROPIC_BASE_URL: 'http://b', ANTHROPIC_AUTH_TOKEN: 'sk-bbbb2222', ANTHROPIC_MODEL: 'm-b' } } },
        ],
      }),
    );
    const { app } = await buildServer(dir);
    try {
      const bad = await app.inject({ method: 'POST', url: '/api/gateway/import', payload: { path: '/nope/x.json' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toContain('找不到源文件');
      const preview = await app.inject({ method: 'POST', url: '/api/gateway/import', payload: { path: file } });
      expect(preview.json().candidates).toEqual([
        { name: '甲', baseUrl: 'http://a', keyTail: '1111' },
        { name: '乙', baseUrl: 'http://b', keyTail: '2222', freeModel: 'm-b' },
      ]);
      expect(JSON.stringify(preview.json())).not.toContain('sk-');
      const applied = await app.inject({ method: 'POST', url: '/api/gateway/import', payload: { path: file, names: ['乙'] } });
      expect(applied.json()).toEqual({ imported: ['乙'] });
      const get = await app.inject({ method: 'GET', url: '/api/gateway' });
      const names = (get.json().profiles as { name: string }[]).map((p) => p.name);
      expect(names).toEqual(['乙']);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/gateway/profile/:id：唯一档拒删 400 且错误可读', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const a = await app.inject({ method: 'POST', url: '/api/gateway/profile', payload: { name: '孤档', baseUrl: 'http://a', apiKey: 'k' } });
      const res = await app.inject({ method: 'DELETE', url: `/api/gateway/profile/${a.json().id}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('只剩这一档');
    } finally {
      await app.close();
    }
  });
});
