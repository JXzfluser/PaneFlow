# AGENTS.md

## 给 PaneFlow 派活

PaneFlow 是本地多 agent 编排台：server（Fastify，默认 `http://127.0.0.1:4310`）握有全部编排 API，
网页只是其中一个消费者。**机器/agent 派活一律走 `paneflow` CLI；CLI 不可用时走 curl 退路。**
CLI 是零业务薄壳（铁律 R4：不直读 dataDir、不自造判据），一切结论以 server 返回字段为准。

约定：以下命令假定 release 安装的 `paneflow` 在 PATH 上；在本仓库内开发时用
`pnpm paneflow <子命令> ...`（tsx 直跑 `packages/cli`）。服务地址解析链：
`--url` > 环境变量 `PANEFLOW_URL` > `~/.paneflow/cli.json`（`{"url": ...}`）> 默认
`http://127.0.0.1:4310`；远程暴露模式带令牌 `PANEFLOW_TOKEN`（转成 `Authorization: Bearer`）。

入口分流（v13-E1 窄判据）：**只有裸 `paneflow` 或 `paneflow serve` 起 server**（起服务与在飞单同源，
别在已有实例的机器上随手敲第二下）；其余任何首参——含 `--help` 与未知命令——一律进 CLI 薄壳，
未知命令由 CLI 报错退 1。这里不维护第二份子命令清单。

### CLI 优先（每条可原样执行）

```bash
# 1) 派活：一句话或整篇 issue 引用皆可；--repo 必须配 --issue（拼规范 issue URL 给服务端识别）
paneflow dispatch "给导出模块加空值兜底" --repo my-org/my-repo --issue 123 --space demo

# 2) 列单：看最近都跑了什么
paneflow runs
paneflow runs --json            # 原始 API 负载，stdout 干净可直接 | jq

# 3) 看细节：run 头 + harness 行（v12-V1 起单实发配置：graph#指纹 · kind= · model= · 档位=，缺项跳过）
#    + 副作用行（v12-S1a 落册账：建单#12 · 回写#7 · PR <url> · 已推送 <时刻>，缺项跳过、无账不显示）
#    + 人等分行（v12-V2 人介入账：人等分: 等待 4.2 分 · 批 2/驳 0/补料 1——审批门
#      拦→放的累计等待时长与决策计数，放门即结算落册；没批过门/旧 run 整缺不显示）
#    + 每个节点状态 + 审批门提示
#    + 掐断账行（v13-S2：节点尝试被引擎中途掐断过时出「⚡ 第 N 轮尝试已掐断（触发点 · 掐时状态）」，
#      触发点取值 settle-timeout/retry/stop/shutdown/agent-gone；一次都没掐过整行不显示）
paneflow status <runId>
paneflow status <runId> --json

# 4) 机器验收：轮询到终态，退出码即结论（无人值守核心用法）
paneflow watch <runId> --timeout 30m    # --timeout 支持 60s/30m/2h 简写，0=不限；默认 30m
echo $?

# 5) 审批：人看完再批；CLI 绝不代替人过门
paneflow approve <runId> <nodeId>

# 6) 复跑实验（v11-E1）：同契约重发 N 份（唯一豁免=同 issue 幂等锁，仅 replay 显式发起）；
#    --suite/--arm/--flag 打实验标，带 suite 的单到终态自动落收数表
paneflow replay <runId> --times 2 --suite c4 --arm a
#    v12-S1b：源单带副作用（建单/覆写/PR/推送在册）默认拒绝 replay（退出码 1，两行指路文案）；
#    v12-S3：--from-failed 走 replay×resume 合流——done 节点继承不重跑，只重放失败/未执行节点。
#    注意 --from-failed 不自动开闸：副作用也可能挂在被重放的失败节点上，穿透仍需显式 --allow-side-effects
paneflow replay <runId> --allow-side-effects      # 显式穿透副作用门禁（新单落「带副作用复跑」事件）
paneflow replay <runId> --from-failed --suite c4 --arm b
paneflow experiments --suite c4              # 只读 server 端收数表（每行含 harness 摘要列 graphSha·agentKind，缺则 -；
#                                             另含 v12-V2「人等分」列=人批门累计等待分钟，无账画 -）
```

watch 退出码表（dispatch/runs/status/approve 恒为 0 成功 / 1 报错）：

| 退出码 | 含义 | 该做什么 |
|---|---|---|
| 0 | 全绿（run `completed`） | 直接验收/继续下一步 |
| 1 | 有红（`failed` / `cancelled` / `completed-with-failures`）| `status <runId>` 看失败节点与 error |
| 2 | 超时未达终态 | 加大 `--timeout` 或 `status` 查是不是卡住 |
| 3 | 停在审批门 | stdout 已列待批 nodeId；人工确认后 `approve`，再 `watch` |

`completed-with-failures`（v11-D3）：并行分支带失败收口，不再洗绿——按红（1）处理。

token 预算熔断（v12-S2）：`PF_RUN_MAX_TOKENS=<正整数>` 设 run 级 token 上限（`contract.budget.maxTokens` 优先；0/未设/破烂=关闭）——节点启动前比对 agent 自报 usage 累计（绝不估算，无自报只警示不熔断），超限按既有失败路收 `failed`，watch 照按红（1）、error 一句「token 预算超限（已用 X / 上限 Y）」；`budget.maxMinutes` 仍只展示（时长维已有节点 timeoutMs 缺省 30min 硬顶）。

门到期熔断（v13-S4）：`PF_GATE_TIMEOUT_MS=<正整数>` 设 run 级审批门等待上限（`contract.budget.gateTimeoutMs` 优先；**缺省 0=关，门一直等人批**）。七处人工门（运行中对话框/澄清轮/人工检查/验收机器门/契约门/分支守卫/启动确认）共用同一实现。到期按既有失败路收 `failed`——watch 照按红（1）、error 一句「等待审批超时，已等待 X，上限 Y，不放行。」；**到期不是人的决策**：不入 `attention` 人等分账、不发任何按键、迟到 `approve` 得 409。被武装的门若在到期前被人放行，记一笔 `externalReleases`（外解唤醒=「定时器差点替人做了决定」），`GET /api/runs/<runId>` 直读该键、缺省=零。

### curl 退路（端点 + 关键字段）

所有请求带 `-H 'content-type: application/json'`；远程模式加 `-H "Authorization: Bearer $PANEFLOW_TOKEN"`。

```bash
BASE=http://127.0.0.1:4310

# 派活（体：task 必填；issueId/cwd/preview 可选；?space= 选项目）
#   v13-E2 fail-closed：档案 defaultAgentKind 与本机实探两路全空 → 400 一句指路（不再猜 claude 起必红单）
curl -s $BASE/api/dispatch -d '{"task":"...","issueId":"123"}'
#   → {runId, issueId?, issueFetched, note?, contract:{mode:extracted|autofilled|gate,...},
#      nodes:[{id,name,type,dependsOn}]   # v11-A1 节点清单摘要}

# 列单 / 看单（:id 响应比 RunRecord 多一个只读聚合字段 awaitingApproval:{nodeIds,waiting}，
#   waiting=true 即 watch 判 3 的显式信号——blocked/paused 节点卡住了整单；
#   v12-V1 起单记录多 harness:{graphSha,agentKind,model?,gwProfile?}——起单时固化的实发配置，
#   旧 run 无此字段；replay 时 model/钉档与原单不一致会在新单 events 落「harness 漂移」事件，只提示不拦；
#   v12-S1a 起带副作用的单多 sideEffects:{issuesCreated?,issuePatched?,prUrl?,pushedAt?}——
#   引擎可见的外部写账（建单/覆写仅调用方带 runId 才归因；pushedAt 为自报口径，模板未报=不可见）；
#   v12-V2 起批过门的单多 attention:{waitMs,gates:{approve,reject,input}}——人介入「验证税」落册账，
#   放门即结算（不靠环形 events 推导；进门时刻不可考的存量轮次只计次不加时长，宁缺毋假）；
#   v13-V1 起有机检项的单多 machineCheckTally:{items,nodes,verified,allPassed}——「机检实跑」侧的账，
#   从 graph 各节点 checks[]（file-exists/command/regex/contract/delivery-branch；manual 引擎实跑不了不进账）
#   × 节点 state 纯读时推导（done⇒该节点机检全过），零新写路径：机检成功历史上没落过册，
#   写端方案对旧 run 永远缺账。图与账对不上/拿不到 state 时**整键省略**——0 是正断言，「不知道」不是 0）
curl -s $BASE/api/runs
curl -s $BASE/api/runs/<runId>
curl -s $BASE/api/runs/<runId>/events

# 审批（体 {action:"approve"|"reject"|"input", text?, keys?}；节点不在门上返回 409 + 指路 error）
curl -s -X POST $BASE/api/runs/<runId>/nodes/<nodeId>/approve -d '{"action":"approve"}'

# 停止 / 队列（queue → {cap, running:[{runId,title}], queued:[{runId,title,position}]}）
curl -s -X POST $BASE/api/runs/<runId>/stop
curl -s $BASE/api/queue
curl -s -X POST $BASE/api/runs/<runId>/promote     # 插队到队首；不在排队中返回 409

# 批量派发（一个模板 × 一列 issue 编号，≤20；并发超限自动排队）
curl -s $BASE/api/dispatch/batch -d '{"template":"my-template","issues":"1\n2\n3"}'

# GitHub 写端点（v12-S1a 副作用归因）：体新增可选 runId——建单/覆写成功且有活跃 runId 时
# 落进该 run 的 sideEffects 账 + 一条「副作用」事件；不带 runId 行为与今天完全一致
curl -s $BASE/api/github/create-issue -d '{"title":"...","runId":"<活跃runId>"}'
curl -s -X PATCH $BASE/api/github/update-issue -d '{"number":7,"body":"...","runId":"<活跃runId>"}'

# 复跑实验（v11-E1）：体 {times?, suite?, arm?, flag?, allowSideEffects?, fromFailed?}；返回 {runs:[{runId,state}]}
# 唯一豁免=R3.4 同 issue 幂等锁，且仅 replay 显式发起；普通 dispatch 撞锁语义不变
# v12-S1b：源单 sideEffects 非空且未带 allowSideEffects → 400 两行指路（列清单+--allow-side-effects/--from-failed）；
#   404 仍只留给「找不到原 run」
# v12-S3：fromFailed=true → 接 resume 通道（done 节点继承不重跑，只重放失败/未执行节点）
curl -s -X POST $BASE/api/runs/<runId>/replay -d '{"times":2,"suite":"c4","arm":"a"}'
curl -s -X POST $BASE/api/runs/<runId>/replay -d '{"allowSideEffects":true}'
curl -s -X POST $BASE/api/runs/<runId>/replay -d '{"fromFailed":true,"allowSideEffects":true}'
curl -s "$BASE/api/experiments?suite=c4"      # 只读收数表 → {tables:[{suite,date,file,rows[]}]}
curl -s "$BASE/api/runs?suite=c4&arm=a"       # 实验元数据过滤列单
```

模型 / agent 选择的**单一事实源三件套**（写死本地清单=违规，以这三处返回为准）：

```bash
curl -s $BASE/api/health          # → agentKinds（合法 agent 类型全集白名单）、herdrOk、
                                  #   env.agentsInstalled / agentsMissing、recommendedAgentKind；
                                  #   v13-E2 起多 platform（process.platform 原样）与 herdrError
                                  #   （herdr 探测失败的人话原因，拿不到整键省略）两标量。
                                  #   win32 探测走 PATH×PATHEXT（未实机验证，见 README 支持矩阵）
curl -s $BASE/api/gateway         # → 当前网关档：{baseUrl, freeModel, enabled, keyConfigured,
                                  #   profiles:[档位数组], current}（apiKey 永不回显）
curl -s $BASE/api/gateway/catalog # → 每档实探的模型清单：
                                  #   {profiles:[{id,name,baseUrl,freeModel,isCurrent,models[],error}]}
                                  #   5min 缓存；强刷 ?refresh=1；指定档 ?profile=<id>
```

### 红线

- 不绕过 server 直读/直写 `~/.paneflow`（dataDir）——状态与判定只认 API 返回字段。
- 审批门（watch 退出码 3 / `awaitingApproval.waiting`）必须人来批；agent 不得自动 approve 自己的单。
