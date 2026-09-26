import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v14-T3 实机首驾撞到的模板写面：POST 一具不带 `metadata` 的 graph 以 500 收场
 * （`saveGraph` 直接往 `graph.metadata` 上写时间戳）。这一组钉三件事：
 *  1. 时间戳是服务器的账——客户端不带 metadata 也照样落，不拿 500 糊它；
 *  2. 判据脏（模板名不合规矩）是调用方的错 → 400 带那句人话，不是 500；
 *  3. 判据本身仍只有一处（`Store.saveGraph`），路由只换状态码不重抄规则。
 */
const HOST = '127.0.0.1:4310';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-graph-write-'));
}

async function build(dataDir: string) {
  const { app } = await buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: { ping: async () => ({ version: '0.0.0' }) } as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
  return app;
}

const post = (app: Awaited<ReturnType<typeof build>>, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/graphs', headers: { host: HOST }, payload: payload as never });

const graph = (name: string): DagGraph => ({
  version: 1,
  name,
  nodes: [{ id: 'start', type: 'start', label: '开始', config: {} }],
  edges: [],
  metadata: { createdAt: '', updatedAt: '' },
});

describe('模板写端 POST /api/graphs 的形状面', () => {
  it('不带 metadata 的 graph：201 落盘并补上时间戳（那是服务器的账，不是客户端必填）', async () => {
    const dataDir = tmpRoot();
    const app = await build(dataDir);
    try {
      const bare = { version: 1, name: 'no-meta', nodes: graph('x').nodes, edges: [] };
      const res = await post(app, { graph: bare });
      expect(res.statusCode).toBe(201);
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'graphs', 'no-meta.json'), 'utf8')) as DagGraph;
      expect(saved.metadata.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(saved.metadata.createdAt).toBe(saved.metadata.updatedAt); // 首落＝created 与 updated 同源
      // 客户端自带的旧 createdAt 不被覆写（只补空，不抹历史）
      const second = await post(app, { graph: { ...bare, metadata: { createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '' } } });
      expect(second.statusCode).toBe(201);
      const again = JSON.parse(fs.readFileSync(path.join(dataDir, 'graphs', 'no-meta.json'), 'utf8')) as DagGraph;
      expect(again.metadata.createdAt).toBe('2020-01-01T00:00:00.000Z');
    } finally {
      await app.close();
    }
  });

  it('脏模板名 → 400 带那一句人话（写面撞见脏体不该回服务端 500）', async () => {
    const app = await build(tmpRoot());
    try {
      const res = await post(app, { graph: { ...graph('bad name'), name: 'bad name' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('模板名只能包含字母/数字/-/_');
      const ghost = await post(app, {});
      expect(ghost.statusCode).toBe(400); // 连 graph 都没有：同样是「你这具不对」，且不许留半张模板
      expect(ghost.json().error).toContain('缺少 graph 体');
    } finally {
      await app.close();
    }
  });

  it('PUT 的既有语义零回归：名与 URL 不一致仍 400，一致则落盘', async () => {
    const dataDir = tmpRoot();
    const app = await build(dataDir);
    try {
      const mismatch = await app.inject({
        method: 'PUT',
        url: '/api/graphs/flow-a',
        headers: { host: HOST },
        payload: { graph: graph('flow-b') } as never,
      });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json().error).toContain('graph.name 与 URL id 不一致');
      const ok = await app.inject({
        method: 'PUT',
        url: '/api/graphs/flow-a',
        headers: { host: HOST },
        payload: { graph: graph('flow-a') } as never,
      });
      expect(ok.statusCode).toBe(200);
      expect(fs.existsSync(path.join(dataDir, 'graphs', 'flow-a.json'))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
