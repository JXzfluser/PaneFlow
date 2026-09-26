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
  /** v12-V1 起单时固化的实发 harness（旧 run/旧 server 没有=不渲染，判定零在 CLI）；
   *  v13-V2 等臂读数三键：readback=读回块最终在不在 prompt（server 扫 graph 实态）、
   *  readbackOutcome=实发结局枚举、skeletonSha=剥注入块+归一路径后的骨架指纹——缺项跳过 */
  harness?: {
    graphSha?: string;
    agentKind?: string;
    model?: string;
    gwProfile?: string;
    readback?: boolean;
    readbackOutcome?: string;
    skeletonSha?: string;
    /** v13-V4 注入面指纹：注入现场实读文件集+两枚运行旋钮，server 算好；旧单缺键不渲染 */
    ctxSha?: string;
    /** v13-W2 岗位指纹：角色+实解析装备的路径集指纹（server 注入现场算好）；旧单缺键不渲染 */
    roleSha?: string;
    /** v13-W2 注入字节账：本单各节点注入块的 UTF-8 字节合计（0 是正读数；缺键=没走到注入现场） */
    injectedBytes?: number;
  };
  /** v12-S1a 副作用落册账（server 判据算好，CLI 只渲染；缺项跳过、整缺不显示） */
  sideEffects?: { issuesCreated?: number[]; issuePatched?: number[]; prUrl?: string; pushedAt?: string };
  /** v12-V2 人介入账（验证税）：放门结算好的等待时长 + 决策计数；无=本单没批过门，整缺不显示 */
  attention?: { waitMs?: number; gates?: { approve?: number; reject?: number; input?: number } };
  /**
   * v13-B2 ①机检层在册账（server 建 worktree 现场落册，CLI 零判据只渲染）：家规命中且真建过
   * 隔离工作目录才有键——整缺=本单没按家规建过支（含「没配家规」），不是「建了零个」。
   */
  deliveryWorktrees?: {
    nodeId: string;
    ruleIndex: number;
    matchedBy: string;
    pullMode: string;
    baseRef?: string;
    baseSource?: string;
    expectedBranch: string;
    prTarget: string;
    actualBranch?: string;
  }[];
  /** v13-B2 ③对账层落差账：一句人话由 server 算好（detail），只照不拦；整缺=无落差 */
  deliveryViolations?: { kind: string; detail: string }[];
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
  /**
   * v13-W1 岗位装备账（server 在注入现场算好落册，这里零判据只渲染）：
   * scope=space 即「这个岗其实在吃空间全量」——警告行的唯一依据；整缺=注入现场没走到，不猜。
   */
  equip?: {
    scope: string;
    role?: string;
    skills?: string[];
    rules?: string[];
    unknownSkills?: string[];
  };
  /**
   * v13-K1 命名产物台账（server 在尝试收口现场实读算好，这里零判据只渲染）：
   * sha/bytes 是引擎读原文算的，不是 agent 自报值；shelved=false 也是正读数（被上限拒了/读不到），
   * 整缺=这一轮压根没有产物（与「声明了但零件」分家）。
   */
  products?: {
    name: string;
    kind: string;
    sha: string;
    bytes: number;
    shelved: boolean;
    shelfError?: string;
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
  /** 打标回执：server 认下的实验标原样回显（不给 experiment 键=整键不出现；判据全在 server，这里只渲染） */
  experiment?: { suite?: string; arm?: string; flag?: string };
}

export const EXIT_OK = 0;
/** 1 = 红（failed/cancelled/completed-with-failures）；API/用法错误同码 */
export const EXIT_RED = 1;
export const EXIT_TIMEOUT = 2;
export const EXIT_GATE = 3;
