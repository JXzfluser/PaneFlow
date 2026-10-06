import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanMcpConfigHome } from './registry-routes.js';

/**
 * v18 MCP 自动发现（cc Switch 思路）纯函数：扫 home 下的 .claude.json / .cursor/mcp.json，
 * 抬 command 型候选；http/sse 型如实 skipped；已在册同名跳过；坏 JSON/缺文件不是错误。
 */

const mkHome = (files: Record<string, string>): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mcp-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return home;
};

describe('scanMcpConfigHome', () => {
  it('Claude Code 与 Cursor 配置里的 command 型都抬出来；同名去重', () => {
    const home = mkHome({
      '.claude.json': JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
          dup: { command: 'uvx', args: ['mcp-dup'] },
        },
      }),
      '.cursor/mcp.json': JSON.stringify({
        mcpServers: { dup: { command: 'uvx', args: ['mcp-dup-from-cursor'] } },
      }),
    });
    const r = scanMcpConfigHome(home, new Set());
    expect(r.candidates.map((c) => c.name).sort()).toEqual(['dup', 'filesystem']);
    const fs1 = r.candidates.find((c) => c.name === 'filesystem')!;
    expect(fs1.command).toBe('npx');
    expect(fs1.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    expect(fs1.source).toBe('Claude Code');
    expect(r.candidates.find((c) => c.name === 'dup')!.source).toBe('Claude Code'); // 先到先得
  });

  it('http/sse 型如实 skipped；已在册同名不进候选；坏 JSON/缺文件静默', () => {
    const home = mkHome({
      '.claude.json': JSON.stringify({
        mcpServers: {
          web: { type: 'http', url: 'https://mcp.example/sse' },
          registered: { command: 'node', args: ['registered.js'] },
        },
      }),
      '.cursor/mcp.json': '{broken',
    });
    const r = scanMcpConfigHome(home, new Set(['registered']));
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'web', source: 'Claude Code', why: 'http/sse 型 server 不是命令账，这一版登记不了' }]);
  });

  it('home 下什么配置都没有＝两个空数组（正读数，不是错误）', () => {
    const r = scanMcpConfigHome(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mcp-empty-')), new Set());
    expect(r).toEqual({ candidates: [], skipped: [] });
  });
});
