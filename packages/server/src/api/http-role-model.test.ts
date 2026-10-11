import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v19-M1 Role.model 的入库面机检（PUT /api/roles）：与 declares/equip 槽同一条姿态——
 * **脏形状在保存前就拒**。这枚值会原样注进启动 argv（`--model <值>`），含空白=两枚参数、
 * 空白键=静默失效，都是「以为换了模型」的事故面。跑法同 http-role-declares.test.ts：
 * app.inject 打真路由，不碰内部实现。
 */

const HOST = '127.0.0.1:4310';

async function buildServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-rolemodel-'));
  const { app } = await buildHttpServer({
    engine: { onChange: () => {}, listRuns: () => [] } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
  });
  return { app, dataDir };
}

const putRoles = (app: Awaited<ReturnType<typeof buildServer>>['app'], roles: unknown) =>
  app.inject({ method: 'PUT', url: '/api/roles', headers: { host: HOST }, payload: { roles } });

describe('PUT /api/roles 的 model 机检（v19-M1：单串非空，脏形状 400 一句指路）', () => {
  it('合法值 PUT→GET 原样往返；不给 model 键=旧语义一字不变', async () => {
    const { app } = await buildServer();
    try {
      const ok = await putRoles(app, [
        { id: 'r-model', name: '换模岗', model: 'gpt-4o' },
        { id: 'r-plain', name: '安静岗' },
      ]);
      expect(ok.statusCode).toBe(200);
      const got = await app.inject({ method: 'GET', url: '/api/roles', headers: { host: HOST } });
      const roles = got.json().roles as Record<string, unknown>[];
      expect(roles.find((r) => r.id === 'r-model')!.model).toBe('gpt-4o');
      expect('model' in (roles.find((r) => r.id === 'r-plain') as Record<string, unknown>)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('provider/id 拼法照存（不猜引擎方言，值域是「单串」不是「枚举」）', async () => {
    const { app } = await buildServer();
    try {
      const ok = await putRoles(app, [{ id: 'r-pi', name: 'Pi岗', model: 'paneflow-gw/deepseek-r1:thinking' }]);
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('脏形状全拒并点名指路：空白/含空格/非字符串/超长', async () => {
    const { app } = await buildServer();
    try {
      for (const bad of ['   ', 'gpt 4o', 42, 'x'.repeat(121)]) {
        const res = await putRoles(app, [{ id: 'r-x', name: '岗', model: bad }]);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('model 非法');
      }
      // 拒过一次就不许留脏名册：GET 回来仍是空库
      const got = await app.inject({ method: 'GET', url: '/api/roles', headers: { host: HOST } });
      expect(got.json().roles).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
