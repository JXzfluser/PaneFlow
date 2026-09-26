import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { Store } from '../orchestrate/store.js';
import type { RunProduct, RunRecord } from '@paneflow/shared';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import { productSha, shelfRunDir } from '../orchestrate/products.js';

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

/**
 * v13-K1 产物架侧接线：一处清单两个来源 + ?src=shelf 的取证读取。
 * 台账条目一律用 shared 的 RunProduct 类型标注——端点返回形状若与类型分叉，编译期就红，
 * 不在测试里自造 payload 充数。
 */
describe('v13-K1 产物架侧读取', () => {
  /** 在架上手放一份产物原文，并给出与之内洽的台账条目（sha 从同一串内容实算） */
  function seedShelf(dataDir: string, runId: string, nodeId: string, name: string, content: string): RunProduct {
    const dir = path.join(shelfRunDir(dataDir, runId), nodeId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
    return {
      name,
      kind: 'doc',
      sha: productSha(content),
      bytes: Buffer.byteLength(content, 'utf8'),
      shelved: true,
    };
  }

  it('一处清单两个来源：workspace 与 shelf 各带 source，架侧条目挂台账指纹', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const { run } = makeWorkspace();
    const plan = seedShelf(dataDir, run.runId, 'impl', 'plan.md', '# 计划\n上架原文');
    new Store(dataDir).saveRun({
      ...run,
      nodes: { impl: { ...run.nodes.impl!, products: [plan, { ...plan, name: 'big.md', shelved: false, shelfError: 'over-run-cap（…）' }] } },
    });
    const { app } = await buildServer(dataDir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-shelf/artifacts', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        files: { name: string; source: string; nodeId?: string; sha?: string; bytes?: number; shelved?: boolean }[];
      };
      const ws = body.files.find((f) => f.name === 'impl.json');
      expect(ws?.source).toBe('workspace');
      const shelf = body.files.find((f) => f.name === 'impl/plan.md');
      expect(shelf?.source).toBe('shelf');
      expect(shelf?.nodeId).toBe('impl');
      expect(shelf?.sha).toBe(plan.sha);
      expect(shelf?.bytes).toBe(plan.bytes);
      expect(shelf?.shelved).toBe(true);
      // 被上限拒的件没上盘：清单以盘上实然为准，绝不替台账把「未上架」列成一个可读条目
      expect(body.files.some((f) => f.name === 'impl/big.md')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('?src=shelf 读上架原文；未登记/未上架/指纹不符/脏 src 各得一句指路', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const { run } = makeWorkspace();
    const plan = seedShelf(dataDir, run.runId, 'impl', 'plan.md', '架上原文');
    new Store(dataDir).saveRun({ ...run, nodes: { impl: { ...run.nodes.impl!, products: [plan] } } });
    const { app } = await buildServer(dataDir);
    const file = (q: string) =>
      app.inject({ method: 'GET', url: `/api/runs/r-shelf/artifacts/file?${q}`, headers: { host: HOST } });
    try {
      const ok = await file(`path=${encodeURIComponent('impl/plan.md')}&src=shelf`);
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { content: string }).content).toBe('架上原文');

      // 缺 src=shelf 时同一格路径仍在 workspace 侧找不到（两侧不混为一谈）
      const wsMiss = await file(`path=${encodeURIComponent('impl/plan.md')}`);
      expect(wsMiss.statusCode).toBe(404);

      const noLedger = await file(`path=${encodeURIComponent('impl/ghost.md')}&src=shelf`);
      expect(noLedger.statusCode).toBe(404);
      expect((noLedger.json() as { error: string }).error).toContain('只读台账登记过的件');

      const badSrc = await file(`path=${encodeURIComponent('impl/plan.md')}&src=everywhere`);
      expect(badSrc.statusCode).toBe(400);
      expect((badSrc.json() as { error: string }).error).toContain('workspace / shelf');

      // 未上架：台账说没上架，架上的文件就不算数
      new Store(dataDir).saveRun({
        ...run,
        nodes: { impl: { ...run.nodes.impl!, products: [{ ...plan, shelved: false, shelfError: 'write-failed:磁盘满了' }] } },
      });
      const notShelved = await file(`path=${encodeURIComponent('impl/plan.md')}&src=shelf`);
      expect(notShelved.statusCode).toBe(404);
      expect((notShelved.json() as { error: string }).error).toContain('未上架（write-failed:磁盘满了）');

      // 台账回到「已上架」，架上内容却被人换过=指纹不符：宁可说取不到，也不交出一份对不上账的原文
      new Store(dataDir).saveRun({ ...run, nodes: { impl: { ...run.nodes.impl!, products: [plan] } } });
      fs.writeFileSync(path.join(shelfRunDir(dataDir, run.runId), 'impl', 'plan.md'), '被人改过的一份');
      const tampered = await file(`path=${encodeURIComponent('impl/plan.md')}&src=shelf`);
      expect(tampered.statusCode).toBe(404);
      expect((tampered.json() as { error: string }).error).toContain('指纹不符');
    } finally {
      await app.close();
    }
  });

  it('工作区蒸发也不瞎：cwd 侧无产物目录、架上有原件 → exists=true 且清单给架侧条目', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const { run } = makeWorkspace();
    // 模拟 worktree/工作区已被回收：run.cwd 存在但 .herdr/artifacts 不在
    fs.rmSync(path.join(run.cwd, '.herdr', 'artifacts'), { recursive: true, force: true });
    const plan = seedShelf(dataDir, run.runId, 'impl', 'plan.md', '回收后只剩这份');
    new Store(dataDir).saveRun({ ...run, nodes: { impl: { ...run.nodes.impl!, products: [plan] } } });
    const { app } = await buildServer(dataDir);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs/r-shelf/artifacts', headers: { host: HOST } });
      const body = res.json() as { exists: boolean; files: { name: string; source: string }[] };
      expect(body.exists).toBe(true);
      expect(body.files.map((f) => `${f.source}:${f.name}`)).toEqual(['shelf:impl/plan.md']);
    } finally {
      await app.close();
    }
  });

  it('真删除 purgeArtifacts=1：工作区侧与架侧一起清，计数含两侧', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-data-'));
    const { cwd, run } = makeWorkspace();
    seedShelf(dataDir, run.runId, 'impl', 'plan.md', '上架原文');
    new Store(dataDir).saveRun({ ...run, archived: true });
    const { app } = await buildServer(dataDir);
    try {
      const del = await app.inject({
        method: 'DELETE',
        url: '/api/runs/r-shelf/archive?purgeArtifacts=1',
        headers: { host: HOST },
      });
      expect(del.statusCode).toBe(200);
      expect((del.json() as { purgedArtifacts: number }).purgedArtifacts).toBe(2);
      expect(fs.existsSync(path.join(cwd, '.herdr', 'artifacts', 'impl.json'))).toBe(false);
      expect(fs.existsSync(shelfRunDir(dataDir, run.runId))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
