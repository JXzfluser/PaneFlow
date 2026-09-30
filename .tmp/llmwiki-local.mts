// 本地验证：真 run 数据 → renderWikiPage → 模拟缓存目录写页+记账 → 打印结构
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@paneflow/shared';
import { appendWikiLog, mergeWikiIndex, readWikiPages, renderWikiPage } from '../packages/server/src/api/wiki.js';

const runs = (await (await fetch('http://127.0.0.1:4310/api/runs')).json()) as { runs: RunRecord[] };
const run = runs.runs.find((r) => r.runId === 'cabc2242')!;
const page = renderWikiPage(run, { repo: 'JXzfluser/PaneFlow', now: new Date().toISOString() });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-llmwiki-'));
const cache = path.join(dir, 'wiki-cache', 'JXzfluser_PaneFlow');
fs.mkdirSync(cache, { recursive: true });
// 模拟既有旧扁平页混放
fs.writeFileSync(path.join(cache, '旧扁平页.md'), '---\npf-run: legacy\n---\n\n旧页正文。');
const abs = path.join(cache, page.file);
fs.mkdirSync(path.dirname(abs), { recursive: true });
fs.writeFileSync(abs, page.markdown);
fs.writeFileSync(path.join(cache, 'index.md'), mergeWikiIndex('', { file: page.file, line: page.indexEntry }));
fs.writeFileSync(path.join(cache, 'log.md'), appendWikiLog('', page.logNote));
// 重复沉淀同页 → index 不重复
fs.writeFileSync(path.join(cache, 'index.md'), mergeWikiIndex(fs.readFileSync(path.join(cache, 'index.md'), 'utf8'), { file: page.file, line: page.indexEntry }));
console.log('=== file:', page.file);
console.log(page.markdown.split('\n').slice(0, 16).join('\n'));
console.log('=== index.md ===');
console.log(fs.readFileSync(path.join(cache, 'index.md'), 'utf8'));
console.log('=== log.md ===');
console.log(fs.readFileSync(path.join(cache, 'log.md'), 'utf8'));
console.log('=== 读回（混放）===');
for (const p of readWikiPages(dir, 'JXzfluser_PaneFlow').concat([])) console.log(p.file, '|', p.title);
