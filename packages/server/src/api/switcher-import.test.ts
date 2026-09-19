import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskCandidate, parseSwitcherConfig, readSwitcherFile } from './switcher-import.js';

function writeTmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sw-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('v9-D3 parseSwitcherConfig（只认已知形状，认不出就跳过）', () => {
  it('cc Switch 形状：providers[].settings.env 的 ANTHROPIC 系被提取，freeModel 取 ANTHROPIC_MODEL', () => {
    const got = parseSwitcherConfig({
      providers: [
        {
          name: '公司网关',
          settings: { env: { ANTHROPIC_BASE_URL: 'http://gw:20128', ANTHROPIC_AUTH_TOKEN: 'sk-abc123', ANTHROPIC_MODEL: 'glmcn/glm-4.7' } },
        },
      ],
    });
    expect(got).toEqual([{ name: '公司网关', baseUrl: 'http://gw:20128', apiKey: 'sk-abc123', freeModel: 'glmcn/glm-4.7' }]);
  });

  it('顶层数组 / {env} 直接挂 / OPENAI 系兜底都能认；同名自动加序号', () => {
    const got = parseSwitcherConfig([
      { id: 'a', env: { OPENAI_BASE_URL: 'http://o/v1', OPENAI_API_KEY: 'k1' } },
      { name: 'a', settings: { env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_API_KEY: 'k2' } } },
    ]);
    expect(got.map((c) => c.name)).toEqual(['a', 'a (2)']);
    expect(got[0]!.baseUrl).toBe('http://o/v1');
    expect(got[1]!.apiKey).toBe('k2');
  });

  it('缺 baseUrl 或缺 key 的项跳过；整体不像形状返回空数组（不猜）', () => {
    expect(parseSwitcherConfig({ providers: [{ name: '没 env' }, { name: '只有 URL', env: { ANTHROPIC_BASE_URL: 'http://x' } }] })).toEqual([]);
    expect(parseSwitcherConfig('字符串')).toEqual([]);
    expect(parseSwitcherConfig({ settingsVersion: 3 })).toEqual([]);
  });
});

function errOf(r: ReturnType<typeof readSwitcherFile>): string {
  if (r.ok) throw new Error('预期失败却成功了');
  return r.error;
}

describe('v9-D3 readSwitcherFile（一切失败都明说，不静默不猜）', () => {
  it('空路径 / 文件不存在 / 非 JSON / 零候选：各给各的错误信息', () => {
    expect(errOf(readSwitcherFile('  '))).toContain('路径');
    expect(errOf(readSwitcherFile('/definitely/not/here.json'))).toContain('找不到源文件');
    expect(errOf(readSwitcherFile(writeTmp('bad.json', '{{{')))).toContain('不是合法 JSON');
    expect(errOf(readSwitcherFile(writeTmp('plain.json', JSON.stringify({ hello: 1 }))))).toContain('不猜');
  });

  it('超过 256KB 拒读；正常文件返回候选且 mask 只留密钥尾 4 位', () => {
    const big = writeTmp('big.json', 'x'.repeat(257 * 1024));
    expect(errOf(readSwitcherFile(big))).toContain('拒读');
    const ok = readSwitcherFile(
      writeTmp('sw.json', JSON.stringify({ providers: [{ name: '甲', settings: { env: { ANTHROPIC_BASE_URL: 'http://a', ANTHROPIC_AUTH_TOKEN: 'sk-wxyz9999' } } }] })),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(maskCandidate(ok.candidates[0]!)).toEqual({ name: '甲', baseUrl: 'http://a', keyTail: '9999' });
  });
});
