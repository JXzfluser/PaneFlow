import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProductDecl, RunProduct } from '@paneflow/shared';

/**
 * v13-K1 命名产物台账的判据层（判据全在这里，engine 只喂现场值、store 只管落盘——
 * 与 delivery.ts/roles.ts 同款分工）。本片要结的账：agent 自报「我产出了什么」今天既不留哈希
 * 也不落盘，worktree 一回收文档就蒸发（v13 需求文档 P4 断①），下游 `{{nodeId.field}}` 引用的
 * 是一句摘要而不是那份文档本体（断②）。
 *
 * 声明/实算分两家（这是形状，不是风格）：agent 只声明 name+file，**sha 与 bytes 由本模块读原文实算**——
 * 自报哈希等于没有哈希（v13-V1「机检/自报双口径」同族病）。
 */

/** run 级上架字节上限缺省值（`PF_SHELF_MAX_BYTES` 覆写；0=不限量、破烂=回落缺省，同 budget.maxTokens 的读法） */
export const SHELF_DEFAULT_CAP = 32 * 1024 * 1024;
/** 单件读取上限：超了不读（不记进台账，宁缺毋假），与产物端点既有 5MB 读数同量级 */
export const PRODUCT_READ_CAP = 2 * 1024 * 1024;

export function shelfCapFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SHELF_DEFAULT_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHELF_DEFAULT_CAP;
  return Math.floor(n);
}

/** 原文实算指纹：UTF-8 字节的 sha256 前 8 位（与 harness.contentSha 同截断口径，但那是规范化 JSON、这是原文） */
export function productSha(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

/** 上架文件名：只取 basename（穿越与目录结构在此被物理消灭）；空名回落 unnamed */
export function shelfName(name: string): string {
  const base = path.basename(name.trim()).replace(/[\\/:*?"<>|]+/g, '_');
  return base || 'unnamed';
}

/**
 * 声明位读端清洗（入库面是 agent 写的 artifact.json，不受我们控制，所以这里必须厚）：
 * 只认 `{name:string非空, file?:string非空}`；`file` 为绝对路径或含 `..` 段的一律拒（判为 skipped，
 * 因为读它等于允许 agent 指到仓外）。破烂整条不记，skipped 里留一句原因给事件面。
 */
export function normalizeProductDecls(raw: unknown): { decls: ProductDecl[]; skipped: { name: string; why: string }[] } {
  const decls: ProductDecl[] = [];
  const skipped: { name: string; why: string }[] = [];
  if (raw === undefined || raw === null) return { decls, skipped };
  if (!Array.isArray(raw)) {
    skipped.push({ name: 'products', why: '不是数组' });
    return { decls, skipped };
  }
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped.push({ name: `products[${i}]`, why: '不是对象' });
      return;
    }
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) {
      skipped.push({ name: `products[${i}]`, why: 'name 缺失或为空' });
      return;
    }
    if (name !== shelfName(name)) {
      // name 同时是架上的文件名：含分隔符/非法字符的两条声明会被 basename 撞成同一个文件、后写覆盖前写，
      // 于是台账说「两份」、架上只剩一份——这正是要防的「审的不是那份」。在此拒掉，不进那个状态。
      skipped.push({ name, why: 'name 不能含路径分隔符或非法文件名字符（上架会撞名互相覆盖）' });
      return;
    }
    const file = o.file === undefined ? undefined : typeof o.file === 'string' ? o.file.trim() : '';
    if (o.file !== undefined && !file) {
      skipped.push({ name, why: 'file 不是非空字符串' });
      return;
    }
    if (file && (path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) {
      skipped.push({ name, why: `file 必须是节点工作目录内的相对路径（收到 ${file}）` });
      return;
    }
    if (seen.has(name)) {
      skipped.push({ name, why: '同名声明：后声明不覆盖前声明，整条不记' });
      return;
    }
    seen.add(name);
    decls.push(file ? { name, file } : { name });
  });
  return { decls, skipped };
}

/** 台账条目（未定 shelved 前的中间形状）：content 是引擎实读到的原文 */
export interface ProductDraft {
  name: string;
  kind: 'doc' | 'diff';
  content: string;
  /** 原文实读自哪个绝对路径（只用于日志/调试，不落册——落册的是 sha，路径随 worktree 回收而失效） */
  readFrom: string;
}

/**
 * 读声明位指向的文件：候选目录按顺序试（worktree 优先于 cfg.cwd——引擎已知这两处可能分裂，
 * 账 #108；两处都没有才算没读到）。读不到/超大/非文本 → 不记，skipped 带一句人话。
 */
export function readDeclaredProducts(
  decls: ProductDecl[],
  candidateDirs: string[],
): { products: ProductDraft[]; skipped: { name: string; why: string }[] } {
  const products: ProductDraft[] = [];
  const skipped: { name: string; why: string }[] = [];
  for (const decl of decls) {
    const rel = decl.file ?? decl.name;
    let hit: { content: string; readFrom: string } | undefined;
    let lastError = '不存在';
    for (const dir of candidateDirs) {
      if (!dir) continue;
      const full = path.resolve(dir, rel);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) {
          lastError = '不是文件';
          continue;
        }
        if (st.size > PRODUCT_READ_CAP) {
          lastError = `超过单件读取上限 ${(PRODUCT_READ_CAP / 1024 / 1024).toFixed(1)}MB`;
          continue;
        }
        hit = { content: fs.readFileSync(full, 'utf8'), readFrom: full };
        break;
      } catch {
        lastError = '不存在';
      }
    }
    if (hit) products.push({ name: decl.name, kind: 'doc', ...hit });
    else skipped.push({ name: decl.name, why: `声明了但读不到：${lastError}（${rel}）` });
  }
  return { products, skipped };
}

/**
 * 上架判定（纯算，不碰盘）：本 run 已用字节 + 本件字节 是否还在上限内。
 * 返回 shelfError 时调用方**不写盘**，台账仍记这一件（shelved=false + 原因）——
 * 「产了但没上架」是读数，不是失败（节点照 done，只披露不拦）。
 */
export function planShelf(
  products: ProductDraft[],
  usedBytes: number,
  cap: number,
): (ProductDraft & { shelved: boolean; shelfError?: string })[] {
  let used = usedBytes;
  return products.map((p) => {
    const bytes = Buffer.byteLength(p.content, 'utf8');
    if (cap > 0 && used + bytes > cap) {
      return {
        ...p,
        shelved: false,
        shelfError: `over-run-cap（已用 ${(used / 1024 / 1024).toFixed(1)} MiB / 上限 ${(cap / 1024 / 1024).toFixed(1)} MiB）`,
      };
    }
    used += bytes;
    return { ...p, shelved: true };
  });
}

/** 台账落册形状（shelved 之后的草稿 → RunProduct） */
export function toRunProduct(p: ProductDraft & { shelved: boolean; shelfError?: string }): RunProduct {
  const out: RunProduct = {
    name: p.name,
    kind: p.kind,
    sha: productSha(p.content),
    bytes: Buffer.byteLength(p.content, 'utf8'),
    shelved: p.shelved,
  };
  if (!p.shelved && p.shelfError) out.shelfError = p.shelfError;
  return out;
}

/** 数一版本 run 架上已占用的字节（含本轮之前的节点；目录不存在=0，这是正读数） */
export function shelfUsedBytes(shelfRunDir: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 竞态删除：不计 */
        }
      }
    }
  };
  walk(shelfRunDir);
  return total;
}

/**
 * 自动采的 diff 产物（kind='diff'，零约定——agent 不用会写声明）：
 * 只含**已跟踪文件相对 HEAD 的改动**，未跟踪新文件不进 diff（`git diff` 的固有语义，不是漏采：
 * 台账要证「审的就是这份 patch」，把未跟踪文件硬塞成 patch 就得引擎自己造 diff 格式，那是假账）。
 * 不在 git 仓 / 无改动 / git 不可用 → undefined（无此产物，不记空 diff）。
 */
export function diffProduct(patch: string | undefined, readFrom: string): ProductDraft | undefined {
  if (!patch || !patch.trim()) return undefined;
  if (Buffer.byteLength(patch, 'utf8') > PRODUCT_READ_CAP) return undefined;
  return { name: 'changes.diff', kind: 'diff', content: patch, readFrom };
}

/**
 * 架上取一份产物原文并验指纹（v13-K1 的两处读取面共用：引擎的硬引用取材、artifacts 端点的 ?src=shelf）。
 * 路径只由 nodeId 与产物名各过一遍 shelfName 拼成——穿越在这一步就被物理消灭，调用方不必再设防。
 * 未上架 / 架上没有 / 指纹与台账不符 → 返回 why（一句人话，直接可进 error 文案）：
 * 指纹不符=「审的就是这份」这一证不成立，宁可说取不到，也不把一份对不上账的内容交给下游当指令读。
 */
export function productShelfFile(
  shelfRoot: string,
  nodeId: string,
  p: RunProduct,
): { content: string } | { why: string } {
  if (!p.shelved) return { why: `未上架（${p.shelfError ?? '原因未记'}）` };
  const file = path.join(shelfRoot, shelfName(nodeId), shelfName(p.name));
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { why: `架上读不到 ${file}（${(err as Error).message}）` };
  }
  const sha = productSha(content);
  if (sha !== p.sha) return { why: `架上内容与台账指纹不符（台账 ${p.sha} / 实读 ${sha}）` };
  return { content };
}

/** 本 run 的产物架目录：`<dataDir>/shelves/<runId>`（下面按 nodeId 分格，名只取 basename） */
export function shelfRunDir(dataDir: string, runId: string): string {
  return path.join(dataDir, 'shelves', runId);
}

/**
 * 真删除联动（v13-K1）：清掉本 run 的产物架，返回删除的件数（0 是正读数=架本来是空的）。
 * runId 只认单层目录名——含分隔符的 id 会把 rm 送出架根，那不是清理是越界，直接 0 不碰。
 * 留架不删=「删了的单还在占盘」，与 purgeArtifacts 的语义相反；默认不带该查询参数时不会走到这里。
 */
export function purgeShelf(dataDir: string, runId: string): number {
  if (!runId || runId !== path.basename(runId)) return 0;
  const target = shelfRunDir(dataDir, runId);
  let n = 0;
  const walk = (dir: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        try {
          fs.unlinkSync(full);
          n += 1;
        } catch {
          /* 单件删不掉不阻断 */
        }
      }
    }
  };
  walk(target);
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* 壳删不掉=下次再删，不影响账 */
  }
  return n;
}

/**
 * 落盘并出台账：算上限 → 逐个写（写失败=读数 shelved:false + 原因，绝不因上架失败拖红节点）→ 返回落册形状。
 * 空输入返回空数组，调用方据此**整键不写**（`rec.products` 缺省=没产，与「产了零件」分家）。
 * `dirName` 是本 run 目录下的一格（引擎传 nodeId，此处再过一遍 basename 防穿越——
 * 上架路径由 server 拼给读端，名字里带 `..` 就等于开了一个写穿越洞）。
 */
export function shelveProducts(
  runShelfDir: string,
  dirName: string,
  drafts: ProductDraft[],
  cap: number,
  write: (target: string, content: string) => void,
): RunProduct[] {
  if (!drafts.length) return [];
  const planned = planShelf(drafts, shelfUsedBytes(runShelfDir), cap);
  const dir = path.join(runShelfDir, shelfName(dirName));
  return planned.map((p) => {
    if (!p.shelved) return toRunProduct(p);
    try {
      write(path.join(dir, shelfName(p.name)), p.content);
    } catch (err) {
      return toRunProduct({ ...p, shelved: false, shelfError: `write-failed:${(err as Error).message}` });
    }
    return toRunProduct(p);
  });
}


