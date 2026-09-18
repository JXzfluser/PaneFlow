# PaneFlow 迭代 v6：评审 · 方向 · 两周冲刺

> 本文是本轮评审的**唯一沉淀文档**（2026-09-14），分三部分：**一、现阶段的不足**（独立复核 + 补充评审）；**二、未来项目可继续的方向**（北极星 + 分期路线）；**三、v6 两周冲刺**（把方向变成砖）。原 `trust-layer-vision.md` 已并入第二部分并删除。
> 评估方式：全代码库三维独立复核（文档治理史 / 服务端引擎 / 前端产品形态），证据锚点给 `文件:行号`，不采信单一文档结论。
> 目标共识：**落地价值 = 开源给开发者用**；心动方向：①交付审计报告 ③Agent 评测台 ④运行回放器；⑤Bot Space 为北极星，不进本 sprint。
> **修订（2026-09-14 第二轮对抗性评审）**：第〇部分以"可以否定项目"为前提重审了全部前提，**推翻了"开源给开发者"的目标设定与"真 Pane"地基叙事**，并据此修订第三部分计划（Gate 0 一票否决闸 + 执行层转 ProcessOps）。第一、二部分结论在否定后仍然成立的部分已标注。
> **附录 A（2026-09-14 晚）**：#308 二次下发排障复盘——真实任务连续失败约 85 分钟的耗时解剖；产品缺陷（herdr 5s 判杀 × 双重等待）、方法论失误（无效基线/内联转义/无对照实验）与环境约束的完整清单，已回灌第三部分（见 A.5）。

---

# 第〇部分 · 对抗性评审：该不该做，比怎么做更重要

> 评审立场：找"不成立"而非"可以更好"。五步攻击 + 判决。

## 0.1 五步攻击

**第 1 步 · 问题定义**：对**代码类**工作，回执早已存在且更硬——**PR**（diff + CI + review + approve + 可 revert）。审计报告不是从零到一，是必须打败在位者。真缝隙在**非 PR 型代理工作**：数据治理批次、巡检、调研、迁移——这些活干完什么都不会留下。→ 护城河收窄为"**非 PR 型工作的回执**"，叙事必须相应换锚。

**第 2 步 · 架构地基**：整套技术栈（Herdr socket / NDJSON / TUI 状态识别 / blocked 启发式 / P7 补丁柜）建立在"agent 只有 TUI"的前提上，而主流 agent CLI 早已全线 headless 化（`claude -p --output-format json` / `codex exec` / `opencode run`，均先于本项目立项）。逐项对照：结构化结果 headless 比 artifact 约定文件更可靠；人工审批可用权限钩子（审批 UI 仍可是 PaneFlow 网页）；人工接管有 `--resume`；隔离本就靠子进程+cwd+worktree。→ **Herdr 从"地基"降级为"可选后端"（保留给 TTY-only agent）；默认执行层应为 ProcessOps（headless CLI 子进程）**——Unix socket（G5）、P7 补丁柜、双栈依赖三个问题同时消失，engine.ts 经 HerdrOps 接缝大部分存活。

**第 3 步 · 护城河**：中立性是"不做什么"的被动资产；骨架库是品牌不是壁垒（提示词无锁）；证据链的价值取决于消费方。→ 唯一当下可兑现的消费方是**作者自己的治理工作**。

**第 4 步 · 时机与执行力**：agent 编排是当前最拥挤赛道（solo + 零分发 + GUI）；PaneFlow 依赖 Herdr（0.8.x 小项目）——给没人用的底座做上层，风险是乘法；**scenario-value-map 列了 14 个场景，真实兑现的只有自指的 Issue 受理流水线，连作者自己的周报数据（绿化台账）都没在机器上跑过**；作者在 Windows 上开发而产品要求 WSL。

**第 5 步 · 反砍计划与形态**：用上述结论回砍 v6（见 0.2）；附一刀——GUI 画布是管理者视角产物，开发者活在终端/编辑器/CI，诚实形态可能是 **CLI-first、Web 作监控面**（侦察性否定，Gate 0 后验证）。

## 0.2 判决与对计划的影响

**否定**：①目标设定"开源给开发者"（改为自用验证成立后顺带公开）；②"真 Pane"地基叙事（换"真进程隔离 + 确定性验证"）；③画布中心形态（侦察性）。
**保留**：验证内核（checks/AC 断言/证据链，不依赖 Pane，瞄准非 PR 型工作 + 评测台）。
**Gate 0（一票否决闸）**：一周内让作者真实数据任务（绿化台账批次）完整跑通并产出审计报告。**跑不通，全部愿景与 sprint 作废**——那说明这台机器只配当个人玩具，而玩具不需要信任层。

| 原 v6 计划项 | 判决 | 理由 |
|---|---|---|
| #1 守卫 / #3 CORS / #4 探测 / #5 小修 | ✅ 保留 | 任何分支下都成立且便宜 |
| #2 reconciler | ⚠️ 降级 | 执行层转 ProcessOps 后意义大减；标注 `PF_RECONCILE_MS=0` 坑位即可 |
| #6 审计报告 | ✅✅ 升格 | 所有分支的核心资产；叙事锚定"非 PR 型工作" |
| #7 variables+播种 | ✅ 保留 | 内容地基 |
| **#8 S5 数据治理骨架** | ✅✅ **升格为 Gate 0** | 全计划唯一能证伪项目的实验 |
| 第 2 波 README/陌生人包装 | ⛔ 砍，延后 | Gate 0 前不对陌生人承诺 |
| 第 3 波 CLI headless | ✅✅ 升格 | 重新定性：**ProcessOps 执行层的滩头阵地**，不是分发手段 |
| 第 4 波 回放器 | ⛔ 延后 | 画布形态待定 |
| 第 4 波 评测台 | ⚠️ 只做侦察 | 验证 `applyVariables` 覆盖 `agentKind`——否定之后最值得去的方向，早知道成本 |

---

# 第一部分 · 现阶段的不足

## 1.1 成熟度仪表盘

| 维度 | 评分 | 依据 |
|---|---|---|
| 编排引擎 | ★★★★☆ | 1438 行 engine.ts：信号量/软锁/worktree/幂等/断点续跑/验收门禁，122+ 测试全绿 |
| Herdr 集成 | ★★★★☆ | 生产路径 100% 真实无 mock；但 reconciler 死代码、TUI 启发式补丁偏多（见 1.5 P7） |
| 内容（骨架/角色） | ★★☆☆☆ | 8 个骨架 7 个接不了真实输入；角色库 5 字段薄壳 |
| UX 外壳 | ★★★☆☆ | 简化提案已全量落地；但零组件测试、emoji 当图标、拖拽目录拿不到真实路径（浏览器限制，功能基本不可用） |
| 信任与安全 | ★★☆☆☆ | 本机零鉴权 + CORS 全反射 + 全员 skip-permissions，与"可控可审计"品牌自相矛盾 |
| 分发与落地 | ★☆☆☆☆ | 陌生人装不上（Herdr≥0.8.2 + agent CLI + pnpm + Unix 假设）；唯一 dogfood 是自产 Issue 流水线 |

一句话总评：**这台机器真的会干活，但它几乎还没干过几件"真活"，也还没向一个陌生人证明过自己。**

## 1.2 开发者采用漏斗与断点

按一个从未见过本项目的开发者的真实旅程逐段检查：

| 漏斗阶段 | 现状 | 断点（证据） |
|---|---|---|
| **看到** | README 定位清晰（真实 Pane / 硬隔离 / 确定性 / 明厨亮灶） | 无 demo 动图、无与软编排（LangGraph/n8n）的一屏对比表；差异化说不出口 |
| **装上** | EnvWizard 三步向导已落地（首访自动弹出） | ① agent CLI 要账号/API key（品类固有摩擦）② **Windows 无路**：`env-check.ts:36`、`engine.ts:920` 用 `sh -c`，herdr 走 Unix socket，`fs-routes.ts:80` 用 `process.env.HOME` ③ 安装前提只藏在 README |
| **首跑** | 一句话下发 + 编排预告门禁已可用 | **8 个内置骨架 7 个不接真实输入**（condition 0 次 / checks 0 次 / variables 1 次）——首跑只能跑演示剧本 |
| **见证价值** | 证据链完整：500 事件时间线、逐条 AC 断言、黑板产物、审批记录 | **全部埋在 JSON 里**，交付审计报告不存在——最强差异化资产没有出口 |
| **留下** | 画布 + 运行中心体验完整 | 无 CLI/headless 出口，进不了 CI/cron |

推论：**审计报告是「见证价值」段的唯一杠杆（零引擎改动），variables 补全是「首跑」段的唯一杠杆**——两者是全路线图性价比最高的两件事。

## 1.3 已确认修复（不再列为缺口）

- 画布保存往返：`graph-serialization.ts` + 往返测试，架构性修复"保存即销毁"。
- 并发可信 R3.1-R3.4：worktree 隔离 / 仓库软锁 / git 脏检查 / issue 幂等（`engine.ts:67-70,106-121,177-185`）。
- 远程模式鉴权：`PF_HOST` 非本机时强制 Bearer 令牌（`config.ts:29-42`，0600）。
- UX 简化提案 A/B/C/D 全量落地；通道层（webhook/飞书/钉钉）+ 运行时间线 UI + GitHub 沉淀闭环。

## 1.4 仍存缺口 G1-G10

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | **对账器是死代码**：`startReconciler()` 从未被调用，"事件+轮询双向校对"只剩事件一半 | `engine.ts:1345-1351` | "确定性"卖点缺兜底腿 |
| G2 | **CORS 全反射 + 本机零鉴权**：任意网页可跨站停 run / 发按键 / 读文件 | `http.ts:85`（`origin: true`） | 安全口碑，品牌自相矛盾 |
| G3 | **自动保存漏判变量改动**。根因：**序列化没问题，问题只在变更检测**——保存载荷已含 `graphVariables/graphMeta`（`store.ts:437-444`），订阅守卫只比较 nodes/edges/graphName/cwd（:423-430） | `store.ts` 尾部订阅 | 旗舰骨架 `issue_id` 参数仍可能丢 |
| G4 | **Planner agentKind 写死 `'claude'`**：只装 opencode 的用户智能下发直接失败 | `dispatch.ts:63` | 首跑即翻车 |
| G5 | **Windows 假设贯穿**：`sh -c` / Unix socket / `HOME` | `env-check.ts:36`、`engine.ts:920`、`fs-routes.ts:80` | 装不上（先文档化 WSL 路径） |
| G6 | 小修包：顶栏 `v0.2.0` 与 package.json `0.1.0` 不一致；`store.ts:131` agentKinds 兜底写死；SettingsView 多处裸 fetch 无 `.ok`/catch；`http.ts:495` 无效表达式；`dag.ts:77` 注释漂移；`template-labels.ts` 前端硬编码 | 各文件 | 口碑细节 |
| G7 | 测试盲区：web 组件 0 测试；`http.ts`/`gateway.ts`/`env-check.ts`/`herdr-ops.ts` 无测试；真机验证只有手动 smoke | 各文件 | 重构信心 |
| G8 | 分发空白：无 CLI、无安装器、无版本化发布 | 根 `package.json` | 漏斗末段断裂 |
| G9 | **【新发现】跨空间自动保存覆盖**：`switchSpace` 把 nodes/edges 置空也触发自动保存 → 800ms 后**用空画布覆盖上一空间未保存内容** | `store.ts:144-158` | 数据完整性 |
| G10 | **【新发现·引擎行为】动态扇出黑板别名缺口**：expand 克隆节点 id 为 `impl__1/impl__2`，黑板以克隆 id 为键，下游 `{{impl.artifact.summary}}` 解析不到（字面量喂给 Agent）——旗舰骨架 verify 节点正踩此坑 | `engine.ts:1028-1075` | 模板设计约束；引擎改进候选 |

## 1.5 补充评审：性能、资源与工程链

| # | 发现 | 证据 | 改进方向 |
|---|---|---|---|
| P1 | **RunRecord 全量重写**：每次状态变迁 `writeFileSync` 全量 JSON（含最多 500 事件+产物），长运行磁盘抖动近似 O(n²) | `store.ts:197-207` | 事件分片/追加写，或归档时瘦身 |
| P2 | 通道配置每次状态变迁同步读盘、无缓存 | `channels.ts` | 启动加载 + 写时失效 |
| P3 | 双重静默截断：前端日志 400 条、事件 500 条，截断无任何提示 | `store.ts:185`、`engine.ts:1372-1378` | 容量提示（"已截断，导出看全量"） |
| P4 | WS 广播无过滤：任何 run 变更推给所有连接的客户端 | `http.ts:712-732` | 按 runId/space 订阅 |
| P5 | 终端预览 2s 轮询、两处各自维护——与时间线"避免轮询"的设计声明相悖 | `Console.tsx:77-96` | WS 化 |
| P6 | runId = `randomUUID().slice(0,8)`，理论碰撞面 | `engine.ts:211` | 全 UUID 或时间戳前缀 |
| P7 | **TUI 启发式补丁集中营**：blocked 连续 2 次才采信、`waitForSettle>40` 抛调试探针、仓库锁 1.5s 轮询、pipeline 24h 轮询上限——herdr 升级时最脆弱的面 | `engine.ts` 多处 | 收拢到一个适配层 + 协议版本握手 |
| P8 | 工程链：无 lint、无 `engines` 字段（node 22 硬依赖未声明）、无依赖审计/renovate、CI 无 smoke 无安全扫描 | `package.json`、`ci.yml` | engines + lint + audit 各一行起步 |

---

# 第二部分 · 未来项目可继续的方向

## 2.1 北极星：AI 劳动的信任层

伟大的产品骑在"时代级错位"上——一种能力暴涨，配套的信任基础设施空白：

| 时代 | 暴涨的能力 | 空白的基础设施 | 伟大产品 |
|---|---|---|---|
| 搜索时代 | 信息 | 找到可信信息 | Google |
| 电商时代 | 交易 | 陌生人交易的信任 | escrow / 支付宝 |
| **AI 时代** | **AI 劳动** | **"AI 干的活能不能信"** | **？** |

关键判断：**瓶颈已从"AI 能不能干"迁移到"我们敢不敢信"。生成正在成为 commodity，信任才是稀缺品。** 模型厂商在拼命做 L0（更聪明的引擎），L1-L5 信任层几乎无人认领。

**PaneFlow 的秘密：五个信任原语已经全部在代码里**，只是从未被如此命名和推销：

| 信任原语 | 代码里的存在 |
|---|---|
| **规格**（先定义什么叫干完） | `AcceptanceAssertion` 逐条断言、checks 四类门禁 |
| **隔离**（关在笼子里干活） | 真 Pane = 真进程/真 TTY/独立 cwd；worktree；软锁 |
| **验证**（机器核对而非自述） | 断言核对（标注 file/output-fallback/empty 来源）、dry-run |
| **存证**（全程留痕可取证） | 500 事件时间线、`.herdr/artifacts/`、审批记录、audit.log |
| **问责**（关键动作人来担） | blocked 原生审批闸、ApprovalCard、manual check |

别人在做更聪明的引擎，PaneFlow 在做引擎的**刹车、行车记录仪和年检制度**。引擎越强，信任层越值钱。

**信任栈与产品阶梯**（每层为上一层供血）：

```
L5 可交易   —— 模板市场、bot 劳动力市场、预算经济          ← bot-space.md B4
L4 信得过   —— 评测台、bot 身份/履历、成本记账、合规包      ← 下一仗
L3 说得清   —— 交付审计报告、可签名存证、运行回放          ← v6 冲刺
L2 看得见   —— 画布、时间线、通知、审批卡                  ← 已基本建成 ✓
L1 干得对   —— 验证门禁、断言核对、确定性 dry-run          ← 已建成 ✓
L0 能干活   —— 模型与 agent 本体                          ← 厂商地盘，不碰
```

注意 **L4 有一块缺失原语必须补：成本记账**（对应 1.2 P7 无、本表指痛点"成本黑箱"）——没有成本核算，"信得过"不完整，"预算经济"无从谈起。

**终局野心（期权，非承诺）**：审计报告不止是 HTML 页面，而是**开放的交付回执格式**（JSON schema：任务规格+断言结果+过程摘要+审批链+签名）——"AI 工作回执的 MCP"目前无人认领；格式即标准，标准即王座。再进一步：**可审计 → 可保险**，AI 工作失误可定价、可投保——届时 PaneFlow 不是开发者工具，而是 AI 劳动经济的清算层。

## 2.2 方向地图（六个方向 × 承接文档）

| # | 方向 | 一句话 | 承接 |
|---|---|---|---|
| ① | **交付审计报告 → 回执格式** | 证据链变一等交付物；终局是"AI 工作回执"开放标准 | v6 冲刺 #6 起步 |
| ② | **骨架复利飞轮** | 每次真实运行复盘"缺哪个 check/断言"→ 回流模板库；骨架质量 = 产品天花板 | `scenario-value-map.md`；v6 #7/#8 |
| ③ | **Agent 评测台** | 同一 DAG 跨 agent 横评——结构性独占（软编排无法固定环境），跨厂商中立护城河的展品 | S13；v6 弹性位 |
| ④ | **运行回放器** | 时间线+产物 → 拖动回放；调试神器 + 魔性 demo | v6 弹性位 |
| ⑤ | **Bot Space（B1-B4）** | 数字员工社会：落户/履历/信任评级 → 记忆 → 值班 → 市场 | `bot-space.md`（已有专文，不重复） |
| ⑥ | **明厨亮灶直播** | 观赛视角看 agent 干活，获客钩子 | 轻量彩蛋 |

## 2.3 分期路线

| 期 | 内容 |
|---|---|
| **近期**（v6 冲刺，见第三部分） | L3 第一块砖（审计报告）、L1 信任债清零（G1-G6）、可分发 CLI 起步 |
| **中期**（+1~2 个迭代） | 评测台 v0（先验证 `applyVariables` 覆盖 `agentKind`，覆盖则几乎免费）；运行级成本记账 v0（时长/模型/重试先记，token 能拿多少拿多少）；**风险分级放行**（低危自动/高危必审——治"权限二选一"痛点）；回放器 v0；多机聚合（HerdrOps 接缝，worktree 移执行机侧）；Windows 原生适配（#4 的 `inPath` 已起步）；引擎改进候选（G10 克隆黑板别名聚合、对账增强） |
| **远期**（季度+） | 回执开放格式草案 + 签名；合规包（三态门映射 / SOX 叙事——付费意愿最高的企业楔子）；bot-space B2 记忆 → B3 值班 → B4 市场；模板市场冷启动（先 10 个"真实到有味道"的骨架）；可保险叙事探索 |
| **候选池**（不承诺） | i18n、web 组件测试全覆盖、移动端阶梯（PWA → 飞书/钉钉卡片 → 小程序）、真机冒烟自动化 |

## 2.4 诚实检验：什么会杀死它

| 风险 | 概率 | 对策 |
|---|---|---|
| **厂商吞并**：Claude/Codex 原生做编排+审计（五年内大概率） | 高 | **跨厂商中立性是唯一护城河**（Terraform 之于多云）：厂商审计永远只覆盖自家 agent，PaneFlow 回执天然跨 17 种；评测台是中立性最佳展品 |
| **Herdr 单点耦合** | 中 | HerdrOps 接缝已证明可替换（fake-ops）；多后端（tmux/纯进程）是期权，不急行权 |
| **模板冷启动**：空市场是死广场 | 高 | 用作者真实工作当种子（v6 #8）；先 10 个真实骨架再谈市场 |
| **观赏性疲劳**："看 agent 干活"会腻 | 高 | 回头客价值锚定回执+评测（可持续资产），观赏只做获客钩子 |
| **独行侠带宽** | 高 | 两周冲刺制：每波出可见物，信任栈一层一层爬 |

---

# 第三部分 · v6 两周冲刺（把方向变成砖）

> **按第〇部分修订后的执行序**：Gate 0 优先——`#1 → #5 → #7 → #8（Gate 0：真实数据试跑+审计报告）`，跑通后才继续 `#3 → #6 → #4 → #2(降级)`；README/陌生人包装与回放器已移出本 sprint；CLI（原第 3 波）提前为 ProcessOps 滩头阵地，在 Gate 0 通过后立即启动。

## 3.1 冲刺路线图

### 第 1 波 · 还债与上锁（Day 1-3）

| # | 事项 | 主要文件 |
|---|---|---|
| 1.1 | 自动保存守卫（G3+G9）：variables/条件边/描述纳入变更检测；autosave key 按空间分 | `store.ts`、`graph-serialization.ts` |
| 1.2 | CORS 收紧同源默认 + 跨站 Origin 校验（G2） | `http.ts`、`config.ts` |
| 1.3 | reconciler 通电（G1） | `engine.ts`、`index.ts` |
| 1.4 | Planner agentKind 探测（G4），顺修 Windows 探测 | `dispatch.ts`、`env-check.ts` |
| 1.5 | 小修包（G6 全项 + P8 的 engines 字段） | 各文件 |

### 第 2 波 · 首跑体验 + 交付审计报告（Day 4-8）

| # | 事项 |
|---|---|
| 2.1 | **8 骨架 variables 补全** + 播种升级（老用户模板安全补种，不覆盖用户编辑） |
| 2.2 | **S9 交付审计报告**：`GET /api/runs/:id/report` 自包含 HTML；RunsCenter「📄」入口；零引擎改动 |
| 2.3 | **README 重写**：一句话定位 → 30 秒 demo → 与软编排一屏对比表 → 诚实边界 → 分平台安装（含 Windows=WSL） |
| 2.4 | （弹性）真实场景骨架：S5 数据治理批次 或 S1 多仓并行 |

### 第 3 波 · 可分发（Day 9-11）

| # | 事项 |
|---|---|
| 3.1 | **CLI headless**：`paneflow run <template> --var k=v --wait --json`，退出码 = 验收断言是否全过 → 可塞 GitHub Actions |
| 3.2 | 安装路径文档化：Unix 原生 + Windows/WSL + 前提版本清单 |
| 3.3 | （弹性）真机冒烟进 CI（self-hosted runner 或 continue-on-error job） |

### 第 4 波 · 想象力弹性位（Day 12-14，二选一）

| 选项 | 内容 | 成本判断 |
|---|---|---|
| **A. Agent 评测台 v0** | 同骨架 `--var agent=claude/codex` 对跑 + 报告并排。前提验证：`applyVariables`（`shared/dag.ts:421-467`）若覆盖 `agentKind` 则几乎免费 | 低。传播钩子最强 |
| **B. 运行回放器 v0** | 时间线 scrubber，数据已全有，纯前端 | 中 |

## 3.2 文件级实现方案

**#1 自动保存守卫（0.5 天）** — `graph-serialization.ts` + `store.ts`
- 根因见 G3：只补变更检测，序列化零改动。`graph-serialization.ts` 导出纯函数 `autosaveChanged(prev, next)`：对 nodes/edges/graphName/cwd/**graphVariables/graphMeta** 六字段引用级比较（zustand 每次更新产生新引用）；放纯模块是因 store.ts 模块级 `localStorage` 无法在 node 环境 vitest 导入。
- `store.ts:422-430` 订阅改用该守卫；条件边经 `updateEdgeCondition` 已触发 edges 引用变更，天然覆盖。
- G9 修复：autosave key 改 `` `pf-canvas-autosave:${getSpace()}` ``，`restoreAutosave()` 与写盘处同步（旧 key 不迁移）。
- 测试：`graph-serialization.test.ts` 追加——六字段同引用→false；仅换 variables 引用→true；仅换 meta→true；仅换 cwd/graphName→true。

**#2 reconciler 通电（0.5 天）** — `engine.ts`
- 接线点选 `startRun()` 内（runs.set 之后、execute 之前）调 `startReconciler()`：无运行无对账对象；自带幂等守卫；不必改 private。
- 重写 `startReconciler`：`reconcileIntervalMs ≤ 0` 直接 return（**防 `setInterval(0)` 4ms 空转打爆 herdr**）；`reconciling` 重入标志；`.catch` 记 warn（防 unhandled rejection）；`timer.unref()`。
- `reconcile()` 内守卫：blocked 且 `blockedWaiters.has(...)` 时 skip——防人工闸挂起时轮询翻状态造成审批卡与 waiter 错位。
- 测试（engine.test.ts 追加）：改状态但**不触发** statusSubs（模拟事件丢失）→ 轮询纠偏；状态回翻→正常 completed；interval 0 → 探测计数不增长；getAgentStatus 抛错→无 unhandled rejection。

**#3 CORS + 跨站加固（0.5–1 天）** — `http.ts` + `config.ts`
- `origin: true` → 有 `PF_CORS_ORIGINS`（逗号分隔白名单）按白名单，否则 `origin: false`（不发 CORS 头）。
- 补 mutating 方法（POST/PUT/PATCH/DELETE）Origin 校验钩子（origin:false 堵不住 simple request）：无 Origin 放行（curl/脚本/CLI/代理）、`Origin.host === req.host` 放行（同源）、白名单放行、其余 403；URL 解析失败即拒。抽纯函数 `isAllowedOrigin` 便于单测。
- 影响评估：生产同源托管、vite proxy、curl 全不受影响；唯一被挡的正是跨站驱动 API。反向代理改写 Host 的部署需配 `PF_CORS_ORIGINS`。
- 测试：新建 `http-cors.test.ts`（app.inject）——跨站 GET 无 CORS 头；跨站 POST 403 且数据未创建；同源 POST 成功；白名单 OPTIONS 回显。

**#4 dispatch Planner 不写死 claude（0.5 天）** — `dispatch.ts` + `http.ts` + `env-check.ts`
- `DispatchOptions` 加 `preferredAgentKind`；http 层构建图前 `detectInstalledAgents(...)` 取第一个（60s 缓存零成本）；空列表 warn 后兜底 'claude'。
- 顺修 Windows：`env-check.ts` 的 `probeBinary` 在 win32 走纯 fs PATH 扫描（导出 `inPath(bin)`：PATH × PATHEXT statSync），POSIX 保留 `sh -c command -v`；同时修好 /api/health 在 Windows 上 agentsInstalled 恒空。
- 测试：dispatch.test 追加 preferred 生效/兜底/DAG 校验；新建 env-check.test（dummy 可执行 + PATH 注入 + 缓存清理）。

**#5 小修包（0.5 天）**
- 5a 版本统一：`vite.config.ts` 读根 package.json 注入 `__PF_VERSION__` define + `globals.d.ts` 声明 + `App.tsx` 使用。
- 5b 兜底去硬编码：store 增 `defaultAgentKind` 字段，App.tsx health 回调写 `agentsInstalled[0] ?? agentKinds[0] ?? 'opencode'`，`addNode`/`scaffoldStarter` 改用它。
- 5c 裸 fetch：api.ts 加公共 `fetchJson<T>`（查 `r.ok`、抛 `{error}`），替换 SettingsView 五处 + RunsCenter 归档。
- 5d `http.ts:495` 死表达式删除；5e `dag.ts:77` 注释改与引擎一致。

**#6 S9 交付审计报告（1–1.5 天，第二波最高优先）** — 新建 `api/report.ts` + `http.ts` 路由 + `RunsCenter.tsx` 按钮
- `GET /api/runs/:id/report`：复用 export 端点的 engine→store→archive 三级回退（覆盖归档运行），返回 `renderRunReport(run)`——纯函数、模板字符串 + 内联 `<style>`，零 JS 零构建依赖零引擎改动。
- 九区块：①头部（runId/状态/骨架/起止耗时/cwd/issueId/时间戳）②任务与骨架（description+变量表；`run.graph` 是 applyVariables 后的图，按实际注入值展示）③DAG 总览表 ④逐节点产物（**source 徽标** file/output-fallback/empty，快照末帧 4KB 折叠）⑤**AC-N 验收矩阵**（断言面+各 impl__N 分支+verify 终审+来源标注；无断言面时明示）⑥审批记录 ⑦时间线尾 ≤60 条 ⑧风险清单（有 errors 的产物/attempts>1/终审 fail 的 AC）。
- **转义红线**：所有 Agent 产出过 `esc()` 全转义（GET 可达 HTML 防 stored XSS）；禁内联事件、零 `<script>`。
- 测试：fixture（ok/fail 分支 + failed 节点 output-fallback 产物 + 审批事件 + 500 events + XSS 注入串）——矩阵呈现、`&lt;script&gt;` 转义、旧记录缺字段不抛。

**#7 骨架 variables 补全 + 播种升级（1 天）** — `builtin-templates.ts` + `shared/dag.ts`。**必须排在 #1 之后合入**。

| 模板 | 新增变量声明 |
|---|---|
| issue-triage | `brief`（required）、`issue_id`（可选）；explore prompt 改真插值 |
| generic-issue-delivery | **修真 bug**：dispatch 路由传了 `{task}` 但模板从未声明 → 静默丢弃。声明 `task` 并在 align prompt 引用 |
| parallel-module-dev | `project_brief`、`modules_root`（默认 `modules`，四分支 cwd 改插值） |
| standard-dev-flow | `feature` |
| risk-approval-flow | `upgrade_scope`（默认 `patch`） |
| bug-fix-pipeline | `bug_brief` |
| role-team-review | `feature_brief` |
| research-compare | `plan_a` / `plan_b` / `eval_dims` |

- 播种升级：metadata 加可选 `builtinVersion`，八模板标 v2。`seedBuiltinTemplates` 三段：不存在→播 v2；`builtinVersion >= 2`→永不碰；**无该字段**（旧版播种、大概率已被旧 bug 剥掉 variables）→纯增量：仅当用户模板自己没有 variables 时补入+回写版本，nodes/edges 一律不碰。
- 测试：变量 key 不与节点 id 冲突；升级用例（label 保留+variables 补入）；已声明不覆盖；v2 用户版零触碰。合入后对 generic-issue-delivery 跑一次 fake-ops dispatch 全链路确认到位。

**#8 S5 数据治理批次骨架 `builtin-batch-data-governance`（1 天）** — 新内置模板（8→9）
- 结构：`prepare`(读 `{{batch_source}}` 清单切批，产 `extra.batches`) → `fanout expand` → `impl` 逐批处理（产出约定写 `output/<批次名>/`——**目录约定是克隆节点共享 cwd 下唯一隔离手段**，数据目录非 git 仓 worktree 不生效）→ `fanin requireAll:false` → `verify`（**绕开 G10：直读 `.herdr/artifacts/impl__*.json`**，不引用 `{{impl.artifact.summary}}`）→ `wrapup` 产 `batch-report.md`。
- 变量：`batch_source`（required）、`batch_prompt`（required）、`batch_size`（默认 50）、`acceptance_template`（默认四条核对模板）。
- 测试：模板通用四用例；仿 engine.test expand 用例端到端（prepare 写 batches 两项 → impl__1/impl__2 done、impl skipped、prompt 含 `output/批次01/`）。

### 合入顺序与砍半策略

```
#1 自动保存守卫 ──→ #7 骨架 variables+播种 ──→ #8 S5 骨架（复用 #7 模式）
#5 小修（独立）                        #6 审计报告（零依赖，#1 完成后即可并行）
#2 reconciler（独立）  #3 CORS（独立）  #4 dispatch（独立）
```

- 建议顺序：**#1 → #5 → #7 → #2 → #3 → #4 → #6 → #8**。
- **必保**：#1、#3、#6、#7 最小子集（旗舰两模板+播种升级——只做声明不做播种升级等于没做）。
- **可砍**：#2（纵深防御，至少注释标明 `PF_RECONCILE_MS=0` 空转坑）、#4（降级为启动 warn）、#8（晚一周无利息）、5c 降级。

## 3.3 不做什么（红线重申）

- **不破确定性红线（D3）**：AI 只选模板不画拓扑。
- **不做**：公网 SaaS / 多租户、Herdr 内核改造、第三方 DAG 引擎替换。
- **本 sprint 不做**：Bot Space B1（北极星另立迭代）、多机聚合、i18n、web 组件测试全覆盖、Windows 原生代码适配（仅文档化 WSL 路径）。

## 3.4 验收标准（sprint 出口条件）

1. **陌生人测试**：没见过项目的开发者按 README 30 分钟内完成 装 → 真实输入首跑 → 打开审计报告。
2. **CI 消费测试**：`paneflow run --wait` 退出码被一个真实 GitHub Actions job 消费。
3. **信任测试**：CORS 加固后同源使用无感；跨域默认拒绝有测试覆盖。
4. **质量底线**：全部测试绿 + typecheck 过 + 既有浏览器断言（40+27 条）不回退。

---

# 第四部分 · 附录 A：#308 二次下发排障复盘（2026-09-14）

> 背景：用 PaneFlow 派 pi 生成 #308 上线内容文档。v1 run（83091b4f，469s）成功；改写为"最终上线口径"的 v2 后重新下发，两个 run（0d2f00a1、fb74001f）共 4 次节点 attempt 全部以 `herdr agent_prompt_stalled` 失败。本附录从交互记录解剖约 85 分钟的排障耗时去向，回答"为什么这么久"。

## A.1 时间线与耗时分布

| 阶段 | 耗时 | 内容 | 结果 |
|---|---|---|---|
| 失败确认与现场勘查 | ~10 min | 两 attempt 判杀；`.tmp-check-herdr.js` 连管道 ENOENT（bash→node 反斜杠被吃，首次踩坑）；失败 pane 已被引擎 workspace.close，`herdr agent list` 无此 agent，无现场可查 | 拿到错误码与 seq 冻结证据（80/82） |
| 引擎修复①＋测试基线混乱 | ~15 min | 加 `promptSettleDelayMs`；全量 `pnpm test` 198s 挂 11 个；`git stash` 做 baseline——**基线无效**（工作区携带 56 提交量的未提交变更，stash 回到远古 HEAD，对照的是另一份代码） | 修复合入但非根因 |
| 服务重启 ×4 | ~10 min | bash `nohup … &` 静默死 → PowerShell 直启 herdrOk:false（丢了 IDE 启动时携带的 `PF_HERDR_SOCKET`）→ 内联 env 转义吃反斜杠（命名管道路径的双反斜杠被吃掉一层）→ 写 `.cmd` 批处理成功 | 发现隐性 env 依赖；沉淀 .cmd 启动器 |
| 带 settle 重跑 | ~3 min | run fb74001f：事件流证实"就绪稳定等待 4000ms"生效，仍 stalled | 排除"提交时机"假设 |
| 隔离实验群 | ~35 min | 详见 A.2——结论是**系统时间维不稳定**，非配置问题 | 定位两类故障形态（A.2） |
| 综合与 fire 方案设计 | ~5 min | 证据链闭合：prompt 均已送达、回复已产出，死于 5s 判杀窗 | 设计出 fire＋确认窗修复（A.4） |
| 复盘写作中的复核 | ~5 min | 发现"默认惰性"声明名不副实：fallback 仍 `?? 4000`（改了注释没改代码），**11 个测试失败里 10 个是自己引入的**；修正为 `?? 0` 后 35 例只剩 1 例 pre-existing | 惰性默认必须对照实验验证 |

## A.2 隔离实验群：两类故障形态

| # | 实验 | 结果 | 推论 |
|---|---|---|---|
| 1 | 全新 cwd ＋好 env＋小 prompt＋4s settle | stalled；visible 只有 `& pi`，TUI 未渲染 | 形态一：死 pane |
| 2 | 体检：cc-switch 200 / `pi -p` 正常 / 22 个 node.exe | pi 本体与网关健康 | 排除配置/网络 |
| 3 | mv 走 9 个 sessions 文件重测 | 仍 stalled | 排除会话堆积 |
| 4 | md5 对照 v1/v2 两份配置目录 | 文件全等却一成一败 | （假象，实为时间维漂移） |
| 5 | 全新目录 clean-agent2 | **SUCCESS 2.6s** | 引出"目录级差异"错误方向 |
| 6 | v1 去 PI_OFFLINE | stalled | 排除 OFFLINE |
| 7 | 去掉 bin/（probe4） | stalled **但 pi 实际回复了"就绪"**＋Update Available 横幅 | **prompt 已达、回复已产**，死于判定而非执行 |
| 8 | 矩阵复测（v1＋v2） | **双 stalled**；c-v1-off 事后翻到 done/seq95 | 10 分钟前成功的配置也失败＝**时间维不稳定，配置二分法在此失效** |

**形态一「死 pane」**：TUI 不渲染、status/seq 冻结 20s+。疑与当日几十次 pane 分裂/回收后的 PTY/conhost 资源劣化相关，重开新 pane 有概率自愈——现有 retryCount 机制是正解。
**形态二「慢翻转」**：TUI 正常、prompt 送达、回复已产出（实验 7 直接可见），但状态翻转耗时 5-10s > herdr 5s 判杀窗 → 被误杀（实验 8 事后 done/seq95 铁证）。上午 v1 成功（状态翻转 <5s）本来就踩在硬币边缘。

## A.3 直接根因（产品缺陷，已定位）

1. **herdr 5 秒判杀窗不可配**：`agent_prompt_stalled` 在 prompt 后 5s 无 seq 变化即杀，把"慢而有效"判成"失败"。
2. **PaneFlow 双重等待放大缺陷**：`promptAgent`（`herdr-ops.ts:85`）把 wait 交给 herdr（内含 5s 判杀），引擎随后又调 `waitForSettle`（`engine.ts:1230`）——herdr 侧等待纯负资产。
3. **失败即毁尸**：节点失败后立即 workspace.close，排障只能靠事件流反推，无法直视现场。

## A.4 修复设计：fire＋确认窗

- `promptAgent` 去掉 wait 参数（提交即返回），settle 全权交给引擎自己的 `waitForSettle`（deadline＝节点超时，45min）。
- 风险对冲（形态一 prompt 石沉大海会干等 45min）：加"确认窗"——prompt 后 45s 内无任何 seq/status 变化判死 pane，快速失败进 retry；有变化则交给 `waitForSettle` 全程等待。
- 与 P7 同向：把"等待/判定"逻辑从 herdr 协议拿回引擎适配层。

## A.5 方法论失误（本可省 ~40 分钟）

| 失误 | 代价 | 教训 |
|---|---|---|
| `git stash` 当基线 | ~8 min＋风险 | 大未提交工作区禁用 stash 基线；正解是改动设计成默认惰性，免除基线需求 |
| "惰性默认"只改了注释 | 10 个测试失败误判为 pre-existing | **惰性声明必须对照实验验证**（改前后失败数对比），不能靠自觉 |
| 全量测试先行 | ~4 min | 198s 全量 → 应先跑单文件（20s）定向 |
| bash/PowerShell 内联反斜杠 | 3 次往返 ~10 min | 含管道路径的命令一律落文件或 .cmd，绝不内联 |
| 隔离实验无对照组 | ~15 min | 实验 5 的一次成功引向"目录级差异"歧途；**每个实验前先重跑上次已知成功配置**，矩阵对照一跑就揭穿时间维问题，但它被排在最后 |

结构性约束：一次 herdr trial 固定成本 1-2.5 min（agent.start 20-40s＋等待），10 次实验 ≈ 25 min——假设质量比数量重要。

## A.6 对 v6 计划的回灌

| 本复盘认知 | 对应计划项 | 强化结论 |
|---|---|---|
| 5s 判杀×双重等待把慢启动变失败 | P7 | prompt 通道去 herdr-wait 化（fire＋确认窗），一次修掉整类问题 |
| 失败 pane 即毁 | #6 审计报告 | 失败节点 visible 快照入 RunRecord（修 #6 时一并落） |
| Windows 转义/分离进程地狱 | G5 | 维持先文档化；.cmd 启动器方案已沉淀 |
| herdr 状态劣化且不可复位（重启它会杀全部用户终端） | 2.4 单点耦合 | ProcessOps 优先级的现场论证 |
| 上午成功＝硬币边缘 | Gate 0 | 验收加"≥3 次连跑稳定"——跑通一次≠可重复跑通 |

## A.7 当前状态

- 已合入：`promptSettleDelayMs`（`engine.ts:778` 默认 0；`index.ts:27` 服务入口 4000）——必要但不充分；engine.test.ts 35 例仅剩 1 例 pre-existing 失败（artifact 绝对路径断言过时，属未提交变更的既有问题）。
- 已设计待验证：fire 模式 `promptAgent`（验证脚本已备）。
- 阻塞中：#308 最终口径文档（v2 prompt 3399 字符与模板 `issue-308-launch-recap-pi` 均就绪）。
- 待清理：`.tmp-*` 调试脚本群、`pi-clean-agent2/-nobin/-sessions-bak`、`pf-probe-a` 临时目录。
