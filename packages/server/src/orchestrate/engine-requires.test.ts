import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DagGraph } from '@paneflow/shared';
import { Engine, type EngineOptions } from './engine.js';
import { FakeHerdrOps } from './fake-ops.js';
import { Store } from './store.js';
import { RegistryStore } from './registry.js';

/**
 * v14-T3 起单口的 fail-closed：`startRun` 在 run 落册**之前**按注册表解析模板 `requires`。
 *
 * 为什么单独测引擎口（预检判据已在 `registry-check.test.ts` 钉过）：这一片的卖点就是
 * 「预检与起单同一把尺」。HTTP 面说缺、起单面照跑 = 缺口以另一种形式回来，
 * 所以这里证的是**调用点接上了**，而不是再证一遍判据。
 */
/** 破烂注册表：整份 JSON 读不出要抛（`load()` 不静默当空表——那是最典型的假绿） */
function breakRegistry(dir: string): void {
  fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry', 'entries.json'), '{ 破烂');
}

const OPTS: EngineOptions = {
  workspaceLabelPrefix: 'paneflow-',
  promptConfirmWindowMs: 0,
  reconcileIntervalMs: 60_000,
  defaultNodeTimeoutMs: 1_200,
  agentStartTimeoutMs: 5_000,
  agentReadyTimeoutMs: 5_000,
  recommendAgentKind: async () => 'reco',
};

let ops: FakeHerdrOps;
let store: Store;
let dataDir: string;
let engine: Engine;
let cwd: string;

beforeEach(() => {
  ops = new FakeHerdrOps();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-t3-requires-'));
  store = new Store(dataDir);
  engine = new Engine(ops, store, OPTS);
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-t3-cwd-'));
});

const graph = (requires?: unknown[]): DagGraph => ({
  version: 1,
  name: 't3-flow',
  nodes: [
    { id: 'start', type: 'start', label: '开始', config: {} },
    { id: 'impl', type: 'agent', label: '实现', config: { agentKind: 'fake', prompt: '干活' } },
    { id: 'end', type: 'end', label: '结束', config: {} },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'impl' },
    { id: 'e2', source: 'impl', target: 'end' },
  ],
  metadata: { createdAt: '', updatedAt: '' },
  ...(requires ? { requires: requires as DagGraph['requires'] } : {}),
});

const settle = async (runId: string) => {
  for (let i = 0; i < 400 && engine.getRun(runId)!.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return engine.getRun(runId)!;
};

describe('startRun 的能力槽预检', () => {
  it('缺项：起单当场一句指路，且**没有**留下僵尸 run（缺口的旧样子是静默少注入，不是红单）', async () => {
    const before = store.listRuns().length;
    await expect(engine.startRun(graph([{ kind: 'model' }]), cwd)).rejects.toThrow(
      /能力槽没补齐[\s\S]*先在「注册中心」登记缺的那几项/,
    );
    expect(store.listRuns()).toHaveLength(before);
  });

  it('登记之后同一张图起单即过，并且真跑到 completed（预检不是新拦路，登记完就该放行）', async () => {
    expect(new RegistryStore(dataDir).add({ kind: 'model', name: '小4号', spec: { model: 'gpt-4o-mini' } }).ok).toBe(true);
    const run = await engine.startRun(graph([{ kind: 'model', id: 'gpt-4o-mini' }]), cwd);
    expect((await settle(run.runId)).state).toBe('completed');
  });

  it('未迁进注册表的 kind 不拦起单（判不了死活就只披露，拿空白当断言=误杀存量模板）', async () => {
    // 改口入账：这一格的示例原来是 `role`，A5-4b-1 起它进了表（条目由名册现算）→ 换 `template`。
    // 判据本身一字没改：改的只是「拿哪一类还没迁的当示例」。
    const run = await engine.startRun(graph([{ kind: 'template', id: 'issue-flow' }]), cwd);
    expect((await settle(run.runId)).state).toBe('completed');
  });

  /**
   * v14 A5-4b-1：`role` 是**第一枚正身在盘上用户数据**的视图 kind，所以引擎口要证的不是判据（那里已钉），
   * 而是这条最容易断的接线——`startRun` 喂给预检的那张表里，**有没有名册现算出来的那几行**。
   * 只证 `readView()` 合并了视图条目不够：引擎完全可以走 `load()`（盘上登记项）那条老路，
   * 于是「岗在角色库里、预检说没这枚岗」——两头各自都绿，只有起单口红。
   */
  it('role 槽自此判死活：名册里有那枚岗就放行，没有就拒（现算条目真的进了引擎那张表）', async () => {
    await expect(engine.startRun(graph([{ kind: 'role', id: 'r-deliver' }]), cwd)).rejects.toThrow(/role → r-deliver/);
    fs.writeFileSync(path.join(dataDir, 'roles.json'), `${JSON.stringify([{ id: 'r-deliver', name: '交付岗' }], null, 2)}\n`);
    const run = await engine.startRun(graph([{ kind: 'role', id: 'r-deliver' }]), cwd);
    expect((await settle(run.runId)).state).toBe('completed');
  });

  /**
   * v14 A5-1 把 `skill` 接进表之后，这一类槽在**起单口**也跟着翻成 fail-closed。
   * 单独钉一格的理由：预检判据在 `registry-check.test.ts` 已证，这里要证的是引擎喂给判据的
   * 是合并视图（含用户登记的 skill 条目）——只证判据的话，「表里有这条但引擎读不到」这种
   * 接线断点会一路静默到实机。
   */
  it('skill 槽自此拦起单：没登记即拒，登记后同一张图放行', async () => {
    await expect(engine.startRun(graph([{ kind: 'skill', id: 'skills/x/SKILL.md' }]), cwd)).rejects.toThrow(
      /skill → skills\/x\/SKILL\.md/,
    );
    expect(new RegistryStore(dataDir).add({ kind: 'skill', name: 'x', spec: { space: 'demo', file: 'skills/x/SKILL.md' } }).ok).toBe(true);
    const run = await engine.startRun(graph([{ kind: 'skill', id: 'skills/x/SKILL.md' }]), cwd);
    expect((await settle(run.runId)).state).toBe('completed');
  });

  /**
   * v14 A5-2：`rule` 与 skill 同款翻面，这里证的还是**接线**（引擎喂给判据的是合并视图，
   * 判据本身在 `registry-check.test.ts`）。多留一格的收益：「这单要守的规矩」这条槽从此也在
   * 起单口 fail-closed——以前它整类落 `unjudged`，起了单才发现文档不存在。
   */
  it('rule 槽自此拦起单：没登记即拒，登记后同一张图放行', async () => {
    await expect(engine.startRun(graph([{ kind: 'rule', id: 'docs/x.md' }]), cwd)).rejects.toThrow(/rule → docs\/x\.md/);
    expect(new RegistryStore(dataDir).add({ kind: 'rule', name: 'x', spec: { space: 'demo', file: 'docs/x.md' } }).ok).toBe(true);
    const run = await engine.startRun(graph([{ kind: 'rule', id: 'docs/x.md' }]), cwd);
    expect((await settle(run.runId)).state).toBe('completed');
  });

  /**
   * v14 A5-3：`repo` 同款翻面。这一枚多一格收益的理由不是「再证一遍接线」，而是它是**三处裸串**
   * （`repos[]`／`rules[].repo`／`delivery[].repo`）共同指的那一类：以前仓库槽整类落 `unjudged`，
   * 起了单才发现家规要的仓根本不在盘上；现在那一步在 run 落册之前就被拒。
   */
  it('repo 槽自此拦起单：没登记即拒，登记后按目录名放行（origin 那套写法同样指得到）', async () => {
    await expect(engine.startRun(graph([{ kind: 'repo', id: 'packages/web' }]), cwd)).rejects.toThrow(/repo → packages\/web/);
    expect(
      new RegistryStore(dataDir).add({
        kind: 'repo',
        name: '前端仓',
        spec: { space: 'demo', dir: 'packages/web', origin: 'my-org/web' },
      }).ok,
    ).toBe(true);
    for (const id of ['packages/web', 'my-org/web']) {
      const run = await engine.startRun(graph([{ kind: 'repo', id }]), cwd);
      expect((await settle(run.runId)).state).toBe('completed');
    }
  });

  it('没带 requires 的模板一个字都不变：注册表破烂也照起单（预检不是全局新前置）', async () => {
    breakRegistry(dataDir);
    const run = await engine.startRun(graph(), cwd);
    expect((await settle(run.runId)).state).toBe('completed');
  });

  it('带槽 + 注册表读不出 = 拒单并指路修注册表（不降级成「没带槽」放行）', async () => {
    breakRegistry(dataDir);
    await expect(engine.startRun(graph([{ kind: 'model' }]), cwd)).rejects.toThrow(
      /注册表读不出，无法预检[\s\S]*先修好注册表再起单/,
    );
  });
});
