# Herdr Socket API 实测经验（protocol 20 / herdr 0.8.2）

2026-09-10 PaneFlow M0 阶段实测结论，适配器开发以此为准，官方 schema 见 `herdr-socket-schema.json`。

## 连接模型（最重要）

- **一次请求一条连接**：api socket 上每个请求使用独立连接，服务器响应后立即关闭连接。不要复用连接发第二个请求（会 EPIPE）。
- **订阅是例外**：`events.subscribe` 所在连接在确认后保持打开，持续推送事件。客户端用一条专用事件连接，承载所有订阅的并集；订阅集合变化时重建连接。

## 订阅规则

- `pane.agent_status_changed` 等 pane 过滤类事件**必须携带 `pane_id`**，且 pane 必须已存在（订阅不存在的 pane → `pane_not_found` 错误并关闭连接）。
- **没有通配符**。想全局监听 agent 状态变化，只能在每个 pane 创建后逐个订阅（编排器知道自己的 pane，这足够）。
- 无过滤的订阅（如 `workspace.created` / `workspace.closed`）可直接使用。
- 订阅确认：`{"id":"<req>","result":{"type":"subscription_started"}}`。
- 官方文档称订阅不回放历史事件，但实测新订阅偶尔会收到近期事件（如 workspace_closed）——**编排器必须按自己的 workspace_id/pane_id 过滤**，不能盲目信任到达顺序。

## 推送事件封包

```json
{"event":"pane.agent_status_changed","data":{"pane_id":"w3:p2","workspace_id":"w3","agent_status":"working","agent":"opencode"}}
```

## Agent 生命周期实测

- `agent.start` 返回时 agent 可能仍是 `unknown` + `launch_pending: true`，**不代表就绪**。必须随后 `agent.wait --until idle`（编排器统一流程：start → wait idle → prompt）。
- `agent.prompt` 带可选 `wait: {until, timeout_ms}`，会等待本轮工作 settle（idle/done/blocked）后返回。
- `blocked` = Herdr 识别到审批/提问 UI。放行 = 通过 `agent.send_keys` 发送按键序列（因 agent kind 而异，须可配置）。
- **`agent.read` 可能读不到内容**：跑在 alternate screen 的 agent（如 opencode 的 TUI）输出不进入 host scrollback。因此**黑板产物走结果文件约定**（`.herdr/artifact.json`），不依赖终端读取。`detection` source 是检测缓冲区，`visible` 是当前视口。
- 状态五值：`idle/working/blocked/done/unknown`。`done` = 后台工作完成且未被查看的 idle（查看 tab 后变 idle）。

## 服务器管理

- 命名 session 独立 server：`herdr --session <name> server`（后台），socket 位于 `~/.config/herdr/sessions/<name>/herdr.sock`，停止：`herdr --session <name> server stop`。
- `herdr api schema --output <path>` 可导出完整 JSON Schema（255KB，含全部 91 个方法与参数定义）。
- 关键 ID：workspace `w1`、tab `w1:t1`、pane `w1:p1`；`workspace.create` 一次性返回 workspace/tab/root_pane 三件套。
- `pane.split` 参数：`direction: right|down`、`target_pane_id`、`cwd`（每节点独立工作目录的关键）、`ratio`、`env`。
- 错误响应：`{"id":"","error":{"code":"...","message":"..."}}`，常见 code：`not_found`、`invalid_request`、`pane_not_found`、`agent_not_ready`、`agent_blocked`、`timeout`。

## 其他

- 本机 Agent kind 一览（`herdr integration list`）：pi, omp, claude, codex, copilot, devin, droid, kimi, opencode, kilo, hermes, qodercli, qwen, cursor, mastracode, antigravity-cli, grok。
- aviz85/herdr-controller（MIT）已无 FastAPI 后端（改为 Next.js route + shell 调 CLI），API 面不含 workspace 生命周期，**不作为桥接层**——已决策自研适配器。
