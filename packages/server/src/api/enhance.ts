import fs from 'node:fs';
import path from 'node:path';
import { gatewayOpenaiBase, readGateway } from './gateway.js';

/**
 * v9-N1 需求增强器：把用户的一句话补成接近可开工的 issue 文本。
 * 上下文来源：工作目录内的 README 简介 + issue 模板小节（K2 起再叠 wiki）。
 * 模型调用走网关免费档；chat 以函数注入，单测不碰网络。
 */

export type ChatFn = (system: string, user: string) => Promise<string>;

/** SSE 流里聚合 delta.content（reasoning_content 是思考过程，丢弃） */
export function aggregateSse(raw: string): string {
  let out = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    try {
      const j = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] };
      out += j.choices?.[0]?.delta?.content ?? '';
    } catch {
      /* 半截心跳行跳过 */
    }
  }
  return out;
}

/**
 * 网关 chat 客户端（**必须流式**）：免费档上游被 OmniRoute 按 15s 执行死线限流，
 * 非流式的真实生成请求几乎必 504；流式首字节 ~1s、聚合完整回复即可通过。
 * 未启用网关返回 null（端点据此报 400，不猜模型）。
 */
export function gatewayChatFn(dataDir: string): ChatFn | null {
  const base = gatewayOpenaiBase(dataDir);
  const g = readGateway(dataDir);
  if (!base || !g.apiKey) return null;
  const model = g.freeModel || 'auto';
  return async (system, user) => {
    const send = () =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${g.apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.4,
          // 免费档多为推理模型：思考 token 计入预算，太小会被 finish_reason=length 吃光正文
          max_tokens: 4000,
          stream: true,
        }),
        signal: AbortSignal.timeout(120_000),
      });
    // 排队拥塞时 504/429 会出现在响应头阶段：退避后重试一次，仍失败才报错
    let res = await send();
    if (res.status === 504 || res.status === 429) {
      await new Promise((s) => setTimeout(s, 20_000));
      res = await send();
    }
    if (!res.ok) throw new Error(`网关对话失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const dec = new TextDecoder();
    const reader = res.body!.getReader();
    let raw = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
    }
    const text = aggregateSse(raw).trim();
    if (!text) throw new Error('网关只返回了思考没有正文（推理档预算耗尽，换 freeModel 或稍后再试）');
    return text;
  };
}

// 免费档仍有 token/分钟配额（429「账户已达到速率限制」实测出现过）——
// 上下文只取点睛信息：README 一句话简介 + 模板小节名，总输入压在几百字内。
const CAP = 200;

function readLines(file: string): string[] | null {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return t.split('\n');
  } catch {
    return null;
  }
}

function clip(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/** 上下文装配：找不到任何文件也不报错，返回空数组由调用方决定要不要带上下文 */
export function gatherEnhanceContext(cwd: string): { label: string; text: string }[] {
  const blocks: { label: string; text: string }[] = [];
  const readmes = ['README.md', 'readme.md', 'README.zh-CN.md', 'README_zh.md'];
  for (const r of readmes) {
    const lines = readLines(path.join(cwd, r));
    if (!lines) continue;
    // 简介 = 第一条非空且非标题的行；整篇都是标题时退回首行
    const intro =
      lines.map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ??
      lines.map((l) => l.trim()).find(Boolean);
    if (intro) {
      blocks.push({ label: `项目简介（${r}）`, text: clip(intro, CAP) });
      break;
    }
  }
  const tplDir = path.join(cwd, '.github', 'ISSUE_TEMPLATE');
  try {
    const first = fs.readdirSync(tplDir).filter((f) => f.endsWith('.md'))[0];
    if (first) {
      const lines = readLines(path.join(tplDir, first));
      const sections = (lines ?? [])
        .map((l) => l.match(/^#{2,3}\s+(.+)/)?.[1]?.trim())
        .filter((x): x is string => Boolean(x))
        .slice(0, 8)
        .join('、');
      if (sections) blocks.push({ label: `Issue 模板小节（${first}）`, text: clip(sections, CAP) });
    }
  } catch {
    /* 无模板目录 = 常态，不视为错误 */
  }
  return blocks;
}

export interface EnhancedIssue {
  title: string;
  body: string;
  /** 机检可用的验收标准（供 N2 DoR 自动补约） */
  acceptance: string[];
  /** 模型标注的仍待澄清点 */
  openQuestions: string[];
}

const SYSTEM = `你是需求分析助手。把用户的一句原始需求扩写成接近可开工的 issue。只输出一个 JSON 对象（不要围栏、不要多余文字）：
{"title":"…","body":"## 背景与目标\\n…\\n## 需求细节\\n…\\n## 验收标准\\n- [ ] …","acceptance":["可机检断言"],"openQuestions":["待澄清点"]}
验收标准须可对照产物判真假，2-5 条；不臆造未提及的技术栈。`;

function parseIssue(raw: string): EnhancedIssue | null {
  const s = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1)) as Partial<EnhancedIssue>;
    if (typeof v.title !== 'string' || typeof v.body !== 'string') return null;
    return {
      title: v.title,
      body: v.body,
      acceptance: Array.isArray(v.acceptance) ? v.acceptance.filter((x): x is string => typeof x === 'string') : [],
      openQuestions: Array.isArray(v.openQuestions)
        ? v.openQuestions.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function userPrompt(text: string, context: string, variant: string): string {
  return `原始需求：\n"""\n${text}\n"""\n${context ? `\n项目上下文：\n${context}\n` : ''}\n扩写视角提示：${variant}`;
}

const VARIANTS = [
  '按“用户能看到什么结果”来写，验收标准以产物对照为准。',
  '按“改动面与回归风险”来写，验收标准包含不破坏既有行为。',
];

/** N2：只起草验收断言的轻调用（dispatch 补约用，不要整篇 body） */
export async function draftAcceptance(text: string, chat: ChatFn): Promise<string[]> {
  const raw = await chat(
    '读下述需求，起草可对照产物逐条核对的验收断言 2-5 条（一句一条、可判真假、不臆造未提及的技术栈）。只输出 JSON：{"acceptance":["…"]}',
    text.slice(0, 2000),
  );
  const list = (items: unknown): string[] =>
    Array.isArray(items)
      ? items.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, 5)
      : [];
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) as { acceptance?: unknown };
    const hit = list(j.acceptance);
    if (hit.length) return hit;
  } catch {
    /* 没按 JSON 来就走下面的行抽取兜底 */
  }
  return list(s.split('\n').map((l) => l.match(/^\s*(?:[-*]|\d+[.、)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/)?.[1]).filter(Boolean) as unknown[]);
}

/**
 * 扩写主流程。浅档（默认）：一次生成；深档：两次不同视角生成 + 一次模型择优选出最终稿。
 * 模型/网关调用失败直接抛错（端点转 502，让用户知道是网关问题）；JSON 解析失败则整段收为 body。
 */
export async function enhanceIssueText(
  opts: { text: string; cwd: string; deep?: boolean },
  chat: ChatFn,
): Promise<{ issue: EnhancedIssue; candidates?: EnhancedIssue[] }> {
  const blocks = gatherEnhanceContext(opts.cwd);
  const context = blocks.map((b) => `【${b.label}】\n${b.text}`).join('\n\n');
  const gen = async (variant: string): Promise<EnhancedIssue> => {
    const raw = await chat(SYSTEM, userPrompt(opts.text, context, variant));
    const parsed = parseIssue(raw);
    if (parsed) return parsed;
    // 模型没按 JSON 返回：整段当 body 收下，标题取首行，保证一次真扩写不因形制丢内容
    const firstLine = raw.split('\n').find((l) => l.trim()) ?? opts.text;
    return {
      title: firstLine.replace(/^#+\s*/, '').slice(0, 120),
      body: raw,
      acceptance: [],
      openQuestions: ['（模型未按结构化格式返回，验收标准需人工补）'],
    };
  };
  if (!opts.deep) return { issue: await gen(VARIANTS[0]!) };
  const candidates = [await gen(VARIANTS[0]!), await gen(VARIANTS[1]!)];
  const pickRaw = await chat(
    '下面是同一需求的两个 issue 扩写稿（JSON）。选一个更能让执行者直接开工的，只输出数字 1 或 2。',
    candidates.map((c, i) => `${i + 1}. ${JSON.stringify(c).slice(0, 1500)}`).join('\n\n'),
  );
  const idx = pickRaw.includes('2') && !pickRaw.includes('1') ? 1 : 0;
  return { issue: candidates[idx]!, candidates };
}
