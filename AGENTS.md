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
#    fresh dispatch 也能直接打实验标（v13-V2 勘误后开闸：取臂规程=双臂各 ≥3 run 用 fresh dispatch 起，
#    replay 只作同臂补分母）：--suite/--arm/--flag 进 experiment 体键，带标单到终态自动落收数表一行；
#    只有带非空 suite 才算实验标（只给 arm/flag → server 400 指路）；CLI 纯透传不判断据（R4）
paneflow dispatch "给导出模块加空值兜底" --repo my-org/my-repo --issue 123 --suite c4 --arm a

# 2) 列单：看最近都跑了什么
paneflow runs
paneflow runs --json            # 原始 API 负载，stdout 干净可直接 | jq

# 3) 看细节：run 头 + harness 行（v12-V1 起单实发配置：graph#指纹 · kind= · model= · 档位=，缺项跳过）
#    + 等臂读数（v13-V2：读回=有/无(结局六态 injected/switch-off/no-pages/not-injected/error/inherited)
#      · 骨架#=剥注入块并归一 run_id/draft_dir 后的指纹——两臂骨架#相等 ∧ 读回不等，「只差一个读回块」才算机器证
#      · 上下文#=v13-V4 注入面指纹（注入现场实读的约定文档/技能 + gwThrottleRetries/节点缺省时长并一枚；
#        只证 PaneFlow 注入面，agent 在 cwd 自读的 AGENTS.md 不可考）；replay 时上下文#变了落「harness 漂移（V4）」事件只提示不拦；旧单缺键整缺不显）
#    + 副作用行（v12-S1a 落册账：建单#12 · 回写#7 · PR <url> · 已推送 <时刻>，缺项跳过、无账不显示）
#    + 人等分行（v12-V2 人介入账：人等分: 等待 4.2 分 · 批 2/驳 0/补料 1——审批门
#      拦→放的累计等待时长与决策计数，放门即结算落册；没批过门/旧 run 整缺不显示）
#    + 每个节点状态 + 审批门提示
#    + 岗位两枚 bit（v13-W2 起在同一行 harness: 尾部）：roleSha=角色+实解析装备的路径集指纹
#      （换装备=换指纹、同装备=同指纹——文档内容改了算 上下文# 的账，不算它的；于是「两臂
#      骨架#相等 ∧ roleSha 不等」= 岗位级 A/B 的机器证，V2 那套零新机制复用）；
#      injected=<KB，一位小数>=本单各节点实注上下文块的 UTF-8 字节合计（0.0KB 是正读数=整单
#      一个字都没注，与「缺键」分家：缺键=注入现场没走到/旧单）。两枚都在注入现场落册、
#      取值时点同 上下文#；判据全在 server，CLI 只渲染）
#    + 装备行（v13-W1 三轴划界：该节点实发吃进 prompt 的「技能 N · 岗位文档 M」计数，绑了岗还标岗名；
#      scope=space 且绑了角色 → 整行升级为「⚠ 该角色未配装备，正吃空间全量」；
#      装备槽引用了项目登记清单外的技能 → 另起一行「⚠ 装备引用不在登记清单，已跳过：…」（只披露不拦）；
#      注入现场没走到（非 agent 节点/档案不可读）整缺不显——判据全在 server，CLI 只渲染）
#    + 掐断账行（v13-S2：节点尝试被引擎中途掐断过时出「⚡ 第 N 轮尝试已掐断（触发点 · 掐时状态）」，
#      触发点取值 settle-timeout/retry/stop/shutdown/agent-gone；一次都没掐过整行不显示）
#    + 授权行 + 授权对账行（v13-W3：岗 declares 三面（gitPush/prOpen/issueWrite）收口落册 →
#      「授权: 岗「r-x」gitPush=false …（声明非强制，锁在 agent CLI 侧）」；声明 false 却撞上
#      副作用账 → 「⚠ 授权对账: 岗「r-x」声明 gitPush=false · 实见「已推送 <时刻>」」——只照不拦，
#      归因是单级上界（副作用账无逐节点分账）；没声明/无落差/旧单两行整缺不显——判据全在 server，CLI 只渲染）
#    + 交付行 + 落差行（v13-B2 家规三层消费：节点按空间 delivery 家规真建过隔离工作目录 →
#      「    交付: 分支 fix/issue-123 · 基点 main（契约优先时带此标注）· PR→main · 家规第 1 条（精确仓）」；
#      挂既有分支=「未拉新支」、续用残留目录=「未建支未拉基点」——没拉就没有基点，账上缺键就明说，
#      绝不拿家规声明的 branchFrom 冒充实测基点；收口对出落差另起 run 级一行
#      「⚠ deliveryViolation: <server 的一句人话>（只标不拦）」，判据与 detail 全在 server，CLI 不比对
#      expected/actual 不自造判定；没配家规/没建 worktree/无落差/旧单 → 两行整缺不显）
#    + 产物行（v13-K1 命名产物台账：尝试收口现场引擎实读算好落册，渲染成
#      「产物: plan.md(a1b2c3·4.2KB) · changes.diff(9f8e7d·1.0KB)」——sha/bytes 是机检口径
#      （读原文算的，不信 agent 自报）；kind=doc 由 artifact.json 声明、kind=diff 零约定自动采；
#      被 run 级字节上限拒的件标「⚠未上架：<原因>」（只披露不拦，节点照 done）；
#      消费面在模板里：下游 prompt 写 `{{artifact:节点ID/产物名}}` 是**硬引用**——引擎把架上原文整篇
#      替换进去（过指纹比对），解析不到=该节点即时失败，不留裸花括号喂 agent；同一格的软引用
#      `{{nodeId.artifact.summary}}` 解析不到只字面放行+起单时一句 ⚠ 事件。直接上游产过命名产物时，
#      每个 agent 节点的注入块尾部多一段「【上游命名产物】…（引用写法）」——没产过零新增（不占 token）
#      没声明产物又不是 git 仓=整缺不显（缺≠「产了零件」）——判据全在 server，CLI 只渲染）
paneflow status <runId>
paneflow status <runId> --json

# 4) 机器验收：轮询到终态，退出码即结论（无人值守核心用法）
paneflow watch <runId> --timeout 30m    # --timeout 支持 60s/30m/2h 简写，0=不限；默认 30m
echo $?

# 5) 审批：人看完再批；CLI 绝不代替人过门
paneflow approve <runId> <nodeId>

# 6) 复跑实验（v11-E1）：同契约重发 N 份（唯一豁免=同 issue 幂等锁，仅 replay 显式发起）；
#    --suite/--arm/--flag 打实验标，带 suite 的单到终态自动落收数表（fresh dispatch 同样可打，见 1）
paneflow replay <runId> --times 2 --suite c4 --arm a
#    v12-S1b：源单带副作用（建单/覆写/PR/推送在册）默认拒绝 replay（退出码 1，两行指路文案）；
#    v12-S3：--from-failed 走 replay×resume 合流——done 节点继承不重跑，只重放失败/未执行节点。
#    注意 --from-failed 不自动开闸：副作用也可能挂在被重放的失败节点上，穿透仍需显式 --allow-side-effects
paneflow replay <runId> --allow-side-effects      # 显式穿透副作用门禁（新单落「带副作用复跑」事件）
paneflow replay <runId> --from-failed --suite c4 --arm b
paneflow experiments --suite c4              # 只读 server 端收数表（每行含 harness 摘要列 graphSha·agentKind·rb=<读回结局>·skel#<骨架指纹>（v13-V2 起，旧行缺项画到前一截），缺则 -；
#                                             另含 v12-V2「人等分」列=人批门累计等待分钟，无账画 -）

# 7) 注册中心（v14-A1/A2/R4）：能力条目说什么、谁在用、现在还在不在——三问三答，判据全在 server
paneflow registry list [--kind model]        # 表 + 「被 N 处使用」+ 本机不认的条目（只披露不清除）
#   组名（模型/Agent 引擎…）由 server 的 `kindLabels` 外发，网页与 CLI 都不各抄一份措辞表；server 没给就明写「未知类型」
#   `agent-kind`（v14-A3-2）是**视图 kind**：18 枚由代码里的出厂清单现算、不落盘，所以没有启停/改删——三写动词对它全拒，
#   时刻读成「本机自/本次运行」（进程启动时刻），手塞进 entries.json 的同名行会被挪进 `rejected` 说清为什么不生效
paneflow registry get <id>                   # 单条：label 人话 + 引用出处逐条（读不出就说读不出，不画「没人用」）
paneflow registry refs <id>                  # 只问引用账：删之前先看这一格
paneflow registry add --from draft.json      # 草案文件原样 POST，CLI 不预校验不补 kind；脏形状 400 一句指路
paneflow registry health [--refresh]         # 整表实探三态：live/missing/unknown（探通不通 ≠ 条目好不好）
paneflow registry probe <id> [--refresh]     # 单枚探针，与批量面同一套画法
#  改和删只有网页「注册中心」有（写端拒悬挂引用、拒删被引用条目，中文解释由 server 给）

# 8) 起单前预检（v14-T3）：模板声明「这单要吃哪几项能力」，派活之前先对着注册表解析
paneflow registry check [--template x] [--space S]   # 逐槽画 ✓命中 / ✗死缺 / ?还判不了 / ⚠形状不认
#   给了 --template 时退出码即结论：0=槽全命中 / 1=有缺口（起单会被引擎 fail-closed 拒掉，同一把尺）；
#   不给 --template = 普查全部在册模板，恒 0（普查不是闸，拦是起单口的事）
paneflow registry check --template x --json  # → 那一行的原样负载：{slots,need,missing,unjudged,malformed,ok}
#   模板侧声明（画布 JSON）：graph 顶层 `requires: [{kind, id?, hint?}]`——今天判死活的 kind 是
#   `model` 与 `agent-kind`（后者的引用写法=整枚 id 或 kind 名；探测名 `antigravity` 那种异名**不算**引用写法，
#   与 R2 引用账同一把尺——两把尺就会出现「预检说缺、引用账说在用」），指向 skill/rule/repo/… 的槽落 `?`（表里没这一类，判「不存在」= 拿空白冒充断言）
paneflow env probe <绝对路径>                 # 只读环境发现器（v14-E1）：这台机器有什么可登记的，给的是草案不是断言
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

# 派活（体：task 必填；issueId/cwd/preview/experiment 可选；?space= 选项目）
#   v13-E2 fail-closed：档案 defaultAgentKind 与本机实探两路全空 → 400 一句指路（不再猜 claude 起必红单）
#   同族 #106 在节点侧：四级（统一覆盖/节点/角色/空间）皆空且实探全空 → 节点秒败带二选一指路，
#   不再硬猜一枚 kind 走「启动超时 30 分钟」慢红路（`paneflow status` 直接看到那句人话）
curl -s $BASE/api/dispatch -d '{"task":"...","issueId":"123"}'
#   实验标（v13-V2 勘误后开闸，体键形状=RunExperimentMeta，与 replay 体的 suite/arm/flag 对齐）：
#   带标单固化进 RunRecord.experiment，到终态自动落收数表一行，GET /api/runs?suite=&arm= 可命中；
#   fail-closed：只有带非空 suite 才算实验标；体级未知键（experment 拼错=实验标静默失效，宁拒不错放）
#   与 experiment 内未知键一律 400 一句指路；不给 experiment 键=旧语义一字不变
curl -s $BASE/api/dispatch -d '{"task":"...","experiment":{"suite":"c4","arm":"a","flag":"readback=off"}}'
#   → {runId, issueId?, issueFetched, note?, contract:{mode:extracted|autofilled|gate,...},
#      nodes:[{id,name,type,dependsOn}],   # v11-A1 节点清单摘要
#      experiment?:{suite,arm?,flag?}}     # 打了才回显：server 认下的实验标回执

# 列单 / 看单（:id 响应比 RunRecord 多一个只读聚合字段 awaitingApproval:{nodeIds,waiting}，
#   waiting=true 即 watch 判 3 的显式信号——blocked/paused 节点卡住了整单；
#   v12-V1 起单记录多 harness:{graphSha,agentKind,model?,gwProfile?}——起单时固化的实发配置，
#   旧 run 无此字段；replay 时 model/钉档与原单不一致会在新单 events 落「harness 漂移」事件，只提示不拦；
#   v13-V2 起同一对象多等臂三键 {readback,readbackOutcome,skeletonSha?}——readback 扫出场 graph
#   实态（false 也是正读数，不是缺键）、readbackOutcome 六态、skeletonSha 剥注入块+归一 run_id/draft_dir
#   后指纹；漂移比对面自 v13-V2 加 skeletonSha（骨架不等=两臂差的不是读回块而是真拓扑），
#   readback/readbackOutcome 不比——它们差是实验的受测变量；v13-V2 前的旧单无 skeletonSha 则跳过比对（宁缺毋假）；
#   v13-W2 起同一对象再多两键 {roleSha?,injectedBytes?}——都在**注入现场**落册（取值时点同 v13-V4 ctxSha，
#   起单时点没有实发值）：roleSha=「角色身份 + 该岗实解析出的技能/岗位文档路径集」按条目去重后并成的指纹
#   （**换装备=换指纹、同装备=同指纹**：文档内容改了走 ctxSha，不抖它；scope 不入指纹），
#   与 skeletonSha 联用即「两臂只差一格装备」的岗位级 A/B 机器证（V2 机制零新造复用）；
#   injectedBytes=本单各 agent 节点实注上下文块的 UTF-8 字节合计（逐节点取最后一轮值，重试不双计；
#   0 是正读数=一个字都没注）。整单没解析出装备（档案不可读/没走注入路）或旧 run → 整键省略；
#   另外起单时若本空间配了班底（profile.team 非空）而某节点 role 不在名册，events 落一条
#   「⚠ 班底名册外引用 N 处」warn 事件（shared.validateRoleRefs 纯读推导，只披露绝不硬拦，存量模板不变红）
#   v12-S1a 起带副作用的单多 sideEffects:{issuesCreated?,issuePatched?,prUrl?,pushedAt?}——
#   引擎可见的外部写账（建单/覆写仅调用方带 runId 才归因；pushedAt 为自报口径，模板未报=不可见）；
#   v12-V2 起批过门的单多 attention:{waitMs,gates:{approve,reject,input}}——人介入「验证税」落册账，
#   放门即结算（不靠环形 events 推导；进门时刻不可考的存量轮次只计次不加时长，宁缺毋假）；
#   v13-V1 起有机检项的单多 machineCheckTally:{items,nodes,verified,allPassed}——「机检实跑」侧的账，
#   从 graph 各节点 checks[]（file-exists/command/regex/contract/delivery-branch；manual 引擎实跑不了不进账）
#   × 节点 state 纯读时推导（done⇒该节点机检全过），零新写路径：机检成功历史上没落过册，
#   写端方案对旧 run 永远缺账。图与账对不上/拿不到 state 时**整键省略**——0 是正断言，「不知道」不是 0）
#   v13-W1 起 agent 节点的运行记录多 equip:{scope:'role'|'space',role?,skills[],rules[],unknownSkills?}——
#   注入现场解析好的岗位装备账：三轴=空间家规/目录作用域规则/角色装备槽；skills/rules 是**实注入**
#   （读失败或超总预算被跳过的不记），所以 scope=space（角色未配装备槽或没绑角色）时数组就是空间全量；
#   unknownSkills=装备槽引用了本空间登记清单外、已跳过不注的项（只披露不拦）；
#   注入现场没走到/档案不可读 → 整键省略（宁缺毋假，不拿空账冒充「吃了零」）；旧 run 无此键；
#   v13-W3 起收口对账落两枚可选键：declares:[{roleId,faces:{gitPush?,prOpen?,issueWrite?}}]——本单
#   实绑岗的授权声明账（三面布尔，绑定 precedence 同 W4 能力账），声明入 prompt 但**不进
#   ctxSha/roleSha 两枚指纹**（声明不是装备）；declareViolations:[{roleId,face,seen}]——声明 false
#   却撞上副作用账的落差账（归因只到**单级上界**：副作用账无逐节点分账，不指认哪一格干的），
#   同时 events 落一条「⚠ declareViolation」warn 事件——只照不拦，收口判定零改动；
#   没声明/无落差/旧 run → 两键整缺（缺≠「声明了零面」）
#   v13-B3 起 /events 时间线多「worktree 回收」账（仅同仓并发用过 worktree 的单才有，存量单零新增）：
#   目录删+已合并分支已删（git branch -d 成功）/「分支未合并，保留待人工定夺」——**这是读数不是失败**，
#   收口判定零改动——/ -d 只跑 -d 绝不 -D 绝不 push（拒绝即诚实读数，不许绕过）；只删分支名正身
#   paneflow/<runId>-<nodeId> 的引擎自建分支，非正身不碰；脏保留的事件带分支名+worktree 路径
#   （旧版只有一行 console.warn 等于没账）。判据全在 server，CLI 零判据（R4，不为此改渲染）
curl -s $BASE/api/runs
curl -s $BASE/api/runs/<runId>
curl -s $BASE/api/runs/<runId>/events

# 产物架（v13-K1：一处清单两个来源，各带 source）——worktree 回收后 workspace 侧蒸发的东西，架侧仍可读
curl -s $BASE/api/runs/<runId>/artifacts           # → {runId,dir,exists,files:[{name,size,mtime,source,nodeId?,sha?,bytes?,shelved?}]}；exists=任一侧有货（工作目录被回收而架上还有原件时也为 true）
curl -s "$BASE/api/runs/<runId>/artifacts/file?path=b/plan.md&src=shelf"  # 读原文；src 缺省=workspace 侧（旧语义一字不变）
#   架根 `<dataDir>/shelves/<runId>/<nodeId>/<名>`（名只取 basename，穿越=400）；per-run 字节上限
#   `PF_SHELF_MAX_BYTES`（缺省 32 MiB），超限的件 `shelved:false` + 一句 shelfError——只披露不拦

# 审批（体 {action:"approve"|"reject"|"input", text?, keys?}；节点不在门上返回 409 + 指路 error）
curl -s -X POST $BASE/api/runs/<runId>/nodes/<nodeId>/approve -d '{"action":"approve"}'

# 停止 / 队列（queue → {cap, running:[{runId,title}], queued:[{runId,title,position}]}）
curl -s -X POST $BASE/api/runs/<runId>/stop
curl -s $BASE/api/queue
curl -s -X POST $BASE/api/runs/<runId>/promote     # 插队到队首；不在排队中返回 409

# 批量派发（一个模板 × 一列 issue 编号，≤20；并发超限自动排队）
curl -s $BASE/api/dispatch/batch -d '{"template":"my-template","issues":"1\n2\n3"}'

# 空间/项目档案（v13-B1 交付约定声明位；rules/skills/delivery 在「项目」视图中有编辑器，机器改走下面的 PUT）
curl -s $BASE/api/spaces                       # → {spaces:[档案数组]}；没配过的可选键整缺不造默认
curl -s $BASE/api/spaces/<id>                  # 单档案；delivery 配了才出现：[{repo?,branchFrom,branchName,prTarget,gates?,note?}]
curl -s -X PUT $BASE/api/spaces/<id> -d '{"delivery":[{"repo":"my-repo","branchFrom":"main","branchName":"fix/issue-{issue}","prTarget":"main","gates":["PR 前"]}]}'
#   PUT=merge 语义（漏发键保旧值，显式 [] 才清空）；脏形状 400 + 一句指路（空 branchName/未知键/gates 破烂…）
#   v13-B2 起三层消费全部接线（不再是只声明）：①机检层建 worktree 按家规渲染分支名、基点走
#   branchFrom（本地 refs/heads 优先、再退 refs/remotes/origin；两路都解析不到=拒建即时红，
#   **绝不静默从当前 HEAD 拉出**）；②注入层把渲染后的约定块进每个 agent 节点的上下文；
#   ③对账层收口核两条落差（实分支名≠渲染结果、gates 声明了而图上一道人闸没编）——只照不拦。
#   契约的 repo/branch 是本单级覆盖口：contract.branch 在场时基点取契约、家规仍命名。
#   实消费账读 GET /api/runs/<runId> 的 deliveryWorktrees[]（nodeId/repo/worktreePath/ruleIndex/
#   matchedBy/pullMode/expectedBranch/prTarget，真拉新支才有 baseRef+baseSource，读得到才有
#   actualBranch）与 deliveryViolations[]（{kind,detail,...}）；没家规/没命中/没建过=整键缺省。
#   v13-B3 worktree 根（顶层键 worktreeRoot，非 delivery 条目——根是空间级事实，塞进 per-repo 家规是形状错误）：
#   生产默认 <dataDir>/worktrees（即 ~/.paneflow/worktrees——证据链搬出 OS 扫荡区）；
#   PUT '{"worktreeRoot":"/volumes/ext/pf-wt"}' 按空间覆写——只认绝对路径（相对路径不猜基准，400 指路），
#   空串=取消覆写回落默认（gatewayProfile 取消钉同款口径）；消费在建 worktree 现场读档案，泄漏清扫的扫描面
#   自动含默认根 + 各档案覆写根（覆写根=用户点名的目录，只清其中残留、不替人删根目录壳）。
#   旧默认根 os.tmpdir()/paneflow-wt 自此不再被引擎清扫（OS 自己的地盘 OS 收尾），刻意不做静默迁移

# 岗位能力账（v13-W4，本版唯一新增端点，纯读）：这个岗历史上干得怎么样、换装备前后差多少
curl -s $BASE/api/roles/<roleId>/profile
#   → {role:{id,name}, overall:{runs, passRate?:{n,passed}, nodePassRate?:{n,done,failed},
#      attention?:{n,waitMs,gates:{approve,reject,input}}, tokens?:{n,input,output},
#      machineCheck?:{n,items,verified,runsAllPassed}}, byRoleSha?:[{roleSha, …同形状}]}
#   口径三则：①每个指标自带分母 n，没有支持样本就整键省略（0 是正断言「一条都没过」，
#   「不知道」不是 0）；②分组吃 roleSha（v13-W2 换装备=换指纹），没落指纹的旧单只进总账
#   不进组，故「总账 runs ≥ Σ各组 runs」是口径事实；③返工（rework）本版**如实不报**——
#   没有任何按岗可归因的落册字段忠实度量「这岗的活被打回重做」，造一个 proxy 就是假账。
#   有岗无单 → 200 且 overall.runs:0（「这岗一次没上过」是读数），岗不存在才 404

# 岗位授权声明（v13-W3）：roles PUT 体的可选 declares——三面布尔声明，入库 fail-closed；
#   PaneFlow 不造沙箱：声明只入 prompt（措辞诚实「声明非强制」）+ 收口对账，拦不了任何真动作
curl -s -X PUT $BASE/api/roles -d '{"roles":[{"id":"r-deliver","name":"交付岗","declares":{"gitPush":false,"prOpen":true}}]}'
#   脏形状 400 一句指路：declares 非对象 / 未知面（拼错的面会静默失效，宁拒不错放）/ 面值非布尔都拒；
#   键缺省=没声明（今天行为一字不变）；显式 {} 合法=声明零面

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
