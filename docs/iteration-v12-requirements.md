# iteration v12 需求（v0.2 草案，经代码对账一轮，待用户裁决）

日期：2026-09-22。前身：v11（批次一二收口于 `247463f`，C4/D4 欠账在途）。
立论方式沿用 v10 复盘裁决：**新需求只准挂两类账——无人值守可靠性、实证分母——不加外壳能力**。
v0.1→v0.2：Explore 全仓对账（file:line 见评审记录）砍掉三处高估、补全两处漏项。

## 外部思想输入（2026-09 侦察小结）

1. **评测必须披露 harness，终点从「产出代码」移到「可上线变更」**（arXiv 2609.04681）：
   孤立跑分指标失真——「收益在写码与出货之间急剧衰减」；要求端到端记录工具链调用轨迹、
   重试次数、人工介入节点；核心 KPI 是「生产验证变更数」，并行追踪 reviewer-hour 与
   返工成本（「验证税」概念：测试+人工复核是主要延迟源，必须入账）。
2. **长时 agent = 长生命周期分布式程序**（Codex harness 评测讨论）：故障注入→状态恢复→
   续跑→断言；非幂等操作恢复时绝不重放；预算/重试阈值超限须安全熔断。
   行业侧印证：Durable Execution / checkpoint 化正在升温（Vercel WDK、MS Agent Framework
   checkpoints、LangGraph），方向一致——**但 PaneFlow 的 resumeOf 已踩在这条路上（见对账）**。
3. **成本治理（FinOps）话术已成主流**：「从 token 账单到线上熔断」是行业公认三步——
   可见→归因→熔断。PaneFlow 卡在第 1.5 步：账单有、熔断无（对账见 S2 改判）。
4. **可观测标准在收敛到 OTel GenAI 语义约定**（trace/span 记录工具调用与模型参数）：
   本项目不引标准壳，只吸收其教训——**harness 参数（模型/档位/解析后 kind）是 trace 一等公民**，
   这正是 V1 的要害。
5. MCP/Skills 分层与自改进飞轮：C1/C2/C3a/v8-I2 已是工程落点，v12 不重造；
   对外 MCP 暴露进 Backlog 留证据。

## 对账（v0.2 核心轮）：v0.1 断言逐条验真

| v0.1 断言 | 审计结论（file:line 在评审记录） | 处置 |
|---|---|---|
| 「无续跑能力，只能整单重放」 | **高估**：resumeOf 链路完整能跑——done 节点继承+产物预载黑板+调度跳过（engine.ts:465-487,966-974），前端 ⤴ 已接线。真缺口=**replayRun 显式放弃 done 继承**（engine.ts:732 传 undefined），两机制只差拼起来 | S3 从「建续跑」缩为「replay×resume 合流」，降为小片 |
| 「replay 无二次副作用防护」 | **属实且更糟**：triage/align 单 replay 会**再建/覆写 issue**（update-issue 端点无 If-Match 无审计，http.ts:562-588）；push/评论对引擎**不可见**（提示词驱动+盲 HTTP 端点，零事件）——想判 sideEffects 连证据源都没有 | S1 拆两步：S1a 副作用先可见（盲端点落事件/agent 自报口径），S1b 才有门禁可判 |
| 「无预算熔断」 | **半属实**：时长维度已有硬顶（节点 timeoutMs 缺省 30min，engine.ts:1298；pipeline 24h）；空白只在 token/成本维——且 `contract.budget:{maxMinutes,maxTokens}` 字段与解析链**已铺好，注释自认 B5 未做执行点**（dag.ts:223-224） | S2 缩为「给既有字段补执行点」，非新造 |
| 「审批留痕零记录」 | **高估**：四类门拦/放成对落 approval 事件、contract.confirmedAt 已落册；缺的是 TUI 对话框门进入不留痕（engine.ts:1449-1452）+ 任何聚合 | V2 缩为「补一条事件 + 聚合读端」 |
| 「harness 参数未固化」 | **大体属实、一处修正**：graph 是 structuredClone 实发快照（含注入后 prompt），模板内容可整幅还原；还原不了的是**解析结果**——effective agentKind 每试现算不写回（engine.ts:2086-2096）、gwProfile 现读空间档案；DAG 模板无 hash（version 恒 1），但契约模板 `id@sha` 是**现成参照实现**（contract-templates.ts:75-78） | V1 定向为「三个解析结果上头 + 照抄 templateSha 给 DAG 加 hash」 |
| 「全仓无 scheduler」 | 属实（server 唯一定时=reconcile interval） | T1 原样 |
| 隐含前提：从事件流推导历史 | **有天花板**：events ≤500 条环形截断（engine.ts:2377），长 run 早期事件可能被挤掉——凡要算账的字段必须**结构化落册**，不靠事件推导 | V2/S1a 设计约束入文 |

结论不变但更硬：v11 台子齐、v12 补三洞收实证账——且对账后**每一洞都比 v0.1 想的浅**
（多是「已铺字段补执行点」「已存在机制拼起来」），范围膨胀风险 R1 反而下降。

## 目标（v12 一句话）

**从「能派单、能复跑」走到「敢隔夜放手」**：夜跑不产生二次事故、不烧穿预算、
人介入的成本看得见；并用 C4 实跑数据把「知识复利是否成立」这笔 v10 以来欠的账结掉。

## 支柱与需求

### P0 还账支柱（数据前提）

- **C4 三夜**：前置清单在 v11 文档（选题/A-B 重启仪式/replay 防撞/收数分母/护栏）。
  **待用户选题**，本仓无工程。
- **D4 孤儿漏网**：待实机复现（gate0 规矩不变）。

### P1 可靠性深化（S 系，挂「夜跑不炸」账）

- **S1a 副作用可见化**（先决小片）：三个写外部世界的口子——`POST /api/github/create-issue`、
  `PATCH /api/github/update-issue`、deliver 节点 push——统一落 run 事件+结构化标记
  （`run.sideEffects: {issuesCreated[], issuePatched, pushed, prUrl}` 收口时落册；
  prUrl 已有，照此形）。M4 Contents 回写的「探 sha/无变化跳过/409」是全仓唯一写侧幂等先例，
  护栏口径向它看齐。
- **S1b 副作用感知 replay**：带 sideEffects 的单默认拒绝 replay，
  `--allow-side-effects` 显式穿透+透明性事件。判据全在 server，CLI 薄壳露出（R4）。
- **S2 token 预算执行点**：`contract.budget.maxTokens` 与 `PF_RUN_MAX_TOKENS`（graph 覆写）
  在节点启动前查 `run.cost.tokens` 累计，超限即停收 `failed`+明确 error。
  注意 tokens 拿不到即 null（绝不估算原则）——**null 时不熔断只警示**，宁漏不误杀。
- **S3 replay×resume 合流（原 S3 的替代，小片）**：`replayRun` 加 `resumeMode`——
  复用 done 继承通道重放（失败节点才重跑），CLI 露出为 `--from-failed`（见可感面）；
  与 S1b 是一对（一个说"别重放"，一个给"只重放没成的"）。

### P2 验证税与披露（V 系，挂「实证读数可信」账）

- **V1 harness 披露**：RunRecord 头上固化 `{effectiveAgentKind, model, gwProfile, graphSha}`
  （解析结果写回一次即成历史，照抄契约模板 sha256 前 8 位做法给 DAG 模板加内容 hash）；
  收数表加 harness 摘要列；replay 与原件比对，漂移落透明性事件。
  **C4 两臂「只差 PF_WIKI_READBACK」从此要机器证，不靠仪式自律。**
- **V2 人介入聚合**：补 TUI 对话框门「进入」事件（现在只留「放」的时刻），
  加读端聚合（每 run 门等待总时长、approve/reject 次数进 cost 或 state 响应）；
  收数表加「人等分」列。**时长从结构化字段算，不从 500 条环形事件里刨。**
- **V3 断言溯源**（Backlog 转正，门控不变）：开工条件=C4 数据指认假绿来源。

### P3 入口支柱

- **T1 最小定时起单**：`~/.paneflow/schedule.json` + interval 对账，无 UI，用途钉死隔夜跑批；
  **解冻条件=C4 人肉三夜跑通**——顺序反了等于给没验证的流程装马达。

## 可感面：v12 落到 CLI 是什么样（命令可原样执行）

原则：**v12 不新造子命令**（除 replay 加两个旗标），全部变化是既有命令输出多行多列；
每条需求验收必带「AGENTS.md 派活说明书同步输出面」对勾（v11-A2 契约继续有效）。

- **dispatch / runs / status / watch / approve 五令面不改**，v12 新事实挂进输出：
  - `paneflow status <runId>` 多三块——**harness 行**（V1：本单实发 agentKind/model/gwProfile/graphSha，
    replay 漂移会多一行「复跑时 harness 已变」）、**副作用行**（S1a：push N 次 · PR 链接 · 回写过 issue）、
    **人等分**（V2：门等待总时长 + approve/reject 次数）。
  - `paneflow watch <runId>` 退出码表不变；S2 熔断触发时按红（1）走，error 一句
    「token 预算超限（已用/上限）」——机器无需学新码。
- **复跑实验（S1b/S3）**：
  ```bash
  paneflow replay <runId> --times 2 --suite c4 --arm a
  # 源 run 带副作用 → 默认拒绝：
  #   ✖ 源 run 有副作用（push 2 次 · PR #12 · issue 回写 1 次）——直接重放会二次副作用
  #     显式穿透加 --allow-side-effects；只重跑失败/未执行节点加 --from-failed
  paneflow replay <runId> --from-failed --suite c4 --arm b   # S3 合流：done 节点不重跑，无二次 push
  ```
- **收数表（V1/V2 加列）**：`paneflow experiments --suite c4` 每行多 harness 摘要列与人等分列——
  A/B 结论要能读出「两臂只差 readback 开关」，不靠起单人自律。
- **C4 夜仪式的效果链**：A/B env 重启仪式仍是人肉（进程级 env），但 V1 落地后
  「只差 READBACK」从自述变成 replay 比对+收数表机器证。
- **T1 无 CLI 面**（若解冻）：schedule 是 server 侧配置，不起「定时命令」——防可感面膨胀。

## 批次建议（对账后全线变小）

- 第一批：C4（待选题即开跑）+ **V1**（赶 C4 第二夜前，A/B 可信度直接受益）。
- 第二批：S1a → S1b → S2 → V3 无 →（S1a/S1b 有依赖序，其余独立；均为「补执行点/合流」量级）。
- 第三批（门控位）：S3、T1、V3。

## 明确不做（v12）

- LLM-as-Judge 自动评产物（黑盒判据与 gate0「只认实机/可机检」相抵）。
- 引 OTel/外部可观测框架（吸收其「harness 参数一等公民」教训即可，不装壳）。
- 自建 durable execution 引擎（resumeOf 已够用，行业 checkpoint 流不跟全量）。
- 上下文压缩/漂移检测（节点粒度天然短程，风险在节点间契约不在单节点上下文）。
- 对外 MCP 暴露、聊天壳、多用户面（沿 v11 裁决）。
- 任何新视图：v12 全部是记账、门控、比对、合流——零新表面。

## 评审记录（v0.2 对账轮八条，处置已并入正文）

- **R1**：v0.1 五处现状断言经 Explore 审计（engine.ts:465-487/732/1298/1449-1452/2086-2096/2377、
  dag.ts:223-224/373-407/437、http.ts:562-588、contract-templates.ts:75-78）——三处高估已收缩，
  需求全部改「补执行点/合流」表述，无一条从零造。
- **R2 副作用范围膨胀**：S1 发现洞比想象大（盲端点连证据都没有），拆 a/b 且 a 先行；
  不做写侧幂等键改造（update-issue 加 If-Match 属工程卫生 Backlog，不占 v12 名额）。
- **R3 null 不熔断**：S2 遵守「绝不估算」既有原则——tokens 为 null 只警示，防误杀合法单。
- **R4 事件截断天花板**：凡 V2/S1 要算账的一律结构化落册，不依赖 events 推导（500 环已证）。
- **R5 V1 不破坏 replay 语义**：graphSha 只做披露与比对，不参与编排判据（漂移只发事件不拦，
  拦是 C4 之后的账）。
- **R6 S3 降级为合流**：不新造续跑——resumeOf 能跑是测试实证过的（engine.test.ts:886/1652），
  只补 replayRun 的 resumeMode。
- **R7 R4 铁律守恒**：S1b/V1/V2 判据全在 server，CLI 仅露出参数与文案。
- **R8 与 v10 裁决一致性**：全部需求挂可靠性/实证两类账，无新外壳能力——通过。
- **R9（用户指正）**v0.2 通篇 server 字段话术、可感面缺位——补「可感面」节（命令原样可执行、
  输出面逐条落到 status/watch/experiments/replay），并立纪律：**每条需求验收含 AGENTS.md 输出面同步**；
  此后迭代需求文档必带可感面一节。

## 裁决问题（等用户点头才动工）

1. **V1 插队**：是否同意 V1 赶在 C4 第二夜前落地（对账后更小：三字段写回+一处 sha 复用）？
2. **C4 题源**：仍是总前提——同一真仓 3 条同类小修，issue 由你立。
3. **S2 默认值**：`PF_RUN_MAX_TOKENS` 你有心理价位吗（免费档网关，建议先设宽只防重试风暴）；
   还是等 C4 单跑读数出来后定默认？
4. T1/V3/S3 维持门控位无异议的话，第二批就是 S1a/S1b/S2/V2 四小片。
