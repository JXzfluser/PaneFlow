/**
 * v14 前置-1：agent kind 的单一事实源（现状账 §一 第 9 行「两枚 TS 常量」的还账片）。
 *
 * 合一前同一份清单写了两遍：`env-check.ts` 的 kind→二进制名、`http.ts` 的 `AGENT_KINDS` 白名单。
 * 加一种 agent 要改两处码，漏一处的症状不是编译红而是读数矛盾——只在实探面有的 kind，写入面判它非法
 * （400），只在白名单有的 kind，实探永远报 missing。这是「一处登记、处处可选」的反面，也是 v14 R 系
 * 立项目前唯一真正的硬重复，所以单独成片、先于 M0 结掉。
 *
 * 本片只结账不引新形状：A3-2 会把这张表接进注册台（kind=`agent-kind`），届时消费点改成从表里取值，
 * 判据与值域仍从这里走——消费者一律 import 本模块，不许再抄一份清单。
 */
const AGENT_PROBES = [
  { kind: 'opencode', bin: 'opencode' },
  { kind: 'claude', bin: 'claude' },
  { kind: 'codex', bin: 'codex' },
  { kind: 'pi', bin: 'pi' },
  { kind: 'copilot', bin: 'copilot' },
  { kind: 'devin', bin: 'devin' },
  { kind: 'droid', bin: 'droid' },
  { kind: 'kimi', bin: 'kimi' },
  { kind: 'kilo', bin: 'kilo' },
  { kind: 'hermes', bin: 'hermes' },
  { kind: 'qwen', bin: 'qwen' },
  { kind: 'qodercli', bin: 'qodercli' },
  { kind: 'cursor', bin: 'cursor' },
  { kind: 'grok', bin: 'grok' },
  { kind: 'omp', bin: 'omp' },
  { kind: 'mastracode', bin: 'mastracode' },
  { kind: 'antigravity-cli', bin: 'antigravity' },
  { kind: 'gemini', bin: 'gemini' },
] as const;

export type AgentKind = (typeof AGENT_PROBES)[number]['kind'];

/** 合法 agent 类型全集（`/api/health` 的 `agentKinds` 与写入面值域校验共用这一枚顺序） */
export const AGENT_KINDS: readonly AgentKind[] = AGENT_PROBES.map((a) => a.kind);

/** kind → 本机 PATH 上的二进制探测名（名字不同的只有 `antigravity-cli`→`antigravity`） */
export const AGENT_BINARIES: Record<AgentKind, string> = Object.fromEntries(
  AGENT_PROBES.map((a) => [a.kind, a.bin]),
) as Record<AgentKind, string>;

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

/**
 * 探测用的二进制名。清单外的 kind 按原名探——`detectInstalledAgents` 从来允许拿任意串去 PATH 上试
 * （实探兜底与单测都走这条），那条宽容与此处的类型收紧不冲突。
 */
export function agentBinaryName(kind: string): string {
  return (AGENT_BINARIES as Record<string, string>)[kind] ?? kind;
}
