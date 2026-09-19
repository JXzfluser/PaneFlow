import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer, isAllowedOrigin } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/** G2：CORS 收紧 + 跨站写拦截。github 端点只消费 dataDir，其余依赖最小桩。 */
function buildServer(dataDir: string, corsOrigins?: string[]) {
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    corsOrigins,
    // U2：GET /api/github/cred 会探 gh 登录态——桩掉，不依赖本机钥匙串
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
  });
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cors-'));
}

const HOST = '127.0.0.1:4310';
const CRED_FILE = 'github.json'; // 与 ghPath() 落盘名一致的路径探针

describe('isAllowedOrigin (纯函数)', () => {
  it('无 Origin 头放行（curl/脚本/CLI/代理）', () => {
    expect(isAllowedOrigin({ origin: undefined, host: HOST, allowed: [] })).toBe(true);
  });
  it('同源放行（Origin host === Host）', () => {
    expect(isAllowedOrigin({ origin: 'http://127.0.0.1:4310', host: HOST, allowed: [] })).toBe(true);
  });
  it('跨站默认拒绝；白名单精确匹配放行', () => {
    expect(isAllowedOrigin({ origin: 'http://evil.example', host: HOST, allowed: [] })).toBe(false);
    expect(
      isAllowedOrigin({ origin: 'https://ok.example', host: HOST, allowed: ['https://ok.example'] }),
    ).toBe(true);
    // 端口不同即不同源
    expect(isAllowedOrigin({ origin: 'http://127.0.0.1:9999', host: HOST, allowed: [] })).toBe(false);
  });
  it('Origin 解析失败即拒', () => {
    expect(isAllowedOrigin({ origin: 'not-a-url', host: HOST, allowed: ['not-a-url'] })).toBe(false);
  });
});

describe('G2 http 层跨站拦截', () => {
  it('跨站 GET：响应不回 Access-Control-Allow-Origin 头', async () => {
    const { app } = await buildServer(tmp());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/github/cred', headers: { host: HOST, origin: 'http://evil.example' } });
      expect(res.statusCode).toBe(200); // 无浏览器时请求本身可达，但跨站脚本读不到响应
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('跨站 PUT：403 且数据未写盘', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/github/cred',
        headers: { host: HOST, origin: 'http://evil.example' },
        payload: { token: 'stolen-write', defaultRepo: '' },
      });
      expect(res.statusCode).toBe(403);
      expect(fs.existsSync(path.join(dir, CRED_FILE))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('同源 PUT（Origin.host === Host）：正常写盘', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/github/cred',
        headers: { host: HOST, origin: `http://${HOST}` },
        payload: { token: 'ghp_ok', defaultRepo: '' },
      });
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(path.join(dir, CRED_FILE))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('白名单模式的 OPTIONS 预检回显 Allow-Origin', async () => {
    const { app } = await buildServer(tmp(), ['http://evil-but-allowed.example']);
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/github/cred',
        headers: {
          host: HOST,
          origin: 'http://evil-but-allowed.example',
          'access-control-request-method': 'PUT',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://evil-but-allowed.example');
    } finally {
      await app.close();
    }
  });

  it('非浏览器写请求（无 Origin，如 curl/CLI）不受影响', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'PUT', url: '/api/github/cred', headers: { host: HOST }, payload: { token: 't', defaultRepo: 'r/r' } });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
