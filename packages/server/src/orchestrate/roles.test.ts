import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConventionBlock, loadRoles, saveRoles } from './roles.js';

describe('roles & conventions', () => {
  it('round-trips the global roles library', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-roles-'));
    expect(loadRoles(dir)).toEqual([]);
    saveRoles(dir, [{ id: 'dev', name: '开发', agentKind: 'pi', prePrompt: '你是开发工程师' }]);
    expect(loadRoles(dir)[0]!.agentKind).toBe('pi');
  });

  it('injects convention files with caps and path traversal guard', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-conv-'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# 团队约定\n禁止无票开发');
    const read = (p: string) => {
      try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
    };
    const block = buildConventionBlock(root, ['AGENTS.md'], read);
    expect(block).toContain('团队约定');
    expect(block).toContain('严格遵守');
    // traversal ignored
    expect(buildConventionBlock(root, ['../evil.md'], read)).toBe('');
    // missing rootCwd → empty
    expect(buildConventionBlock(undefined, ['AGENTS.md'], read)).toBe('');
  });

  it('caps oversized files and total budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-conv-'));
    fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(150 * 1024));
    const read = (p: string) => fs.readFileSync(p, 'utf8');
    const block = buildConventionBlock(root, ['big.md'], read);
    expect(block).toContain('超长截断');
    expect(block.length).toBeLessThan(150 * 1024);
  });
});
