import fs from 'node:fs/promises';
import path from 'node:path';
import { runHasEnded, type RunRecord } from '@paneflow/shared';
import { latestAssertionResults } from '../api/wiki.js';
import { attentionMinutes } from './attention.js';
import { Store } from './store.js';

/**
 * v11-E1c 收数表：带 experiment.suite 的 run 到终态后，往
 * `<dataDir>/experiments/<suite>/<YYYY-MM-DD>.md` 追加一行事实（只追加不改写，
 * 无 UI、无统计检验、无调度）。挂点是收口的「加而不改」——写盘失败不再静默：
 * v13-V3 起 appendExperimentRow 返回可判别三态、失败在本模块内 console.error
 * 实账并累计计数（experimentWriteStats 供 health 读），但永不 reject、
 * 绝不让记账把 run 收口弄炸（收口路径 fire-and-forget 的契约不变）。
 */

/**
 * v13-V3 表版本单点常量：口径变更只改这里 + experimentTableHeader 的口径戳。
 * append-only 表头只写一次，历史文件拿不到新戳——「旧行不回填」是结构事实，
 * 边界随戳声明：新口径自本版新建的表/新行起生效。
 */
export const EXPERIMENT_TABLE_VERSION = 2;

/** 日切口径（定死=UTC）：run 时间戳都是 toISOString()，slice(0,10) 即 UTC 日期 */
function experimentDay(run: RunRecord): string {
  return (run.finishedAt ?? run.startedAt).slice(0, 10);
}

function tokenCell(value: number | undefined | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

export function experimentRow(run: RunRecord): string {
  const results = latestAssertionResults(run);
  const pass = results.filter((r) => r.status === 'ok').length;
  const total = results.length;
  const retries = run.cost?.retries ?? 0;
  const wall = run.finishedAt
    ? Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))
    : 0;
  // v13-V3 token in/out 列：直取 run.cost.tokens（引擎收口 Σ 各节点 artifact.extra.usage，
  // 全是 agent 自报口径；null/缺账本=拿不到，画 '-' 绝不估算——与 dag.ts RunCost 注释同红线）
  const tokens = run.cost?.tokens ?? null;
  // v12-V1 harness 摘要列：起单实发指纹·agentKind（旧 run 无 harness 字段画 '-'）——
  // A/B 两臂「只差 readback」要能在这张表上机器读出，不靠起单人自律
  const harness = run.harness
    ? [run.harness.graphSha, run.harness.agentKind].filter(Boolean).join('·') || '-'
    : '-';
  // v12-V2 人等分列：验证税入账——放门结算好的 attention.waitMs 折分钟（一位小数）；
  // 无 attention（旧 run/没人批过门）画 '-'，读这张表即知人的等待占了多少
  const waited = attentionMinutes(run.attention);
  const cell = (s: string) => s.replace(/\|/g, '\\|').trim();
  return `| ${[
    cell(run.runId),
    cell(run.experiment?.arm ?? '-'),
    cell(run.experiment?.flag ?? '-'),
    cell(run.state),
    `${pass}/${total}`,
    String(retries),
    String(wall),
    tokenCell(tokens?.input),
    tokenCell(tokens?.output),
    cell(run.replayOf ?? '-'),
    cell(harness),
    cell(waited),
  ].join(' | ')} |`;
}

/**
 * 表头+口径戳只在全新建文件时写一次（suite 名来自调用方清洗后的值）。
 * v13-V3：口径戳用 '> ' 引用行——listExperimentRows 的行过滤只认 '| ' 前缀，
 * 戳行不进 rows、更不进任何「行数」统计。
 */
export function experimentTableHeader(suite: string): string {
  const stamp =
    `> 表版本 v${EXPERIMENT_TABLE_VERSION} · 口径戳（建表即定死）：` +
    'state 列原样记 run.state，绿/pass 口径=completed（completed-with-failures 记原态、验收按红，v11-D3 不洗绿）；' +
    '断言列=latestAssertionResults 里 ok 数/总数（agent 自报口径）；' +
    'token in/out=run.cost.tokens，引擎收口汇总的 agent 自报 usage（Σ artifact.extra.usage），无自报画「-」——绝不估算；' +
    '人等分=attention.waitMs 折分钟（一位小数，放门结算账），无账画「-」；' +
    '日切按 UTC（finishedAt??startedAt 的 ISO 前 10 位），+08 夜跑跨日会拆两张表、行数按表各自计；' +
    `本表只追加不回改——新列/新口径自 v${EXPERIMENT_TABLE_VERSION} 起的新行生效，历史行不回填。`;
  return [
    '# 实验收数 ·',
    suite,
    '',
    stamp,
    '',
    '| runId | arm | flag | state | 断言 pass/total | 重试 | 墙钟秒 | token in | token out | replayOf | harness | 人等分 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ].join('\n');
}

/**
 * v13-V3 append 三态：调用方（engine 收口）保持 `void appendExperimentRow(...)`
 * 向后兼容——失败无法被忽略不靠返回值强制，而靠本模块内的 console.error 实账
 * 与 experimentWriteStats() 计数（health 可读）。永不 reject。
 */
export type ExperimentAppendResult =
  /** 表不存在，本次连表头+口径戳建档并落行 */
  | { status: 'created'; file: string }
  /** 表已存在，普通追加一行 */
  | { status: 'appended'; file: string }
  /** 没报 suite = 非实验单，本来就不该落盘（不算失败） */
  | { status: 'skipped' }
  /** 写失败：这一行在收数表里缺账，file=目标相对路径，error=底层原因 */
  | { status: 'failed'; file: string; error: string };

/** 进程级累计账（与 Store.persistFailures 同款挂法）：health 读端只认这里 */
const writeStats = {
  successes: 0,
  appendFailures: 0,
  lastFailure: undefined as { at: string; suite: string; runId: string; file: string; error: string } | undefined,
};

/** 只读快照（返回拷贝，外部改不动）：收数落盘的成功/失败累计 + 最近一次失败实账 */
export function experimentWriteStats(): {
  appends: number;
  appendFailures: number;
  lastFailure?: { at: string; suite: string; runId: string; file: string; error: string };
} {
  return {
    appends: writeStats.successes,
    appendFailures: writeStats.appendFailures,
    ...(writeStats.lastFailure ? { lastFailure: { ...writeStats.lastFailure } } : {}),
  };
}

/** 纯本地落盘（零网络零 git）；永不 reject——失败以三态返回 + console.error + 计数现形 */
export async function appendExperimentRow(
  dataDir: string,
  run: RunRecord,
): Promise<ExperimentAppendResult> {
  const raw = run.experiment?.suite?.trim();
  if (!raw) return { status: 'skipped' }; // 没报 suite = 不是实验单，不落任何目录（'default' 兜底只留给怪而确有值的 suite）
  const suite = safeSuite(raw);
  const relFile = `experiments/${suite}/${experimentDay(run)}.md`;
  const file = path.join(dataDir, relFile);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const line = `${experimentRow(run)}\n`;
    let status: 'created' | 'appended';
    // 'ax'=不存在则连表头建档（排他创建，并发收口互不踩）；已存在=普通追加
    try {
      await fs.appendFile(file, `${experimentTableHeader(suite)}\n${line}`, { flag: 'ax' });
      status = 'created';
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      await fs.appendFile(file, line, 'utf8');
      status = 'appended';
    }
    writeStats.successes += 1;
    return { status, file: relFile };
  } catch (e) {
    // 收数仍是旁账：异常流不回收口，但「静默少行」就地结清——实账进日志与计数
    const error = e instanceof Error ? e.message : String(e);
    writeStats.appendFailures += 1;
    writeStats.lastFailure = { at: new Date().toISOString(), suite, runId: run.runId, file, error };
    console.error(
      `[paneflow] 收数表落盘失败（此 run 在表里缺行）：suite=${suite} runId=${run.runId} file=${file} err=${error}`,
    );
    return { status: 'failed', file: relFile, error };
  }
}

/** 目录清洗：只留字母数字/连字符/下划线/点/中文，其余折成 -（防路径注入） */
export function safeSuite(s: string): string {
  return (
    s
      .trim()
      .replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 64) || 'default'
  );
}

/**
 * 只读列表达面（GET /api/experiments）：suite 给了只看该 suite；
 * 行过滤只认 runId 前缀（行首单元格），别的字段模糊匹配会误伤。目录缺失=空，不抛。
 * rows 含表头行（零加工直呈契约）——数据行数由消费方（CLI）如实扣除，v13-V3。
 */
export async function listExperimentRows(
  dataDir: string,
  q: { suite?: string; runId?: string },
): Promise<{ suite: string; date: string; file: string; rows: string[] }[]> {
  const root = path.join(dataDir, 'experiments');
  let suites: string[];
  try {
    suites = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  if (q.suite) {
    const want = safeSuite(q.suite);
    suites = suites.filter((s) => s === want);
  }
  const out: { suite: string; date: string; file: string; rows: string[] }[] = [];
  for (const s of suites.sort()) {
    let days: string[];
    try {
      days = (await fs.readdir(path.join(root, s))).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const d of days) {
      try {
        const text = await fs.readFile(path.join(root, s, d), 'utf8');
        let rows = text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
        if (q.runId) {
          const prefix = q.runId;
          rows = rows.filter((l) => l.slice(2).split('|')[0]!.trim().startsWith(prefix));
        }
        if (rows.length) out.push({ suite: s, date: d, file: `experiments/${s}/${d}`, rows });
      } catch {
        // 半截文件 = 没这条（对账端会把这类缺行照出来）
      }
    }
  }
  return out;
}

/** 表头行识别：首格是 runId（口径戳 '> ' 行根本进不到 rows） */
function isHeaderRow(row: string): boolean {
  return /^\|\s*runId\s*\|/.test(row);
}

function rowRunId(row: string): string {
  return row.slice(2).split('|')[0]!.trim();
}

/**
 * v13-V3 `?reconcile=1` 对账：盘上实验表的行 vs dataDir 里的 run 记录。
 * 只走 Store 既读端（listRuns/listArchivedRuns，含全部空间），不手拼路径读账本。
 * 归档口径（定死并显式）：**已归档 run 计入 expected**——收数行是终态时刻落的账，
 * 之后归档只是移出主列表，把归档单当孤儿行会系统性冤枉 archive 里的每一单；
 * includeArchived:false 仅供对照实验，正常口径保持默认 true。
 * expected=「带 suite 且 runHasEnded」的记录；非终态单（running/queued）还没到
 * 落账时机，不计缺行。返回：每张表缺哪些 runId（表文件整个没了也记缺）+
 * 表里哪些行在盘上找不到记录（孤儿行）。
 */
export async function reconcileExperimentTables(
  dataDir: string,
  q: { suite?: string; includeArchived?: boolean } = {},
): Promise<{
  archivedIncludedInExpected: boolean;
  expectedRuns: number;
  tables: { file: string; exists: boolean; missingRunIds: string[]; orphanRunIds: string[] }[];
}> {
  const includeArchived = q.includeArchived !== false;
  const runs: RunRecord[] = [];
  for (const space of Store.listSpaces(dataDir)) {
    try {
      const store = new Store(dataDir, space.id);
      runs.push(...store.listRuns());
      if (includeArchived) runs.push(...store.listArchivedRuns());
    } catch {
      // 单空间读炸不拦对账其余部分；宁可少比对也不假阳性报缺行
    }
  }
  const knownRunIds = new Set(runs.map((r) => r.runId));
  const suiteFilter = q.suite ? safeSuite(q.suite) : undefined;

  const expectedByFile = new Map<string, string[]>();
  for (const run of runs) {
    const raw = run.experiment?.suite?.trim();
    if (!raw || !runHasEnded(run.state)) continue;
    const suite = safeSuite(raw);
    if (suiteFilter && suite !== suiteFilter) continue;
    const file = `experiments/${suite}/${experimentDay(run)}.md`;
    const bucket = expectedByFile.get(file);
    if (bucket) bucket.push(run.runId);
    else expectedByFile.set(file, [run.runId]);
  }

  const tables = await listExperimentRows(dataDir, suiteFilter ? { suite: suiteFilter } : {});
  const seen = new Set<string>();
  const out: { file: string; exists: boolean; missingRunIds: string[]; orphanRunIds: string[] }[] = [];
  for (const t of tables) {
    seen.add(t.file);
    const rowIds = t.rows.filter((r) => !isHeaderRow(r)).map(rowRunId);
    const rowSet = new Set(rowIds);
    out.push({
      file: t.file,
      exists: true,
      missingRunIds: (expectedByFile.get(t.file) ?? []).filter((id) => !rowSet.has(id)).sort(),
      orphanRunIds: rowIds.filter((id) => !knownRunIds.has(id)).sort(),
    });
  }
  // 盘上有终态实验单、表文件却整个没出现（建档失败/目录被删）——缺行账照录
  for (const [file, ids] of [...expectedByFile].sort(([a], [b]) => a.localeCompare(b))) {
    if (!seen.has(file)) out.push({ file, exists: false, missingRunIds: ids.sort(), orphanRunIds: [] });
  }
  return {
    archivedIncludedInExpected: includeArchived,
    expectedRuns: [...expectedByFile.values()].reduce((n, ids) => n + ids.length, 0),
    tables: out,
  };
}
