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

> **2026-09-26 状态刷新**：用户令「按需求走」＝按本文件推荐取值推进。Q2 已单独结掉（前置-1，见 §十三）；
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
- 未开工：**v14 的 R/T/W/E/X 五系代码面已全部落地**（逐片见 §十三；唯一挂着的是 W6 `roleShaV:2`，判据是「现在做不出诚实版本」，
  前置=W5′ 装备槽指向注册项，见 §七 二次刷新）。此后欠的三类账不在 agent 能代做的范围里：
  ①M0 机证① 的 10 条 replay 等臂复验（要 run 预算）；③X3 实机首驾**只剩带 agent 节点的那一笔**（要 token，且要在你自己那个项目上手敲才算数）——只读面与零 token 写面已由 agent 在临时靶项目 `x3` 上证完，逐条读数见本文末「X3 半程核对回执」「X3 写面回执」两段。
  ~~②X2 的版本 bump / tag / Release~~——**已办**：五枚 `package.json` 0.2.0→0.3.0、本地产物冒烟 17/17、`v0.3.0` 标签推送后由
  `release.yml` 自动发 GitHub Release（CI 里冒烟不过则不发）。**实发回执（2026-09-27 对平）**：bump 提交 `2975385` 的 CI run
  `36315427746` 绿 → 推 `v0.3.0` 标签 → Release run `36315598843` 绿 → `gh release view v0.3.0` 四枚资产齐
  （`paneflow-0.3.0.tgz` + `.sha256`、`paneflow-latest.tgz` + `.sha256`）；从公开 URL 重下的 `paneflow-latest.tgz` 实算 sha256
  与 sidecar 逐字节相符（`dfc05d59…8ffd4d`），解包后 `package.json` 读回 `paneflow 0.3.0`。装机侧回执（用户机 `install.sh` 升级后跑一次）仍在用户手里。
- **上面那句「五系代码面已全部落地」报小了账，此处更正（2026-09-27，用户点破「怎么连一个注册模块现在都还没完成啊」）**：
  五系**流程**确实都通了，但 slogan 的**底座**只通了一小半——§一 那张清单里该有正身的 kind 有 13 枚，
  `REGISTRY_KINDS` 当时只有 4 枚（登记项 `model`、`mcp` ＋ 视图两枚 `agent-kind`、`node-type`）：
  项目规则、技能、仓库、角色、模板、网关档、机检类型…六枚以上今天仍住在各自的老写入语义里，
  §一 读数①那「12 套登记语义」**没被收成一套**。所以 R 系的真实账是「内核通了、kind 没迁完」，
  而我把内核通说成了全部落地——这是可感面口径上的漏报，不是措辞差异。
  处置：按 §一 那张表拆成 **A5-x 逐枚进表**（形状决议见 §十二），A5-1 `skill`、A5-2 `rule` 已落（见 §十三 那两行），其余照表推进；
  每片的回归面都是同一件事——预检里这一 kind 从 `?` 翻成 `✓/✗`（起单口自此 fail-closed 拦），
  凡此前拿未迁 kind 举例的断言逐片改口，不闷声放宽。
- **X3 的机器前置（本片新增的账，不是 X3 本身）**：本机在跑的 server 是 09-26 起的 dev 实例（PID 54817，`tsx packages/server/src/index.ts`），
  它前端的 `packages/web/dist` 已是我 `pnpm build` 出的 HEAD——于是**前后端版本错配**：`GET /api/registry?kind=node-type`、`?kind=mcp`
  与 `?kind=skill`／`?kind=rule` 在这台实例上回 400「这版只登记：model/agent-kind」（T1/T4/A5-1/A5-2 后端不在它身上），`/api/env/probe` 直接 404（E1/E2 不在），
  而注册表列表、批量健康、`registry check`、单枚 `:id/health` 全 200（R1-R4/T3 在）。后果很具体：画布 Palette 读不到节点类型清单、
  E2 向导按了没货、注册中心「新增」里没有技能与规则这两型。解法只有那条既定路：**队列空时的一次重启仪式**（与上面 v13-Z 那条余项是同一次），属共享状态变更，需用户令，不代做。
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

## 十二、A5（把 §一 剩下的登记面逐枚进表）落盘形状决议——写码前定死

§八 那条更正背后是这一系：R1–R5 建的是**内核**（信封＋引用账＋快照），内核今天认得的 kind 只有 4 枚；
§一 清单上该有正身的登记面有 13 枚。A5 就是把这个差一块块补平，一片一枚 kind，**每片各带一条「预检自此拦起单」断言**。
下面这些取值是开工令附件，实施时不许临场发明第二套；实测推翻就改这一节并留证据。

1. **两类 kind，判据一句话**：「这张表能不能被用户增删」。
   **登记项**（用户可写、落 `entries.json`、三写动词全通）：`model`(A1) · `mcp`(T4) · `skill`(A5-1) · `rule`(A5-2) · `repo`(A5-3)；
   **视图 kind**（条目由代码或现盘**现算**、不落盘、三写动词全拒）：`agent-kind`(A3-2) · `node-type`(T1) ·
   `check-type`(A5-4) · `role`(A5-4b-1) · `template` / `gateway-profile`(A5-4b-2)。
   视图 kind 迁的是「引用有正身可指」这件事，不是搬数据——与 §五「不搬 graphs」不冲突，且它天然满足 R3 的「只读聚合」。
2. **作用域住在 spec，不动信封**（A5-1 定形，后续同例）：`skill.spec = {space, file, note?}`。
   **不**在信封上插 `space` 键，也**不**升 `schema.json` 到 v2——作用域是这一 kind 的事实，不是所有条目的事实；
   往统一信封塞 per-kind 维度＝用 schema 版本换一次形状错误，两样都赔。先例是 `model.spec.gatewayProfile`。
3. **引用写法逐 kind 定死，且必须覆盖今天盘上真在写的那几种**。`skill` 认三枚：整 id、slug、`spec.file`（相对路径）。
   第三枚不是省事——今天 `role.skills[]` 与 `space.skills[]` 存的就是路径串，不认它则 A5-1 落地当场把现网引用洗成悬挂，
   R2 写端会拿着一份 400 拒掉所有存量角色的 PUT。**中文名/显示名一律不算引用写法**（与 model、agent-kind 同一把尺）；
   中文 name 的 slug 会回落成 `e<8位随机>`，所以人写的中文名在引用账里什么都指不到——这条有测试钉住，防止下一片顺手放宽。
4. **写入面不判存在性**。登记一条指向不存在的项目或还没写出来的技能文件都合法：
   space 存在＝R2 的引用账（那个项目被删时这条会亮引用者清单）；file 存在＝R4 的探针。
   「先立账、后写文」是正常使用路径；写入面拦存在性等于逼用户先去编辑器里建一个空文件再回来点保存。
5. **预检不按 `--space` 收窄**（本片唯一的主动不做事）。`graph.requires` 的槽里没有写项目名的位置，
   拿当前空间去收窄＝替模板作者编一个他根本没画的约束。于是命中口径是「本机任一项目登记过这篇技能即算命中」，
   作用域那一维住在**引用账**（空间自己发的引用按主人收窄）与**探针**（去那个项目根实读一次）。
   `spaceNote` 文案已照这条改写，并有断言钉住（`预检的槽仍不按项目收窄` 这句在测试里被 `toContain`），文案腐不回去。
6. **跨面同键冲突 → 不对称处置**（A5-1 的形状，A5-2/A5-3 沿用）。两条 `skill` 条目允许各自写同一个 `file`（不同项目里同名相对路径）。
   反向引用账**逐条记全**——多报的代价是「删的时候多拦一次」，人能绕过去；
   正向能力快照**跳过歧义项**——记两条等于谎称这一单读了两篇文件，历史 run 的账不可恢复，宁可少记。
   全被跳过时快照给 `null`（整键不给），不是 `[]`（`[]` 是正断言「这一单没吃任何注册能力」，「不确定」不能冒充正断言）。
7. **探针三态各有各的正身**：`live`=去那个项目 `rootCwd` 实读到文件（带字节数与改动时刻）；
   `missing`=`..` 越界／不是文件／ENOENT；`unknown`=空间档案读不到或没配 `rootCwd`，
   文案明写「不等于这篇技能不存在」（未探得≠不存在，R4 那条老账）。
   `skill` 探针**不进缓存层**——`stat` 一次即结论，所以 `--refresh` 对它是 no-op；这一条要在 CLI 回执里如实，不让旗标撒谎。
8. **「进表」这个动作本身就是回归面**：`isJudged` 由 `REGISTRY_KINDS` 派生，所以一枚 kind 落表即自动把预检读数
   从 `?`（非阻塞）翻成 `✓/✗`（阻塞，起单口 fail-closed 拒）。于是每片必须做同一件改口入账：
   凡此前拿「未迁 kind」当例子的断言，把例子换成**仍未迁**的那一枚（A5-1 用的替身是 `rule`，A5-2 起 `rule` 有正身了、替身换成 `repo`），
   并把翻面本身钉成一条 before/after 断言。这不是测试噪音，是这一片唯一用户可感的语义变化。
9. **A5-3 `repo` 的形状**（开工前定死，同上）：`spec = {space, dir, origin?, note?}`。
   这一枚与前两枚多一处不同：**今天「仓库」在盘上有两套命名空间**，把它们塞进一枚键就是假账——
   `dir` 是相对主仓根的**目录名**（`repos[]`／`rules[].repo`／`delivery[].repo` 三处写的都是这一形），
   `origin` 是 GitHub 的 **`owner/repo`**（`contract.repo`／`dispatch --repo` 那一形，由 `.git/config` 的 remote 归一而来，
   归一只用 `dispatch.ts: parseGithubRemote` 那把尺，不另写第二份）。于是引用写法是**四枚**：
   `id`／`slug`／`spec.dir`／`spec.origin`（外加 origin 写成完整 URL 时按那把尺归一出的 `owner/repo`——
   存原样、匹配时归一，登记面不改用户写的字节，两处判据的分歧就此没有）。
   **探针只回答「这台机器上这个目录在不在」**（`fs` 三态：越界/不存在/不是目录=missing，读到目录=live 且 detail 分说
   有没有 `.git`），**不实读 remote URL**：整表健康是逐个条目跑的，为一句核对去起 N 次 `git` 子进程不值，
   而派发现场的候选仓解析本来每次都实读——「没核 ≠ 不符」，detail 里如实写这一版不核对。
   A5-3 之后的改口替身＝`role`（视图 kind；A5-4b-1 已迁它、A5-4b-2 又迁了 `template`/`gateway-profile`，自此替身＝`channel`）。
10. **A5-4 `check-type` 的形状**（视图 kind 的第一枚，与 `node-type`(T1) 同条路）：`spec = {label, hint, machine}`。
    这一枚要立的**不是数据而是「这六型有正身可指」**，所以它整枚走视图路：条目由 `shared/dag.ts: CHECK_TYPE_CATALOG` 现算、
    不落 `entries.json`、三写动词全拒（红线七：登记形状不登记执行体）。三条硬约束：
    ①**清单与值域同源**——`CHECK_TYPE_CATALOG_BY_TYPE` 是 `Record<CheckSpecType, 条目>`，判别联合加一型而清单忘一行就编译不过，
    于是「表里六型」与「引擎认得六型」不会是两把尺；
    ②**机检账的分母从此派生**——`MACHINE_CHECK_TYPES = CHECK_TYPE_CATALOG.filter(c => c.machine).map(c => c.type)`，
    此前那份手抄白名单与这份清单是两处事实源（v13-V1 的 `machineCheckTally` 吃它），自此只有一处；`machine` 是布尔且**不给默认值**
    （缺省猜 `true` 会把「人工确认」计进机检侧的分子，那是把人的看一眼冒充机器实跑）；
    ③**探针通道刻意不开**——与 `node-type` 同一句判据「这一型的正身就是代码」：PATH 上探不到「文件存在」这一型，
    画红点是替人判死、画灰点是谎称探过，所以 `health` 整键不给，界面上天然没有那个点（与 `mcp`/T4 同款处置，这里是裁决不是漏写）。
    引用写法两枚 `id`/`slug`；中文显示名「文件存在」**不算**引用写法（与 model 中文名、agent-kind 探测名同一把尺）。
    **进表的代价要写清**：`capabilitySnapshot` 自此把机检条目也记进账，于是**同一张图在 A5-4 前后起单会得到两个不同的 `cap#`**——
    历史 run 吃自己落册的那份副本一字不动（§十三 M0 那条「既有读数不许改」照旧），但拿旧单做等臂对照时要记得这一刀是版本带来的，
    不是这一单换了配置。改口替身照 §十二-9 那句留在 `role`（A5-4b-1 已迁它，自此替身＝`template`）。

11. **A5-4b-1 `role` 的形状**（视图 kind 第二枚；这一枚把「正身」的定义扩了一次）：`spec = {label, agentKind?}`，
   条目由 `roles.json` 名册**现算**、不落 `entries.json`、三写动词全拒。四条硬约束：
   ①**视图 kind 的正身第一次不是代码**——前三枚（`agent-kind`/`node-type`/`check-type`）的成员由版本决定，`role` 的成员是用户自己建的岗位。
   于是「内置清单／版本自带的」这类**页面形容词一律作废**：正身措辞由 server 逐 kind 外发成 `viewHomes`（`GET /api/registry` 与 `GET /api/registry/:id` 各带一张），
   `VIEW_HOME` 与 `VIEW_BUILDERS` 同写成 `{ [K in 视图 kind]: … }`，所以加第五枚而忘写去处就编译不过——一处词表，两处消费面（网页组徽标/详情注释、CLI 视图项那一行）都不形容词；
   **消费面对旧 server 缺键回落成不带 kind 的通用措辞，不猜**（猜错就是把用户建的岗位说成出厂货）。
   ②**名册脏了不冒充读数**：`ENOENT`＝正读数的空组（还没建过角色库，不是错误）；读不出／顶层非数组／行无可用 id／重复 id／缺岗名／`agentKind` 破烂
   各进一条 `disclosure`，并入 `readView().rejected`（「只披露不清除」），与引擎侧 `loadRoles()` 的静默降级**刻意分家**——那侧照旧跑单，这面说清为什么少了几行。
   ③**引用写法三枚**＝整 id、slug、以及 `entry.name` 里那名册原值。第三枚不是省事：`registryId()` 把 slug 段小写化，
   名册里 `R-Deliver` 这种大写 id 只有靠 `name` 存原样才指得到；**岗名（`spec.label`）不算**引用写法（与 model 中文名、agent-kind 探测名、check-type 中文显示名同一把尺）。
   ④**不进探针通道**（与 `node-type`/`check-type`/`mcp` 同款裁决，不是漏写）：一枚岗位「在不在」由名册现算那一刻就定了，再探一次只是把同一句话问第二遍。
   **进表的代价与欠账要写清**：`cap#` 自此把角色条目记进账（同一张图跨这一刀两个值）；
   `space.team[i].roleId` 与 `nodes[i].config.role` 两处裸串从 `unmigrated` 只报计数变成**一条边**（谁在用看得见）；
   但**角色库那一面的删除当时不查这本账**——R2 的拒删只武装在注册表三个写动词上，而 `role` 恰恰没有写动词，
   于是删一枚还在被班底/模板引用的岗不会被拦。本片只做到「引用指得到、出处看得见」，删除侧的闸记为 A5-5a 那一笔账。
   **（A5-5a 已还：同一份判据如今装在 `PUT /api/roles` 上——整本名册覆写时这次没再带上的一枚岗先问一次引用账，被指着就 400 点名出处、名册一个字节不动。见 §十三 与 A5-5a 行。）**
12. **A5-4b-2 `template` ＋ `gateway-profile` 的形状**（视图 kind 第三、四枚正身在盘上；§十二-1 清单的最后两枚）：
   `template.spec = {nodes, description?}`（`nodes` 是**节点个数**，不是拓扑——图的内容有 `validateDag`/`graphSha` 两本正身账，镜子不复述）、
   `gateway-profile.spec = {label, baseUrl?, freeModel?, keyConfigured}`。五条硬约束：
   ①**两枚的机器值不同源，各自跟着引擎取用时的那枚键**：`template` 是**文件名去 `.json`**（`store.getGraph` 按文件名找图，图里 `name` 只是元数据），
   `gateway-profile` 是**档 id 原样**（`SpaceProfile.gatewayProfile` 与 `model.spec.gatewayProfile` 发的都是这一串）。
   两处不一致都**以机器值为准 + 落一条披露**（「改名要连文件一起改」），不静默跟随图内 `name`。
   ②**`apiKey` 在这面根本不出现**：条目只带 `keyConfigured` 布尔（R1 边界②：密钥只在盘上流转，任何以网关盘为输入的推导器都不许把它带进返回值），
   且这一格**必填布尔**——缺省当 `true` 就是把一枚裸档说成能跑（假绿）。
   ③**「现在生效的是哪一档」不进任何条目**：`GatewayDoc.current` 是文档级读数，换档不是能力面变了，塞进某一档的 spec 会让换档抖出 `specSha`；
   但它自本片起在引用账里是**一条有出处的边**（`face:'gateway' · via:'current'`），不再是 `unmigrated` 的一个计数。
   ④引用写法**三枚**（整 id／slug／机器值原样）：第三枚必需——`registryId()` 把 slug 小写化，而 `saveGraph` 的名正则与 `upsertGatewayProfile`
   都收大写（`Fix-Issue`／`Gw-Main` 是能落盘的写法），只认 slug 就把这枚现网写法当场洗成悬挂。**图内 `name`、档名（`label`）、`freeModel` 都不算**
   引用写法（没有任何键按那句说明/那个中文名/那枚型号指岗，与 model 中文名、岗名、`mcp` 的 `command` 同一把尺）。
   ⑤脏盘不冒充读数，且**按条目 id 去重**：`a b.json` 与 `a-b.json` 是两个引擎都取得到的文件、却归一成同一枚条目 id——注册表只渲第一条并披露
   （说「有两枚 `template:x`」就是假账）；`nodes` 不是数组 ⇒ 披露，**不渲 0**（「读不出」与「一张空图」是两种正读数）；
   `ENOENT` ⇒ 空组零披露（还没建过模板/只有一枚默认档，不是错误）。探针通道两枚**都不开**（图在不在盘上、档配没配，条目本身就是读那两张盘读出来的）。
   **随片多出的页面读数**：视图项的「启用」那一格从此有两种读法——`gateway-profile` 的正身自己带 `enabled`，停用的档真跑不了，
   而预检侧早就只认启用中的条目，镜子继续画「—」就是页面与判据对同一件事说两种话；纯函数 `viewEnabledCell` 照读 server 的 `enabled`
   画「停用中」（title 说「那一面里停着，注册表只照读」），**文案里永远不许出现「点击」**：启停的正身在那一面，在这里给个可点的格子就是造一个不生效的假控件，
   与三写动词对视图 kind 全拒同一个道理。前四枚视图 kind 没有 `enabled` 落差，照旧画「—」。
   **翻面代价**：同一张图跨这一刀有两个 `cap#`（能力快照自此记进模板与网关档）；HTTP 整表面**再也样本化不出** `unmigrated`
   （扫描器能发出的 kind 全在表里了），那条 stance 从此只住在判据层——`registry-refs` 手喂一枚 `channel` 裸串、`registry-check` 的 `?` 那一格，
   两处各钉一枚，不拿假盘面冒充渲染证据。
13. **裸串引用账只数「今天就能指到东西」的串——模板变量不算引用**（A5-4b-2 实机首验抓到，后续 kind 一体适用）：`{{…}}` 是起单时才解析的槽位（出厂 `builtin-issue-triage` 的 `config.pipeline.template` 写的就是它），拿整串是变量的 target 去判死活＝替一条**还不存在的名字**断一条悬挂。窄闸住在 `registry-refs.ts:isRuntimeVariableSlot`，`refsFromGraph` 收口处只剔**整串恰为 `{{…}}`** 的引用（`fix-{{x}}` 这种拼了一半的仍算——引擎没有替换它的通道，指不到就是真指不到）；`refsFromRequires` 不经这道闸（`requires` 是人手写的声明，没有替换通道）。这条与「岗名／图内 name／`freeModel` 不算引用写法」是同一族判据：**能指到条目的写法才算边，人眼看着像名字的不算**。

14. **A5-5b 装备槽的两写法：并存，不是替换**（W 系的收口片；§三 P3 那条「角色=对注册内容的选择配置」到这里才真成立）：
    一格槽（`role.skills[i]` / `role.rules[i]`）从今天起认两种写法——**裸相对路径**（v13-W1 的原语义：吃本项目登记清单里那一枚，池子尺）
    与 **`{kind:'skill'|'rule', id:'…'}`**（注册表定点引用：条目自己的 `spec.file`，注册表尺）。**刻意不做的事**：
    ①**不把裸串自动翻成引用**（翻法不唯一：同一篇文档在 A 项目和 B 项目各登记一枚；翻了等于替人改写那枚岗的语义，
    跨项目可复用的池子语义会被第一枚命中的条目钉死在一个项目上）；②**不复制第二把池子尺**——裸串那一路直接调
    `resolveSkillRefs` 本体，所以「裸串行为逐字节不变」是构造保证而非断言保证；③**引用不落地的原因不入指纹**
    （`misses[].why` 的取材是整张注册表，别处改一枚条目就抖这岗的 `roleSha`＝拿别人的账冒充这岗的配置），
    但它必须**有一处人话**落册：裸串的毛病是「不在登记清单」，引用的毛病是「不属于本单所在项目 / 解析不到可用条目」，
    拿前一句去披露后一种格子就是假话——所以 server 在注入现场把 `why` 算好进账，CLI 只原样渲（R4）。
    **作用域去哪**：`rule` 条目自带的 `spec.repo`/`pathsGlob` 不进注入清单，而是交回给唯一那把作用域尺
    `rules.matchRules`（这里再算一遍 glob 就是两处判据）；**项目去哪**：`skill` 描述器的 `matches` 不按空间收窄
    （`registry check` 那一侧的裁决就是「任一项目登记过这篇即命中」），收窄住在调用方——本单空间对不上就**不注、只披露**。
    **顺带白捡的一件事**：`{kind,id}` 在 R2 引用账里是一条真边（`face:'role'、via:'skills[0]'`），于是 A5-1..A5-3 那三枚 kind
    的「拒删被引用条目」闸对岗位装备**自动生效**——删除侧一格代码没新写，测试钉的是那条拒答真从装备槽引出来。
    **A5-5b-3（「名册里还有哪些裸串在注册表里指得到」的只读报告）判为不做**：A5-5b-2 立起第二列之后，那份报告的人
    已经站在这儿了——同一篇文档在裸路径列与定点引用列各显一行，「这篇注册中心也登记着、勾它就把这枚岗钉到那个项目」
    是肉眼可读的对照，再起一刀 `GET` 只是把同一份读数换个地方重画（还得为它加一张面与一套文案）。
    **而迁移本体照旧不自动做**：那枚岗可能被多个项目的班底用，裸串在每个项目指的都是「这一项目根下的这一篇」，
    换成哪一枚条目 id 都是替人改写语义（§十二-14 ①），所以这里只到「看得见、点得出」为止，落盘改写留给人。

## 十三、实施状态表（v14 开工前全空；K1 未收口则 A 系不开）

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
| X1 | 注册中心视图（现役控件对照） | **全量已完成**（首屏 `10bc315` + 详情抽屉两件本片） | `10bc315` 本片 | 网页「注册中心」= 一张表（分组/label/来源/启停/删除）+ 健康点 ●/○/? + 被引用数 + 表单登记（不写 JSON）；**对照「现役家产」清点后缺的只有两件，本片补齐**：①**引用者清单**——详情抽屉「谁在用」逐条列 server 随条目发下的 `refs`（`face · 「名字」（id） · via`，与 CLI `registry refs` 同一份账同一把尺；`face` 原样画，中文对照表住在 server 的 400 文案里，不抄第二份），三种读数三句话：`refs` 缺键＝「这次没扫出来，不是没人用」（琥珀色，不给删除开绿灯）／`[]`＝「没人用（正读数）」／有货＝「被 N 处引用，删除时 server 拿这份清单拒你」；②**行内「探一次／现探」**——接既有 `GET /api/registry/:id/health`（CLI `registry probe` 的同一落点、同一份 5min 实探缓存，`?refresh=1` 才绕开），读数回来顺手并进批量那张 health map，于是表上那颗点与详情行不会画成两样；回执句只说它那一格说不出来的三件事（失败原话／这一类没有探针通道／刚探过一次，读数见上一格）。机证：web 单测 +9 条（`refRows` 三段排版与字段缺失、形状不认也不吞、缺键 vs 空数组分家、数值型 `refs` 不画清单但计数照读；`probeNote` 四态＋失败优先＋不重复贴人话），web **12 文件 / 100** 全绿 + `tsc -b` 净 + 根 typecheck 净。**M0 样张③ 的「肉眼看到」：截图仍取不到（应用内视口不可用），但现网 DOM 断言已实跑到**（2026-09-27，见下一行「现网取证」）。**更正一笔**：`ba7622c` 的提交说明把「`api.dryRun` 返回形状并入单一事实源」记成本片改动，实际那半在 `1098285` 就落了（见上一行 K2）；提交已推故不改历史，账在这里对平 |
| X2 | CLI 三处必动 + AGENTS/README + 发行 v0.3.0 | **已完成**（代码面 `e8f1fb6` 一片 + 发行本片） | 本片 | 三处：①`CLI_SUBCOMMANDS` 已含 `env/registry`（前片完成，本片无需增枚）；②`VALUE_FLAGS` 已含 `kind/from/path/space/template`（本片不新增）；③USAGE 补 `env add` 一行（含 --json）；`paneflow env add <目录> --space <id> [--json]` 与网页向导同一 API、同一判据（stdout 干净可 `| jq`）；AGENTS.md 补 `env add` 命令块（四类入档 / 三类只披露 / 一行回执 / 不装任何软件）。机证：CLI 单测 4 条（人读一行 + `--json` 直出 + `body.error` 双语义退 1 + 脏输入不发请求与 USAGE 覆盖），CLI **3 文件 / 74** 全绿 + `pnpm typecheck` 净。**发行（本片）**：五枚 `package.json` 0.2.0→0.3.0（根 `name: paneflow` 的版本即注册表 `schema.json` 的 `writtenBy` 来源，无需另改代码）+ README 的 tag 示例那行照改；`node scripts/build-release.mjs` 本地产 `paneflow-0.3.0.tgz`（378.9KB／9 文件，带 `.sha256` sidecar 与 `LICENSE`——v0.2.0 包内缺许可那条已还）；`node scripts/smoke-release.mjs` 对**真产物** **17/17 通过**（含 E1/E2/E3「新起服务上 `runs`/`experiments --suite c4` 真打得通」与 E4/E6 自起实例不留孤儿）。打 `v0.3.0` 标签推 `origin/main` 后由 `release.yml` 自动发 GitHub Release（CI 里冒烟不过则不发）。**Release 与装机的肉眼回执仍是 X3 的事**——本仓在 agent 侧只能证到产物冒烟这一层 |
| A5-1 | `skill` 进注册表（登记项第三枚；§十二 形状决议的第一片） | **已完成（本片）** | 本片 | **可感面**：`paneflow registry list` 多出「技能」分组；`paneflow registry probe skill:&lt;id&gt;` 三态人话（`live`＝去那个项目 `rootCwd` 实读到「N 字节 · 改动于 …」／`missing`＝越界·不是文件·没有这篇／`unknown`＝项目档案读不到或没配根目录，明说「不等于这篇技能不存在」）；**语义变化一处**：`registry check --template x` 里 `kind:'skill'` 的槽自此从 `?`（不拦）翻成 `✓/✗`，起单口同尺 fail-closed；网页「注册中心·新增」长出 skill 三键——`所属项目` 是下拉（数据源 `GET /api/spaces`），`文档路径` 是文本框+datalist（候选=所选空间 `skills`/`conventionFiles`/`rules[].file` 三源并集去重排序，仍可直填，候选不是白名单）。**形状**：`spec={space,file,note?}`——作用域住 spec 不动信封、不升 schema v2（§十二-2）；引用写法三枚 `id`/`slug`/`spec.file`（第三枚是盘上今天真在写的那串路径，不认它则本片当场把现网角色引用洗成悬挂）；写入面不判存在性（space 归 R2 引用账、file 归 R4 探针，§十二-4）；预检不按 `--space` 收窄，`spaceNote` 文案已改口并被断言 `toContain` 钉住。**跨面同键的不对称处置**（§十二-6）：反向引用账把同一 `file` 的两枚条目**逐条记全**（多报=删被拒，可绕），正向能力快照**跳过歧义项**（记两条=谎称这一单读了两篇文件，不可恢复），全跳过给 `null` 不给 `[]`。机证：server **62 文件 / 937**（新增判据 24 条——`registry` 10／`registry-check` 单元 3／路由 2／引用账歧义双记 2／快照跳过 3／起单拦截 1／词表 1 类）+ web **12 文件 / 104**（skill 三键与候选并集 6 条）+ cli **3 文件 / 75**；根 `typecheck` 净 + web `tsc -b` 净。**改口入账**（§十二-8）：7 条既有断言里拿未迁 kind 举例的位换成 `rule`（`api/registry-check` fixture 槽、`registry-refs` 未迁清单与 `requires[3].id`、CLI `?` 槽与「需要：模型 3 · 规则 1」行、web 未知类型示例、`registry.test` 分组序）——**只换例子，没放宽任何判据**，`git diff` 里 `it(` 行零删除。**诚实边界两条**：①表单的实机浏览器核对欠着——本机 4310 跑的是 09-26 dev 实例（v13-S6 单实例锁），这一版前端不在它身上，`?kind=skill` 在那台实例上照旧 400，与 X3 前置是同一次重启；②`skill` 探针不进缓存层，`--refresh` 对它是 no-op（CLI 不拿旗标撒谎） |
| A5-2 | `rule` 进注册表（登记项第四枚；§十二 形状决议的第二片） | **已完成（本片）** | 本片 | **可感面**：`paneflow registry list` 多出「规则」分组（组名仍从 server 的 `kindLabels` 出，词表没添第二份）；`paneflow registry probe rule:<id>` 在 skill 那枚的文件面之外多问一句作用域——文档按 `spec.space` 的 `rootCwd` 实读，`spec.repo` 按**主仓根**下这个目录真不真存在来问，越出主仓根或目录没有 ⇒ `missing` 且 detail 直说「没有节点的工作目录落得进这里，这条约定永远不会被注入」（这就是注入现场 `matchRules` 那把尺的确定结论，不是猜）；`spec.pathsGlob` **刻意不判**（glob 语义只有注入现场那一把尺说得清，这里再算一遍就是两处判据，迟早对不上）；**语义变化一处**：`registry check --template x` 里 `kind:'rule'` 的槽从 `?`（不拦）翻成 `✓/✗`，起单口同尺 fail-closed；网页「注册中心·新增」长出 rule 五键——`所属项目`（下拉，`GET /api/spaces`）+ `文档路径`（文本框+datalist，候选与 skill 共用那份 `space-docs` 池：所选空间的 `skills`/`conventionFiles`/`rules[].file` 三源并集）+ `作用域仓`（datalist `space-repos`，所选空间登记过的仓）+ `目录 glob`（原样存，不给候选）+ `备注`，五键里只 `space`/`file` 必填。**形状**：`spec={space,file,repo?,pathsGlob?,note?}`——作用域住 spec 不动信封、不升 schema（§十二-2 同例）；引用写法三枚 `id`/`slug`/`spec.file`（第三枚＝今天 `profile.rules[i].file` 落册的那串，不认它则本片当场把现网角色 `rules[]` 与空间档案两面的引用洗成悬挂）；**作用域不是引用**：`refKeys` 不含 `repo`/`pathsGlob`，于是 `requires:[{kind:'rule',id:'packages/web'}]` 那种拿仓名当引用的写法照旧判 `missing`（两处判据会分出「预检说缺、引用账说在用」）；写入面不判存在性（§十二-4），但 `repo`/`pathsGlob` **给了就得是非空串**——空串若被静默丢掉，这条约定就从「只守某仓」**悄悄放大**成「整个项目都守」，那是最坏的一种「看起来存成功了」（`note` 仍按 `model`/`skill` 旧例空串即丢，它不承载作用域）。**跨面同键的不对称处置**（§十二-6）沿用：同一 `file` 在两个面各登记一枚时，反向引用账逐条记全、正向能力快照跳过歧义项（全跳过给 `null` 不给 `[]`）；而作用域改了**算快照的账**——快照抄整份 spec，所以 `specSha` 随 `repo`/`pathsGlob` 变（换作用域=换约定，不是换引用）。机证：server **62 文件 / 960**（A5-1 收口时 937）· web **12 / 107**（104）· cli **3 / 75**，全绿；根 `typecheck --force` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功；新增判据分布在 7 枚文件——`orchestrate/registry`（探针矩阵：live／无作用域 live／文档缺 missing／仓目录缺 missing 带「永远不会被注入」／`..` 越界 missing／glob 不判→live／无 rootCwd unknown／幽灵空间文案「不等于这篇约定不存在」＋ label 两枚括注形状）、`registry-check` 单元（词表 + 槽翻面）、`api/registry-check`（同路径的 skill 条目**不算** rule 命中——两 kind 各判各的）、`registry-refs`（承接后的引用账：角色 `rules[]` 与空间 `rules[i].file` 两面各指同一枚条目）、`registry-snapshot`（整份 spec 进账、`repo` 目标不解析成 rule）、`engine-requires`（登记前拒起单／登记后同图放行）、`api/registry-routes`（POST kind=rule 的 label 人话 + `pathGlob` 拼错→400）。**改口入账**（§十二-8）：`rule` 自此再也发不出 `?` 那句，六处拿它当「未迁示例」的断言换成 `repo`（`orchestrate/registry-check` 的 unjudged 槽 ×2、`api/registry-check` fixture 槽、`engine-requires` 那条「未迁不拦」、`registry-refs` 未迁清单与 `requires` 第 5 槽、CLI 的 `?` 槽与「需要：模型 3 · 仓库 1」行、web 的 pending 组与 `need` 标签行）——**只换例子，没放宽任何判据**，`git diff` 里新增 `it(` 行 22（server）+ 4（web），被删的两行都只是同一测试改了标题里的 kind 名（server 那条 unjudged 判据、web 的 A5-1 `skill-files` 旧字面），测试条数只加不减。**诚实边界两条**：①`rule` 探针与 skill 同款不进缓存层，`--refresh` 是 no-op；②表单的实机浏览器核对仍欠——本机 4310 跑的是 09-26 dev 实例，这一版前端与后端都不在它身上（`?kind=rule` 在那台实例上照旧 400），与 X3/A5-1 是同一次重启 |
| A5-3 | `repo` 进注册表（登记项第五枚；§十二-9 形状决议的第三片，也是「一盘两制」那一处收口） | **已完成（本片）** | 本片 | **可感面**：`paneflow registry list` 多出「仓库」分组（组名仍只住 server 那一处词表）；`paneflow registry probe repo:<id>` 问的是**目录面**而非文件面——`live`＝「项目「X」下有这个目录（改动于 …）· 是 git 工作区（看到 .git）」，目录在但没 `.git` 仍 `live`、只把落差写进 detail（「登记的是目录不是仓，家规真拉分支时会撞」——不是「不存在」就不判死）、没有/不是目录/`..` 越出主仓根＝`missing`、项目没这枚档案或没配 `rootCwd`＝`unknown`（「未探得，不等于这个仓不存在」）；**语义变化一处**：`registry check --template x` 里 `kind:'repo'` 的槽从 `?`（不拦）翻成 `✓/✗`，起单口同尺 fail-closed（`engine-requires` 那条就是「没登记即拒、登记后放行」）；同时三处裸串（`profile.repos[i]`／`rules[i].repo`／`delivery[i].repo`）从 `unmigrated` 只报计数变成**一条边**——于是删一枚还在被档案用的仓会被 400 拒掉，并把「项目「demo」的 repos[0]」这个位置一次给够；网页「注册中心·新增」长出 repo 四键（`所属项目` 下拉 + `仓库目录` 文本框+datalist `space-repos` + `远端仓` 纯文本 + `备注`，必填只有 `space`/`dir`）。**形状**（§十二-9）：`spec={space,dir,origin?,note?}`，**两套命名空间分开放**——`dir` 是相对主仓根的目录名（现网那三处裸串吃的都是它）、`origin` 是 GitHub 的 `owner/repo` 或完整 clone URL（`contract.repo`／`dispatch --repo` 那一形）；引用写法是 `id`/`slug`/`dir`/`origin` 四枚，外加**归一名那一趟双向**：`refKeys` 把条目存的 origin 过一遍 `parseGithubRemote`（存 URL ⇒ 也认 `owner/repo`），Descriptor 新添的可选 `normalizeTarget` 把**发来的裸串**也过同一把尺（存 `owner/repo` ⇒ 也认 URL）——只归一一侧就是拿一半写法冒充「同权」，而 `candidateRepos` 外发给用户的恰好是 `owner/repo` 那一形。归一只在比对那一瞬间发生，**存原样**不变（快照与 `specSha` 抄的仍是用户写的那串字节）。`origin` 给了就得是非空串（空串占位＝一条永远指不到的裸串），`note` 空了整键不发。**目录名跨空间可撞**：空间自己发的引用按 `spec.space` 收窄（判得准），`requires`/角色面不绑空间故不收窄（收窄=替作者编约束，与 skill/rule 同一处理）；按 origin 点名的写法**不**收窄（那本来就是全局标识）。**作用域不是引用**：`dir` 之外的收窄键不进 `refKeys`。机证：server **62 文件 / 984**（A5-2 收口时 960）· web **12 / 109**（107）· cli **3 / 75**，全绿；根 `typecheck --force` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功；新增 `it(` 24 条分布在 7 枚文件——`orchestrate/registry`（形状四拒＋必填／label 括注 origin／`refKeys` 存 URL 多列归一名、没有 origin 不硬造、自建域不归一／**双向同权**：存 `owner/repo` 时三种 URL 写法都命中且 URL 不在 `refKeys` 里（证明走的是 target 归一不是多存键）、`git.internal` 域与别的 owner 照指不到／探针五态＋`origin 不实读`／跨空间收窄与 origin 不收窄／三处裸串各归各类）、`registry-check` 单元（五枚写法＋**反方向那条**＋中文名不是引用写法＋目录名不收窄＋死缺记 judged＋宽槽与停用）、`api/registry-check`（登记那枚仓之后同一张模板由拦变放）、`engine-requires`（repo 槽拦起单：没登记即拒，`dir` 与 `origin` 两种写法都放行到完成）、`registry-refs`（`repo` 承接后的引用账与「同一枚目录名各归各类」）、`api/registry-routes`（POST kind=repo 走完整条路：`?kind=repo` 不再 400、探针 live、refs 边、拒删、`originu` 拼错 400）、`registry-view.test`（四键长法＋必填两枚＋`origin` 原样透传不剪 URL）。**改口入账**（§十二-8）：`repo` 自此再也发不出 `?` 那句，替身换成 `role`（`orchestrate/registry-check` 的 unjudged 槽与分组读数、`api/registry-check` fixture 槽、`engine-requires` 那条「未迁不拦」、`registry-refs` 未迁清单与 `requires` 那一槽、CLI 的 `?` 槽与「需要：模型 3 · 角色 1」行、web 的 pending 组／`need` 标签／detail 行／「没挂号的 kind 不临场发明字段」示例）——**只换例子，没放宽任何判据**，`git diff` 里被删的那一行只是同一测试改了标题里的 kind 名，测试条数只加不减；另把 §十二-9 早写下的一句「`A5-3 之后的改口替身＝role`」留在文档里，下一片不用再判一次。**诚实边界四条**：①探针**不起子进程**——`origin` 与真仓 remote 符不符这一版明说不核（detail 原话「按登记原样存，这一版探针不实读核对」），实读归派发现场 `candidateRepos` 那一把尺，两处判据迟早分出两个答案；②`repo` 探针与 skill/rule 同款不进缓存层，`--refresh` 对它是 no-op（CLI 不拿旗标撒谎）；③`远端仓` 那一格**故意不给候选池**——拿别条目已登记的 origin 当 datalist 会诱人把同一枚远端仓登记第二枚（重复条目比少一格候选贵得多），只有 `仓库目录` 吃 `profile.repos[]` 这份真源；④表单的实机浏览器核对仍欠——本机 4310 跑的是 09-26 dev 实例，这一版前后端都不在它身上（`?kind=repo` 在那台实例上照旧 400），与 X3/A5-1/A5-2 是同一次重启 |
| A5-4 | `check-type` 进注册表（视图 kind 第一枚；§十二-10 形状决议） | **已完成（本片）** | 本片 | **可感面**：画布节点属性「检查门禁」从此**六型全加得出来**——此前那里是一份硬编码四枚按钮（`file-exists`/`command`/`regex`/`manual`），`contract` 与 `delivery-branch` 引擎认得、`requires` 与机检账也都算得，**但页面上根本点不出来**，这是本片唯一净新增的用户可见能力（两枚各带自己的编辑器：`contract` 填契约骨架戳 `template=id@sha`、`delivery-branch` 填期望分支，留空各回落「家规渲染」与 `pf/<runId>`）；按钮与检查行的措辞改吃注册表条目（`label`＋`hint` 当 title＋一枚「引擎实跑/人看一眼」徽标），不再是页面自己那份字符串表；`paneflow registry list --kind check-type` 出「机检」分组与「被 N 处使用」，`registry get check-type:file-exists` 逐条列引用出处（`template · 「x」 · nodes[0].config.checks[0].type`）；**语义变化一处**：`registry check --template x` 里 `kind:'check-type'` 的槽从 `?`（不拦）翻成 `✓/✗`，起单口同尺 fail-closed——写错一个字母的 `file-exis` 从此在派活前就被点名到第几格第几项；能力快照 `cap#` 自此把机检条目也记进账，于是**同一张图在 A5-4 前后起单会得到两个不同的 `cap#`**（历史 run 吃自己落册那份副本一字不动；等臂对照时这一刀是版本带来的、不是这一单换了配置——已同时写进 `registry-snapshot.ts` 注释与本决议 §十二-10）。**形状**（§十二-10）：视图 kind——六枚条目由 `shared/dag.ts: CHECK_TYPE_CATALOG` 现算、不落 `entries.json`、三写动词全拒；`spec={label,hint,machine}` 只带**画法与机检口径**，执行体与 `CheckSpec` 判别联合留在引擎（红线七）；`CHECK_TYPE_CATALOG_BY_TYPE` 是 `Record<CheckSpecType, 条目>` 所以「表里六型」与「引擎认得六型」编译期就锁死，不会长第二把尺；`MACHINE_CHECK_TYPES` 自此**由 catalog 的 `machine` 派生**（v13-V1 机检账 `machineCheckTally` 的分母此前是手抄的第二份清单，那是两处事实源）；`machine` 必填且必须是布尔（缺省猜 `true`＝把「人工确认」计进机检侧分子）；引用写法两枚 `id`/`slug`，中文显示名「文件存在」与机检口径「人看一眼」**都不算**引用写法（与 model 中文名、agent-kind 探测名、mcp `command` 同一把尺）；探针通道**刻意不开**（与 `node-type`/`mcp` 同判据：这一型的正身就是代码），`health` 整键不给、界面上天然没有那颗点。机证：server **62 文件 / 1000**（A5-3 收口时 984）· web **13 / 116**（109；web 多出 `check-types.ts` + `check-types.test.ts` 两枚文件）· cli **3 / 75**，全绿；根 `typecheck --force` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功；新增 16 枚 `it(`（server）分布在 5 枚文件——`orchestrate/registry`（5 条：清单↔值域编译锁 + `MACHINE_CHECK_TYPES` 派生 + 在 `REGISTRY_VIEW_KINDS` 里／spec 三键白名单七枚脏样例全拒（`mchine` 拼错、label 缺或空、hint 缺或空、machine 缺或非布尔）／一条没登记也出厂六行且逐字段等于清单且**不建 `registry/` 目录**／三动词全拒（「加一型机检＝改引擎，注册表不代造跑不了的检查」）／两枚写法同权 + 中文措辞不算）、`registry-refs`（4 条：每枚 `checks[].type` 挂到出厂条目并指得到第几格第几项、`requires` 里 id 与机器值同权、`file-exis` 判 dangling（以前只数不判）、中文名不指向）、`registry-check` 单元（3 条：命中即过而写错一型＝missing 且拒单、宽槽在表上就过且分组记中文组名「机检」、`need` 行形状）、`registry-snapshot`（3 条：三道不同的检＝三条账按 id 排且整份 spec 抄进账且同型两次合并 `via`、不喂 `readView().entries` 时机检那枚整个丢掉、清单外的型不进快照）、`api/registry-routes`（1 条 + 三处词表：`?kind=check-type` 出厂六型上架与画法字段齐、POST 照拒；`knownKinds`/`viewKinds`/`kindLabels` 各加一枚）；`api/registry-health` 另加一条断言钉「**`check-type` 行不带 `health` 键**」（无通道是裁决，界面上不能长出一个假点）；web 7 条（`check-types.test.ts`：六型全出按钮／`undefined` 只给空读数**绝不拿 `CHECK_SPEC_TYPES` 兜出一份清单**／停用、本 bundle 不认识的型、缺 label、缺 hint、`machine` 非布尔五路各进 `unusable` 带一句人话／`blankCheck` 逐型出厂形状）+ `registry-view.test` 的 `machine` 布尔行（首个布尔 spec 键，渲染成是/否）。**改口入账**（§十二-8）：`check-type` 自此发不出 `?` 那句，替身**照 §十二-9 末句留在 `role`**（A5-4b 才迁它，这一片不用再判一次）；`registry-refs` 的未迁清单摘掉 `check-type`、`registry-check.ts` 与 `registry-snapshot.ts` 两处注释里的「未迁示例」与「视图 kind 两枚」改口成三枚、AGENTS.md 的判活 kind 行与注册中心段照改——**只换例子，没放宽任何判据**：`git diff` 里被删的断言只有示例 kind 名与计数（行数一律 `+CHECK_TYPE_CATALOG.length`），测试条数只加不减（server 984→1000、web 109→116）。**诚实边界四条**：①没有探针通道不是漏写——`registry probe check-type:*` 明说「这一类没有探针通道」，那一格永远不画点；②表里加第七行**不会**让引擎真跑一个不存在的校验器（执行体住代码），新增校验器仍是一次代码改动，这一枚「正身就是代码」的代价与 `node-type` 一字不差；③`cap#` 因本片而变，跨 A5-4 做等臂对照时要把这一刀算进版本而不是配置；④画布与表单的实机浏览器核对仍欠——本机 4310 跑的是 09-26 dev 实例，`?kind=check-type` 在那台实例上照旧 400，与 X3/A5-1/A5-2/A5-3 是同一次重启 |
| A5-4b-1 | `role` 进注册表（视图 kind 第二枚；§十二-11 形状决议——「正身」第一次不是代码而是盘上的用户数据） | **已完成（本片）** | 本片 | **可感面**：`paneflow registry list` 多出「角色」分组（组名仍只住 server 那一处词表），注册中心第一次能看清「本机有哪些岗、每枚被几处用着」；`paneflow registry get role:<id>` 的 label 是 `「交付岗」· 钉档 claude`（没钉就整段省略，不写「没钉档」冒充读数），下面逐条列引用出处（`space · 「demo」 · team[0].roleId` / `template · 「x」 · nodes[0].config.role`）；**语义变化一处**：`registry check --template x` 里 `kind:'role'` 的槽从 `?`（不拦）翻成 `✓/✗`，起单口同尺 fail-closed——模板 `requires` 指一枚名册里没有的岗，派活前就被点名，而 `requires: [{kind:"role",id:"r-deliver"}]` 从此指得到人。**新增对外读数 `viewHomes`**：`GET /api/registry` 与 `GET /api/registry/:id` 各带一张「这一类的正身在哪儿」的逐 kind 表（`role`→「角色库那一面（岗位在那儿建、改、删；注册表只是它的镜子）」，其余三枚→代码），网页组徽标由「内置清单」改成**「现算清单」**并把 title 与详情注释换成这张表给的原话，CLI 视图项那一行同吃（`视图项（成员由角色库那一面…现算出来）：不落盘，改不了也删不了`），两枚时刻表头读「本机自/本次运行」——server 没给这张表（旧实例）就回落成不带 kind 的通用措辞，**不拿猜的形容词盖在用户自己建的岗位上**。`role` 不挂「新增登记」下拉（挂上去＝点开却登记不了的假可点）。**形状**（§十二-11）：`spec={label, agentKind?}`——`label` 必须是非空串（岗名）、`agentKind` 给了就得是非空串，**存在性不在这儿判**（写入面不判存在性那条老规则照旧）；条目 `id=registryId('role', 名册id)`、`name`=名册原值（大写 id 靠它才指得到）、`source:'user'`、`enabled:true`、时刻=进程启动那枚 `BOOT_AT`；`VIEW_BUILDERS` 与 `VIEW_HOME` 都写成 `{ [K in 视图 kind]: … }`，加第五枚视图 kind 而忘写正身去处就编译不过（与 §十二-10 ①同术）；引用写法三枚 `id`/`slug`/`name`，**岗名不算**；探针通道刻意不开。脏读数处置：名册 `ENOENT`=空组正读数、零披露，坏 JSON／顶层非数组／无 id 行／重复 id／缺岗名／`agentKind` 破烂各进一条披露并入 `rejected`（只披露不清除，与引擎侧 `loadRoles()` 的静默降级分家）。机证：server **63 文件 / 1023**（A5-4 收口时 62/1000；文件 +1＝新增 `orchestrate/registry-view.test.ts`）· web **13 / 117** · cli **3 / 76**，全绿；根 `typecheck` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功；测试**净增 25 条**（server 1000→1023、web 116→117、cli 75→76），只加不减，其中 `orchestrate/registry-view.test.ts`（本片新文件，12 条）逐条是：ENOENT 正读数／两枚岗逐键如实／**大写 id 的岗**（slug 被小写化但 `name` 存原样，所以那枚引用指得到）／坏 JSON 与非数组各进一条点名 `roles.json` 的披露／非对象行与 id 破烂不渲条目／同 id 两枚第一枚赢（与引擎 `find` 同一把尺）、第二枚披露／缺岗名时 label 回落用 id 且明说不是替它起名／`agentKind` 脏值既不当钉档渲也不当「没钉」／四枚视图 kind 各有各的拒写句（拿「由代码决定」拒岗位＝假路标）／拒写句动词跟动作、去处跟 kind／`registryViewEntries` 一次并四枚且披露也并进 `rejected`。其余 13 条净增分布在 6 枚文件——`orchestrate/registry-check`（命中写法两枚同权且岗名不算／大写 id 靠 `entry.name` 指回／指不到＝missing 且 `unjudged` 清空／宽槽「名册有岗就行」／分组记中文组名「角色」且 judged 全算）、`registry-refs`（名册岗渲成条目且班底绑定与节点绑岗各得一条出处／整 id 与 roleId 原值同权／名册里没有的岗判得出死活＝dangling（以前只数不判）／配置里写岗名不指向）、`api/registry-routes`（`GET ?kind=role` 名册现算上架、脏行只披露、写入面照拒并指路角色库）+ `viewHomes` 四断言（键集=`viewKinds`、`role` 含「角色库」且**不含**「版本自带」、`agent-kind` 含「代码决定」、`node-type` 逐字等于 `viewHomeOf`；`GET /api/registry/role%3Ar-deliver` 也带 `viewHomes.role`）、`engine-requires`（role 槽自此判死活：名册有那枚岗就放行、没有就拒）、`orchestrate/registry`（视图项在表上而注册台账无文件／`compareEntries` 吃 `REGISTRY_KINDS` 顺序）；`api/registry-health` 另加一条断言钉「**`role` 行不带 `health` 键**」（无通道是裁决，界面上不能长出一个假点）；web 4 条（`viewHomes` 逐 kind 带到 `KindGroup.home`、旧 server 缺键时 `home` 键**不存在**而非默认值、`whenLabels(view, home)` 两形、非视图项永不带注释）+ cli 2 条（`registry get` 视图项正身吃 `viewHomes`、缺键回落且不画「登记于」）。**改口入账**（§十二-8）：`role` 自此发不出 `?` 那句，替身换 `template`（CLI 的 `?` 槽与「需要：…」行、web 的 pending 组／`need` 标签／detail 行／「没挂号的 kind 不临场发明字段」示例、`registry-check` 与 `api/registry-check` 的 fixture 槽、`registry-refs` 未迁清单、`formFieldsFor` 的 null 例子）——**只换例子，没放宽任何判据**，测试条数只加不减（server 1000→1023、web 116→117、cli 75→76）；§十二-9 与 §十二-10 末句那两句「替身留在 `role`」照此改口成「A5-4b-1 已迁它，自此替身＝`template`」。**诚实边界五条**：①注册表是镜子不是账本——岗位的建/改/删全在角色库，三写动词拒且拒句带去处；②**删除侧的闸这一片没装**（当时）：`PUT /api/roles` 那天不查引用账（R2 的拒删只长在注册表写动词上，而 `role` 没有写动词），删一枚还在被班底或模板引用的岗**不会被拦**，本片只做到「引用指得到、出处看得见」，这一笔欠账记在 §十二-11 与 A5-5a。**A5-5a 已把闸装到正身面**——`guardOnDiskDeletes(dataDir,'role',…)` 读的就是本片建的那本引用账，判据没第二处；③没有探针通道＝那颗健康点永远不画，「名册读不动」只能靠披露行说，不假装探过；④`cap#` 因本片而变，跨 A5-4b-1 做等臂对照时这一刀算版本不算配置；⑤网页与 CLI 的实机核对仍欠——本机 4310 跑的是 09-26 dev 实例，`?kind=role` 与 `viewHomes` 在那台实例上照旧读不到，与 X3/A5-1/A5-2/A5-3/A5-4 是同一次重启 |
| A5-4b-2 | `template` ＋ `gateway-profile` 进注册表（视图 kind 第三、四枚正身在盘上；§十二-12 形状决议，也是 §十二-1 清单的最后两枚） | **已完成（本片）** | 本片 | **可感面**：`paneflow registry list` 多出「模板」与「网关档」两个分组（组名仍只住 server 那一处 `kindLabels`，CLI 没添第二份词表）；`registry get template:<文件名>` 的 label 是 `「my-flow」· 7 个节点 · 一句话说明`（没有说明就整段省略，`nodes:0` 画得出「节点数 0」——那是「一张空图」这个**正读数**，与「读不出」分家），下面逐条列引用出处（`template · 「x」 · nodes[2].config.pipeline.template` / `gateway · 「默认档」（default） · current`）；**语义变化两处**：`registry check --template x` 里 `kind:'template'`/`kind:'gateway-profile'` 的槽从 `?`（不拦）翻成 `✓/✗`、起单口同尺 fail-closed（`engine-requires` 那条就是「盘上没有那张图/那一档即拒，写进盘就放行」），而**网关整表从此有出处**：`gateway.json` 的 `current` 那枚裸串以前只落 `unmigrated` 计数，现在是一条 `via:'current'` 的边（`registry-health` 钉住）；网页「注册中心」两张盘的组各带正身徽标（「编排模板那一面…」「网关设置那一面…」来自 `viewHomes`），且视图项的「启用」那一格从此有两种读数——`enabled:false` 的网关档画**「停用中」**（title：「这一项在网关设置那一面里是停用状态：注册表只照读，启停不在这里按」），而不是像前四枚那样一律画「—」。**形状**（§十二-12）：`template.spec={nodes,description?}`、`gateway-profile.spec={label,baseUrl?,freeModel?,keyConfigured}`；机器值两枚不同源（**文件名去 `.json`** ／ **档 id 原样**），图内 `name` 与文件名不一致时以文件名为准并落一条披露；引用写法各三枚（id／slug／机器值原样），第三枚是因为 `registryId()` 小写化 slug 而 `saveGraph`/`upsertGatewayProfile` 收大写；**图内 name、档名、`freeModel` 都不算**引用写法；`apiKey` 在这面根本不出现（只有 `keyConfigured` 必填布尔，缺省当 `true` 就是把裸档说成能跑），序列化断言 `not.toContain('sk-secret'/'sk-route')` 逐处钉死；`GatewayDoc.current` 不进任何条目 spec（换档不抖 `specSha`）；两枚都**不挂探针通道**（`health` 整键不给）；脏盘按**条目 id** 去重（`a b.json` 与 `a-b.json` 归一撞车时只渲第一条并披露——说「有两枚」就是假账），`nodes` 非数组／档 id 缺／同 id 第二行／`baseUrl` 空串各进一条披露且**不渲 0**，`ENOENT`=空组零披露零条。**R5 快照随片改口**：`gateway-profile` 进表后这一单吃的那一档自己进 `capabilityRefs`（`via:['gateway·current']`，`engine.test.ts` 逐键钉形状且整份记录搜不到密钥），于是同一张图跨这一刀有两个 `cap#`（历史单吃落册副本不变）。机证：server **63 文件 / 1046**（A5-4b-1 收口时 1023，**+23**）· web **13 / 120**（117，+3）· cli **3 / 76**（0，本片 CLI 没有新判据：分组与组名照旧从 server 的 `kindLabels`/`viewHomes` 读），全绿；根 `typecheck` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功（chunk-size 警告是既有形状）；新增判据分布——`orchestrate/registry-view.test.ts` 14 条（模板盘 7：目录不存在＝零条零披露且**不建目录**／两张贴图逐键如实／文件名≠图内 name／单张读不出逐文件披露其余照给／两图归一同一枚 id 只渲第一条／`registryViewEntries` 一次并六枚且披露并进 `rejected`／六枚视图 kind 各有各的拒写句；网关盘 7：两档上架且整条搜不到 apiKey／`enabled:false` 照渲／旧扁平格式包成「默认档」（与运行面同一包装）／盘读不出＝点名 `gateway.json` 一条披露／脏行逐条披露其余照给／大写档 id 靠 `name` 原样指回／`current` 是文档级读数不进条目）；`registry-check` 单元 6 条（模板两枚写法同权且说明句不算／大写文件名靠 `entry.name` 指回／指不到＝missing 且 `unjudged` 清空（翻转留字为证）／宽槽「盘上有模板就行」且空图可用／档位三枚不算引用写法／两枚分组各记中文组名且 judged 全算）+ 未迁 stance 由 `channel` 继续样本化 1 条；`registry-refs` 3 条（`channel` 替身样本＋template/gateway-profile 自此落 dangling＋运行时变量槽不算引用，见下「实机首验」①）；`api/registry-routes` 1 条（`?kind=template`/`?kind=gateway-profile` 两张盘现算上架、脏行只披露、POST/DELETE 各自指路自己的那一面、且不建 `entries.json`）+ 三处词表（`knownKinds` 11 枚、`viewKinds` 6 枚、`kindLabels` 两枚）；`api/registry-health` 2 条（`current` 那枚裸串有出处且 `health` 整键不给／六枚视图 kind 同表上架、`unmigrated` 改口为 0）；`engine-requires` 1 条（两枚槽自此判死活）；`orchestrate/registry`（`registry.test.ts`）两处视图全集断言补两张盘样本；web 3 条（`viewEnabledCell`：停用中那句不带「点击」／有正身与无正身两种回落／非视图项不走这里）+ `specRows` 两枚新读数（`nodes:0`→「节点数 0」、`keyConfigured:false`→「配了密钥 否」）。**实机首验补掉两处假读数**（这一片第一次在真 CLI 上跑通两张盘：`PF_DATA_DIR=$(mktemp -d) PF_PORT=4399 pnpm dev:server` 起一次性实例、`PANEFLOW_URL=http://127.0.0.1:4399 pnpm paneflow registry list/get/check`，单实例锁在 dataDir 内所以不碰本机 4310 的在飞单；验完即关进程并删临时盘）：①**运行时变量槽不是引用**——出厂 `builtin-issue-triage` 在 `nodes[i].config.pipeline.template` 写的是 `{{triage.artifact.extra.suggestedTemplate}}`（起单时才解析成图名）。`template` 进表前这串埋在 `unmigrated` 计数里看不见，进表后引用账替它断了一条「盘上没有这张图」的**假悬挂**（单测 fixture 全用真图名，所以只有实跑才露）。窄闸 `registry-refs.ts:isRuntimeVariableSlot` 只把**整串就是 `{{…}}`** 的 target 从引用账剔掉：`fix-{{x}}` 仍算引用、`nodes[0].type` 这类裸串仍建边、`run.graph` 是替换后的实态所以 R5 快照零影响；机证 `registry-refs` 新增 1 条（4 断言，正是上面那三条不放宽加一条为空）。实机 `dangling` 由 2 处收到 **1 处**（只剩 fixture 里真不存在的 `model → gpt-9`），`unmigrated` 归零。②**注账栏的标题在说谎**——`rejected` 从这一片起有两种行：渲不出条目的坏行，以及**条目照渲、旁边要补一句**的落差行（实跑真撞上「文件名 `Fix-Issue` ≠ 图内 `name` `fix-issue-renamed`，条目按文件名渲」那条披露）。旧措辞「本机不认的条目／不计入下表」对在表上明晃晃摆着的那一行是假话，而用户读到它会以为整组读数都不可信。四处一并改口：CLI `registry list` 的标题→`⚠ 照读时的一句话（只披露不清除）`、且**单独成一节**带计数标题（原来两空格缩进直接续在最后一组下面，会把注账读成「网关档那一组的问题」）、web `rejectedSummary`、`server/orchestrate/registry.ts` 与 `web/src/registry-view.ts` 里 `rejected` 那两枚字段的注释、AGENTS.md `registry list` 那行；两侧测试各钉一句反例 `not.toContain('本机不认')` / `not.toMatch(/没被认出\|本机不认/)`——**改的是措辞与取样，判据一条没放宽**（`web 120`、`cli 76` 条数不变；server 那条 `registry-refs` 新判据让 1045→1046）。③页面这一侧的同一条措辞本轮只在单测层证到，浏览器实机核对与下面第⑥条是同一次重启的账。**改口入账**（§十二-8）：`template`/`gateway-profile` 自此发不出 `?` 那句，替身换 `channel`（CLI 的 `?` 槽与「需要：模型 3 · channel 1」行、web 的 pending 组／`need` 标签／detail 行、`registry-check` 的 fixture 槽与「没挂号的 kind 不临场发明字段」示例、`registry-refs` 未迁清单与 `requires[4].id`、`engine-requires` 那条「未迁不拦」）——**只换例子，没放宽任何判据**，测试条数只加不减（server 1023→1046、web 117→120、cli 76→76）；HTTP 整表面的 `unmigrated` 断言由 `1` 改口成 `0` 是**判据翻面的正读数**不是放宽（那条 stance 搬到判据层手喂样本继续钉，两处各有名字）。**诚实边界六条**：①注册表是镜子不是账本——模板的建/改/删全在画布、档的配/改/删全在「设置·网关」，三写动词拒且拒句带去处；②**删除侧的闸这一片仍未装**（当时，与 role 同一笔欠账）：从画布删一张图不查引用账、把档从网关盘删掉也不查，那是 A5-5a 的账——**A5-5a 已还**：`DELETE /api/graphs/:id` 与 `DELETE /api/gateway/profile/:id` 与 `PUT /api/roles` 三面各接同一条 `guardOnDiskDeletes`；③「停用中」是**照读**不是开关——启停永远不许在这面点（`viewEnabledCell` 的文案断言 `not.toMatch(/点击\|开关/)` 钉住），前四枚视图 kind 无 `enabled` 落差照旧画「—」；④`cap#` 因本片而变（模板/网关档进账），跨 A5-4b-2 做等臂对照时这一刀算版本不算配置；⑤两枚都没有探针通道＝那颗健康点永远不画，「盘读不动」只能靠 `rejected` 那行披露说，不假装探过；⑥实机核对分两半，欠的那半要说清：**CLI 这一半已在一次性实例上真跑过**（`PF_DATA_DIR=$(mktemp -d) PF_PORT=4399` 起临时实例，读回 `· 模板（11 项）`／`· 网关档（2 项）`／`gateway-profile:gw-main 「主档」 · https://gw.example · 已配密钥 被 1 处用`，整表搜不到 `apiKey`——上面「实机首验」那两处假读数就是这一跑抓出来的，单测没抓到）；**网页那半与本机 4310 照旧欠**——那台跑的是 09-26 dev 实例，`?kind=template`/`?kind=gateway-profile` 与 `viewHomes` 两枚新去处在它上面读不到，与 X3/A5-1…A5-4b-1 是同一次重启的账。
| A5-5a | 删除侧的闸：三枚「正身在盘上」的视图 kind 各自的写路径自此查引用账（§十二-11 与 A5-4b-2 诚实边界② 记了两次的那笔欠账） | **已完成（本片）** | 本片 | **可感面**（三面各一句 server 原话，页面不另造措辞）：①**角色库**（`PUT /api/roles` 是整本名册覆写，「删一枚岗」＝这次没再带上它）——撤下还被班底与画布指着的那枚岗，整次覆写被 400 拦下、名册一个字节不动，页面回执「保存失败，改动还在草稿里：「r-deliver」还被 2 处引用着（项目「演示项目」的 `team[0].roleId`、模板「flow」的 `nodes[0].config.role`），删除会把这些引用变成悬挂引用——先改掉那几处再来。」，草稿留在未保存态（`committed` 不升格，红点还在）；②**网关删档**（`DELETE /api/gateway/profile/:id`）——被某个项目钉档的档删不掉，回执「删档失败：…（项目「demo」的 `gatewayProfile`）…」且档仍在列表里（`refresh()` 重读盘），而**只被 `current` 指着的生效档照删**（删完顺延，`{ok:true, current:'paid'}`）；③**画布删模板**（`DELETE /api/graphs/:id`）——别的图把它当子流程/兜底模板指着时 400 点名「模板「main」的 `nodes[0].config.pipeline.template`」，文件仍在；自指（图里 `pipeline.template` 指自己）删得掉，因为那条边随文件一起消失。AGENTS.md 的 `registry` 段补了这一组语义（三面 400 列引用者、`current` 那一格不算引用者、引用账扫不出→500 不放行）。**判据只有一处**：新增 `orchestrate/registry-gate.ts:guardOnDiskDeletes(dataDir, kind, targets, opts)`——它**不做任何字符串比对**，现读 `registryViewEntries` + `readReferenceIndex`（与注册中心同一本账），拿 `refsForEntry` 反查；`registry-routes.ts` 里那句「被谁在用」的拒答画法（`FACE_CN` + 句式）收进这一枚模块共用，注册表写动词面与三枚正身面从此说同一句话。**四条形状约束**：①整批 targets **逐枚**判，拦在第一个删不动的那枚（PUT 是原子的，所以拦就拦下整次）；②`via:'current'` 不算引用者——删生效档会顺延，不产生悬挂；真拦的是 `SpaceProfile.gatewayProfile` 那种**别处**指着它的边；③`template` 的自指剔除走 `opts.selfIds`，且**只给图内 `name`、不给文件名**（referrer 的 id 一律是图内 name，把文件名塞进黑名单会连「另一张图的 name 恰好等于被删的文件名」那笔**真引用**一起洗掉）；④**扫描抛错一律 500，不放行**——把「读不出」降级成「零引用」就是给删除开绿灯，那是 R2 最危险的假绿；正身条目读不出来时（盘上脏了或重名被去重）回落 `index.dangling` 的 by，拒句先明说这一枚在镜子里读不出、下面列的是裸串原文。**机证**：server **65 文件 / 1067**（A5-4b-2 收口时 63/1046，**+21**＝新增 `orchestrate/registry-gate.test.ts` 14 条判定层 + `api/http-registry-gate.test.ts` 7 条路由面，文件 +2）· web **13 / 120**（条数不变，本片 web 零新判据）· cli **3 / 76**（不变，CLI 没有删除面）；根 `typecheck` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功（chunk-size 警告是既有形状）；新增两条都**不桩判据**——判定层 fixture 手写真实落盘形状（项目档案、`roles.json`、`graphs/*.json`、`gateway.json`），HTTP 面走真 `buildHttpServer` + `app.inject`，每面各钉三件事（闸接在这条路由上／拦下时盘面字节不动／每面一条放行路径），每一格两头断言（拦的那格点名能按图索骥的 `via` 键路径，放的那格与同盘另一枚被拦的格配对，免得「放行」被读成「读不出」）；另钉 `graphs` 摆成普通文件时 `PUT /api/roles` 得 500 且名册字节不动（这一格只能放在 PUT 面上——`DELETE /api/graphs/:id` 会先把 `Store` 构造出来、目录已被 mkdir，闸就跑不到），以及序列化断言逐处 `not.toContain('sk-secret'/'sk-paid')`（拒句里不许带密钥，R1 边界②）。**顺带修一处既有的假绿＋随机红**（不在本片计划里，是全量跑到第二次撞出来的）：`api/http-gateway-d.test.ts` 的网关 catalog 那一格，密钥哨兵写成小写 `'ka'` 而该格 `apiKey` 早已改成 `'kA'`——同文件上面就有注释记着「两字母小写串会被 `gw-<Date.now().base36>-…` 的 id 段随机撞红，CI run 36005203061 实撞过」，可那次修只换了**写入侧**的哨兵、**断言侧**漏了这一处。后果是双向的：这一格从此**测不到「密钥不外泄」**（小写串本来就不会出现＝恒真断言），又**随时随机红**（本片第一次全量 1067 全绿、隔六分钟第二次同样代码红 1 条，红的就是它——时间戳编出 `…kard…` 而已）。改口成 `not.toContain('kA')`：断言强度**恢复**而不是放宽（钉的仍是「整串密钥不得出现在返回里」），且 `kA` 含大写、结构上不可能被全小写 id 冒充。**这条先例记在这里**：哨兵一改就要连断言侧一起改，只改一侧=把一次真防护换成一次恒真。**改口入账**：AGENTS.md 里 A5-4b-1 那段「出处看得见 ≠ 删得掉…那道闸是 v14-A5-5 的账」与本文档三处（§十二-11 末句、A5-4b-1 诚实边界②、A5-4b-2 诚实边界②）**同日改口**——它们写的是「今天不查引用账」，本片之后那是假话；**只改陈述，没放宽任何判据**，测试条数只加不减（1046→1067、web/cli 不变）。**诚实边界六条**：①只读账、**只拦删除**——运行中的单一个字节没碰，写入面（存图、存档、PUT 带着被引用的岗覆写）照旧放行，「存一张指着不存在子流程的图」仍是运行时那一格的账，不在本片；②`selfIds` 剔除的依据是**名字而不是文件路径**（`RawReference` 没有逐文件出处），两张图同名时仍可能多剔一笔——彻底解法要给引用者带来源文件，刻意不铺（那会改 R2 的账形状）；③闸只认「正身在盘上」这三枚 kind，`agent-kind`/`node-type`/`check-type` 三枚正身住代码的没有删除面可拦（`registry` 那侧本来就三写动词全拒）；④Palette 的「重命名模板」＝另存新名＋删旧名，删除那一步现在可能被闸拦下——那时新模板**已落盘**，所以先把列表刷出来再说清「列表里现在两份都在」，不拿「重命名失败」冒充整件事没发生（这一格是真回归：不刷列表用户会以为改名没成，实际盘上多了第二枚）；⑤三面回执与那句重命名半成功文案，**都只证到代码与单测层**——server 的 400/500 人话经 `api.ts` 的 `json()` 抛错原样到达 toast/`pm-err`，链路是读代码确认的；浏览器实机核对与 X3/A5-1…A5-4b-2 是同一次重启的账（本机 4310 跑的是 09-26 dev 实例，`guardOnDiskDeletes` 不在它身上）；⑥本片没把网关删档那格的 `window.confirm` 换成 D3 统一小模态（它在本片判据之外，记在 better-ui 那一串的账上）——**这笔已由 UI-1 还掉**：那枚 400 拒句如今显示在确认框内部且不关窗，不再是一条会自己消失的回执。
| UI-1 | better-ui：残余原生 `window.confirm` 归位 D3 统一小模态（六处·四张面）——顺带还掉 A5-5a 诚实边界⑥ | **已完成（本片）** | 本片 | **可感面**（逐处说页面变成什么；原生框是 OS 画的、不带任何本仓措辞，从此这六处都吃 `--panel-2`/`--err`/`--accent` 那套 token）。①**已归档·真删除**（RunsCenter）：原本两次连排的原生问句并成**一枚** 400px 小模态——标题「真删除 r-xxx」+ 说明「记录文件将从磁盘移除，不可恢复。」+ 勾选框「一并清理该 run 的产物文件（…＋产物架上的整份副本；不勾则保留）」，**默认不勾**（旧文案那句「点取消=保留产物（默认）」的口径从话术落成了勾的形状）；②**运行卡片·断点续跑**：标题带 run 号，正文摊开读数「继承已完成节点 1/3：plan，失败与未执行节点将重新执行；产物黑板从源 run 载入」，主按钮「续跑」且**不亮红**（续跑开新 run、源 run 不动，不是破坏性动作），零 done 时明写「没有可继承的格，等于整单重跑」而不画一个空的「：」；③**设置·GitHub 解绑 PAT**；④**设置·接单模板 409 覆盖二次确认**（server 那句 409 原文直接当说明文字，前端不重述判据）；⑤**设置·网关删档**——就是 A5-5a 那枚删除面。⑥同四处之外的 `window.prompt` 早已为零，故本片之后**全站原生对话框归零**（grep 只剩注释里提到旧事）。**这枚模态比 toast 强的地方正是 A5-5a 那句拒答的去向**：被项目钉着的档删不掉时，「还被 N 处引用着（项目「demo」的 `gatewayProfile`）……先改掉那几处再来」现在显示在框内**且不关窗**，人来得及照着 `via` 键路径去改，改完在同一框里再点一次或 Esc 放弃——从前它是一条紧跟原生 confirm 之后、自己会消失的 `log('error')` 回执。**模态本身补两件**：`ModalCheck`（勾选框与 fields 共用一条 values 通道，勾上='1'／没勾=''，判读收在 `isChecked` 一处）；**纯确认框的焦点落脚点**——从前它没有任何可输入元素，焦点停在 body 上（Tab 序随机、Enter 不提交），现在无字段时焦点归主按钮。CSS 单列 `.pm-check`（`.modal-prompt input` 那条 `width:100%`+padding 是文本框的形状，勾选框要归位；`accent-color: var(--accent)` 跟主题）。**为什么单开 `src/dialogs.ts`**：packages/web 没有组件渲染测试（只有纯函数测试），模态的「默认勾哪一侧、文案留哪三条边界、提交把哪个开关传下去」全是判断，留在组件里等于这部分永远不会被跑到——搬进纯模块（只吃原始值+一个 `onConfirm`，不碰 store 不碰 fetch）就能断言。**机证**：web **14 文件 / 128**（+1 文件 +8 条 `dialogs.test.ts`：破坏性加料默认不勾、勾与不勾各传 `true/false`、`isChecked` 只认 `'1'`（空串与缺键都没勾）、续跑 message 的计数与清单两种形状、三枚删除类各亮红且文案钉住一条边界、409 原文一字不吞且只回调一次）· cli **3 / 76** 不变 · 根 `typecheck` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功（一键模式服务 `packages/web/dist`，源码改了不 build 等于没上线）；**server 未重跑**——`git status` 只有 web 五个文件，本片零 server 改动。**诚实边界四条**：①**浏览器实机未核**，与 X3/A5-1…A5-5a 是同一次重启的账（本机 4310 是 09-26 的 dev 实例），这片的可感面全部只证到代码+单测+build 层；②只动**呈现层**——六个动作的端点、参数、判据一字未改（`?purgeArtifacts=1` 仍是同一枚 query，`api.resumeRun` 仍是同一次 POST）；③真删除从此只问一次，勾选框是「这一次点确定的意图」，改意图不必重开框；④`WikiPublishModal` 的「我确认公开」保持它自己的勾选实现（它是一整块预览弹层，不是通用小模态的字段），没为了统一把它拆了重写。 |
| A5-5b-1 | 装备槽认 `{kind,id}` 定点引用（W 系收口第一片；§十二-14「两写法并存」裁决的落地片） | **已完成（本片）** | 本片 | **可感面**（三面各给原话，措辞只住 server 那一处）。①**CLI**：`paneflow status <runId>` 的装备行下面，落不了地的槽从此**逐格带原因**——`⚠ 装备没落地，已跳过：skill:elsewhere —— 命中的条目不属于本单所在项目（「elsewhere」挂在项目「other」），跨项目拿相对路径读文档不在注入面的口径里`；表里压根解析不到时那句换成 `注册表里解析不到可用的「skill」条目（nope）`；被 `enabled:false` 摘掉的条目也走这一句（拿停用中的条目凑装备槽就是假绿，与预检同一条判序）。**旧单措辞一字不改**：账上没有 `misses` 明细（v14-A5-5b 前落的册）就照渲 v13-W1 那句 `⚠ 装备引用不在登记清单，已跳过：ghost.md`——新单也不再拿这句话冒充引用型的毛病（裸串的毛病是「不在清单」，引用的毛病是「不属本单项目／解析不到」，两句不能互换）。②**写入面**（`PUT /api/roles`）：形状脏 → 400 `角色 r-x 的 skills[1] 形状不认：…（裸串需是该项目 skills 登记清单里的相对路径，或写 {kind:'skill',id:'…'} 定点引用注册表条目）`；形状对但注册表指不到 → 400 `装备槽里有注册表解析不到的定点引用：岗「r-arm」的 skills[0] → skill:ghost——先在「注册中心」登记那一枚（或把它换回相对路径/删掉这一格）再存名册。`；**注册表整表读不动 → 500 且不保存名册**（`注册表读不出（…）——读不出不等于装备槽没指错，这次不保存名册`）——把「读不出」降级成「没指错」就是给脏配置开绿灯，与 A5-5a 那条 500 同一判序。③**网页**（设置·角色库，角色卡展开的装备区）：新增一行 `定点引用（照注册中心条目解析，注入死活看那一面的探针）：` + 每枚引用一个 chip（`skill:deploy`，shared 的 `equipSlotLabel` 那一处措辞）带「摘掉」；既有那行 `清单外（该项目注入时跳过不注）` **只数裸串**，其「清掉」按钮自此**不碰引用格**（一键清理把人的定点引用洗掉＝拿清理毛病的名义改了配置）。勾选面仍只产裸路径。**形状**：`RoleEquipSlot = string | {kind:'skill'|'rule', id}`（shared 一处定义，`equipSlotIssueOf` 是唯一的形状尺：未知键拒、缺 id 拒、`id` 含 `..` 拒、空串拒）；解析住在新的 `orchestrate/registry-equip.ts:resolveEquipSlots`（纯函数，`entries` 与池子都由调用方给），命中走 R2 那把尺（`matchedEntries`＋描述器 `matches`），**不复制第二把池子尺**——裸串那一路直接调 `resolveSkillRefs` 本体，所以「裸串行为不变」是构造保证；`rule` 条目自带的 `spec.repo`/`pathsGlob` 交回唯一那把作用域尺 `rules.matchRules`；注入账 `NodeEquip` 多两枚可选键 `unknownRules[]`／`misses:[{axis,slot,why}]`，**都只在非空时落册**（旧单整键缺省＝没有这份明细，不拿空数组冒充「配过」）。`roleSha` 取材同步认 `unknownRules`（脏槽被改过＝这岗的配置确实变过），`misses[].why` **刻意不入指纹**（它的取材是整张注册表，别处改一枚条目就抖这岗的指纹＝拿别人的账冒充这岗的配置）。引用账多一条边：`{kind,id}` 落 `face:'role'`、`via:'skills[0]'`，于是 A5-1..A5-3 那三枚 kind 的「拒删被引用条目」闸**白捡**对装备槽生效（删除侧零新代码）。**机证**：server **67 文件 / 1090**（A5-5a 收口时 65/1067，**+2 文件 +23 条**＝新增 `orchestrate/registry-equip.test.ts` 15 条判据层 + `api/http-role-equip.test.ts` 6 条路由面，engine ⑤ 与 dispatch ⑤ 各 1 条）· web **15 / 135**（+1 文件 +7 条 `equip-slots.test.ts`：分流只数裸串／引用不算「清单外」／取消勾选不碰引用／摘引用按 kind+id 配对且同名的裸串留下／清掉留下引用与合法项／全干净时空操作）· cli **3 / 77**（+1 条：新单两行 ⚠＋旧单原句＋干净单零行 三形状）；根 `typecheck` 净 + web `tsc --noEmit` 净 + `pnpm build` 成功（chunk-size 警告是既有形状）。判据层 fixture **全走真注册表**（`new RegistryStore(dataDir).add({kind:'skill'|'rule', spec:{space,file}})` 后 `readView()`），没有手搓条目；裸串那一路另钉**逐字节对照**（同一组输入过 `resolveSkillRefs` 与过 `resolveEquipSlots`，产物相等），HTTP 面每格两头断言（拦的那格点名 `岗「…」的 skills[0]` 且 `roles.json` 字节不动／放的那格证明原样往返、引用对象不被预解析成路径、也不洗成字符串）。**实机跑过两处**：`paneflow status` 的三形状与 `PUT /api/roles` 的 400/500 都只证到单测层，**CLI 与网页那两面在本机 4310 上照旧欠实机核对**（与 X3/A5-1…A5-5a、UI-1 是同一次重启的账）。**诚实边界七条**：①**并存不是替换**（§十二-14）：本片不做任何写盘迁移——把裸串自动翻成引用会替人改写那枚岗的语义（同一篇文档在多项目各登记一枚，翻法不唯一），迁移只能是「只读报告＋人点头」；②网页点不出 `{kind,id}`（这一片的引用格只能从 API/手编名册进来），那是 A5-5b-2 的账；③「名册里还有哪些裸串在注册表里指得到」的只读报告也没做（A5-5b-3）；④跨项目的定点引用**不注、单照常绿**（只披露不拦是 R 系一贯），`enabled:false` 的条目同理——要拦就得等人裁决「装备缺失算不算红单」，本片不代答；⑤`roleSha` 跨这一刀有两个值：只有**配了脏文档槽**（`unknownRules` 非空）的岗会变，干净名册逐字节不变（空数组不入取材是刻意的）——跨 A5-5b 做岗位级 A/B 对照时这一刀算版本不算配置；⑥`resolveContext` 里 W1 那根兼容带（`role?.skills === undefined ? pool : resolved.skills`）仍留着：键缺省＝没配槽、吃项目全量这一格语义没动，本片只改「配了槽时怎么解析」；⑦注入面之外的一切照旧——`registry check` 的 `skill`/`rule` 槽判序、探针三态、R5 快照，一个字节没改。 |
| A5-5b-2 | 勾选面点得出引用（W 系收口第二片；A5-5b-1 诚实边界② 记的那笔欠账） | **已完成（本片）** | 本片 | **可感面**（只一面：设置·角色库的装备区，且只改「点得出来」这件事）。角色卡「自带装备」那一段现在是**上下两列**（角色卡走 `.role-roster` 的 ~260px 栅格，塞不进左右两栏）——前列 `技能（来自各项目的 skills 登记）` 照旧产**裸相对路径**，后列新增 `定点引用（注册中心条目：认那一枚自己登记的文档，不吃本项目的清单）`，每行是「条目登记的文档路径 + 右侧灰字项目名」，勾它产 `{kind:'skill'|'rule', id:'<整枚条目 id>'}`（**原样 `entry.id`**：不 trim、不小写、不换成 `spec.file`——换了就不是定点引用，大写 id 全靠这一枚才指得回来）；`装备来源` 下拉的文案同步改成 `自带装备（勾项目登记清单 / 注册中心条目）`。三种空态分得开：注册中心那一刀**没读到** → `注册中心那一刀没读到（上面的勾选不受影响）`；读到了而**表里这类还没有条目** → `注册中心里还没有这一类条目（先去登记一枚，才能定点引用）`；两者的差别是「不知道」与「正读数零」，拿空列表冒充后者会把人的判断带走。已写进去的引用仍列在下一行 `定点引用（照注册中心条目解析，注入死活看那一面的探针）：` 带 `摘掉`（A5-5b-1 那一面没动，只是现在它接的上是真勾出来的格子）。**形状**：`registry-view.ts: equipRefOptions(entries, kind, spaces)` 是这一列唯一的取材处——`enabled` 与注入现场（`registry-equip.resolveRef`）**同一把尺**（停用的条目根本递不出去，凑装备槽就是假绿）、`spec.file`/`spec.space` 读不出的行**不画**（说不清它指哪篇文档，画出来就是点了会落空的勾；脏形状 server 不会外发，这里仍钉一层是因为两处判据迟早分叉）、项目名取 `GET /api/spaces` 的 `name`、**档案里没这一枚就退回 id 原样**（不拿空白冒充「没项目」）、按 显示出来的项目名→文档→id 稳定排序；跨项目的条目**照列**并带自己的项目名——「这一枚注到本项目会被跳过」那句话住在状态页的装备明细行，勾选面不重算第二遍。勾选配对住在 `equip-slots.ts: hasEquipRef/toggleEquipRef`：认 `kind`+`id` **字面成对**，同一枚条目的 slug 写法在勾选面上就是「没勾」（归一化会替人改写那枚岗落盘的字节，所以不归一；两枚写法照旧都解析得到）；`toggleEquipRef` 取消一次把重复的并入零（勾选框是「有没有」一个读数，留第二枚就是让人以为还勾着）。**机证**：web **15 文件 / 142 条**（A5-5b-1 收口时 15/135，**+7 条**＝`registry-view.test.ts` 4 条 `equipRefOptions`（kind 轴过滤／`enabled:false` 递不出去＋脏 spec 不画／项目名退回 id／跨项目照列＋排序）+ `equip-slots.test.ts` 3 条（引用勾选与另一种写法不勾／摘引用不误伤别种拼法＋上面既有的两条））；**server／cli 零改动**（本片不碰判据面：注入、写入面 400/500、引用账、探针都是 A5-5b-1 的账），复验 server **67 / 1090**·cli **3 / 77** 照绿；根 `typecheck` 净 + web `tsc --noEmit` 净 + `pnpm build` 成功。**实机跑过几处**：**空态那两支已证**（2026-09-28 队列空重启后，本机 4310 的浏览器 DOM 断言：`.equip-slot` 两块上下排、两个列头同 12px/400、`各项目还没登记可选文档` 与 `注册中心里还没有这一类条目（先去登记一枚，才能定点引用）` 两句各在其位；逐条读数在本文末「X3 半程核对回执」段，同一趟把四处「两列并排」的说法按屏改正过来）。**带货那一支也已证**（2026-09-28 续跑：临时登记 `rule:x3-readme-candidate` 后，`PUT /api/roles` 把 `{kind:'rule',id:…}` 写进「角色 1」，卡面读到 `装备 · 技能 0 · 岗位文档 1`、引用列出真格子 `README.md[X3 首驾靶项目]✓` 与 chip + `摘掉`；技能轴此时仍画空态句，直到 `skill:x3-agents-md` 登记上去。逐条读数与清理回执在本文末「X3 写面回执」段，两枚条目与临时模板验完即删）。**诚实边界六条**：①这一列的取材是**注册中心整表**再按 kind 筛，不是「本单项目能注的条目」清单——项目收窄是注入现场的事（`resolveRef` 里 `spec.space !== ctx.spaceId` 就不注只披露），界面把它预先剪掉会让人以为「别家登记的和我无关」，而那枚岗本来就可能被别的项目的班底用；②勾出来的引用**不做写盘迁移**（§十二-14 那条裁决照旧）：裸串那一列一个字节没改，两列各产各的写法；③同一篇文档在两项目各登记一枚时，两行都列得出（各自带项目名），勾哪一枚就是钉哪个项目——**这正是定点引用与裸串的分别**，界面不替人选，也不合并成一行；④slug 写法的引用显示为未勾（见上），这一格在「注册中心」页的引用账里指的仍是同一条目，两处读数不同形是刻意的：账认多种写法，勾选框只认自己发出去那一串；⑤`rule` 那一列勾出来只带 `{kind:'rule',id}`，条目自己的 `repo`/`pathsGlob` 不在界面复述（作用域尺只有 `matchRules` 那一把），要看作用带去注册中心那条目的 label；⑥注册中心读那一刀**失败时只丢引用列**，项目清单那一列照旧能勾（两列各自独立取材，一处坏不能连带另一处白掉），保存动作仍由 server 的三段判序兜（写引用型脏槽照样 400，界面点得出≠界面放过）。 |
| UI-2 | better-ui 续刀：样式表里的十六进制回落清零（承 `0bae4ef` 的语义 token 归位——那一刀清组件里硬编码的红，这一刀清 `styles.css` 里死掉的回落） | **已完成（本片）** | 本片 | **可感面**（**零像素变化**，这是一片代码面清理，不是给人看的改动）：`.run-cost-chip`／`.bot-meta.dirty`／`.bot-ghosts`／`.enhance-draft-q`／`.artifact-row .dim`／`.artifact-chip`／`.artifact-chip.warn` 七行里的八个 `var(--x, #hex)` 写成 `var(--x)`。为什么值得动：`--border`/`--text-dim`/`--warn` 在暗（`styles.css:12,14,17`）与亮（`:36,38,41`）两套主题里**都定义过**，`:root` 上永不缺席，所以那串十六进制今天走不到；走不到的分支不是保险，是**下一次改 token 时的静默替身**——真要有人把 `--warn` 从主题里摘掉或挪进某个局部作用域，界面不会报错也不会变灰，而是按 `#b8860b`／`#e0a03a`／`#333`／`#999` 这几串**上一版的颜色**继续渲染，两处口径就这么分开了。顺带清的是同族的写法漂移：全站芯片圆角一律 `border-radius: 999px` 字面量，A5-5b-2 新加的那枚却吃了个仓库里根本不存在的 `--r-chip`（靠回落值才成立）——同一个读数两处口径迟早分叉，照约定回字面量。**取证（代码面，不是浏览器）**：两处列头同 12px、同 line-height、无额外 padding，故等高（原先小一号会让同级列头看起来像次级说明，扫视时第二列被当成备注跳过）；回落清零后的颜色读数与改前**逐字节相等**，因为那八个分支从来没有被执行过——这条是 CSS 变量解析的事实，不是我实测的截图。**机证**：web **15 文件 / 142 条**（与 A5-5b-2 收口时同一批，本片不新增判据）·根 `typecheck` 净·web `tsc --noEmit` 净·`pnpm build` 成功（CSS 打进 `dist/assets/index-*.css`，产物字节变了说明改动真进了发行物）。**实机跑过几处：零**——浏览器核对与 X3／A5 系列／UI-1／A5-5b-1／A5-5b-2 记的是同一笔账（本机 4310 是旧 dist，前端新后端旧要等那次重启）。**诚实边界三条**：①这片**不改任何可见外观**，所以它的「可感面」只能是代码面的：把它写成界面改动就是假话；②只清了**已有语义 token 的回落**，主题块之外仍可能有别的硬编码色（本片是 `styles.css` 里 `, #hex` 这一形的全集，不是「全站零硬编码」的宣称）；③`--warn` 与被我删掉的 `#e0a03a` 本来**颜色并不相同**（暗色下 `#d9b25c`）——也就是说那串回落一旦被执行到，渲染出来的是**另一种黄**，这正是它比「没有回落」更糟的地方；现在它要么是真 token、要么是 CSS 变量未定义时按初始值继承，两种都比静默换色好解释。 |
| X3 | 实机首驾（零手填路径全程） | **机器全链已核**（2026-09-28 两段回执：只读半程 + 零 token 写面全链） | 只读面全绿；写面机器链全绿；欠真 agent 单 | 代码路径已通：`paneflow env add <绝对路径> --space <id>` → `paneflow registry check --template x` → `paneflow dispatch "..." --repo ... --issue ...` → `paneflow status <runId>` 见「能力: N 项 · cap#xxx」一行；向导四步（网页）同路。欠的是真项目上跑一遍：本机装 v0.3.0 之后手敲一次；agent 侧无可代做的部分。~~机器前置在 §八 末一条~~ **那次队列空重启已在 2026-09-28 做完**（队列 `cap 8/running 0/queued 0` 读数在先，旧 pid 54817/54807/54784 停净，新监听 pid 71298）：`?kind=node-type` 由 400 → 200 六型全出、`/api/env/probe` 由 404 → 200，「前端新后端旧」这条 caveat 自此作废。**剩下的只有一处要人**：带 agent 节点的真单（`dispatch` 那一笔要花 token，且要在你自己那个项目上手敲才算首驾）。~~剩下的两处要人~~ **两处里的第一、二处已在 2026-09-28 用零 token 走法证掉**：`env add` 落在临时靶项目 `x3`（不碰 `default` 的注入面）、`registry check` 逐槽 `✓/✗` 与起单 fail-closed 各证一次、临时登记的两枚 `skill`/`rule` 条目让装备区引用列点出了真格子——逐条读数与「验完删」的清理回执在本文末「X3 写面回执」段（残留：临时项目 `x3` 与那条零节点单 `d8f8f5aa`，前者没有 DELETE 路由、要删走网页「项目」视图）。 |

**M0 机证三条的现状（不洗）**：① 10 条 v13 历史 run replay 后 `骨架#/ctxSha/roleSha` 逐字节相等——**未跑**（要 run 预算点头）；② server 全量测试零改动零红——**已达标**（A3-2 片收口实跑：server **61 文件 / 872** 绿、web 11/**82**、cli 3/**70**，`pnpm typecheck` 净 + web `tsc -b` 净；T3 片时是 61/852、web 77、cli 69，R5 片收口时 57/817、web 71、cli 63——**只加不减**，且加的全是新片的判据断言，既有断言一条没放宽。X1 全量片收口时（K2 已在账）：**server 918 · web 12/100 · cli 75**，根 `typecheck` 净 + web `tsc -b` 净；**A5-1 片收口时：server 62 文件 / 937 · web 12/104 · cli 75**，两枚净照旧；**A5-2 片收口时：server 62 文件 / 960 · web 12/107 · cli 75**（cli 条数不变——那片只换例子），根 `typecheck --force` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功；**A5-3 片：server 62/984 · web 12/109 · cli 3/75**（净三照旧）；**A5-4 片：server 62/1000 · web 13/116 · cli 3/75**——web 文件数 12→13 是那片新增的 `check-types.ts` 与它的测试，净三照旧；**A5-4b-1 片：server 63/1023 · web 13/117 · cli 3/76**——server 文件数 62→63 是新片的 `orchestrate/registry-view.test.ts`，净三照旧；**A5-4b-2 片：server 63/1046 · web 13/120 · cli 3/76**（cli 只换例子不加判据，与 A5-2 同形），根 `typecheck` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功；**A5-5a 片：server 65 文件 / 1067 · web 13 / 120 · cli 3 / 76**——server 文件数 63→65 是判定层（14 条）与 HTTP 面（7 条）两枚新测试文件，**既有断言一条没动**；web/cli 条数一字不变（本片 web 只改掉一句**假话**：重命名模板那格删除被闸拦下时新模板其实已落盘，旧文案却说「重命名失败」；CLI 根本没有删除面），根 `typecheck` 净 + web `tsc -b --noEmit` 净 + `pnpm build` 成功。**（下面那句「这一片动过两条既有断言」是 A5-4b-2 那一片的账——这一栏整段是 M0② 的逐片流水账，A5-5a 自己一条既有断言都没动。）**那一片**动过两条既有断言**，写实：`engine.test.ts` 的 R5 那两格原先按位置取 `capabilityRefs[0].spec`，而快照按 `kind\0id` 排序、`gateway-profile` 字母序排在 `model` 之前——进表后 `[0]` 换成了网关档条目，首跑就红两条。改法是换成该文件早已备好的 `refsOf(run,'model')` 按 kind 取（**期望值一字未放宽**，钉的还是「历史那份副本没改」），并补一条正断言把新进账的网关档条目逐键钉住（含 `via:['gateway·current']` 与「整份记录搜不到 apiKey」）。红的是**取样姿势**，不是判据；这条先例记在这里，下一枚 kind 进表再撞同样两条照此处理，不许反过来放宽期望值）；③ 注册中心首屏一张表 + 健康点 + 被引用数——**结构已证、视觉半证**（A3-2 后 `pnpm build` 刷新了 server 一键模式挂的前端，实机页面读回 `Agent 引擎 18 项 内置清单` 分组与「出厂行无启停/删除」；截图仍未取到——应用内视口不可用，见 X1 行）。
   **X1 两件的现网取证（2026-09-27，`http://127.0.0.1:4310/` 注册中心，dist 为 HEAD）走 DOM 断言，原话照抄**：
   模型条目详情抽屉「谁在用」两行——`gateway · 「默认档」（default） · freeModel` 与
   `template · 「t3-demo」（t3-demo） · requires[0].id`（T3 的 `graph.requires` 引用真的进了引用账），
   收尾一句「被 2 处引用——删除/停用时 server 会拿这份清单拒你。」；出厂项 `agent-kind:qwen` 的同一格画
   「没人用（这是正读数：引用账确实扫过盘面，一处都没指着它）。」，健康格画「○ 不在：PATH 上逐个目录枚举完，没有「qwen」这个可执行文件」——
   三种读数在真页面上分开了。「探一次」点下去回执「刚探过一次（回执时刻 2026-09-27 19:31），读数见上一格。」，无失败块。
> ②里那条**工程口径**要写死：本仓 server 一键模式服务的是 `packages/web/dist`，改完 web 源码不跑 `pnpm build` 就等于没改——A3-2 第一次实机检查看到的就是旧包（`未知类型：agent-kind`），build 之后才读到新组名。判据落在构建链上，不靠记性。
> ②「零改动」这条口径在 R5 需要说清它约束的是什么：**历史 run 的既有读数与既有判据不许改**（`骨架#/ctxSha/roleSha/graphSha` 逐字节、
> 收口判定、退出码），不是「测试文件一行不许动」。R5 确实动了 5 条钉死字符串——收数表多一列（doc 明写要新增 `registrySnapshotSha` 列），
> 那些断言本来就钉在列数上；改的是**期望值**（多一个 `- |`），不是放宽判据。这类「按 doc 要求改列」的动账逐片在此报备，不闷声改绿。


**X3 半程核对回执（2026-09-28，本机 `http://127.0.0.1:4310/`，dist=HEAD）**——用户令「准备 X3 实机首驾与浏览器核对」，这一栏记**已证的半程**与**留给人手的那半程**，不写成首驾完成。

- **机器前置已清**（§八 末那条 caveat 自此作废）：队列读数 `{"cap":8,"running":[],"queued":[]}` 后才停 09-26 那台 dev 实例（pid 54817/54807/54784），重启后监听 pid 71298，日志净（4310 在听、一键模式、herdr socket、data dir `~/.paneflow`、pi 网关 provider 已同步）。停之前先坐实了「前端新后端旧」：`?kind=node-type` 回 400「不认的能力类型「node-type」（这版只登记：model/agent-kind）」；重启后同一枚回 200 且六型全出，`/api/env/probe` 从 404 → 200。
- **后端读数**：注册中心 49 条 · `knownKinds` 11 · `viewKinds` 6；分组 model 1 / agent-kind 18 / node-type 6 / check-type 6 / role 6 / template 11 / gateway-profile 1 / **skill·rule·repo·mcp 各 0**。`/api/spaces` 里每个项目的 `skills`/`rules`/`repos` 都是 0——下面装备区那两句空态因此都是**正读数**，不是没读到。
- **画布 Palette（T1 底座在实机成立）**：`节点类型` 分组画 核心 `⚙ Agent 节点`/`⇢ 子流水线`、基础 `▶ 开始`/`■ 结束`、高级折叠组展开后 `⑂ 同时做几件事`/`⏐ 等全部做完`——六枚与 `?kind=node-type` 逐枚对齐，画布手里没有第二份清单。编排视图的模板卡带着 T3 预检角标：`t3 demo` 那一行是 `✗ 需要：模型 2 · 技能 1 · Agent 引擎 2`（`技能` 那一枚真没登记，预检说的是「缺」不是「不知道」）。
- **设置·角色库装备区（A5-5b-2 的空态那一支）**：`装备来源` 切到 `自带装备（勾项目登记清单 / 注册中心条目）` 后 `.equip-slot` 出两块，两个列头同为 12px/400、各占整宽**上下排**（不是左右并排——核对时按子元素 y 坐标坐实，四处「并排」的说法与文档里那句列头引文 `技能文档（来自各项目的技能登记）` 一起归位成屏上原话 `技能（来自各项目的 skills 登记）`）。两句空态分得开：裸路径列 `各项目还没登记可选文档`，引用列 `注册中心里还没有这一类条目（先去登记一枚，才能定点引用）`。**带货那一支当时仍未证**（当刻读数）：注册表 `skill`/`rule` 零条目，勾不出引用格，`{kind,id}` 的落盘形状只证到单测层——**这一条已由下一栏「X3 写面回执」第 3 步证掉**，那里的读数才是要提交的形状。
- **E2 向导（只读那三段在真仓上跑通）**：探 `/Users/zfl/Documents/PaneFlow-run-clone` → `看发现` 画 Git 仓 1（`origin=JXzfluser/PaneFlow`）· 约定文档 1 · 作用域规则 18 · 机检候选 2 · 工作流 2 · Worktree 1，每行带「依据 · <文件名>」与 `（只报存在与大小，未读内容）`，末尾一句 `没有 skills 目录（未探到 skills 或 .paneflow/skills）`；`勾选` 步 25 枚框、**5 枚置灰**（2 机检 + 2 workflow + 1 worktree，正是「只披露不登记」那三类），主按钮读数 `登记 20 项`。**没点登记**——那一笔事务改 `~/.paneflow` 里的项目档案，按红线留给人手敲。
- **核对顺手修的两处**：①上面那句「并排」的假话（`AGENTS.md`／`styles.css` 注释／`SettingsView.tsx` 两处注释／本文档 A5-5b-2 行）；②向导不吃 Esc——`PromptModal`/`RunsCenter` 都装了这把钥匙，`EnvRegister` 漏了，中间几步只剩「← 上一步」退路。补的监听在**登记已在飞**时不关（Esc 与背景点击都不关）：服务端那一笔照旧落盘，此刻收掉界面等于让人以为「取消了」而档案其实改了。取证：`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` 让模态消失，dist 里数到第 4 枚 `keydown` 监听；**browser-use 的 `press_key` 没达页面**（窗口未获焦），真键盘那一支在此环境**未证**。
- **仍欠（当时记的）**：`paneflow env add <绝对路径> --space <id>` 真登记 → `registry check --template <x>` → `dispatch` → `status` 见「能力: N 项 · cap#…」一行；以及先登记一枚 `skill`/`rule` 条目，把引用列的带货那一支在页面上看一眼。**这两笔已由下一栏的零 token 走法证掉，欠的只剩「真 agent 单」那一笔**。

**X3 写面回执（2026-09-28 续跑 · 零 agent token 的那半程）**——用户令「继续所有剩余任务」。上一栏留给「人手」的两笔写拆成两半看清了：**改档案这一笔 agent 能证**（`env add` 是一次事务登记，不花 token），**花 token 那一笔仍留人**。为了不碰 `default` 的注入面（那 18 篇 iteration 文档一入档，往后每一单都会吃它们当作用域规则，而发现器只说「规则候选」，从没断言过它们该注），另起临时靶项目 `x3` 走全程：

1. `POST /api/spaces {"id":"x3","name":"X3 首驾靶项目"}` → `pnpm paneflow env add /Users/zfl/Documents/PaneFlow-run-clone --space x3` 退 **0**：`⚠ 5 项只披露不登记（check/workflow/worktree 无对应档案字段）` + `✔ 已登记 20 项 · 项目 x3`；档案回读 `rootCwd=/Users/zfl/Documents/PaneFlow-run-clone`、`repos 1`、`conventionFiles ['AGENTS.md']`、`rules 18`、无 `skills` 键（与向导那屏发现逐格对得上）。
2. **注册两枚条目**（`POST /api/registry`，网页/CLI 都不预校验形状以外的东西）：`rule:x3-readme-candidate`（`[项目 x3] README.md`）探针 **live**「项目「X3 首驾靶项目」下读到了「README.md」（8030 字节 · 改动于 2026-09-23T23:56:45.379Z）」，`registry refs` 一处 `space · X3 首驾靶项目（x3）· rules[0].file`——登记那一刻 `add` 的回执里 `refs` 就已经带着这一条，引用账不用人再做什么；`skill:x3-agents-md`（`[项目 x3] AGENTS.md`）探针 live **8889 字节**，与 E2 向导那句「约定文档 1 · AGENTS.md 8889 字节」同一枚读数（它 `refs: []` 也是正读数：`conventionFiles` 不发引用边）。
3. **装备引用「带货」那一支在页面上证到**：`PUT /api/roles` 把 `{kind:'rule',id:'rule:x3-readme-candidate'}` 写进「角色 1」的 `rules[0]`（写前存原名册、验完还原并坐实 `roster byte-equal to original: true`）——卡面 meta `装备 · 技能 0 · 岗位文档 1`；岗位文档那一轴的引用列出**真格子** `README.md[X3 首驾靶项目]✓`，下一行 chip `定点引用（照注册中心条目解析，注入死活看那一面的探针）：rule:x3-readme-candidate摘掉`；技能轴那列此时仍画空态句（还没登记 skill 条目）。引用账两处出处 `role · 角色 1（role-mu7tngig）· rules[0]` + `space · x3 · rules[0].file`；此时 `DELETE /api/registry/rule%3A…` 回 **400** 点名两处（`via` 是能按图索骥的键路径）。**两列各说各的尺**也第一次看得见：裸路径那一列 18 格里 `README.md` 同样在列，勾它产 `README.md`，勾引用那一格产 `{kind,id}`——同一篇文档两种写法，谁也没把谁翻过去。
4. **临时模板 `x3-cap-probe`**（只有 `▶ 开始`/`■ 结束` 两枚节点——**零 agent 节点＝零 token**）携四枚 `requires`（`rule`/`model`/`node-type`/`skill`）。`paneflow registry check --template x3-cap-probe --space x3` 退 **1**：`模板「x3-cap-probe」· 项目「x3」· 需要：规则 1 · 模型 1 · 节点类型 1 · 技能 1 ← 有缺口`，逐槽 `✓ rule → rule:x3-readme-candidate`／`✓ model → glmcn/glm-4.7`／`✓ node-type → end`／`✗ skill → 读图（注册表里没有可用（启用中）的「技能」条目指向「读图」）`——A5-1/A5-2 两枚 kind 的槽在实机上画的是 `✓/✗` 而不是 `?`，这就是「新增能力进没进底座」那枚判据的读数（分组中文标签来自 server 的 `kindLabels`，CLI 与网页都没再抄一份）。
5. **引擎侧同一把尺 fail-closed**：拿这张图 `POST /api/runs?space=x3` 回 **400**，一句人话「模板「x3-cap-probe」的能力槽没补齐：skill → 读图（…模板备注：还没登记 skill 条目，看预检怎么说）——先在「注册中心」登记缺的那几项（或改掉模板的 requires）再起单。」预检与起单没有两套判据。
6. 登记那枚 skill 条目、把槽改指它 → 预检退 **0**（四槽全 ✓）→ 起单 201，`run d8f8f5aa` 跑完 `✔ completed · 用时 0s`，`paneflow status` 出首驾要的那一行：`能力: 5 项（gateway-profile 1 · model 1 · node-type 2 · rule 1）· cap#b701666e`（上行 `harness: graph#c37ea10c · kind=pi · model=glmcn/glm-4.7 · 读回=无(not-injected) · 骨架#c37ea10c`）。`--json` 里逐条 `via`：`gateway·current`／`gateway·freeModel`／`template·nodes[0].type`／`template·nodes[1].type`／`space·rules[0].file`。**`requires` 里那两枚 skill/rule 槽只有一枚进了快照**（进的是 `space·rules[0].file`，`requires[3].id` 没进）——声明不是实发，这条单测早钉住、实机头一回看得见。
7. **R5「日后条目被编辑/删除，历史读数不改」实机证到**：随后把两枚条目与临时模板都删掉，**删除顺序本身就是账**——先删 skill 被 **400** 拦「还被 1 处引用着（模板「x3-cap-probe」的 requires[3].id）」→ 删模板 200 → 再删 skill 200；`rule` 那枚先被 **400** 拦在「项目「X3 首驾靶项目」的 rules[0].file」，把 x3 档案里那条规则撤掉（`PUT /api/spaces/x3` 显式发 17 项数组）才删得掉。注册表回到 **49 条**（`skill`/`rule` 各 0、`rejected` 0）而 `paneflow status d8f8f5aa` 照旧读 `能力: 5 项 … cap#b701666e`：逐条 spec 吃的是起单那一份副本。
- **顺带照出一句 AGENTS.md 的假话并改掉**（同一个探针模板 `x3-kind-probe`，只有 `▶/■` 两枚节点，验完即删）：拿四枚 `requires` 问「已迁的视图 kind 到底落什么画法」——`✓ template → t3-demo`／`✓ role → std-planner`／`✓ gateway-profile → default`／`? channel → any（「通道」这一类还没迁进注册表，判不了死活（只披露不拦））`，整屏退 **0**（带 `?` 的槽不算缺口）。AGENTS.md 里那句「指向 template/gateway-profile/channel/… 的槽仍落 `?`」自 A5-4b-2/A5-4b-1 起就不成立：前两枚早已判死活，只有真没迁的那一类才落 `?`。改口按屏上原话写，并补上「`?` 不拦」这半句（预检退 0 是它的直接读数）。
- **残留（照实报，agent 删不掉的那部分）**：①临时项目 `x3` 还在——`DELETE /api/spaces` 这一版没有路由，网页「项目」视图里可直接删；它的档案是 `env add` 的原样产物，只在清理条目时把 `rules` 从 18 撤成 17（撤的正是 `README.md` 那条，它当时被临时条目指着，不撤就删不掉那枚条目）；②`run d8f8f5aa` 这条零节点单留在 x3 的运行记录里，是 cap# 那行的原件；③名册与注册表均回到首驾前的状态（`roles` 逐字节还原、注册表 49 条）。
- **这一栏证到哪、没证到哪**：证到的是「注册表→引用账→删除闸→预检→起单 fail-closed→能力快照→历史读数」整条**机器链**在真盘上贯通，全程零手填路径、零 agent 支出。**没证到**的是带 agent 节点的真单——那一笔要 token，也要在你自己那个项目上人手敲一遍才算首驾（`default` 的档案这一趟一个字节没动）。
