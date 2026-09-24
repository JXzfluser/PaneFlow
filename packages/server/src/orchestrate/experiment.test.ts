import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import { Store } from './store.js';
import {
  appendExperimentRow,
  EXPERIMENT_TABLE_VERSION,
  experimentRow,
  experimentTableHeader,
  experimentWriteStats,
  listExperimentRows,
  reconcileExperimentTables,
  safeSuite,
} from './experiment.js';

const graph = {
  version: 1,
  name: 'g',
  nodes: [],
  edges: [],
  metadata: { createdAt: '', updatedAt: '' },
} as unknown as RunRecord['graph'];

function mkRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'abc12345',
    dagName: 'g',
    graph,
    state: 'completed',
    cwd: '/tmp/x',
    nodes: {},
    startedAt: '2026-09-21T08:00:00.000Z',
    finishedAt: '2026-09-21T08:02:30.000Z',
    ...over,
  };
}

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pf-exp-'));
}

describe('v11-E1c experimentRow（收数行：只如实记账）', () => {
  it('全列齐：runId/arm/flag/state/断言 pass÷total/重试/墙钟秒/token in/token out/replayOf/harness/人等分（无 harness/attention 画 -）', () => {
    const run = mkRun({
      experiment: { suite: 'c4', arm: 'a', flag: 'readback=on' },
      replayOf: 'src-99',
      cost: { totalMs: 150_000, retries: 2, tokens: { input: 0, output: 0 }, byNode: { impl: { durationMs: 150_000, attempts: 3, retries: 2 } } },
      nodes: {
        impl: {
          artifact: {
            extra: {
              assertionResults: [
                { id: 'AC-1', status: 'ok', evidence: '' },
                { id: 'AC-2', status: 'fail', evidence: '' },
                { id: 'AC-3', status: 'ok', evidence: '' },
              ],
            },
          },
        } as unknown as RunRecord['nodes']['impl'],
      },
    });
    expect(experimentRow(run)).toBe('| abc12345 | a | readback=on | completed | 2/3 | 2 | 150 | 0 | 0 | src-99 | - | - |');
  });

  it('v13-V3 token in/out 列：直取 run.cost.tokens；null/无 cost/无 usage 一律画 -（绝不估算）', () => {
    const reported = mkRun({
      experiment: { suite: 'c4' },
      cost: { totalMs: 1, retries: 0, tokens: { input: 12345, output: 678 }, byNode: {} },
    });
    expect(experimentRow(reported)).toContain('| 12345 | 678 |');
    const nullTokens = mkRun({ experiment: { suite: 'c4' }, cost: { totalMs: 1, retries: 0, tokens: null, byNode: {} } });
    expect(experimentRow(nullTokens)).toContain('| 150 | - | - | - |'); // 墙钟之后 token 两格都 -，replayOf 也 -
    const noCost = mkRun({ experiment: { suite: 'c4' } });
    expect(experimentRow(noCost)).toBe('| abc12345 | - | - | completed | 0/0 | 0 | 150 | - | - | - | - | - |');
  });

  it('v12-V1 harness 摘要列：graphSha·agentKind；缺半边照实只留有的', () => {
    const withH = mkRun({ experiment: { suite: 'c4' }, harness: { graphSha: 'a1b2c3d4', agentKind: 'pi' } });
    expect(experimentRow(withH)).toBe('| abc12345 | - | - | completed | 0/0 | 0 | 150 | - | - | - | a1b2c3d4·pi | - |');
    const partial = mkRun({ experiment: { suite: 'c4' }, harness: { graphSha: '', agentKind: 'pi' } });
    expect(experimentRow(partial)).toContain('| - | pi |'); // graphSha 空串（怪单）不产出孤零零的「·pi」
  });

  it('v12-V2 人等分列：attention.waitMs 折分钟一位小数；无 attention 画 -；零等待也如实 0.0', () => {
    const waited = mkRun({
      experiment: { suite: 'c4' },
      attention: { waitMs: 252_000, gates: { approve: 2, reject: 0, input: 1 } }, // 4.2 分钟
    });
    expect(experimentRow(waited)).toMatch(/\| 4\.2 \|$/);
    const zero = mkRun({ experiment: { suite: 'c4' }, attention: { waitMs: 0, gates: { approve: 0, reject: 0, input: 0 } } });
    expect(experimentRow(zero)).toMatch(/\| 0\.0 \|$/); // 有账本如实呈现，不与「无账」混同
    const legacy = mkRun({ experiment: { suite: 'c4' } });
    expect(experimentRow(legacy)).toMatch(/\| - \|$/);
  });

  it('缺项画 -；无 finishedAt 墙钟记 0；管道符转义不撑破表格', () => {
    const run = mkRun({ experiment: { suite: 'c4' }, finishedAt: undefined, nodes: {} });
    expect(experimentRow(run)).toBe('| abc12345 | - | - | completed | 0/0 | 0 | 0 | - | - | - | - | - |');
    const nasty = mkRun({ experiment: { arm: 'a|b' }, replayOf: 'x|y' });
    expect(experimentRow(nasty)).toContain('a\\|b');
    expect(experimentRow(nasty)).toContain('x\\|y');
  });
});

describe('v13-V3 experimentTableHeader（口径戳随表头落盘）', () => {
  it('新建表带版本戳+口径引用行：state/token/日切/不回填边界全指名；戳行不进数据行', async () => {
    const header = experimentTableHeader('c4');
    expect(header).toContain(`表版本 v${EXPERIMENT_TABLE_VERSION}`);
    expect(header).toContain('completed-with-failures 记原态、验收按红');
    expect(header).toContain('run.cost.tokens');
    expect(header).toContain('日切按 UTC');
    expect(header).toContain('历史行不回填');
    expect(header).toContain('| runId | arm | flag | state | 断言 pass/total | 重试 | 墙钟秒 | token in | token out | replayOf | harness | 人等分 |');
    const dir = await tmp();
    await appendExperimentRow(dir, mkRun({ experiment: { suite: 'c4' } }));
    const tables = await listExperimentRows(dir, {});
    // 口径戳以 '> ' 引用行落盘：listExperimentRows 只收 '| ' 前缀行，rows=表头+数据行
    expect(tables[0]!.rows).toHaveLength(2);
    const text = await fs.readFile(path.join(dir, 'experiments', 'c4', '2026-09-21.md'), 'utf8');
    expect(text).toContain('\n> 表版本 v');
  });
});

describe('v11-E1c safeSuite（目录清洗：防路径注入）', () => {
  it('../ 前缀被剥；非法字符折 -；中文/点/下划线保留；64 封顶；空归 default', () => {
    expect(safeSuite('../evil')).toBe('evil');
    expect(safeSuite('a b/c')).toBe('a-b-c');
    expect(safeSuite('c4_夜.二-x')).toBe('c4_夜.二-x');
    expect(safeSuite('x'.repeat(100))).toBe('x'.repeat(64));
    expect(safeSuite('')).toBe('default');
    expect(safeSuite('   ')).toBe('default');
    expect(safeSuite('../../')).toBe('default');
  });
});

describe('v13-V3 appendExperimentRow（三态返回：失败不可忽略，但永不 reject）', () => {
  it('首次落盘=created（表头+行）；同日第二条=appended 不重发表头；按 finishedAt 日期分文件；无 suite=skipped', async () => {
    const dir = await tmp();
    const first = await appendExperimentRow(dir, mkRun({ experiment: { suite: 'c4', arm: 'a' } }));
    expect(first).toEqual({ status: 'created', file: 'experiments/c4/2026-09-21.md' });
    const file = path.join(dir, 'experiments', 'c4', '2026-09-21.md');
    const firstText = await fs.readFile(file, 'utf8');
    expect(firstText).toContain(experimentTableHeader('c4'));
    expect(firstText.split('\n').filter((l) => l.startsWith('| abc'))).toHaveLength(1);
    const second = await appendExperimentRow(dir, mkRun({ runId: 'def67890', experiment: { suite: 'c4', arm: 'b' } }));
    expect(second).toEqual({ status: 'appended', file: 'experiments/c4/2026-09-21.md' });
    const secondText = await fs.readFile(file, 'utf8');
    expect(secondText.match(/# 实验收数/g)).toHaveLength(1); // 表头不重发
    expect(secondText).toContain('| def67890 | b |');
    // 另一天 → 另一文件
    const other = await appendExperimentRow(
      dir,
      mkRun({ experiment: { suite: 'c4' }, startedAt: '2026-09-20T01:00:00.000Z', finishedAt: '2026-09-20T01:05:00.000Z' }),
    );
    expect(other.status).toBe('created');
    expect(await fs.readFile(path.join(dir, 'experiments', 'c4', '2026-09-20.md'), 'utf8')).toContain('| abc12345 |');
    expect(await appendExperimentRow(dir, mkRun({}))).toEqual({ status: 'skipped' });
  });

  it('写失败=failed 态 + console.error 实账（suite/runId/路径）+ experimentWriteStats 累计；engine 侧 void 调用照旧兼容', async () => {
    const dir = await tmp();
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, '我不是目录');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = experimentWriteStats();
    const res = await appendExperimentRow(blocker, mkRun({ experiment: { suite: 'c4' } }));
    expect(res.status).toBe('failed');
    expect(res).toMatchObject({ file: 'experiments/c4/2026-09-21.md' });
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    spy.mockRestore();
    expect(logged).toContain('收数表落盘失败');
    expect(logged).toContain('suite=c4');
    expect(logged).toContain('runId=abc12345');
    expect(logged).toContain(path.join(blocker, 'experiments', 'c4', '2026-09-21.md'));
    const after = experimentWriteStats();
    expect(after.appendFailures).toBe(before.appendFailures + 1);
    expect(after.appends).toBe(before.appends); // 失败不进成功账
    expect(after.lastFailure?.runId).toBe('abc12345');
  });

  it('成功也计数：experimentWriteStats 返回快照（appends 含 created+appended）', async () => {
    const dir = await tmp();
    const before = experimentWriteStats();
    await appendExperimentRow(dir, mkRun({ experiment: { suite: 'stats' } }));
    await appendExperimentRow(dir, mkRun({ runId: 'def67890', experiment: { suite: 'stats' } }));
    const after = experimentWriteStats();
    expect(after.appends).toBe(before.appends + 2);
    expect(after.appendFailures).toBe(before.appendFailures);
    expect(experimentWriteStats().appends).toBe(after.appends); // 只读快照，改不动内部账
  });
});

describe('v11-E1c listExperimentRows（只读列表达面）', () => {
  it('缺目录=空不抛；suite 精确过滤；runId 只认行首前缀；表头行随行返回（CLI 读列名用）', async () => {
    const dir = path.join(await tmp(), 'missing-deep'); // 不存在
    expect(await listExperimentRows(dir, {})).toEqual([]);
    const root = await tmp();
    await appendExperimentRow(root, mkRun({ experiment: { suite: 'c4', arm: 'a' } }));
    await appendExperimentRow(root, mkRun({ runId: 'zz999999', experiment: { suite: 'other' } }));
    const all = await listExperimentRows(root, {});
    expect(all.map((t) => t.suite)).toEqual(['c4', 'other']);
    expect(all[0]!.file).toBe('experiments/c4/2026-09-21.md');
    expect(all[0]!.rows[0]).toContain('| runId | arm |'); // 表头在行里，列名自带
    const only = await listExperimentRows(root, { suite: 'c4' });
    expect(only).toHaveLength(1);
    expect(only[0]!.rows.some((r) => r.includes('| zz999999 |'))).toBe(false);
    const byRun = await listExperimentRows(root, { runId: 'abc' });
    expect(byRun.flatMap((t) => t.rows)).toEqual(['| abc12345 | a | - | completed | 0/0 | 0 | 150 | - | - | - | - | - |']);
    // 行过滤只认行首 runId 前缀——v12/v13 加列（列数变化）不伤读端
    expect(await listExperimentRows(root, { runId: 'abc', suite: 'other' })).toEqual([]);
  });
});

describe('v13-V3 reconcileExperimentTables（表 vs 盘上 run 记录）', () => {
  it('缺行照出、孤儿行照出、整表缺失照出；非终态单不计缺；口径字段显式回写', async () => {
    const dir = await tmp();
    const store = new Store(dir, 'default');
    const r1 = mkRun({ runId: 'run-0001', experiment: { suite: 'c4' } });
    const r2 = mkRun({ runId: 'run-0002', experiment: { suite: 'c4' } });
    const r3 = mkRun({ runId: 'run-0003', experiment: { suite: 'c4' }, state: 'running' });
    for (const r of [r1, r2, r3]) store.saveRun(r);
    await appendExperimentRow(dir, r1); // r2 模拟 append 静默失败：盘上有单、表里没行
    // 孤儿行：手塞一条盘上找不到的记录（旧口径直写文件也照样被对出来）
    const file = path.join(dir, 'experiments', 'c4', '2026-09-21.md');
    await fs.appendFile(file, '| ghost-99 | - | - | completed | 0/0 | 0 | 0 | - | - | - | - | - |\n', 'utf8');
    const rep = await reconcileExperimentTables(dir);
    expect(rep.archivedIncludedInExpected).toBe(true);
    expect(rep.expectedRuns).toBe(2); // r1+r2（r3 非终态不计）
    const t = rep.tables.find((x) => x.file === 'experiments/c4/2026-09-21.md');
    expect(t).toMatchObject({ exists: true, missingRunIds: ['run-0002'], orphanRunIds: ['ghost-99'] });
    // 整表缺失：另一天的终态单，表文件根本没建
    const r4 = mkRun({ runId: 'run-0004', experiment: { suite: 'c4' }, startedAt: '2026-09-19T01:00:00.000Z', finishedAt: '2026-09-19T01:02:00.000Z' });
    store.saveRun(r4);
    const rep2 = await reconcileExperimentTables(dir, { suite: 'c4' });
    const gone = rep2.tables.find((x) => x.file === 'experiments/c4/2026-09-19.md');
    expect(gone).toMatchObject({ exists: false, missingRunIds: ['run-0004'] });
  });

  it('归档口径：默认 archived 计入 expected（不算孤儿）；includeArchived:false 才显式对照', async () => {
    const dir = await tmp();
    const store = new Store(dir, 'default');
    const r = mkRun({ runId: 'run-arch1', experiment: { suite: 'c4' } });
    store.saveRun(r);
    await appendExperimentRow(dir, r);
    store.archiveRun('run-arch1'); // 移入 archive/——收数行早已落账
    const def = await reconcileExperimentTables(dir);
    const t = def.tables.find((x) => x.file === 'experiments/c4/2026-09-21.md')!;
    expect(t.missingRunIds).toEqual([]);
    expect(t.orphanRunIds).toEqual([]); // 归档单不误判为孤儿行
    const noArch = await reconcileExperimentTables(dir, { includeArchived: false });
    expect(noArch.archivedIncludedInExpected).toBe(false);
    expect(noArch.tables.find((x) => x.file === 'experiments/c4/2026-09-21.md')!.orphanRunIds).toEqual(['run-arch1']); // 对照口径：排除归档后同一行被显式报孤儿
  });

  it('空盘（无 experiments 无 run）：全零不抛', async () => {
    const dir = await tmp();
    expect(await reconcileExperimentTables(dir)).toEqual({
      archivedIncludedInExpected: true,
      expectedRuns: 0,
      tables: [],
    });
  });
});
