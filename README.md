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

## 快速开始

前置：本机已安装并运行 [Herdr](https://github.com/herdrdev/herdr) ≥ 0.8.2，Node ≥ 22，pnpm。

```bash
pnpm install
pnpm build          # 构建前端
pnpm dev:server     # 启动编排服务（http://127.0.0.1:4310）
pnpm dev:web        # 启动画布开发服务（http://127.0.0.1:4311，代理 API）
```

打开 http://127.0.0.1:4311 ：左侧拖入 开始/Fan-out/Agent/Fan-in/结束 节点 → 连线 → 配置每个 Agent 节点的类型（pi/opencode/claude…）与任务指令 → 设置流水线工作目录 → 运行。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PF_HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | Herdr api socket 路径 |
| `PF_PORT` | `4310` | 编排服务端口 |
| `PF_DATA_DIR` | `~/.paneflow` | 模板与运行记录存储 |
| `PF_MAX_PANES` | `8` | 全局并行 Pane 上限 |
| `PF_PANE_ENV` | 空 | 注入流水线 workspace 的环境变量（`K=V,K2=V2`），如 `OPENCODE_DISABLE_AUTOUPDATE=1,PI_DISABLE_UPDATE_CHECK=1` |
| `PF_WORKSPACE_PREFIX` | `paneflow-` | 流水线 workspace 标签前缀（自动回收依据） |
| `PF_GITHUB_REPO` | 空 | 启用 GitHub 模板沉淀（`owner/name`） |
| `PF_GITHUB_TOKEN` | 空 | GitHub PAT（需 Contents 读写权限；只从环境变量读取，永不入库/入日志） |
| `PF_GITHUB_BRANCH` | `main` | 沉淀分支 |
| `PF_GITHUB_DIR` | `templates` | 沉淀目录 |

配置后顶栏出现「☁️ 沉淀 / ⬇️ 拉取」：沉淀把本地全部模板异步推送到仓库 `templates/*.json`；拉取反向合并到本地。默认关闭，断网不影响任何核心功能。

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

## 边界（明确不做）

AI 动态生成 DAG、公网 SaaS/多租户、改造 Herdr 内核、复用第三方 DAG 引擎。OpenViking / OmniRoute / GitHub 沉淀 / Electron 为后置可选插件，MVP 不含。
