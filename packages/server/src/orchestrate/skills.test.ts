import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSkillBlock, readSkillIndex } from './skills.js';

const mkRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pf-skills-'));

describe('buildSkillBlock（I1 约定同款注入）', () => {
  it('注入技能全文并带区分措辞', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'deploy.md'), '# 部署做法\n先跑迁移再滚动发布');
    const block = buildSkillBlock(root, ['skills/deploy.md'], (p) => {
      try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
    });
    expect(block).toContain('技能库');
    expect(block).toContain('参考执行');
    expect(block).toContain('先跑迁移再滚动发布');
    expect(block).toContain('<技能文档 name="skills/deploy.md">');
  });

  it('缺失文件跳过、traversal 拒绝、全空返空串', () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'ok.md'), '可用技能');
    const read = (p: string) => {
      try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
    };
    const block = buildSkillBlock(root, ['nope.md', '../evil.md', 'ok.md'], read);
    expect(block).toContain('可用技能');
    expect(block).not.toContain('evil');
    expect(buildSkillBlock(root, ['nope.md'], read)).toBe('');
    expect(buildSkillBlock(undefined, ['ok.md'], read)).toBe('');
    expect(buildSkillBlock(root, [], read)).toBe('');
  });

  it('超长单文件截断标注', () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(150 * 1024));
    const block = buildSkillBlock(root, ['big.md'], (p) => fs.readFileSync(p, 'utf8'));
    expect(block).toContain('超长截断');
    expect(block.length).toBeLessThan(150 * 1024);
  });
});

describe('readSkillIndex（Planner 技能索引）', () => {
  it('名字取文件名（去 .md），描述取首行（去 #），与名字同则不重复', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.md'), '# 灰度发布流程\n\n正文略');
    fs.writeFileSync(path.join(root, 'sub', 'beta-deploy.md'), '   \n#   beta-deploy\n正文略');
    fs.writeFileSync(path.join(root, 'c.md'), '纯文本首行描述');
    const idx = readSkillIndex(root, ['a.md', 'sub/beta-deploy.md', 'c.md', 'missing.md']);
    expect(idx).toEqual([
      { name: 'a', description: '灰度发布流程' },
      { name: 'beta-deploy' },
      { name: 'c', description: '纯文本首行描述' },
    ]);
  });

  it('超长首行截到 100 字符；空清单/无根返空', () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'long.md'), `# ${'描'.repeat(150)}`);
    const [only] = readSkillIndex(root, ['long.md']);
    expect(only!.description!.length).toBe(100);
    expect(readSkillIndex(root, undefined)).toEqual([]);
    expect(readSkillIndex(undefined, ['long.md'])).toEqual([]);
  });

  it('上限 20 项，多出的如实丢弃', () => {
    const root = mkRoot();
    const files: string[] = [];
    for (let i = 0; i < 25; i++) {
      const f = `s${i}.md`;
      fs.writeFileSync(path.join(root, f), `# 技能 ${i}`);
      files.push(f);
    }
    expect(readSkillIndex(root, files)).toHaveLength(20);
  });
});
