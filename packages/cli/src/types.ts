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

/** GET /api/runs / GET /api/runs/:id 的最小结构读法（只声明 CLI 用到的字段） */export interface RunView {
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
   * v13-K2 打回账（引擎结构化落册，落在这**一岗被否决回边拒过**的节点上）：
   * reviewer=拒它的审查节点，reason=它写的原话（缺=没写，不编），
   * action=rework=打回重跑 / capped=上限已达这次没人解决。
   * 整缺=从没被打回（与 K2 前的旧单同形，不据此断言「零返工」）。
   */
  rejections?: {
    at: string;
    attempt: number;
    reviewer: string;
    reason?: string;
    action: string;
  }[];
  /**
   * v13-W1 岗位装备账（server 在注入现场算好落册，这里零判据只渲染）：
   * scope=space 即「这个岗其实在吃空间全量」——警告行的唯一依据；整缺=注入现场没走到，不猜。
   * v14-A5-5b 起 `misses` 带每格的**一句为什么**（server 现算的措辞，CLI 不复述判据、不改写）；
   * `unknownSkills`/`unknownRules` 仍是槽原文——旧单没有 `misses`，读端照旧回落那一行。
   */
  equip?: {
    scope: string;
    role?: string;
    skills?: string[];
    rules?: string[];
    unknownSkills?: string[];
    unknownRules?: string[];
    misses?: { axis: string; slot: string; why: string }[];
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

/** POST /api/env/probe 的最小结构读法（v14-E1 草案注册集；只声明 CLI 用到的字段） */
export interface EnvProbeItemView {
  /** 类目按 string 读：server 日后加类目（如 channel）不许把薄壳炸红 */
  kind: string;
  name: string;
  detail: string;
  /** 依据：发现自哪个相对路径——E1 的定义要求每项都带，CLI 只照读不核 */
  evidence: string;
}

export interface EnvProbeView {
  path: string;
  /** git 仓根：不是 git 仓=整键缺省（不是空串），缺就不渲染 */
  root?: string;
  /** server 算好的一句人话汇总：计数与归一全在判据层，CLI 零判据只照读 */
  summary?: string;
  /** 只含有依据的发现；[] 是正读数「一条都没探到」，与 error（现场读不到）分家 */
  items: EnvProbeItemView[];
  /** 没探到的类目 + 一句为什么 */
  missing: string[];
  /** 本机可用 agent CLI（/api/health 同一套实探）；[] 是正读数，整缺=旧 server */
  agentsAvailable?: string[];
  /** 探测失败的一句人话（这是读数不是客户端错误：HTTP 200 带它） */
  error?: string;
}

/**
 * v14-A1/A2（R1+R2）注册表视图（`GET/POST /api/registry`）：**每个字段都是 server 算好的**——
 * `label` 来自该 kind 的 Descriptor、`refs` 来自纯读引用索引，CLI 一格都不自己判（R4）。
 */
export interface RegistryEntryView {
  id: string;
  kind: string;
  name: string;
  source: string;
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
  /** server 的一句人话标签（不看 spec 就能说清这条是什么） */
  label?: string;
  /**
   * 「谁在用」。**缺键＝引用账没读出来（不知道）**，与 `[]`（正读数：一条引用都没有）分家——
   * 这是 R2 的 宁缺毋假 在 HTTP 面上的形状，CLI 据此决定渲染哪句。
   */
  refs?: { face: string; id: string; name: string; via: string }[];
  /**
   * v14-A3-2：这一项是**内置清单的视图项**（出厂自带、不落盘、写入面不接）。server 给的读数，
   * CLI 不拿 `source==='builtin'` 自己推（出处与可写性是两条判据，两份迟早分叉）。缺键＝旧 server，按非视图渲染。
   */
  view?: boolean;
}

/** `GET /api/registry` 的响应（`rejected`/`refSummary` 都是只披露不清除的读端账） */
export interface RegistryListView {
  entries: RegistryEntryView[];
  /** 手改盘面/旧版本写进来的条目：整条不认，但必须看得见（渲成「一条都没登记」是假绿） */
  rejected: { id: string; why: string }[];
  schema: { version: number; writtenBy?: string } | null;
  knownKinds: string[];
  /** `knownKinds` 里「现算出来、不可登记/改/删」的那几类（A3-2；缺键＝旧 server） */
  viewKinds?: string[];
  /**
   * kind → 这一类的**正身在哪儿**（A5-4b-1 起外发；缺键＝旧 server）。视图 kind 不再只有一种出处
   * （`agent-kind` 住代码、`role` 住角色库），薄壳自造一句「出厂自带」就会对岗位说假话——措辞只在 server 一处。
   */
  viewHomes?: Record<string, string>;
  /** kind → 人话组名（server 那一处词表外发；缺键＝旧 server，画 kind 原值，CLI 不自备对照表） */
  kindLabels?: Record<string, string>;
  refSummary?: {
    scanned: number;
    dangling: { kind: string; target: string; by: unknown[] }[];
    unmigrated: { kind: string; targets: string[]; refs: number }[];
  };
}

/**
 * v14 R4 健康读数（`GET /api/registry/health`）：三态与计数**全是 server 算好的**。
 * `status` 按 string 读（日后加枚举不许把薄壳炸红）；`health` **缺键＝这一类没有探针通道**，
 * 与 `unknown`（探了没探通）、`missing`（探通了清单里没有）是三件事，各画各的。
 */
/**
 * R4 的一条实探读数（批量面与单枚面同形）。`status` 按 string 读（日后加枚举不许把薄壳炸红）；
 * `detail` 是 server 的一句人话，为什么这么判全在里面。
 */
export interface RegistryHealthReadout {
  status: string;
  detail: string;
  at?: string;
  cached?: boolean;
}

export interface RegistryHealthRow extends RegistryEntryView {
  health?: RegistryHealthReadout;
}

/** `GET /api/registry/:id/health`（单枚探针 `paneflow registry probe <id>`） */
export interface RegistryProbeView {
  at?: string;
  entry: RegistryEntryView;
  health?: RegistryHealthReadout;
}

/**
 * `GET /api/registry/:id`（`paneflow registry get|refs <id>`）：条目 + 视图 kind 的正身措辞。
 * `viewHomes` 与 list 同一份表——详情那一行「这一项从哪儿来」不能说假话（岗位不是出厂自带的）。
 */
export interface RegistryDetailView {
  entry: RegistryEntryView;
  viewHomes?: Record<string, string>;
}

/**
 * v14-T3 一条能力槽的落点读数。`verdict` 按 string 读（日后加一枚落点不许把薄壳炸红，
 * 也不许被就近塞进 ✓/✗ 某一档）；命中说明与缺因都是 server 写好的 `why`，CLI 不自己拼判定。
 */
export interface RequirementSlotView {
  kind: string;
  id?: string;
  hint?: string;
  verdict: string;
  why: string;
  entryId?: string;
}

/** 一张模板的预检读数（`need` 的分组计数与中文组名全在 server 算好） */
export interface RegistryCheckRow {
  template: string;
  slots: RequirementSlotView[];
  need: { kind: string; label: string; declared: number; judged: number; gaps: number }[];
  missing: RequirementSlotView[];
  unjudged: RequirementSlotView[];
  malformed: RequirementSlotView[];
  ok: boolean;
}

/** `GET /api/registry/check`：给 `--template` 时只有一行，不给=扫全部在册模板 */
export interface RegistryCheckView {
  space: string;
  spaceNote?: string;
  at?: string;
  templates: RegistryCheckRow[];
}

export interface RegistryHealthView {
  at?: string;
  entries: RegistryHealthRow[];
  /** 盘上指向已迁类型却查不到条目的裸串（E2「一键登记」的输入源；server 不给「已被承接」字段——那枚恒 false） */
  dangling: { kind: string; target: string; by: { face: string; id: string; name: string; via: string }[] }[];
  summary?: {
    scanned?: number;
    dangling?: number;
    unmigrated?: number;
    probed?: number;
    live?: number;
    missing?: number;
    unknown?: number;
    unused?: number;
  };
}

export const EXIT_OK = 0;
/** 1 = 红（failed/cancelled/completed-with-failures）；API/用法错误同码 */
export const EXIT_RED = 1;
export const EXIT_TIMEOUT = 2;
export const EXIT_GATE = 3;
