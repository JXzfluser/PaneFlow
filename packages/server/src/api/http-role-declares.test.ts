import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v13-W3 Role.declares 的入库面机检（PUT /api/roles）：判据只有一条姿势——
 * **脏形状在入库前就拒**（fail-closed 宁拒不错放，与 W1 装备槽 / B1 delivery 同款）：
 * 拼错的面（gitpush=）到收口对账现场只会静默失效——「声明了却永远对不上账」正是
 * 本片要防的事故，所以未知面一律 400 指路，绝不悄悄丢键放行。
 * 跑法与 http-role-profile.test.ts 同款：app.inject 打真路由，不碰内部实现。
 */

const HOST = '127.0.0.1:4310';

async function buildServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-roledecl-'));
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

const putRoles = (app: Awaited<ReturnType<typeof buildServer>>["app"], roles: unknown) =>
  app.inject({ method: 'PUT', url: '/api/roles', headers: { host: HOST }, payload: { roles } });

describe('PUT /api/roles 的 declares 机检（v13-W3：三面布尔，脏形状 400 一句指路）', () => {
  it('合法三面 PUT→GET 原样往返；不给 declares 键=旧语义一字不变；显式 {{}} 也照存', async () => {
    const { app } = await buildServer();
    try {
      const ok = await putRoles(app, [
        { id: 'r-deliver', name: '交付岗', declares: { gitPush: false, prOpen: true, issueWrite: true } },
        { id: 'r-plain', name: '安静岗' },
      ]);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ saved: 2 });
      const got = await app.inject({ method: 'GET', url: '/api/roles', headers: { host: HOST } });
      const roles = got.json().roles as { id: string; declares?: unknown }[];
      expect(roles.find((r) => r.id === 'r-deliver')!.declares).toEqual({
        gitPush: false,
        prOpen: true,
        issueWrite: true,
      });
      expect('declares' in (roles.find((r) => r.id === 'r-plain') as Record<string, unknown>)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('未知面 400（拼错=声明静默失效，宁拒不错放）：文案点出坏面并列出可用面', async () => {
    const { app, dataDir } = await buildServer();
    try {
      const res = await putRoles(app, [{ id: 'r1', name: '甲', declares: { gitpush: false } }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('gitpush');
      expect(res.json().error).toContain('gitPush/prOpen/issueWrite');
      // 拒 = 整库不落盘（宁缺毋假：不把半本脏库放上岗）
      expect(fs.existsSync(path.join(dataDir, 'roles.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('面值非布尔 400：字符串 "false" 不是 false（写错型声明比没声明更坏）', async () => {
    const { app } = await buildServer();
    try {
      for (const declares of [
        { gitPush: 'false' },
        { prOpen: 0 },
        { issueWrite: null },
      ]) {
        const res = await putRoles(app, [{ id: 'r1', name: '甲', declares }]);
        expect(res.statusCode, JSON.stringify(declares)).toBe(400);
        expect(res.json().error).toContain('布尔');
      }
    } finally {
      await app.close();
    }
  });

  it('declares 不是对象（字符串/数组/null）400 一句指路；不声明就不给这个键', async () => {
    const { app } = await buildServer();
    try {
      for (const declares of ['gitPush=false', ['gitPush'], null, 42]) {
        const res = await putRoles(app, [{ id: 'r1', name: '甲', declares }]);
        expect(res.statusCode, JSON.stringify(declares)).toBe(400);
        expect(res.json().error).toContain('必须是对象');
      }
    } finally {
      await app.close();
    }
  });

  it('显式 declares:{} 放行（配过且清空=合法的「一面都没声明」），且收口面读端当没声明处理', async () => {
    const { app } = await buildServer();
    try {
      const res = await putRoles(app, [{ id: 'r1', name: '甲', declares: {} }]);
      expect(res.statusCode).toBe(200);
      const got = await app.inject({ method: 'GET', url: '/api/roles', headers: { host: HOST } });
      expect(got.json().roles[0].declares).toEqual({});
    } finally {
      await app.close();
    }
  });
});
