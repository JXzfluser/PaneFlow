# llm-wiki 沉淀 schema（Issue #6 / 首驾-llmwiki + Issue #7 落点改造 + v11-C2 双门）

PaneFlow 把一条绿 run 蒸馏成 **llm-wiki 风格**的知识页，push 到**主仓默认分支的
`llm-wiki/` 目录**（Issue #7：不再走 `<repo>.wiki.git`——GitHub dotcom 上 wiki 仓库
需网页人工初始化、且细粒度 PAT 不支持 wiki 的 git 访问；普通目录只依赖 Contents 权限），
供读回（`/api/wiki/state`）与需求增强（`/api/issues/enhance` 上下文注入）长期累积使用。

## 双门判据（v11-C2，fail-closed；`publishableRun(run, kind)` 纯函数）

- **正门（kind=`green`，缺省）**：`completed` + 无兜底（unverified）产物 + 断言无
  `fail` + **断言行 ≥1 条 `status=ok`** 才放行。0 条结果、全没跑、只有 `n/a`
  一律拒——**断言没跑≠绿**（首驾 run ba2751bf 的 0/6「没跑」钻空收口，摩擦账 #17）。
  `completed-with-failures` 正门专属拒绝语并指路侧门。
- **反面教材侧门（kind=`counterexample`）**：只收带失败收口的单
  （`failed` / `completed-with-failures`），显式沉淀教训页；**两门互斥**——能过
  正门的绿单走侧门同样被拒（「别贴反面教材标签」），中间态（running/paused 等）
  两边都进不去。绿门与侧门共用 `{ok, reason}` 语义面。

## 侧门 API 形态

```
POST /api/wiki/publish
{ "runId": "…", "repo": "owner/name", "confirm": true, "kind": "counterexample" }
```

`kind` 缺省或 `"green"` 走正门；只接受 `green|counterexample`，其余 400。
侧门页 = 同 llm-wiki 风格 + 三特征：frontmatter `confidence: low`（tags 另加
`counterexample`）、正文页首一行固定警示（`> ⚠ 反面教材：…结论与做法不可照抄`）、
index 条目带 `⚠ ` 前缀（条目面复用、按 file 去重语义不变），log.md 照记。
响应原样回显 `kind`。public 仓 409 二次确认门对两门同等生效。

## 页面结构

```
<repo>@<默认分支>/
└── llm-wiki/
    ├── index.md            # 每个页面一行条目（链接 + 一行摘要），同路径去重；反例条目 ⚠ 前缀
    ├── log.md              # 只追加记账：ISO 时间 + run id + 落了哪些页
    ├── concepts/           # type: concept
    ├── entities/           # type: entity
    ├── summaries/          # type: summary —— run 沉淀页固定落这里
    └── syntheses/          # type: synthesis
```

- 文件名：小写连字符 slug（`sanitize` + `lowercase`），形如
  `summaries/修登录页样式-abc123.md`（dag 名 + runId 后 6 位）。

## frontmatter 七字段（缺省有确定兜底）

| 字段 | 取值 | 兜底 |
| --- | --- | --- |
| `title` | `dagName（run runId）` | — |
| `type` | `concept\|entity\|summary\|synthesis` | run 页恒为 `summary` |
| `tags` | `[paneflow, run-record, <spaceId>]`；侧门页另加 `counterexample` | 无 spaceId 则两枚 |
| `created` | run 起始时间 | 缺则用发布时间 |
| `updated` | 本次发布时间 | — |
| `sources` | `paneflow:run/<id>` + `repo:<r>` + `dag:<d>`（有 PR 再加） | — |
| `confidence` | 断言全过 → `high`；无断言结果 → `medium`；侧门反例页恒 `low` | — |

`pf-run` / `pf-repo` / `pf-dag` / `pf-space` / `pf-contract-source` / `pf-published`
为 PaneFlow 溯源扩展键，跟在七字段之后。

**兼容读（v11-C2）**：读回解析 `confidence`；旧页（Issue #6 时代无此键）视为正页，
不降权、不报错。

## 改动落点

- `packages/server/src/api/wiki.ts`
  - `publishableRun(run, kind)`：双门判据（v11-C2 fail-closed 正门 + counterexample 侧门，互斥）。
  - `renderWikiPage`：纯函数，run → 页（七字段 frontmatter + 分类相对路径）+ `indexEntry`/`logNote` 记账串；
    `kind:'counterexample'` 出侧门页三特征（confidence low / 正文首行 ⚠ 警示 / index 条目 ⚠ 前缀）。
  - `mergeWikiIndex` / `appendWikiLog`：index 合并（同 file 原位替换去重，⚠ 前缀条目同样按 `](file)` 命中）、log 只追加。
  - `syncWikiCache`：shallow + sparse-checkout 只物化主仓缓存的 `llm-wiki/` 子树，返回默认分支名；token 不落 .git/config。
  - `publishWikiPage`：写页到 `llm-wiki/<分类>/`，落页后写 `llm-wiki/index.md`/`log.md`，三文件一起 `git add` 提交、push 到默认分支；撞远端前移重同步重试一次。
  - `readWikiPages`：只递归 `llm-wiki/` 子树（相对该根返回路径），排除 `index.md`/`log.md`，
    frontmatter `title` 优先、文件名回退；v11-C2 另解析 `confidence` 入 `WikiPage.confidence`
    （旧页无键 → undefined，兼容读视为正页）；缓存缺失/落点为空返回空不抛。
  - `pickWikiExcerpts`：**读回降权（v11-C2）**——`confidence: low` 的页相关度折半
    （×0.5）排序靠后、同分正页优先；有命中的反例不丢（唯一相关经验照样入选），
    命中时 label 明示「反面教材（低置信…勿照抄）」给 enhance 注入面足上下文。
- 读侧消费：`http.ts` 的 `/api/wiki/publish`（v11-C2 起 body 多一可选 `kind`，缺省 `green`
  零回归）、`/api/wiki/state`、`/api/issues/enhance`（`pickWikiExcerpts(readWikiPages(...))`
  自动覆盖两种结构与降权）。
- 单测：`wiki.test.ts`（AC-1..AC-4 纯函数 + 混放读回 + v11-C2 双门两向/侧门页三特征/读回降权/旧页兼容/路由 kind 门）、`http-wiki-state.test.ts`（路由门）。
