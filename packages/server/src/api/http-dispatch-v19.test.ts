import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpServer } from './http.js';
import { Engine } from '../orchestrate/engine.js';
import { FakeHerdrOps } from '../orchestrate/fake-ops.js';
import { Store } from '../orchestrate/store.js';

/**
 * v19-R1 首条任务零前置 + v19-R4 派活挑人（POST /api/dispatch 的 ensureCwd/assign 体键）。
 * 全链路真路由 + 真 Engine + FakeHerdrOps（http-dispatch-permmode.test 同款替身）。
 */

const HOST = '127.0.0.1:4310';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dispatch-v19-'));

async function buildRealServer(opts?: { recommend?: () => Promise<string | null> }) {
  const dataDir = tmp();
  const root = tmp();
  const ops = new FakeHerdrOps();
  const store = new Store(dataDir);
  const recommend = opts?.recommend ?? (async () => 'fake' as string | null);
  const engine = new Engine(ops, store, {
    workspaceLabelPrefix: 'paneflow-',
    promptConfirmWindowMs: 0,
    reconcileIntervalMs: 60_000,
    defaultNodeTimeoutMs: 1_200,
    agentStartTimeoutMs: 5_000,
    agentReadyTimeoutMs: 5_000,
    recommendAgentKind: recommend,
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
    // engine 侧空读数钉 null、http deps 侧钉 undefined——同一语义两张签名，测试里适配，不扰生产
    recommendAgentKind: async () => (await recommend()) ?? undefined,
  });
  await app.inject({
    method: 'PUT',
    url: '/api/spaces/exp',
    headers: { host: HOST },
    payload: { rootCwd: root },
  });
  return { app, engine, dataDir, root };
}

const dispatch = (app: { inject: (o: object) => Promise<{ statusCode: number; json(): any }> }, payload: object) =>
  app.inject({ method: 'POST', url: '/api/dispatch?space=exp', headers: { host: HOST }, payload });

describe('v19-R1 工作目录现场问文件系统（fail-fast + ensureCwd 一键创建）', () => {
  it('目录不存在 → 400 带 code=cwd-missing 与 cwd 回显，不起单（旧的慢红路收口在接单口）', async () => {
    const { app, engine, root } = await buildRealServer();
    try {
      const gone = path.join(root, 'no-such-dir');
      const res = await dispatch(app, { task: '给导出模块加空值兜底', cwd: gone });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('cwd-missing');
      expect(res.json().cwd).toBe(gone);
      expect(res.json().error).toContain(gone);
      expect(engine.listRuns()).toEqual([]);
      expect(fs.existsSync(gone)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('ensureCwd=true → 就地 mkdir -p 后正常接单；脏值（字符串）宁拒不放行', async () => {
    const { app, root } = await buildRealServer();
    try {
      const gone = path.join(root, 'a', 'b', 'c');
      const res = await dispatch(app, { task: '新目录首单', cwd: gone, ensureCwd: true });
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(gone) && fs.statSync(gone).isDirectory()).toBe(true);
      await app.inject({ method: 'POST', url: `/api/runs/${res.json().runId}/stop` });

      const dirty = await dispatch(app, { task: '脏值单', cwd: path.join(root, 'x'), ensureCwd: 'true' });
      expect(dirty.statusCode).toBe(400);
      expect(dirty.json().error).toContain('ensureCwd');
      expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('无 cwd 且档案没 rootCwd → 400 code=cwd-empty（网页指路卡据此摆「在哪干」输入框）', async () => {
    const { app } = await buildRealServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dispatch',
        headers: { host: HOST },
        payload: { task: '裸任务无目录' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('cwd-empty');
    } finally {
      await app.close();
    }
  });

  it('引擎全空 → 400 带 code=no-agent-kind（文案照旧，code 是给指路卡的新增读数）', async () => {
    const { app, root } = await buildRealServer({ recommend: async () => null });
    try {
      const res = await dispatch(app, { task: '这台机器没引擎', cwd: root });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('no-agent-kind');
      expect(res.json().error).toContain('defaultAgentKind');
    } finally {
      await app.close();
    }
  });
});

describe('v19 打磨：自动派活的引擎读数（GET /api/dispatch/auto-engine 与接单口同一把尺）', () => {
  const auto = (app: { inject: (o: object) => Promise<{ statusCode: number; json(): any }> }, space = 'exp') =>
    app.inject({ method: 'GET', url: `/api/dispatch/auto-engine?space=${space}`, headers: { host: HOST } });

  it('配了项目默认 → project-default；且与这单实发 harness 同值（一处 ladder 两处渲）', async () => {
    const { app, root } = await buildRealServer({ recommend: async () => null });
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/spaces/exp',
        headers: { host: HOST },
        payload: { defaultAgentKind: 'pi' },
      });
      const read = await auto(app);
      expect(read.statusCode).toBe(200);
      expect(read.json().agentKind).toBe('pi');
      expect(read.json().via).toBe('project-default');
      expect(read.json().note).toContain('按项目默认解析 → pi');
      // 真派一单对表：读数说落到 pi，起单就得到 pi（浏览器不另拼一条梯，拼错这里就红）
      const dispatched = await dispatch(app, { task: '自动派单对表', cwd: root });
      expect(dispatched.statusCode).toBe(200);
      const rec = (await app.inject({ url: `/api/runs/${dispatched.json().runId}?space=exp` })).json();
      expect(rec.harness?.agentKind).toBe('pi');
      await app.inject({ method: 'POST', url: `/api/runs/${rec.runId}/stop?space=exp` });
    } finally {
      await app.close();
    }
  });

  it('没配默认但实探有值 → probed（中性读数，不是毛病）', async () => {
    const { app } = await buildRealServer({ recommend: async () => 'codex' });
    try {
      const read = await auto(app);
      expect(read.json()).toMatchObject({ agentKind: 'codex', via: 'probed' });
      expect(read.json().note).toContain('按本机实探落到 → codex');
    } finally {
      await app.close();
    }
  });

  it('两路全空 → none 且 agentKind 为 null：明说现在派不出单（与接单口 400 同结论）', async () => {
    const { app, root } = await buildRealServer({ recommend: async () => null });
    try {
      const read = await auto(app);
      expect(read.json().agentKind).toBeNull();
      expect(read.json().via).toBe('none');
      expect(read.json().note).toContain('派不出单');
      const blocked = await dispatch(app, { task: '这台机器没引擎', cwd: root });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().code).toBe('no-agent-kind');
    } finally {
      await app.close();
    }
  });

  it('档案读不动 → unknown（无从判断），不与 none（查过了没有）混为一谈', async () => {
    const s = await buildRealServer();
    try {
      fs.writeFileSync(path.join(s.dataDir, 'spaces', 'exp', 'profile.json'), '{这不是 JSON');
      const read = await auto(s.app);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ agentKind: null, via: 'unknown' });
      expect(read.json().note).toContain('无从判断');
    } finally {
      await s.app.close();
    }
  });

  it('没建过的项目档案：Store 现造默认档，读数走实探那一级而不是报错', async () => {
    const { app } = await buildRealServer({ recommend: async () => 'opencode' });
    try {
      const read = await auto(app, 'never-seeded');
      expect(read.json()).toMatchObject({ space: 'never-seeded', agentKind: 'opencode', via: 'probed' });
    } finally {
      await app.close();
    }
  });
});

describe('v19-R4 assign 挑人（班底名册 × 角色库解析，判据全在 server）', () => {
  async function seededTeam(agentKind?: string) {
    const s = await buildRealServer();
    await s.app.inject({
      method: 'PUT',
      url: '/api/roles',
      headers: { host: HOST },
      payload: { roles: [{ id: 'r-work', name: '交付手', ...(agentKind ? { agentKind } : {}) }] },
    });
    await s.app.inject({
      method: 'PUT',
      url: '/api/spaces/exp',
      headers: { host: HOST },
      payload: { team: [{ roleId: 'r-work' }] },
    });
    return s;
  }

  it('挑中在编成员 → 回执 assignee 落 run 册，harness.agentKind 跟随岗引擎（第 0 级覆盖）', async () => {
    const { app } = await seededTeam('claude');
    try {
      const res = await dispatch(app, { task: '这单交给交付手', assign: { roleId: 'r-work' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().assignee).toEqual({ roleId: 'r-work', name: '交付手', agentKind: 'claude' });
      const rec = (await app.inject({ url: `/api/runs/${res.json().runId}?space=exp` })).json();
      expect(rec.assignee).toEqual({ roleId: 'r-work', name: '交付手', agentKind: 'claude' });
      expect(rec.harness?.agentKind).toBe('claude');
      await app.inject({ method: 'POST', url: `/api/runs/${rec.runId}/stop?space=exp` });

      const plain = await dispatch(app, { task: '没挑人' });
      expect(plain.statusCode).toBe(200);
      expect(plain.json().assignee).toBeUndefined();
      const rec2 = (await app.inject({ url: `/api/runs/${plain.json().runId}?space=exp` })).json();
      expect('assignee' in rec2).toBe(false);
      await app.inject({ method: 'POST', url: `/api/runs/${rec2.runId}/stop?space=exp` });
    } finally {
      await app.close();
    }
  });

  it('不在班底/角色悬空/没配引擎/引擎不认 → 各 400 一句指路，不起单', async () => {
    const notInTeam = await seededTeam('claude');
    const noEngine = await seededTeam();
    const ghost = await seededTeam('ghost');
    try {
      const r1 = await dispatch(notInTeam.app, { task: '活', assign: { roleId: 'r-ghost-member' } });
      expect(r1.statusCode).toBe(400);
      expect(r1.json().code).toBe('assign-not-in-team');

      // 悬空引用：班底行里的 roleId 在角色库读不到（PUT team 不校验角色在册，现场构造这一形状）
      await notInTeam.app.inject({
        method: 'PUT',
        url: '/api/spaces/exp',
        headers: { host: HOST },
        payload: { team: [{ roleId: 'r-dangling' }] },
      });
      const r2 = await dispatch(notInTeam.app, { task: '活', assign: { roleId: 'r-dangling' } });
      expect(r2.statusCode).toBe(400);
      expect(r2.json().code).toBe('assign-role-dangling');

      const r3 = await dispatch(noEngine.app, { task: '活', assign: { roleId: 'r-work' } });
      expect(r3.statusCode).toBe(400);
      expect(r3.json().code).toBe('assign-no-engine');

      const r4 = await dispatch(ghost.app, { task: '活', assign: { roleId: 'r-work' } });
      expect(r4.statusCode).toBe(400);
      expect(r4.json().code).toBe('assign-engine-unknown');

      expect(notInTeam.engine.listRuns()).toEqual([]);
      expect(noEngine.engine.listRuns()).toEqual([]);
      expect(ghost.engine.listRuns()).toEqual([]);
    } finally {
      await notInTeam.app.close();
      await noEngine.app.close();
      await ghost.app.close();
    }
  });

  it('脏形状宁拒不错放：assign 给字符串/未知键/空 roleId 全 400', async () => {
    const { app, engine } = await seededTeam('claude');
    try {
      for (const bad of ['r-work', { roleid: 'r-work' }, { roleId: '  ' }, [1]]) {
        const res = await dispatch(app, { task: '活', assign: bad });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('assign');
      }
      expect(engine.listRuns()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('replay 血缘继承 assignee——不继承则复跑双臂 harness 抖出「引擎变了」的假漂移', async () => {
    const { app } = await seededTeam('claude');
    try {
      const res = await dispatch(app, { task: '首单挑人', assign: { roleId: 'r-work' } });
      expect(res.statusCode).toBe(200);
      const runId = res.json().runId as string;
      await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop?space=exp` });
      const rep = await app.inject({
        method: 'POST',
        url: `/api/runs/${runId}/replay?space=exp`,
        headers: { host: HOST },
        payload: {},
      });
      expect(rep.statusCode).toBe(200);
      const newId = rep.json().runs[0].runId as string;
      const rec = (await app.inject({ url: `/api/runs/${newId}?space=exp` })).json();
      expect(rec.assignee).toEqual({ roleId: 'r-work', name: '交付手', agentKind: 'claude' });
      expect(rec.harness?.agentKind).toBe('claude');
      await app.inject({ method: 'POST', url: `/api/runs/${newId}/stop?space=exp` });
    } finally {
      await app.close();
    }
  });
});
