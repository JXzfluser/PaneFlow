import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateSse, enhanceIssueText, gatherEnhanceContext, type ChatFn } from './enhance.js';

function projectWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-enhance-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const ISSUE_JSON = JSON.stringify({
  title: '绿化台账汇总提速',
  body: '## 背景与目标\n…\n## 验收标准\n- [ ] 汇总 < 2s',
  acceptance: ['汇总接口 P95 < 2s'],
  openQuestions: ['数据量级？'],
});

describe('v9-N1 SSE 聚合', () => {
  it('只累计 delta.content，思考流与坏行忽略', () => {
    const raw = [
      'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}',
      'data: {"choices":[{"delta":{"content":"{\\"title\\""}}]}',
      'data: 心跳',
      'data: {"choices":[{"delta":{"content":":\\"x\\"}"}}]}',
      'data: [DONE]',
    ].join('\n\n');
    expect(aggregateSse(raw)).toBe('{"title":"x"}');
  });
});

describe('v9-N1 上下文装配（点睛式：简介行 + 模板小节名）', () => {
  it('README 取首条非标题行、模板取小节名，均截断不越界', () => {
    const dir = projectWith({
      'README.md': `# 台账系统\n${'x'.repeat(3000)}`,
      'AGENTS.md': '约定：中文提交',
      '.github/ISSUE_TEMPLATE/bug.md': '# 缺陷\n## 期望行为\n正文\n## 复现步骤',
    });
    const blocks = gatherEnhanceContext(dir);
    expect(blocks.map((b) => b.label)).toEqual(['项目简介（README.md）', 'Issue 模板小节（bug.md）']);
    expect(blocks[0]!.text.length).toBeLessThanOrEqual(201);
    expect(blocks[0]!.text.endsWith('…')).toBe(true);
    expect(blocks[1]!.text).toBe('期望行为、复现步骤');
  });

  it('整篇都是标题的 README 退回首行', () => {
    const dir = projectWith({ 'README.md': '# 只有标题\n## 之二' });
    expect(gatherEnhanceContext(dir)).toEqual([{ label: '项目简介（README.md）', text: '# 只有标题' }]);
  });

  it('空目录返回空上下文（不报错）', () => {
    expect(gatherEnhanceContext(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-enhance-empty-')))).toEqual([]);
  });
});

describe('v9-N1 enhanceIssueText', () => {
  it('浅档：一次调用即返回结构化 issue，上下文随 user prompt 带入', () => {
    const calls: { system: string; user: string }[] = [];
    const chat: ChatFn = async (system, user) => {
      calls.push({ system, user });
      return ISSUE_JSON;
    };
    const dir = projectWith({ 'README.md': '# 绿化台账' });
    return enhanceIssueText({ text: '台账汇总太慢', cwd: dir }, chat).then((r) => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.user).toContain('# 绿化台账');
      expect(r.issue.title).toBe('绿化台账汇总提速');
      expect(r.issue.acceptance).toEqual(['汇总接口 P95 < 2s']);
      expect(r.candidates).toBeUndefined();
    });
  });

  it('深档：两稿不同视角 + 一次择优，返回最终稿与候选', () => {
    const prompts: string[] = [];
    let n = 0;
    const chat: ChatFn = async (_s, user) => {
      prompts.push(user);
      n += 1;
      if (n <= 2) return JSON.stringify({ ...JSON.parse(ISSUE_JSON), title: `稿${n}` });
      return '2';
    };
    const dir = projectWith({});
    return enhanceIssueText({ text: '优化导出', cwd: dir, deep: true }, chat).then((r) => {
      expect(prompts).toHaveLength(3);
      expect(r.candidates?.map((c) => c.title)).toEqual(['稿1', '稿2']);
      expect(r.issue.title).toBe('稿2');
    });
  });

  it('模型不按 JSON 返回：整段收为 body，标题取首行，不丢内容', async () => {
    const chat: ChatFn = async () => '# 标题行\n正文随意写的段落';
    const dir = projectWith({});
    const r = await enhanceIssueText({ text: '随便', cwd: dir }, chat);
    expect(r.issue.title).toBe('标题行');
    expect(r.issue.body).toContain('正文随意写的段落');
    expect(r.issue.openQuestions.length).toBe(1);
  });

  it('markdown 围栏包裹的 JSON 也能解析', async () => {
    const chat: ChatFn = async () => '```json\n' + ISSUE_JSON + '\n```';
    const r = await enhanceIssueText({ text: 'x', cwd: projectWith({}) }, chat);
    expect(r.issue.acceptance).toEqual(['汇总接口 P95 < 2s']);
  });

  it('网关抛错原样上抛（端点转 502，不静默降级）', async () => {
    const chat: ChatFn = async () => {
      throw new Error('网关对话失败：HTTP 500');
    };
    await expect(enhanceIssueText({ text: 'x', cwd: projectWith({}) }, chat)).rejects.toThrow('HTTP 500');
  });
});
