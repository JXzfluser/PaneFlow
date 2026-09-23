import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DagGraph } from '@paneflow/shared';
import { buildHttpServer } from './http.js';
import { writeGithubSettings } from './github-cred.js';
import type { Engine } from '../orchestrate/engine.js';
import type { HerdrOps } from '../orchestrate/herdr-ops.js';
import type { Store } from '../orchestrate/store.js';

/**
 * v8-I1 路由接线：/api/dispatch 的两个新消费点——
 *  1) profile.skills → Planner 技能索引；
 *  2) 裸 #123 无默认仓 → profile.repos 的 origin 候选仓依次试拉。
 */
function buildServer(dataDir: string, onRun: (graph: DagGraph) => void) {
  const engine = {
    onChange: () => {},
    startRun: async (graph: DagGraph) => {
      onRun(graph);
      return { runId: 'r-1' };
    },
  } as unknown as Engine;
  return buildHttpServer({
    engine,
    store: {} as unknown as Store,
    ops: {} as unknown as HerdrOps,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    // U2：issue 拉取兜底探 gh——桩为未登录，测试不碰本机钥匙串
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
  });
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dispatch-'));
const HOST = '127.0.0.1:4310';

describe('POST /api/dispatch（v8-I1 接线）', () => {
  it('profile.skills 出现在 Planner 技能索引（名字+首行描述）', async () => {
    const dataDir = tmp();
    const root = tmp();
    fs.writeFileSync(path.join(root, 'sk.md'), '# 灰度发布做法\n正文略');
    let graph!: DagGraph;
    const { app } = await buildServer(dataDir, (g) => (graph = g));
    try {
      await app.inject({ method: 'PUT', url: '/api/spaces/demo', headers: { host: HOST }, payload: { rootCwd: root, skills: ['sk.md'] } });
      const res = await app.inject({ method: 'POST', url: '/api/dispatch?space=demo', headers: { host: HOST }, payload: { task: '把服务灰度上去' } });
      expect(res.statusCode).toBe(200);
      const planner = graph.nodes.find((n) => n.id === 'planner')!;
      expect(planner.config.prompt).toContain('本空间技能库 1 项');
      expect(planner.config.prompt).toContain('- sk —— 灰度发布做法');
    } finally {
      await app.close();
    }
  });

  it('裸 #123 无默认仓：按 repos 登记的 origin 依次试候选仓，首个命中即用', async () => {
    const dataDir = tmp();
    const root = tmp();
    writeGithubSettings(dataDir, { token: 'tok' }); // 有 token、无 defaultRepo → 走候选链
    for (const [dir, url] of [
      ['alpha', 'git@github.com:o/alpha.git'],
      ['beta', 'https://github.com/o/beta.git'],
    ] as const) {
      const p = path.join(root, dir);
      fs.mkdirSync(p, { recursive: true });
      execFileSync('git', ['init', '-q', p]);
      execFileSync('git', ['-C', p, 'remote', 'add', 'origin', url]);
    }
    let graph!: DagGraph;
    const { app } = await buildServer(dataDir, (g) => (graph = g));
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('/repos/o/alpha/')) {
        return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
      }
      if (u.includes('/repos/o/beta/issues/123/comments')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (u.includes('/repos/o/beta/issues/123')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ number: 123, title: '修个导出', body: '导出为空时报警', state: 'open', html_url: 'u', labels: [] }),
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    try {
      await app.inject({ method: 'PUT', url: '/api/spaces/demo', headers: { host: HOST }, payload: { rootCwd: root, repos: ['alpha', 'beta'] } });
      const res = await app.inject({ method: 'POST', url: '/api/dispatch?space=demo', headers: { host: HOST }, payload: { task: '按 #123 修复' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().issueFetched).toBe(true);
      // 先试 alpha（404）再中 beta——顺序与去重由 candidateRepos 单测保证，这里验路由真用了候选
      expect(seen.some((u) => u.includes('/repos/o/alpha/issues/123'))).toBe(true);
      const planner = graph.nodes.find((n) => n.id === 'planner')!;
      expect(planner.config.prompt).toContain('关联 Issue #123（o/beta');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('候选全落空 → 照旧降级为纯任务执行，note 带末次错误', async () => {
    const dataDir = tmp();
    const root = tmp();
    writeGithubSettings(dataDir, { token: 'tok' });
    const p = path.join(root, 'solo');
    fs.mkdirSync(p, { recursive: true });
    execFileSync('git', ['init', '-q', p]);
    execFileSync('git', ['-C', p, 'remote', 'add', 'origin', 'git@github.com:o/solo.git']);
    const { app } = await buildServer(dataDir, () => {});
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, json: async () => ({ message: 'Requires authentication' }) }));
    try {
      await app.inject({ method: 'PUT', url: '/api/spaces/demo', headers: { host: HOST }, payload: { rootCwd: root, repos: ['solo'] } });
      const res = await app.inject({ method: 'POST', url: '/api/dispatch?space=demo', headers: { host: HOST }, payload: { task: '看 #77 办' } });
      expect(res.json().issueFetched).toBe(false);
      expect(res.json().note).toContain('Requires authentication');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});
