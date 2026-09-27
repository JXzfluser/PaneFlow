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
| agent kind | ~~两枚 TS 常量~~ **前置-1 已合一**：`api/agent-kinds.ts` 一表两读（清单 `AGENT_KINDS` + 探测名 `AGENT_BINARIES`）；改代码仍只此一处，A3-2 接进注册台后连这处也不欠 | **改代码 ×1** | 节点侧只过正则（`dag.ts:914,1003`）；请求侧 `isAgentKind` | — | `node.config.agentKind` |
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
- **R3 兑现读数（A3-2 第一片：`agent-kind` 进表）与三条改判**：
  1. **改判（顺序）**：原计划 A3-1 先迁 `template`，实施改为 **A3-2 先迁 `agent-kind`**。为什么：`template` 进表在屏幕上
     什么都不是（模板卡已经在了），而 `agent-kind` 一进，三处现役缺口同时闭合——R4 那枚 parked 样张 `registry probe agent-kind:pi`
     跑得到、T3 的 `{kind:'agent-kind'}` 槽从「判不了」变成「判死活」、R5 能力面第一次吃到第二枚 kind。欠账要挑能一并还清的那种。
  2. **形状（视图 kind，新台类）**：`agent-kind` 的成员住在代码那张出厂清单（`api/agent-kinds.ts`，前置-1 合一的产物），
     **不落盘**——搬进盘＝同一件事两处存，而真正决定「能不能起这个 agent」的是代码那片。于是加一层
     `REGISTRY_VIEW_KINDS`/`isRegistryViewKind`：`load()` 保持**盘上纯读**（三个写动词只吃它），`readView()` 才是所有读面
     （HTTP×5、引擎预检、R5 快照、R2 引用账）吃的那一枚合并视图。三条推论各有断言：
     写入面三动词对视图 kind 全拒（不拒＝用户造的假 kind 被读端当成可用能力）；手塞进 `entries.json` 的那条**读端不吃**、
     整条挪进 `rejected` 说清为什么不生效（静默吞掉就是查三天的那类账），且 DELETE 仍清得掉（不然一条不生效的残记录永远删不掉）；
     时刻不能造假——视图项带的是**进程启动时刻**（含义=本机这次运行从何时开始看见它），文案与 CLI 都按 `view` 标分家，不写「登记于」。
     读面渲染同理：出厂行的「启用」格画 `—` + 一句「出厂清单没有启停这一格：本机探到货就能用」，不是留白——留白读成「控件坏了」，`—` 读成「这一格不适用」。
  3. **改判（单一词表）**：kind→中文组名 原先两处（server `KIND_CN` 与 web `KIND_GROUP_LABELS`，措辞已实际分叉：
     `agent-kind` 一处「代理」一处「Agent 引擎」）。现收在 server `registry-check.ts` 一处，并由 `GET /api/registry`
     外发 `kindLabels` 供网页与 CLI 渲染。**判据零参与**（改标签不会让预检变绿变红），但分叉的代价是「同一枚 kind 两个名字」，
     而没人会去比对两张措辞表——所以 web 那份删掉、回落语义改成显式「未知类型」，让「server 没给」看得见。
  4. **翻转代价入账**：`{kind:'agent-kind'}` 槽从前一律放行，现在指不到就是死缺、起单被拒。调用方**必须喂 `readView()`**——
     只喂 `load()` 会把整类 agent 读成死缺，那是假红不是 fail-closed（引擎与路由两侧都已换，断言在 `registry-check.test.ts` 的专格里）。
- **R4 探测单通道**：一个 probe 调度（缓存 / 超时 / 强刷一份实现），复用既有件：`env-check.ts:27-101` 60s 缓存 +
  `:103 clearAgentProbeCache` 失效钩子、`herdr-ops.ts:120-128 probeAgent` 三态。
  **超时＝未知，绝不并入 `gone`**（探针通道自己造假缺就是造第二个 684 绿假账）。
  可感面（立项原文）：`paneflow registry probe agent-kind:pi` → `ok · /opt/homebrew/bin/pi`；
  `paneflow registry probe model:gpt-x --timeout 10s` → `未知 · 探测超时 10s（未探得，不等于不可用）`。
  **实跑到的可感面（1323bf5 + 本片，两条改判都记在这里，不留原文措辞冒充已交付）**：
  - `paneflow registry probe <id> [--refresh]` → `● model:u1appnuf  glmcn/glm-4.7 · 档=default · 免费位 … 被 1 处用  ·· 在「默认档」的实探清单里（528 枚中第 512 枚 · 它正挂在免费位）` + 一行 `读数时刻 …（缓存）`；
    落点 `GET /api/registry/:id/health`（与批量面 `/api/registry/health`、`/api/gateway/catalog` **同一份缓存**，
    `registry-health.test.ts` 用命中计数器证：换消费者/换粒度零重探，`?refresh=1` 才 +1）。
  - 改判一：**输出用 `●/○/?` 三枚点，不是原文的 `ok ·`**——批量面（首屏那张表）先落了三态画法，
    单枚面再自创一套「ok/not」就是同一读数两个口径（§一「一份判据」）。三态各画各的、未知绝不并入「不在」。
  - 改判二：**`--timeout` 不做**。原文那句 `探测超时 10s` 想证的性质（超时＝未知）已经由共享通道保证：
    `probeGatewayModels` 自带 6s AbortSignal，掐表一律落 `error`→`unknown`（不是空清单→`missing`）。
    给人一根可调秒针=在探针通道上再开一个入口，且改的是**别人**那一档的耗时预算，不是这条命令的判据。
    于是 `paneflow registry probe agent-kind:pi` 那枚样张**曾在 A3-2 挂着**：当时 `REGISTRY_KINDS` 只有 `model`
    （`shared/registry.ts:44`），表里没有 agent-kind 条目可探——那是 kind 进表的波次问题，不是探针缺件。
    **A3-2 已还清**：`agent-kind` 走视图 kind 进表（见上面 R3 兑现读数），`registry-health.ts` 补上 agent 通道
    （直接抄 `probeBinaryPresence` 的三态：超时/sh 起不来/PATH 读不到一律 `unknown`，只有本机明确答「PATH 里没这个可执行文件」
    才是 `missing`）。同一改动把 A3-2 之前的旧病一并修了：`probeBinary` 那一路把「sh 三秒没答话」和「command -v 说没有」
    都收成 `false`——对首屏 `agentsInstalled` 无所谓（少列一枚＝与今天一字不差），但健康点照那个口径画就是把**「未探得」画成「没装」**。
- **R5 逐单能力快照账（v0.1 `regSha=活行内容指纹` 判死，重设计）**：run 记录存
  `capabilityRefs: [{kind, id, specSha, spec}]`——解析现场**快照整份 spec 副本**，`specSha=contentSha(规范化 spec)`，
  用 `harness.ts:16-33` 现成 canonical 内容指纹；比对与分组用**整单不可变集**的指纹，不引用活行。
  于是「一次编辑改了历史 run 的读数」（v0.1 的病）不存在，「删了条目历史就查不到」也不存在（快照自带原文）。
  等臂第四枚仍成立，但判据换成：**同 id 集合 ∧ 快照指纹相等＝两臂能力面相同**；跨臂的注册表变更靠「语料表新增
  `registrySnapshotSha` 列」暴露，而不是指望活行不变。
  可感面：`paneflow status <runId>` 多一行 `  能力: 7 项（技能 2 · 机检 3 · agent 2）· cap#=8f21c0`；没走注册消费面=整行不显。
- **R5 兑现读数与三条改判（本片实跑口径，不静默偏离）**：
  1. **落点**：`RunRecord.capabilityRefs / capabilitySha`（`shared/dag.ts`）由**引擎起单现场**写入（`engine.ts` 的
     harness 固化旁同一处，各自带防御 try）——注册表读不出/一条已迁能力没吃到 → **两键整缺**（`capabilitySnapshot`
     返回 `null` 而非 `[]`）；`GET /api/runs/:id` 直呈（`...run`），CLI 只渲染。取材面＝出场 graph × 本单空间档案 ×
     **本单实绑角色** × **本单生效网关档**，四支抽取器与 R2 反向扫描**共用同一支**（`refsFromSpace/Role/Graph/GatewayDoc`
     + `matchesTarget`）——两份匹配口径迟早对不上，那就是第二份判据。
  2. **改判（可感面词面）**：分组标签用注册表 **kind 原样**（今天是 `model 1`），不是 doc 样张里的「技能/机检/agent」中文词。
     为什么：中文标签住在 server 的 `Descriptor.label`，CLI 若要显示就得自带一张 kind→中文 表＝第二份事实源（违 R4）。
     样张那三组要等 A3-x 把 `skill`/`check-type`/`agent-kind` 迁进表才可能出现——**波次欠账，不是本片少写**。
     **A3-2 后的现状**：那把锁由 `GET /api/registry` 的 `kindLabels` 外发解掉（网页分组与 CLI 组名同吃那一处词表），
     但 `paneflow status` 的 `能力:` 行仍画 kind 原样——它读的是 `GET /api/runs/:id`，那条负载里没有 `kindLabels`，
     为一行文案去给 run 负载塞措辞表是走错门（判据面与文案面分家）。**明写为欠账**，随 A3 后续片一并定夺。
  3. **改判（收数表列名）**：doc 写 `registrySnapshotSha` 列，落成表内 `能力# = cap#<8位指纹>` 一列，
     `EXPERIMENT_TABLE_VERSION` 3→**4**（append-only：历史行不回填，边界随口径戳声明）。这一列就是跨臂注册表变更的暴露位。
  4. **改判（停用条目）**：`enabled: false` 的条目**不进快照**。停用是注册表里唯一表达「不再现役」的键，
     算进能力面会让「一臂启用/一臂停用」的 cap# 相等，第四枚等臂判据就此漏掉一次真实变更——宁可少记一条，不可漏报一次。
  5. `cap#` **不含 `via`**（引用出处不是能力面差异），逐条 `specSha` 与整单 `cap#` 都用 `harness.ts` 现成 `contentSha`
     （键序无关，与 `graphSha` 同尺）；等臂第四枚＝**同 id 集合 ∧ 逐条 specSha 相等 ⇔ cap# 相等**。

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
- **T3 模板带槽 `graph.requires` + 起单前预检**（已落地 `e5dc0b6` + 本轮实机首驾两处补修）：模板顶层声明 `requires:[{kind, id?, hint?}]`，纯校验增量
  （`dag.ts:917-1041` 那套），起单前对着注册表解析、缺项 fail-closed 即时红一句指路——今天的缺口是**静默少注入**
  （`unknownSkills` 只披露，模板作者要等节点行为异常才发现装备没上身）。
  可感面（逐条实跑过，命令与退出码按现状）：
  ```bash
  paneflow registry check --template x --space demo   # 0=槽全命中；1=有缺口（逐槽 ✓命中 / ✗缺口 / ?不认，缺口带 server 写好的 why）
  paneflow registry check                             # 不给 --template = 全模板普查，只列不拦，恒退 0（无人值守的闸是单模板问法）
  paneflow registry check --template x --json         # 直吐那一行：{template,slots[],need[],missing[],unjudged[],malformed[],ok}——机检要的 missing:[{kind,id,hint,…}] 就在这层
  ```
  模板卡上显示「需要：模型 1 · 技能 2」+ ✓/✗/?（`requirementBadge`，**先于派活可见**，这是 T3 的可感面；预检读数拿不到时显「需要 N 项 · 预检没读出」而不是画 ✓）。
  **一条撤回的自报 bug**（写文档自查时误报，落测试当场被证伪，记在这里是因为「以为自己修了个真 bug」是假账最常见来源）：
  我判断「未迁 kind 的**没点名**宽槽（`{kind:'skill', hint:'要能读图'}`）会落 `missing` → 误拒起单」，
  并照这个判断改了判据、写了文案。测试第一条就把这版改判打死：`checkGraphRequirements` 在**进匹配之前**
  就有 `if (!isJudged(slot.kind)) → unjudged; continue`（`registry-check.ts:141-148`），点名与宽槽同一路，
  我新加的那支是**走不到的死码**，`missing` 从来只可能出现在「已迁 kind 且账上没货」。改动整体撤回、零残留
  （`git diff` 净）。真缺口仍是真缺口：已迁 kind 而表里空 → `missing` → 拒单，这条原有测试压着。
  **四条实施改判**（都不是设计时想出来的，是撞出来的）：
  | v0.2 原文 | 实际落地与理由 |
  |---|---|
  | `paneflow dispatch "…" --template x` 缺项当场退 1 | **dispatch 没有 `--template`**——它走 Planner 现制图，不是模板起单，往它身上挂模板标是凭空造接口。fail-closed 设在 `startRun`，于是 `dispatch`/批量派发/replay/pipeline 子单一律被覆盖（比原方案的单入口更宽）。无人值守的可编程判据因此是 `registry check --template` 的退出码：**先查后派两拍**，不是一拍 |
  | 「按当前项目解析」 | **本版 `--space` 不参与命中判定**：`REGISTRY_KINDS` 只迁了 `model`，注册表还是全局一张，拿空间去解析是假装读档案。空间如实回显（`space` + 一句 `spaceNote` 交代本轮解析与空间无关），判据不掺水 |
  | 模板卡可编辑「需要」 | **本版没有 `requires` 的作者态 UI**（归 W5 全站手填面清点那一片承接）。但声明一旦写进模板文件，打开→保存→自动保存→再打开 全链路零丢失（`graph-serialization` 有回归测试压着——R1 的老事故形状：画布画不出来的字段，一回写就被抹平） |
  | 预检结果落 run 事件行 | **不落**：`startRun` 直接抛，那句人话已经经 `error` 到 `status`/`watch`（退出码 1）。再补一条事件行是同一笔账记两遍 |
  **两处实机首驾撞形**（读代码读不出来，只有真敲才露）：
  - `POST /api/graphs` 收一具没有 `metadata` 的 graph → **500 `Cannot set properties of undefined (setting 'updatedAt')`**。
    metadata 是服务器自己记账的地方，不该由客户端进贡：现在缺则补两枚时间戳、显式带 `createdAt` 则保旧值，
    形状不合法（名字脏/无 body）改口 **400 一句指路**（`store.ts saveGraph` + `http.ts saveGraphReply`，两层各一枚回归测试）。
  - `requires` 起初**不进反向引用账** → R2 的全部承诺（「拒删被引用」）对一个只被模板声明点名的条目是漏的；
    现场就演示出那次「本该拒、结果删掉了」的删除。修法：`refsFromRequires` 单独一支，**只挂反向账**。
    这里有一枚形状区别值得留档：**声明面（模板写了要什么）与实发面（这一单真吃了什么）是两回事**——
    `refsFromGraph` 同时喂 R2 的盘上扫描和 R5 的 run 实发快照（`cap#`），把 `requires` 塞进去等于让「作者许愿」
    污染「这一单的装备读数」，故分家；没点名的宽槽（只有 `hint` 无 `id`）不建边，不拿模糊匹配凑数。
- **T4 插件与 MCP 承载**：v0.1 只给 58 字，本轮**降级为待裁决**（撞 v13:285 既有裁决，见 §七 Q4）。若点头，形状定为：
  插件＝一组 RegistryEntry + 一个传输；MCP server 以 stdio 登记，工具**只暴露为 check 类与节点装备**（只读/受限动作），
  不暴露为可改图、可批门者；「新增 MCP」表单＝名称 + 启动命令（**用可执行文件实探下拉，`/api/fs/browse` 已在**）→
  探一次 → 回执「探到工具 5 个 · 只读 4」→ 勾选暴露给哪些角色。门控于 T1（无 driver 契约就谈工具桥＝对着空形状写码）。
  > **落地实录（`ade742d`，与上面这段的差）**：点的那个头只到「登记账」这一层——上面那段里的「探一次 → 回执探到工具 5 个」
  > 需要真 MCP 握手才给得出，而那是 v13:285 判死的那条路，所以**没有做**：`mcp` 条目刻意不留探针通道（`health` 整键不给，
  > 界面上天然没有那个点），桥接与工具清单一起留给未来的显式改判。「勾选暴露给哪些角色」同理未做——那需要角色装备槽先指向
  > 注册项（W5′），不是 T4 一片能顺手带的。

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

> **2026-09-26 状态刷新**：用户令「按需求走」＝按本文件推荐取值推进。Q2 已单独结掉（前置-1，见 §十二）；
> Q1/Q5/Q7 按推荐落地（只读聚合先行、只准**一个**新视图=注册中心、K1 已收口故 A 系可开）；
> Q3（`roleShaV:2` 破历史可比）与 Q4（MCP/插件进 v14＝明示改判 v13:285）**仍不动**——
> 这两条各自要推翻一笔既有裁决或毁掉既有可比性，推荐值也不是免费的，等点名再改。
> Q6 七条红线随片确认（每片收尾时核自己踩没踩）；Q8 见 §六 施工 workflow 已按读法一执行，读法二（出厂模板集）另立批次。
>
> **2026-09-26 二次刷新（点名之后的三条落账）**：
> - **Q4 已点头并入 v14**（用户裁决「两件都做（加性）」）→ T4 以 `ade742d` 落地，形态是**加性**的：
>   MCP 只进注册表当「本机登记了哪台 server」的声明账，**不自实现客户端**（v13:285 那条一字未改——
>   登记 ≠ 连接；Bridge 是 v15 的事）。
> - **Q7 的 K2 已点头**（同一次裁决里把「继续全部处理」当作 v13 裁决问题 9 的点头）→ 以 `1098285` 落地，
>   回边语义按文档设计：`reject: true` 标记边吃同一把 `edgeActive` 尺、`attempt` 上限封顶、
>   `rejections` 复用 `abandonments` 那本账、打回理由注入重跑 prompt。
> - **Q3（`roleShaV: 2`）仍不点头，且当场判为「现在做不出诚实版本」**：`roleSha` 要指纹的是「岗位实解析出的装备条目」，
>   而 `skill`/`rule` 两枚 kind 至今不在注册表里（§一 现状账）——没有条目 id 可指，换口径只会把旧 run 的指纹
>   和新 run 的指纹摆成两串无法解释的数字。前置是 W5′（`{kind,id}` 装备槽），不是 W6 本身。

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

## 八、与 v13 的接续（账面清点，2026-09-26 更新：硬前置已还清）

- 已完成：v13 的 S/V/E/W/B/K 系 **22 片**，最后一笔 **K1 `a745c50`**（产物台账与硬引用）；未推 origin/main 见本仓 `git log origin/main..HEAD`（推需明示）。
- **前置-0 还清实录（原判据「server 落地或退文档」，处置=落地，不退文档）**：server 侧新增 `orchestrate/products.ts`
  （声明清洗/实读算 sha/上架/取用同一处判据）+ 引擎收口采集点 `collectNodeProducts` + 硬引用替换
  （`{{artifact:节点/名}}` 解析不到=本节点即时失败）；`/api/runs/:id/artifacts` 实返已含
  `source/sha/bytes/shelved`，`file?src=shelf` 走台账+指纹双闸，真删除一并清架。
  「禁 stub 自造 payload」一条的处置如实记：CLI 那条单测**仍按 `RunView` 最小结构读法手写**（这是 v11-A1 起每一片的既有
  约定，不是本片新造的假 payload），真正的形状约束改由 server 侧测试钉住——`http-artifacts.test.ts` 的台账条目一律标
  `RunProduct` 类型并**在架上手放同一串原文实算 sha**，端点返回形状若与 shared 类型分叉则编译期即红。
- v13-Z 收口（全量复验 + 状态表 + AGENTS.md + 记忆）已办；**唯一余项=一次去临时 env 的重启仪式**
  （撤 `PF_DIRTY_CHECK=0` / `PF_PROMPT_CONFIRM_MS=180000`，需队列空 + 用户令，属共享状态变更不代做）。
- 未开工：**v14 的 R/T/W/E/X 五系代码面已全部落地**（逐片见 §十二；唯一挂着的是 W6 `roleShaV:2`，判据是「现在做不出诚实版本」，
  前置=W5′ 装备槽指向注册项，见 §七 二次刷新）。此后欠的三类账不在 agent 能代做的范围里：
  ①M0 机证① 的 10 条 replay 等臂复验（要 run 预算）；③X3 实机首驾（真项目上手敲一遍）。
  ~~②X2 的版本 bump / tag / Release~~——**已办**：五枚 `package.json` 0.2.0→0.3.0、本地产物冒烟 17/17、`v0.3.0` 标签推送后由
  `release.yml` 自动发 GitHub Release（冒烟不过则不发）。装机侧回执（用户机 `install.sh` 升级后跑一次）仍在用户手里。
- 基线读数（2026-09-26 实跑）：server **721/721**（50 文件）、cli **43/43**、web **57/57**、`pnpm typecheck` 四包净
  + `tsc -b packages/web` 净。

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

## 十、A1（R1）落盘形状决议——写码前定死，防实施时自创

这一节是**开工令的附件**：A1 的每个开放点在下面都给了取值与理由，实施时不许再临场发明第二套；
若实测推翻其中某条，改这一节并留证据，别悄悄改码。

1. **表的位置与文件形状**：`<dataDir>/registry/entries.json` 单文件（**不做 per-kind 一文件**）。
   理由三条，都是硬的：id 全局唯一这道守卫不能跨文件核；R2 的反查要把全表一次读进内存扫 graphs/roles/spaces；
   条目量级是「几十」不是「几万」。写入走 v13-S5 现成的 `Store.atomicWriteSync`，不新造写盘路。
2. **版本戳（顺带还 R7 的债，且这是 A3 任何一片的硬前置）**：`<dataDir>/registry/schema.json` =
   `{version: 1, writtenBy: '<package version>'}`。读到 `version` **高于**代码内已知值 → **拒启**并一句指路
   （「这份 dataDir 由更新的 PaneFlow 写过，先升级再跑，别用旧二进制覆写」）。§九 那条「boot 迁移 + `.bak`
   在无版本戳 dataDir＝假绿」到此清偿；回滚单位=整目录快照，**永不**拿 `.bak` 改名当回滚。
3. **信封字段**（放 shared，键名即账名）：
   `RegistryEntry = { id, kind, name, source: 'builtin'|'user'|'discovered', enabled: boolean, createdAt, updatedAt, spec }`——
   `source` 三态语义定死：`builtin`=代码出厂、`user`=表单/CLI 登记、`discovered`=E1/E2 环境探得；
   `enabled:false` 是「留着但不再被选」，**不是删除**，被引用项 disable 只在运行面披露（R2 的写入面才拦）。
4. **spec 的类型纪律**：`RegistrySpecMap`（kind→spec 形状）逐 kind 追加，`RegistryKind = keyof RegistrySpecMap`。
   读取面遇到 map 里没有的 kind → **整条不认**（不猜形状、不渲成空卡），写入面 400。
   这样才守住 §五「不统一 spec」：统一的是信封，判别联合仍住在 shared，编译期双向锁（`dag.ts:119`）不许降级。
5. **Descriptor 与动词**：一 kind 一模块，`{kind, parse(spec)→一句人话|null, probe(entry)→读数|undefined, resolve(entry)}`。
   动词条数=四个写动词（`add`/`update`/`delete` + 纯读 `list`/`get`），`probe` 是**只读第五动词**（永不写盘，写盘=造第二份事实源）。
   A1 只落 **`model` 一枚 kind** 当形状样板（它今天确实没有家：只作为网关档的 `freeModel` 字段 + catalog 探针读数，
   见 §一 第 13 行），其余 kind 一律走 A3-x 逐片迁。
6. **id 与冲突**：`<kind>:<slug>`，slug 取自 name 的 ASCII 化结果；非 ASCII（中文名很常见）回落 `e<8位随机>`——
   **不把中文名当文件名**，那会把 id 变成 URL 编码地狱。`add` 撞已有 id → 400 一句（改=显式 `update`，id 不可变＝R1 边界③）。
7. **兼容带（A1 的零回归判据）**：本片**不动任何消费点**——表落了、动词通了，但 engine/角色/节点取值路径一字不改。
   机证=既有测试零改动零红（含 `evidence` 里那些 v13 断言）。换取值从 A3-x 才开始，逐 kind、每片各带一条「等臂不破」断言。
8. **A1 的可见面如实入账**：本片可见面=**API + CLI 只读面**（`GET /api/registry`、`paneflow registry list [--kind model] [--json]`）。
   「表单主路」在 X1（注册中心视图）兑现，不塞进 A1——A1+X1 合成一片会是 2000 行的提交，
   且 X1 的家产对照表（网关「保存并测试」/key 掩码/切档/角色「● 未保存」）需要独立一轮实机核对。这是对 §三 R1
   可感面的一句**分片勘误**，不是砍需求。

## 十一、E1 落盘形状决议（同上，写码前定死）

1. **E1 纯只读**：只产「草案」，不落 dataDir、不写注册表、不在被探目录留任何字节。登记是 E2 的事。
   落点：`packages/server/src/api/env-probe.ts`（判据层，读现场与下判断分开、可注入文件视图锁三态，
   样板 `env-check.ts:57 probeWin32Binary`）+ `POST /api/env/probe` 一条路由 + CLI `paneflow env probe`（零判据，三处必动）。
2. **「探测失败」是读数不是客户端错误**：路径不存在/不是目录/`git` 不可用 → **200** 带 `error` 一句人话与空 `items`；
   只有请求体形状脏（缺 `path`、非串）才 400。混错这两类会让无人值守脚本把「这台机器没装 git」当成「参数写错了」。
3. **每项发现必带 `evidence`**（发现自哪个相对路径文件）——没依据的发现不入草案，这是 E1 定义里那句「每项带依据」的硬版。
4. **不回显文件内容**：约定文档只报「存在 + 字节数」。远程暴露模式带令牌，内容回显＝新开一个信息泄露面，
   而 E1 的判据根本不需要内容。
5. **`missing` 是必填读端**：探不到的类目要有一句为什么（宁缺毋假——缺席要有解释，而不是画一条空项占位）。
6. **机检候选**由 lockfile 判包管理器（`pnpm`>`yarn`>`npm`）、由 `package.json` 的 `scripts.test`/`scripts.typecheck` 判命令；
   多套 lockfile 并存**另起一条披露项**（这是真读数，不是错误，也不静默择一）。非 node 项目拿不到 scripts → 进 `missing`，不硬造。
7. **本机可用 agent** 复用既有实探（`agent-kinds.ts` 清单 + `detectInstalledAgents` 的 60s 缓存），
   **E1 不另造一份清单**——前置-1 刚把两枚白名单合一，这里再抄一份就是当场破家规。
8. **规则候选设上限 20 篇**（只取仓根与 `docs/` 一层）：不设上限时一个大仓会把草案刷成垃圾，
   超过只报计数不逐项列——被探目录的规模不是我们的账，但把人的注意力刷没是。

## 十二、实施状态表（v14 开工前全空；K1 未收口则 A 系不开）

| 片 | 名称 | 状态 | 提交 | 可感面已实跑 |
|---|---|---|---|---|
| 前置-0 | K1 收口（server 落地或退文档；单测去 stub 假 payload） | **已完成 `a745c50`** | `a745c50` | CLI `产物:` 行 + 架侧 `src=shelf` 取证已复验（server 721 绿） |
| 前置-1 | agent-kind 两枚白名单合一 | **已完成** | `4d91ae8` | 无新增用户可见面（合一片）；机证=6 条判据（两表键集相等／唯一改名项 `antigravity-cli→antigravity`／清单外按原名探／`isAgentKind` 破烂拒）+ 真路由两条（`/api/health` 的 `agentKinds` 与 `PUT /api/spaces` 值域同源）；现网实测：合一前起的实例仍在跑，其 `agentKinds` 18 枚与新表**逐项相等**（兼容带）；server 全量 **727/727**（51 文件）· typecheck 净 |
| R1 | 统一信封 + Descriptor + 四动词（表单主路） | **已完成 `9b2a7ae`** | `9b2a7ae` | `paneflow registry list/get/refs/add`（`3de8ef4`）+ 网页表单（`10bc315`）现网实跑：`注册表 schema v1（由 0.2.0 写）· 这版认识：model`；版本戳「遇更高版本拒启」有真路由断言 |
| R2 | 引用索引 + 写端拒悬挂/拒删被引用 | **已完成 `b2f3d29`** | `b2f3d29` | `paneflow registry list` 尾行现网实跑：`引用账：扫过 116 处跨面裸串引用 · 指向已迁类型却查不到条目 0 处 · 指向未迁类型 115 处（未迁的不判死活）`；写端两条 400（拒删被引用/禁用被引用）带逐处出处 |
| R3 | 只读聚合视图（逐 kind 亮分组；不搬数据） | **已完成（A3-2 第一片：`agent-kind` 进表）** | 本片 | CLI 现网实跑 `paneflow registry list`：`这版认识：模型/Agent 引擎` + 组行 `· Agent 引擎（18 项）`（18 枚由出厂清单现算、**不落盘**）；网页 `pnpm build` 后实机看到 `Agent 引擎 18 项 内置清单` 分组、出厂行只剩「详情」（无启停/删除，启停格画 `—` 并注明「出厂清单没有启停这一格」），详情抽屉两枚时刻 `本机自/本次运行` 同源 + 说明「内置清单项由版本自带，没有登记时刻」。引用账随之从 `扫过 116 · 未迁 115` 变 `125 · 90`（`agent-kind` 迁入后这批裸串有了正身可指）。机证：`readView` 5 条（不落盘且条数=出厂清单长度／盘上手写影子行落 `rejected` 并指路 DELETE／三写动词全拒且**不建 `registry/` 目录**／模型组排在前的排序）+ 预检 4 条（探测名 `antigravity` **不是**引用写法）+ 快照 1 条 + 路由 `kindLabels` 1 条 + CLI 1 条 + web 5 条。**三条改判（顺序、视图 kind 形状、单一词表）与翻转代价见 §二 R3** |
| R4 | 探测单通道（复用缓存与三态） | **已完成 `1323bf5` + 单枚探针补齐 + agent 通道还清（A3-2）** | `1323bf5` | 批量：`paneflow registry health` 现网实跑（`实探 1 项：●1 ○0 ?0 · 悬挂 0 · 没人用 0`）；单枚：`paneflow registry probe model:u1appnuf` → `● … ·· 在「默认档」的实探清单里（528 枚中第 512 枚 · 它正挂在免费位）` + `读数时刻`。**同一份缓存=命中计数器机证**（list 0 探／health 1／再 health 1／catalog 1／`?refresh=1` 2）。两条改判（`●/○/?` 替 `ok ·`、`--timeout` 不做）见 §二 R4。**A3-2 还清 parked 样张**：`registry probe agent-kind:pi` → `● agent-kind:pi  探测名同 kind  出厂  被 4 处用  ·· 本机 PATH 上探到可执行文件「pi」，这一型可用`；批量面现在是 `实探 19 项：●7 ○12 ?0`，○ 的人话是「PATH 上逐个目录枚举完，没有「copilot」这个可执行文件：本机没装这一型」——**枚举完=正读数，不是「不知道」**（旧的 `probeBinary` 假 missing 病根见 §二 R4）。本地 PATH 通道与网关目录共用那份 60s 缓存（win32=PATH×PATHEXT，拿不到 PATH ⇒ `?`） |
| R5 | 能力快照账（capabilityRefs + specSha + cap#） | **已完成（本片）** | 本片 | 引擎起单现场落册两枚键 → `GET /api/runs/:id` 直呈 → `paneflow status` 渲一行 `能力: N 项（kind n）· cap#xxx`；收数表新增「能力#」列（表版本 3→4）。机证：单元 9 条（去重/cap# 键序无关/悬挂与未迁 kind 不进/null≠`[]`/副本不随活行变）+ 引擎集成 6 条（真注册表+真网关档落盘跑单：**编辑条目后历史 run 一字不动**、再起一单 cap# 随配置变、同配置两单 cap# 相等、停用→两键整缺、无登记→两键整缺、只吃本单生效那档）+ CLI 1 条（五种 payload 渲染）；`apiKey` 断言不进快照 |
| T1 | 节点类型清单 + driver 只读数契约 | **已完成 `4940f37`（补账 `a647b6a`）** | `4940f37` `a647b6a` | 六枚类型从两处事实源（Palette 硬编码 + `DAG_NODE_TYPES` 裸串数组）收成一张 `NODE_TYPE_CATALOG`（shared/dag.ts：形状+画法+分组+组内序），套信封成**视图 kind** `node-type`（不落盘、三写动词全拒，与 `agent-kind` 同条路）；画布左栏改读 `GET /api/registry?kind=node-type` 渲按钮，`web/node-types.ts` 把「读得出画法／读不出／被停用」三态分家——本 bundle 不认识的类型进 `unusable` 明说，绝不 cast 上画布。登记的是**形状与画法不是执行体**（红线七），执行仍住引擎分派段。机证：`node-types.test.ts` 6 条 + registry 视图 112 行新增断言 + `a647b6a` 的 `registry-routes` 路由断言（出厂六型上架、写法字段齐、写入面照拒——当时漏钉的一条：id 序把「结束」排在「开始」前面） |
| T2 | 旧流程留引擎（判决表已改判） | 判决完成 | — | — |
| T3 | `graph.requires` + `registry check` 预检 | **已完成（本片）** | 本片 | 判据一份（`orchestrate/registry-check.ts`）→ HTTP `GET /api/registry/check` 与引擎 `startRun` 同吃 → CLI `paneflow registry check --template x [--space S]` 退 0/1、网页模板卡一行「需要：模型 1 · 技能 1」+ ✓/✗/?/…。机证：判据 12 条 + 路由 6 条 + 起单口 5 条 + CLI 6 条 + 网页 6 条（含 `requires` 画布往返零丢失）。**四条实施改判 + 两处实机首驾撞形（模板写面 500 / `requires` 漏进反向引用账）见 §三 T3** |
| T4 | 插件 / MCP 承载 | **已完成 `ade742d`（§七 Q4 点名后按「加性」落地）** | `ade742d` | `mcp` 进 `REGISTRY_KINDS`/`RegistrySpecMap`/`SPEC_PARSERS`，形状停在裁决划得下的那一侧：登记=`{command, args?, note?}`，**工具桥接一行不写**（v13:285「不自实现 MCP 客户端」一字未改——登记 ≠ 连接）。探针通道**刻意不开**：画红点是替人判死，画灰点是谎称探过，所以 `health` 整键不给、界面上天然没有那个点。引用写法只认 id 与 slug（`command` 不算，与 model「中文名不算」/agent-kind「探测名不算」同一把尺）。消费面两处、都是声明级：`requires:[{kind:'mcp',id}]` 预检槽 + R2 引用账；网页表单长出三键（`command` 必填）。可感面：`paneflow registry add --from mcp.json` → `registry list --kind mcp` 见组行；无实探=那一格不画点 |
| K2 | 打回回路（v13 尾巴，§七 Q7 点头后落地） | **已完成 `1098285`** | `1098285` | 画布上「审出问题就退回重做」以前只能靠人停单再 replay；现在回边是真语义：带 `reject: true` 的边在审查岗 settle 现场按**同一把 `edgeActive` 尺**判活（跑过质检≠拒了），成立就把被拒方连同下游开回待跑，打回理由注进重跑 prompt。上限（默认 2、可配 1..5）封顶后那一次否决没人解决 → 被拒节点按 `failed` 收口、整单落 `completed-with-failures`（v11-D3 不洗绿）。账落在**被拒方**节点（`rejections[]`，`abandonments` 同款卫生），于是三处消费面同时有正身：CLI `status` 一行打回账＋理由原话、W4 角色能力账从此有 `rework:{rejected,capped}`（此前刻意不报，因为没有按岗可归因的真账）、网页运行卡一枚打回 chip＋预演步骤与画布回边可见。拓扑侧回边一律不算依赖（topoSort／扇入闸／upstream／预演步骤／autoLayout 只看前向边）；`validateDag` 按形状 fail-closed（两端都得是 agent、必须指向前置、无 condition 即「恒打回」拒）。**打回块只涨 `injectedBytes`，不进 `ctxSha`/`roleSha`/`skeletonSha`——C4 等臂语料可比性不破**（M0 机证①的前提交付不变）。顺带修两处遮蔽真 bug：动态扇出把分支模板上的条件边判据洗成恒通过、`api.dryRun` 自抄一份返回形状（现改单一事实源 `DryRunResult`） |
| W5 | 全站手填面清点 | **已完成 `e8f1fb6`** | `e8f1fb6` | 五处手填→选择：①PropertyPanel 模板名/兜底模板 → datalist（数据源=templateList）；②pipeline params → 结构化 key/value 行+增删；③两处 cwd → CwdInput 组件（文本+浏览按钮+内联目录面板，基于 /api/fs/browse）；④EquipPicker 手填 → 「去注册中心新增」跳转。机证：web tsc -b 净 + 90/90 绿 + build 成功 |
| W6 | `roleShaV: 2` | **判为「现在做不出诚实版本」，仍待裁决（见 §七 二次刷新）** | — | — |
| E1 | 环境发现器（只读） | **已完成 `e37d7b3`** | `e37d7b3` | `paneflow env probe <目录> [--json]` 七类草案逐项带依据（发现自哪个相对路径）；探测失败落 `missing`+一句为什么，不是 400 |
| E2 | 一次事务登记 + 向导四步 | **已完成（本片）** | 本片 | `POST /api/env/register` 一次事务：probe → map → write 全绿才落档案（原子写），任一步失败整体不落盘。CLI `paneflow env add <目录> --space <id>` 一行回执；网页「项目」页头「🔍 发现环境并登记」开四步向导（选目录 → 看发现 → 勾选 → 登记回执）。判据在 `env-probe.mapProbeToProfilePatch` 纯函数：四类可登记（repo/doc/skill/rule 各自映射档案字段，rule 带 repo 关联），三类只披露（check/workflow/worktree 无字段，向导里勾选框置灰）。机证：单测 6 条（四类映射/三类披露/selected 越界与负索引忽略/existing 与同批去重/rule 按 file 去重/空 selected 全不选）+ 端到端 27 条（env-probe.test.ts 全绿）；`panelflow typecheck` 净 + web `tsc -b` 净 + server 61/890 绿 + web 12/90 绿。诚实边界：向导不装任何软件，只登记「本机/本仓确实有这些东西」 |
| X1 | 注册中心视图（现役控件对照） | **全量已完成**（首屏 `10bc315` + 详情抽屉两件本片） | `10bc315` 本片 | 网页「注册中心」= 一张表（分组/label/来源/启停/删除）+ 健康点 ●/○/? + 被引用数 + 表单登记（不写 JSON）；**对照「现役家产」清点后缺的只有两件，本片补齐**：①**引用者清单**——详情抽屉「谁在用」逐条列 server 随条目发下的 `refs`（`face · 「名字」（id） · via`，与 CLI `registry refs` 同一份账同一把尺；`face` 原样画，中文对照表住在 server 的 400 文案里，不抄第二份），三种读数三句话：`refs` 缺键＝「这次没扫出来，不是没人用」（琥珀色，不给删除开绿灯）／`[]`＝「没人用（正读数）」／有货＝「被 N 处引用，删除时 server 拿这份清单拒你」；②**行内「探一次／现探」**——接既有 `GET /api/registry/:id/health`（CLI `registry probe` 的同一落点、同一份 5min 实探缓存，`?refresh=1` 才绕开），读数回来顺手并进批量那张 health map，于是表上那颗点与详情行不会画成两样；回执句只说它那一格说不出来的三件事（失败原话／这一类没有探针通道／刚探过一次，读数见上一格）。机证：web 单测 +9 条（`refRows` 三段排版与字段缺失、形状不认也不吞、缺键 vs 空数组分家、数值型 `refs` 不画清单但计数照读；`probeNote` 四态＋失败优先＋不重复贴人话），web **12 文件 / 100** 全绿 + `tsc -b` 净 + 根 typecheck 净。**M0 样张③ 的「肉眼看到」这条仍欠**（真浏览器截图取不到——应用内视口不可用；DOM 断言有）。**更正一笔**：`ba7622c` 的提交说明把「`api.dryRun` 返回形状并入单一事实源」记成本片改动，实际那半在 `1098285` 就落了（见上一行 K2）；提交已推故不改历史，账在这里对平 |
| X2 | CLI 三处必动 + AGENTS/README + 发行 v0.3.0 | **已完成**（代码面 `e8f1fb6` 一片 + 发行本片） | 本片 | 三处：①`CLI_SUBCOMMANDS` 已含 `env/registry`（前片完成，本片无需增枚）；②`VALUE_FLAGS` 已含 `kind/from/path/space/template`（本片不新增）；③USAGE 补 `env add` 一行（含 --json）；`paneflow env add <目录> --space <id> [--json]` 与网页向导同一 API、同一判据（stdout 干净可 `| jq`）；AGENTS.md 补 `env add` 命令块（四类入档 / 三类只披露 / 一行回执 / 不装任何软件）。机证：CLI 单测 4 条（人读一行 + `--json` 直出 + `body.error` 双语义退 1 + 脏输入不发请求与 USAGE 覆盖），CLI **3 文件 / 74** 全绿 + `pnpm typecheck` 净。**发行（本片）**：五枚 `package.json` 0.2.0→0.3.0（根 `name: paneflow` 的版本即注册表 `schema.json` 的 `writtenBy` 来源，无需另改代码）+ README 的 tag 示例那行照改；`node scripts/build-release.mjs` 本地产 `paneflow-0.3.0.tgz`（378.9KB／9 文件，带 `.sha256` sidecar 与 `LICENSE`——v0.2.0 包内缺许可那条已还）；`node scripts/smoke-release.mjs` 对**真产物** **17/17 通过**（含 E1/E2/E3「新起服务上 `runs`/`experiments --suite c4` 真打得通」与 E4/E6 自起实例不留孤儿）。打 `v0.3.0` 标签推 `origin/main` 后由 `release.yml` 自动发 GitHub Release（CI 里冒烟不过则不发）。**Release 与装机的肉眼回执仍是 X3 的事**——本仓在 agent 侧只能证到产物冒烟这一层 |
| X3 | 实机首驾（零手填路径全程） | 待用户实机跑 | — | 代码路径已通：`paneflow env add <绝对路径> --space <id>` → `paneflow registry check --template x` → `paneflow dispatch "..." --repo ... --issue ...` → `paneflow status <runId>` 见「能力: N 项 · cap#xxx」一行；向导四步（网页）同路。欠的是真项目上跑一遍：本机装 v0.3.0 之后手敲一次；agent 侧无可代做的部分 |

**M0 机证三条的现状（不洗）**：① 10 条 v13 历史 run replay 后 `骨架#/ctxSha/roleSha` 逐字节相等——**未跑**（要 run 预算点头）；② server 全量测试零改动零红——**已达标**（A3-2 片收口实跑：server **61 文件 / 872** 绿、web 11/**82**、cli 3/**70**，`pnpm typecheck` 净 + web `tsc -b` 净；T3 片时是 61/852、web 77、cli 69，R5 片收口时 57/817、web 71、cli 63——**只加不减**，且加的全是新片的判据断言，既有断言一条没放宽。X1 全量片收口时（K2 已在账）：**server 918 · web 12/100 · cli 75**，根 `typecheck` 净 + web `tsc -b` 净）；③ 注册中心首屏一张表 + 健康点 + 被引用数——**结构已证、视觉半证**（A3-2 后 `pnpm build` 刷新了 server 一键模式挂的前端，实机页面读回 `Agent 引擎 18 项 内置清单` 分组与「出厂行无启停/删除」；截图仍未取到——应用内视口不可用，见 X1 行）。
> ②里那条**工程口径**要写死：本仓 server 一键模式服务的是 `packages/web/dist`，改完 web 源码不跑 `pnpm build` 就等于没改——A3-2 第一次实机检查看到的就是旧包（`未知类型：agent-kind`），build 之后才读到新组名。判据落在构建链上，不靠记性。
> ②「零改动」这条口径在 R5 需要说清它约束的是什么：**历史 run 的既有读数与既有判据不许改**（`骨架#/ctxSha/roleSha/graphSha` 逐字节、
> 收口判定、退出码），不是「测试文件一行不许动」。R5 确实动了 5 条钉死字符串——收数表多一列（doc 明写要新增 `registrySnapshotSha` 列），
> 那些断言本来就钉在列数上；改的是**期望值**（多一个 `- |`），不是放宽判据。这类「按 doc 要求改列」的动账逐片在此报备，不闷声改绿。

