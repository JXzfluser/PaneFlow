import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/** A1（v7）：空间档案保存一致性——全字段回写后重读必须一致。 */
function buildServer(dataDir: string) {
  return buildHttpServer({
    engine: { onChange: () => {} } as unknown as Engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-spaces-'));
}

const HOST = '127.0.0.1:4310';

describe('PUT /api/spaces/:id 保存一致性（v7-A1）', () => {
  it('全字段 PUT 后 GET 重读一致（conventionFiles/skills/repos 不再丢）', async () => {
    const { app } = await buildServer(tmp());
    try {
      const payload = {
        rootCwd: '/repo/main',
        description: 'd',
        conventionFiles: ['AGENTS.md', 'docs/CLAUDE.md'],
        skills: ['skills/pdf'],
        repos: ['svc-a', 'svc-b'],
      };
      const put = await app.inject({ method: 'PUT', url: '/api/spaces/demo', headers: { host: HOST }, payload });
      expect(put.statusCode).toBe(200);
      const get = await app.inject({ method: 'GET', url: '/api/spaces/demo', headers: { host: HOST } });
      const p = get.json();
      expect(p.conventionFiles).toEqual(payload.conventionFiles);
      expect(p.skills).toEqual(payload.skills);
      expect(p.repos).toEqual(payload.repos);
      expect(p.rootCwd).toBe('/repo/main');
    } finally {
      await app.close();
    }
  });

  it('磁盘持久：新 Store 实例（模拟重启服务）读到的档案含勾选字段', async () => {
    const dir = tmp();
    const { app } = await buildServer(dir);
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { conventionFiles: ['AGENTS.md'] },
      });
    } finally {
      await app.close();
    }
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'spaces', 'demo', 'profile.json'), 'utf8')) as Record<string, unknown>;
    expect(raw.conventionFiles).toEqual(['AGENTS.md']);
  });

  it('merge 语义保住未发送的键；空数组是显式清空而非丢失', async () => {
    const { app } = await buildServer(tmp());
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { conventionFiles: ['A.md'], skills: ['s1'] },
      });
      const second = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { rootCwd: '/x', skills: [] },
      });
      const p = second.json();
      expect(p.conventionFiles).toEqual(['A.md']); // 未发送 → 保住
      expect(p.skills).toEqual([]); // 显式空 → 清空
    } finally {
      await app.close();
    }
  });

  it('白名单：name/createdAt/id 不经 body 污染，未知键被忽略', async () => {
    const { app } = await buildServer(tmp());
    try {
      await app.inject({ method: 'PUT', url: '/api/spaces/demo', headers: { host: HOST }, payload: { description: 'ok' } });
      const evil = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST },
        payload: { name: 'hijacked', createdAt: '1999-01-01', id: 'other', rootCwd: '/r', evilKey: 1 } as Record<string, unknown>,
      });
      const p = evil.json();
      expect(evil.statusCode).toBe(200);
      expect(p.name).not.toBe('hijacked');
      expect(p.createdAt).not.toBe('1999-01-01');
      expect(p.id).toBe('demo');
      expect(p.rootCwd).toBe('/r');
      expect((p as Record<string, unknown>).evilKey).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('__proto__ 注入在传输层即被拒（400），到不了白名单', async () => {
    const { app } = await buildServer(tmp());
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/spaces/demo',
        headers: { host: HOST, 'content-type': 'application/json' },
        payload: '{"rootCwd":"/r","__proto__":{"polluted":true}}',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
