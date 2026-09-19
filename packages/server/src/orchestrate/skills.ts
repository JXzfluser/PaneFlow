import fs from 'node:fs';
import path from 'node:path';

/**
 * I1 skills 死配置激活：profile.skills（与 conventionFiles 同款的发现→勾选清单）
 * 自此有两个运行期消费者——
 *  1) 节点 prompt：约定同款通道整篇注入（buildSkillBlock，大小上限复用）；
 *  2) 下发 Planner：技能索引一行一项（readSkillIndex，只读首行不整篇）。
 */
export interface SkillIndexEntry {
  name: string;
  description?: string;
}

const PER_FILE_CAP = 100 * 1024;
const TOTAL_CAP = 250 * 1024;
const HEAD_BYTES = 400;
const DESC_CAP = 100;
const MAX_SKILLS = 20;

const safeJoin = (rootCwd: string, rel: string): string | null =>
  rel.includes('..') ? null : path.resolve(rootCwd, rel);

/** 约定同款注入块：技能整篇进节点 prompt，措辞区分「严格遵守」与「酌情参考」。 */
export function buildSkillBlock(
  rootCwd: string | undefined,
  skills: string[] | undefined,
  readFile: (p: string) => string | null,
): string {
  if (!rootCwd || !skills?.length) return '';
  const parts: string[] = [];
  let total = 0;
  for (const rel of skills) {
    const abs = safeJoin(rootCwd, rel);
    if (!abs) continue;
    const content = readFile(abs);
    if (content === null) continue;
    const clipped = content.length > PER_FILE_CAP ? `${content.slice(0, PER_FILE_CAP)}\n…（超长截断）` : content;
    if (total + clipped.length > TOTAL_CAP) {
      parts.push(`<技能文档 name="${rel}">（超出总预算未注入）</技能文档>`);
      break;
    }
    total += clipped.length;
    parts.push(`<技能文档 name="${rel}">\n${clipped}\n</技能文档>`);
  }
  if (!parts.length) return '';
  return `以下是本空间的技能库（沉淀过的可复用做法，与本单匹配就参考执行）：\n\n${parts.join('\n\n')}\n\n---\n`;
}

/** Planner 用技能索引：名字+首行描述（不读整篇），控制注入体积。 */
export function readSkillIndex(rootCwd: string | undefined, skills: string[] | undefined): SkillIndexEntry[] {
  if (!rootCwd || !skills?.length) return [];
  const out: SkillIndexEntry[] = [];
  for (const rel of skills) {
    if (out.length >= MAX_SKILLS) break;
    const abs = safeJoin(rootCwd, rel);
    if (!abs) continue;
    let head: string;
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
        head = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue; // 文件缺失/不可读：如实跳过，不编造
    }
    const name = path.basename(rel).replace(/\.md$/i, '').trim();
    if (!name) continue;
    const firstLine = head
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l !== '');
    const description = firstLine ? firstLine.slice(0, DESC_CAP) : undefined;
    out.push({ name, ...(description && description !== name ? { description } : {}) });
  }
  return out;
}
