<img src="packages/web/public/icon.svg" alt="PaneFlow 图标" width="72" height="72" />

# PaneFlow

**基于 Herdr 真实终端 Pane 的确定性多 Agent DAG 可视化编排平台。**

画布节点 1:1 映射独立 Herdr Pane（独立进程、独立终端、独立工作目录、独立会话）——硬隔离、真实并行、原生 blocked 人工审批。区别于所有 LLM-API 软编排与 AI 动态生成工作流系统。

```
【前端画布】Vite + React + @xyflow/react
        ↕ REST + WebSocket
【自研编排服务】Node 22 + Fastify（DAG 调度 / 状态中枢 / 黑板 / 资源管控）
        ↕ NDJSON over Unix Socket（herdr 协议 20）
【运行底座】Herdr server → Workspace/Tab/Pane → pi / opencode / claude / codex / …17 种编码 Agent
```

## 核心能力一览

- **🎯 智能下发**：顶栏一句任务描述 → Planner 自动选择交付模板（或生成任务拆解）→ 骨架自动执行 → Issue 回链 + git 收口
- **确定性编排**：策展骨架 + 动态扇出（按任务数组克隆分支）+ 条件边（产物字段断言剪枝）+ Dry-Run 预演
- **质量门禁**：file-exists/command/regex/manual 四类检查；manual 复用审批卡片人闸
- **模型网关**：设置页配置 OmniRoute/LiteLLM 等网关后，Agent 全量走网关（免费档/自动切换由网关负责）
- **GitHub 闭环**：GH_TOKEN 注入 + create-issue/update-issue 确定性原语（EMU 账号场景可用）
- **验收断言**：align 注入 AC-N 断言面 → impl 逐条自测回写 → verify 逐条核对（带证据链的交付）

## 快速开始

前置（两条路相同）：本机已安装并运行 [Herdr](https://github.com/herdrdev/herdr) ≥ 0.8.2，Node ≥ 22。

### 方式一 · 免克隆安装（推荐给使用者）

不需要 clone 仓库、不需要 pnpm，一条命令装出全局 `paneflow` 命令：

```bash
curl -fsSL https://raw.githubusercontent.com/JXzfluser/PaneFlow/main/install.sh | bash
```

（不愿走脚本也可以直接 `npm install -g` 发行包：
`npm i -g https://github.com/JXzfluser/PaneFlow/releases/latest/download/paneflow-latest.tgz`）

脚本装法自带三道检查（v13-E1）：本机 herdr api socket 在不在（缺了就是「装完即白装」）、
下载包与 `paneflow-latest.tgz.sha256` sidecar 的 digest 是否一致（对不上拒绝安装）、
临时文件全程落在退出即清的临时目录里。逃生阀：`PF_HERDR_SOCKET=<路径>` 指认非默认 socket、
`PF_INSTALL_SKIP_HERDR_CHECK=1` 明确跳过检查（后果自负）。

```bash
paneflow            # 启动编排服务并同源托管画布（等价显式写法：paneflow serve）
paneflow --help     # 派活/看单/验收走 CLI：其余任何首参都不会起第二个服务实例
```

打开 http://127.0.0.1:4310 即是画布。升级重跑同一条命令即可；卸载：`npm uninstall -g paneflow`。
发行包 = 服务端单文件 + 前端构建产物 + 4 个 npm 运行时依赖，数据仍存 `~/.paneflow`。

### 方式二 · 源码运行（推荐给开发者）

额外前置：pnpm（版本以 `packageManager` 为准）。

```bash
pnpm install
pnpm start          # 一键：构建前端 + 启动服务（同源托管画布）
```

开发模式（热更新）：

```bash
pnpm dev:server     # 编排服务（http://127.0.0.1:4310）
pnpm dev:web        # 画布开发服务（http://127.0.0.1:4311，代理 API）
```

上手三步：🎯 下发任务（一句描述，自动路由/生成编排）或左侧拖拽节点手动画流水线 → 运行 → 运行中心看进度/审批/产物。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PF_HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | Herdr api socket 路径 |
| `PF_PORT` | `4310` | 编排服务端口 |
| `PF_HOST` | `127.0.0.1` | 监听地址；非本机回环时强制启用 `PF_TOKEN` 鉴权（远程/手机访问用） |
| `PF_TOKEN` | 空 | 访问令牌；远程模式下未设置时首次启动自动生成并持久化到 `PF_DATA_DIR/auth-token.json` |
| `PF_WEB_DIR` | 自动探测 | 前端构建产物目录（免克隆发行包的启动器注入；源码运行无需设置） |
| `PF_DATA_DIR` | `~/.paneflow` | 模板与运行记录存储 |
| `PF_MAX_PANES` | `8` | 全局并行 Pane 上限 |
| `PF_PANE_ENV` | 空 | 注入流水线 workspace 的环境变量（`K=V,K2=V2`），如 `OPENCODE_DISABLE_AUTOUPDATE=1,PI_DISABLE_UPDATE_CHECK=1` |
| `PF_WORKSPACE_PREFIX` | `paneflow-` | 流水线 workspace 标签前缀（自动回收依据） |
| `PF_PROMPT_CONFIRM_MS` | `45000` | prompt 提交确认窗（ms）：提交后 agent 状态须在此窗口内离开 idle，超时判 `agent_prompt_stalled` 走节点失败/重试；`0` 关闭（fire-and-forget） |
| `PF_CORS_ORIGINS` | 空 | 跨站请求白名单（逗号分隔 origin）。默认不回 CORS 头且拦截一切跨站写操作；同源部署与 curl 不受影响，反向代理改写 Host 时需显式配置 |
| `PF_GITHUB_REPO` | 空 | 启用模板云端同步（`owner/name`） |
| `PF_GITHUB_TOKEN` | 空 | GitHub PAT（需 Contents 读写权限；只从环境变量读取，永不入库/入日志） |
| `PF_GITHUB_BRANCH` | `main` | 同步分支 |
| `PF_GITHUB_DIR` | `templates` | 同步目录 |

配置后顶栏出现「☁️ 同步 / ⬇️ 拉取」：同步把本地全部模板异步推送到仓库 `templates/*.json`；拉取反向合并到本地。默认关闭，断网不影响任何核心功能。（注意与「wiki 沉淀」区分：后者是 run 结论推主仓 `llm-wiki/`，此处是编排模板的云端互为备份。）

#### 网关限流环境变量（PF_GW_*）

网关感知限流旋钮（v11-D1）：run 走网关（网关档 `baseUrl` 的 host 可识别）时，按「网关主机」维度对发往该主机的节点做在途并发限制与限流错峰，避免网关免费档并发上限把整批节点打成 429/503。以下四个变量各自独立成条，默认值与 `packages/server/src/orchestrate/engine.ts` 一致（闸实现见 `gwlimit.ts`）。

**`PF_GW_MAX_CONCURRENT`** — 同一网关主机最大在途并发
- 用途：同一网关主机上允许同时在跑的节点数上限（跨 run 共享在途记账；额度排满时新节点就地排队等起窗）。
- 默认：`2`。
- 调大/调小：调大 → 同主机可并行更多节点、整单更快，但撞网关限流的概率升高；调小 → 更保守地串行；`0`（乃至小于 1 的任何值）= 关闭整闸，领窗直接放行且不记账，等于停用网关限流。
- 与其他旋钮的关系：与全局 `PF_MAX_PANES`（Pane 槽）、项目级 run 并发上限三者取交集，齐备才起窗；同时是本组其余三个 `PF_GW_*` 旋钮的总开关（整闸关闭时收紧/退避/额外重试均不生效）。

**`PF_GW_TIGHTEN_MS`** — 命中限流后闸收紧的基础窗口
- 用途：节点命中网关限流（429/503）后，该主机闸临时停止发放新窗的基础时长（错峰重放，已在跑节点不受影响）。
- 默认：`15000`（毫秒）。
- 调大/调小：调大 → 错峰窗更长、避开整点高峰更有效，但节点等起窗的时间变长；调小 → 更快恢复放窗；连续命中时收紧窗逐次翻倍、封顶 8 倍（默认即 120 秒），窗过期后再命中重新从基数起算；设 `0` = 收紧窗归零，错峰停用，但闸与退避重试仍工作。
- 与其他旋钮的关系：作用于闸的冷却期，管「新窗何时起」；与 `PF_GW_BACKOFF_BASE_MS`（管「命中节点自己何时重试」）配套成内外两层错峰。

**`PF_GW_BACKOFF_BASE_MS`** — 命中限流后的指数退避基数
- 用途：节点命中网关限流且还有下一次尝试时，重试前等待的基数时长，按连续命中次数指数递增（基数 × 2^(n-1)），封顶 60 秒（60000 毫秒）。
- 默认：`3000`（毫秒）。
- 调大/调小：调大 → 重试间隔更长、更保守，不易连续撞限流但节点重试更慢；调小 → 重试更快、但更容易再吃限流；设 `0` = 命中后不等待立即重试。
- 与其他旋钮的关系：只在限流判定（429/503 加语境词启发式）命中时生效；重试次数上限由 `PF_GW_THROTTLE_RETRIES` 决定，两者共同决定限流节点的最坏额外耗时。

**`PF_GW_THROTTLE_RETRIES`** — 纯限流失败的额外重试预算
- 用途：节点因网关限流而失败时，在其自身 `retryCount` 之外追加的重试次数（仅 run 识别为走网关主机时发放该预算，不占节点自身重试额度）。
- 默认：`2`。
- 调大/调小：调大 → 限流节点更耐受、成功率更高，但每次重试都带退避等待、总时长相应拉长；调小 → 快速失败；设 `0` = 不追加，限流节点只有自身 `retryCount` 次机会。
- 与其他旋钮的关系：决定退避轮数（每轮等待时长由 `PF_GW_BACKOFF_BASE_MS` 定）；非限流失败不消耗该预算，仍走节点自身 `retryCount` / `onFail` 策略。

## 核心机制

- **确定性 DAG**：用户预定义拓扑（start/agent/fanout/fanin/end），启动前校验（防环/连通/配置完整），杜绝 AI 动态生成的不稳定性。
- **真实并行**：数据流调度器，前驱全部落定即发射，全局 Pane 并发上限保护终端；Fan-in 汇聚屏障支持严格（任一分支失败即失败）/宽容（requireAll=false，用成功分支继续）两种语义。
- **状态防漂移**：`pane.agent_status_changed` 事件订阅 + 周期轮询双向校对，idle/working/blocked/done/unknown 五态全 mirrored。
- **blocked 人工审批**：Agent 触发审批 UI 时画布标红 + 审批卡片（终端快照 / 放行按键可配 / 终止 / 自由输入补充指令）。
- **黑板产物交接**：每个 Agent 节点的 prompt 自动附加「结果写入 `.herdr/artifacts/<nodeId>.json`」约定（绝对路径，按节点隔离）；done 后编排器读取，缺失时回退终端输出尾部。下游 prompt 通过 `{{nodeId.artifact.summary}}` / `{{nodeId.output}}` 插值引用上游产物。
- **全生命周期资源管控**：每次运行创建 `paneflow-<runId>` 独立 workspace，正常结束/失败/停止/服务重启（孤儿扫描）四条路径全部自动回收，不污染用户会话。
- **失败策略**：节点级重试次数（重试=全新 Pane+Agent）+ `onFail` 终止/跳过继续。

## 开发

```bash
pnpm test        # 全部测试（socket 客户端 9 + 编排引擎 17）
pnpm smoke       # 隔离 pf-test 会话全链路冒烟（workspace→pane→agent→prompt→清理）
pnpm typecheck   # TS 全量类型检查
```

- `packages/shared` — DAG 模型 / 校验 / 拓扑 / 模板插值（前后端共享）
- `packages/server/src/herdr` — herdr socket 客户端（NDJSON、一次请求一连接、专用事件连接、自动重连重订阅）
- `packages/server/src/orchestrate` — 调度引擎（可全量单测，herdr 操作抽象为 `HerdrOps` 接口）
- `docs/` — herdr socket 协议 schema 与实测经验（`protocol-learnings.md`）

### 发布免克隆发行包

`node scripts/build-release.mjs` 在本地产出 `out/release/paneflow-<ver>.tgz`（+ `paneflow-latest.tgz`，
各带 `.sha256` sidecar 供 `install.sh` 校验；入口 `bin/paneflow.mjs` 与 `LICENSE` 原样入包）。
产物冒烟是发布的一环：`node scripts/smoke-release.mjs` 对真产物跑断言，每条同时钉精确退出码与输出子串
（防「非零即绿」假验），CI 在打包后、发 Release 前必跑，任一不符即不发。
正式分发走 CI：改 `package.json` 版本号 → 打标签推送，`.github/workflows/release.yml` 自动构建并发布 GitHub Release，
`install.sh` 与 `npm i -g <release-url>` 即刻可用：

```bash
git tag v0.2.0 && git push origin v0.2.0
```

## 边界（明确不做）

AI 动态生成 DAG、公网 SaaS/多租户、改造 Herdr 内核、复用第三方 DAG 引擎。OpenViking / OmniRoute / 模板云端同步 / Electron 为后置可选插件，MVP 不含。
