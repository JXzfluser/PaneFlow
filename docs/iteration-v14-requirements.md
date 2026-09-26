# iteration v14 需求（v0.2 草案，底座重构立项：一处登记 · 处处可选 · 每单有账；经三路对抗验证对账一轮，待用户裁决）

日期：2026-09-26。前身：v13（21 片已落，最后一笔 `afb8d4e`＝B2 三层消费＋B4 交付出口；K1 未收口、K2 门控、Z 未办）。
立论方式：本轮按用户指令立**第零条账——底座形状**，slogan 是「一切能力均可注册接入，所有业务皆由模板编排」，
并把它折成一枚可判真的检验：**任何一项能力，如果新增它必须改 TS 常量或硬编码分支，它就还没进底座**。
纪律不变：凡断言必带 file:line；凡需求必带可感面（原样可执行的命令 + 看得见的输出变化）；只挂账不喊口号。

v0.1 → v0.2 的来源：三路对抗验证（事实核验 15 行 / 架构可行性 15 条 / 体验与可感面 11 条，共 41 条发现，全部带证据）。
**v0.1 的三处设计错误被推翻**（不是被修正，是被判死）：①`sha=contentSha(活注册行 spec)` 作为等臂判据——直接违反本仓
自己钉死的指纹家规（`harness.ts:186-190`：roleSha 刻意不逐文件算内容指纹，就是为了「同装备=同指纹」不被编辑噪声打破）；
②统一 `spec: Record<string, unknown>`——会拆掉现存唯一的类型级纪律（`shared/src/dag.ts:119` `const _checkSpecTypesCovered:
Record<Exclude<CheckSpec['type'], CheckSpecType>, never>`，新增一类而漏登记则编译即红）；③把 `graphs/` 迁进注册表——
`api/github-sync.ts:74 pushAll()` 与 `:106` 起 `saveGraph` 都吃 `store.listGraphs()`，搬完云同步面静默失效。
处置全表见「对账」节。

## 评估总判（一句话给每路）

- **事实核验路**：机制类断言基本全部成立，但要我改口四处——`worktrees` 是我 grep 漏掉的真落点（`engine.ts:330` 走
  `this.store.root`）、`herdr.sock` 根本不住 dataDir（缺省 `~/.config/herdr/herdr.sock`，`config.ts:89-94`）、
  `runs`/`templates` 是 legacy 迁移源不是活配置、`fallbackTemplate` 不是「兜空」而是两步解析后节点明败。
  两条反而**加强**论点：agent kind 是**两枚** TS 白名单（`api/env-check.ts:6-25` 18 枚探测表 + `api/http.ts:81-100` `AGENT_KINDS`，
  后者在 :848/:1309 强制、:953 回显），「插件」一词全仓唯一命中在 `api/channels.ts:7` 注释里——把一条 `ChannelType` 联合
  加 if 链称作「通道插件」。
- **架构可行性路**：15 条里 8 条 blocker，最重的三条判死 v0.1 的形状（上节）；此外判出我漏的第七红线（账本唯一写端）
  与一条范围实锤——**K1 未收口就叠 16 片是本轮最大的信用风险**。
- **体验路**：slogan 点名要的「模型」在我 v0.1 里根本没有注册面；`--from ./x.json` 把 f93df09 换来的「表单+就地回执」
  标准降回「手写配置文件」；体验全押在最后一根 workflow 上，A3 做完用户屏幕上什么都看不到。

## 一、现状事实账（v0.2 全部重新实测；这是 slogan 前半句今天为假的证据）

dataDir 一级落点实测 **15 枚**（grep `path.join(dataDir|this.store.root|root, '<名>')`，生产码，去重后逐条核）：
8 枚单文件（`auth-token.json` `server.lock` `github.json` `channels.json`+`settings.json` `roles.json`
`wiki-visibility.json` `gateway.json`）· 5 个目录（`spaces/` `graphs/` `worktrees/` `wiki-cache/` `experiments/`）·
2 枚 legacy 迁移源（`templates/` `runs/`，`store.ts:252-253` 只读搬走）。其中**自有 schema 的登记面 9 张**。

| 能力面 | 存在哪 | 写入语义 | 校验 | 删除语义 | 引用方式（跨面） |
|---|---|---|---|---|---|
| 网关档 | `gateway.json` profiles[] | 按 id upsert（`api/gateway.ts:113`，:122 是 id 去重环） | `parseGatewayDoc` 读端宽松洗（:34-40） | 「只剩这一档拒删」（:152） | `SpaceProfile.gatewayProfile` **裸字符串 id** |
| 角色库 | `roles.json` | **整库替换**（PUT，`http.ts:296→344 saveRoles()`） | 入库 fail-closed + 读端 `normalizeDeclares` 兜手改盘（`roles.ts:52`） | 改 id=历史能力账断轴，**无 id 稳定性守卫** | `space.team[].roleId`、`node.config.role` |
| 通知通道 | `channels.json` | **整文件非原子写**（`channels.ts:105-107` `fs.writeFileSync`） | 自带一套 | 自带 | 类型是 `ChannelType` 联合（:10）+ if 链（:127）——注释 :7 自称「通道插件」 |
| 项目规则 | `SpaceProfile.rules[]`（`store.ts:17`） | PUT /api/spaces/:id **按键 merge**（`{...profile,...patch}`，`http.ts:900`） | 自带 | 显式 `[]` 才清空 | `role.rules[]` **裸路径串** |
| 技能 | `SpaceProfile.skills[]`（:19） | 同上 | **无**（路径字符串数组） | 同上 | `role.skills[]` 裸路径串；清单外引用→`equip.unknownSkills` 只披露不拦（`engine.ts:3156`） |
| 已登记仓库 | `SpaceProfile.repos[]`（:21） | 同上 | **无** | 同上 | `rules[].repo` / `delivery[].repo` 目录名串 |
| 交付家规 | `SpaceProfile.delivery[]`（:44） | 同上 | `validateDelivery` fail-closed 400（`delivery.ts:53`，未知键 :62-64） | 同上 | engine 建 worktree 现场匹配 |
| 编排模板 | `graphs/*.json`（全局，v10-Y，`store.ts:197`） | 模板 CRUD | `validateDag` | **删了不查引用** | `pipeline.template` 裸名串；缺失→`fallbackTemplate`（`engine.ts:2648-2651` 落事件），仍无→节点失败「模板不存在…」（:2653） |
| agent kind | **两枚 TS 常量**：`env-check.ts:6-25`（18）+ `http.ts:81-100`（`AGENT_KINDS`） | **改代码 ×2** | 节点侧只过正则（`dag.ts:914,1003`）；请求侧白名单 :848/:1309 | — | `node.config.agentKind` |
| 机检类型 | **TS 常量 6 枚**（`dag.ts:109-116`）＋**编译期双向锁**（:119） | **改代码**（且引擎执行点是 if 链 `engine.ts:2276-2307`） | 未知即拒（v13-V0，:983） | — | `checks[].type` |
| 节点类型 | **TS 常量 6 枚**（`dag.ts:7`） | **改代码**（引擎按类型分支 `engine.ts:1689,1710`） | 未知即拒（:975） | — | `nodes[].type` |
| 内置模板 | **TS 常量**（`builtin-templates.ts:544`）+ 幂等 seed（:557，绝不覆盖用户改/删） | **改代码 + 重新发行** | 同模板 | — | 同模板；**C4 实机恢复路径依赖 seed**（`scripts/c4-night1.sh:88`：`mv graphs/<t>.json{,.bak}` + 重启触发重播） |
| 模型 | 无独立面：只作为网关档的 `freeModel` 字段 + catalog 实探清单（`api/gateway.ts` / `/api/gateway/catalog` 5min 缓存） | — | — | — | 角色/节点无可勾选的「模型」条目 |
| MCP server | `packages/*/src` **零命中**（本轮重跑，大小写不敏感） | — | — | — | docs 侧有既往裁决：v13:285「不自实现 MCP 客户端」、v13:154 `.mcp.json` 门控位 |
| 插件 | `packages/*/src` 零命中；唯一语义命中是 `channels.ts:7` 的中文注释 | — | — | — | — |

三个读数：

1. **「登记一项能力」今天有 12 套语义**，四种写入形状（upsert / 整库替换 / 整文件非原子写 / 按键 merge）、三档校验
   （fail-closed 400 / 读端宽松洗 / 根本没有）。这不是「配置项分散」，是**同一动作没有同一语义**——
   v13 体验账（`f426195` 编辑丢改动、`f93df09` 手填 JSON 改表单）修的是症状，形状没修。
2. **新增一种能力必须改码的有四处**：agent kind（两枚白名单）、机检类型（常量 + 引擎 if 链）、节点类型（常量 + 引擎分支）、
   通道类型（联合 + if 链）、内置模板（常量 + 重新发行）。slogan 前半句现状为假。
3. **跨面引用全是裸字符串，且每面自己发明容忍度**：角色引技能=路径串（越界跳过+只披露）、空间引角色=id（名册外只 warn，
   `shared/dag.ts:1185-1199` 推 `level:'warning'`，`engine.ts:858` 消费）、模板引模板=名串（两步解析后节点明败）。
   悬挂引用**没有一处**在写入面被拒过。

底座结论：PaneFlow **有配置面，没有注册面**。缺的不是再配几个键，是三件底座事实——
**一套统一信封（一张表，但每 kind 保判别类型）· 一种可解析可反查的引用 · 一份逐单不可变的能力快照账**。

## 二、目标（v14 一句话）

**把「能力散在 12 套语义里」换成「一处登记、处处可选、每单有账」**：所有能力都从同一个信封进来（形状各异、类型纪律不降级）、
被同一张引用索引管住（写端拒悬挂、运行面仍只披露）、被角色与模板**以勾选方式**消费；业务流凡是新增的都只由
「注册项 + 模板」组成而不再新增 TS 常量；并让底座继承 v12/v13 最硬的家产——
**每一单都能机器证自己当时吃了哪几项能力**，且这份证据不随注册表被编辑而改变（v0.1 用活行 sha 是错的，v0.2 改用快照，见 R5）。

### 波一最小闭环（M0，先兑现再谈其余）

迁一个 kind 就亮一个分组；M0 = R1 信封 + R2 引用索引 + T3 `requires` 预检 + 表单登记（含「模型」）+ R5 快照账。
**M0 的机证验收样张**（这是回答「凭什么信这不是形状重构」的唯一一条数，不接受形容词）：
① 取 10 条 v13 历史 run 各 `replay` 一次，`骨架# / ctxSha / roleSha` 三指纹与迁移前**逐字节相等**；
② server 全量测试零改动零红（本会话实测 684/684、engine.test 220/220、CLI 27/27、delivery 23/23；
对账路静态复算得 675–682，差值来自 `it.each` 与三处 for 循环展开——**以实跑为准，此处如实标静态口径**）；
③ 注册中心首屏截图一张：既有四面长成一张表、健康点、被引用数。三样齐全才继续投 R3/R4/T1；缺任何一样，v14 停在 M0。

## 三、支柱与需求

### P1 注册内核（R 系）

**统一的是信封，不是内容**：

```ts
RegistryEntry<K extends Kind> = { id: '<kind>:<slug>'; kind: K; name; source: 'builtin'|'user'|'discovered';
  enabled: boolean; spec: KindSpec[K];        // ← 每 kind 一个判别联合，住在 shared，编译期锁不许降级
  probe?: { ok: boolean; detail: string; at: string } }   // 缺=没探过（不是「健康」）
```

`Descriptor` 契约（代码侧注册，一 kind 一模块）：`{ kind, parse(spec)→一句人话错误|null, probe(entry), resolve(entry) }`。
写死三条边界，防内核变成第二个泥潭：
①**注册内核不吞运行时语义**——消费点仍走各自 `resolve`，取值改为从表里拿（engine 改动限于取值那一行，可逐 kind 切片）；
②**密钥类字段禁入 spec**——`gateway.json` 是 `mode: 0o600` 且注释明写「含 apiKey 明文」（`api/gateway.ts:61-64`），
读端 `listGatewayProfiles` 特意剥 key 只留 `keyConfigured`（:99-110）；注册表只存 id 引用，`probe`/`list`/详情抽屉
**永不打印 spec 原值里的密钥位**，只打 `keyConfigured=true` 一类读数；
③**id 不可变**——改名/改语义=新条目（否则本账第 1 节自己写的「改 id=历史能力账断轴」永不清偿）。

- **R1 统一信封与四个动词**：一套 CRUD + 一份 kind 判别联合清单 + 写端 fail-closed 400（同 `validateDelivery` 口径）。
  逐 kind 保留既有写入语义（整库替换 / merge / upsert 不强行拉平——R2 的引用 diff 基线就是「表内既有 id 集」）。
  **可感面（UI 主路，不是 JSON 主路）**：注册中心「＋登记一项」→ 选类型 → **按该 kind 的 `parse` 长出字段表单** →
  保存即探一次 → 就地回执（健康点 · 被引用数 · 一句「已登记，项目 X 现可用」）。
  `paneflow registry add skill --from ./x.json` 降级标注为**脚本/agent 专用**；`spec` 在界面上只读展示，
  **绝不出现裸 JSON 编辑器**。CLI 面：`paneflow registry list [--kind <k>] [--json]`。
- **R2 引用完整性与反查**：跨面引用升级为 `{kind, id}`；「谁在用」是**纯读推导**（扫 graphs/ + roles.json + spaces/，
  零新写路径，先例 v13-V1 `machineCheckTally`）。写入面 fail-closed：删除/禁用被引用项 → 400 列引用者。
  运行面**仍只披露**（手改盘面的悬挂引用不炸在跑的单，落一条 warn——「宁拒不错放」只管写入，不追改老单）。
  可感面：`paneflow registry refs gateway:p-gpt --json` → `{refs:[{type:'space',id:'demo',via:'gatewayProfile'}]}`；
  UI 详情列「被 2 个项目 · 1 个角色使用」，删不动的原因看得见。
- **R3 只读聚合视图（v0.1「搬数据进表」判死，改判）**：四面（gateway/roles/channels/spaces）**原地不动**，
  注册中心只是把它们渲成一张表 + 同一组动词的适配层。搬物理目录、改文件格式一律推后，且必须满足前置：
  `registry/schema.json` 版本戳 + 遇更高版本拒启（v13 记账的 R7「数据迁移版本戳」至今未认领，这是硬前置），
  `paneflow registry migrate --dry-run` 先出草案，回滚＝还整目录快照（**不是 `.bak` 改名**——
  那会让旧二进制在已搬空的目录上「零配置健康」启动，是最重的 宁缺毋假 违规）。
  `graphs/` 永不搬（云同步面 `github-sync.ts:74,106` 依赖 `store.listGraphs()`）；内置 seed 永不删
  （`c4-night1.sh:88` 的实机恢复路径靠它）。
  可感面：`paneflow registry list` 一屏看到四类；「A3-x 随片可见面」——迁一个 kind，注册中心亮一个分组。
- **R4 探测单通道**：一个 probe 调度（缓存 / 超时 / 强刷一份实现），复用既有件：`env-check.ts:27-101` 60s 缓存 +
  `:103 clearAgentProbeCache` 失效钩子、`herdr-ops.ts:120-128 probeAgent` 三态。
  **超时＝未知，绝不并入 `gone`**（探针通道自己造假缺就是造第二个 684 绿假账）。
  可感面：`paneflow registry probe agent-kind:pi` → `ok · /opt/homebrew/bin/pi`；
  `paneflow registry probe model:gpt-x --timeout 10s` → `未知 · 探测超时 10s（未探得，不等于不可用）`。
- **R5 逐单能力快照账（v0.1 `regSha=活行内容指纹` 判死，重设计）**：run 记录存
  `capabilityRefs: [{kind, id, specSha, spec}]`——解析现场**快照整份 spec 副本**，`specSha=contentSha(规范化 spec)`，
  用 `harness.ts:16-33` 现成 canonical 内容指纹；比对与分组用**整单不可变集**的指纹，不引用活行。
  于是「一次编辑改了历史 run 的读数」（v0.1 的病）不存在，「删了条目历史就查不到」也不存在（快照自带原文）。
  等臂第四枚仍成立，但判据换成：**同 id 集合 ∧ 快照指纹相等＝两臂能力面相同**；跨臂的注册表变更靠「语料表新增
  `registrySnapshotSha` 列」暴露，而不是指望活行不变。
  可感面：`paneflow status <runId>` 多一行 `  能力: 7 项（技能 2 · 机检 3 · agent 2）· cap#=8f21c0`；没走注册消费面=整行不显。

**kind 清单（v0.1 含糊处，定死）**：

| kind | 出厂条目来源 | 是否进表 | 消费者 | 波次 |
|---|---|---|---|---|
| skill 技能 | 项目档案 `skills[]` 路径 | 是（spec.file 相对主仓根） | 注入槽 / 角色勾选 | M0 |
| rule 规则 | `rules[]` 作用域条目 | 是（带 repo/pathsGlob 作用域） | 三轴划界注入 | M0 |
| repo 仓库/环境 | `repos[]` + `rootCwd` | 是（E 系发现器写入） | 派发 cwd / 机检基准 | M0 |
| model 模型 | `/api/gateway/catalog` 探得 | 是（「登记为常用模型」把探针读数变成可勾选项） | 角色/节点模型下拉 | M0 |
| gateway-profile 网关档 | `gateway.json` | 视图进、数据原地（R3）；密钥禁入 spec | 空间钉档 | M0 |
| role 角色 | `roles.json` | 视图进、数据原地 | 班底名册 / 节点绑定 | M0 |
| agent-kind | 两枚 TS 白名单合一 | 是 | 节点实发 kind | A3-2 |
| check-type 机检类型 | `CHECK_SPEC_TYPES` + 编译期锁 | 是（清单条目；**执行器与判别联合留代码**） | `checks[].type` 值域 | A3-3 |
| node-type 节点类型 | `DAG_NODE_TYPES` | 是（同上；T1 driver 契约） | 画布面板 + 引擎分派 | B |
| template 模板 | `graphs/` + seed | 视图进、**永不搬** | dispatch/pipeline 引用 | A3-1 |
| channel 通道 | `channels.json` | 是（含类型清单，替掉 if 链为按类型分派） | 通知派发 | M0 |
| artifact-kind 产物种类 | v13-K1 的 `doc`/`diff` | 是 | 产物台账与上架 | K1 收口后 |
| mcp / plugin | 无 | **需裁决**（撞 v13:285「不自实现 MCP 客户端」既有裁决定） | — | 见 §七 Q4 |

### P2 模板承载业务（T 系）

- **T1 节点类型注册面**：driver 契约 `{kind, configSchema, ports, run(ctx)→读数}`；6 枚内建类型先成清单条目
  （行为零改动，`validateDag` 改为按清单判值域）。**driver 只能返回读数，绝不写账**（红线七）。
  可感面：`paneflow registry list --kind node-type` → 6 枚内建；画布节点面板（`web/src/components/Palette.tsx`，
  现为硬编码列表）**改为读这张表**——注册进来一个节点类型，画布上就拖得出来，这是后半句最直接的可见证据。
- **T2 流程外移判决（v0.1 表 5 行判 4 行错，按证据改判）**：写账时序依赖一旦存在即**不可外移**，逐条留证：
  | v0.1 判决 | v0.2 判决与证据 |
  |---|---|
  | 契约提取/DoR 门 可外移 | **留引擎**：`contract` 检查直接决定门（`engine.ts:2340` `gated=checks.some(c=>c.type==='contract')`），`contractGate` 写 `run.contract/blockedAt/templateFeedback`（:2461-2535）；提取已在 `api/dispatch.ts:198-214`，消费在 `http.ts:1344`——账本写仍在引擎 |
  | 澄清循环 可外移 | **留引擎**：走 `promptAndSettle` 后重抽产物＝状态转移＋记账 |
  | wiki 沉淀门/读回 可外移 | **留引擎**：`planWikiReadback` 在 graph clone **之前**（`engine.ts:775`，属骨架期事实、影响 ctxSha），`maybeAutoDistill` 卡在收口（:1516） |
  | 交付对账 部分可外移 | **留引擎**：`reconcileDelivery` 夹在 `reclaimWorktrees`(:1488) 与 `computeRunCost`(:1510) 之间，位置即语义 |
  | 产物采集 K1 kind 化 | **可 kind 化但前置 K1 收口**（server 侧今天 `grep products packages/server/src` 零命中） |
  真正的「业务流走模板」兑现点因此**不在搬旧流程**，而在两条：①新增流程一律写成「模板 + 注册项」（新增节点类型走 T1，
  不新增引擎分支）；②模板作者能选的东西全进表（T3/P3）。诚实标注：slogan 后半句 v14 结的是「**新增**皆由模板编排」，
  「既有写账流程全外移」不在本版，也不假装在近路。
- **T3 模板带槽 `graph.requires` + 起单前预检**：模板顶层声明 `requires:[{kind, id?, hint?}]`，纯校验增量
  （`dag.ts:917-1041` 那套），起单按当前项目解析、缺项 fail-closed 即时红一句指路——今天的缺口是**静默少注入**
  （`unknownSkills` 只披露，模板作者要等节点行为异常才发现装备没上身）。
  可感面（含无人值守可编程判据）：
  ```bash
  paneflow registry check --template x --space demo       # 0=槽全命中；1=有缺口并列出缺哪几项
  paneflow registry check --template x --space demo --json # → {missing:[{kind,id,hint}]}
  paneflow dispatch "..." --template x --space demo        # 缺项当场退 1（与既有退出码表 0/1 完全兼容，watch 语义不动）
  ```
  模板卡上显示「需要：技能 2 · 机检 1 · 模型 1」+ 本项目命中✓/缺口✗（**先于派活可见**，这是 T3 的可感面）。
- **T4 插件与 MCP 承载**：v0.1 只给 58 字，本轮**降级为待裁决**（撞 v13:285 既有裁决，见 §七 Q4）。若点头，形状定为：
  插件＝一组 RegistryEntry + 一个传输；MCP server 以 stdio 登记，工具**只暴露为 check 类与节点装备**（只读/受限动作），
  不暴露为可改图、可批门者；「新增 MCP」表单＝名称 + 启动命令（**用可执行文件实探下拉，`/api/fs/browse` 已在**）→
  探一次 → 回执「探到工具 5 个 · 只读 4」→ 勾选暴露给哪些角色。门控于 T1（无 driver 契约就谈工具桥＝对着空形状写码）。

### P3 角色=对注册内容的选择配置（W 系，承 v13-W1..W4）

- **W5 全站手填面清点**（v0.1 只写角色卡，漏了四处现役手填）：
  | 现役控件 | 现状态 | v14 |
  |---|---|---|
  | 角色装备槽 | 已是勾选清单（`f426195`） | 引用改 `{kind,id}`，悬挂在**保存时**拒（R2） |
  | `PropertyPanel` 目标模板名 | 自由文本 + 插值 placeholder | 下拉，数据源 graphs 表 |
  | `PropertyPanel` 独立工作目录（两枚 cwd 框） | 手填路径 | 目录浏览（`ProjectProfileEditor` 已有该通道）＋一句保留理由 |
  | `PropertyPanel` pipeline params | `key=值` textarea | 表单行＋增删，插值仍是文本但字段有名 |
  | `SettingsView` EquipPicker「登记清单里没有这篇？手填一条」 | 展开即手填路径 | 换成「去注册中心新增」跳转（登记表单承接） |
- **W6 roleSha 换口径**：由「角色+路径集」改为「角色+条目 id 集合」，`scope` 仍不入指纹（`harness.ts:190-191` 那半条判据不动）。
  **破坏性如实入账**：v13-W2 起的 roleSha 与新值不可比，落 `roleShaV: 2`，旧行不重算（先例 v13-V3「新行起生效」）。
  需 §七 Q3 点头——这是改判，不自行放行。

### P4 环境一键注册（E 系，用户点名）

- **E1 发现器（纯只读）**：给目录 → 探 git 仓/远端 URL、AGENTS.md/CLAUDE.md、skills 目录、规则候选、包管理器与测试命令候选、
  `.github/workflows`、已有 worktree → 产**草案注册集**，每项带依据（发现自哪个文件）。
  可感面：`paneflow env probe ~/code/my-repo` → 「发现：git 仓 origin=my-org/my-repo · 约定文档 AGENTS.md · 技能 3 篇 ·
  机检候选 `pnpm test` · 本机可用 agent：pi, opencode」；`--json` 直取草案。
- **E2 一次事务登记**：草案过人一遍（勾选/改名/删项）→ 一次事务写表，失败整体回滚（不留半套环境）。
  可感面：`paneflow env add ~/code/my-repo --space my-proj` → 「已登记 7 项 · 项目 my-proj」；UI 向导四步
  （选目录 → 看发现 → 勾选 → 登记回执）。**诚实边界写进文案**：E2 **不装任何软件**，只登记「本机/本仓确实有这些东西」；
  装 herdr/agent 仍走 `EnvWizard.tsx`——那是「本机可跑」，这是「项目登记」，互补不合并、不改名。

### P5 体验与收口（X 系）

- **X1 注册中心视图（迁移不许弄丢现役家产）**：逐条对照，明写「搬移后控件的对应位置」——
  网关卡的「保存并测试」/key 掩码/`gh` 与 switcher 一键导入/切档、角色库的「● 未保存」脏态标与 ghost 引用警示，
  **一个都不许在迁移中消失**；详情抽屉的 spec 只读；引用者清单；探一次。
  与 v12/v13「零新视图」纪律的冲突**明写为改判**（用户本轮指令是「重新思考整体框架**和体验**」）→ §七 Q5。
- **X2 CLI 与发行的真实账**（v0.1「launcher 窄判据天然接住」说反了，撤回）：新子命令必须动三处——
  `packages/cli/src/main.ts:13 CLI_SUBCOMMANDS`（不加就是未知命令退 1）、`:21 VALUE_FLAGS`（补 `kind/from/only/skip/template/timeout`）、
  USAGE 文案；`--json` 全系可用（「stdout 干净可 \| jq」家规）；launcher 窄判据只需保证别把它路由去起 server。
- **X3 实机首驾**：一个真实项目 E1→E2→T3 起单→`status` 见「能力: … · cap#=…」一行，全程零手填路径。
  **没有这条，v14 全部是形状重构**（且它是 §二 M0 样张之后的第二道实证，不是唯一道）。

## 四、红线与不变式（v0.2 补第七条）

注册的是**清单与配置**，不是**判定、闸门与账本**。七项不许注册、不许插拔、不许插件/driver 触达：

1. 审批门语义：人必须批；插件/driver/agent 无一能 approve 自己的单。
2. run/node 状态机与终态分级（含 `completed-with-failures` 不洗绿）。
3. 账本落盘与读端语义：原子写、宁缺毋假（缺=不知道，0/[] 是正读数）、事实结构化落册不靠环形 events 推导。
4. 并发闸/队列/仓库软锁/尝试边界掐断。
5. 交付基点 fail-closed（本地 refs → origin → 拒建，绝不静默从 HEAD 拉）。
6. 判据住 server、CLI 零判据（R4）——注册台自身也守。
7. **【v0.2 新增】账本唯一写端＝引擎收口**：`RunRecord`/`NodeRunRecord` 只能由引擎写，字段由 shared 类型锁死；
   driver/probe/plugin **只返回读数**。理由带账：引擎收口写的远多于 v0.1 列的四项——`buildRunHarness`（`engine.ts:808`、
   `:2848-2869`）、`noteContextInjection`（:3182-3233）、`capturePrUrl`/`recordIssueSideEffect`（:2360-2396）、
   产物抽取（:3589-3637，喂 `http.ts:1797-1846` 的 `unverified`）、`costLive`、门释放时的 attention 结算、
   v13-S4 `externalReleases`——一个能写账的插件会把上述 1–6 全部变成不可信账。

## 五、明确不做（含被对抗路判死的）

- 搬 `graphs/` 或任何既有数据目录（R3 判死改判：先只读聚合）；删内置 seed（断 C4 恢复路径）。
- 统一 spec 类型（R1 判死改判：只统一信封，判别联合与编译期双向锁留在 shared）。
- 活注册行 sha 当等臂判据（R5 判死改判：解析时快照）。
- 插件沙箱与能力强制（v13-W3 已裁）；durable execution（撞 v12:120）；远程 marketplace；
  npm 动态 import 第三方 driver；模板可视化编程（扩的是可注册动作，不是图灵完备度）；多机分布式 registry。
- 把状态机、门、账本做成注册项（见红线）。

## 六、多 workflow 规划（含 file:line 认领，防两条切片同改一处）

**令牌轴**（同刻一个 workflow 持有）：`orchestrate/engine.ts` · `shared/src/dag.ts` · `api/http.ts`（已 2076 行/约 70 路由，
是最挤的一根轴）。每片开工前在状态表登记认领文件+区段，改 `validateDag` 与收口序列的片互斥。

| WF | 切片（顺序即依赖） | 认领文件（区段） | 门控 |
|---|---|---|---|
| **A 内核** | A1 信封+Descriptor+四动词(R1) → A2 引用索引+写端拒删(R2) → A3-x 只读聚合逐 kind（template→agent-kind→check-type→channel→model→role/gateway 视图） → A4 probe 单通道(R4) → A5 快照账(R5) | `shared/dag.ts`（类型）、`orchestrate/registry.ts`（新）、`api/http.ts`（新路由段） | M0＝A1+A2+A3 前三片+A5 草案；**A3 任何一片之前**须有 `registry/schema.json` 版本戳（R7 债） |
| **B 编排** | B1 节点类型清单+driver 契约(T1) → B2 `graph.requires`+预检命令(T3) → B3 新增流程一律模板化（旧流程按 T2 判决全部留引擎） → B4 MCP 桥(T4) | `shared/dag.ts:917-1041`（B2）、`engine.ts` 节点分派段（B1/B3） | **B4 门控于 B1**；B3 门控于 C4 分母结清（引擎行为改一点，A/B 语料换一版） |
| **C 岗位** | C1 手填面清点+装备选择器(W5) → C2 `roleShaV:2`(W6) | `web/src/components/PropertyPanel.tsx`、`SettingsView.tsx`（与 B 不相交）；C2 吃 `harness.ts` | **C2 门控于 §七 Q3 点头** |
| **D 环境** | D1 发现器(E1，纯只读新文件) → D2 一次事务登记+向导(E2) | `orchestrate/envprobe.ts`（新）、`web/src/components/ProjectsView.tsx` | D2 的 UI 门控于 D1 读数可用（CLI 先行） |
| **E 收口** | E1 注册中心视图全量(X1) → E2 文档/AGENTS/发行(X2) → E3 实机首驾(X3) | `api/http.ts` 读端段 | 尾随；E2 必先还 K1 的账（§八） |

切片纪律（v0.2 加严，源自 K1 实锤）：一片＝一个可提交单位＝`pnpm typecheck` + 相关 vitest 全绿 + 该片可感面在干净 shell
真跑过 + **端到端可达**（server 字段 → API → CLI/UI 渲染）；**单测禁止用 stub 自造 payload 变绿**——v0.1 期的 K1 CLI 产物行
就是这么绿的（`grep products packages/server/src` 零命中，而 `AGENTS.md` 已把 `sha/bytes/shelved/src=shelf` 写成既有 API：
文档先于代码）。此条入家规候选，先入本文件。

## 七、裁决问题（要用户点头，不代答）

1. **既有 dataDir 文件走「只读聚合」还是「搬数据」？** 推荐：只读聚合先行（R3 已按此改判），搬数据前置版本戳 + dry-run + 快照回滚。
2. **agent kind 两枚白名单合一**是不是可以立刻单独做（不需要 registry）？这是现状账里唯一「硬重复」，一片可结，建议插到 M0 之前。
3. **`roleSha` 换口径允不允许破历史可比**（W6/`roleShaV: 2`）？这是改判，按 v13:72 先例须点头。
4. **MCP/插件要不要进 v14**？v13:285 明写「不自实现 MCP 客户端」、v13:154 `.mcp.json` 是门控位——进＝明示改判。
5. **X1「新视图」与 v12:118-121、v13:25「零新视图」纪律冲突**：v14 按用户本轮指令（框架**和体验**）改判？推荐：是，
   但只允许**一个**新视图（注册中心），其余全并入既有页面。
6. **红线七条逐条确认**，尤其「基点 fail-closed 留引擎」「declares 不做强制」「driver 不得写账」。
7. **v13 尾巴处置**（K1 是 v14 的硬前置，非可选项，见 §八）：先收 K1 再开 v14 任何切片；K2（打回回路，门控在 v13 裁决问题 9
   的回边语义，该问题至今无用户裁决）**移入 v14 B 系**（回边＝编排语义，与 T1/T3 同域）。
8. **「用多workflow规划好」的两种读法**：v0.2 §六 给的是施工 workflow（含依赖与令牌轴）；若指的是业务侧多流程编排规划，
   则补一节「v14 出厂模板集：≥N 条业务流全部只由 注册项 + 模板 组成、不新增 TS」。请点名要哪个（或都要）。

## 八、与 v13 的接续（账面清点，v0.2 加硬前置）

- 已完成：v13 的 S/V/E/W/B 系 21 片，最后一笔 `afb8d4e`；16 笔未推 origin/main（推需明示）。
- **在飞＝硬前置（v0.2 判死「先叠 v14」）**：K1 产物台账。工作区状态实测：`shared/dag.ts` 已声明 `ProductDecl`/`RunProduct`、
  `cli/main.ts:334-341` 已渲染 `产物:` 行、`AGENTS.md` 已把产物架键写成既有 API，而
  **`grep products packages/server/src`（生产码）零命中**，`/api/runs/<id>/artifacts` 实返
  `{name,size,mtime,nodeId,nodeLabel,nodeState,unverified}`（`http.ts:1797-1846`）——sha/bytes/shelved/source 皆无。
  收口动作：①server 侧读取/算 sha/上架 + 端点补键，或②先把 CLI 渲染与 AGENTS.md 那几行退回（不留文档先于代码的账）；
  CLI 那条单测改成吃 server 真实响应形状或补 server 侧测试（禁 stub 自造 payload）。**这一步不做完，v14 任何切片不开。**
- 未开工：v14 全部（本文＝立项草案）。v13-Z 收口（全量复验 + 状态表 + AGENTS.md + 记忆 + 一次去临时 env 的重启仪式）照办。
- 基线读数：本会话实跑 server 684/684、engine.test 220/220、CLI 27/27、delivery 23/23；对抗路静态复算 675–682（差值为
  `it.each` 与三处 for 循环展开），以实跑为准。

## 九、对账（三路对抗 41 条发现 · 逐条处置）

| 发现 | 证据 | 处置 |
|---|---|---|
| 密钥会进 spec/sha/回显 | `gateway.ts:61-64` 明文注释 + :99-110 剥 key | **采纳**：红线入 R1 ②（密钥禁入 spec，只存引用与读数） |
| 统一 blob 拆掉类型纪律 | `dag.ts:119 _checkSpecTypesCovered` 编译期双向锁 | **采纳并改判**：只统一信封；判别联合留 shared（§五 入「明确不做」） |
| 四种写入形状互相打架 + id 无稳定性守卫 | `http.ts:296-344` 整替换 / `channels.ts:105-107` 非原子写 / `gateway.ts:113` upsert / `http.ts:900` merge | **采纳**：逐 kind 保语义 + id 不可变 + diff 基线定义（R1/R2） |
| 中间态更便宜；唯一硬重复是两枚 kind 白名单 | `env-check.ts:6` + `http.ts:81` | **采纳**：R3 改判只读聚合；白名单合一插为 M0 前置片（§七 Q2） |
| 搬 graphs 断云同步 + 删 seed 断 C4 恢复 | `github-sync.ts:74,106` / `builtin-templates.ts:556-569` + `c4-night1.sh:88` | **采纳判死**：R3 不搬数据、seed 原位（§五） |
| boot 迁移 + `.bak` 在无版本戳 dataDir＝假绿 | `config.ts:123` 开发/发布共用；全仓无 schema 戳；v13 R7 未认领 | **采纳**：版本戳为硬前置；`.bak` 方案删 |
| 在途 run 跨切面没人负责 | `engine.ts:335-370` 构造期改判；`store.ts:130-174 scanCorruptRuns` 返 null | **采纳**：在途 run 不回填；须 gate0 式实机夜跑证据 |
| 活行 sha 摧毁等臂可证性 | `harness.ts:186-190`「同装备同指纹不被编辑噪声打破」 | **采纳判死**：R5 改解析时快照 + `registrySnapshotSha` 列 |
| T2 五行判四行错（写账/时序依赖） | `engine.ts:2340,2461-2535,775,1488,1510` | **采纳判死 + 部分反驳**：旧流程全部留引擎；后半句改判为「**新增**皆由模板编排」（不假装近路） |
| 漏第七红线（账本唯一写端） | `engine.ts:808,2360-2396,3182-3233,3589-3637` 等 | **采纳**：红线 7 新增，带账 |
| 范围一刀切建议（只留 R1/R2/T3/R5 降级） | — | **部分采纳**：M0 采其范围；**驳回「砍 X/W 全部」**——用户指令是「框架**和体验**」，体验半壁不可砍，改为「随片可见面」 |
| v12/v13「零新视图」冲突 + K1 未收口就叠 16 片 | v12:118-121、v13:25；`grep products server`=0 + CLI 单测靠 stub | **采纳 K1 硬前置**（§八）；**改判入册** 零新视图（§七 Q5，只准一个新视图） |
| 探针须复用既有缓存/三态；超时≠gone | `env-check.ts:27-101,103`；`herdr-ops.ts:120-128` | **采纳**：R4 写明 |
| 「模型」被 slogan 点名却无注册面 | `gateway.ts` 只有 `freeModel` + catalog 探针 | **采纳**：kind 清单加 `model`，M0 片（登记为常用模型→角色/节点下拉可选） |
| `--from ./x.json` 把手填 JSON 降级重开 | 对照 `f93df09` 的表单+回执标准 | **采纳**：R1 主路改表单，`--from` 标 agent 专用，spec 只读 |
| 体验全押 WF E，A3 后屏幕无变化 | — | **采纳**：「A3-x 随片可见面」+ 首日前后对比 + M0 样张 |
| X1 会弄丢 GatewayCard/RolesEditor 家产 | 保存并测试 / key 掩码 / gh+switcher 导入 / 切档 / ● 未保存 / ghost 警示 | **采纳**：X1 逐条对照表，控件不许消失 |
| 全站手填残留只写了角色卡 | `PropertyPanel` 模板名/两枚 cwd/pipeline params；`SettingsView` EquipPicker 手填口 | **采纳**：W5 改「全站手填面清点」表 |
| 插件/MCP/模板作者面各一行撑不住点名要求 | — | **部分采纳**：T4 补表单流程但降级为待裁决（§七 Q4）；模板作者可见面并入 B1 的 Palette 证据 |
| 术语没做「用户不须学」的翻译层 | `reg#`/`kind`/`spec`/`RegistryEntry`/`roleShaV`/`source` | **采纳**：术语对照（界面文案：能力·能力类型·健康检查·配置详情(只读)·内置/手动登记/自动发现·能力#；机器键永不进界面） |
| X2「窄判据天然接住」说反了 | `main.ts:13 CLI_SUBCOMMANDS`、`:21 VALUE_FLAGS` | **采纳撤回**：X2 改为「三处必动」清单（本轮自查复核过） |
| T3 缺无人值守预检 | 退出码表 0/1 兼容但未撞不知 | **采纳**：`registry check --template --space [--json]` |
| 三条令牌轴配 16 片＝必然顺序耦合 | `http.ts` 2076 行 | **采纳**：§六 加认领文件与互斥 |
| 事实账四处不实（16 落点 / herdr.sock / legacy / 兜空） | `engine.ts:330`、`config.ts:89-94`、`store.ts:252-253`、`engine.ts:2648-2653` | **采纳**：§一 全部改写，重测为 15 枚并分 legacy |
| 「全仓 grep 0」范围越界 | `docs/iteration-v13:285`、`vite.config.ts:2`、`channels.ts:7` | **采纳**：范围收窄到 `packages/*/src`，并**主动引用**「通道插件」这条自打脸证据 |
| `validateDelivery` :49→:53；upsert :122→:113 | — | **采纳**：行号全改 |
| 基线数不可静态复现 | 静态 ≈675-682 vs 实跑 684 | **采纳**：标双口径，以实跑为准（§八） |

**41 条处置分布，如实入账**：采纳 27 · 采纳并改判（原判死、给新形状）4 · 部分采纳（含驳回其一刀切建议的两处）3 ·
改判入册待点头 3 · 撤回并自纠 1（X2）。**推翻 v0.1 设计的是 4 条，全部采纳**——与 v13 那轮「18/18 全被修正、0 被推翻」
相比，本轮对抗质量更高，因为确有 4 处被推到重写。

## 十、实施状态表（v14 开工前全空；K1 未收口则 A 系不开）

| 片 | 名称 | 状态 | 提交 | 可感面已实跑 |
|---|---|---|---|---|
| 前置-0 | K1 收口（server 落地或退文档；单测去 stub 假 payload） | 阻塞中 | — | — |
| 前置-1 | agent-kind 两枚白名单合一 | 未开工 | — | — |
| R1 | 统一信封 + Descriptor + 四动词（表单主路） | 未开工 | — | — |
| R2 | 引用索引 + 写端拒悬挂/拒删被引用 | 未开工 | — | — |
| R3 | 只读聚合视图（逐 kind 亮分组；不搬数据） | 未开工 | — | — |
| R4 | 探测单通道（复用缓存与三态） | 未开工 | — | — |
| R5 | 能力快照账（capabilityRefs + specSha + cap#） | 未开工 | — | — |
| T1 | 节点类型清单 + driver 只读数契约 | 未开工 | — | — |
| T2 | 旧流程留引擎（判决表已改判） | 判决完成 | — | — |
| T3 | `graph.requires` + `registry check` 预检 | 未开工 | — | — |
| T4 | 插件 / MCP 承载 | 待裁决 §七 Q4 | — | — |
| W5 | 全站手填面清点 | 未开工 | — | — |
| W6 | `roleShaV: 2` | 待裁决 §七 Q3 | — | — |
| E1 | 环境发现器（只读） | 未开工 | — | — |
| E2 | 一次事务登记 + 向导四步 | 未开工·门控 | — | — |
| X1 | 注册中心视图（现役控件对照） | 待裁决 §七 Q5 | — | — |
| X2 | CLI 三处必动 + AGENTS/README + 发行 v0.3.0 | 未开工 | — | — |
| X3 | 实机首驾（零手填路径全程） | 未开工 | — | — |
