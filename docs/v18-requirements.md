# PaneFlow v18 新版需求梳理（对标 T3 Code）

> 输入：pingdotgg/t3code（23.7k★，"agent harness control surface"）+ 前序 todos.dev 对比 + 本轮易用性改造的沉淀。
> 性质：评审稿。评审通过前不入远端（家规）。

## 一、定位结论（先说清楚跟 T3 Code 是什么关系）

| | T3 Code | todos.dev | PaneFlow 现状 |
|---|---|---|---|
| 本质 | 单 agent 会话的**控制面**（手机/Web/桌面三端） | 团队任务看板 + Chief 拆解 | 多 agent **DAG 编排 + 可审计交付** |
| 单位 | thread（可续谈的会话） | todo 卡片 | run（一锤子 DAG，跑完即止） |
| 远程 | 核心卖点（token/中继） | 云托管 | ❌ 本机 only |
| 审阅 | PR file revisions + SnapShots | 卡片级 | 审阅队列（有门无 diff） |
| 权限 | permission modes 三档拨盘 | 简单确认 | 七处人工门（有门无档位） |
| 用量 | usage & limits 中心 | token 显示 | run 级 cost 账，无总览 |

**关键判断：T3 Code 与 PaneFlow 不是竞品，是互补层。** T3 Code 解决"随时随地指挥一台机器上的 agent"，PaneFlow 解决"一群 agent 按图施工、交付可审计"。新版目标 = **借 T3 Code 的控制面骨架，补齐 PaneFlow 的远程与审阅短板，让"可审计编排"这个差异化随时可触达**。

差异化叙事（对外一句话）：*T3 Code 让你随时看到 agent 在干什么；PaneFlow 让一群 agent 按图施工、每一步可机检、每个门有人拍板、每笔账能对得上。*

## 二、需求清单

### P0 —— v18「控制面骨干」（对齐 T3 Code 的最低 complete 集）

**R1 远程访问 + 手机放行**（对标 remote-access / Devices / mobile）
- 现状：server 只听 127.0.0.1，无令牌暴露模式（AGENTS.md 已预留 PANEFLOW_TOKEN 设计但未实现完整链路）。
- 需求：① `paneflow serve --remote` 生成一次性配对码/长令牌，Web 面在手机浏览器/PWA 可用；② 看板与审阅队列做移动端窄屏适配（5 列板横向滚动 + 审阅卡片全宽）；③ 审批门推送到手机后**就地批准/驳回**（配合 R2 的档位）。
- 验收：手机浏览器配对后，完成「看板查进度 → 审阅队列批一道门」全流程，不经桌面。

**R2 运行权限模式**（对标 permission-modes）
- 现状：审批门全开或全关（dispatch confirmGate 一枚布尔），粒度粗。
- 需求：派发时选三档——`只读咨询`（禁写副作用+机检全跑）/ `常规`（关键门等人）/ `自动放行`（只留契约门），档位入 run 契约、看板卡片显示档位徽标；与 W3 授权声明（declares）对账联动：自动放行档撞上 gitPush=false 声明 → 照旧只照不拦但徽标转黄。
- 验收：三档各派一单，看板能读出档位，自动放行单中途无人值守跑完。

**R3 审阅升级：diff 看板**（对标 source-control / PR file revisions）
- 现状：产物架有 diff 文件（changes.diff 自动采），但没有渲染审阅面；审批门批准时看不到"改了什么"。
- 需求：审阅队列卡片展开后内嵌 **改动摘要**（文件清单 + 行数增删，读架侧 diff 原文渲染），深看跳终端预览/产物架；完成态 run 的详情页给「改动总览」页签（worktree 回收后仍可从架侧读）。
- 验收：一单真实修复任务，审批人不打开终端只靠审阅面能说出"这单改了哪几个文件"。

**R4 用量与限额中心**（对标 usage and limits）
- 现状：run.cost 已落账（时长/重试/tokens），散在单卡上。
- 需求：设置页新增「用量」卡（或看板统计牌点开）：今日/本周 tokens 输入输出、按项目/按 agent kind 分组、PF_RUN_MAX_TOKENS 现值与本月触发熔断次数。
- 验收：能回答"这个月哪个项目烧了多少 token"而不用翻 run 列表。

### P1 —— v19「会话与交付缝合」

**R5 运行续谈（thread 化第一步）**（对标 threads）
- 现状：run 终态即死，返工要重派全单。
- 需求：完成/失败单给「续谈」入口——在同一项目上下文开一轮新 run，自动注入上单产物摘要与失败原因（黑板已有 artifact 约定，加一枚"前情"注入块）；模型沿用上单骨架。
- 验收：对一单失败任务点续谈，新单的 planner 上下文里能看到上一单败在哪。

**R6 服务化与自更新**（对标 background-service / updating）
- `paneflow service install`（launchd/systemd）+ `paneflow update`；健康页显示版本与"有新版"提示。

**R7 移动端深适配**（对标 mobile-appearance）
- 画布除外（明确不支持手机改图，只读缩略）；任务/看板/审阅/项目四页过窄屏。

**R8 通知卡片化**（对标 T3 的推送体验）
- 飞书/钉钉消息带「批准 / 驳回 / 详情」交互（飞书卡片回调 → server 端点 → 复用 approve 通道；人仍是人，通道只是按钮）。

### P2 —— v20+ 差异化护城河

**R9 快照与回滚**（对标 SnapShots）：节点收口时对交付 worktree 打快照（git stash/ref 级即可），run 详情可回滚到任一节点后状态。**注意与 worktree 回收（B3）的交互**：回收后快照从架侧读。
**R10 多账号**（对标 Multiple accounts）：同 agent kind 多 profile（工作/个人 Claude 账号），节点可选账号。
**R11 语音输入任务**（对标 voice input）：任务输入框加语音转文字（Web Speech API 起步）。
**R12 执行机注册**（对标 todos.dev executor / T3 remote environments）：`paneflow agent register` 把另一台机器注册为执行机，跨机派单。

## 三、负面清单（本轮明确不做）

- ❌ MCP 工具桥接（v13:285 已裁决不自实现 MCP 客户端，注册中心只做声明账）
- ❌ 云托管服务/账号体系（保持本地优先、BYOK）
- ❌ 替换用户的 agent 订阅（T3 Code 同款边界：只驾驭已装好的 CLI）
- ❌ 手机端画布编辑（只读缩略即可，图编辑是桌面场景）

## 四、里程碑

| 里程碑 | 主题 | 范围 | 出口判据 |
|---|---|---|---|
| v18 | 控制面骨干 | R1-R4 | 手机配对后可批门；三档权限可跑通；审阅看得到 diff；用量一屏可答 |
| v19 | 会话与交付 | R5-R8 | 失败单可续谈；服务化安装脚本可用；飞书卡片能批门 |
| v20 | 护城河 | R9-R12 | 快照可回滚；执行机注册跑通跨机单 |

## 五、与既有裁决的衔接（防止新需求踩旧红线）

- R1 远程暴露复用 AGENTS.md 既有约定（PANEFLOW_TOKEN → Bearer），不新造第二套鉴权
- R2 权限档位是**契约层的枚举**（contract.mode 的延伸），不动引擎调度器；七处门的实现继续共用
- R3/R9 的"改了什么"一律读**架侧正身**（产物架/shelf），workspace 侧蒸发了也能审——B3 回收语义不破
- R5 续谈注入"前情"走 K1 命名产物同一把尺（硬引用解析不到=明确失败，不喂裸花括号）
- R8 通知按钮最终走 `/approve` 同一端点，人等分账照记（按钮=人，通道不是人）
