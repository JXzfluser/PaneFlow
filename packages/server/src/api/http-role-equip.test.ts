import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { registerRegistryRoutes } from './registry-routes.js';
import { RegistryStore } from '../orchestrate/registry.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v14 A5-5b 装备槽 `{kind,id}` 的**写入面**（`PUT /api/roles`）。
 *
 * 判据层已在 `orchestrate/registry-equip.test.ts` 逐格钉过，这里只断四件事：
 *  1. 引用对象**存得进去也读得出来**（原样往返，不在 HTTP 薄壳里被洗成字符串）；
 *  2. 悬挂的定点引用 400，且**名册一个字节没动**（整本覆写是原子的：拒了却少一枚岗比不拦更糟）；
 *  3. 裸串指向未登记路径**照存**（池子语义今天就不判死活，一并拒=替存量名册改判据）；
 *  4. 这一片真正的兑现点——名册里存了引用之后，注册表那一面对同一枚条目的删除**被引用账拦住**。
 * 外加注册表读不出＝500（读不出降级成「没有悬挂」就是给写入开绿灯）。
 */

const HOST = '127.0.0.1:4310';

async function build(withRegistryRoutes = false) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-http-equip-'));
  const { app } = await buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
  if (withRegistryRoutes) registerRegistryRoutes(app, { registry: new RegistryStore(dataDir), dataDir });
  return { app, dataDir };
}

const rolesFile = (dataDir: string): string => path.join(dataDir, 'roles.json');
const readRoles = (dataDir: string): unknown[] => JSON.parse(fs.readFileSync(rolesFile(dataDir), 'utf8')) as unknown[];

const putRoles = (app: Awaited<ReturnType<typeof build>>['app'], roles: unknown) =>
  app.inject({ method: 'PUT', url: '/api/roles', headers: { host: HOST }, payload: { roles } });

/** 在 fixture dataDir 上直接登记一枚条目（走真注册表，spec 形状由内核校验） */
function addEntry(dataDir: string, raw: Record<string, unknown>): string {
  const r = new RegistryStore(dataDir).add(raw);
  if (!r.ok || !r.entry) throw new Error(`fixture 登记失败：${r.why ?? '没回条目'}`);
  return r.entry.id;
}

describe('PUT /api/roles 的装备槽引用（v14-A5-5b）', () => {
  it('可解析的 {kind,id}：200 且原样往返（引用对象不被洗成字符串、不预解析成路径）', async () => {
    const { app, dataDir } = await build();
    try {
      const id = addEntry(dataDir, { kind: 'skill', name: 'deploy', spec: { space: 'demo', file: 'skills/deploy.md' } });
      const res = await putRoles(app, [{ id: 'r-arm', name: '装备岗', skills: [{ kind: 'skill', id }], rules: ['docs/x.md'] }]);
      expect(res.statusCode).toBe(200);
      expect(readRoles(dataDir)).toEqual([
        { id: 'r-arm', name: '装备岗', skills: [{ kind: 'skill', id }], rules: ['docs/x.md'] },
      ]);
      const got = await app.inject({ method: 'GET', url: '/api/roles', headers: { host: HOST } });
      const role = (got.json().roles as Record<string, unknown>[]).find((r) => r.id === 'r-arm')!;
      expect(role.skills).toEqual([{ kind: 'skill', id }]);
    } finally {
      await app.close();
    }
  });

  it('悬挂的定点引用 400：拒句点名岗与那一格，名册不落盘（装备没换上却以为换上了=本片要防的事故）', async () => {
    const { app, dataDir } = await build();
    try {
      const res = await putRoles(app, [
        { id: 'r-ok', name: '好岗', skills: ['skills/a.md'] },
        { id: 'r-bad', name: '坏岗', skills: [{ kind: 'skill', id: 'skill:ghost' }] },
      ]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('岗「r-bad」的 skills[0]');
      expect(res.json().error).toContain('skill:ghost');
      expect(res.json().error).toContain('再存名册');
      expect(fs.existsSync(rolesFile(dataDir))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('裸串不判死活：指向未登记路径照存（跨项目复用是它的语义，不是它的毛病）', async () => {
    const { app, dataDir } = await build();
    try {
      const res = await putRoles(app, [{ id: 'r-old', name: '存量岗', skills: ['skills/never-registered.md'] }]);
      expect(res.statusCode).toBe(200);
      expect(readRoles(dataDir)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('脏形状在形状闸就拒（含未知键、空 id、错 kind），一句指路带格子下标', async () => {
    const { app, dataDir } = await build();
    try {
      for (const slot of [
        { kind: 'skill', filed: 'x' },
        { kind: 'skill', id: '  ' },
        { kind: 'model', id: 'model:x' },
        123,
      ]) {
        const res = await putRoles(app, [{ id: 'r1', name: '甲', skills: ['ok.md', slot] }]);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('skills[1] 形状不认');
      }
      expect(fs.existsSync(rolesFile(dataDir))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('注册表读不出＝500 不放行（读不出≠没有悬挂），名册不落盘', async () => {
    const { app, dataDir } = await build();
    try {
      fs.mkdirSync(path.join(dataDir, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'registry', 'entries.json'), '{ 破烂');
      const res = await putRoles(app, [{ id: 'r1', name: '甲', skills: [{ kind: 'skill', id: 'skill:deploy' }] }]);
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain('注册表读不出');
      expect(res.json().error).toContain('这次不保存名册');
      expect(fs.existsSync(rolesFile(dataDir))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('兑现点：名册存了引用之后，注册表删那枚条目被引用账拦住并点名岗', async () => {
    const { app, dataDir } = await build(true);
    try {
      const id = addEntry(dataDir, { kind: 'rule', name: 'review-doc', spec: { space: 'demo', file: 'docs/review.md' } });
      expect((await putRoles(app, [{ id: 'r-rev', name: '评审岗', rules: [{ kind: 'rule', id }] }])).statusCode).toBe(200);
      const del = await app.inject({ method: 'DELETE', url: `/api/registry/${id}`, headers: { host: HOST } });
      expect(del.statusCode).toBe(400);
      expect(del.json().error).toContain('评审岗');
      expect(del.json().error).toContain('rules[0]');
      // 引用写法用 slug 也一样进账（岗那一侧三种写法都认，账就得三种都看得见）
      const id2 = addEntry(dataDir, { kind: 'skill', name: 'export-guard', spec: { space: 'demo', file: 'skills/export.md' } });
      expect((await putRoles(app, [{ id: 'r-x', name: '导出岗', skills: [{ kind: 'skill', id: 'export-guard' }] }])).statusCode).toBe(200);
      const del2 = await app.inject({ method: 'DELETE', url: `/api/registry/${id2}`, headers: { host: HOST } });
      expect(del2.statusCode).toBe(400);
      expect(del2.json().error).toContain('导出岗');
    } finally {
      await app.close();
    }
  });
});
