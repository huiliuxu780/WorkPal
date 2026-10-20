# CAP-01 + UX-03 — 操作确认与 Bot 管理面收敛

Status: `in-progress`。Draft PR [#81](https://github.com/huiliuxu780/WorkPal/pull/81) 必须按本任务重做；未合并、未部署。代码事实基线：`main @ 472f0b1`。

历史设计保留，但不再作为实现依据：

- [v1 低层权限规则编辑器](./archive/CAP-01-low-level-editor.md)：已否决。
- [v2 两界面草案](./archive/CAP-01-two-surface-draft.md)：已否决。
- [v3 按 Bot 管理应用草案](./archive/CAP-01-per-bot-apps-draft.md)：已否决。
- UX-03 的已批准结构见 [UX-03 决策](../ux/UX-03-decision.md)。

## 1. 纠错结论

### 1.1 已有功能，禁止在本批重做

以下均已存在于 `main`，不是 CAP-01 新需求：

1. **Connect Apps 全局应用目录弹窗**
   - 现有 `PluginsOverlay` 已有目录、搜索、推荐、连接状态、应用详情、连接、重授权和断开。
   - 现有 `connections.catalog/list/begin/complete/revoke/tools` 是它的权威链路。
   - 本批不得改变弹窗结构、普通应用作用域、连接生命周期、executor 工具解析或自定义 MCP 语义。
2. **全局 Settings 大弹窗**
   - 现有 `SettingsOverlay` 已有 General / Models / Memory / Voice / Usage / Computer / Updates。
   - 保留现有 Dialog 外壳、尺寸、导航、关闭方式和响应式行为，不另造设置页面。
3. **Auto-review 与审批规则**
   - `ActionAutoReviewPreference`、`ActionApprovalRule`、`autoReview.get/set`、`approvalRules.list/set/remove` 已存在。
   - `ApprovalRulesSettings` 已位于 General 的 Advanced 内；本批只调整它的用户表达和位置，不建立第二套规则系统。
4. **当场审批与恢复**
   - `AskCard`、`InterventionRegion` 已支持 Allow once / Always allow / Deny、刷新恢复、幂等提交、secret/takeover 和真实 effect 状态。
   - 本批不得另造审批状态机、第二种 Intervention 或平行的确认卡协议。
5. **成果与执行记录**
   - 文件和消息成果已经留在原对话；`RunDetailsPanel` 已展示 Outputs 与 Effects ledger。
   - 本批不得新建成果中心、Bot 成果页或第二套 result projection。
6. **Bot 与群设置**
   - `BotSettings` 已有头像换装、名称、头衔、描述、通知、电脑模式、资料库、草稿板、模型、思考深度、记忆范围、语音、导出和清空。
   - `GroupSettings` 已存在并保持现状。UX-03 只迁移入口和布局，不能丢功能或改群设置模型。
7. **执行后端**
   - PostgreSQL 的 Task、Run、Attempt、Intervention、ExternalEffect、Worker 和审计继续存在。
   - 用户要求删除的是 Task Center 用户界面，不是执行模型。

### 1.2 我此前乱设计、必须剔除的内容

以下不是用户需求，必须从 #81 与任务书中删除：

- Bot Settings 内的 `BotPermissionsSection`、规则表、scope/glob/资源表达式、策略试算器、冲突工作台和草稿切 Bot 守卫。
- `bots.capabilityPolicy.get/update/preview`、`CapabilityPolicyView`、`capabilityPolicyRev`、`CapabilityPolicyChange` 及其 migration、catalog、parity test 和专用 E2E。
- per-Bot 普通应用摘要、开关、停用、应用权限矩阵和第二套应用目录。
- “把 Connect Apps 全局化”的任何 API、schema、迁移、executor 改造或产品说明。它已经是全局目录。
- 新的 `apps.connections.list()`、新的 `actionRules.*` 平行 API、新的 `ApprovalActionPresentation` DTO 和新的 `execution.actions` 结果 DTO。
- 在 Bot 设置里展示应用权限、Auto-review、自定义规则、执行结果或成果。
- 为邮件、付款、文档等示例建立固定分类或 preset。它们只能是文案例子。
- 与本功能无关的 `.github/workflows/nightly-verification.yml` 删除、memory 文档改动或其他顺手修改。它们不进入 #81。

### 1.3 用户已明确授权的变化

本批只允许以下产品变化：

1. 将现有 Auto-review 与审批规则改成普通用户能理解的表达。
2. 删除 Task Center 用户界面，让等待、完成、失败、取消和重试回到来源 Bot / 原对话。
3. 实施 UX-03：聊天顶部悬浮头像与状态，Bot 侧面板收敛为 `详情 / 资料库 / 电脑` 三 tab；群设置不变。

## 2. 产品结构

| 用户要做的事 | 入口 | 本批处理 |
| --- | --- | --- |
| 连接或断开应用 | 侧栏 Connect Apps → 现有大弹窗 | **不改，只回归** |
| 设置什么时候需要确认 | Settings → General | 改造现有 Auto-review / ApprovalRulesSettings |
| 决定这一次是否执行 | 原对话现有 Intervention 卡 | 保留现有链路，优化用户文案时不得改状态机 |
| 查看结果 | 原对话 + 现有 Execution detail | **不新建结果系统** |
| 管理单个 Bot | 悬浮头像 → Bot 侧面板 | UX-03 布局迁移 |
| 管理群聊 | 悬浮头像簇 → 现有 GroupSettings | 入口迁移，内容不改 |

## 3. 前端任务

### F1. 撤销 #81 的错误权限编辑器

- 删除 `BotPermissionsSection`、`capability-policy.ts`、其测试、E2E、翻译和 Shell 草稿状态。
- BotSettings 不出现“权限”“应用与操作”“成果”或“安全策略”区域。
- roster、切 Bot、跨 Space 导航恢复 `main` 行为。

### F2. 改造现有 Auto-review 设置

- 继续使用现有 `SettingsOverlay`；不新增导航项或新页面。
- 将现有 `ApprovalRulesSettings` 从 Advanced 折叠区移到 General 主内容。
- 显示一个 Auto-review 开关。
- 自定义规则只显示：自然语言动作 + `先问我 / 自动允许`。
- 支持新增、编辑、删除；失败时保留当前输入。
- 删除 `Flag unexpected actions`、checker 可用性和固定 email/purchase preset 等技术表达。
- 页面说明作用域为当前 Space 中该用户的所有 Bot；不提供 Bot picker、tool、scope、glob、优先级或试算器。

### F3. 保留现有审批与结果链路

- 继续使用 `AskCard` / `InterventionRegion` 的现有一次允许、长期允许、拒绝和恢复逻辑。
- 可把按钮和动作说明改成人能理解的具体文案，但不能增加第二套审批协议。
- 继续使用原对话成果卡、`RunDetailsPanel` 的 Outputs / Effects 和现有 detail retry。
- 不新增成果页面、成果列表、Action DTO 或 effect 结果数据库。

### F4. 移除 Task Center 用户界面

- 删除侧栏入口、Task Center 页面、轮询计数和该页面专用样式/翻译/E2E。
- 等待确认、完成、失败、取消和重试继续由来源 Bot 状态、原对话执行卡和 Intervention 表达。
- 将仍被来源回焦使用的 `TaskCenterNavIntent` 改为中性的 execution navigation 名称；不要删除其功能。
- 保留 Task/Run/Attempt/Intervention/ExternalEffect 后端执行记录。
- `runs.taskCenter` 若删除 UI 后没有任何调用方，可随同删除；不把清理扩展成执行后端重构。

### F5. UX-03 管理面收敛

- 移除聊天头部的 Bot 名称/头像 trigger、模型切换器、电脑按钮和独立 run pill。
- 转录区水平居中贴顶显示一个悬浮头像件；状态环与 `运行中 · N 项动作` / `待审批 · 事由` 属于同一个控件。
- 点击悬浮件打开/收起 Bot 侧面板。
- Bot 面板 hero 保留 AvatarStudio；tab 为 `详情 / 资料库 / 电脑`。
- `详情` 迁入现有 BotSettings 的身份、通知、模型/思考、记忆、语音、导出/清空和例行任务入口。
- `资料库` 迁入现有 KnowledgeSection 与 ScratchpadSection。
- `电脑` 迁入现有电脑模式、实时屏幕、维护和完整窗口入口。
- 群聊显示头像簇并打开现有 GroupSettings；GroupSettings 内容不改。
- Connect Apps、Auto-review、规则、执行结果和成果不进入 Bot 面板。

## 4. 后端任务

### B1. 删除错误的新策略系统

- 删除 #81 新增的 capabilityPolicy contract、RPC、router、CAS revision、审计表和 migration。
- 撤销为该编辑器新增的 capability catalog / preview / parity 代码。
- `Bot.capabilityRules` 与现有执行边界恢复 `main` 行为；本批不开放 UI。

### B2. 在现有审批规则上支持用户文案

- 继续以 `ActionAutoReviewPreference` 和 `ActionApprovalRule` 为唯一持久化模型。
- 继续使用 `autoReview.*` 与 `approvalRules.*` 命名；需要自然语言字段时扩展现有 schema/接口，不新建 `actionRules.*`。
- 保留旧规则并保持其原匹配范围；旧数据可读、可删除，迁移不得扩大授权。
- `自动允许` 只影响既有 action-review/approval 决策，不能连接应用、扩大资源权限或绕过服务端 deny、撤权、Plan review、secret/takeover。
- 多条规则冲突时沿用现有保守决策；不要为设置页增加策略模拟器。

### B3. Task Center UI 退场后的来源导航

- 保留现有 Run/Intervention 读模型和执行状态。
- 来源 Bot / Thread 的 attention 投影必须能打开原对话并聚焦对应 Run 或 Intervention。
- 没有 shell 的 cancelled Run 仍通过原对话执行卡使用 MR-01 重试。
- 不新增全局待办聚合、计数或第二个任务列表。

### B4. UX-03 复用现有契约

- 不新增 Bot 持久化模型或第二套 Bot settings API。
- 悬浮状态复用现有 Bot avatar / Run / Intervention 投影，不从消息文本猜状态。
- 群头像簇复用现有已授权成员数据。

## 5. 实施顺序

1. 将 #81 的功能代码恢复到 `main`，只保留经单独确认的任务文档；移出无关 nightly/memory 修改。
2. 在现有 ApprovalRulesSettings、approvalRules 和 autoReview 链路上完成用户化改造。
3. 删除 Task Center UI，并把来源导航命名和入口收敛回原对话。
4. 实施 UX-03 的头部、悬浮头像和三 tab Bot 面板。
5. 运行受影响的定向测试与聚焦 E2E，一次收口同一 PR；不按组件拆 PR。

## 6. 验收标准

1. `PluginsOverlay`、connections RPC/schema、连接生命周期和 executor 工具解析相对 `main` 无产品行为变化。
2. Settings 与 Connect Apps 仍是各自现有的大弹窗；没有新设置页、新应用目录或新左侧导航项。
3. Bot Settings 没有应用权限、capability policy、规则试算器、Auto-review 或成果列表。
4. #81 不包含 capabilityPolicy RPC/contract/schema/migration、`BotPermissionsSection` 或其 E2E。
5. Auto-review 和规则使用现有 `autoReview.*` / `approvalRules.*` 权威链路；没有第二套规则系统。
6. General 中的规则只呈现自然语言动作与 `先问我 / 自动允许`，支持新增、编辑、删除和失败保留输入。
7. 旧 ActionApprovalRule 数据保持原范围且可读、可删；没有静默扩权。
8. 既有 AskCard / Intervention 的一次允许、长期允许、拒绝、刷新恢复和 effect 状态回归通过。
9. 原对话成果和现有 RunDetails Outputs / Effects 保持可用；没有新成果中心或结果 DTO。
10. Task Center 的入口、页面和轮询消失；Task/Run/Attempt/Intervention/ExternalEffect 执行链保持完整。
11. waiting/completed/failed/cancelled 能从来源 Bot / 原对话发现并定位到对应 Run；MR-01 重试仍可用。
12. 单 Bot 顶部只有一个居中悬浮头像状态件；打开三 tab Bot 面板后，原 BotSettings/Computer 能力逐项可达。
13. hero 头像继续打开 AvatarStudio；群头像簇继续打开未改造的 GroupSettings。
14. UX-01 执行卡、UX-02 Plan review、AG-08 撤权恢复、头像状态和跨 Space 导航不回归。
15. #81 不夹带 nightly workflow、memory 文档或其他无关修改。
16. 受影响包类型检查、现有审批定向测试、来源导航测试和聚焦 E2E 通过；未部署。

## 7. 交付物

- 本任务：`docs/tasks/CAP-01.md`
- UX-03 决策：`docs/ux/UX-03-decision.md`
- UX-03 冻结原型：`/Users/rivers/Documents/WorkPal-design/ux03-bot-panel-tabs/index.html`
- 历史 CAP-01 原型与 v1/v2/v3 文档保留作决策记录，不再作为开发输入。
