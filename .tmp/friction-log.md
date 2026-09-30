# 首驾摩擦账（真实任务驱动 PaneFlow：Issue #6 → dispatch → PR）

> 记录口径：只记本次真实使用中实际撞到的，不预判。任务 = 在 PaneFlow 自己仓库上跑 issue→编排→PR 闭环（需求：wiki 沉淀升级 llm-wiki 风格）。
> run: c16fd31e · clone cwd: ~/Documents/PaneFlow-run-clone · 2026-09-19

## 已撞到

1. **脏检查把 untracked 也算脏**：llm-wiki 仓库 17 处改动（含个人 KB 常态的未跟踪 raw/）直接拒绝起 run。对个人知识库/资料仓这类"永远有未跟踪文件"的 cwd，首驾第一天就被挡在门外。需要：untracked 与 tracked-modified 分级，或 cwd 级豁免配置。
2. **git 凭据账号劫持**：wrapup/deliver 要在 cwd 仓库 push，但 git 默认走系统 osxkeychain——本机 keychain 里是**错误账号**（zhufl02_onewo）。PaneFlow 把 PAT 存进 ~/.paneflow/github.json 并给 pane 注入 GH_TOKEN（gh CLI 正确），但 `git push` 不读 GH_TOKEN（HTTPS 远端走 credential helper）。结果是「gh 能建 issue、push 却认证错号」的割裂，用户必须手动给 clone 配 credential.helper 覆盖——这个知识引擎里完全没有，也没在任何文档里。需要：run 起 cwd 时若 remote 是 github 且已存 PAT，自动注入临时 GIT_ASKPASS/credential 覆盖。
3. **PUT /api/github/cred 响应不回显 defaultRepo**：只回 {saved, tokenConfigured}，设置默认仓库后必须去翻 ~/.paneflow/github.json 才能确认落盘。反馈闭环缺一角。
4. **dispatch 响应太瘦**：{runId, issueId, issueFetched, contract}——没有子图名/节点清单/查看入口，前端要再拉 /api/runs（整个列表带全量 graph，很重）才能定位这次 run。缺 `GET /api/runs/:id` 的轻量指向或响应里带 run 摘要。
5. **api.github.com 网络**：本机直连 443 抖动严重（此前 push 空回、需走 127.0.0.1:7897 代理）。create-issue/fetch-issue 直调 https://api.github.com 无代理配置项——本次碰巧直连通了。文档/env 面缺 HTTPS_PROXY 透传说明。

6. **waitForSettle 藏了个 40-poll 调试探针（首驾必杀雷，已修 04a234c）**：`polls>40` 把每个 agent 节点等待硬顶在 ~45s，完全无视传入的 30min timeoutMs——第一次真实派发 planner 就被 `waitForSettle polls=41 ... status=working` 误杀（fail-fast 两试共 105s）。此前实机验证从未跑过 >40s 的单节点？说明"绿跑"样本对等待路径覆盖为零。deadline 检查本已有界，探针纯属遗留。教训：**调试探针不许进主干**；settle 等待路径需要一条"working 持续超过探针窗"的回归测试。

7. **同 issue 幂等锁父撞子自我死锁（首驾第二发实抓，已修 3812bf0）**：派发父 run 带 issueId=6，route(pipeline) 节点透传同 issue 起子 run，被 R3.4 锁当成「重复下发」拒绝——即派发链只要带 issue 就 **100% 走不到子流水线**。错误信息还被 onChildStarted('') 覆盖成半截「子运行 」（节点上看到的 error 无信息量，真凶要靠 server.log 栈）。修：RunRecord.parentRunId + 锁排除祖先链 + 回归测试。附带两处可发现性问题：a) 子 run 启动失败时节点 error 停留在 `子运行 `（占位写太早、失败不清理）；b) run failed 后 GET /api/runs/:id 无「崩溃原因」面，crash 栈只在 server 日志。

8. **跨 run 仓库软锁只借不还（首驾第三发实抓，已修 7f32f96）**：repoClaims 在节点拿到锁后没有任何释放点——父 run planner 跑完仍"持锁"，pipeline 子 run 的 align 排队等它、父又在等子 = 环形等待，要白等 max(60s,timeoutMs)（~30min）才超时失败。第三发实抓证据：`3b559054/align queued「等待仓库锁：被 run 47015711 的 planner 占用」` 而 planner 早已 done。修：attemptNode 包 finally 按 run+node 归还 + holder 审批放行后 waiter 跑完的回归测试。另注意：**服务重启 = 内存锁清零**，孤儿 pane 留在 herdr 里没人收（本次留下 3b559054 的 align pane），pane 生命周期与 run 恢复不同步。

9. **worktree 重试不幂等（第四发实抓，已修 80af93f）**：回收只删目录不删分支，节点 retryCount 重试再走 `worktree add -b` 必炸「分支已经存在」——impl__3/4 第一次只是 prompt stalled，重试反而死于 git 报错。修：残留目录→续用 / 仅分支→挂载续用 / 无→新建。
10. **网关免费档扛不住 fanout 并发（第四发根因）**：5 路 impl 并行 pi → 上游 503 `chat_admin_busy（structurally heavy chat request capacity is busy）`，pi 自带 3 次重试仍失败后**退回 idle**。pane 里明晃晃印着 Error，但 run 侧只看到 `agent_prompt_stalled`（见下条）——错误可见性断在最后一跳。引擎对"走同一网关的 agent 并发"零感知：PF_MAX_PANES 能限但属全局钝器，缺「按网关档限流」的配置。
11. **确认窗把「agent 干完/撞错退回 idle」误判为「prompt 石沉大海」**：impl__2 那种 4 分钟正常完结靠运气（45s 内离开了 idle），而 503 死掉的分支状态从未离开 idle 视野（提交时 working→立刻 idle）也被记成 stalled——错误信息「末次状态 idle」已经提示有鬼，但**没把 pane 里的报错尾行带进 run 记录**。stalled 应附带 readOutput 尾部（引擎手里就有这个函数，失败路径却不用）。
12. **verify/deliver 死了 run 仍叫 completed**：fanin 宽容 + 末节点 skip，dispatch 聚合只看 run.state → 「绿」的语义在真实多失败下完全失真（本发 6 红 4 绿仍 completed）。至少 failed>0 时该给 `completed-with-failures` 或在 state 里可辨。
13. **M4 接单回写污染工作区**：align 把 issue-draft.json 写回 cwd 仓库 tracked 文件 → run 结束仓库必脏 → 同仓下一次 startRun 被 R3.3 脏检查挡死（第四发前手动 checkout 还原才通）。回写目标应默认 untracked 区（.paneflow/ 草稿目录）或沉淀完自清理。
14. **孤儿 pane 无回收**：三次重启+失败留下多个 herdr pane（pf-e50afd-* 等）无人关，永不复用还占屏幕；herdr 又不能重启。需要 boot 时「无父 run 的 pf-* pane 清理」。

## 待观察（跑完补）

- planner 走 pi+网关免费档：超时/限流表现
- route 子流水线的审批门（manual pre-push）在前端与 API 两侧的可发现性
- wrapup 分支守卫（pf/<run_id>）在 agent 误切分支时的纠错
- wiki 沉淀点赞入口对本 run 是否可用（沉淀→本需求正好形成自指闭环）
15. **wiki 功能 API 开了但仓库不落地，沉淀失败文案无指路（首驾实测撞墙）**：`PATCH has_wiki:true` 返回 200 且 GET 确认 true，但 `<repo>.wiki.git` 匿名 clone、token ls-remote、空仓 init+push、false→true 翻转全部「Repository not found」——GitHub dotcom 现在只认 Web Settings→Features→Wikis 的人工开关（或网页建首页）来初始化 wiki 仓库；叠加第二层：`github_pat_` 细粒度 token 本就不支持 wiki 的 git 访问，双堵。产品侧 publishWikiPage 只把 git 报错截成「git clone 失败：正克隆到…」一行，用户完全不知道下一步该干嘛。待办：a) 沉淀失败按 404/not found 给「请先在网页设置开启 Wiki」指路文案；b) 认真评估把 llm-wiki 沉淀目标改成普通仓库目录（Contents 权限即可推，细粒度 PAT 友好，读回逻辑不变）。
16. **调度洞：并发上限挤出 pending 的 ready 节点凭空蒸发（第五发实抓，已修）**：schedule() 扫描先把节点从 pending 摘掉，再看 `paneSlots.acquired >= capacity` 就 break——被挡的节点既不在 pending 也不在 inflight，收尾判据 `!pending && !inflight` 直接成立，run 带着未跑节点「completed」（第五发 impl__4 即此症；连旧测试 cap=2/3分支 也是靠不检查 fc 才一直绿）。修：没启动就归还 pending + capacityBlocked 时轮询等释放（不空转）+ cap 测试补全分支断言 + 单分支上限回归测试。
17. **沉淀落点改造落地 + 假重启陷阱（Issue #7 实机收口）**：按 #15 的 b 方案把落点从 `<repo>.wiki.git` 改成主仓 `llm-wiki/` 目录（sparse 浅克隆 + 默认分支推送 + push 被前移时重试一次），两发真沉淀（cabc2242/ba2751bf）已上远端 main 并验 index/log 记账。过程踩坑：改完代码 `pkill -f 'tsx packages/server/src/index.ts'` 没杀掉真身（tsx 会 re-exec，实际命令行是 `node --require preflight.cjs --import loader.mjs …`），旧进程仍占 :4310 用旧 wiki.git 代码应答，新实例 EADDRINUSE 崩在日志里——**验证前必须 lsof 查监听者 PID**；另外探针 clone 曾挂在凭据提示上（macOS 无 timeout 命令），服务启动须 `GIT_TERMINAL_PROMPT=0`。附带门疑点：ba2751bf（派发父 run，0/6 断言通过、无显式 fail）仍过了 publishableRun 进沉淀——绿的语义在沉淀门上再次失真，和 #12 同源，后续该统一收口。
18. **沉淀直推 main 与开发 checkout 天然分叉（设计后果，首次撞上）**：publishWikiPage 往 `<repo>@默认分支:llm-wiki/` 直推后，任何本地 clone 的 main 都会落后于自己产生的沉淀提交——本次推 fe53281 就被 non-fast-forward 拒（远端多了两条沉淀提交）。这次靠「改动面不相交 + rebase --autostash」无冲突化解，但这是每次沉淀后推代码的固定仪式。产品侧要么沉淀走独立分支+PR，要么在文档里把 rebase 仪式写死。

#19 v11 第一批多智能体实装（2026-09-20）：tsx re-exec 再验证——重启认 PID 走 lsof 的仪式第三次救命；D5 实现 agent 会话中途断线留下「大半半成品」，教训=并行 agent 断线后必须先 git status+grep 盘点已落 hunk 再补派（本次 engine.ts 注入与模板改词已完好，只欠测试）。另记：release launcher 合流后 bin 行为分叉面=首参命中 5 子命令，回归须保 else 分支逐字节旧行为（已锁）。

#20 v11 第二批收口（2026-09-21）：同树并行 agent 崩溃已成模式——D5/C1 之后 C3b+E1 双 agent 再度双双断线（「Unable to connect to the service」，各烧 35+/37 tool uses），且这次只落了半成品（C3b 纯函数+渲染面、E1 仅 shared 类型字段）。裁决 protocol 升级：**同一批次同一实现 agent 第二次断线就不再补派，收尾 agent 直接 inline 补完**（本次当日完事，C3b+E1 全绿入账）。测试补完时抓到两个只有测试能抓的真 bug：a) **fs.appendFile 会静默建档**——「ENOENT 才写表头」的建档判据从未触发过，收数表表头实际永远不落盘；改成 'ax' 排他 append（连头带行一次写、EEXIST 转普通追加），顺带免疫并发收口互踩。教训：**拿异常当控制流必须配一条专门证该异常路径的测试**。b) RunCost 顶层有 retries（我凭印象改成 byNode 求和，tsc 的 fixture 报错反而是正确答案）——记账字段先读接口再写实现。另：测试夹具写嵌套路径页（summaries/x.md）必须 seedCache 先 mkdir 父目录，ENOENT 一片红才想起来。CLI 冒烟差点栽在拿 main.ts（库）当入口跑——tsx 直跑要指 index.ts，输出为空≠通过。

#21 v12 四波实施（2026-09-22）：a) **单 commit 自洽性盲区**——S2 波 agent 改了 shared/index.ts 导出 RunTokenLedger 但收口人 staging 清单漏了它，工作树 tsc 常绿掩盖「该 commit 单独 checkout 编译不过」，下一波开工才暴露（d92be10 补偿入账）。教训：**commit 前把 git status 剩余未跟踪/未暂存改动逐条对号**，凡「agent 说还有一行没提交的遗留改动」必须当场查明归属并入最近的账。b) 审计给的一处缺口实查是三处——V2 任务书点名「对话框门拦侧无事件」，agent 核实澄清轮门、启动确认升级路同病同治；对账结论是「快照」不是「全像」，立需求时留「同类扫一遍」的验收钩子。c) S2 第一派即断线（本仓累计第四次），补派一次即完工——「断线≠任务难」，协议内一次补派的额度够用，勿因断线改判需求砍功能。d) 实机冒烟的零成本姿势：旧单读端（新键整缺不炸）+路由门 400/404+空表直呈+CLI 直跑，全链起单路（harness 固化/熔断/结算）如实留给 C4 第一夜——**不烧配额换冒烟绿**。
#22 CLI 可感面断在「安装」最后一步（2026-09-22，用户实指）：v11-A1/A2 把 CLI 功能、bin 合流打包（build-release.mjs）都建齐了，但从未发过含 CLI 的 Release，AGENTS.md 按「paneflow 在 PATH 上」的假设口吻写说明书——用户机器 command not found，全部可感面不可见。教训：**说明书的每条命令须先在干净 shell 原样跑一遍；功能=代码+打包+PATH 三步，缺一步等于零**（[[可感面]]纪律的安装维度）。临时补法=~/.local/bin dev shim（tsx 直跑 packages/cli/src/index.ts），正式路=推码后发 v0.2.0 Release。

## #23（2026-09-23，C4 第一夜开跑即踩）CLI dispatch 15s 前端超时 vs 慢派发的「假失败真建单」

现象：`paneflow dispatch "…" --repo --issue --space --json` 报 `✘ The operation was aborted due to timeout`（client.ts:34 `AbortSignal.timeout(15_000)`），退出码 1；**但服务端其实已建成单**（`paneflow runs` 第一条 ● running 198be1b9）。根因猜测：派发路要抓 GitHub issue（代理链路 4310→7897→GitHub 可超 15s），CLI 超时阈值按本地轻请求设的。

危害：无人值守脚本（如 c4-night1.sh 的 dispatch 循环）会把「成功建单」当失败 `die`，或重试造成**重复建单**。

处置口径（今夜）：手动开跑不依赖脚本；判定以 `paneflow runs` server 侧为唯一事实源。
候选修法（留门，勿今夜动）：a) dispatch 超时单独放宽（如 60s）；b) 超时后先 GET /api/runs 查最近 run 再定性；c) 服务端 dispatch 异步化先回 runId。附 EPIPE 噪音：`paneflow runs --json | head` 时 CLI 未处理 stdout EPIPE，小修。

## #24（2026-09-23，C4 第一夜）release bin shim 子命令白名单漂移——replay/experiments 发行版不可用

`paneflow replay …` 在装出来的全局 CLI 上**掉进起 server 分支**报 EADDRINUSE。根因：build-release.mjs 生成的 `bin/paneflow.mjs` 硬编码五成员白名单（v11-A1 时点），v12 加了 replay/experiments 子命令（main.ts CLI_SUBCOMMANDS 七成员）没人回头补这行——AGENTS.md 写明的说明书命令在发行版上根本打不到。测试全绿因为单测直接调 main()，不穿 bin 路由。
修法（今夜已改源，随下次发行生效）：shim 改从 `cli.mjs` 导出的 `CLI_SUBCOMMANDS` 动态取集合，硬编码清零、单一事实源；微缩验证三路由（replay/experiments→CLI、裸参→server）。
教训：**发行物面（bin 路由表）也是需求可感面的一部分**——新增子命令的验收清单必须含「release 装出来打得通」，同 #22（代码+打包+PATH 三步论）的第四层：路由。

## #25（2026-09-23，C4 第一夜）stalled 确认窗误报杀真干活节点（impl__2 + wrapup 双发）

子单 f6b7bc97 两节点被 `agent_prompt_stalled：提交后 45000ms 无状态变化（确认窗，末次状态 idle）` 判死，**但输出尾部明晃晃挂着「⠧ Working…」spinner**——agent 正在执行 #8 的 grep 工序，工作树里 README 成果完好。wrapup 更冤：提交后仅 47s 即被判。一次误报可能是网关慢响应，双发+47s<45s+确认窗的时序说明 pane 状态采样把 pi 的 TUI 重绘间隙读成 idle、或重试后状态机没复位（impl__2 是第 1 次重试轮上中的）。
今夜口径：成果靠 from-failed 复跑接力；账先立着，读数=**stall 误报率非零且不可忽略**，是「敢隔夜放手」的头号反面证据。待查：确认窗的 idle 判据源（herdr pane state vs 输出静默）与 retryCount 后的状态复位。

## #26（2026-09-23，C4 第一夜）fanout 子单的 replay 整体不可用（--from-failed 与普通复跑同拒）

对含动态展开的单（impl 模板节点 + 实发 impl__1/impl__2）POST /replay 一律 400「DAG 校验失败：节点不可从开始节点到达：实现 {{item.name}}」——克隆图时 fanout 展开记录未随迁，模板节点悬空。**E1 replay 与 S3 from-failed 的隐含边界：只吃静态图**；受理路派生的 delivery 子单恰恰全是 fanout 图=实验主战场全不可复跑。今夜绕行=父单 from-failed（route 重放自然生新子单）。修法候选：克隆时把 fork.expand 指向的 plan 产物断言重演（真复跑）或把已展开节点连边原样带走（继承式）——裁决等明晨，先入账。

## #27（2026-09-23，C4 第一夜）pi 沙箱逐文件白名单 × 引擎草稿路=弹窗地狱（#9 子单死因）

`~/.pi/agent/sandbox.json` 的 allowWrite 是**逐文件**累加制（每按一次 [A] 加一条精确路径），而 PaneFlow 的产物路径天然发散：`drafts/<runId>/…` 随单换目录、`.herdr/artifacts/<nodeId>.json` 随节点换名、隔离 worktree 在 `/private/var/folders/…/paneflow-wt/<run>-<node>/`。组合结果=agent 每写一个新文件弹一次权限窗，无人值守夜跑必然被 auto-abort 收割（#9 的 wrapup 就是这么死的：弹窗 586s 超时→HEAD 还在 main→分支守卫红）。
今夜处置：sandbox.json 手工升级四条目录级授权（drafts 树/跑单克隆/paneflow-wt 根/tmp）。
正解（待开工，v13 候选）：**引擎起 pi 时就把本单产物根注入沙箱授权**（对齐 claude 分支的 --settings 通道），模板/引擎谁落的文件谁开闸，不许让机器活等人点窗。守卫侧战果如实记：分支守卫在 wrapup 死后守住 main 零提交。

## #28（2026-09-23，C4 第一夜）resume 链跨单串味：#9 的 run 拿着 #8 的方案词干活

ec936d52（issue=9，2e7912ba 的 resume）的 impl 快照实锤：任务词整段是 **Issue #8 的实现方案定版**（PF_GW_* 四旋钮、+28 行），而盘上 `.herdr/artifacts/planner.json` 已是 issue_id=9。同 cwd 一条 resume/replay 链上跑过 #8 又跑 #9，align/plan 的产物文本在 dispatch 时被嵌进节点 brief，resume 只继承节点不重规划——继承的 done 节点带着前任单的语境继续演，写的 README 是 #8 已交付内容的复刻（PR #11 里早有真身）。wrapup 分支守卫红只是末端症状，真雷是**验收过的 impl 干的根本不是本单的活**——F2 resume×同 cwd 复用的语料污染，三夜语料若混进这种「假绿」整批作废。
今夜处置：污染工作树 stash（`c4-night1: #8 dup README section`）、陈旧 `.herdr/artifacts/*.json` 归档让路，#9 改**全新 dispatch** 重跑（新 plan 新 brief，不再 resume 受污染链）。
修法候选（明晨裁决）：resume 入口校验 `issueId` 与被继承节点产出语境一致；或草稿/产物按 runId 分目录（`.herdr/artifacts/<runId>/`），物理隔离断掉串味路。
