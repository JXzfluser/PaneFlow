import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PRODUCT_READ_CAP,
  SHELF_DEFAULT_CAP,
  diffProduct,
  normalizeProductDecls,
  planShelf,
  productSha,
  productShelfFile,
  purgeShelf,
  readDeclaredProducts,
  shelfCapFromEnv,
  shelfName,
  shelfRunDir,
  shelfUsedBytes,
  shelveProducts,
} from './products.js';

describe('v13-K1 声明位读端清洗 normalizeProductDecls', () => {
  it('没声明/空声明=两皆空（缺≠产了零件）', () => {
    expect(normalizeProductDecls(undefined)).toEqual({ decls: [], skipped: [] });
    expect(normalizeProductDecls(null)).toEqual({ decls: [], skipped: [] });
    expect(normalizeProductDecls([])).toEqual({ decls: [], skipped: [] });
  });

  it('file 缺省时用 name 当路径；显式 file 保留相对路径', () => {
    const { decls, skipped } = normalizeProductDecls([
      { name: 'plan.md' },
      { name: '报告', file: 'docs/report.md' },
    ]);
    expect(skipped).toEqual([]);
    expect(decls).toEqual([{ name: 'plan.md' }, { name: '报告', file: 'docs/report.md' }]);
  });

  it('破烂整条不取并在 skipped 留一句原因（agent 写的文件不受我们控制）', () => {
    const { decls, skipped } = normalizeProductDecls({ name: 'plan.md' });
    expect(decls).toEqual([]);
    expect(skipped).toEqual([{ name: 'products', why: '不是数组' }]);

    const bad = normalizeProductDecls([
      'plan.md',
      null,
      {},
      { name: '  ' },
      { name: 'blank.md', file: '   ' },
      { name: 'esc.md', file: '/etc/passwd' },
      { name: 'up.md', file: '../outside.md' },
      { name: 'dup.md' },
      { name: 'dup.md' },
      { name: 'nested/plan.md' },
      { name: 'plan.md', file: 'sub/plan.md' },
    ]);
    expect(bad.decls).toEqual([{ name: 'dup.md' }, { name: 'plan.md', file: 'sub/plan.md' }]);
    expect(bad.skipped.map((s) => `${s.name}:${s.why}`)).toEqual([
      'products[0]:不是对象',
      'products[1]:不是对象',
      'products[2]:name 缺失或为空',
      'products[3]:name 缺失或为空',
      'blank.md:file 不是非空字符串',
      'esc.md:file 必须是节点工作目录内的相对路径（收到 /etc/passwd）',
      'up.md:file 必须是节点工作目录内的相对路径（收到 ../outside.md）',
      'dup.md:同名声明：后声明不覆盖前声明，整条不记',
      'nested/plan.md:name 不能含路径分隔符或非法文件名字符（上架会撞名互相覆盖）',
    ]);
  });
});

describe('v13-K1 指纹与上架名', () => {
  it('sha 从原文实算（同一内容必得同一指纹，改一字就变）', () => {
    expect(productSha('abc')).toBe(productSha('abc'));
    expect(productSha('abc')).not.toBe(productSha('abd'));
    expect(productSha('abc')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('shelfName 只取 basename：穿越在拼路径前就被物理消灭', () => {
    expect(shelfName('a/b/plan.md')).toBe('plan.md');
    expect(shelfName('../../etc/passwd')).toBe('passwd');
    expect(shelfName('  ')).toBe('unnamed');
  });

  it('上限读法：未设=缺省、0=不限量、破烂=回落缺省', () => {
    expect(shelfCapFromEnv(undefined)).toBe(SHELF_DEFAULT_CAP);
    expect(shelfCapFromEnv('')).toBe(SHELF_DEFAULT_CAP);
    expect(shelfCapFromEnv('0')).toBe(0);
    expect(shelfCapFromEnv('1024')).toBe(1024);
    expect(shelfCapFromEnv('-5')).toBe(SHELF_DEFAULT_CAP);
    expect(shelfCapFromEnv('abc')).toBe(SHELF_DEFAULT_CAP);
  });
});

describe('v13-K1 实读原文 readDeclaredProducts', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-prod-'));

  it('候选目录按序试：worktree 里没有才回落节点 cwd', () => {
    const wt = tmp();
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'plan.md'), '来自 cwd');
    const r = readDeclaredProducts([{ name: 'plan.md' }], [wt, cwd]);
    expect(r.skipped).toEqual([]);
    expect(r.products[0]!.content).toBe('来自 cwd');
    expect(r.products[0]!.kind).toBe('doc');
  });

  it('两处都有时 worktree 优先（引擎已知这两处可能分裂，隔离现场才是本单的产出）', () => {
    const wt = tmp();
    const cwd = tmp();
    fs.writeFileSync(path.join(wt, 'plan.md'), '来自 worktree');
    fs.writeFileSync(path.join(cwd, 'plan.md'), '来自 cwd');
    const r = readDeclaredProducts([{ name: 'plan.md' }], [wt, cwd]);
    expect(r.products[0]!.content).toBe('来自 worktree');
  });

  it('声明了但读不到=不记 + 一句人话（宁缺毋假，不记空件）', () => {
    const cwd = tmp();
    const r = readDeclaredProducts([{ name: 'ghost.md' }], ['', cwd]);
    expect(r.products).toEqual([]);
    expect(r.skipped[0]!.why).toContain('声明了但读不到：不存在');
  });

  it('超过单件读取上限不读（拒的是这一件，不是整个节点）', () => {
    const cwd = tmp();
    const big = path.join(cwd, 'big.md');
    fs.writeFileSync(big, Buffer.alloc(PRODUCT_READ_CAP + 1, 0x61));
    const r = readDeclaredProducts([{ name: 'big.md' }], [cwd]);
    expect(r.products).toEqual([]);
    expect(r.skipped[0]!.why).toContain('超过单件读取上限');
  });

  it('目录不存在/不是文件都不抛错，只落成读数', () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'sub'));
    const r = readDeclaredProducts([{ name: 'sub' }, { name: 'gone.md' }], [path.join(cwd, 'not-here')]);
    expect(r.products).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });
});

describe('v13-K1 上架判定与落盘', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shelf-'));
  const draft = (name: string, content: string): import('./products.js').ProductDraft => ({
    name,
    kind: 'doc',
    content,
    readFrom: '/nowhere',
  });

  it('run 级字节上限逐件累加，超限的件 shelved:false + 原因（台账照记=读数不是失败）', () => {
    const planned = planShelf([draft('a.md', 'x'.repeat(100)), draft('b.md', 'y'.repeat(100))], 0, 150);
    expect(planned[0]!.shelved).toBe(true);
    expect(planned[1]!.shelved).toBe(false);
    expect(planned[1]!.shelfError).toContain('over-run-cap');
    expect(planned[1]!.shelfError).toContain('0.0 MiB / 上限 0.0 MiB');
  });

  it('cap=0 不限量；已用字节从架上实数（含此前节点的格子）', () => {
    expect(planShelf([draft('a.md', 'x'.repeat(100))], 999, 0)[0]!.shelved).toBe(true);
    const root = tmp();
    expect(shelfUsedBytes(root)).toBe(0);
    fs.mkdirSync(path.join(root, 'n1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'n1', 'a.md'), '12345');
    expect(shelfUsedBytes(root)).toBe(5);
    expect(shelfUsedBytes(path.join(root, '不存在的格'))).toBe(0);
  });

  it('shelveProducts 写盘并出台账；台账 sha 与架上原文对得上', () => {
    const root = tmp();
    const products = shelveProducts(root, 'n1', [draft('plan.md', '# 计划')], 0, (target, content) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    });
    expect(products).toHaveLength(1);
    expect(products[0]!.shelved).toBe(true);
    expect(products[0]!.bytes).toBe(Buffer.byteLength('# 计划', 'utf8'));
    expect(fs.readFileSync(path.join(root, 'n1', 'plan.md'), 'utf8')).toBe('# 计划');
    const got = productShelfFile(root, 'n1', products[0]!);
    expect(got).toEqual({ content: '# 计划' });
  });

  it('空输入返回空数组（调用方据此整键不写 rec.products）', () => {
    expect(shelveProducts(tmp(), 'n1', [], 0, () => {})).toEqual([]);
  });

  it('写失败=shelved:false + write-failed 原因，不抛错也不拖红节点', () => {
    const products = shelveProducts(tmp(), 'n1', [draft('plan.md', 'x')], 0, () => {
      throw new Error('磁盘满了');
    });
    expect(products[0]!.shelved).toBe(false);
    expect(products[0]!.shelfError).toBe('write-failed:磁盘满了');
  });

  it('格子名再过一遍 basename：nodeId 里带分隔符也开不了写穿越洞', () => {
    const root = tmp();
    shelveProducts(root, '../../escape', [draft('plan.md', 'x')], 0, (target, content) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    });
    expect(fs.existsSync(path.join(root, 'escape', 'plan.md'))).toBe(true);
  });

  it('productShelfFile：未上架/架上没有/指纹不符各回一句人话，绝不交出一份对不上账的内容', () => {
    const root = tmp();
    const [ok] = shelveProducts(root, 'n1', [draft('plan.md', '原文')], 0, (t, c) => {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, c);
    });
    expect(productShelfFile(root, 'n1', ok!)).toEqual({ content: '原文' });
    // 被上限拒的件：架上没有文件，取用侧必须说「未上架」而不是「读不到」——两件事的账要分得开
    expect(productShelfFile(root, 'n1', { ...ok!, shelved: false, shelfError: 'over-run-cap（…）' })).toEqual({
      why: '未上架（over-run-cap（…））',
    });
    expect(productShelfFile(root, 'n1', { ...ok!, name: 'ghost.md' })).toEqual({
      why: expect.stringContaining('架上读不到') as string,
    });
    fs.writeFileSync(path.join(root, 'n1', 'tampered.md'), '另一份内容');
    expect(productShelfFile(root, 'n1', { ...ok!, name: 'tampered.md' })).toEqual({
      why: expect.stringContaining('指纹不符') as string,
    });
  });
});

describe('v13-K1 零约定 diff 与架清理', () => {
  it('diffProduct：空 patch 不算产物（不记空 diff 充数）', () => {
    expect(diffProduct(undefined, '/x')).toBeUndefined();
    expect(diffProduct('   \n', '/x')).toBeUndefined();
    expect(diffProduct('diff --git a/x b/x\n', '/x')).toEqual({
      name: 'changes.diff',
      kind: 'diff',
      content: 'diff --git a/x b/x\n',
      readFrom: '/x',
    });
  });

  it('purgeShelf 数得出删了几件；含分隔符的 runId 不越出架根', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-data-'));
    const runDir = shelfRunDir(dataDir, 'run-1');
    fs.mkdirSync(path.join(runDir, 'n1'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'n1', 'plan.md'), 'x');
    fs.writeFileSync(path.join(runDir, 'n1', 'changes.diff'), 'y');
    expect(purgeShelf(dataDir, 'run-1')).toBe(2);
    expect(fs.existsSync(runDir)).toBe(false);
    expect(purgeShelf(dataDir, 'no-such-run')).toBe(0);
    expect(purgeShelf(dataDir, '../../etc')).toBe(0);
    expect(fs.existsSync(runDir)).toBe(false);
  });
});
