import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import { latestAssertionResults } from '../api/wiki.js';
import { attentionMinutes } from './attention.js';

/**
 * v11-E1c 收数表：带 experiment.suite 的 run 到终态后，往
 * `<dataDir>/experiments/<suite>/<YYYY-MM-DD>.md` 追加一行事实（只追加不改写，
 * 无 UI、无统计检验、无调度）。挂点是收口的「加而不改」——写盘任何意外都静默，
 * 绝不让记账把 run 收口弄炸。
 */

export function experimentRow(run: RunRecord): string {
  const results = latestAssertionResults(run);
  const pass = results.filter((r) => r.status === 'ok').length;
  const total = results.length;
  const retries = run.cost?.retries ?? 0;
  const wall = run.finishedAt
    ? Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))
    : 0;
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
    cell(run.replayOf ?? '-'),
    cell(harness),
    cell(waited),
  ].join(' | ')} |`;
}

/** 表头只在全新建文件时写一次（suite 名来自调用方清洗后的值） */
export function experimentTableHeader(suite: string): string {
  return ['# 实验收数 ·', suite, '', '| runId | arm | flag | state | 断言 pass/total | 重试 | 墙钟秒 | replayOf | harness | 人等分 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'].join('\n');
}

/** 纯本地落盘（零网络零 git）；永不 reject */
export async function appendExperimentRow(dataDir: string, run: RunRecord): Promise<void> {
  try {
    const raw = run.experiment?.suite?.trim();
    if (!raw) return; // 没报 suite = 不是实验单，不落任何目录（'default' 兜底只留给怪而确有值的 suite）
    const suite = safeSuite(raw);
    const day = (run.finishedAt ?? run.startedAt).slice(0, 10);
    const dir = path.join(dataDir, 'experiments', suite);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${day}.md`);
    const line = `${experimentRow(run)}\n`;
    // 'ax'=不存在则连表头建档（排他创建，并发收口互不踩）；已存在=普通追加
    try {
      await fs.appendFile(file, `${experimentTableHeader(suite)}\n${line}`, { flag: 'ax' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      await fs.appendFile(file, line, 'utf8');
    }
  } catch {
    // 收数是旁账：盘炸也不许流回收口路径
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
        // 半截文件 = 没这条
      }
    }
  }
  return out;
}
