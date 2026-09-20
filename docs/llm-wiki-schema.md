# llm-wiki 沉淀 schema（Issue #6 / 首驾-llmwiki + Issue #7 落点改造）

PaneFlow 把一条绿 run 蒸馏成 **llm-wiki 风格**的知识页，push 到**主仓默认分支的
`llm-wiki/` 目录**（Issue #7：不再走 `<repo>.wiki.git`——GitHub dotcom 上 wiki 仓库
需网页人工初始化、且细粒度 PAT 不支持 wiki 的 git 访问；普通目录只依赖 Contents 权限），
供读回（`/api/wiki/state`）与需求增强（`/api/issues/enhance` 上下文注入）长期累积使用。
门面不变：只有「跑完且绿 + 断言无 fail + 非兜底产物 + 用户点赞」的单才沉淀。

## 页面结构

```
<repo>@<默认分支>/
└── llm-wiki/
    ├── index.md            # 每个页面一行条目（链接 + 一行摘要），同路径去重
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
| `tags` | `[paneflow, run-record, <spaceId>]` | 无 spaceId 则两枚 |
| `created` | run 起始时间 | 缺则用发布时间 |
| `updated` | 本次发布时间 | — |
| `sources` | `paneflow:run/<id>` + `repo:<r>` + `dag:<d>`（有 PR 再加） | — |
| `confidence` | 断言全过 → `high`；无断言结果 → `medium` | — |

`pf-run` / `pf-repo` / `pf-dag` / `pf-space` / `pf-contract-source` / `pf-published`
为 PaneFlow 溯源扩展键，跟在七字段之后。

## 改动落点

- `packages/server/src/api/wiki.ts`
  - `renderWikiPage`：纯函数，run → 页（七字段 frontmatter + 分类相对路径）+ `indexEntry`/`logNote` 记账串。
  - `mergeWikiIndex` / `appendWikiLog`：index 合并（同 file 原位替换去重）、log 只追加。
  - `syncWikiCache`：shallow + sparse-checkout 只物化主仓缓存的 `llm-wiki/` 子树，返回默认分支名；token 不落 .git/config。
  - `publishWikiPage`：写页到 `llm-wiki/<分类>/`，落页后写 `llm-wiki/index.md`/`log.md`，三文件一起 `git add` 提交、push 到默认分支；撞远端前移重同步重试一次。
  - `readWikiPages`：只递归 `llm-wiki/` 子树（相对该根返回路径），排除 `index.md`/`log.md`，
    frontmatter `title` 优先、文件名回退；缓存缺失/落点为空返回空不抛。
- 读侧消费不变：`http.ts` 的 `/api/wiki/publish`、`/api/wiki/state`、`/api/issues/enhance`
  （`pickWikiExcerpts(readWikiPages(...))` 自动覆盖两种结构）。
- 单测：`wiki.test.ts`（AC-1..AC-4 纯函数 + 混放读回）、`http-wiki-state.test.ts`（路由门）。
