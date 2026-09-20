# v11 需求：入口、可靠性与复利实证（目标 → 支柱 → 需求）

> 立项来源：2026-09-20 用户四条——①勘 Genspark GenTeam；②CLI 派活入口；③「复利比收件箱重要」；④「根据现有功能做冗余移除与迭代」（v3 代码对账轮，见文末对账记录）。
> 口头裁决链：B 组降 backlog → 可靠性+Harness 立第三/四支柱 → v3 按代码现状砍冗余。
> GenTeam 勘研：Slack 骨架 × AI 数字员工一等群成员（读消息流/认领任务/汇报进度、任务板人机同 assignee、可连自己电脑本地执行）。证据只到 App Store 官方描述+URL 结构，未取到运行时交互（gate0：只记描述面）。裁决：不抄聊天壳。

## 目标（一句话）

v11 把 PaneFlow 从「人开网页盯 run」推进到「AI 一条命令派活、机器验收说话、夜里敢无人值守跑、复利有实证分母」——且 v3 起每条需求都以代码现状为凭：**已有的不重做，前提错的改写，读回链的真实缺口（C3a）补上**。

## 支柱一：同步本地入口 —— `paneflow` CLI

- **A1 CLI（与现有 launcher 合流，v3 修正）**：release 链已生成 `bin/paneflow.mjs`（server+web 启动器，`scripts/build-release.mjs:44-74`，install.sh 装的正是它）——**不另起第二个 bin**。`paneflow` 统一入口：无参/`serve` 保持现启动行为，编排子命令走新 `packages/cli`：
  - `paneflow dispatch "<一句话>" [--repo x/y] [--issue N]` → runId+子图摘要（顺带还 #4：现响应仅 `{runId, issueId?, issueFetched, note?, contract摘要}`，http.ts:1083-1093，无节点清单——server 端只读聚合扩字段允许，CLI 包内零业务）。
  - `paneflow runs [--json]` / `status <runId>` / `approve <runId> <nodeId>`。
  - `paneflow watch <runId> [--timeout 30m]` → **退出码即验收**：0 全绿 / 1 有红 / 2 超时 / 3 停在审批门（stdout 给待批 nodeId；CLI 不替人过门）。
  - 地址解析链：`--url` > `PANEFLOW_URL` > `~/.paneflow/cli.json` > `http://127.0.0.1:4310`。
  验收：mock 单测（watch 四态）；真 server 冒烟 dispatch→watch→(approve)→watch；**旧启动方式零破坏**（release tgz 里 `paneflow` 直接跑仍起 server）；tsc 净。
- **A2 agent 说明书**：`AGENTS.md` 增派活节（CLI 优先、curl 退路端点字段列全）。验收：每条命令可原样执行。
- **A3 MCP shim（后置）**：CLI 的转发壳，A1 有真实 agent 用过再立单。

## 支柱二：执行可靠性 —— 无人值守前置（v3 逐条按代码现状收窄）

- **D1 网关感知限流（#10，保留）**：现仅有全局 pane 信号量（`paneSlots`，PF_MAX_PANES，engine.ts:76/742）+ 项目级 `maxConcurrentRuns`（engine.ts:408-417），无任何按网关的配额——第三层限流确实缺。验收：注入 503 的 mock 网关回归（排队→错峰重放→收口）；与现有两层取交集。
- **D2 stalled 带报错尾行（#11，保留）**：已核实失败路径只存裸 `err.message`（engine.ts:1259-1260→983），`readOutput` 只在成功/协商路径用——错误尾行就在手边却不采。验收：fake ops 输出含 Error → 节点 error 含末 ~800 字符。
- **D3 run 状态分级（#12，保留）**：已核实 RunState 只有 5 态（shared/dag.ts:353-359），`onFail:'continue'` 的失败节点照样收口成 `completed`（engine.ts:636-638）——语义失真坐实。加 `completed-with-failures`，沉淀门（C2）与 watch 退出码消费之。验收：引擎两态单测；API/web 可见区分。
- **D4 孤儿 pane 漏网排查（#14，v3 收窄：不是从零建回收）**：boot 孤儿清扫**已存在**（`recoverOrphans()` engine.ts:199-219，index.ts:67-74 调用），首驾仍留孤儿说明按 label 前缀匹配有漏网形态（如 align pane）。改为：实抓复现漏网 → 补匹配兜底；`client.paneClose`（client.ts:245）现零调用者，可作单 pane 精确回收的现成弹药。**红线不变：只碰 `pf-*` 命名空间，绝不重启 herdr。**
- **D5 草稿回写落点修正（#13，v3 前提更正）**：对账发现 M4 接单模板回写走 GitHub Contents API 远端路径（`.github/ISSUE_TEMPLATE/paneflow-intake.md`，dispatch.ts:141），**根本不碰 cwd**；#13 脏 cwd 的真凶是 align 节点把 issue-draft.json 写进工作区 tracked 文件。需求改为：align 草稿产物一律落 dataDir（或 run 目录），cwd 只读约定写进节点 prompt。验收：临时 git 仓起 run 后 `git status` 干净。

## 支柱三：知识复利转实（v3 重排：先补读回断链，再谈回链与实证）

- **C2 沉淀门 fail-closed（先修门，v3 精化）**：现门**已经在查断言**（wiki.ts:76-84：completed + 无 unverified + 断言行无显式 fail），ba2751bf 钻的是「0/6 条**没跑**≠fail」的空子——fail-open 语义。收紧为「**≥1 条 pass**」的 fail-closed；失败 run 走「反面教材」侧门（`confidence: low`+页首警示+index 条目 ⚠ 前缀+读回降权）。验收：0-pass run 拒正库/failed run 进侧门两向单测；schema 文档同步。
- **C3a 读回接入执行链（v3 新增，本支柱真正的缺口）**：对账实锤——wiki 读回目前**只发生在 `POST /api/issues/enhance`**（派单前提示一句，http.ts:853-866，且只回个数不留痕），**引擎 agent prompt 零注入**。复利的读端在执行链上名存实亡，C4 的 A/B 若无此环就是空转。做：plan/impl 节点 prompt 注入 top-k 沉淀摘录（按 run 仓库缓存读回），env 开关 `PF_WIKI_READBACK=on|off` 供 C4 对照。验收：注入路径单测（含开关两态）；实机一次 run 的 pane prompt 里可见摘录块。
- **C1 蒸馏 + 旧页更新**：wrapup 后异步蒸馏（经验账本→可泛化条目，命中既有 concept 页则改写、`updated` 真被用上，无则新建；流水账照旧进 `summaries/`）。**蒸馏失败/超时不阻塞收口**（多一次 agent 调用，与 D1 抢配额，必须可弃）。验收：同主题两 run 后 concepts 单页且 `updated>created`、index 不增；实机复跑看旧页被改。
- **C3b 引用回链**：run `extra` 落「本次实际注入的页清单」（依托 C3a），页 frontmatter `pf-cited-by` 计数；`/api/wiki/state`+run 详情可见「被 N 次 run 引用」；注入整段带出不掐半句。验收：两 run 计数单测；实机详情页可见来源页。
- **C4 复跑实证（唯一实证交付）**：同类小修 ×3 夜，`PF_WIKI_READBACK` 开/关 A/B，记断言通过率/重试数/墙钟，结论进 gate0 风格文档——**不达标就明说复利未成立**。同契约复跑可借 `resumeOf` 的契约继承（engine.ts:361）省重复填单。降级预案：E1 延期则人肉盯跑，E1 不阻塞 C4。
- **C0 沉淀迁移还账（第一批顺手修，Issue #7 遗留外链）**：落点改主仓 `llm-wiki/` 后设置卡片没跟上——①头部与页链接仍指 `github.com/<repo>/wiki(/<file>)`（SettingsView.tsx:394/413），而 publish 回的真 URL 是 `/blob/<branch>/llm-wiki/<file>`（wiki.ts:300）：点开是旧 wiki 空页/404；②`/api/wiki/state` 不回 branch（http.ts:950-951），前端想拼对链接都拼不了——服务端补 `branch`（sync 时已知）；③旧文案「推到仓库 wiki」「其余 N 页见线上 wiki」（RunsCenter.tsx:363、SettingsView.tsx:419）与「沉淀」一词双义（模板云同步也叫沉淀，Guide.tsx:84）——知识沉淀独享「沉淀」，模板那条改名「模板云端同步」。验收：实机点卡片每个链接落到位；文案 grep 无「仓库 wiki」残留。
- **C5 沉淀人味（第二批，贴 C2 同属发布流）**：现链路是「点赞一下→直接 push main」，用户看不见将生成什么、公共仓确认靠 window.confirm 弹错文（RunsCenter.tsx:259）。做：①**推前预览**——`renderWikiPage` 本就是纯函数，加 GET 预览端点，弹层里看页再落确认按钮（公开仓警示并入同一弹层，废掉 409-再点一次-原生 confirm 三段舞）；②push 成功后设置卡自动刷新（现在只 log 一行，页列表不变、`syncedAt` 不动，误导「没存上」）；③页列表升级：按 concepts/summaries/syntheses 分组、带 frontmatter `updated`（七字段里有但 state 不吐）、C3b 的 cited-by 计数在此露出；④读回可见化：enhance 的「带了 N 页沉淀」从一闪而过的 log（TasksView.tsx:134）升级为草稿旁可展开的页标题清单。验收：预览端点单测（含 public 仓警示态）；实机一次点赞全流程走查截图级描述。**不做**：页删除/撤回管理（push 即终局，回退走 GitHub，宁缺毋滥）。

## 支柱四：复跑实验 harness（v3 大幅缩水：批量派发已是现物）

`POST /api/dispatch/batch`（模板 × ≤20 issue，http.ts:1102-1175）、队列/promote（engine.ts:452-486）都已存在——E1 不再包含「批量起 run」。真缺的三片：

- **E1a 同契约 replay**：现被 R3.4 同 issue 幂等锁挡死（engine.ts:231-243）；RunRecord 已 archive variables/dagName（dag.ts:368-370）但没接线。做：`paneflow replay <runId> [--times N]`，实验模式下豁免幂等锁（豁免条件=replay 显式发起）。
- **E1b 实验元数据**：run 打标（suite/flag/arm），`GET /api/runs?suite=` 过滤。
- **E1c 收数表**：跑完落 `experiments/<date>/results.md`（runId/arm/断言/重试/墙钟）。
  验收：三片各自单测 + 2 run 小样实机跑通；**不建 UI、不做统计检验、不做调度**。

## 批次依赖与顺序（v3 重排）

- **第一批（无人值守地基）**：D2 → D3 → D1 → A1/A2；D4/D5 已收窄为小修，随批带上；**C0 随批带上**（纯还账，无依赖，放着就是坏链接）。
- **第二批（复利转实）**：C2 → C5 → C3a → C1 → C3b → E1a/b/c。**C3a 提到 C1 前**：读回先接通，蒸馏才有读者；C5 贴 C2（同一发布流，预览弹层一次把 fail-closed 警示和公开仓确认都装了）。
- **第三批（实证收口）**：C4（依赖第一批+第二批的 C3a；E1 锦上添花，人肉可跑）。

## 明确不做（v11）

- 照抄 GenTeam 聊天壳；多用户/邀请/presence SaaS 面。
- CLI 第二套业务逻辑（含直读 dataDir）；**第二个 paneflow bin**（与 release launcher 合流，v3）。
- 重建孤儿 pane 回收、重建批量派发、重建沉淀断言门（三者代码已存在，v3 对账砍掉的冗余）。
- 读回向量/语义检索（等 C4 数据证明词面是瓶颈）；OAuth 回调；harness 统计框架。

## Backlog（留证据不动工）

- **B1 任务收件箱 / B2 主动认领**：解冻 = B1 实机 ≥3 单 + D1/D3 落地。
- **验收牙齿**：产物 schema 强制、verify 沙箱化、断言溯源——等 C4 数据指认假绿来源再对症立单。
- **定时任务**（E1 的下一寸；已核实全仓无任何 scheduler，只有 reconcile interval）、**移动端审批 PWA**（vibe42 旧账）。
- 工程卫生：master↔main 错位、#18 rebase 仪式文档化、代理/凭据排障进 README（#5）。

## 对账记录（v3，2026-09-20 代码现状审计 → 冗余移除/前提更正）

| 项 | 审计发现（file:line） | 处置 |
|---|---|---|
| A1 | release 已生成 `paneflow` 启动器（build-release.mjs:44-74） | 合流不另起 bin，加「旧启动零破坏」验收 |
| D4 | boot 孤儿清扫已存在（engine.ts:199-219） | 从「建回收」缩为「查漏网+兜底」；paneClose 零调用者可利用 |
| D5 | M4 回写实为远端 Contents API（dispatch.ts:141），不碰 cwd | 前提更正，真凶改判 align 草稿落点 |
| C2 | 沉淀门已查断言（wiki.ts:76-84），钻空机制=0 条未跑非 fail | 从「加检查」改为「fail-open→fail-closed」 |
| C3 | 读回只在 enhance 一处、引擎零注入（http.ts:853-866） | **新增 C3a 补断链**——v2 高估了现状，复利读端此前名存实亡 |
| E1 | batch/queue/promote 已存在（http.ts:1102-1175） | E1 砍半，只留 replay/元数据/收数三片 |
| 沉淀设置卡 | Issue #7 迁移后链接指旧 wiki（SettingsView.tsx:394/413 vs wiki.ts:300）；state 缺 branch；tooltip/Guide 文案旧 | **新增 C0 还账**（第一批）；体验面立 **C5**（预览/自刷新/分组列表/读回可见） |
| D1/D2/D3/C4 | 缺位属实（状态 5 态、失败无尾行、无网关层、无实验开关） | 原样保留 |

## 评审记录（v2 自审 8 条 + v3.1 一条，处置已并入正文）

R1 范围膨胀→批次全为还债/补链无新表面；R2 关键路径长→C4 人肉降级；R3 D4 红线→只碰 pf-* 且走 API；R4 A1 边界→CLI 零业务/server 只读复扩字段；R5 蒸馏可弃；R6 watch 退出码 3；R7 反面教材进 index 带 ⚠；R8 与 v10 裁决一致性通过；R9（沉淀设置评估轮）Issue #7 只改服务端、前端外链成坏链——凡改落点必全仓 grep 旧落点引用入验收纪律；C5 划清「不做页删除管理」防复利支柱再膨胀。

## 实施状态

（开工后按 v10 样式补：项 / commit / 验证三列。）
