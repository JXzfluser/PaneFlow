import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import {
  appendExperimentRow,
  experimentRow,
  experimentTableHeader,
  listExperimentRows,
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
  it('全列齐：runId/arm/flag/state/断言 pass÷total/重试/墙钟秒/replayOf/harness（无 harness 字段画 -）', () => {
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
    expect(experimentRow(run)).toBe('| abc12345 | a | readback=on | completed | 2/3 | 2 | 150 | src-99 | - |');
  });

  it('v12-V1 harness 摘要列：graphSha·agentKind；缺半边照实只留有的', () => {
    const withH = mkRun({ experiment: { suite: 'c4' }, harness: { graphSha: 'a1b2c3d4', agentKind: 'pi' } });
    expect(experimentRow(withH)).toBe('| abc12345 | - | - | completed | 0/0 | 0 | 150 | - | a1b2c3d4·pi |');
    const partial = mkRun({ experiment: { suite: 'c4' }, harness: { graphSha: '', agentKind: 'pi' } });
    expect(experimentRow(partial)).toContain('| - | pi |'); // graphSha 空串（怪单）不产出孤零零的「·pi」
  });

  it('缺项画 -；无 finishedAt 墙钟记 0；管道符转义不撑破表格', () => {
    const run = mkRun({ experiment: { suite: 'c4' }, finishedAt: undefined, nodes: {} });
    expect(experimentRow(run)).toBe('| abc12345 | - | - | completed | 0/0 | 0 | 0 | - | - |');
    const nasty = mkRun({ experiment: { arm: 'a|b' }, replayOf: 'x|y' });
    expect(experimentRow(nasty)).toContain('a\\|b');
    expect(experimentRow(nasty)).toContain('x\\|y');
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

describe('v11-E1c appendExperimentRow（新建带表头、追加不重发头、写炸静默）', () => {
  it('首次落盘=表头+行；同日第二条只追加行；按 finishedAt 日期分文件', async () => {
    const dir = await tmp();
    await appendExperimentRow(dir, mkRun({ experiment: { suite: 'c4', arm: 'a' } }));
    const file = path.join(dir, 'experiments', 'c4', '2026-09-21.md');
    const first = await fs.readFile(file, 'utf8');
    expect(first).toContain(experimentTableHeader('c4'));
    expect(first.split('\n').filter((l) => l.startsWith('| abc'))).toHaveLength(1);
    await appendExperimentRow(dir, mkRun({ runId: 'def67890', experiment: { suite: 'c4', arm: 'b' } }));
    const second = await fs.readFile(file, 'utf8');
    expect(second.match(/# 实验收数/g)).toHaveLength(1); // 表头不重发
    expect(second).toContain('| def67890 | b |');
    // 另一天 → 另一文件
    await appendExperimentRow(
      dir,
      mkRun({ experiment: { suite: 'c4' }, startedAt: '2026-09-20T01:00:00.000Z', finishedAt: '2026-09-20T01:05:00.000Z' }),
    );
    expect(await fs.readFile(path.join(dir, 'experiments', 'c4', '2026-09-20.md'), 'utf8')).toContain('| abc12345 |');
  });

  it('无 suite 不落盘；dataDir 不可写也只静默、绝不 reject', async () => {
    const dir = await tmp();
    await appendExperimentRow(dir, mkRun({}));
    expect(listExperimentRows(dir, {})).resolves.toEqual([]);
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, '我不是目录');
    await expect(
      appendExperimentRow(blocker, mkRun({ experiment: { suite: 'c4' } })),
    ).resolves.toBeUndefined();
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
    expect(byRun.flatMap((t) => t.rows)).toEqual(['| abc12345 | a | - | completed | 0/0 | 0 | 150 | - | - |']);
    // 行过滤只认行首 runId 前缀——v12 加列（列数变化）不伤读端
    expect(await listExperimentRows(root, { runId: 'abc', suite: 'other' })).toEqual([]);
  });
});
