# PaneFlow 长期记忆

> 细节论证见 `docs/`（scenario-value-map、ux-simplification-proposal、iteration-v4/v5）。

## 是什么

基于 Herdr **真实终端 Pane** 的确定性多 Agent DAG 编排平台。一个画布节点 = 一个独立 Pane（进程/终端/cwd/会话硬隔离）→ 真并行 + 原生 blocked 人工审批。
栈：Vite+React+@xyflow/react ←REST/WS→ Node22+Fastify ←NDJSON over Unix Socket(herdr 协议 20)→ Herdr → 17 种编码 Agent。
**D3 红线**：拓扑永远由用户策展，AI 只"选骨架 + 填参数"。不做 AI 生成 DAG / 公网 SaaS / 改 Herdr 内核 / 复用第三方 DAG 引擎 / 个人微信对接。

## 关键路径

- 共享 DAG 模型/校验/拓扑/插值：`packages/shared/src/dag.ts`
- 调度引擎（核心资产）：`packages/server/src/orchestrate/engine.ts`
- HTTP API / 出站通道层：`packages/server/src/api/{http,channels}.ts`
- 前端状态与画布往返：`packages/web/src/{store,graph-serialization}.ts`
- 运行时间线：`packages/web/src/timeline.ts` + `components/RunTimeline.tsx`

## 旗舰链路（最值钱）

入口 A `builtin-issue-triage`；入口 B `POST /api/dispatch`（Planner 单点决策）→ 均汇入 `builtin-generic-issue-delivery`：
align（注入 AC-N 断言 + 回写 Issue）→ plan → fork（按 `extra.tasks` 扇出）→ impl×N（并行自测）→ merge（宽容汇聚）→ verify（逐条核对）→ wrapup（git 收口 + 回贴）。

## 工程约定

- Conventional Commits，正文注明 Issue；偏好**分笔提交**（feat/fix 分开）。
- 结果交接：每节点写 `.herdr/artifacts/<nodeId>.json`：`summary`(必填)/`files`/`errors`/`extra`。
- `extra.acceptance=[{id:"AC-N",assertion,verify_method}]`（align 注入）、`extra.assertionResults=[{id,status:'ok'|'fail'|'n/a',evidence}]`（回写）。**禁止插值数组字段**（会 String 化成 `[object Object]`）。
- env 优先级：`PF_PANE_ENV` < 模型网关 < 角色 < 节点。`.herdr/` 不进版本库。

## 质量基线

`pnpm test` = **122 全绿**（server 92 + web 30）。⚠️ `pnpm typecheck` **不含 web** → 前端必须 `pnpm --filter @paneflow/web exec tsc -b`。
前端可测的姿势：把纯逻辑抽成独立模块（`timeline.ts`/`steps.ts`/`graph-serialization.ts`）脱离 DOM 单测；服务端用 `orchestrate/fake-ops.ts` + `app.inject()`。

## 未修缺口（按性价比）

1. **CI 触发分支写 `main`，仓库实际是 `master`** → `.github/workflows/ci.yml` 永不触发，自动化保护为零（一行修）。
2. 自动保存订阅漏比 `graphVariables`/`graphMeta`（只比 nodes/edges/graphName/cwd）。
3. 孤儿 worktree：`reclaimWorktrees` 只在 run 收尾调用、`liveWorktrees` 是内存态 → 重启后 `os.tmpdir()/paneflow-wt/*` 与 git worktree 僵尸残留，应并入 `recoverOrphans`。
4. 运行检索筛选 UI 缺失；`nodeDuration()` 是死代码。
5. 信任模式：host=127.0.0.1 且无 `PF_TOKEN` 时鉴权全关；`/input`、`/keys`、`/api/fs/*` 应无条件要求令牌。

## 产品判断

- **引擎是产品级，骨架是演示级**：内置 8 骨架 condition/checks 各 0 次、variables 1 次，7/8 收不到真实输入 → 缺口是内容不是能力，先给骨架加 `variables` 声明。
- 先做：① 交付审计报告（零引擎改动）② 数据治理批次 ③ 多仓并行交付。角色库仍是薄壳（Role 仅 id/name/agentKind/prePrompt/env），领域知识只能靠 `buildConventionBlock()` 注入。
- **跨机/多机的接缝是 `HerdrOps`**（`FakeHerdrOps` 已是先例，接口里 `target` 是字符串，可编码 `peer:pane`）→ 引擎零改动。但 `createWorktree` 是 engine 私有方法、用本地 `os.tmpdir()` 执行 `git worktree add` → **跨机必须把建/收 worktree 移到执行机侧**，否则节点 cwd 指向不存在的路径。
- 定位：卖"活在你能看见、能干预、能留证的封闭环境里被干完了"（明厨亮灶）。

## 控件基线（styles.css 顶部设计系统层）

新增控件一律吃基线（圆角/边框/过渡 + `:focus-visible` 焦点环），**禁止再写内联样式**。两条铁律：给 input/select 设背景**只用 `background-color`**（`background` 简写会重置下拉箭头 `background-image`）；局部 `padding` 简写会覆盖基线 `padding-right`，须补 `select{padding-right:26px}`。

## 验证 harness（技能 `paneflow-ui-verify`）

playwright-core 装在 `/Users/zfl/.workbuddy/binaries/node/workspace/`（脚本必须放这里跑，ESM 不认 NODE_PATH），复用缓存 Chromium。服务端 `PF_DATA_DIR=/tmp/paneflow-verify PF_PORT=4399 pnpm dev:server`（兼托管 dist）。

## 踩过的坑

- 复核代码必须用 ripgrep/Grep 或 `grep -E`：BSD grep 不支持 `\|` 交替会静默假阴性。`rg -r` 是 `--replace` 不是递归。
- **同一文件在同一消息里发多个 Edit，实测只有一次落盘** → 逐条改并复核。
- 评估能力按三列核对：引擎实现 → UI 可达 → 画布往返安全。
