# PaneFlow 迭代 v6 需求文档（自用验证冲刺）

> v1.1（2026-09-18 修订：按"目标→支柱→需求"重组，并吸收本轮评审 8 条修正）。
> 上游依据：`iteration-v6-oss-landing.md` 第〇部分判决 + Genspark 调研（见 2.3）。

---

## 一、目标：这个项目和这个迭代到底在干什么

### 1.1 三层目标（先钉死，再看需求）

| 层 | 内容 | 变化 |
|---|---|---|
| **北极星（项目级，季度）** | AI 劳动的信任层——回答"AI 干的活能不能信"：规格/隔离/验证/存证/问责五个原语已在代码里 | 不变 |
| **阶段目标（判决后）** | 不对陌生人承诺。先回答：**这台机器对我自己的真实工作，是否可信、可重复、有用？** 自用验证成立后才顺带公开 | 本轮锚定 |
| **本迭代目标（两周）** | 用一个真实数据任务（绿化台账批次）端到端跑一次完整证明：**跑得动 → 出得来我愿意留存的交付物 → 说得清成本和证据**。证伪即止损，项目降级为个人玩具 | 唯一任务 |

### 1.2 一句话读法

本迭代所有需求只服务两件事：**围绕目标加固**（它别误杀我、别丢我数据、别被人白嫖控制）和**围绕目标提体验**（它干完的活，我能看懂、能留存、能算账）。除此之外的功能一律不做。

---

## 二、四根支柱与需求映射

```
目标：真实任务完整证明
 ├─ 支柱一 跑得动 —— 执行层不再把"慢而有效"判成失败        → R1
 ├─ 支柱二 守得住 —— 数据完整性 + 本机安全（加固）          → R2, R3
 ├─ 支柱三 证得实 —— Gate 0 实验：3 连跑 + 执行层对照        → R4（核心）
 └─ 支柱四 说得清 —— 交付审计报告 + 成本账（体验）          → R5, R6
      地基杂务                                            → R7
```

### 2.3 Genspark 参照（为什么这三条机制值得抄进支柱四）

Genspark（MainFunc 旗下，前百度小度负责人景鲲创立；首轮融资 4.35 亿美元、估值近 19 亿美元，2026 年再报融资 3.85 亿美元；团队约 20 人，上线 9 天收入近千万美元；2026-08 发布开源 GenOffice）是 general-purpose agent 赛道商业化最重的对照品：Super Agent 拆解任务 → 并行子 agent → **全程直播规划与工具调用** → 产出**可直接用的交付物**（网页/Slides/Sheets）→ **credit 计费**。它证明了 agent 产品的护城河在**可信交付与成本计量**，不在模型——正是 PaneFlow 信任层叙事的商业化旁证。借三个机制，不抄形态（云端多租户、自然语言万能入口、模型比拼继续不做）：

| 机制 | 落到 |
|---|---|
| 过程直播、看得懂 | R5 报告"结论先行 + 过程人话化" |
| 交付物一等公民 | R5 报告本身即自包含 HTML 交付物 |
| credit 计费 | R6 成本记账 v0（补齐 L4"成本黑箱"缺口） |

---

## 三、需求详述

### 支柱一 · 跑得动

**R1 · fire＋确认窗收尾合入（原 T1）【P0，本迭代第一个动作】**

现状：工作区未提交 diff 已实现主体（`herdr-ops.ts` promptAgent 去 wait 化 + `engine.ts` 引擎侧确认窗 + `PF_PROMPT_CONFIRM_MS` 默认 45s）。

需求：
1. 错误信息硬编码"45s"改为 `confirmMs` 插值。
2. 确认窗轮询中 `getAgentStatus` 抛错按"无变化"处理并 warn——**注释写明这是有意选择**：herdr 查询接口整体故障时会在窗口末判死，宁可误杀重试不可挂起 45min。
3. 补 fake-ops 测试 4 例：立即 working 放行 / 始终 idle 到窗抛 stalled / status 抛错无 unhandled rejection / `confirmMs:0` 一次检查放行。
4. 合入后真实 herdr 上重放 #308 v2 prompt 一次，确认形态二（慢翻转）不再误杀。
5. **提交时拆 commit**：bot-space.md 文档改动与本 diff 分开。

验收：engine.test 全绿（现存 1 例 pre-existing 失败在 commit message 点名）；#308 重放通过。

### 支柱二 · 守得住

**R2 · 自动保存守卫（原 T2，修 G3+G9）【P0】**

G9 是全表唯一**丢用户数据**的缺陷：切空间触发自动保存，800ms 后用空画布覆盖上一空间未保存内容。
方案不变：`graph-serialization.ts` 导出纯函数 `autosaveChanged(prev,next)` 六字段引用比较（nodes/edges/graphName/cwd/**graphVariables/graphMeta**）；`store.ts` 订阅改用守卫；autosave key 按空间分（修 G9，旧 key 不迁移）；追加 4 例单测。
验收：任何空间切换路径不存在"空图覆盖他空间未保存内容"的写入。

**R3 · CORS 收紧 + 跨站校验（原 T3，修 G2）【P0】**

G2 与"可控可审计"品牌直接矛盾：任意网页可跨站停 run/发按键。方案不变：`origin:true`→默认 `origin:false`＋`PF_CORS_ORIGINS` 白名单；mutating 方法 Origin 校验纯函数 `isAllowedOrigin`（无 Origin 放行/同源放行/白名单放行/其余 403）；`http-cors.test.ts` 4 例。
验收：跨站 POST 403 有测试；同源、vite proxy、curl 无感。

### 支柱三 · 证得实（本迭代核心）

**R4 · Gate 0：数据治理骨架 + 绿化台账 3 连跑 + 执行层对照（原 T4）【P0】**

*骨架* `builtin-batch-data-governance`：`prepare`(读 `{{batch_source}}` 切批) → fanout expand → `impl` 逐批（输出目录约定 `output/<批次名>/` 做克隆隔离）→ fanin(requireAll:false) → verify（直读 `.herdr/artifacts/impl__*.json`，绕开 G10）→ wrapup 产 `batch-report.md`。模板测试 + fake-ops 端到端。

*"绿"的定义（一票否决闸的判据必须机器可判）*：**run 状态 completed + verify 终审断言全过 + wrapup 产物存在且非空**。三条缺一即该次不算绿。人工抽检批次质量另行记录，不入判据。

*实验设计*（方法论按附录 A 复盘教训：命令落文件、实验前先重跑已知成功基线）：

| 臂 | 内容 | 裁决 |
|---|---|---|
| A（herdr） | 真实批次 2×50 条起步，同一配置**连跑 3 次**（单次 run 含多节点 attempt，墙钟预计 1-3h：**采用隔夜串行跑**，最大等待窗 4h/次，超时视同失败并记录） | **Q1 场景价值**：3/3 绿=是；若 ≥2 次死于形态一（死 pane），判"Q1 待定、执行层问题实锤"转喂 Q2 |
| B（headless 对照，半天时间盒） | 最小脚本（已装 CLI 任选：`claude -p --output-format json`/`codex exec`/`opencode run`）手工跑**同一批次的 impl prompt**，对比成功率、结构化产物可得性、耗时 | **Q2 执行层方向**。结论边界：B 臂只裁决"headless 可行性方向"，**不裁决 ProcessOps 迁移成本**（worktree/审批/状态机均未经管） |

R6 的时长/attempt 记账（见下，Day3-5 先行合入）与本实验同窗完成，故 **Q3 成本可核算性** 在同一裁决点有真实数据可判：3 次 run 各产出一份 `run.cost`，缺数处 `unknown`。

验收：3 连跑记录（runId/耗时/绿否/失败点）+ B 臂观察笔记 + 三问各一页裁决，落 `docs/gate0-verdict.md`。

### 支柱四 · 说得清

**R5 · 交付审计报告（原 T5 + T6 的"报告区块"部分）【P1，Q1=是 才做】**

`GET /api/runs/:id/report` 自包含 HTML + RunsCenter「📄」入口。原 #6 九区块方案为基础，叠加 Genspark 机制：
1. **结论先行**：首屏四格——任务是否完成 / AC 通过率 / 风险数 / 成本（R6 数据）。
2. **交付物内嵌**：markdown 产物转义后渲染内嵌；`output/` 文件列相对路径清单。报告本身即"可直接留存复用的东西"。
3. **失败快照**：失败节点 visible 末帧入报告风险清单。**注意：此项需要引擎在 attempt 失败路径写快照，是全迭代唯一一处引擎改动**（不守"零引擎改动"口号）；若实施超预算，降级为弹性项，不阻塞 R5 其余部分。

红线不变：`esc()` 全转义、零 `<script>`、禁内联事件；fixture 测试含 XSS 注入串与缺字段旧记录。
验收：对 Gate 0 真实 run 产出一份作者认可"愿意留存"的报告（Q1 人工判断环节）。

**R6 · 运行成本记账 v0（原 T6，拆分提前）【P0 子集 + P1 展示】**

L4 缺口"成本黑箱"的最小补齐；Genspark credit 制印证可计量是信任前提。拆两段排期：
- **R6a（Day3-5，随 R4 合入，P0）**：attempt 结束记 `durationMs`，`RunRecord` 汇总每节点/整 run 的总时长、attempt 数、重试失败数；artifact 含 `usage` 字段则聚合进 `run.cost.tokens`（R4 的 impl prompt 已引导自报），拿不到明示 `unknown`——绝不造估算数。不做预算强制、不做熔断。
- **R6b（Day6-9，P1）**：报告首屏成本格 + 区块成本表（节点×时长×tokens，unknown 标注来源）。

验收：Gate 0 三次 run 各有 `cost` 数据；缺数处是 `unknown` 不是 0。

### 地基杂务

**R7 · 顺手修（原 T7 拆分 + T8）【P2，整项可砍】**

- **真 bug 顺手修（保留）**：`generic-issue-delivery` dispatch 传 `{task}` 但模板未声明导致静默丢弃——声明 `task` 并在 align prompt 引用（0.1d）。
- 小修包：版本统一 `__PF_VERSION__`、store `defaultAgentKind` 去硬编码、SettingsView 裸 fetch 换 `fetchJson<T>`、`http.ts:495` 死表达式、`dag.ts:77` 注释、根 `package.json` 加 `engines`；dispatch 写死 claude 只加启动 warn 一行。
- **移出本迭代（原 T7 其余部分）**：8 骨架 variables 全量补全与播种升级——它服务"首跑体验/陌生人目标"，已被第〇部分判决砍掉；Gate 0 用新建骨架，不经过旧模板。

---

## 四、执行序

```
Day 1     R1 收尾合入 + #308 重放验证          （跑得动，是一切实验的前提）
Day 2-3   R2 ∥ R3                              （守得住，全独立）
Day 3-5   R4 骨架 + R6a → 隔夜连跑 3 次（期间跑 R7、B 臂半天）
          ── Gate 0 裁决点：Q1/Q2/Q3 三问三页 ──
Day 6-9   Q1=是 → R6b → R5（对真实 run 出报告）
Day 10-11 缓冲：实验返工 / herdr 处置 / 裁决文档收尾
```

硬性关口：①R4 首跑前 R1 必须已合入并真实验证（否则形态二误杀污染实验）；②裁决点前不启动 R5/R6b；③R7 任何项挤占 R4 时间即让路。

## 五、出口条件

1. **裁决完成**（无条件即算交付）：`gate0-verdict.md` 三问各一页结论 + 证据 runId——无论成败。
2. Q1=是 时：3/3 绿（定义见 R4）+ 一份作者认可的 HTML 报告 + 成本区块有值或有 `unknown` 标注。
3. 质量底线（无条件）：测试全绿 + typecheck + 既有浏览器断言不回退 + R2/R3 各有拒绝路径测试。
4. 不再要求：陌生人 30 分钟装机、GitHub Actions 消费（随"开源给开发者"目标一并移出）。

## 六、风险

| 风险 | 对策 |
|---|---|
| 形态一（死 pane）复发污染 Q1 | "≥2 次死于形态一 → Q1 待定、Q2 提前实锤"是判据的一部分，不是意外 |
| 3 连跑墙钟超时挤占两周 | 隔夜串行 + 4h 超时窗；宁可缩批次（2×25）不跳对照实验 |
| 台账数据隐私 | 清单放 gitignore 目录；报告仅本地留存不外发 |
| token 两头落空 | R6a 明示 unknown，时长/attempt 账不依赖 agent 自报 |
| 单人带宽再被排障吃掉 | R1-R3 测试自证；实验命令一律落文件；B 臂半天时间盒，超时发现记入裁决不进实现 |

## 七、留给下一迭代的钩子（不承诺）

ProcessOps 立项（Q2 触发）/ `paneflow run` CLI / 8 骨架 variables 补全与播种（若公开目标复活）/ 评测台侦察 / G10 引擎改进 / reconciler 通电 / .tmp-* 调试脚本清理。

---

## 附：实施状态（2026-09-18）

代码侧全部合入（未推送）；真实环境验证待作者隔夜执行。

| 需求 | 代码 | 待验证 |
|---|---|---|
| R1 确认窗 | ✅ `5360f15`（含 `PF_PROMPT_CONFIRM_MS=0` 禁用路径，窗内错误信息带实际毫秒数） | #308 提示词在真实 herdr 重放：确认无误报 `agent_prompt_stalled` |
| R2 自动保存守卫 | ✅ `2f41d17`（autosaveChanged 六字段 + 按空间分 key + 切空间先落盘） | 无（单测覆盖） |
| R3 CORS 收紧 | ✅ `5360f15`（isAllowedOrigin 纯函数 + mutating 403 钩子 + `PF_CORS_ORIGINS` 白名单） | 9 个注入单测已覆盖拒绝路径；浏览器实机 403 一眼即可 |
| R4a 骨架 + R6a 记账 | ✅ `503215d`（第 9 模板 builtin-batch-data-governance；RunCost tokens 只取 agent 自报，否则 null） | 隔夜 3 连跑 + B 臂 headless 对照 → `gate0-verdict.md` |
| R7 顺手修 + 小修包 | ✅ `1bcc5c1` `a49dea0`（task 参数传递修复含回归防线、`__PF_VERSION__`、默认 Agent 走 health 安装探测、fetchJson 收编 8 处裸 fetch、README 补 R1/R3 变量两行） | 无 |
| R5 / R6b | —（执行序关口②：裁决点前不启动） | 取决于 Q1=是 |

临时 data-dir 冒烟已过：无 herdr 时服务正常起、9 模板播种、`builtin-generic-issue-delivery` 携带 `task` 变量。若日后 data-dir 存在旧副本模板文件，seed 不覆盖用户编辑，需删旧文件重启后下发才带上修复。
