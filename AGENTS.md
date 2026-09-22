# AGENTS.md

## 给 PaneFlow 派活

PaneFlow 是本地多 agent 编排台：server（Fastify，默认 `http://127.0.0.1:4310`）握有全部编排 API，
网页只是其中一个消费者。**机器/agent 派活一律走 `paneflow` CLI；CLI 不可用时走 curl 退路。**
CLI 是零业务薄壳（铁律 R4：不直读 dataDir、不自造判据），一切结论以 server 返回字段为准。

约定：以下命令假定 release 安装的 `paneflow` 在 PATH 上；在本仓库内开发时用
`pnpm paneflow <子命令> ...`（tsx 直跑 `packages/cli`）。服务地址解析链：
`--url` > 环境变量 `PANEFLOW_URL` > `~/.paneflow/cli.json`（`{"url": ...}`）> 默认
`http://127.0.0.1:4310`；远程暴露模式带令牌 `PANEFLOW_TOKEN`（转成 `Authorization: Bearer`）。

### CLI 优先（每条可原样执行）

```bash
# 1) 派活：一句话或整篇 issue 引用皆可；--repo 必须配 --issue（拼规范 issue URL 给服务端识别）
paneflow dispatch "给导出模块加空值兜底" --repo my-org/my-repo --issue 123 --space demo

# 2) 列单：看最近都跑了什么
paneflow runs
paneflow runs --json            # 原始 API 负载，stdout 干净可直接 | jq

# 3) 看细节：run 头 + harness 行（v12-V1 起单实发配置：graph#指纹 · kind= · model= · 档位=，缺项跳过）+ 每个节点状态 + 审批门提示
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
paneflow experiments --suite c4              # 只读 server 端收数表（每行含 harness 摘要列 graphSha·agentKind，缺则 -）
```

watch 退出码表（dispatch/runs/status/approve 恒为 0 成功 / 1 报错）：

| 退出码 | 含义 | 该做什么 |
|---|---|---|
| 0 | 全绿（run `completed`） | 直接验收/继续下一步 |
| 1 | 有红（`failed` / `cancelled` / `completed-with-failures`）| `status <runId>` 看失败节点与 error |
| 2 | 超时未达终态 | 加大 `--timeout` 或 `status` 查是不是卡住 |
| 3 | 停在审批门 | stdout 已列待批 nodeId；人工确认后 `approve`，再 `watch` |

`completed-with-failures`（v11-D3）：并行分支带失败收口，不再洗绿——按红（1）处理。

### curl 退路（端点 + 关键字段）

所有请求带 `-H 'content-type: application/json'`；远程模式加 `-H "Authorization: Bearer $PANEFLOW_TOKEN"`。

```bash
BASE=http://127.0.0.1:4310

# 派活（体：task 必填；issueId/cwd/preview 可选；?space= 选项目）
curl -s $BASE/api/dispatch -d '{"task":"...","issueId":"123"}'
#   → {runId, issueId?, issueFetched, note?, contract:{mode:extracted|autofilled|gate,...},
#      nodes:[{id,name,type,dependsOn}]   # v11-A1 节点清单摘要}

# 列单 / 看单（:id 响应比 RunRecord 多一个只读聚合字段 awaitingApproval:{nodeIds,waiting}，
#   waiting=true 即 watch 判 3 的显式信号——blocked/paused 节点卡住了整单；
#   v12-V1 起单记录多 harness:{graphSha,agentKind,model?,gwProfile?}——起单时固化的实发配置，
#   旧 run 无此字段；replay 时 model/钉档与原单不一致会在新单 events 落「harness 漂移」事件，只提示不拦）
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

# 复跑实验（v11-E1）：体 {times?, suite?, arm?, flag?}；返回 {runs:[{runId,state}]}
# 唯一豁免=R3.4 同 issue 幂等锁，且仅 replay 显式发起；普通 dispatch 撞锁语义不变
curl -s -X POST $BASE/api/runs/<runId>/replay -d '{"times":2,"suite":"c4","arm":"a"}'
curl -s "$BASE/api/experiments?suite=c4"      # 只读收数表 → {tables:[{suite,date,file,rows[]}]}
curl -s "$BASE/api/runs?suite=c4&arm=a"       # 实验元数据过滤列单
```

模型 / agent 选择的**单一事实源三件套**（写死本地清单=违规，以这三处返回为准）：

```bash
curl -s $BASE/api/health          # → agentKinds（合法 agent 类型全集白名单）、herdrOk、
                                  #   env.agentsInstalled / agentsMissing、recommendedAgentKind
curl -s $BASE/api/gateway         # → 当前网关档：{baseUrl, freeModel, enabled, keyConfigured,
                                  #   profiles:[档位数组], current}（apiKey 永不回显）
curl -s $BASE/api/gateway/catalog # → 每档实探的模型清单：
                                  #   {profiles:[{id,name,baseUrl,freeModel,isCurrent,models[],error}]}
                                  #   5min 缓存；强刷 ?refresh=1；指定档 ?profile=<id>
```

### 红线

- 不绕过 server 直读/直写 `~/.paneflow`（dataDir）——状态与判定只认 API 返回字段。
- 审批门（watch 退出码 3 / `awaitingApproval.waiting`）必须人来批；agent 不得自动 approve 自己的单。
