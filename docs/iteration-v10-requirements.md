# v10-U 体验优化需求（目标 → 支柱 → 需求）

> 立项来源：2026-09-19 用户三条（角色库做出组织架构感 / GitHub 凭据还有更好的方式吗 / 空间概念转为项目、布局灵活、项目角色从全局库添加）。
> 口头裁决：**「不叫岗位，就是 bot 的角色」**——组织感 = bot 班底阵容，不是公司岗位表。

## 目标（一句话）

设置与任务界面从「配置表单」升级为「我的 AI 班底」：bot 有脸、凭据零摩擦、空间就叫项目且班底前置可见可动。

## 支柱一：班底感（ familiar roster ）

- **U1 角色库 → bot 阵容视图**：角色卡 = bot（头像/名字/默认 Agent 类型/人设摘要），标准五连打头按
  规划→实现→评审→验收→沉淀 排成首发阵容；每张卡挂「已部署 N 个项目 / 待命」徽标
  （数据源：新增 GET /api/roles/usage 聚合各项目档案 team 的 roleId）。编辑人设收进卡内折叠区。
  验收：usage 聚合单测（含悬空 roleId 不计）；阵容渲染 tsc+build 净。

## 支柱二：凭据零摩擦

- **U2 GitHub 凭据体验升级**：
  - 来源可见：GET /api/github/cred 回 `source`（stored-pat / gh-cli / none）+ tokenTail（尾 4 位，不回显全值）+ ghLoggedIn。
  - 零复制也能干活：create-issue 等确定性动作无存储 PAT 时自动兜底 `gh api`（直用 gh CLI 登录态）；
    wiki 沉淀同理（ghCliToken 现取现用）。失败仍明说不吞。
  - 一键解绑：POST /api/github/cred/unlink 清除存储 token（gh 登录态不受影响）。
  验收：source 判定/兜底路径/unlink 单测；真实 gh 登录态冒烟只走读路径。

## 支柱三：项目化与布局灵活

- **U3 空间 → 项目（仅词面）**：所有用户可见文案「空间」改「项目」；存储目录、`?space=` 参数、
  SpaceProfile 类型名全部不动（零迁移风险，内部标识不上 UI）。
- **U3b 项目班底条前置**：任务视图顶部常驻本班底——成员 chip（头像+名字）+「从角色库添加」下拉
  （列全局库未入列角色，点选即写 profile.team）+ 一键装填标准五连（已有接口）。空班底给引导卡。
  验收：班底条纯函数（可添加名单计算/移除语义）快照测试；改名后 grep 无用户可见「空间」残留。

## 批次依赖与顺序

`U0 文档 → U1 → U2 → U3`；U3b 依赖 U1 的 roles 数据形状但可并行。

## 明确不做（v10-U）

- 数据模型/API 键改名（space→project 只发生在词面）。
- 角色层级/汇报线（组织架构感 = 阵容感，不是树）。
- OAuth / token 加密后端（gh 登录态兜底已覆盖主要摩擦）。

## 实施状态（2026-09-19 收口）

| 项 | commit | 验证 |
|---|---|---|
| U1 bot 阵容视图 | `d83c59f` | usage 聚合单测 ×2（含悬空 roleId/空目录）；server 291 全绿；实机 `GET /api/roles/usage` 回 b-smoke 五连部署 |
| U2 凭据来源/兜底/解绑 | `a33d682` | 来源三态+resolve 优先级+unlink+create-issue gh 兜底+wiki 过凭据门 单测 ×5；实机 `GET /api/github/cred` = stored-pat·尾号 Vh0Q·ghLoggedIn=true |
| U3 词面改名+班底条 | `68f1b10` | addableRoles 快照测试 ×3；web grep 用户可见「默认空间/空间主仓根/…」清零（仅注释与「画布空间」留）；默认空间读侧显示「默认项目」（listSpaces+GET profile 两处，盘上档案不改写） |

词面裁决补记：用户口语「不叫岗位，就是 bot 的角色」→ 界面词全部阵容化（已部署 N 个项目/待命/首发五连/人设），无任何「岗位/职位/编制」字样。

未做实机像素级核对（browser-use 截图通道仍不可用）：班底条/阵容卡外观以 build+结构测试为凭，像素验收留给用户开页确认。
