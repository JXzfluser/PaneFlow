import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { Engine } from '../orchestrate/engine.js';
import { FakeHerdrOps } from '../orchestrate/fake-ops.js';
import { Store } from '../orchestrate/store.js';

/**
 * fresh dispatch 实验标：POST /api/dispatch 的 experiment 体键（形状对齐 replay 体与 RunExperimentMeta）。
 * 全链路走真实生产面：buildHttpServer 真路由 + 真 Engine + FakeHerdrOps（engine.test 同款替身，
 * 零 monkeypatch 路由内部）——带标的单起出来后 RunRecord.experiment 在册、收口后收数表真落一行。
 */

const HOST = '127.0.0.1:4310';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dispatch-exp-'));

async function buildRealServer() {
  const dataDir = tmp();
  const root = tmp();
  const ops = new FakeHerdrOps();
  const store = new Store(dataDir);
  const engine = new Engine(ops, store, {
    workspaceLabelPrefix: 'paneflow-',
    promptConfirmWindowMs: 0,
    reconcileIntervalMs: 60_000,
    defaultNodeTimeoutMs: 1_200,
    agentStartTimeoutMs: 5_000,
    agentReadyTimeoutMs: 5_000,
  });
  const { app } = await buildHttpServer({
    engine,
    store,
    ops,
    herdrSocketPath: path.join(dataDir, 'herdr.sock'),
    dataDir,
    readGhCliToken: async () => {
      throw new Error('test: gh not logged in');
    },
    // v13-E2 探针注入面：CI 与本机装了什么不决定断言成败；'fake' 只对 FakeHerdrOps 有意义
    recommendAgentKind: async () => 'fake',
  });
  await app.inject({
    method: 'PUT',
    url: '/api/spaces/exp',
    headers: { host: HOST },
    payload: { rootCwd: root },
  });
  return { app, engine, dataDir };
}

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('condition not met in time'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const dispatch = (app: { inject: (o: object) => Promise<{ statusCode: number; json(): any }> }, payload: object) =>
  app.inject({ method: 'POST', url: '/api/dispatch?space=exp', headers: { host: HOST }, payload });

describe('fresh dispatch 实验标（POST /api/dispatch 的 experiment 体键）', () => {
  it('带 suite 起单：回执+记录在册、?suite=&arm= 过滤命中、终态后收数表真落一行（读盘核对）', async () => {
    const { app, engine, dataDir } = await buildRealServer();
    try {
      const res = await dispatch(app, {
        task: '给导出模块加空值兜底',
        experiment: { suite: 'c4', arm: 'a', flag: 'readback=off' },
      });
      expect(res.statusCode).toBe(200);
      const { runId } = res.json();
      expect(res.json().experiment).toEqual({ suite: 'c4', arm: 'a', flag: 'readback=off' });
      // 记录在册：run 头直读（与 replay 同一条 opts 通道固化的 RunRecord.experiment）
      const rec = (await app.inject({ url: `/api/runs/${runId}` })).json();
      expect(rec.experiment).toEqual({ suite: 'c4', arm: 'a', flag: 'readback=off' });
      // 既有过滤读的就是这个字段
      const hit = (await app.inject({ url: '/api/runs?suite=c4&arm=a' })).json();
      expect(hit.runs.map((r: { runId: string }) => r.runId)).toContain(runId);
      // 收口（stop 是最确定的终态路：机器验收链路不关心这单跑成什么色）
      await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });
      await waitFor(() => {
        const s = engine.getRun(runId)!.state;
        return s === 'cancelled' || s === 'failed' || s === 'completed' || s === 'completed-with-failures';
      });
      const state = engine.getRun(runId)!.state;
      const file = path.join(dataDir, 'experiments', 'c4', `${engine.getRun(runId)!.finishedAt!.slice(0, 10)}.md`);
      // 等「这一行到位」不等「文件存在」（v13-CI脆测试②同姿势）
      await waitFor(() => {
        try {
          return fs.readFileSync(file, 'utf8').includes(`| ${runId} |`);
        } catch {
          return false;
        }
      });
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain('# 实验收数');
      expect(text).toContain(`| ${runId} | a | readback=off | ${state} |`);
    } finally {
      await app.close();
    }
  });

  it('破烂实验标一律 400 一句指路，不起单：只 arm/flag 无 suite、空/非串 suite、非对象、内层/外层未知键（含 experment 拼错）', async () => {
    const { app, engine } = await buildRealServer();
    try {
      const cases: [unknown, RegExp][] = [
        [{ arm: 'a', flag: 'f' }, /suite/],
        [{ suite: '' }, /suite/],
        [{ suite: 42 }, /suite/],
        [{ suite: 'c4', arm: '' }, /arm/],
        ['c4', /experiment/],
        [{ suite: 'c4', sute: 'c4' }, /未知键/],
      ];
      for (const [experiment, pat] of cases) {
        const res = await dispatch(app, { task: '活', experiment });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(pat);
      }
      // body 级拼错：experment 不是合法体键——拼错=实验标静默失效，宁拒不错放
      const typo = await dispatch(app, { task: '活', experment: { suite: 'c4' } });
      expect(typo.statusCode).toBe(400);
      expect(typo.json().error).toContain('experment');
      // 全都没起单
      const runs = (await app.inject({ url: '/api/runs' })).json();
      expect(runs.runs).toEqual([]);
      expect(engine.listRuns()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('不给 experiment 键=今日语义一字不变：记录无此字段、终态后 experiments 目录压根不建', async () => {
    const { app, engine, dataDir } = await buildRealServer();
    try {
      const res = await dispatch(app, { task: '普通活' });
      expect(res.statusCode).toBe(200);
      expect(res.json().experiment).toBeUndefined();
      const { runId } = res.json();
      const rec = (await app.inject({ url: `/api/runs/${runId}` })).json();
      expect('experiment' in rec).toBe(false);
      await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });
      await waitFor(() => {
        const s = engine.getRun(runId)!.state;
        return s === 'cancelled' || s === 'failed' || s === 'completed' || s === 'completed-with-failures';
      });
      await new Promise((s) => setTimeout(s, 50)); // fire-and-forget 落盘窗口
      expect(fs.existsSync(path.join(dataDir, 'experiments'))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
