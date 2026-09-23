/**
 * v11-D1 网关感知限流（摩擦账 #10）：免费档网关并发一多整点 503，run 里节点成批失败。
 * 这里补上调度第三层——按「网关主机」维度的在途并发闸 + 命中限流后的临时收紧（错峰）。
 *
 * 定位：只加闸不改调度器。它与全局 pane 信号量（paneSlots）、项目级 maxConcurrentRuns
 * 取交集——节点要 pane 槽、run 额度、本网关主机额度三者齐备才起窗；排不上就在
 * runAgentNode 的尝试循环里轮询等待（复用仓库锁等待同款机制，不另起调度）。
 */

/** 与 engine 其余 PF_* 一致的整数 env 读取；未设/非数字回落默认值 */
export function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * baseUrl → 闸的键：URL 的 host（hostname:port，默认端口省略）。
 * 同主机不同端口多半是不同后端，分开计；解析不了 = 不识别（返回 null → 该 run 免闸）。
 */
export function gatewayHostOf(baseUrl: string | undefined | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * 限流特征启发式：节点失败信息（v11-D2 后异常路径自带「输出尾部」）或启动报错里
 * 找 429/503 + 限流语境词。要求数字与语境内共现（间隔有界），避免「503 files changed」
 * 这类裸数字误伤；纯词组（请求过多/限流/Too Many Requests）单独也认。
 * 覆盖面如实声明：agent CLI 若把网关错误吞成通用超时，这里就抓不到——退避只加成
 * 保险，闸与错峰不依赖识别。
 */
const THROTTLE_RES: RegExp[] = [
  // 「503 Service Unavailable」「429: too many requests」
  /\b(429|503)\b[^\n]{0,30}\b(service unavailable|too many requests|rate|throttl|overload|error|status|busy)\b/i,
  // 「HTTP 503」「status code 429」「error: 429」「429 Too Many Requests」
  /\b(http|status|error|code|upstream)\b[^\n]{0,20}\b(429|503)\b/i,
  /\b(429|503)\b[^\n]{0,20}\b(http|status|code)\b/i,
  // 无限流数字但语义明确的短语（中文组不能带 \b——CJK 不算 \w，词边界永不成立）
  /\b(rate.?limit\w*[^\n]{0,30}(exceed|error|hit)|too many requests|throttl\w*)|(请求过多|服务不可用|限流|超出配额|配额不足)/i,
];

export function looksLikeGatewayThrottle(text: string): boolean {
  if (!text) return false;
  return THROTTLE_RES.some((re) => re.test(text));
}

export interface GwGateOptions {
  /** 同一网关主机上允许同时在跑（含起窗/退避等待尝试）的节点数；<1 = 关闭整闸（PF_GW_MAX_CONCURRENT，0=关） */
  maxConcurrent: number;
  /** 一次命中限流后该主机闸临时收紧的基础窗口（ms）；连续命中按 2 倍递增，封顶 8 倍 */
  tightenMs: number;
  /** 等闸轮询间隔（ms），默认 250 */
  pollMs?: number;
  /** 可注入时钟（测试保确定性） */
  now?: () => number;
}

interface HostGate {
  active: number;
  /** 收紧窗到期前不放新窗（已在跑的节点不受影响） */
  cooldownUntil: number;
  /** 连续限流命中数：第 i 次命中收紧 tightenMs * 2^(i-1)；窗口过期后再命中重新从 1 起 */
  streak: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 跨 run 共享的按主机在途并发闸（一个 Engine 一个实例）。 */
export class GwConcurrencyGate {
  private readonly hosts = new Map<string, HostGate>();
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: GwGateOptions) {
    this.pollMs = Math.max(5, opts.pollMs ?? 250);
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.maxConcurrent >= 1;
  }

  private state(host: string): HostGate {
    let st = this.hosts.get(host);
    if (!st) {
      st = { active: 0, cooldownUntil: 0, streak: 0 };
      this.hosts.set(host, st);
    }
    return st;
  }

  /**
   * 领取一个该主机的在途额度：额度内且不在收紧窗才成功；否则轮询等（aborted 置真即放弃，
   * 返回 false 供调用方走取消路径）。关闭态直接放行且不记账。
   */
  async acquire(host: string, aborted?: () => boolean): Promise<boolean> {
    if (!this.enabled) return true;
    const st = this.state(host);
    for (;;) {
      if (aborted?.()) return false;
      if (st.active < this.opts.maxConcurrent && this.now() >= st.cooldownUntil) {
        st.active += 1;
        return true;
      }
      await sleep(this.pollMs);
    }
  }

  /** 归还额度（与 acquire 严格配对；关闭态/未记账主机为无害 no-op） */
  release(host: string): void {
    if (!this.enabled) return;
    const st = this.hosts.get(host);
    if (st) st.active = Math.max(0, st.active - 1);
  }

  /**
   * 命中一次网关限流：该主机闸临时收紧（起新窗错峰重放）。连续命中窗口翻倍，封顶 8 倍。
   * 返回本次收紧窗口（ms），供事件时间线展示。
   */
  penalize(host: string): number {
    if (!this.enabled) return 0;
    const st = this.state(host);
    const now = this.now();
    st.streak = now < st.cooldownUntil ? Math.min(st.streak + 1, 4) : 1;
    const window = this.opts.tightenMs * 2 ** (st.streak - 1);
    st.cooldownUntil = Math.max(st.cooldownUntil, now + window);
    return window;
  }

  /** 诊断/测试快照：各主机的在途数与收紧窗截止（epoch ms） */
  snapshot(): Record<string, { active: number; cooldownUntil: number; streak: number }> {
    const out: Record<string, { active: number; cooldownUntil: number; streak: number }> = {};
    for (const [host, st] of this.hosts) out[host] = { active: st.active, cooldownUntil: st.cooldownUntil, streak: st.streak };
    return out;
  }
}
