# PaneFlow 项目长期记忆

## 项目定位

**PaneFlow** = 基于 Herdr 真实终端 Pane 的**确定性**多 Agent DAG 可视化编排平台。

- 画布节点 1:1 映射独立 Herdr Pane（独立进程 / 终端 / 工作目录 / 会话）→ 硬隔离、真实并行、原生 blocked 人工审批。
- 与所有 LLM-API 软编排、AI 动态生成工作流系统的根本区别：**拓扑永远由用户策展，AI 只做"选哪个骨架 + 填什么参数"**（决策 D3 确定性红线，不可破）。
- 栈：Vite + React + @xyflow/react ← REST/WS → Node 22 + Fastify ← NDJSON over Unix Socket（herdr 协议 20）→ Herdr server → 17 种编码 Agent。
- 仓库：`JXzfluser/PaneFlow`（公开），本地路径 `/Users/zfl/Documents/CopawKnowledgeBase/llm-wiki/raw/PaneFlow`。

## 关键路径

| 用途 | 路径 |
|---|---|
| DAG 模型 / 校验 / 拓扑 / 插值（前后端共享） | `packages/shared/src/dag.ts` |
| 调度引擎（1223 行，核心资产） | `packages/server/src/orchestrate/engine.ts` |
| HTTP API（586 行） | `packages/server/src/api/http.ts` |
| 前端状态与**画布往返** | `packages/web/src/store.ts` |
| 节点属性面板 | `packages/web/src/components/PropertyPanel.tsx` |
| 内置模板（8 个） | `packages/server/src/orchestrate/builtin-templates.ts` |
| 智能下发（Planner → pipeline 路由） | `packages/server/src/api/dispatch.ts` |
| 迭代决策记录 | `docs/iteration-issue-driven.md`（v4）、`docs/iteration-v5-product-readiness.md`（v5） |

## 旗舰交付链路（项目最值钱的部分）

入口 A：`builtin-issue-triage` 模板（explore → triage 建 Issue → route 路由）
入口 B：`POST /api/dispatch` 智能下发（Planner 单点决策 → pipeline 路由）
→ 均汇入 `builtin-generic-issue-delivery` 骨架：
`align`（注入 AC-N 验收断言 + 回写远程 Issue 正文）→ `plan`（拆解 + 断言覆盖映射）→ `fork`（按 `extra.tasks` 动态扇出）→ `impl×N`（并行实现 + 逐条自测回写 `extra.assertionResults`）→ `merge`（宽容汇聚）→ `verify`（逐条核对断言）→ `wrapup`（git 收口 + Issue 回贴）

## 工程约定（必须遵守）

- **提交信息**用 Conventional Commits，正文注明关联 Issue。
- **结果交接约定**：每个 Agent 节点须写结果文件 `.herdr/artifacts/<nodeId>.json`，字段 `summary`（必填）/ `files` / `errors` / `extra`。
- **验收断言约定**：`extra.acceptance = [{id:"AC-N", assertion, verify_method}]`（align 注入）；`extra.assertionResults = [{id, status:'ok'|'fail'|'n/a', evidence}]`（impl/verify 回写）。**禁止插值数组字段**（引擎会 String 化成 `[object Object]`），引用断言一律照抄 Markdown 文本。
- **env 合并优先级**：全局 `PF_PANE_ENV` < 模型网关 < 角色 < 节点。
- **运行产物目录 `.herdr/` 不进版本库**（run 启动时自动确保 `.gitignore` 含 `.herdr/`）。
- 红线：不做 AI 动态生成 DAG、不做公网 SaaS/多租户、不改造 Herdr 内核、不复用第三方 DAG 引擎、不做个人微信对接。

## 测试与质量基线

- `pnpm test` = **78/78 全绿**（10 文件）；`pnpm typecheck` 通过；`pnpm smoke` 为全链路冒烟脚本（非自动化回归）。
- **前端测试数 = 0**，且**无 CI**（无 `.github`）。任何前端改动目前无自动化保护。
- 单测可直接造 mock：`packages/server/src/orchestrate/fake-ops.ts`（HerdrOps 抽象）、`app.inject()` + `vi.stubGlobal('fetch')`。

## 已知设计缺口（v5 评估结论，按优先级）

- **P0 数据完整性**：`store.ts` 的 `toGraph()` 不输出 `graph.variables`；`dagToRf()`/`toGraph()` 丢弃 `edge.condition`；重建 metadata 时丢 `description`、重置 `createdAt`。→ 画布保存会静默销毁数据，必须最先修。
- **P0 能力可达性**：条件边 / checks / 动态扇出 / 模板变量**四个高级能力全部无 UI**；画布无自动保存；rootCwd 仅裸文本框（`/api/fs/browse` 前端零调用）。
- **P0 并发正确性**：设计 D8 的 worktree 隔离 / 软锁 / 脏检查 / 同 issue 幂等锁**全部零实现**，而旗舰骨架默认让 N 个 impl 并发写同一 cwd。
- **P1 安全**：API 无鉴权；`/api/fs/read` root 由客户端提供（任意文件读）；`input` 端点可注入终端；host 硬编码 127.0.0.1（`--host` + 令牌未实现）；无结构化日志。
- **P1 可运维**：运行历史硬截断 50 条（`store.ts:163`）。
- **P2 分发**：无 LICENSE / 无 CI / 无安装器；服务重启一律标记 failed，无断点续跑。

## 协作备忘

- 环境：macOS，node 22.22.2（managed），pnpm 10.28.0，herdr 0.8.2（`~/.local/bin/herdr`）。
- 复核代码时**必须用 ripgrep（Grep 工具）或 `grep -E`**：macOS BSD `grep` 不支持 `\|` 交替，会静默产生假阴性（曾因此误判）。
- 评估能力时按三列核对：**引擎实现 → UI 可达 → 画布往返安全**。
