# PaneFlow 迭代方向 v5：产品成熟度评估与迭代需求

> 评估方式：不采信既有文档结论，**以代码实测为准**独立复核。证据锚点一律给出 `文件:行号`，可在当前 master（4d00cc3）复核。
> 评估时间：2026-09-12。实测环境：node 22.22.2 / pnpm 10.28.0 / herdr 0.8.2（本机已装）。

---

## 0. 结论先行

| 判断 | 结论 |
|---|---|
| **工程成熟度** | **高（★★★★☆）**。编排引擎与 herdr 底座是真正的资产，78/78 测试全绿、类型检查通过、端到端真实跑通过多轮交付。 |
| **产品成熟度** | **低（★★☆☆☆）**。当前形态 = **单机开发者自用工具**，尚不是可交付给他人的产品。 |
| **最强的交付能力** | 「一句话下发 → 策展骨架 → 并行实现 → 验收断言核对 → Issue 回链 + git 收口」的全闭环。**这是我见过的完整度最高的确定性多 Agent 交付链路**，也是这个项目最值得产品化的东西。 |
| **离真正的产品差什么** | 不是缺功能，而是 **6 类"最后一公里"缺口**：数据完整性 → 能力可达 → 并发可信 → 安全可暴露 → 可运维 → 可分发。 |
| **最紧急的一条** | **画布保存会静默销毁数据**（`variables` / 条件边 / 模板描述）。旗舰骨架 `builtin-generic-issue-delivery` 已被这把刀架着——任何人打开它、点一次保存，`issue_id` 参数与模板描述就永久消失，连带击穿「智能下发」的 Planner 选型。**这是 P0，必须先于一切新功能**。 |

一句话总结：**这个项目的引擎是产品级，外壳是玩具级**。v5 的全部工作，就是把外壳补齐到引擎的水平。

---

## 1. 成熟度评估（证据锚定）

### 1.1 硬指标实测

| 指标 | 实测结果 | 结论 |
|---|---|---|
| 代码规模 | 8,974 LOC TS/TSX（4 包：shared / server / web / scripts） | 中等规模，单人可维护 |
| 单元测试 | **78 passed / 78**（10 个文件，28.4s） | ✅ 全绿（含此前记录的 fanout flaky 项，本次已稳定通过） |
| 类型检查 | `tsc -b packages/shared packages/server` 无输出 = 通过 | ✅ |
| 前端构建 | `packages/web/dist` 存在且已构建 | ✅ |
| 前端测试 | **0 个测试文件** | ❌ 最大测试盲区 |
| E2E | 仅 `scripts/smoke.ts`（147 行一次性脚本，非自动化回归） | ⚠️ |
| CI | **无 `.github`** | ❌ 无门禁 |
| 许可证 / 分发 | **无 LICENSE、无 Dockerfile、无安装器、无 Electron** | ❌ 无法对外交付 |
| 真实运行证据 | `.herdr/artifacts/` 有 11 份真实运行产物（triage / plan / impl×5 / wrapup 等） | ✅ 确实在真实使用 |
| 迭代治理 | 13 个批次 + §13 自闭环 8 项断环点审计，全部 ✅ | ✅ 治理规范度罕见地高 |

### 1.2 能力矩阵

把"设计里写了"和"用户真能用"分开看——这是本次评估最重要的视角。

| 能力 | 引擎实现 | UI 可达 | 画布往返安全 | 真实可交付 |
|---|---|---|---|---|
| DAG 校验 / 拓扑 / 防环 | ✅ | ✅ | ✅ | ✅ |
| 真实并行 + 全局 pane 池 | ✅ `engine.ts:63-65,313-327` | ✅ | ✅ | ✅ |
| blocked 人工审批（快照/按键/终止/补充） | ✅ `engine.ts:665-681` | ✅ | ✅ | ✅ |
| 黑板产物交接 + `{{}}` 插值 | ✅ `engine.ts:1138-1154` | ✅ | ✅ | ✅ |
| Fan-in 严格/宽容 | ✅ `engine.ts:450-459` | ✅ | ✅ | ✅ |
| 重试 / onFail / 超时 | ✅ `engine.ts:519-544` | ✅ | ✅ | ✅ |
| 澄清循环 clarify | ✅ `engine.ts:698-735` | ✅ | ✅ | ✅ |
| 动态扇出 expand | ✅ `engine.ts:873-920` | ❌ **无 UI** | ✅（节点级 config 不丢） | ⚠️ 只能手写 |
| 条件边 condition | ✅ `engine.ts:330-345` | ❌ **无 UI** | ❌ **保存即销毁** | ❌ 事实不可用 |
| checks 四类门禁 | ✅ `engine.ts:751-799` | ❌ **无 UI** | ✅ | ⚠️ 只能手写 |
| 模板变量 variables | ✅ `dag.ts:426-454` | 仅运行表单 | ❌ **保存即销毁** | ❌ 事实不可用 |
| pipeline 子流水线路由 | ✅ `engine.ts:805-866` | ✅ | ✅ | ✅ |
| Space 多空间 | ✅ | ✅ | ✅ | ✅ |
| 角色库 / 约定注入 | ✅ `engine.ts:991-1010` | ✅ | ✅ | ✅ |
| 模型网关注入 | ✅ `engine.ts:561-566` | ✅ | ✅ | ✅ |
| GitHub 凭据闭环 | ✅ `http.ts:142-214` | ✅ | ✅ | ✅ |
| 同仓并发写隔离（worktree） | ❌ **未实现** | — | — | ❌ **旗舰骨架裸奔** |
| 幂等 / 软锁 / 脏检查 | ❌ **未实现** | — | — | ❌ |
| 鉴权 / 远程访问 | ❌ **未实现** | — | — | ❌ |

**读法**：上表下半部分（expand / condition / checks / variables）是本次评估的核心发现——**四个高级编排能力全部只有引擎、没有入口**；其中两个还会被画布保存销毁。这解释了为什么真实运行里只有 `expand` 被用上（因为它藏在内置模板的节点 config 里），而条件边与模板变量在真实 run 中**从未出现过**。

### 1.3 成熟度评分卡

| 维度 | 评分 | 依据 |
|---|---|---|
| 编排引擎能力 | ★★★★★ | 数据流调度 / 全局信号量 / 条件边 / 扇出 / 子流水线 / 门禁 / 澄清循环，语义完整且可全量单测 |
| 真实终端隔离底座 | ★★★★★ | 节点 1:1 Pane，独立进程/终端/cwd/会话；协议 20 客户端健壮（一次请求一连接 + 专用事件连接 + 断线重订阅） |
| 交付闭环完整度 | ★★★★☆ | 对齐 → 拆解 → 扇出 → 实现 → 汇总 → 断言核对 → 收口，含 Issue 回链与 git 收口 |
| 工程可信度 | ★★★★☆ | 78/78 绿 + 类型通过；扣分项：前端零测试、无 CI |
| 生命周期资源管控 | ★★★★★ | 可读 workspace 命名 + 4 条回收路径 + 启动孤儿扫描 |
| 配置可达性 | ★★☆☆☆ | 4 个高级能力 JSON-only；rootCwd 仅裸文本框 |
| 数据完整性 | ★★☆☆☆ | 画布往返丢 `variables` / `condition` / `metadata.description` |
| 并发正确性 | ★★☆☆☆ | 设计 D8 已定稿，worktree / 软锁 / 脏检查三项全未实现 |
| 安全边界 | ★☆☆☆☆ | 无鉴权、任意文件读、终端注入面 |
| 可观测 / 可运维 | ★★☆☆☆ | 历史硬截断 50 条、日志仅 console、无 trace 关联 |
| 分发 / 产品形态 | ★☆☆☆☆ | 无 CI / LICENSE / 安装器；仅源码 + README |

**总评：工程 ★★★★☆ / 产品 ★★☆☆☆。**

---

## 2. 最强交付能力剖析（这个项目最值钱的部分）

### 2.1 端到端链路

两条入口，最终汇入同一条交付骨架：

```
入口 A（重流程）  入口 B（智能下发，推荐）
内置模板              一句任务描述
builtin-issue-triage  POST /api/dispatch  (http.ts:329-357)
   │                     │
   │  explore → triage   │  Planner 单点决策        ← dispatch.ts:22-89
   │  （建 Issue + 建议     │  从模板清单里选骨架 / 填参
   │    模板 + 写 issue_id）│  （AI 只选编排，不画拓扑 = 确定性红线 D3）
   │        ↓             │        ↓
   └──→ route(pipeline 节点) ←──────┘   engine.ts:805-866
              │  按 suggestedTemplate 插值路由
              │  缺失则回退 builtin-generic-issue-delivery
              ↓
     ╔══════════════ 交付骨架（generic，builtin-templates.ts:333-397）══════════════╗
     ║ start → align → plan → fork(fanout/expand) → impl×N → merge(fanin) → verify → wrapup → end ║
     ╚═══════════════════════════════════════════════════════════════════════════════╝
              │
   align   注入验收断言面 AC-N（extra.acceptance）+ 远程 Issue 正文回写
   plan    方案拆解 → extra.tasks[]（每任务内嵌其承接的断言）
   fork    运行时按 tasks 数组克隆 N 个 impl 分支（expandFrom）
   impl×N  并行实现 + 逐条自测回写 extra.assertionResults
   merge   宽容汇聚（requireAll=false，失败分支不拖垮整体）
   verify  逐条核对断言，输出核对结论
   wrapup  git 收口（Conventional Commits + 关联 Issue）+ 摘要回贴 Issue
```

### 2.2 为什么这是真资产

三条别人很难复制的性质：

1. **硬隔离的真实并行**——不是 LLM-API 层面的"伪并发"，是 N 个独立终端里 N 个真实编码 Agent 同时干活。`engine.ts:63-65` 的实例级 `paneSlots` 信号量保证跨 run 跨 Space 的全局上限（这个缺口在 v4 §9 被标 P0，现已真修复，不是文档幻觉）。
2. **确定性红线守住了**——拓扑永远是策展骨架，AI 只做"选哪个骨架 + 填什么参数"。这是它区别于所有 AI 动态生成工作流系统的根本，也是它敢叫"可以放心用的编排"的原因。
3. **交付语义闭环了**——从验收断言（AC-N）的注入，到每个实现分支的逐条自测回写，到 verify 节点的逐条核对，再到 Issue 回贴与 git 提交。它交付的不只是代码，是**带证据链的交付**。

### 2.3 但这条链路现在有三处漏

| 漏点 | 后果 | 证据 |
|---|---|---|
| **扇出后 N 个 impl 并发写同一目录** | 真实事故面：两个 Agent 同时改同一批文件，互相覆盖 | `engine.ts:873-920` 克隆节点不换 cwd；全仓无 worktree 实现（设计 D8 未落地） |
| **Planner 选型依赖 `metadata.description`** | 模板描述在画布保存后丢失 → Planner 失去判断依据，退化为"全靠猜" | `store.ts:263-266` 重建 metadata 时不带 `description`；`http.ts:343-346` Planner 正是读它 |
| **`{{issue_id}}` 变量声明会被保存抹掉** | 受理路线传进来的 issue 编号无法插值，prompt 里留字面量 `{{issue_id}}` 喂给 Agent | `store.ts:253-268` 不输出 `variables`；`builtin-templates.ts:396` 声明了它 |

**这三处漏全部命中旗舰骨架**——所以我把它列为 v5 P0，而不是"体验优化"。

---

## 3. 离真正的产品还差哪些（六类缺口）

### A. 数据完整性 —— 「保存即损坏」（P0，最紧急）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| A1 | `toGraph()` 不输出 `graph.variables` | `store.ts:253-268` | 旗舰骨架的 `issue_id` 参数声明保存后消失；运行参数表单消失；pipeline 传参失配 |
| A2 | `dagToRf()` 与 `toGraph()` 均丢弃 `edge.condition` | `store.ts:103-108`、`store.ts:262` | 条件边在画布上不可见、不可编；手写模板往返一次即被销毁 |
| A3 | `toGraph()` 重建 metadata：`createdAt` 被重置、`description` 丢失 | `store.ts:263-266` | 模板创建时间永远是"刚刚"；**Planner 失去模板描述**（直接击穿智能下发） |

> 这三个是同一处代码的同一类错误：**画布只认识它的 UI 能渲染的那部分字段，其余静默丢弃**。它是"仅引擎无 UI"的直接后果，但危害等级更高——因为它会毁掉用户已有的数据。

### B. 能力可达性 —— 「有引擎，没入口」（P0）

| # | 缺口 | 证据 |
|---|---|---|
| B1 | 无"边选中 → 条件边编辑"（Canvas 无 `onEdgeClick`） | `Canvas.tsx:45-57` 无任何边事件；`PropertyPanel` 只处理节点 |
| B2 | `checks` 四类门禁无 UI | `PropertyPanel.tsx` 全文无 `checks` 字样 |
| B3 | fanout 节点属性面板**不渲染任何字段** | `PropertyPanel.tsx:24-26` 只分 `isAgent/isFanin/isPipeline`，fanout 落到最外层只显示"独立工作目录" |
| B4 | 模板级 `variables` 声明无 UI | `PropertyPanel.tsx` 无 `variables`；仅 `RunDialog` 消费声明生成表单 |
| B5 | 画布**无自动保存**，刷新即丢 | `store.ts` 仅 `theme` / `view` 进 localStorage；`grep autosave|debounce` 无命中 |
| B6 | rootCwd「三入口」（最近/浏览/拖拽）未落地，后端 `/api/fs/browse` 前端**零调用** | `SettingsView.tsx:266-273` 仅裸 `<input>`；ripgrep `fs/browse` 在 web 下无匹配 |

### C. 安全边界 —— 从"本机自用"到"能给人用"的鸿沟（P1）

| # | 缺口 | 证据 | 风险 |
|---|---|---|---|
| C1 | **API 无任何鉴权** | `http.ts` 无 `onRequest`/`preHandler`/`Authorization` 校验 | 任何本机进程（含浏览器里的恶意页面跨域探测）可驱动 Agent |
| C2 | `/api/fs/read` 的 `root` 由**客户端提供** | `fs-routes.ts:55-69` | 路径前缀校验以攻击者给的 root 为基准 → 等价任意文件读取 |
| C3 | 终端注入端点无保护 | `http.ts:469-481` `sendPaneText` | 可向 Agent 终端注入任意文本 = 本机 RCE 面 |
| C4 | `host` 硬编码 `127.0.0.1`，v4 承诺的 `--host 0.0.0.0` + 访问令牌（手机审批）**未实现** | `index.ts:37` | D9 P1 的"离开工位审批"仍未成立 |
| C5 | Fastify `logger: false`，全程 `console.log/error` | `http.ts:72` | 无请求日志、无结构化日志、无 run 级关联 |
| ✅ | 凭据落盘已收紧 `0o600`，dataDir 不进 git | `github-cred.ts`、`.gitignore` | 这一项做对了，保持 |

### D. 并发正确性 —— 设计已定稿，代码零行（P0，真实事故面）

| # | 缺口 | 证据 |
|---|---|---|
| D1 | **同仓 worktree 隔离未实现** | ripgrep `worktree` 全仓仅命中一句无关注释 |
| D2 | 软锁排队未实现 | 同上 |
| D3 | run 启动前脏检查未实现 | `engine.ts:156-158` 只校验 cwd 存在，不校验 git 干净 |
| D4 | 同 issue 幂等锁未实现 | v4 §10 列为 P2 待办，未动 |

**为什么这条是 P0 而非 P2**：旗舰骨架的动态扇出天然产生 N 个共享同一 cwd 的 impl 分支（`engine.ts:873-920` 不修改 `cwd`）。也就是说，**项目最核心的交付能力，在默认配置下就是一个并发覆盖现场**。v4 把它排 P2 是当时 D8 尚未验证；现在 D8 已确认可行（herdr 原生 `worktree create` 可用），优先级应上调。

### E. 可运维性 —— 出问题查不到（P1）

| # | 缺口 | 证据 |
|---|---|---|
| E1 | 运行历史**硬截断 50 条**，无归档、无检索、无导出 | `store.ts:156-163` `.slice(0, 50)` |
| E2 | 无结构化日志 / 无 trace 关联（无 runId↔nodeId↔事件时间线） | `http.ts:72`、全仓 `console.*` |
| E3 | 服务重启一律把 running 标记 failed，**无断点续跑** | `engine.ts:75-94` |
| E4 | 无交付质量指标（节点耗时分布 / 重试率 / 失败原因聚类） | 数据其实都在 `RunRecord` 里，只是没有视图 |

### F. 分发与形态 —— 别人装不上（P2，但决定"是不是产品"）

| # | 缺口 | 证据 |
|---|---|---|
| F1 | 无 CI（无 `.github`）——78 个测试全靠人手动跑 | 目录不存在 |
| F2 | 无 LICENSE | 无 LICENSE 文件 |
| F3 | 无安装器 / 单二进制 / Electron 壳；启动需 `pnpm dev:server` + `pnpm dev:web` 双终端 | `package.json` scripts |
| F4 | 前端零测试 | 无 `*.test.tsx` |
| F5 | 文档漂移三处 | ① `PropertyPanel.tsx:82` 写「0=默认15」，实际默认 30 分钟（`index.ts:22`）② v4 §13.4 的 REST DELETE issue 端点不存在（wrapup 已记录）③ README 未提 dispatch / gateway / github 凭据等新增能力 |

---

## 4. 迭代需求

排序原则：**先止住数据损坏 → 再把能力交出去 → 再保证并行不踩踏 → 才谈安全与分发**。前 3 个迭代不完成，后面做的都是在流沙上盖楼。

---

### 迭代 1 · 止血：画布往返数据完整性（P0）

**目标**：画布不再静默销毁数据。这是全 v5 的前置。

| 编号 | 需求 | 交付物 | 验收标准 |
|---|---|---|---|
| R1.1 | `toGraph()` 透传 `graph.variables` | `store.ts` | 加载 `builtin-generic-issue-delivery` → 保存 → `variables` 含 `issue_id` 不变 |
| R1.2 | 边往返保留 `condition`（`dagToRf` + `toGraph`） | `store.ts` | 含条件边的手写模板往返一次，`condition` 逐字段相等 |
| R1.3 | metadata 保真：`createdAt` 不重置、`description` 不丢 | `store.ts` | 保存后 `createdAt` 不变、`updatedAt` 更新；`description` 保留 |
| R1.4 | **新增前端 round-trip 回归测试**（首个 web 测试） | `store.roundtrip.test.ts` | `graph → dagToRf/toGraph → graph` 深度全等断言通过 |
| R1.5 | 顺带修正 `PropertyPanel` 超时文案「0=默认15」→「0=默认30」 | `PropertyPanel.tsx` | 文案与实际默认一致 |

**验收门槛**：`pnpm typecheck` + `pnpm test` 全绿（≥78 + 新增用例），且 R1.1–R1.3 有可复现的往返断言。

---

### 迭代 2 · 可达：把四个高级能力交到手上（P0）

**目标**：不写一行 JSON，就能配出旗舰骨架的全部编排语义。

| 编号 | 需求 | 交付物 | 验收标准 |
|---|---|---|---|
| R2.1 | 边上选中 → 属性面板（条件边编辑：`field`/`equals`/`notEquals`/`exists`） | `Canvas.tsx` 加 `onEdgeClick` + `EdgePanel` | 点边可编辑条件，画布虚线+标签呈现，保存后往返不丢 |
| R2.2 | Agent 节点 checks 编辑（file-exists / command / regex / manual 增删改） | `PropertyPanel.tsx` | 4 类门禁均可 UI 构造；Dry-Run 能列出 checks |
| R2.3 | fanout 节点 `expand` 编辑（`from`/`field`/`onEmpty`） | `PropertyPanel.tsx` 增加 fanout 分支 | 可 UI 复刻 `expand:{from:'plan',field:'extra.tasks'}` |
| R2.4 | 模板级 `variables` 声明编辑（表格式增删） | 新建变量面板 | 可 UI 复刻 `[{key:'issue_id',...}]`；运行表单随之出现该字段 |
| R2.5 | 画布自动保存（debounce ~800ms + 脏标记 + 手动保存/另存） | `store.ts` + 顶栏 | 改动后刷新页面不丢；切模板前提示未保存 |
| R2.6 | 后端目录浏览器接入 rootCwd「三入口」（最近 / 浏览 / 拖拽） | `SettingsView.tsx` 调 `/api/fs/browse` | 可点选目录写入 rootCwd，无需手输 |

**验收门槛**：**用一个"零 JSON"的端到端演示验收**——全程 UI 画出 align→plan→fanout→impl→merge→verify→wrapup，含 1 条条件边、1 组 checks、1 个 expand、1 个 variables，Dry-Run 通过并成功运行。

---

### 迭代 3 · 可信：并行交付不互相踩踏（P0）

**目标**：旗舰骨架在默认配置下不再是一个并发覆盖现场。

| 编号 | 需求 | 交付物 | 验收标准 |
|---|---|---|---|
| R3.1 | herdr worktree 隔离：节点启动时目标 repo 已被占用 → 用 `herdr worktree create` 独立工作 | `engine.ts` + `herdr-ops.ts` | 同仓双任务并发跑，两个分支文件互不覆盖，各自分支可独立提交 |
| R3.2 | 软锁排队兜底（worktree 不可用时同 repo 任务串行） | `engine.ts` | 强制关闭 worktree 能力后，同 repo 任务自动串行且不失败 |
| R3.3 | run 启动前脏检查（repo 有未提交改动则拒绝并提示） | `engine.ts:156+` | 脏工作区下发被拒绝，提示明确；干净工作区正常启动 |
| R3.4 | 同 issue 幂等锁（同一 issue 重复下发 → 拒绝或明确提示） | `engine.ts` + `http.ts` | 同 issue 二次下发返回 409 或提示已有运行 |
| R3.5 | worktree 生命周期纳管（run 结束随 workspace 一并回收） | `engine.ts` | run 结束后无残留 worktree；孤儿扫描覆盖 worktree |

**验收门槛**：真实双任务同仓场景跑通，产出可独立合入的分支；重复下发被拦；`recoverOrphans` 覆盖 worktree。

---

### 迭代 4 · 可暴露：安全与远程审批（P1）

**目标**：能离开工位审批，且暴露服务不留下"本机 RCE"的口子。

| 编号 | 需求 | 交付物 | 验收标准 |
|---|---|---|---|
| R4.1 | 访问令牌（Bearer）+ `--host` 可配；令牌首次启动生成并仅在终端展示一次 | `config.ts` + `http.ts` 鉴权钩子 | 无令牌一律 401；`--host 0.0.0.0` + 令牌下手机浏览器可访问 |
| R4.2 | `/api/fs/read` 收敛：root 必须来自 Space 已登记的 `rootCwd`（不接受任意客户端 root） | `fs-routes.ts` | 越出 rootCwd 一律 403；Space 未配置时该端点 400 |
| R4.3 | 终端注入面收敛：`input` / `keys` 端点需令牌 + 审计日志（who/when/what） | `http.ts` | 未授权调用 401；每次注入落地可查审计记录 |
| R4.4 | 移动端审批可用性验证（blocked 卡片在手机浏览器可用） | 前端响应式微调 | 手机上完成一次真实放行/终止 |

---

### 迭代 5 · 可运维：历史与可观测（P1）

**目标**：50 条之后不丢历史；出问题能在 5 分钟内定位到节点。

| 编号 | 需求 | 交付物 | 验收标准 |
|---|---|---|---|
| R5.1 | 运行归档 + 检索（按 space / issue / template / 日期 / 状态）+ 导出 JSON | `store.ts` + 运行中心 | 可检索到早期运行；可导出单次 run 完整记录 |
| R5.2 | 解除 50 条硬截断，改分页加载 | `store.ts:156-163` | 历史 > 50 条时全部可翻页抵达 |
| R5.3 | 结构化日志 + `runId`/`nodeId` 关联 + `GET /api/runs/:id/events` 时间线 | 新建 logger + 端点 | 单次 run 全链路可回溯（何时、哪个节点、什么错误、重试几次） |
| R5.4 | 交付质量看板（节点耗时分布 / 重试率 / 失败原因聚类） | 运行中心视图 | 一眼看出慢节点与高频失败原因 |

---

### 迭代 6 · 可交付：分发与形态（P2）

**目标**：别人能在一台干净机器上装起来并用起来。

| 编号 | 需求 | 交付物 | 验收标准 |
|---|---|---|---|
| R6.1 | LICENSE + CI（typecheck / test / build 三绿门禁） | `LICENSE`、`.github/workflows/ci.yml` | PR 三绿才可合；徽章可查 |
| R6.2 | 一键启动（`npx paneflow` 或单二进制 / Electron 壳，前端构建产物内置并由服务端托管） | 新 entry + 静态托管 | 一条命令起服务并直接打开画布，无需双终端 |
| R6.3 | 首次运行零环境引导闭环（自动检测 herdr 未装 → 给命令 → 重检通过后放行） | 复用现有 EnvWizard | 干净机器按引导三步跑通 |
| R6.4 | 文档对齐（超时默认值 / §13.4 端点 / README 补齐 dispatch·gateway·github 能力） | README + docs | 文档描述与实测行为一致 |
| R6.5 | 断点续跑（服务重启后从最后 done 节点继续，替代当前一律 failed） | `engine.ts:75-94` | 重启后 run 可续跑而非重跑全流程 |

---

## 5. 优先级与执行顺序

| 迭代 | 主题 | 优先级 | 依赖 | 阻塞了什么 |
|---|---|---|---|---|
| 1 | 数据完整性止血 | **P0** | — | 阻塞迭代 2（UI 建在会丢字段的存储上等于白做） |
| 2 | 能力可达（四个面板） | **P0** | 迭代 1 | 阻塞迭代 3 验证（并发场景要能画出来才能压测） |
| 3 | 并发可信（worktree/锁/幂等） | **P0** | 迭代 1 | 阻塞"把交付能力交给别人用" |
| 4 | 安全与远程审批 | P1 | — | 阻塞"离开工位"与对外暴露 |
| 5 | 历史与可观测 | P1 | — | 阻塞长期运维 |
| 6 | 分发与形态 | P2 | 1–5 | 决定"是否能被称为产品" |

**建议执行节奏**：迭代 1 单独一批立刻做（改动面小、收益极大、纯收益无风险）；迭代 2 与 3 可并行推进（前端面板 / 引擎并发，互不冲突）；迭代 4 与 5 在 3 之后。

**一句话判断**：做完迭代 1+2，「四个高级能力可用」；做完迭代 3，「旗舰交付能力可信」；做完迭代 4–6，**它才真正从"我的工具"变成"一个产品"**。

---

## 6. 与 v4 文档的差异修正清单

| v4 表述 | 本次实测 | 处置建议 |
|---|---|---|
| `PropertyPanel` 超时「0=默认15分钟」 | 实际默认 30 分钟（`index.ts:22`） | 迭代 1 R1.5 修正文案 |
| §9 把「同仓 worktree 隔离」列为 P2 | 旗舰骨架默认并发写同一 cwd = 真实事故面 | **上调为 P0**，见迭代 3 |
| §13.4 建议 `REST DELETE /repos/{owner}/{repo}/issues/{number}` | 该端点不存在（GitHub 实测 404） | 改为 `gh issue close`，随迭代 6 R6.4 修正 |
| §4「零环境引导」标记为已落地 | 后端能力齐备，但 rootCwd 三入口前端未接入 | 迭代 2 R2.6 补齐 |
| §13 自闭环 8 项全 ✅ | 复核成立（`expand` / `clarify` / 回收路径 等均在代码中确认） | 无需修正，作为基线 |
