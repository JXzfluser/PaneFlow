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
    const run = await engine.startRun(graph([{ kind: 'repo', id: 'packages/web' }]), cwd);
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
