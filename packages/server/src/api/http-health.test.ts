import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v13-E2 Windows 诚实入账：GET /api/health 两个新标量——
 *  platform：process.platform 原样上报（不判类不改写）；
 *  herdrError：herdr 探测失败的人话原因；拿不到（非 Error/空 message）= 整键省略，宁缺毋假。
 * 明确不测 named-pipe 判别 win32 herdr：实测探不出，猜名字=估算（需求文档已裁撤）。
 */
function buildServer(ops: Partial<HerdrOps>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-health-'));
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: ops as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

const HOST = '127.0.0.1:4310';

describe('GET /api/health 的 platform / herdrError 标量（v13-E2）', () => {
  it('herdr 探测失败：herdrOk=false + herdrError 带人话原因，platform 原样', async () => {
    const { app } = await buildServer({
      ping: async () => {
        throw new Error('connect ENOENT: /tmp/nope/herdr.sock');
      },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.platform).toBe(process.platform);
      expect(body.herdrOk).toBe(false);
      expect(body.herdrError).toBe('connect ENOENT: /tmp/nope/herdr.sock');
    } finally {
      await app.close();
    }
  });

  it('herdr 探测成功：herdrError 整键省略（不塞 null/空串冒充读数）', async () => {
    const { app } = await buildServer({
      ping: (async () => ({ version: '0.8.2' })) as unknown as HerdrOps['ping'],
    });
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } })).json();
      expect(body.herdrOk).toBe(true);
      expect(body.herdrVersion).toBe('0.8.2');
      expect('herdrError' in body).toBe(false);
      expect(body.platform).toBe(process.platform);
    } finally {
      await app.close();
    }
  });

  it('失败但读不出人话（非 Error/空 message）：herdrError 照样整键省略', async () => {
    const { app } = await buildServer({
      ping: async () => {
        throw { weird: 'object' };
      },
    });
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } })).json();
      expect(body.herdrOk).toBe(false);
      expect('herdrError' in body).toBe(false);
    } finally {
      await app.close();
    }
  });
});
