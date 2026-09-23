# PaneFlow v5 验收回执 + 价值挖掘（第一轮）

> 核实方式：对 `4d00cc3..afdfc17` 共 11 个提交逐条比对 `docs/iteration-v5-product-readiness.md` 的验收标准，**以代码与实测为准**（不看提交信息自述）。
> 实测时间：2026-09-12。质量门禁：`pnpm typecheck` 通过；`pnpm test` = **server 82/82 + web 4/4 = 86/86 全绿**（上版 78，新增 4 个前端往返测试 + 4 个引擎用例）。

---

## 0. 总体判断

| 维度 | 结论 |
|---|---|
| **完成度** | **R1/R2/R3/R4 全部达标；R5 部分达标；R6 有 1 项致命失效** |
| **代码质量** | 高。R1 的修法尤其正确——没有打补丁，而是**抽出独立的序列化层** `graph-serialization.ts` 并配了往返测试，从架构上根除"画布只认识 UI 能渲染的字段"这个根因 |
| **最严重问题** | **R6.1 的 CI 永远不会触发**（触发分支 `main` vs 实际分支 `master`）→ 86 个测试的自动化保护实际为零 |
| **剩余缺口** | 6 处，其中 2 处"有数据无出口"（R5.3/R5.4），1 处"有机制无覆盖"（R3.5 孤儿 worktree） |

一句话：**这版把"能力"补齐了，但把"能力被真正用上"这件事漏了几处**——和上一版"引擎有、UI 无"是同一种病，只是这次换到了运维与 CI 层。

---

## 1. 验收状态矩阵

### 迭代 1 · 数据完整性 —— ✅ 全部达标（且修法优于要求）

| 需求 | 状态 | 证据 |
|---|---|---|
| R1.1 `toGraph()` 透传 `variables` | ✅ | 新建 `packages/web/src/graph-serialization.ts`；`rfToGraph()` 第 141 行 `...(variables.length ? { variables } : {})` |
| R1.2 边往返保留 `condition` | ✅ | `graphToRfParts()` 第 100 行写入 `data.condition`；`rfToGraph()` 第 133 行写回 |
| R1.3 metadata 保真 | ✅ | 第 137 行 `createdAt: meta.createdAt \|\| now`（不重置）、139 行保留 `description` |
| R1.4 前端往返测试 | ✅ | `graph-serialization.test.ts` 4 用例，覆盖 variables/condition/metadata/节点深字段 |
| R1.5 超时文案 | ✅ | `PropertyPanel.tsx:165` 已改「0=默认30」 |

**额外做对的**：`store.ts` 的 `toGraph()` 现在只是 `rfToGraph()` 的薄封装（第 247 行），`dagToRf()` 旧路径已删；`openRun()` 也切到新序列化层（第 308 行）。这是**根因修复**，不是补丁。

### 迭代 2 · 能力可达 —— ✅ 全部达标

| 需求 | 状态 | 证据 |
|---|---|---|
| R2.1 条件边面板 | ✅ | `Canvas.tsx:54` `onEdgeClick`；`PropertyPanel.tsx:14-84` `EdgeConditionPanel`（field + equals/notEquals/exists 三态 + 移除条件） |
| R2.2 checks 编辑 | ✅ | `PropertyPanel.tsx:213-252`，四类门禁增删改齐全 |
| R2.3 fanout expand 编辑 | ✅ | `PropertyPanel.tsx:310-335`（`from.field` + `onEmpty`） |
| R2.4 variables 声明编辑 | ✅ | 新建 `VariablesEditor.tsx`，已挂载 `OrchestrateView.tsx:148` |
| R2.5 画布自动保存 | ⚠️ **有漏判** | 800ms 防抖 + `restoreAutosave()` 已在 `App.tsx:50` 调用，但见 §2.5 |
| R2.6 rootCwd 三入口 | ✅ | 最近使用（localStorage `pf-recent-roots`）+ 目录浏览（`/api/fs/browse`）+ 拖拽（`SettingsView.tsx:312` `onDrop`） |

### 迭代 3 · 并发可信 —— ✅ 主体达标，1 处覆盖缺失

| 需求 | 状态 | 证据 |
|---|---|---|
| R3.1 worktree 隔离 | ✅ | `engine.ts:1129 createWorktree()`，`git worktree add` 独立目录+独立分支；`engine.ts:649-658` 同 run 兄弟撞仓即隔离 |
| R3.2 软锁排队 | ✅ | `engine.ts:659-669` 跨 run 撞仓 → `queued` + 轮询等待 + 超时退出 |
| R3.3 启动前脏检查 | ✅ | `engine.ts:106-121` `git status --porcelain`，拒绝启动并给出变更清单；`PF_DIRTY_CHECK=0` 可关 |
| R3.4 同 issue 幂等锁 | ✅ | `engine.ts:177-185` 同空间同 issue 拒绝重复下发 |
| R3.5 worktree 生命周期 | ⚠️ **半成品** | 见 §2.4 |

**实现偏差（可接受，但需记录）**：v4 设计 D8 写的方案是用 herdr 原生 `herdr worktree create`，实现改成了直接 `git -C <repo> worktree add`（`engine.ts:1134`）。功能等价且更可控，但**只对 git 仓库生效**，非 git 目录无隔离——这一点 v4 文档未写明。

### 迭代 4 · 安全与远程 —— ✅ 全部达标（1 处策略需确认）

| 需求 | 状态 | 证据 |
|---|---|---|
| R4.1 访问令牌 + host 可配 | ✅ | `config.ts:65` `PF_HOST`；`config.ts:29-42 ensureAuthToken()`（0600 落盘，`PF_TOKEN` 可覆盖）；`http.ts:102-109` `onRequest` 钩子验 `Bearer`；`index.ts:41-43` 启动仅展示一次 |
| R4.2 `/api/fs/read` 收敛 | ✅ | `fs-routes.ts` 签名改为 `resolveRoot(space)`，root 由**服务端 Space 档案**给出，客户端不再能传任意 root |
| R4.3 注入审计 | ✅ | `http.ts:113-130` JSONL 落 `audit.log`，`keys`/`input` 两端点接入（554/569 行） |
| R4.4 移动端审批 | ✅ 实现就位 | `styles.css:403,411` 响应式断点 900px/640px；真机放行需人工验一次 |

**策略提醒**：`config.ts:31` 在 `host=127.0.0.1` 且未设 `PF_TOKEN` 时**完全关闭鉴权**（"本机信任模式"）。这是合理的 DX 取舍，但要明确它意味着：**只要本机任何进程/浏览器页面能访问 4310，终端注入面就是敞开的**。建议要么在 README 里显著声明这一前提，要么对 `/input`、`/keys`、`/api/fs/*` 这三个高危端点**无条件要求令牌**。

### 迭代 5 · 可运维 —— ⚠️ **仅 1/4 达标，是本轮最大短板**

| 需求 | 状态 | 证据 |
|---|---|---|
| R5.1 归档 + **检索** + 导出 | ⚠️ 缺检索 | 归档 ✅（`store.ts:166-174 archiveRun` 移入 `archive/`）、导出 ✅（`http.ts:523` + `RunsCenter.tsx:107`）；**检索/筛选 UI 完全没做**，`RunsCenter.tsx` 只有排序，没有按 space/issue/模板/日期/状态的筛选入口 |
| R5.2 解除 50 条截断 | ✅ | `store.ts:156` 注释与实现均已改全量 |
| R5.3 结构化日志 + 事件时间线 | ⚠️ **有数据无出口** | 服务端全做对了：`run.events`（`engine.ts:1331-1336`，环形 500 条）+ 6 类事件埋点 + `GET /api/runs/:id/events`（`http.ts:505-509`）。但**前端零消费**——全 `packages/web/src` 搜不到任何时间线渲染 |
| R5.4 交付质量看板 | ❌ **未落地** | `RunsCenter.tsx:5-10` 定义了 `nodeDuration()`，然后**全文件再无调用**——死代码。耗时分布/重试率/失败原因聚类一个都没有 |

### 迭代 6 · 分发与形态 —— ❌ 1 项致命失效

| 需求 | 状态 | 证据 |
|---|---|---|
| R6.1 LICENSE + CI | ❌ **CI 失效** | `LICENSE` ✅（MIT）；`.github/workflows/ci.yml` ✅ 存在且内容正确（typecheck→test→web build）。**但第 5、7 行触发分支写 `main`，而本仓实际分支是 `master`** → 推送/PR 永不触发，门禁形同虚设 |
| R6.2 一键启动 | ✅ | `package.json` 新增 `"start": "pnpm build && pnpm dev:server"`；`http.ts:2,83-95` `@fastify/static` 托管 `packages/web/dist` + SPA 回退 |
| R6.3 零环境引导 | ✅ | `App.tsx:86` `EnvWizard` 保留并接入 |
| R6.4 文档对齐 | ⚠️ **漏 1 处** | PropertyPanel 文案 ✅（R1.5 已修）；README 已补智能下发/模型网关（第 17、20 行）✅；**但 `docs/iteration-issue-driven.md:371` 的错误 REST DELETE 断言仍在**——本轮明确点名要改的三处漂移之一 |
| R6.5 断点续跑 | ✅ | `engine.ts:230-254` 继承 done 节点 + 黑板预载；`engine.ts:175` `resumeOf` 参数；引擎测试新增 `R6.5 resume: done nodes inherited, failed node re-executes only` 用例通过 |

---

## 2. 六处缺口的修法与优先级

| # | 缺口 | 影响 | 修法 | 优先级 |
|---|---|---|---|---|
| 2.1 | **CI 触发分支错**（R6.1） | 86 个测试的自动化保护 = 0；这是"安全网没接上"，后续所有改动都在裸奔 | 改 `.github/workflows/ci.yml` 的 `branches: [main]` → `[master]`（或在 GitHub 把默认分支改为 `main`） | **P0 · 一行改动** |
| 2.2 | **事件时间线无出口**（R5.3） | 已埋 6 类事件、500 条环形缓冲、专用端点——**数据全在，用户看不到**。可观测性的价值全被卡在最后一跳 | `RunsCenter` 的「打开」按钮旁加时间线抽屉，消费 `/api/runs/:id/events` | **P0 · 性价比最高** |
| 2.3 | **质量看板死代码**（R5.4） | `nodeDuration` 已写好却未调用；无法回答"哪个节点最慢/谁在反复重试" | 在运行卡片内展开节点耗时条形 + 重试次数徽标；失败原因按 `rec.error` 文本聚类 | **P1** |
| 2.4 | **孤儿 worktree 泄漏**（R3.5） | `reclaimWorktrees()` 只在 run 收尾调用（`engine.ts:360`）；`liveWorktrees` 是内存态，**进程重启后数组清空**，`os.tmpdir()/paneflow-wt/*` 永久残留，且仓库里 `git worktree list` 留下僵尸条目 | ① `recoverOrphans()` 增加 worktree 清理（扫 tmpdir + `git worktree prune`）；② 把 worktree 落在 repo 内 `.git/paneflow-wt/` 或登记到 disk 供重启后识别 | **P1** |
| 2.5 | **自动保存漏判变量改动**（R2.5） | `store.ts:344-352` 的订阅守卫只比较 `nodes/edges/graphName/cwd`；**只改模板变量（`setGraphVariables`）不会触发自动保存** → 刷新即丢，恰好落在 R1/R2.5 想堵的那类"静默丢数据"上 | 守卫里补 `graphVariables` 与 `graphMeta` 比较 | **P1 · 三行改动** |
| 2.6 | **检索能力缺失**（R5.1） | 历史能存全量了，却只能按时间顺序翻——运行一多就等于没有历史 | `RunsCenter` 加筛选条（空间/状态/Issue/模板/日期区间）+ 关键词 | **P1** |

> 其余小项：`engine.ts:106 checkDirtyRepos(graph, cwd, spaceId)` 的 `spaceId` 形参未使用；`pnpm test` 输出里出现 3 次 `fatal: not a git repository`——`gitRepoRoot`/`gitStatusPorcelain` 的 stderr 未抑制，属噪声，建议 `stdio: 'ignore'`。

---

## 3. 价值挖掘（第一轮）

前面两轮都在补"让已经有的东西真正可用"。这一节换个视角：**这个项目手里已经握着几张别人没有的牌，但都还没打出去。**

排序依据 = **已具备的基础有多厚 × 打出去后的杠杆有多大**。

### 价值脉络 1 · 「带证据链的交付」→ 一等公民的交付物 ★★★★★

**已经握在手里的**：`extra.acceptance`（AC-N 断言面）→ `extra.assertionResults`（每个 impl 分支逐条自测回写）→ `verify` 节点逐条核对 → `extra.events` 500 条事件流 → 每节点 `outputSnapshots` 终端快照留档。**这五样加起来，是一次运行的完整审计证据链，而且已经在真实运行里跑出来了**（`.herdr/artifacts/` 里就有）。

**现在的问题**：这些证据散落在 `runs/<id>.json` 里，对使用者而言是**运行副产品**，不是**交付物**。

**挖法**：把 `wrapup` 节点的产出从"git commit + Issue 评论"升级为生成一份**《交付审计报告》**（Markdown/HTML）：
- 断言矩阵：AC-N × 每个分支的 status × evidence（一眼看出哪条断言有证据、哪条是空口）
- 证据溯源：每条断言的 evidence 挂到具体节点、具体终端快照、具体时间点
- 风险清单：`errors` 非空的节点、`status: fail/n/a` 的断言、重试过的节点
- 一页结论 + 附录原始日志

**为什么是最高价值**：这直接命中"**明厨亮灶**"——让使用者看见 agent 到底做了什么、凭什么说做完了。市面所有 agent 编排工具交付的是"它说它完成了"；PaneFlow 能交付"**它凭什么说完成了，你自己看**"。这是差异化，也是信任的来源。而且**技术上是 100% 复用现有数据**，不需要新引擎能力。

### 价值脉络 2 · 引擎可脱离画布 → CLI / headless 入口 ★★★★☆

**已经握在手里的**：整个编排能力全是 API 驱动的（`POST /api/runs` 收 graph 或 graphId + variables 即可起跑），`HerdrOps` 是抽象接口，测试用 `fake-ops.ts` 就能全量驱动引擎。**换句话说，引擎早就不依赖画布了。**

**现在的问题**：唯一的入口是人在浏览器里点。**交付能力无法被 CI、脚本、定时任务调用。**

**挖法**：加一个 `paneflow` CLI：
```bash
paneflow run builtin-generic-issue-delivery --var issue_id=162 --cwd ~/repo --wait
paneflow status <runId> --json
paneflow approve <runId> <nodeId> --approve
paneflow report <runId> --out audit.md    # 与价值脉络 1 合流
```
**杠杆在哪**：一旦有 `--wait` + 退出码 + `--json`，PaneFlow 就能被塞进 GitHub Actions：「提 PR → 自动跑多 Agent 交付 → 产出审计报告 → 贴回 PR」。**这才是从"一个工具"变成"一条流水线"的跳跃。**

### 价值脉络 3 · 骨架库 + GitHub 沉淀 → 策展知识资产的流通 ★★★★☆

**已经握在手里的**：8 个内置模板 + `GithubSync` 双向沉淀/拉取（`templates/*.json`，已实测跑通）。设计里还规划了修复型/调研型/巡检型骨架。

**现在的问题**：骨架库被当成"内置模板"藏着，没人知道它的存在，也没法贡献。

**挖法**：把"骨架"提升为独立概念与流通资产——本地骨架库视图（含来源标记：内置/自建/拉取）、`paneflow skeleton pull <repo>` 一条命令拉别人的骨架、骨架带元数据（适用场景、所需角色、预期扇出宽度的 cost profile）。

**为什么值钱**：v4 的确定性红线 D3 说"AI 只选骨架、不生成拓扑"。**那么骨架库的质量就是这个产品的天花板**。骨架是唯一能沉淀"专家经验"的载体——一次优质交付编排可以复用到所有同类任务。而且 GitHub 沉淀机制已经通了，**分发渠道是现成的，只差把资产立起来**。

### 价值脉络 4 · 角色库 + 约定文档自动发现 → 团队工程规范的执行器 ★★★☆☆

**已经握在手里的**：全局角色库（agentKind + 约定文档集 + 前置/后置动作 + 检查集 + 提示词骨架）、项目档案 Convention/skills 自动发现勾选、`/api/fs/discover` 已能识别 repo 与 skills。

**现在的问题**：定位在"配置项"，没被表达成"治理能力"。

**挖法**：角色从"一个人的偏好"变成"**团队的规范执行器**"——角色绑定团队的 AGENTS.md / lint 规则 / 检查集，任何走这个角色的 Agent 自动继承；运行结束产出"规范遵从度"（哪些约定被检查、哪条没过）。

**与你的既有体系天然咬合**：这正是 `chuanplus` 那套（catalog + Change 包 + 三态门）里"**三态门**"的多 Agent 版本——把"人遵守规范"换成"Agent 自动被执行规范约束"。

### 价值脉络 5 · HerdrOps 可替换 → 引擎可移植 ★★★☆☆

**已经握在手里的**：`HerdrOps` 抽象 + `fake-ops.ts` 全量 fake 实现，证明**引擎与终端底座是解耦的**。

**挖法**：评估再实现一个 backend（tmux / Docker exec / SSH 远端），或干脆把 `packages/server/src/orchestrate/` 抽成可独立发布的编排库。

**为什么值得评估但不急**：它的价值是"**未来可选**"——现在谈第二个 backend 是过度设计。但**意识到引擎本可移植**这件事本身有价值：它决定了 PaneFlow 是"一个 Herdr 的壳"还是"一个编排引擎"。建议只做**边界清理**（把 herdr 相关代码全集中在 `herdr/` + `herdr-ops.ts`，编排层零 herdr 依赖），不投入新 backend。

---

## 4. 建议的下一步（按投入产出的性价比排序）

| 顺序 | 动作 | 投入 | 产出 |
|---|---|---|---|
| 1 | 修 CI 触发分支（`main`→`master`） | 一行 | 86 个测试的自动化保护**首次真正生效** |
| 2 | 修自动保存守卫（补 `graphVariables`/`graphMeta`） | 三行 | 堵住最后一个静默丢数据口 |
| 3 | 事件时间线接出来（消费 `/api/runs/:id/events`） | 半天 | 已埋好的可观测数据**终于有出口** |
| 4 | 交付审计报告（价值脉络 1） | 1–2 天 | 把"证据链"变成可交付物——**差异化落地的第一步** |
| 5 | CLI `--wait` + 退出码 + `--json`（价值脉络 2） | 2–3 天 | 解锁 CI 场景，交付能力从"点界面"变"可编程" |
| 6 | 骨架库视图 + `skeleton pull`（价值脉络 3） | 2–3 天 | 知识资产开始流通 |

前 3 项是**还债**（把已经做的东西接通），后 3 项是**增值**（把手里的牌打出去）。
