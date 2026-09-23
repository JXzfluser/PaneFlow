# PaneFlow 迭代方向 v4：产品化总体规划（已评审定稿）

> 评审轮次汇总：v2 三层配置模型 → v3 六点产品化反馈 → v4 样式基调（参考 pi 蓝皮书）、布局定稿、任务拆分语义修正、Spaces 体系、远程指令通道分析。
> 事实核对：`maxConcurrentPanes` 为 per-run 计数（engine.ts:245），多 run 并行时全局并发未受控；模板复制/删除 API 已有但 UI 未暴露；herdr 原生支持 `worktree` 子命令（可用于同仓并发隔离）。

## 0. 决策记录

| # | 决策 | 说明 |
|---|---|---|
| D1 | 角色库**全局** | 跨项目复用；项目档案只引用+覆盖 |
| D2 | 路径**选择/发现**优先，禁止裸手填 | §2 |
| D3 | 动态性 = **数据驱动**，不做 AI 生成拓扑 | §3 |
| D4 | 评审通过后推送；脱敏替换远端 v1 | 已执行 |
| D5 | **样式基调参考 pi 蓝皮书**（VitePress 系）✅已确认 | §1：亮色为默认、蓝主色、卡片化、书籍式导航；暗色保留为切换项 |
| D6 | 拆分单位 = **任务（task）**，"尽量不跨仓"是约束不是维度 | §3.2 |
| D7 | 引入 **Space（项目空间）** 一级概念；herdr workspace 按 run 组织且**可读命名** | §5；Space 维持纯个人工具语义（成员/权限不做） |
| D8 | 同仓并发写用 **herdr worktree** 隔离 ✅已确认 | §5.3 |
| D9 | 远程指令通道：**通知先行、命令后置、明确不做个人微信**；仅用不破坏「本地离线」红线的方式 | §6 |

## 1. 样式基调（D5，参考 pi.xiaomovps.com 蓝皮书）

参考页实测：VitePress 书籍式文档站——白底、蓝主色（链接/高亮/锚点）、大量留白、清晰 H1→H3 层级、三列对照表、浅色代码块、灰底与琥珀色两类提示框、左侧书籍目录、右上外观切换。气质：**干净、可读、教程感**，而非当前 ComfyUI 式深色高密度工具风。

PaneFlow 视觉语言据此调整：

| Token | 定稿 |
|---|---|
| 默认主题 | 亮色（白底/浅灰面板），暗色保留一键切换（现有 🌙/☀️ 按钮不变） |
| 主色 | 蓝（accent，链接/运行按钮/选中态/节点选中框） |
| 组件语言 | 卡片化（圆角 8px、1px 边框、轻投影）；提示框两态：灰色「说明」+ 琥珀「注意/审批」；表格用于对照类信息 |
| 排版 | 标题层级分明（视图标题 → 区块标题 → 条目），正文 13px、行高宽松、留白优先于密度 |
| 导航 | 书籍式左侧层级导航（见 §1.1），当前项高亮 |
| 画布 | 浅色画布 + 灰点阵，节点白卡片、状态色只用于**状态条与徽标**（不再整卡渲染） |

### 1.1 布局定稿（结合项目自选最优）

全局骨架 = **左侧固定窄导航 + 顶条 + 视图区**（替换现五分区硬布局）：

```
┌──┬──────────────────────────────────────────────┐
│☐ │ 顶条：当前视图标题 · 视图内主操作（运行/停止）· 状态灯 · 🌙 · ? │  48px
│编│──────────────────────────────────────────────┤
│运│                                              │
│设│              视 图 区（三选一）                 │
│  │  · 编排：节点库(左,可折叠) | 画布 | 属性(右)    │
│  │          + 底部控制台(可折叠拖高，已有)         │
│  │  · 运行：运行中心（§5.2）                      │
│  │  · 设置：二级侧栏（空间/角色库/环境/关于）       │
└──┴──────────────────────────────────────────────┘
 56px
```

- 左导航 56px：图标+单字（编/运/设），Space 切换器钉在导航底部（当前空间名，点击换空间/新建）；
- 顶条只放**当前视图**的主操作——不再把模板/云端/运行全挤一排（解决顶栏拥挤的根源）；
- 编排视图的节点库与模板库合并为左面板两个折叠组；模板项 hover 出 复制/重命名/删除/导出。

## 2. 配置体验（上轮②，原则不变）

**能发现的不要填，能选择的不要输，输过的不要再输。**

- 只维护一个绝对路径：**主仓根**（Space 属性）。仓库 = 相对名；约定文档（AGENTS.md 等）与 skills/ 在根下**自动发现勾选**；
- 主仓根选择三入口：最近使用 / 后端目录浏览器（`/api/fs/browse` 仅列目录）/ 拖拽文件夹；手输兜底；
- 模板管理操作：复制另存（fork 内置模板的改造起点）/ 重命名 / 删除 / 导入导出 JSON。

## 3. 动态编排（上轮③，语义修正）

### 3.1 条件边 + Dry-Run（不变）

边条件断言上游 artifact 字段（`{field, equals}`），不满足即剪枝；运行前 Dry-Run 展开变量/条件/扇出，打印最终拓扑与检查清单，**动态可预演**。

### 3.2 动态扇出：按**任务**展开（D6 修正）

拆分维度修正：**需求拆分 ≠ 仓库拆分**。"任务"才是交付单元，约束是**一个任务尽量不跨仓库**（跨仓任务无法并行、联调面大）；反过来一个仓库可以有多个任务（如 order 仓的接口改造 + 数据迁移两个任务，可并行）。

```
[任务拆分] Agent 产出 tasks: [
    { name: "下单接口改造", repo: "service-order", brief: "…" },
    { name: "订单数据迁移", repo: "service-order", brief: "…" },   ← 同仓双任务，worktree 隔离后仍并行
    { name: "下单页改版",   repo: "web-portal",    brief: "…" } ]
   ↓ [fan-out · expandFrom: "split.tasks"]  运行时克隆 dev 节点，{{item.name}}/{{item.repo}}/{{item.brief}} 注入
```

- 拆分节点提示词内置约束：「拆为可并行的任务；单任务不跨仓库；同仓多任务允许但需说明隔离方式」；
- 同仓并发任务由 D8 的 worktree 机制兜底（§5.3），拆分 Agent 只管合理，不被仓库维度绑架。

### 3.3 运行中微调（P2，不变）

queued 节点启动前允许临时覆盖 prompt/参数（run-local）。

## 4. 零环境引导（上轮④，不变）

环境自检 API（herdr/node/agent 清单）→ 首次访问欢迎向导（三步：装 Herdr → 装 Agent → 连接测试，命令复制+重检）；agentKind 下拉分「已安装/未安装（灰显+安装命令）」；顶条 Herdr 灯点击直达诊断。样式按 §1：向导即书籍式步骤卡（MODULE·STEP 徽标行的既有语言）。

## 5. Spaces 体系与多工作流管理（上轮⑤ + 本轮"分 spaces"）

### 5.1 Space（项目空间）一级概念（D7）

```
Space = 主仓根 + 项目档案(约定/技能/变量/角色覆盖) + 模板集 + 运行历史归属
```

- 多**需求**并行 = 同一 Space 下多个 run 同时跑；多**项目**并行 = 多 Space 切换；
- Space 列表钉在左导航底部；运行中心、编排画布均以当前 Space 为上下文（模板互不污染）。

### 5.2 Herdr workspace 组织与运行中心

- **每个 run 一个 herdr workspace**（现状机制保留），命名从 `paneflow-{runId}` 改为**可读**：`pf-{space}-{issue}`（如 `pf-demo-162`）——用户在 herdr TUI 里能按名字围观对应需求的 pane 群，run 结束回收不变；
- 运行中心（「运」视图）：全局状态条（N 运行中 · M 待审批 · pane 池 x/8，**跨 Space 汇总**）+ run 行卡片（`#162 下单优化`、节点进度、待审批聚合、耗时、打开/停止/归档）+ blocked/完成浏览器通知；
- 全局并发池（P0）：Engine 级信号量，跨 run 跨 Space 共享。

### 5.3 同仓并发写保护（D8）

两个任务同时改同一仓库（同 run 内拆出，或两个 run 撞车）：

1. **worktree 隔离**（主方案）：节点启动时若目标 repo 已被占用，用 herdr 原生 `herdr worktree create` 在独立 worktree 中工作（分支互不干扰，天然并行）；
2. **软锁兜底**：worktree 不可用时同 repo 任务排队串行；
3. **run 启动前脏检查**：repo 有未提交改动直接拒绝（不覆盖用户工作区）。

## 6. 远程指令通道：微信 / 飞书对接分析（D9）

出发点：在聊天工具里下发指令（跑流水线、审批、看进度），人不必守在工位。这与「本地离线、无公网依赖」的产品红线有张力，解法是选对通道并严格分层。

### 6.1 通道可行性对比

| 通道 | 出站推送 | 入站命令 | 公网暴露要求 | 结论 |
|---|---|---|---|---|
| 飞书自定义机器人（webhook） | ✅ 极简（一个 URL） | ❌ 无交互 | **无**（纯本地出站） | P1 通知首选 |
| 飞书应用·长连接模式 | ✅ | ✅ 交互卡片（按钮=审批） | **无**（WebSocket 长连接，无需公网 IP） | P2 命令网关首选 |
| 企业微信 | ✅ | 回调需公网 URL | 需要（内网穿透不推荐） | 缓 |
| 个人微信 | ❌ 无官方 API | 第三方机器人违反 ToS、封号风险 | — | **明确不做** |
| 通用 Webhook / 邮件 | ✅ | ❌ | 无 | 兜底通道 |

### 6.2 入站命令的核心问题（为什么「命令后置」）

1. **安全面（最重）**：PaneFlow 本地 API 可创建 Agent 并向终端注入指令 = 本机 RCE 面。暴露到聊天必须收敛为**命令白名单**（`状态` / `审批 <run> 放行|终止` / `停止 <run>` / `跑 <模板> issue=… version=…`），**禁止自由文本透传为 Agent 提示词**；
2. **身份与授权**：本地工具无用户体系 → 飞书 user_id / 群白名单 + 两级角色（管理员可审批/启动，其他只读）；app secret 存本机配置/钥匙串，不入库不入日志；
3. **消息形态**：终端日志不可直接倒灌（长度与格式限制），推摘要卡片 + 深链回本地 Web；审批用飞书交互卡片按钮（放行/终止/补充输入）；
4. **参数收集**：运行参数表单在聊天端退化为卡片表单或引导式补齐对话，超出的都引导回 Web；
5. **竞态**：聊天与 Web 同时审批 → 引擎审批 waiter 一次性消费天然幂等（第二处得到 409），UX 提示「已在别处处理」即可；
6. **红线检查**：长连接与出站 webhook 不需要公网入站端口，不破坏「本地离线」定位；**禁止内网穿透方案**（frp/ngrok 会重新打开攻击面）。

### 6.3 分期

- **P1（低成本高价值）**：出站通知——blocked / 完成 / 失败 → 飞书 webhook 卡片（附深链）；同时 Web 服务支持 `--host 0.0.0.0` + 访问令牌，**手机浏览器直接审批**，零机器人就解决「离开工位审批」；
- **P2**：飞书长连接命令网关（白名单命令 + 交互卡片审批 + 身份白名单 + 审计日志 who/when/what）。

## 7.5 模型网关：Agent 模型代理与自动切换（实测痛点驱动）

**痛点实测**：真实受理流水线中，pi 使用的免费模型通道（deepseek 等）响应极慢甚至超时，导致 explore/triage 节点动辄十几分钟、时好时坏。

**方案定位**：PaneFlow **不自建网关**（不重做生态），而是提供三层 env 注入，把任何 Agent 指向你自己部署的模型网关：

| 层级 | 配置处 | 适用 |
|---|---|---|
| 全局 | `PF_PANE_ENV` 环境变量 | 全部流水线统一走网关 |
| 角色 | 设置 → 角色库 → 环境变量 | 「开发」走强模型、「调研」走便宜模型 |
| 节点 | 属性面板 → 模型网关/环境变量 | 单节点特例（覆盖角色与全局） |

合并优先级：全局 < 角色 < 节点。

**网关选型**（自行部署，PaneFlow 只注入地址类 env）：

| 网关 | 特点 | 典型注入 |
|---|---|---|
| **LiteLLM Proxy** | OpenAI 风格统一入口，fallbacks/retries/路由策略内置 | `OPENAI_API_BASE=http://127.0.0.1:4000/v1` + `OPENAI_API_KEY=sk-…` |
| **Claude Code Router** | 为 claude-code 系设计，多供应商路由 | `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` |
| **OmniRoute** | v4 预留的网关方案，MCP 聚合 | 按其文档 |

**自动切换示例**（LiteLLM router 配置 fallback）：

```yaml
model_list:
  - model_name: main
    litellm_params: { model: deepseek/deepseek-chat }      # 便宜主力
  - model_name: main
    litellm_params: { model: openai/gpt-4o-mini }          # 超时自动切
routing_fallbacks: [main]
```

Agent 端只需把 base_url 指向网关、模型名写 `main`——单模型超时/限流时网关自动换供应商，PaneFlow 侧零改动。**收尾说明**：Agent 对网关 env 的具体变量名因 kind 而异（claude=ANTHROPIC_*、opencode=OPENCODE_*/OPENAI_*、pi=pi 配置），节点 env 注入的正是这层适配点。

**已落地（OmniRoute 实测接入 ✅）**：

- 设置页新增「模型网关」卡片：网关地址 / API Key（写后回显脱敏）/ 免费档模型 id / 启用开关 / 连通测试（列出模型数）；配置持久化 `<dataDir>/gateway.json`
- 引擎注入：每个 Agent Pane 自动获得 `OPENAI_API_BASE/KEY`、`ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL` 等全套网关变量（合并序：全局 < 网关 < 角色 < 节点）
- 实测：OmniRoute `localhost:20128`，484 个模型含 `auto/best-free`、`auto/coding:free` 免费档；claude Agent 经 `ANTHROPIC_BASE_URL` 直连网关真实跑通流水线（请求被路由到免费模型，快照完整）
- 内置模板默认 Agent 类型从 pi 切换为 claude（走网关最稳的接入路径）
- 安全：gateway.json 存于本机数据目录，API Key 永不入库不入 git，读取回显脱敏

## 8. 全局角色库（D1，不变）

设置页「角色库」：角色 = 默认 agentKind + 约定文档集 + 前置/后置动作 + 检查集 + 提示词骨架；项目档案/Space 只做引用+覆盖。画布节点 = 名称 + 角色 + 仓库 + 提示词。

## 9. 优先级总表（v4）

| 优先级 | 项 | 来源 |
|---|---|---|
| **P0** | 全局并发池（多 run 正确性） | ⑤ |
| **P0** | 样式切换为亮色默认 + pi 风格组件语言改造 | 本轮 |
| **P0** | 环境自检 + 欢迎向导 | ④ |
| **P0** | 模板复制/重命名/删除/导入导出 UI | ② |
| **P0** | 模板变量 + 运行参数表单 | v2 |
| **P0** | Space 概念落地（主仓根选择三入口 + 约定/技能自动发现） | ② 本轮 |
| **P1** | 左导航 + 三视图信息架构（编排/运行/设置） | ② 本轮 |
| **P1** | 运行中心视图 + workspace 可读命名 + 浏览器通知 | ⑤ 本轮 |
| **P1** | 项目档案 + 全局角色库 | ① |
| **P1** | checks 检查 gate | v2 |
| **P1** | 条件边 + Dry-Run 预演 | ③ |
| **P1** | 澄清循环节点 + run 绑 issueId | v2 |
| **P1** | 出站通知（飞书 webhook 卡片）+ Web `--host`/访问令牌（手机审批） | D9 本轮 |
| **P1 末** | 动态扇出（expandFrom: tasks，按任务展开） | ③ 本轮 |
| **P2** | 飞书长连接命令网关（白名单命令/交互卡片审批/审计） | D9 本轮 |
| **P2** | 同仓 worktree 隔离 + 软锁 + 脏检查 | 本轮 |
| **P2** | 运行中 queued 节点临时覆盖 | ③ |
| **P2** | 同 issue 幂等锁、归档检索、子流水线、flow.yaml 导入 | ⑤ v2 |

P0 各项 0.5–2 天；P1 为产品形态主战场；P2 治理增强。

## 10. 待确认（已全部确认 ✅）

1. 亮色默认主题 → **确认**（D5）
2. Space 纯个人工具语义 → **确认**；远程协作诉求由 §6 微信/飞书通道分析承接（D9）
3. 同仓并发 worktree 隔离 → **确认**（D8）

## 11. 开发执行计划（已确认：P0+P1 全量，逐功能推送）

事实勘察结论（开发前）：
- `herdr server agent-manifests` 输出全部 Agent kind 及版本/状态 → 环境自检数据源可靠（辅以 `command -v` 检测本地二进制）；
- `herdr worktree create/list/open/remove` 可用 → D8 成立；
- `variables` 尚未实现；当前存储为扁平 templates/ + runs/，Space 需重构 + 一次性自动迁移。

### 执行顺序（依赖驱动）

**Phase A · 地基（P0）**
1. 全局并发池：Engine 级信号量替换 schedule 内 per-run 计数
2. Space + 存储重构：`spaces/<id>/{templates,runs,profile.json}` + 全局 settings.json；boot 时旧扁平数据自动迁入 default 空间
3. 模板变量 + 运行参数表单：`DagGraph.variables[]` 声明式；渲染时先做 `{{var}}` 替换（变量优先、黑板引用其后），可注入 prompt/cwd 等全部字符串字段；运行对话框按声明生成表单
4. 模板操作 UI：复制另存/重命名/删除（确认）/导出 JSON/导入（拖拽或选择）
5. 环境自检 + 欢迎向导：`/api/health` 扩展（herdr 版本/Agent 清单+本地安装检测）；首次访问三步向导卡（安装命令复制+重检）
6. 亮色默认 + token 微调（组件级卡片化随 Phase B 信息架构一并做）
7. 出站通知：settings.json（feishuWebhook/notifyEvents）+ blocked/完成/失败推送卡片 + `--host 0.0.0.0` 访问令牌说明

**Phase B · 产品形态（P1）**
8. 左导航 + 三视图信息架构（编排/运行/设置）
9. 运行中心 + workspace 可读命名 `pf-{space}-{issue}` + 浏览器通知
10. 项目档案 + 全局角色库（settings 视图；角色继承/覆盖）
11. checks 检查 gate（file-exists/command/regex/manual；manual 复用审批卡片）
12. 条件边 + Dry-Run 预演
13. 澄清循环节点 + run.issueId
14. 动态扇出 expandFrom（按任务数组克隆分支节点）

设计取舍备查：变量与黑板引用同用 `{{}}` 语法——变量先替换（声明式、无歧义），其余按节点引用解析；条件边在画布上以虚线+标签呈现，属性面板点选边编辑；checks 失败计入节点失败语义（重试/onFail 照常）。

## 12. 智能下发（Smart Dispatch）——任务下发的一等公民功能（设计定稿候选）

> 场景：在指定空间输入任务描述 → 自动选模板编排 / 自动生成最优编排 → 自动处理。

### 12.1 Space 配置增强

- Space 档案新增：`repos[]`（主仓根下的仓库清单，自动发现 + 手动维护）、`defaultCwd`（默认工作目录）
- 下发时目录优先级：用户指定 > `defaultCwd` > 发起下发时的当前目录
- 设置页空间卡片可视化维护（自动发现沿用 /api/fs/discover）

### 12.2 Planner：AI 选编排 + 填参数（不画拓扑）

- 一次轻量 Agent 调用（走网关）：输入 = 任务描述 + Space 档案（仓库/约定摘要/**模板清单**）
- 输出契约（JSON，写入结果文件）：
  `{ "mode": "template", "template": "builtin-…", "params": {...} }`
  或 `{ "mode": "skeleton", "skeleton": "builtin-generic-issue-delivery", "tasks": [{name, brief, repo?}] }`
- 输出不合规 → 兜底链：generic 骨架 + 原始描述作为唯一任务（串行交付），永不阻断

### 12.3 骨架库（策展拓扑，渐进丰富）

| 骨架 | 拓扑 | 场景 |
|---|---|---|
| 交付型（已有 generic） | 对齐→拆解→动态扇出→汇总→归档 | 功能实现类任务 |
| 修复型 | 复现→溯源→修复→回归 | Bug 类任务 |
| 调研型 | 双路并行调研→对比决策 | 技术选型/探索 |
| 巡检型 | 多目标并行检查→汇总报告 | 定时/批量健康检查（P2 配 cron） |

Planner 只在骨架库中选择并填参——确定性红线不破；骨架库随场景增长。

### 12.4 交互与实现

- 入口：顶栏「🎯 下发任务」对话框（任务描述 + 可选 Issue + 可选仓库）；
- 实现 = 临时编排生成器：`[Planner] → [pipeline 路由]` 三节点图按下发内容程序化生成（复用 pipeline 节点路由 + generic 骨架 + 动态扇出 + 澄清循环——零新引擎能力）；
- 运行中心以同一 task/issue 归属展示；Planner 失败不阻断（12.2 兜底链）；
- 现有「Issue 受理流水线」模板保留为重流程选项（其 explore+triage 两节点被 Planner 单点替代）。

### 12.5 待确认

1. Planner 用网关免费档先行验证，效果不足再切 `auto/pro-*`？
2. 骨架库首批：交付型 + 修复型 + 调研型（复用现成模板改造），巡检型后置？
3. 下发入口放顶栏还是左侧导航独立视图？

## 13. GitHub 凭据闭环契约与运维（收尾定稿 · Issue #3）

> 收尾来源：Issue「GitHub 凭据闭环与端到端验证」（远程 #3）。align 已核实核心链路全部就位：GET/PUT `/api/github/cred`、POST `/api/github/create-issue`、PATCH `/api/github/update-issue`（http.ts:142-214）、triage→route 插值拉起交付（builtin-templates.ts triage/route 节点）。本节记录四项契约与运维结论：**defaultRepo 兜底语义与验收修订 / 凭据安全与 dataDir 排除 / 端到端验收运行时前置 / 合成 Issue 清理清单**。实现锚点：github-cred.ts、github-sync.ts、config.ts:43。

### 13.1 凭据端点契约与 defaultRepo 兜底语义

**端点面**（本地编排服务，`PF_PORT` 默认 4310）：

| 端点 | 入参 | 语义 |
|---|---|---|
| `GET /api/github/cred` | — | 返回 `{ tokenConfigured, defaultRepo }`；未配置时 `tokenConfigured:false` |
| `PUT /api/github/cred` | `{ token?, defaultRepo? }` | 落盘 `<dataDir>/github.json`；`token` 空 = 保留已存值，`defaultRepo` 可单独更新 |
| `POST /api/github/create-issue` | `{ title, body?, repo?, labels? }` | 凭配置 PAT 直调 GitHub API 确定性建 Issue；成功返回 `{ number, url, repo }` |
| `PATCH /api/github/update-issue` | `{ number, repo?, body }` | 就地覆盖 Issue 正文（对齐远程 Issue #3 正文用） |

**create-issue 失败面**（按判定序）：

| 触发 | 结果 |
|---|---|
| 缺 token | 400 未配置 GitHub 凭据 |
| 缺 `repo` 且 **defaultRepo 已配置** | **兜底成功**：按 defaultRepo 直调 API 创建，返回 number/url |
| 缺 `repo` 且 defaultRepo 也未配置 | 400 缺少 repo（未配置默认仓库） |
| 缺 title | 400 缺少 title |
| GitHub API 401/403/404 | 原样透传状态码 + message |
| 网络不可达 / 15s 超时 | 502 |

**验收语义（AC#2 与 AC#5 对齐，消除『缺 repo』字面冲突）**：

- **基线**：缺 repo 时 defaultRepo 兜底成功；**仅当 defaultRepo 也未配置才 400**（与实测行为一致——兜底分支已由合成 Issue #4 实测通过，见 13.4）。
- **AC#5 修订指引**：验收标准 #5 措辞由「缺 repo → 400」改为「**缺 defaultRepo（且未携带 repo）→ 400**」，并在同条补齐「缺 repo 且 defaultRepo 已配置 → 按 defaultRepo 兜底成功」。修订需同步两处：`issue-draft.json` 正文，以及远程 Issue #3 正文（用 `PATCH /api/github/update-issue` 就地覆盖，而非重开 Issue）。

### 13.2 凭据安全与 dataDir 不进 git

- **落盘权限**：`writeGithubSettings` 以 `fs mode: 0o600` 写 `<dataDir>/github.json`（token 明文，仅属主可读写，消除 644 世界可读风险）；`readGithubSettings` 对既有 644 文件兼容，无需迁移。
- **dataDir 不进 git（三重闭环）**：
  1. `.gitignore` 已含 `data/`；
  2. 默认 dataDir `~/.paneflow` 位于仓库外；
  3. **github-sync 仅 push `templates/*.json`**——沉淀用 token 来自 env `PF_GITHUB_TOKEN`，不落盘、不 push，凭据文件永不进入仓库。
- 结论：凭据/运行时数据（github.json、gateway.json 等）与模板沉淀（`templates/`）严格分离，仓库内无明文密钥。

### 13.3 端到端验收的运行时前置步骤

默认实例（`~/.paneflow`）下 github.json 不存在时凭据卡为空；验收前需**先置独立数据目录 + PUT 凭据，再跑冒烟**：

```bash
# 1) 独立实例（指定数据目录；默认 ~/.paneflow 亦在仓库外）
PF_DATA_DIR=/tmp/pf-data pnpm dev:server

# 2) 先置凭据（token 空 = 保留已存值）
curl -s -X PUT http://127.0.0.1:4310/api/github/cred \
  -H "Content-Type: application/json" \
  -d '{"token":"<PAT>","defaultRepo":"JXzfluser/PaneFlow"}'

# 3) 冒烟：确认就绪 + 缺 repo 走 defaultRepo 兜底
curl -s http://127.0.0.1:4310/api/github/cred        # → tokenConfigured:true, defaultRepo
curl -s -X POST http://127.0.0.1:4310/api/github/create-issue \
  -H "Content-Type: application/json" -d '{"title":"smoke"}'   # → { number, url }（缺 repo 兜底成功）
```

- 错误路径复现：全新 dataDir（不 PUT）→ 缺 token 400；仅 PUT token 不 PUT defaultRepo → 缺 repo 400；缺 title → 400；PAT 无效 → 401 透传 message。
- 路由链 #3 抽查：triage 产物 `extra.suggestedTemplate` / `extra.issue_id` 经 route(pipeline) 节点 `{{...}}` 插值拉起交付（fallback 未触发）；triage 提示词内置的 curl 即 13.1 的 create-issue。
- 默认实例的凭据配置视为 **verify 阶段运行时前置**，不单列为验收块（达标证据复用 /tmp 独立实例实测）。

### 13.4 合成 Issue 清理清单

| Issue | 来源 | 处置 |
|---|---|---|
| #4（title `t`） | 缺 repo 负路径测试时 defaultRepo 兜底意外创建（实测通过兜底分支的副产物） | 关闭/删除 |
| #2（「测试-可删除-2」） | 历史遗留合成 Issue | 关闭/删除 |

```bash
# 仅针对合成实例，非用户 Issue
gh issue close 4 -R JXzfluser/PaneFlow
gh issue close 2 -R JXzfluser/PaneFlow
# 需彻底删除时：gh api "repos/JXzfluser/PaneFlow/issues/4" --method DELETE
#   （GitHub REST 支持 DELETE /repos/{owner}/{repo}/issues/{number}）
```

## 13. 自闭环打磨清单（基于 8 个真实 run 会话的断环点审计，已落地）

> 审计方法：盘点真实运行会话（E2E 冒烟/受理/下发/交付骨架）中每一处需要人工介入、产物泄漏或非优雅终止的环节。

| # | 断环点 | 闭环方案 | 状态 |
|---|---|---|---|
| 1 | 运行产物（.herdr/artifacts）污染用户项目 git（实测 4 个文件被误提交） | run 启动时自动确保工作区 .gitignore 含 `.herdr/`；已 untrack 误提交产物 | ✅ |
| 2 | claude 启动确认框（trust/bypass）需人工按键 | `--settings` 预接受消除 + 启动闸门自动应答一轮（下移+回车），未决才转人工 | ✅ |
| 3 | 交付完成后代码变更不入库（靠人工提交） | 交付型/标准型骨架 wrapup 内置 git 收口指引（Conventional Commits + 关联 Issue） | ✅ |
| 4 | 子运行进度在父级不可见（只见"运行中"） | 父 route 节点实时镜像子运行节点粒度进度（含模板信息），运行中心/画布直接可读 | ✅ |
| 5 | 弱模型不守产物约定 → 动态扇出失败 | 扇出回退单分支交付；失败信息带上游产物字段诊断 | ✅ |
| 6 | 启动慢（免费网关冷启动 90s+）被误判失败 | 启动/就绪超时扩至 4/6 分钟 + 就绪闸门（blocked 转人工） | ✅ |
| 7 | gh 命令 410（EMU 账号/沙箱过滤） | GH_TOKEN 注入 + 沙箱白名单 + create-issue 确定性原语 | ✅ |
| 8 | 终端预览历史为空 | 多源读取 + 快照留档回放 | ✅ |

**剩余（P2 规划中）**：同 issue 幂等锁、独立 human 节点类型、定时触发（巡检骨架）、flow.yaml 导入器、浏览器通知细粒度设置。

**自闭环的当前定义**：一句任务描述下发后，从规划、并行执行、产物留档、git 入库、Issue 回链到通知提醒，全程无需人工介入；人工仅在两类时刻被邀请——**审批**（高危确认/澄清问答）与**验收**（manual 检查门）。
