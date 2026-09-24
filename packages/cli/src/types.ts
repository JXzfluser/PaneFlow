/**
 * CLI 共享类型与 IO 注入面。
 * 铁律（R4）：零业务逻辑、禁直读 dataDir——这里只定义 server JSON 的
 * 结构化读法（state 一律按 string 处理，前瞻兼容 completed-with-failures
 * 这类还没进 shared 类型的字面量），判定全部用 server 返回字段说话。
 */

/** vitest 替身注入面：默认实现走真实 fetch/stdout/fs，测试全部换成假的 */
export interface CliIo {
  fetch: typeof globalThis.fetch;
  /** stdout 行输出（人读与 --json 都走这里，保证 jq 干净） */
  out: (line: string) => void;
  /** stderr */
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  homedir: () => string;
  readFile: (p: string) => string | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 是否有着色能力（缺省跟随 stdout.isTTY；测试注入 false） */
  color: boolean;
}

/** GET /api/runs / GET /api/runs/:id 的最小结构读法（只声明 CLI 用到的字段） */
export interface RunView {
  runId: string;
  state: string;
  dagName?: string;
  issueId?: string;
  startedAt?: string;
  finishedAt?: string;
  cwd?: string;
  cost?: { totalMs?: number };
  prUrl?: string;
  nodes?: Record<string, NodeRunView>;
  graph?: {
    nodes?: { id: string; label?: string; type?: string }[];
    edges?: { source: string; target: string }[];
  };
  /** v11-A1 只读聚合字段：审批门显式信号（老 server 没有时按节点 state 兜底推导） */
  awaitingApproval?: { waiting: boolean; nodeIds: string[] };
  /** v12-V1 起单时固化的实发 harness（旧 run/旧 server 没有=不渲染，判定零在 CLI） */
  harness?: { graphSha?: string; agentKind?: string; model?: string; gwProfile?: string };
  /** v12-S1a 副作用落册账（server 判据算好，CLI 只渲染；缺项跳过、整缺不显示） */
  sideEffects?: { issuesCreated?: number[]; issuePatched?: number[]; prUrl?: string; pushedAt?: string };
  /** v12-V2 人介入账（验证税）：放门结算好的等待时长 + 决策计数；无=本单没批过门，整缺不显示 */
  attention?: { waitMs?: number; gates?: { approve?: number; reject?: number; input?: number } };
}

export interface NodeRunView {
  nodeId: string;
  state: string;
  error?: string;
  blockedPrompt?: string;
  /** v13-S2 掐断账（引擎结构化落册，只取最新一条展示） */
  abandonments?: {
    at: string;
    attempt: number;
    trigger: string;
    agentStatus: string;
    agentName: string;
  }[];
}

/** POST /api/dispatch 的响应（nodes 为 v11-A1 新增节点清单摘要） */
export interface DispatchResult {
  runId: string;
  issueId?: string;
  issueFetched?: boolean;
  note?: string;
  contract?: { mode: string; assertions?: number; template?: string };
  nodes?: { id: string; name: string; type: string; dependsOn: string[] }[];
}

export const EXIT_OK = 0;
/** 1 = 红（failed/cancelled/completed-with-failures）；API/用法错误同码 */
export const EXIT_RED = 1;
export const EXIT_TIMEOUT = 2;
export const EXIT_GATE = 3;
