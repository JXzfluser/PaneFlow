import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { Store } from '../orchestrate/store.js';
import type { RunRecord } from '@paneflow/shared';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';

/** v8-H2 产物货架：列表/单文件读取（防穿越）/下载/真删除可选联动清理产物 */

const HOST = '127.0.0.1:4310';

function buildServer(dataDir: string) {
  const engine = {
    onChange: () => {},
    listRuns: () => [],
    getRun: () => undefined,
  } as unknown as Engine;
  return buildHttpServer({
    engine,
    store: new Store(dataDir),
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
  });
}

/** 一个带产物目录的 run 工作区：artifacts 下有 impl.json（对应节点）与 notes.txt（杂项） */
function makeWorkspace(): { cwd: string; run: RunRecord } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-'));
  const artDir = path.join(cwd, '.herdr', 'artifacts');
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, 'impl.json'), JSON.stringify({ summary: '实现完成' }));
  fs.writeFileSync(path.join(artDir, 'notes.txt'), '杂项说明');
  fs.writeFileSync(path.join(artDir, 'blob.dat'), Buffer.from([0x89, 0, 0x50, 0]));
  const run: RunRecord = {
    runId: 'r-shelf',
    dagName: 'shelf-dag',
    graph: {
      name: 'shelf-dag',
      nodes: [{ id: 'impl', type: 'agent', label: '实现', config: {} }],
      edges: [],
    } as unknown as RunRecord['graph'],
    state: 'completed',
    cwd,
    nodes: { impl: { nodeId: 'impl', state: 'done', attempts: 1 } },
    startedAt: '2026-09-19T00:00:00.000Z',
  };
  return { cwd, run };
}

describe('v8-H2 产物货架', () => {
  it('列表：产物文件带元数据，<nodeId>.json 挂上节点信息；无目录时 exists=false 不报错', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const { cwd, run } = makeWorkspace();
    new Store(dir).saveRun(run);
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-shelf/artifacts', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { dir: string; exists: boolean; files: { name: string; nodeId?: string; nodeLabel?: string; nodeState?: string; size: number }[] };
      expect(body.dir).toBe(path.join(cwd, '.herdr', 'artifacts'));
      expect(body.exists).toBe(true);
      const impl = body.files.find((f) => f.name === 'impl.json');
      expect(impl?.nodeId).toBe('impl');
      expect(impl?.nodeLabel).toBe('实现');
      expect(impl?.nodeState).toBe('done');
      expect(body.files.find((f) => f.name === 'notes.txt')?.nodeId).toBeUndefined();
      expect(body.files.find((f) => f.name === 'notes.txt')?.size).toBeGreaterThan(0);

      const ghost = await app.inject({ method: 'GET', url: '/api/runs/nope/artifacts', headers: { host: HOST } });
      expect(ghost.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('空产物目录的存在性：cwd 无 .herdr/artifacts 时 exists=false、files=[]', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-empty-'));
    const { run } = makeWorkspace();
    new Store(dir).saveRun({ ...run, cwd });
    const { app } = await buildServer(dir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-shelf/artifacts', headers: { host: HOST } });
      const body = res.json() as { exists: boolean; files: unknown[] };
      expect(body.exists).toBe(false);
      expect(body.files).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('单文件：内联可读；穿越路径 400；不存在 404；二进制拒预览 415；raw=1 走下载', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const { run } = makeWorkspace();
    new Store(dir).saveRun(run);
    const { app } = await buildServer(dir);
    try {
      const ok = await app.inject({ method: 'GET', url: `/api/runs/r-shelf/artifacts/file?path=${encodeURIComponent('impl.json')}`, headers: { host: HOST } });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { content: string }).content).toContain('实现完成');

      const traversal = await app.inject({ method: 'GET', url: `/api/runs/r-shelf/artifacts/file?path=${encodeURIComponent('../notes-outside')}`, headers: { host: HOST } });
      expect(traversal.statusCode).toBe(400);
      const abs = await app.inject({ method: 'GET', url: `/api/runs/r-shelf/artifacts/file?path=${encodeURIComponent('/etc/passwd')}`, headers: { host: HOST } });
      expect(abs.statusCode).toBe(400);

      const missing = await app.inject({ method: 'GET', url: `/api/runs/r-shelf/artifacts/file?path=${encodeURIComponent('ghost.json')}`, headers: { host: HOST } });
      expect(missing.statusCode).toBe(404);

      const bin = await app.inject({ method: 'GET', url: `/api/runs/r-shelf/artifacts/file?path=${encodeURIComponent('blob.dat')}`, headers: { host: HOST } });
      expect(bin.statusCode).toBe(415);

      const raw = await app.inject({ method: 'GET', url: `/api/runs/r-shelf/artifacts/file?path=${encodeURIComponent('notes.txt')}&raw=1`, headers: { host: HOST } });
      expect(raw.statusCode).toBe(200);
      expect(raw.headers['content-disposition']).toContain('attachment');
      expect(raw.payload).toBe('杂项说明');
    } finally {
      await app.close();
    }
  });

  it('真删除联动：purgeArtifacts=1 只清本 run 节点的同名产物、杂项文件保留；默认全保留', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const { cwd, run } = makeWorkspace();
    new Store(dir).saveRun({ ...run, archived: true });
    const { app } = await buildServer(dir);
    try {
      const plain = await app.inject({ method: 'DELETE', url: '/api/runs/r-shelf/archive', headers: { host: HOST } });
      expect(plain.statusCode).toBe(200);
      expect((plain.json() as { purgedArtifacts: number }).purgedArtifacts).toBe(0);
      expect(fs.existsSync(path.join(cwd, '.herdr', 'artifacts', 'impl.json'))).toBe(true);
    } finally {
      await app.close();
    }

    // 重新归档一条同 run 记录验证勾选路径
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const ws2 = makeWorkspace();
    new Store(dir2).saveRun({ ...ws2.run, runId: 'r-purge', archived: true });
    const { app: app2 } = await buildServer(dir2);
    try {
      const del = await app2.inject({ method: 'DELETE', url: '/api/runs/r-purge/archive?purgeArtifacts=1', headers: { host: HOST } });
      expect(del.statusCode).toBe(200);
      expect((del.json() as { purgedArtifacts: number }).purgedArtifacts).toBe(1);
      expect(fs.existsSync(path.join(ws2.cwd, '.herdr', 'artifacts', 'impl.json'))).toBe(false);
      expect(fs.existsSync(path.join(ws2.cwd, '.herdr', 'artifacts', 'notes.txt'))).toBe(true);
    } finally {
      await app2.close();
    }
  });
});
