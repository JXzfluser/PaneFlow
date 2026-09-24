# iteration v13 需求（v0.5 草案，多 agent 评估一轮 + 十七路对抗验证对账 + 干活力考古一轮 + 闭环协同设计讨论三轮 + 交付约定移植一轮，待用户裁决）

日期：2026-09-24。前身：v12（四波全收口 + 追加波，见 v12 实施状态表；工程口径绿，实机口径欠账全推 C4）。
立论方式沿用 v10 裁决：**新需求只准挂两类账——无人值守可靠性、实证分母——不加外壳能力**；凡断言必带 file:line；绝不估算。
v0.1→v0.2 的来源与既往不同：本版由 **29-agent 多路评估**产题（7 路审计：引擎/API/前端/共享+CLI/迭代史/竞态/趋势；
3 lens 提 18 条候选；逐条对抗验证；完整性批判），18/18 条候选全部被验证轮修正（无一原样幸存，亦无一被推翻——
见「对账」节，这个分布本身就是本轮最该诚实记录的方法学读数）。
干活力支柱（W 系）另有来源：**用户驱动的第六轮代码考古**（问题：「接单没真正结合场景用角色，skill 为什么不在角色上配？」），
逐行论证见 `docs/workforce-roles-audit.md`；「效率」作为第三条账名目由该轮用户裁决直立（评审记录 R8）。
闭环协同支柱（K 系）来源：**用户驱动的第七～九轮设计讨论**（「从需求到上线的闭环、真正的多 agent 开发驾驶舱」→
纠偏「载体是角色，丰富角色间协调与扩展」→「方案/测试报告/上线准备等产物必须可跟可查」）；同轮的手机触达线经用户裁「先放下」入 Backlog（评审记录 R9）。
交付约定支柱（B 系）来源：**用户第十一轮追问**（「约定分支的拉起这类基本工程怎么没有？」+ 给出 `fix/issue-{issue}`/
`feature/v{version}-{issue}` 两副「交付约定」块样本），规范移植自本工作区姊妹工程 **pi-issue-harness**
（config/process/{default,lean,hotfix}.yaml：过程=数据文件、contract 驱动开分支、判定法则切引擎/宿主边界）。

## 评估总判（一句话给每路审计）

- **引擎/API 面**：主干（调度、并发闸、重试、fan-in、v12 五件套）真实落码且有测试锚定；但「敢隔夜」仍有四条恶性漏路——
  重启逃逸（agent 活着、单已判死、workspace 永不回收）、尝试边界双跑、审批门无限阻塞、账本非原子写且失败无声。
- **进程级存活**（批判轮补账）：server 全仓 `process.on` 零命中——一次未捕获 Promise 拒绝即当场死，
  死后 boot 又把全部在飞单一律改 failed 落盘；且无单实例守卫，**发行包上误敲一次子命令就是触发器**（见 E1）。
- **实证面**：v12 把账写端配齐了，读端三处塌——pass/total 100% 自报口径、A/B 等臂性仍靠仪式自律、收数表连成本列与
  行完整性都没有；且分表日期按 UTC 切、夜跑正落跨日窗（本机 +08）。
- **前端**：harness/sideEffects/attention/costLive/收数表在 UI 零呈现（实测发行包产物六关键字命中全 0）——但按 v12
  「零新视图」纪律这属体验账，本版**只入册不认领**（进「明确不做」+Backlog）。
- **竞态**：「真实进程硬隔离并行」主张已被一整条赛道占住（Orca/Gas Town/Agent Orchestrator 等）；还站得住的差异收窄为
  「确定性 DAG + 真实进程 + 副作用/人介入/token 全落册的收数」——外部账从「领先叙事」转为「可第三方复算口径」。
- **采用侧反证**：v0.2.0 两资产合计下载 3 次——「不跟就掉队」的判断全部建立在行业叙事上，本仓自己的采用分母 ≈ 0。
- **干活力面**（用户驱动第六轮考古，非工作流产物）：角色是五字段「名牌」不是「岗位」——装备（技能/规则/模型）三通道全绕开
  角色轴，技能全文×全节点注入本身反效率，账本无角色维度，权限只活在 prePrompt 话术里。故本版立 P3（W 系），「效率」
  经用户裁决直立即第三条账名目。
- **闭环面**（用户驱动第七～九轮讨论，非工作流产物）：需求→实现→上线闭环的**载体是角色**，而角色链现状四断——
  产物只是 worktree 里的 artifact.json+路径数组（文档不落盘不哈希，worktree 回收即蒸发，engine.ts:2462-2499）；
  `{{nodeId.field}}` 引用未解析**字面放行**（dag.ts:696-698，假绿）且 fan-in 只喂摘要（N1）；否决没有回边语义，
  质检岗有装备无话语权；终态停在 completed 无交付册。故本版立 P4（K 系），同挂「效率」第三条账名下。
- **交付约定面**（用户第十一轮追问 + pi-issue-harness 规范移植）：「分支从哪拉、叫什么、PR 去哪、门禁几道、驳回怎么走」
  这类每项目的工程家规**全部写死或死件**——分支名写死 `paneflow/{runId}-{nodeId}`（engine.ts:2315）、基点=仓库当前 HEAD
  （engine.ts:2323 不指定起点：主仓停在 feature 分支则新单静默继承未合并提交，污染账）；`RunContract.repo/branch` 系
  **server 零消费的死字段**（dag.ts:229-230 定义、全仓 grep 无消费点）；`prUrl` 无产生方（dag.ts:415/463）；
  worktree 根钉 `os.tmpdir()`（脏目录证据链归 Windows 存储感知扫荡）；分支只增不减（engine.ts:2317 自认「回收只删目录不删分支」）。
  故本版立 P5（B 系）。

## 外部思想输入（2026-09 侦察小结；**全部未亲验原文，只作背景不承重**）

1. harness 披露立论成文（arXiv 2605.23950《Stop Comparing … Without Disclosing the Harness》，**编号未经直取核实**），
   且出现以 harness 为受测变量的基准（Claw-SWE-Bench，分差 15–27pp 系二手转述，**入账不引数字**）。
2. 「验证成本经济学」正题化（arXiv 2609.04681，v12 已引）：成本治理公开形态停在网关/账号粒度，
   **per-run token 熔断未见业界同类**——v12-S2 是领先项，但领先要对外复算才有牙齿（V3 收数表成本列）。
3. 「人机协作税」无可机检标准指标，attention{waitMs,gates} 在公开检索中无对应物——差异主张位，继续做实。
4. 自改进飞轮 2026 结论=「**有条件成立**」（字节 Seed 三基准泼冷水 vs PILOT/ReasoningBank 正面证据），
   条件正是 harness 固定 + 分母可信——**反向支持本版「先修夜跑保险丝，再开 C4」的顺序**。
5. AGENTS.md 跨厂商标准化（OpenAI 牵头、Claude Code 宣布兼容，时点 2026-09-19/20 报道集中）：目标仓 AGENTS.md
   经 rules/convention 注入实发 prompt（roles.ts:88-110 → engine.ts:2296-2298 → engine.ts:1542-1546）却零留痕——V4 立账。

## 对账（v0.2 核心轮：18 候选逐条验真，处置并入正文）

| 候选 | 审计结论（验证 agent 亲核 file:line） | 处置 |
|---|---|---|
| 重启对账·孤儿闭环（R13-S1∪P13-6） | 缺口属实，但「boot 复活续跑」撞「不重建 durable execution」红线（v12:120）；killAgent **是造协议面**（protocol-reference.json 17 动词全集无 kill）；孤儿认领按 workspaceId 轴修不掉 engine.ts:1456 覆盖漏网，须换 **label 反解 runId 轴**；终态收口前还有 readOutput 攒快照窗，周期扫描须 in-flight 保护 | **S1**：只做「标记 + 同事务回收」，恢复走既有 ⤴/`--from-failed` 两通道；D4 转正并入，不再等实机复现（漏网形态已定位）；worktree 泄漏（v5-audit:97）同片顺手结 |
| 尝试边界掐断（R13-S2/P13-6③） | 「重试不掐旧 agent」属实（engine.ts:2428→1447 直接另起）；掐断序列只在 stopRun（engine.ts:855-866）；「在飞节点烧穿预算」一半是**无证据源**（costLive 只在落册时刻写，engine.ts:2498）——按「绝不估算」不该扩 | **S2**：抽 `interruptAttemptAgent` 零新接口；reconcile 判据改 `not_found` 错误码二分（非两轮 null）；closePane 属 v11-D4「待实机复现」**不抢跑，留门控位**；预算扩在飞整腿删 |
| 仓库软锁竞态（R13-S3） | 竞态属实（engine.ts:1427-1434 退出循环后无复核直接 set），但**不需要 CAS**：JS 单线程下判定与写入同 tick 天然原子，根因是谓词比错对象（比 `holder.runId` 而非「有无 holder」）；「锁泄漏」说法有误（no-op 释放行为正确），真后果是三活空窗 | **S3**：一行谓词修正 + 红线注释（退出与 set 间禁 await）+ 双等待者测试走 fake `maxConcurrent` 探针（不读私有 repoClaims） |
| 门超时+外解唤醒（R13-S4∪P13-4） | 七处门全裸 Promise 属实（engine.ts:1558/1614/1722/1839/1901/2013/2204 逐一命中）；但「全仓无 notifier」**错**——channels.ts:10-24 + http.ts:1837-1869 已推「⛔ 等待审批」，真账是「页了仍无人来」；「合成 reject 唤醒」会污染人工话术与 attention 账 | **S4**：抽单一 `awaitGate()` 三态返回；到期 fail-closed 收 failed、**不入 attention**（守 engine.ts:852-854 红线）；外解唤醒严禁 sendKeys、单记 `externalRelease` 计数；`onGateTimeout` 旋钮删（hold=现状，不留双自由度）；blockedAt 已是现成时钟，不新造计时起点 |
| saveRun 原子化（R13-S5） | 非原子+静默吞属实（store.ts:291-301/316-321，engine.ts:2611-2616）；但因果写反：SIGKILL 不截断（内核刷盘），真路径是 **ENOSPC 短写**（先 O_TRUNC）；「未 push 交付无痕湮灭」高估，实测口径=记录消失+workspace 被关+脏树挡重派 | **S5**：tmp+fsync+rename；`corruptRuns` 扫描失败回 null 不回 `[]`（[] 是正断言）；unarchive（store.ts:278）与 boot 第二 catch（engine.ts:185）一并入同 helper；失败计数挂 health `persistFailures`（别写进正在失败的账本） |
| 校验器 fail-closed（批判轮补账） | node.type / checks[].type **均不查值**，未知类型恒真放行（dag.ts:596-653 无值域判定）；agentKind 只过正则；fanout 无 maxItems | **V0**（最便宜的假绿账，小片）：两处白名单 + 一处上限；未知即校验失败，宁拒不错放 |
| 机检落册 checksLedger（V13-1） | 「机检成功零落册」属实，但 checksLedger 大片方案被裁：**落册只从上线日计数，历史 run 永远缺账**；纯读端推导（graph 里 checks × 节点 state）今天即有分母 | **V1** 缩为读端 `machineCheckTally`；如实定性「把 100% 自报改为机检/自报双口径，让『没有机检』第一次可见」——**不称 V3 解冻基建**（C4 模板机检数=0，解冻须先在 C4 路径装真机检，那是 V3 本体、门控不变） |
| 断言覆盖率（V13-2） | 「最便宜假绿通道」夸大：0/6 全不报已被 v11-C2 fail-closed 挡（wiki.ts:115-124+测试锁）；求差口径沉淀页已有（wiki.ts:264 分母=契约），缺的是收数表与绿门文案没吃到；wiki.ts:264 **现存 >100% bug**（pass 未与契约取交） | **V1 并片**：`assertionDiff` 落 shared（邻 failedAssertionsOf），pass 取交集，折进既有单元格 `2/6（缺 AC-4、AC-5）`，不加新列、不落新字段（读时算先例 http.ts:1467） |
| A/B 等臂机检（V13-3） | 「off 臂与 on-但-无页塌成同一缺键」属实（engine.ts:705-737 五出口无区分）；但 `vs=` 比对端点+文本启发式被判表面膨胀；graphSha 被注入块改写故两臂 sha 必不同、无法证「只差读回块」；**verifier 新挖出更脏事实：replay 路二次追加读回块，off 臂带旧块**（engine.ts:768-771 自认）→ replay 取臂下「两臂只差 readback」根本不成立 | **V2**：harness 增 `readback`（扫 graph 实态、非现读 env）+`readbackOutcome`（五+1 态含 `inherited`）+ `skeletonSha`（剥注入块、归一 run_id/draft_dir 后的 contentSha，复用 harness.ts:15-32）；等臂判据=skeletonSha 相等 ∧ readback 不等；**C4 取臂改判：双臂 fresh dispatch（各 ≥3 run），replay 只作同臂补分母** |
| 收数表可信度（V13-4∪P13-5） | appendExperimentRow 全吞（experiment.ts:51-70）属实且最硬；CLI「N 行」含表头是**现成的谎报**（main.ts:303）；`summary` 统计端点（中位数/n）判违 v11 裁决「无统计检验」删；token 列零新字段可加（engine.ts:979 cost 先于 :988 收数）；「旧行画 '-'」做不到（append-only md 表头只写一次），改「新行起生效」 | **V3**：行数修真 + append 三态返回 + `?reconcile=1`（expected 取盘上记录并显式归档口径）+ token in/out 列（`run.cost.tokens`，null 画 '-'）+ **口径戳随表头落盘**（state/token/pass 口径指名源）+ **日切口径声明**（experiment.ts:56 现按 UTC slice，夜跑 +08 必跨日拆表——本片定死并落戳）；verifiedBy 列撤（属 V3-断言门控位） |
| 沉淀降权+引用列（V13-5） | agent 注入路 weightOf 未传降权属实（engine.ts:721），但「C2 降权空挂」说重了：置信身份已逐行透传入册（readback.ts:214/225）；联表端点被裁——**收数表加一列「引用沉淀 N 页」即可按 arm 分组读出**，零新路由 | **V5**：①降权接线（LOW_CONFIDENCE_PENALTY 单源）字面片即做；②引用列**门控在 C4 出料后**（分母=0 时列无读者） |
| harness 披露扩充（P13-3） | retryPolicy 入 sha 是 graphSha 子集、比对面恒等，删；checksEnv 两臂同机非混淆因子、归 E2，删；「AGENTS.md 零消费」说反了（roles.ts 消费链完整）——真账是**运行时注入不留痕**，与 WikiReadbackTrace 不对称 | **V4**：单键 `ctxSha` = contentSha{resolveContext 实读文件集 + gwThrottleRetries + nodeTimeoutMsDefault}，**在注入现场取、不在起单时取**；只披露不拦（守评审 R5）；诚实边界入文：agent CLI 在 cwd 自读的那份 AGENTS.md 不可考，ctxSha 只证 PaneFlow 注入面 |
| 发行 launcher 漂移（R13-S6∪V13-6∪P13-1，三条重复进池） | 漂移属实且**批判轮实测 v0.2.0 真包证实已上架**（bin/paneflow.mjs 路由 5 枚）；但「永不退出常驻」症状说反——端口占用时 listen 失败退 1；**最重后果三条全漏：误起第二实例在构造期就把在飞单改判 failed 写盘**（engine.ts:160-190 早于 :43 listen）；「C4 发行渠道走不通」夸大（本仓 tsx 路绕开） | **E1**：采「漂移不可能」案——launcher 判据改「无首参或 `serve` 才起 server，其余一律进薄壳」（结构上消灭第二份清单，顺带结 `--help` 同类雷）；release.yml 打包后冒烟步（断言输出+精确退码，防「非零即绿」假验）；install.sh 三修（mktemp trap 泄漏、校验和 digest、herdr 前置检查）+ 产物补 LICENSE（实测 v0.2.0 包内无许可文本，根 package.json 无 license 字段——v6 OSS 账正身） |
| Windows 支持面（P13-2） | 「整台装不上」**被实测推翻**：win32 已在跑（本机 18 run 记录；批判轮复核 completed=8/failed=10——verifier 报 10 口径写反），缺的是默认路径与无 sh 上下文；C4 污染说法撤（C4 两副模板 checks 为空）；**真账升级：探测恒空时 index.ts:60 回落 `'claude'`，gate0:13 记 claude 开箱即挂 → 无人值守首节点必红** | **E2**：本波**改判 v6 裁决**（v6-oss-landing:300「不做 Windows 原生适配」→ 实跑证据在手，改判须用户点头）：probeBinary win32 分支（PATH×PATHEXT，v6:248 方案已沉淀）+ claude 回落改 fail-closed + health 加 `platform`/`herdrError`（撤 named-pipe kind 判别——实测探不出，猜名=估算）+ APPDATA 默认候选 + smoke.ts:15 同修 + README/install.sh 支持矩阵（原生 cmd/PowerShell **未验证如实标**）+ fs-routes `os.homedir()` |
| 进程级存活（批判轮补账） | 全仓 `process.on` 零命中；26 处 fire-and-forget void；无 SIGTERM 处置（退出不掐 agent 不 flush 账本，叠加 S5 非原子写=双病）；**无 dataDir 独占锁**，双实例互踩账且发行包一次误敲即触发 | **S6**：unhandledRejection/uncaughtException 兜底（落日志、不假装恢复）+ SIGTERM/SIGINT 优雅停机（掐 agent→关 workspace→flush 账本，复用 S1/S2 的处置函数）+ **启动 pidfile/锁守卫**（同 dataDir 第二实例拒起——E1 修的是误敲诱因，S6 修的是踩账本体）；服务化（systemd/pm2/launchd）只写文档不自造壳 |
| 安全面（api 审计 5 条高危，批判轮判「静态属实、可达未证」） | `/api/graphs/:id` 拼路径待穿、/ws 连接即全量回放、health 令牌豁免回显绝对路径与 agent 清单、启动令牌打印 stdout（夜跑必进日志） | **S7（门控位·实探片）**：一次实机可达性探测（穿越构造真打一次本地 server）再定改判——gate0 规矩：只认实机，静态推断不占需求名额 |

**18/18 全 partial、0 holds、0 refuted 的分布如实入册**：说明对抗轮「收缩/修正」功能有效（每条都被抓到至少一处错），
但「推翻」环节事实上没发生——凡评估结论想当事实用的下一轮，须补一次真执行模态（跑 build-release、真重启观察），
本轮所有「运行期症状」均为读码推演，已在各片标注待实机点。

## 目标（v13 一句话）

**从「账落册了」走到「这台服务本身敢隔夜、收出来的每一行经得起复算」**：死得起（进程兜底+优雅停机+重启回收闭环）、
不双跑（掐断/锁谓词/门到期三路堵死）、账本自身可信（原子写+损坏可见+收数表自含成本与口径戳）、
等臂与断言双口径机器可证——然后按这个底子开 C4 三夜，把 v10 以来欠的实证分母真正结掉。
**同时让「编排=效率」第一次名副其实**：装备随角色走、上岗有指纹、账本有岗位轴（P3/W 系）——绑角色不再是安慰剂；
再进一步，让角色之间**有货可交、有话可驳、有册可查**（P4/K 系）——需求到上线的闭环由角色产物链钉合。

## 支柱与需求

### P0 可靠性支柱（S 系，「夜跑四漏 + 进程与账本自身」）

- **S1 重启对账与孤儿闭环（D4 转正）**：boot 标记 + 同事务回收；owned 改 label 反解 runId 轴、仅活跃认领；
  周期清扫（`PF_ORPHAN_SWEEP_MS` 缺省 300s，`<=0` 关，照 config.ts:74 形状）+ in-flight/收口窗双保护 + 处置幂等互斥；
  worktree 顺手账。回收失败明说失败，`recoverOrphans` catch 的「下一次扫描」假话注释要么兑现要么删。
- **S2 尝试边界掐断**：`interruptAttemptAgent` 零新接口抽共用；三触发点钉死（waitForSettle 超时/进重试/stopRun）；
  reconcile 认 `not_found` 错误码二分（传输错不判，宁缺毋假）；掐断事实结构化落 `rec.abandonments`（不靠环形事件）。
- **S3 仓库软锁谓词修正**：一行改判 + 红线注释 + 双等待者 `maxConcurrent` 断言；顺带清「拿到锁后 rec.error 残留」陈缺。
- **S4 门到期 fail-closed + 外解唤醒**：`awaitGate()` 收编七门；run 级 `gateTimeoutMs` + `PF_GATE_TIMEOUT_MS`
  （契约优先/env 兜底/0=关，照 resolveTokenCap 口径）；到期收 failed、error 固定句式、不入 attention；
  外解唤醒严禁 sendKeys、单记 externalRelease；误判自动放行加红线测试。
- **S5 账本原子写与失败可见**：tmp+fsync+rename 单 helper（saveRun/unarchive/boot 三路共用）；
  health 增 `corruptRuns`/`persistFailures`（拿不到=null 不回 `[]`，按空间聚合带 spaceId）；stale tmp 计入损坏信号。
- **S6 进程级存活与单实例**：兜底 handler 落日志、SIGTERM 优雅停机走 S1/S2 处置函数、dataDir 独占锁
  （第二实例起即拒，错误指路）；服务化文档一小节。
- **S7 安全面实探（门控位）**：graphs 路径穿越/ws 鉴权/health 回显/令牌 stdout 四题一次实机可达性测试，据结果下波立案。

### P1 实证支柱（V 系，「每一行可复算」）

- **V0 校验器 fail-closed**（最便宜假绿）：node.type / checks[].type 白名单 + fanout maxItems 上限，未知即拒。
- **V1 机检/自报双口径 + 断言覆盖**：读端 `machineCheckTally`（done⇒机检全过，state 拿不到整键省略）；
  `assertionDiff` 入 shared、pass 取契约交集（顺手修 wiki.ts:264 现存 >100% bug）、覆盖读数折进既有单元格；
  绿门只补文案不改判据（判据改属 v11-C2 语义变更另裁）。
- **V2 等臂机检**：harness 增 `readback`/`readbackOutcome`（含 inherited 态，扫 graph 实态得出）+ `skeletonSha`
  （剥读回块/I2 块、归一 run_id/draft_dir）；收数表 harness 列与 CLI status 追加；
  **C4 取臂规程改写**（fresh dispatch 双臂、replay 限同臂）写入 v11 前置清单勘误。
- **V3 收数表自含可信**：行数去表头谎报、append 三态、`?reconcile=1`、token in/out 列（`run.cost.tokens`，null 画 '-'）、
  口径戳（含日切口径，UTC vs 本地 +08 跨日切窗定死随表头落盘）、版本号单点常量。
- **V4 ctxSha 注入留痕**：注入现场取 contentSha{实读文件集 + env 级两旋钮}；入比对面（只披露不拦）；
  诚实边界注释（pane cwd 自读面不可考）。
- **V5 沉淀账**：①注入路降权接 weightOf（字面片）；②收数表「引用沉淀 N 页」列——**门控在 C4 出料后**。
- **V3-断言溯源（旧 V3）维持门控**：解冻前置改准为「C4 路径上先存在可机检断言执行」——V0/V1 铺的就是这一步的可见性。

### P2 入口与发行支柱（E 系，避与 v12 T1 撞号）

- **E1 发行链收口**：launcher CLI 优先窄判据（删手写路由表）+ release.yml 打包后冒烟（精确退码+输出断言）+
  install.sh 三修（trap 泄漏/校验和 digest/herdr 前置检查）+ 产物 LICENSE + 根 package.json license 字段。
- **E2 Windows 诚实入账（须用户改判 v6 裁决）**：probeBinary win32 分支 + **claude 回落改 fail-closed**（首节点必红账）
  + health 两标量 + APPDATA 默认候选 + smoke.ts 同修 + 支持矩阵（未验证面如实标）+ `os.homedir()`。

### P3 干活力支柱（W 系，「让角色从名牌变岗位」；逐行论证见 `workforce-roles-audit.md`）

诊断基线：`Role` 只有 `{id,name,agentKind,prePrompt,env}`（roles.ts:7-14），引擎对它**仅三条消费路**（前缀/默认 CLI/env，
engine.ts:2286-2287/2234-2235/1444-1445）；技能与规则走**空间轴/目录轴**绕开角色（skills.ts:25-48 把 ≤20 文件全文注进
每个 agent 节点，rules.ts matchRules 只按工作目录）；模型钉在空间级（engine.ts:2262-2266）；内置模板只有 planner 节点绑 role
（api/dispatch.ts:234-240）。后果：**绑不绑角色边际效应≈0，「结合场景用角色」结构上不可能**。

- **W1 角色装备槽与三轴划界**（中片，效率账）：装备三轴各司其职——**空间级只留事实与家规**（rootCwd/repos/网关/并发 +
  无作用域 rules/conventionFiles 这条「人人必守」面 + skills **登记清单**）；**目录轴**留 repo/pathsGlob 空间性规则（M3 已有，不动）；
  **角色级**新增岗位装备：`Role.skills?`（引用语义，从空间登记清单里选）、`Role.rules?`（评审清单类岗位文档，注入=matchRules ∪ 角色 rules 去重）。
  **语义迁移点：`profile.skills` 从「注入清单」降级为「登记清单」，注入决定权上移角色槽**（改写 engine.ts:2300-2302 消费点）；
  兼容带：角色未配槽=空间全量现状，但 status 渲染一行「该角色未配装备，正吃空间全量」（可见是收口前提，不强迁）。
  G1 直接记账：20 技能登记、每岗挂 2–3 个 → 每节点 prompt 减重一个数量级；字段全 optional、不 bump 任何 schema version。
- **W2 角色指纹与上岗**（小片，实证分母账·岗位轴）：harness 增 `roleSha`（角色+装备解析内容指纹，复用 harness.ts contentSha）
  + `injectedBytes`；DAG 校验对「有班底 run」的节点 role ∈ 名册给**警告**（不硬拦，护存量模板）。
  **上岗的另一半是让名册会说话**：planner 名册块（api/dispatch.ts:260-266）从「只有名字」升级为「名字+装备索引」
  （readSkillIndex 按角色分列，skills.ts:51-77 现成通道）——规划手第一次能**按装备结合场景点人**，「接单不用角色」的死结解在这。
  roleSha 使「换装备=换指纹」，V2 等臂机制（skeletonSha 相等 ∧ 受测变量不等）直接外延到岗位级 A/B——C4 方法论零新机制复用。
- **W3 授权声明+归因+事拦**（中片，可靠性账·S1a 同族）：`Role.declares?` 三面声明（gitPush/writeScope/…），**PaneFlow 不造沙箱**
  （17 动词协议面无切钩子，能力锁归 agent CLI）。只做三事：①声明注入 prompt 且措辞诚实（「声明非强制」）；②副作用账按 roleSha 归因；
  ③收口对账：声明与实态落差（如 declare gitPush=false 却现 pushedAt）标 `declareViolation` 入 events，**只照不拦**。
  「跑中掐」（事拦真执行）判为 durable-execution 变体——**不做**。
- **W4 角色能力账**（小片，实证分母读端）：`GET /api/roles/:id/profile` 纯读时算聚合（按 roleSha 分组通过率/返工/attention/token/
  机检覆盖，全从既有落册字段，零新写端；先例 V1 machineCheckTally + http.ts:1467）。本版**唯一新增端点、且是纯读**。
- **W5 装备物化（门控位）**：把角色 skills 反写 agent 原生形态（.claude/skills / AGENTS.md 片段 / .mcp.json）——涉跨 CLI 格式矩阵
  与写用户目录，**先在 1–2 个 CLI 实机验证被认，否则不开闸**。边界声明：PaneFlow 是供给侧搬运工，不是 agent 运行时配置的拥有者。

### P4 协同与产物支柱（K 系，「让角色成群结队、让产物有册可查」；同挂「效率」第三条账名下）

诊断基线（亲核读码，纠一处讨论期误判）：产物交接**通道已存在**——`withArtifactConvention` 让 agent 自写
`artifact.json`（summary/files[]/errors，engine.ts:2462-2471），读不到才落扫屏尾 5 行兜底（engine.ts:2489）；
真账不是「没有通道」而是**通道太轻**：files 只是活在工作区/worktree 里的路径数组，文档本体不落盘、不哈希、不持久，
worktree 回收即蒸发。其余三断：`{{nodeId.field}}` 未解析字面输出（dag.ts:696-698，假绿）+ fan-in 只喂摘要（N1）；
图上只有前向边，评审「打回」无回边语义无账；终态 completed 即止，无需求上游、无交付下游——本仓自己的开发仪式
（需求文档→对抗验证→切片→收数）恰是这三样缺件的手动版。闭环不另建账本体系：**闭环 = 角色产物链闭合**。

- **K1 产物台账与硬引用**（中小片·本支柱最便宜起手）：`artifact.json` 契约升级为命名产物清单 `{name,kind,sha,bytes}`——
  kind 两值：`diff`（代码改动，git 自动采零约定）、`doc`（方案设计/测试报告/上线准备等整篇文档，约定写盘、prompt 措辞与
  artifact.json 交接同款）。收口把 doc **复制进 dataDir 产物架**原子落盘（与 S5 共用 tmp+fsync+rename helper），
  sha 复用 contentSha 先例（harness.ts:15-32）——下游引用自此可证「审的就是这份」（V2 等臂同精神）；产物架要有字节上限
  与超限 fail 规则（N6 无上限账同片治理）。`{{artifact:nodeId/name}}` 为硬引用：**解析不到=校验失败**（顺手结
  dag.ts:696-698 现存假绿，宁拒不错放= V0 同款姿态）；fan-in 消费面从摘要升级为命名产物清单（结 N1）。
  读端走既有架通道（shelf 先例 http.ts:1618-1621 扩到 dataDir 架，且该账「只扫 run.cwd」正该由本片结掉）。
- **K2 打回回路**（中片·须回边语义点头，裁决问题 9）：图允许**指向已完成节点的否决回边**（reviewer→builder），
  否决理由作为重跑 attempt 的附加上下文（复用「重试带上下文」现路）；每次打回落 `rejections` 结构化账
  （复用 abandonments 形状，不靠环形事件），reworkN 在 W4 角色账里已有读者。**人也是编制内的岗**：审批门/⛔ 通知/
  attention{waitMs} 已是「人岗」的协调原语，不新造，只在渲染上把人画进排班。协调**只有三原语**：类型化移交（K1）、
  回边（K2）、门（已有）——agent 之间开自由对话即 cost/attention/机检三分母当场作废，红线。
- **K3 上下游岗位入编**（大片·整体后置 v14 头，裁决问题 10）：需求单（`{id,goal,契约 AC-*}`——形状直接复用
  assertion 机制不另造 DSL；V1 assertionDiff 分母从 wiki 契约换成需求契约）与交付册（人执行 merge/发布后
  纯落账动词 `deliver`，**不代跑 git push**——同 S6 对 systemd 的「操作系统的事」口径）都作为**普通角色的产物**落地
  （需求澄清岗/发布岗）。排班表六站现状：需求澄清 ✗（仓外手写）/架构拆单 ✗（planner 只点人不画图，dispatch.ts:234-240）/
  执行 ✓/质检 ✗（有装备无回边）/发布 ✗（停在 completed）/复盘 ~（wiki 沉淀有人格化缺）——**四站缺的是编制不是引擎**。
  收数表加 requirementId 列后，「编排=效率」第一次有需求粒度分母（时延/token/人介入三本账全已落，只缺 join key）。
- **K4 驾驶舱=账本读端（不认领，只定性）**：驾驶舱回答且只回答三问——在飞什么（run×需求分组）/卡在哪（gates+attention
  聚合收件箱）/成不成（契约双口径+交付态）。数据源零新增，全在既有账+K1 架；本波读端**只到 CLI/curl**，
  前端呈现与「夜跑复盘 UI」同格 Backlog——驾驶舱不是新造出来的屏，是账本可信之后的兑付。

产物即铆钉（K1/K2/K3 的交汇图）：需求单→全链验收基准；方案设计→执行角色移交物；测试报告→打回否决的依据；
上线准备 doc+脚本→交付册前置（脚本 `run` 型 check rehearsal 一步**门控**，checks[].type 白名单 V0 已铺）；
交付册→回写需求单闭环成形。

### P5 交付约定支柱（B 系，「分支不写死——按项目的家规拉起」；形状移植自 pi-issue-harness）

诊断基线（评估总判「交付约定面」条，全带 file:line）：交付约定五要素——**拉出基点 / 分支命名 / PR 目标 / 门禁 / 驳回流程**——
现状要么写死要么死件。样本即用户给的两副：bug 单「从 main 拉 `fix/issue-{issue}`，PR→main，三道人闸，驳回开 Bug 链回主 Issue」；
feature 单「从 main 拉 `feature/v{version}-{issue}`，PR→release/v{version}」。这不是配置匮乏，是**引擎该执行的家规没接线**。

- **B1 交付约定块入空间**（小片，可靠性账）：SpaceProfile 新增 optional `delivery?: DeliveryRule[]`，
  条目形状对齐 rules 的挂载点先例（`{repo?, branchFrom, branchName, prTarget, gates?, note?}`，store.ts:15-16 同款
  repo 匹配语义）——按仓匹配（一仓一副），字段全 optional 不 bump schema（W 系同款卫生）。占位符 `{issue}` 取
  `RunRecord.issueId`（dag.ts:386 已有）、`{version}` 取起单 template variables（applyTemplateVariables 通道现成，
  dag.ts:711）。配置页加一行 delivery（配置文件管理、无编辑器，与 rules/skills 登记同款 UX）。
- **B2 三层消费**（中片·本支柱正身）：①**机检层**——`createWorktree` 改约定驱动：基点=`branchFrom` 显式指定，缺省探
  `origin/HEAD`，两头拿不到**拒绝拉起收 failed**（宁缺毋假绿，V0 姿态；现状 engine.ts:2323 从 HEAD 静默继承 = 污染账）；
  分支名按 `branchName` 模板渲染，占位符解析不到=起单校验失败（严禁静默回退 runId，dag.ts:696-698 假绿同款教训）；
  `contract.repo/branch` 死字段点亮为 per-run 覆盖口（契约优先于空间，pi-issue-harness「按 contract 开分支」正身）。
  ②**注入层**——渲染后的交付约定块进 resolveContext 约定通道（engine.ts:2289 现场），agent 每次提交/开 PR 看得见家规
  （「注入每步上下文」的样本原话）。③**对账层**——收口核对实态（分支名匹配/基点祖先链/push 目标分支）与约定落差
  标 `deliveryViolation` 入 events，**只照不拦**（W3 同族；PR 目标硬拦在人闸位，那是人的事）。
- **B3 分支与目录生命周期**（小片，结 N3 账）：reclaim 成功→`git branch -d` 入账（engine.ts:2317 注释自认「只删目录
  不删分支」的分支半笔）；脏保留→分支与 worktree 路径进 events 可见（不再只有一行 console.warn）；worktree 根默认迁
  `<dataDir>/worktrees`（`delivery.worktreeRoot` 可覆）——证据链搬出 OS 扫荡区。
- **B4 prTarget 激活**（字面小片）：prTarget 进注入块并预填 K3 交付册——`prUrl` 字段（dag.ts:415/463）自此有产生方。
  **PaneFlow 不代跑 push/建 PR**（S6 同款「操作系统的事」口径），约定只声明+机检+对账。
- **与 K3 的分工**：`gates`（对齐先行/PR 前人闸/关单前人闸）与「驳回流程」今天可由既有件表达大半——approval 节点=人闸、
  K2 回边=驳回；B 系补的是**约定声明位**（哪几道、叫什么），执行件不新造。多种过程方式（standard/lean/hotfix）
  =「graph 模板 × delivery 条目」的组合命名，**不新增模板类型**（防表面膨胀；判定法则照抄姊妹仓：换团队不需要的东西
  不进引擎包，约定住宿主空间配置）。

### P0 还账支柱（不变，排序更新）

- **C4 三夜**：技术前置历版俱备，本版新增三条**硬前置**——E1（收数命令发行形态可用）、S1/S6（夜里不留幽灵 agent、
  不死得无声）、V2（等臂从仪式改机器证，取臂规程已改 fresh dispatch）。**建议第一批片落完再开跑**；选题 #8/#9/#10 不变。

## 可感面：v13 落到 CLI 是什么样（命令可原样执行）

原则沿用 v12：**不新造子命令**；每条需求验收必带「AGENTS.md 输出面同步」对勾。

- `paneflow status <runId>`：机检行 `机检: 3/3 过 · 自报 ok 6`（无机检整行不显）；harness 行追加
  `skeletonSha=… · readback=off(injected)`；节点行「上次尝试已掐断（超时/消失）」（rec.abandonments 渲染）。
- `paneflow watch`：退出码表**不变**；S4 到期收 failed → 照按红（1）；S1 回收失败、S6 第二实例拒绝各一句 error。
- `paneflow experiments --suite c4`：行数不再含表头；行内多出 token 两列、覆盖单元格 `2/6（缺 AC-4、AC-5）`、
  引用沉淀列（V5② 门控位）、文件头第二行口径戳。
- curl 面：`GET /api/health` 多 `platform / herdrError / corruptRuns / persistFailures` 四键；
  `GET /api/experiments?suite=c4&reconcile=1` → `{expectedN, loggedM, missingRunIds}`；
  `GET /api/runs/:id` 的 graph/state 即 V1 复算全料（**无新端点、无 vs=、无 summary——三条都被对账轮裁死**；
  本版唯一新增端点是 W4 的纯读 `GET /api/roles/:id/profile`）；
  `GET /api/roles/:id/profile` → `{roleSha, runs, passRate, reworkN, attentionMs, tokenTotal, machineCheckTally}`（缺项 null 不估算）。
- **W 系面**：`paneflow status` 的 harness 行追加 `roleSha=… · injected=12.3KB`；编排预告的名册行从「名字」升级为
  `名字（装备：skillA、skillB）`；配置了角色装备后，同一节点注入块从「空间全量技能」缩到「岗位装备集」——**token 账肉眼可降
  （costLive 同列对比）**；未配槽角色一行警告 `该角色未配装备，正吃空间全量`；声明-实态落差行
  `⚠ 声明禁 push 但检出 pushedAt（只标不拦）`（declareViolation 渲染）；无新子命令、无新视图。
- env 面：`PF_ORPHAN_SWEEP_MS`（缺省 300000，<=0 关）、`PF_GATE_TIMEOUT_MS`（缺省 0=不限）。
- **K 系面**：`paneflow status <runId>` 节点行追加产物行 `产物: plan.md(a1b2c3·4.2KB) · test-report.md(d4e5f6·1.1KB)`
  与打回行 `↩ 被 reviewer 打回×1（理由摘要，见 rejections 账）`；图校验新增拒绝类「`{{artifact:x/y}}` 解析不到」
  （结假绿非造新绿）；`GET /api/runs/:id` 的 `artifacts[]` 升为台账全料（name/kind/sha/bytes），原文走既有架通道读——
  **无新子命令、无新视图**；K3 未入编前，需求单/交付册无任何 UI 位。
- **B 系面**：`paneflow status` 节点 worktree 行改渲染约定实态 `分支 fix/issue-123（基点 main ✓ · PR→main）`，
  落差行 `⚠ deliveryViolation：分支基点非约定 main（只标不拦）`；起单校验新增拒绝类「branchName 占位符 {issue} 无法解析」
  （issueId 缺失即拒，不静默回退）；配置页 delivery 一行（文件管理 UX）；`GET /api/runs/:id` 的 worktree.branch 即 B2
  机检料——**无新子命令、无新端点**。
- E1 验收（发行包原样跑）：server 未起时 `paneflow experiments --json`、`paneflow --help` 均快速退 1 且不留监听进程、
  dataDir 无写入；`node scripts/build-release.mjs` 出包后 CI 冒烟步骤同断言。

## 批次建议

- **第一批（C4 开跑前·保险丝与口径）**：S1 → S6 → S3 → V0 → V2 → E1。全是「补执行点/合流/改判据」量级（S1 中片、余小片），
  且每一条都是 C4 数据可信度的直接前提。
- 第二批：S2、S4、S5、V1、V3、V4、E2（E2 以用户改判点头为开工条件）；W1、W2（小中片，且是 C4 之后「岗位级 A/B」
  的前提——但不拦 C4 本夜，C4 三臂实验不依赖角色装备）；**B1、B3**（小片，基点污染与分支/目录生命周期是夜跑可靠性
  直接账）、**B2**（中片，开工前置=裁决问题 11 的基点缺省姿态点头；且是「多节点并行同仓」进 isolation=always 形态的前提）。
- 第三批：W4（纯读端，等 W2 的 roleSha 落册有分母才有读者）、W3（声明+归因随 W1/W2；`declareViolation` 对账依赖
  S1a 副作用账过实机验证）、**K1**（产物台账+硬引用+dag.ts:696-698 假绿结账+N1 fan-in 喂产物清单——本支柱最便宜起手，
  且是 K2/K3 的物质基础）。
- 第四批（C4 之后、K3 之前）：**K2** 打回回路——开工硬前置是裁决问题 9 的回边语义点头；rejections 账形状依赖 S2 的
  abandonments 先落。
- 门控位：V5②（等 C4 料）、S7（等实探）、旧 V3 断言溯源（等 C4 指认假绿）、closePane（等实机复现，v11-D4 裁决不翻）、
  T1 定时起单（v12 原义：等 C4 人肉跑通）、**W5 装备物化（等 1–2 个 CLI 实机验证格式被认）**、
  **岗位级 A/B 实验（等 W1+W2+C4 方法论复盘）**、**K3 上下游岗位入编（等 C4 复盘后裁，v14 主体头牌）**、
  **上线脚本 `run` 型 check rehearsal（等 V0 白名单落地）**、**手机触达/审批全案（用户裁「先放下」，遗产三条见 R9）**。
- **C4 开跑窗口**：第一批收口后由用户令烧配额；三夜期间不再插工程片（防「边跑边改 harness」自造混淆因子——V4 的 ctxSha
  恰好会把这种事照出来）。

## 明确不做（v13）

- 重启复活 running run / re-attach 续跑（触「不重建 durable execution」；恢复走既有 ⤴/`--from-failed`）。
- `killAgent` 等协议面发明（17 动词全集外一个不加）；closePane 不抢 v11-D4 实机裁决。
- `/harness?vs=`、`/api/experiments/summary`、checksLedger 新字段、OTel 别名层、收数表 JSON 化——对账轮五连裁，均表面膨胀。
- 跨 run 统计读数（中位数/显著性/n 门槛）：v11 裁决「无统计检验」有效，结论走 gate0 风格人工文档。
- 夜跑复盘 UI / 已落册账本的前端呈现：web 审计实锤零呈现，但属体验账不挂两类账——入 Backlog 指名待裁。
- i18n/英文界面、陌生人首跑面（v10 纪律外）；LLM-as-Judge、聊天壳、多用户面、公网 SaaS（历版沿袭）。
- 自造 daemon/服务管理器（S6 只做进程内兜底+文档，systemd/pm2 是用户的操作系统的事）。
- **W 系边界三连**（防干活力支柱长成外壳怪兽）：①不造沙箱/工具能力锁（agent 在真 pane 里拿到全量 CLI 能力是事实，
  W3 只声明+归因+事后照，「跑中掐」判 durable-execution 变体不做）；②不自实现 MCP 客户端/不接管 agent 原生配置所有权
  （W5 只是供给侧搬运工且门控）；③不做角色编辑器 UI 与「AI 自动生成角色装备」（后者与「AI 动态生成拓扑」同族红线 D3）。
- **K 系边界三连**（防协同支柱长成对话壳+文档站）：①不做文档系统——doc 就是「一个文件 + 一册」，无富文本/在线编辑/
  外部同步（这不是 Confluence）；②不做 agent 自由对话协调——协调只有三原语（K1 类型化移交 / K2 回边 / 门），
  agent 之间开群聊即 cost/attention/机检三分母当场作废；③不建账号体系——注册/登录/多用户/OAuth 全线不做
  （手机触达轮的正身结论：凭据级「单主人 token + 一次性配对」已够，账号是只有驾驶员的车修机场）。
- **需求→上线的独立账本体系不做**：需求单/交付册只作为 K3 的角色产物存在，不建与 run 账平行的第二套流程账（防双账对不齐）。

## 评审记录（多 agent 评估轮）

- **R1 结构账**：批判轮自陈其 prompt 未插值卷宗（脚本缺陷）、18/18 verdict 塌在 partial——两事均如实入册；
  对账因此**不依赖**「holds」背书，每条正文结论都由本方案重新指认 file:line，运行期症状全部标「待实机」。
- **R2 三重复并一**：launcher bug 以三种矛盾症状（常驻/撞端口/收数断线）三进验证池——合并为 E1，
  症状以批判轮实测真包 + verifier #13 读 server/index.ts 退路为准（listen 失败退 1；**第三后果踩账本入 S6**）。
- **R3 高估回收**：Windows「装不上」、V13-1「解冻基建」、P13-2「C4 污染」、R13-S5「无痕湮灭」、R13-S3「锁泄漏」
  五处经亲核改判，正文按实测口径写。
- **R4 依据卫生**：外部 URL 全部未亲验 → 降背景不承重；二手百分比一律不引；verifier #18 自报 run 数被批判轮复算纠正
  （completed=8 非 10）。凡「grep 零命中」注明只证无字面量、不证无消费（AGENTS.md 案即此类）。
- **R5 R4 铁律守恒**：V0/S 系/E 系判据全在 server，CLI 仅渲染与旗标；零新子命令、零新视图。
- **R6 与 v10 裁决一致性**：S/V 两类账正身；E1 挂「实证分母的发行形态前提」（c4-night1.sh 依赖 release paneflow）+
  已立入口承诺兑现；E2 挂 gate0 一票否决线（实机即 win32）且**显式声明改判 v6 裁决待用户点头**——无一条外壳能力。
- **R7 未认领账留痕**：前端呈现、采用分母、版本矩阵（CI 只 ubuntu+node22）、dependabot、数据迁移版本戳（RunRecord 无
  version 字段、DagGraph version!==1 硬拒双向断头）——全部点名入 Backlog 不入本版，防下轮「集体漏账」复发。
- **R8 干活力轮（用户裁决入册）**：W 系不来自 29-agent 工作流，来自用户第六轮追问的角色考古（论证与 file:line 全在
  `workforce-roles-audit.md`）——29-agent 七路审计竟无一路碰「角色是不是岗位」，这是工作流法的盲区实证：**用户领域直觉
  指出的结构缺口，比 fan-out 更难自己长出来**，入册备忘。账目交代：W 系引入「效率」为第三条账名目，系用户明裁
  （「编排主要的目的是为了效率」），与本仓 E2 改判先例同级；R4 铁律守恒同样过——交集注入、事拦对账、profile 聚合
  判据全在 server，CLI 只渲染，W4 端点是纯读且为本版唯一新端点。schema 卫生：Role 新字段全 optional、不 bump version
  （绕开 R7 记录的双向断头雷）。
- **R10 交付约定轮（用户驱动，v0.5）**：来源系用户追问「约定分支的拉起这类基本工程怎么没考虑」+ 亲贴两副
  「交付约定」块样本（fix/feature 流程），规范形状移植自姊妹工程 pi-issue-harness（过程=数据文件三副、contract 驱动
  开分支、判定法则切引擎/宿主）。两条方法账入册：①「死字段先于新字段」——`contract.repo/branch` 与 `prUrl` 早已在
  schema（dag.ts:229-230/415/463）却零消费，B 系大半工程量是接线不是发明；②用户点名的三份流程卷宗
  （herdr/forge.md/hermes·dag-loop）**本机检索不可达**（仅 `aios/herdr.md` 实战手册在盘），本轮 B 系形状据实标注只依据
  可读到的 pi-issue-harness 与用户贴样，**未亲验的卷宗不承重**（R4 依据卫生同款）——待用户补料后复核，若有出入以勘误入册。
- **R9 闭环协同轮（用户驱动，v0.4）**：来源非工作流，系用户三轮追问（驾驶舱/闭环 → 载体是角色 → 产物必须可跟可查）。
  纠偏一条如实入册：讨论期把产物判成「扫屏遗言摘录」，亲核后实为**文件交接契约已存在**（engine.ts:2462-2471），
  真账是「文档不落盘不哈希、引用不硬、回收即蒸发」——K1 形态因此从「新建通道」纠正为「升级既有契约」，
  「凡断言必带 file:line」又一次兜住。同轮手机触达线（飞书自建应用/ntfy/EasyTier 等 X/Y 案）经用户裁「先放下」入门控位，
  三条设计遗产入册防重复探索：①命令面/屏幕面分离（审批=命令，遥控=屏幕，后者只归 RustDesk 类文档）；
  ②不建账号体系（进「明确不做」K 系边界③）；③若开闸，飞书自建应用 userId 白名单为前选、LAN 面须等 S7 实探。
  账目交代：K 系同挂 W 系已立的「效率」第三账名目（R8 先例），零新子命令、零新视图、零新写端之外膨胀——
  K1 纯文件账、K2 纯图语义+账、K3 门控；dag.ts:696-698 与 N1/N6 三笔既有假绿/断线账由 K1 顺手结，不另立片。

## 裁决问题（等用户点头才动工）

1. **开工顺序**：是否同意「第一批六片（S1/S6/S3/V0/V2/E1）落完再令 C4 开跑」？（反方案=先烧配额，接受首批四漏在册跑三夜。）
2. **E2 改判**：v6 曾裁「不做 Windows 原生适配」，本版以实跑证据改判——点头则 E2 入第二批，否则砍到只剩
   「claude 回落 fail-closed + 支持矩阵文案」最小诚实面。
3. **S4 默认值**：`PF_GATE_TIMEOUT_MS` 你有心理价位吗（建议 0=关起步，C4 单先只开 `gateTimeoutMs` 观察一臂）。
4. **V2 取臂规程改判**：「A/B 双臂 fresh dispatch、replay 只作同臂补分母」会改变 C4 夜操作单量（每臂 ≥3 新单），
   配额预算你接受吗？
5. 门控位（closePane/S7/V5②/T1）无异议的话，本版的「不」就是终版之「不」。
6. **W 系账名目追认**：本版把「效率」立为第三类账（源于你「编排主要为效率」的裁决）并让 W1/W2 进第二批——
   若你更保守，可退回「W 系全部门控、只随 C4 复盘再定」，代价是继续容忍技能全文×全节点注入的 token 浪费。
7. **W3 边界确认**：授权只做「声明+归因+事后照（declareViolation）」，「跑中掐」判为 durable-execution 变体不做——
   即评审岗的「不亲自改代码」永远是可核对的声明而非硬拦截。接受这个诚实边界吗？
8. **skills 语义迁移确认**：`profile.skills` 从「注入清单」降级为「登记清单」、注入决定权上移角色槽（未配槽=吃全量+一行警告，
   不强迁）——这动的是空间配置页的**词面语义**（登记/勾选 UX 不变），AGENTS.md 输出面同步。点头 W1 才可按此形状动工；
   反方案=skills 完全迁到角色、空间不留清单（更纯粹，但发现→勾选的一次登记体验会被拆散）。
   顺带一并裁：模型档位仍钉空间级（gatewayProfile）——角色级 model 槽本版**不做**入 Backlog（装备指纹×网关指纹组合复杂度失控前不叠轴）。
9. **K2 回边语义裁决**：确定性 DAG 首次允许「指向已完成节点的否决回边」（拓扑仍确定、attempt 动态 +1 并落 rejections 账）——
   这是拓扑确定性与打回真实性的取舍：不接受则质检岗只能「看见但不能说话」，K2 入门控位。
10. **K3 节奏确认**：需求单/交付册/排班表入编是「需求→上线闭环」正身，但属大片——建议本波只落 K1（+K2 视裁决 9）、
   K3 整线后置「C4 复盘后、v14 头牌」。**先修夜跑保险丝再开闭环**的顺序与 v13 立论一致，你点头吗？
11. **B2 基点缺省姿态**：delivery 未配 `branchFrom` 时——(a) fail-closed 拒拉（宁缺毋假，但存量空间首单必红）还是
    (b) 兼容带回退现状 HEAD+一行警告（保存量，但污染账再躺一代）？建议 (a)+空间配置页红字提示，与 V0「宁拒不错放」同姿。
    ✅ **已裁（2026-09-24，用户「选a」）**：采 (a) fail-closed——未配基点即拒拉收 failed，配空间页红字指路；
    (b) 兼容带否决，存量空间首单必红系已告知并接受的代价。
