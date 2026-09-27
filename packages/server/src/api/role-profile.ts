import type { RunRecord } from '@paneflow/shared';
import { machineCheckTally } from '@paneflow/shared';

/**
 * v13-W4 角色能力账（实证分母读端）：GET /api/roles/:id/profile 的全部判据都在这一个
 * 纯函数模块里——http.ts 只负责把**已落册**的 RunRecord 列表喂进来并挂路由，零 IO、
 * 零新写端、零引擎改动（先例：v13-V1 machineCheckTally 的纯读时算姿势）。
 *
 * 为什么只能读时算：机检成功、岗位装备这些账历史上从没单独落过册，写端方案对旧 run
 * 永远缺账；这里聚合的每一个数都从 RunRecord 既有字段推得：
 *  · 样本归属（哪些单上过这个岗）→ graph 节点 config.role（名义绑岗）× 节点记录 equip.role
 *    （v13-W1 注入现场实绑；equip 落了册就只认实绑，pre-W1 旧单回落名义绑岗——宁缺毋假）；
 *  · 分组 → harness.roleSha（v13-W2 岗位+装备指纹；没落册的单进总账不进任何组，
 *    于是「总账样本数 ≥ 各组样本数之和」是口径而非 bug）；
 *  · 通过率 → run.state / 节点 state；attention → run.attention（v12-V2）；
 *  · token → run.cost.tokens（null=拿不到，绝不估算）；机检 → machineCheckTally(run)；
 *  · 返工 → 该岗节点记录的 rejections 账（v13-K2 打回回路，落册在被拒方）。
 *
 * 多角色 run 的诚实边界：attention/tokens/machineCheck 三本账在落册处就是 **run 级聚合**
 * （引擎没有按岗拆账），本模块只把它们记到「上过该岗的单」头上——含该岗即整单入账。
 * 所以这些数对多岗单是**上界归因**，分母 n 如实暴露样本构成，读者据此自行折价；
 * 造一个「看起来是岗位的」拆分数才是假账。
 *
 * 返工（rework）在 K2 之前**刻意不聚合**：当时没有任何按岗可归因的落册字段忠实度量
 * 「这岗的活被打回重做」——attention.gates.reject 是 run 级合计（拆不到岗）、节点 attempts
 * 是引擎重试（超时/报错，语义≠返工）。缺一个数是诚实，造一个是假账。
 * K2 落地后这字段有了正身：节点记录的 `rejections[]`（谁拒的、第几轮、封顶还是重跑），
 * 账落在**被拒方**节点上，于是按岗归因是直接的，不需要 proxy。
 * 仍然守同一口径：只在真有打回条目时报数——K2 前的旧单和「从没被打回」在账上同形
 * （都是整键缺省），拿 0 冒充实测「零返工」就是造出来的假账。
 */

/** 分母约定（全模块统一）：每个指标对象自带 n=可支持该断言的样本数；
 *  n===0（没有任何样本带齐该指标所需落册字段）→ **整键省略**，不报 {n:0} 占位——
 *  machineCheckTally 同款姿势：0 是正断言（「一条都没过」），「不知道」不是 0。
 *  runs（样本单数）永远是正计数，0 也是读数（「这岗一次没上过」）。 */

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** run 级通过率分母：completed / completed-with-failures / failed。
 *  cancelled 不入分母——人停的单不是岗位工作的裁决（同 v11-D3 精神：判据宁窄不浑）。 */
function runVerdict(state: RunRecord['state'] | undefined): 'pass' | 'fail' | 'none' {
  if (state !== 'completed' && state !== 'completed-with-failures' && state !== 'failed') return 'none';
  return state === 'completed' ? 'pass' : 'fail';
}

/** 岗级节点通过率分母：done / failed。skipped/cancelled/非终态不入分母（不是岗位干出来的结论）。 */
const NODE_TERMINAL = new Set(['done', 'failed']);

export interface RoleGateCounts {
  approve: number;
  reject: number;
  input: number;
}

/** 一集样本 run（总体或某个 roleSha 组）的能力账 */
export interface RoleProfileMetrics {
  /** 上过该岗且实际落了装备/绑岗记录的 run 数——正计数，0 是读数不是缺账 */
  runs: number;
  /** run 级通过率：n=已收口且有裁决的样本数，passed=completed 数（completed-with-failures 计红） */
  passRate?: { n: number; passed: number };
  /** 岗级节点通过率：只数**该岗节点**的终态记录（跨岗不混账），n=done+failed */
  nodePassRate?: { n: number; done: number; failed: number };
  /** 人等分（v12-V2 attention）：n=落了 attention 账的样本 run 数；run 级合计，见文件头归因边界 */
  attention?: { n: number; waitMs: number; gates: RoleGateCounts };
  /** token 合计：n=cost.tokens 非 null 的样本 run 数（agent 自报口径，拿不到不估算） */
  tokens?: { n: number; input: number; output: number };
  /** 机检覆盖（v13-V1 tally）：n=tally 推得出的样本 run 数；runsAllPassed=机检全过且真有机检的 run 数 */
  machineCheck?: { n: number; items: number; verified: number; runsAllPassed: number };
  /**
   * 返工（v13-K2 打回回路）：该岗节点被否决回边打回的总条目数，按岗直接归因
   * （账落在被拒方节点上，不是 run 级合计）。
   * rejected=打回次数（含封顶那一次），capped=其中「上限已达、这次否决没人解决」的笔数
   * （这批单最后是被拒方 failed 收口的，所以 capped>0 的单 passRate 里必有红）。
   * 整键缺省=没有任何可支持样本：既可能是这岗零返工，也可能是它上的单全是 K2 前的旧单——
   * 两种读法在账上同形，所以不报 0 冒充「实测零返工」。
   */
  rework?: { rejected: number; capped: number };
}

/** 按 roleSha（v13-W2 岗位+装备指纹）分组的账：换装备=换指纹=换一行，回退在组间对比里可见 */
export interface RoleShaGroup extends RoleProfileMetrics {
  roleSha: string;
}

export interface RoleProfile {
  /** 该岗全期总账（所有样本 run，含没落 roleSha 的旧单） */
  overall: RoleProfileMetrics;
  /** roleSha 分组账：至少一单落了 roleSha 才出现；按样本数降序、同数控指纹升序（稳定可复算） */
  byRoleSha?: RoleShaGroup[];
}

/** 一集样本 run 连同其「属于该岗」的节点记录（聚合的最小现场） */
interface RoleSample {
  run: RunRecord;
  /** 该岗在该单里的节点记录（图里绑了岗且记录在册的；没跑到的节点不入此列） */
  nodeRecords: RunRecord['nodes'][string][];
}

/**
 * 挑出「上过该岗」的样本 run（纯读，防御旧盘上形状不齐的记录）：
 * 判据=图里存在一个节点，其节点记录 equip.role 命中该岗（W1 实绑优先），
 * 无 equip 落册（pre-W1 旧单/注入现场没走到）时回落 graph 名义 config.role。
 * 实绑优先的含义：图里写了 A 岗、注入现场实际吃的是 B 岗 → 只算 B 岗的账（实态>名义）。
 */
export function sampleRunsForRole(roleId: string, runs: readonly RunRecord[]): RoleSample[] {
  const out: RoleSample[] = [];
  for (const run of runs) {
    const graphNodes = Array.isArray(run?.graph?.nodes) ? run.graph.nodes : [];
    const nodeRecords: RoleSample['nodeRecords'] = [];
    let bound = false;
    for (const gn of graphNodes) {
      const rec = gn?.id ? run.nodes?.[gn.id] : undefined;
      const nominalRole = typeof gn?.config?.role === 'string' ? gn.config.role : undefined;
      // 实绑优先：equip 落了册只认注入现场的 equip.role；没落册（pre-W1 旧单）回落名义 config.role
      const hit = rec?.equip ? rec.equip.role === roleId : nominalRole === roleId;
      if (!hit) continue;
      bound = true;
      if (rec) nodeRecords.push(rec);
    }
    if (bound) out.push({ run, nodeRecords });
  }
  return out;
}

/** 对一集样本算能力账（可作用于总体或单个 roleSha 组，同判据同形状） */
export function computeRoleMetrics(samples: readonly RoleSample[]): RoleProfileMetrics {
  const m: RoleProfileMetrics = { runs: samples.length };
  let runN = 0;
  let runPassed = 0;
  let nodeN = 0;
  let nodeDone = 0;
  let nodeFailed = 0;
  let attN = 0;
  let waitMs = 0;
  const gates: RoleGateCounts = { approve: 0, reject: 0, input: 0 };
  let tokN = 0;
  let tokIn = 0;
  let tokOut = 0;
  let mcN = 0;
  let mcItems = 0;
  let mcVerified = 0;
  let mcAllPassedRuns = 0;
  let reworkRejected = 0;
  let reworkCapped = 0;

  for (const { run, nodeRecords } of samples) {
    const verdict = runVerdict(run.state);
    if (verdict !== 'none') {
      runN += 1;
      if (verdict === 'pass') runPassed += 1;
    }
    for (const rec of nodeRecords) {
      // 返工账与该岗节点记录直接对齐（K2 的账落在被拒方），不看 state：
      // 被打回后节点可能还在跑/被卡住，砍掉非终态就把「正在返工」这一类读数洗掉了。
      for (const rj of rec.rejections ?? []) {
        reworkRejected += 1;
        if (rj?.action === 'capped') reworkCapped += 1;
      }
      if (!NODE_TERMINAL.has(rec.state)) continue;
      nodeN += 1;
      if (rec.state === 'done') nodeDone += 1;
      else nodeFailed += 1;
    }
    // attention 只在整账形状可信时入账：waitMs 与三个门计数都得是有限数
    const att = run.attention;
    if (att && num(att.waitMs) && att.gates && num(att.gates.approve) && num(att.gates.reject) && num(att.gates.input)) {
      attN += 1;
      waitMs += att.waitMs;
      gates.approve += att.gates.approve;
      gates.reject += att.gates.reject;
      gates.input += att.gates.input;
    }
    // cost.tokens 为 null 是引擎明示的「拿不到」——排除分母，不计 0
    const tokens = run.cost?.tokens;
    if (tokens && num(tokens.input) && num(tokens.output)) {
      tokN += 1;
      tokIn += tokens.input;
      tokOut += tokens.output;
    }
    // machineCheckTally 对图账对不上/state 拿不到的单返回 null → 整单不进该机检分母
    const tally = machineCheckTally(run);
    if (tally) {
      mcN += 1;
      mcItems += tally.items;
      mcVerified += tally.verified;
      if (tally.allPassed) mcAllPassedRuns += 1;
    }
  }

  if (runN > 0) m.passRate = { n: runN, passed: runPassed };
  if (nodeN > 0) m.nodePassRate = { n: nodeN, done: nodeDone, failed: nodeFailed };
  if (attN > 0) m.attention = { n: attN, waitMs, gates };
  if (tokN > 0) m.tokens = { n: tokN, input: tokIn, output: tokOut };
  if (mcN > 0) m.machineCheck = { n: mcN, items: mcItems, verified: mcVerified, runsAllPassed: mcAllPassedRuns };
  // 没有 rework 分母可报：被打回零次的节点在账上就是「整键缺省」（与 K2 前的旧单同形），
  // 硬凑一个 n 只会是 rejected 的同义反复，读者要的分母是 runs / nodePassRate.n。
  if (reworkRejected > 0) m.rework = { rejected: reworkRejected, capped: reworkCapped };
  return m;
}

/**
 * 该岗能力账：总体 + 按 harness.roleSha 分组（v13-W2）。
 * 没落 roleSha 的样本只进 overall 不进气味组——宁缺毋假，绝不给旧单造一个假指纹键；
 * 所以「overall.runs ≥ Σ byRoleSha[i].runs」是口径事实，读端各自消化。
 */
export function buildRoleProfile(roleId: string, runs: readonly RunRecord[]): RoleProfile {
  const samples = sampleRunsForRole(roleId, runs);
  const bySha = new Map<string, RoleSample[]>();
  for (const s of samples) {
    const sha = s.run.harness?.roleSha;
    if (!str(sha)) continue;
    let group = bySha.get(sha);
    if (!group) bySha.set(sha, (group = []));
    group.push(s);
  }
  const profile: RoleProfile = { overall: computeRoleMetrics(samples) };
  if (bySha.size > 0) {
    profile.byRoleSha = [...bySha.entries()]
      .map(([roleSha, group]) => ({ roleSha, ...computeRoleMetrics(group) }))
      .sort((a, b) => b.runs - a.runs || a.roleSha.localeCompare(b.roleSha));
  }
  return profile;
}
