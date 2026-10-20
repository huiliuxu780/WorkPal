# CAP-01 + UX-03 — Auto-review、操作闭环与 Bot 管理面收敛

Status: `in-progress`。Draft PR [#81](https://github.com/huiliuxu780/WorkPal/pull/81) 必须按本任务重做，并在同一 PR 完成 [UX-03 决策](../ux/UX-03-decision.md)；未合并、未部署。代码核对基线 `main @ 472f0b1`。

历史设计完整保留：

- [v1 低层权限规则编辑器](./archive/CAP-01-low-level-editor.md)：把内部策略暴露给用户，已否决。
- [v2 两界面草案](./archive/CAP-01-two-surface-draft.md)：仍以技术权限为中心，已否决。
- [v3 按 Bot 管理应用草案](./archive/CAP-01-per-bot-apps-draft.md)：错误地把账号级应用和长期选择放进 Bot 设置，已否决。
- 当前实施契约只有本文件。

## 1. 已核实的产品事实

2026-10-20 已在用户 Mac 上直接走查运行中的 Grok Bot，并用用户提供的三张截图复核。其信息架构不是“每个 Bot 配一套应用权限”：

- 已连接应用对同一账号下的所有 Bot 可用；应用由侧栏 `Connect apps` 管理。
- Settings 的 `通用 → Bot` 管全局 Auto-review / Custom Rules；左侧没有单独的权限或操作确认导航。
- Connect Apps 是独立大弹窗，包含已连接摘要、搜索、真实分类、推荐列表、添加/连接状态和应用详情返回路径。
- 单个 Bot 的设置用于名称、头像、标签和稳定角色等 Bot 自身信息。
- 文件、图片、链接和工具结果作为卡片留在产生它们的对话中。
- 主界面右侧 Bot/对话详情承载资料库、电脑和例行任务等上下文，没有 Task Center。

官方来源：

- [Connect apps](https://cursor.com/help/grok-bot/connect-apps)
- [Work with connected apps](https://cursor.com/docs/grok-bot/work)
- [Settings](https://cursor.com/docs/grok-bot/settings)
- [Bots](https://docs.x.ai/grok-bot/bots)
- [Files and results](https://docs.x.ai/grok-bot/files-and-results)

WorkPal 当前代码已经有全局 `Connect Apps` 目录弹窗；按 Bot 的 MCP assignment 和 `Bot.capabilityRules` 是另外的现存实现事实，不能据此把应用目录重新解释成 Bot 设置。两者在本任务中都保持现有语义。

## 2. 设计北极星

**Connect Apps 保持现状；用户在平台设置里表达什么时候需要确认，在动作发生时作决定，在原对话里拿到成果，并通过悬浮头像进入完整 Bot 管理面。**

系统负责工具注册、资源授权、deny、撤权、幂等和审计。用户不配置 tool、scope、glob、优先级、catalog 或 Bot 级权限矩阵。

邮件、付款、文档、日历和数据库都是示例，不是固定权限分类。生产界面只能显示当前真实连接、真实动作和真实结果。

## 3. 信息架构

| 用户问题 | 唯一入口 | 内容 | 不放在这里的内容 |
| --- | --- | --- | --- |
| 我连接了哪些应用？ | 侧栏 `Connect Apps` → 现有 Integrations 大弹窗 | 当前 Space 的连接、登录状态、连接/断开 | Bot 选择器、每 Bot 开关、工具表 |
| 哪些操作自动做、哪些先问我？ | 现有 Settings 大弹窗 → `General` | Auto-review、所有 Bot 共用的自然语言规则 | 内部策略、应用连接管理 |
| 这一次做不做？ | 产生动作的原对话 | 具体动作、对象、影响、一次允许/以后允许/拒绝 | 规则编辑表单、全局任务队列 |
| 做成了吗？成果在哪？ | 原对话 + Execution detail | 文件/链接/消息/变更结果、真实 effect 状态 | Bot 设置、另建成果后台 |
| 这个 Bot 是谁、怎么工作？ | Bot 设置 | 名称、头像、标签、稳定角色及既有 Bot 选项 | 应用权限、执行结果、长期允许规则 |

本任务不在 Bot 设置新增“应用与操作”“权限”“成果”或“安全”区域。

### 3.2 UX-03 补充结构

- 聊天头部不再承载 Bot 管理功能：移除头像/名称 trigger、模型切换器、Agent 电脑按钮与独立 run pill。
- 单 Bot 对话在转录区水平居中贴顶显示一个悬浮头像件；身份、状态环和 `运行中 · N 项动作 / 待审批 · 事由` 文案属于同一控件。
- 悬浮件单击打开 Bot 侧面板，再次单击收起；不随转录滚动消失。
- Bot 侧面板使用居中 hero、名称、头衔与 `详情 / 资料库 / 电脑` 三 tab；hero 头像可打开 AvatarStudio 换装。
- 群聊使用最多 3 个成员头像加计数的悬浮头像簇，点击进入现有群设置；群设置结构保持现状，不改成三 tab。
- Bot 面板不承载 CAP-01 的 Connect Apps、Auto-review、自定义规则或成果列表。

### 3.1 范围口径

WorkPal 的账号数据按 Space 隔离，因此界面写明：`这些设置适用于当前 Space 中你的所有 Bot。` 不提供 scope 下拉框。跨 Space 不共享连接或操作偏好，除非后续产品任务专门改变租户边界。

## 4. 完整用户流程

### 4.1 Connect Apps（现有能力，不在本批重做）

当前产品已经从侧栏进入 `Connect Apps` 并打开全局应用目录大弹窗，已有搜索、catalog、连接状态和详情。本批保持现状：

- 看见可连接和已连接的应用；
- 登录或重新授权；
- 断开应用；
- 普通应用继续按现有全局连接语义供 Bot 使用。

不得为了 CAP-01 重写 `PluginsOverlay`、连接生命周期、目录信息架构或普通应用作用域。Draft #81 若已改动这些行为，应恢复到 main；`activeBotId` 只保留现有自定义 MCP/高级流程的真实用途，不能据此误判整个 Connect Apps 是 per-Bot 产品。

已连接不代表每个动作都能执行。服务端仍会在执行时检查当前用户、Space、资源、连接状态、强制策略和是否需要确认。

自定义 MCP/开发者服务若现有产品明确采用按 Bot 分配，可继续留在它自己的高级入口；不得混入普通连接应用列表，也不得被本任务静默改成账号级。

### 4.2 General 中的 Auto-review 与自定义规则

不新增 Settings 左侧导航项。规则放在现有 Settings 大弹窗的 `General` 内容区，与参考截图一致。

`Auto-review` 是面向用户的总开关：

- 开启后，WorkPal 在有后果的操作执行前检查是否需要确认，并应用自定义规则；
- 关闭后，不运行模型审核，但服务端固定要求确认或禁止的动作仍保持原行为；
- 界面不展示 checker、模型、内部策略或运行细节。

`自定义规则` 使用一句自然语言和一个结果选择：

- `当 WorkPal 想要：` 自然语言输入，例如“替我回复邮件”；
- `它应该：` 只提供 `先问我`、`自动允许`；
- 用户可以新增、修改、删除规则；
- 冲突时 `先问我` 优先，界面直接写清；
- 规则适用于当前 Space 中该用户的所有 Bot，不提供 Bot picker、scope 或资源表达式。

用户在真实动作卡选择“以后直接……”时，系统创建一条同类型的 `自动允许` 规则。它出现在同一规则列表，可编辑或删除；设置里也允许用户直接创建规则，不再另设“无需再次确认”专区。

### 4.3 当场确认具体动作

确认卡回答三个问题：Bot 要做什么、影响谁或什么、执行后会发生什么。

卡片结构：

1. 标题：`<Bot 名称> 想要 <动作>`。
2. 2–4 个关键字段：收件人、文件、金额、日历对象、目标记录等真实对象。
3. 一句影响说明；长内容可展开查看。
4. 依据当前动作生成的三个选择：
   - 一次按钮，例如 `发送这封邮件`；
   - 可选的长期按钮，例如 `以后直接发送`；
   - 拒绝按钮，例如 `不发送`。

长期按钮只在服务端注册了稳定、人类可读的动作身份时出现。其说明固定写清：`以后当前 Space 中任一 Bot 执行这类动作时不再询问。` 连接账户、资源权限或服务端 deny 仍逐次检查。

密码、验证码、CAPTCHA、支付确认和需要用户亲自完成的页面显示 `接管完成`，没有长期允许。

后台 Run 需要确认时，来源 Bot/对话进入 attention 状态。用户点击带有“需要确认”状态的 Bot 或对应对话，直接打开原 Thread 并聚焦同一 Intervention。多个待处理动作按原对话时间顺序保留，不再聚合到另一个中心。

### 4.4 成果与执行结果

动作结果属于产生它的工作：

- 文件、图片、链接、发送回执和其他成果作为卡片留在原对话；
- Execution detail 第 2 层显示本 Run 的关键动作及 pending/approved/executing/completed/failed/denied/expired/uncertain 状态；
- 后台完成、失败、取消或等待确认都写回原对话，并更新对应 Bot/对话的预览和头像状态；
- Bot 设置不展示成果列表，也不新建“安全日志”或“成果中心”。

批准不等于完成。界面只有收到 `ExternalEffect` 的真实终态后才能显示完成。结果未知时沿用现有恢复选择。

## 5. 前端任务

### F1. Connect Apps 不回归

- `PluginsOverlay` 的目录、搜索、featured tiles、连接账户详情、连接/断开和 catalog 加载保持 main 现状。
- 不新增 Bot picker、权限表或另一套应用目录。
- 不把自定义 MCP 的高级流程误改成普通连接应用语义。
- #81 中为旧权限编辑器或错误 per-Bot 方案加入的 Connect Apps 改动全部撤回；本项只有回归验证，没有新产品开发。

### F2. 平台操作确认设置

- 保留现有 `SettingsOverlay` Dialog 外壳：普通面板 `920×720`、约 `200px` 左侧导航、标题和关闭方式不重做。
- 不新增左侧导航项；将 `ApprovalRulesSettings` 从 General → Advanced 移到 General 主内容。
- 展示 `Auto-review` 总开关和 `自定义规则` 表单。
- 自定义规则由自然语言动作和 `先问我 / 自动允许` 两种结果组成，支持新增、编辑、删除。
- 真实动作卡保存的长期选择进入同一列表，不再创建第二个“无需再次确认”区。
- 页面明确写当前 Space、所有 Bot 的作用范围。
- 删除固定邮件/购买 preset、`Flag unexpected actions` 技术文案和 checker 可用性提示。

### F3. 操作确认卡与来源回焦

- 扩展现有 `AskCard` / `InterventionRegion`，使用服务端结构化展示和动态按钮文案。
- pending、submitting、accepted、already_handled、expired 和 effect 终态全部来自服务器。
- 长期选择按钮只在响应含可信 remember proposal 时出现。
- 恢复、刷新、双击与多标签页提交不得产生第二次外部动作。
- Bot/对话的 attention 状态点击后直接进入来源 Thread，打开目标 Run 并聚焦确认卡。
- 后台 Run 的完成、失败和取消状态必须在原对话形成可恢复的记录；没有 shell 的取消 Run 也从原对话卡重试。

### F4. 对话成果与执行详情

- 复用现有消息卡展示文件、链接和工具产物；不把成果复制进设置页。
- Execution detail 增加 `操作` 区，展示真实 effect 摘要、对象、时间和终态。
- 失败原因使用安全业务文案，保留既有 detail retry。
- Bot 行和对话预览只负责提示状态并直接打开原对话，不复制结果。

### F5. 移除 Task Center 用户界面

- 删除 Task Center 导航入口、路由、列表页、轮询计数、筛选、分页和独立动作按钮。
- 删除 `TaskCenterView`、`TaskCenterNavEntry` 以及仅服务该列表的 Web 状态和翻译。
- 将通用的“打开 Run 并聚焦确认/状态”能力改名并保留为来源导航能力，不再使用 `TaskCenter*` 命名或模块内存意图。
- 删除仅服务 Task Center 的 RPC/contract/projection；若同一查询仍有其他真实调用方，则改名为对应业务用途并记录调用方。
- 保留 PostgreSQL 的 Task、Run、Attempt、Intervention、ExternalEffect 和 Worker 执行模型。它们是系统执行记录，不是用户管理的新会话或中心。
- MR-01 的重试入口收敛到原对话失败/取消卡；既有 Task Center E2E 改为来源对话 E2E，不丢验收语义。

### F6. 删除 Draft #81 的错误前端

删除 `BotPermissionsSection`、Bot 级应用摘要、Bot 级停用、capability catalog、advanced input、preview、policyRev 冲突工作台、Shell 级权限草稿和旧 editor 专用 E2E/翻译。Bot Settings 恢复到本任务之前的产品职责；roster 跨 Space 点击恢复原导航。

### F7. UX-03：头部、悬浮头像与 Bot 三 tab 面板

- 删除聊天头部中的 Bot 头像/名称 trigger、模型切换器、Agent 电脑按钮和独立 run 状态 pill；移动端导航改为左上悬浮按钮。
- 在转录区水平居中贴顶放置唯一悬浮头像件，并为首屏内容预留稳定顶部空间，不能遮挡消息或输入框。
- idle 显示常态头像；running 使用状态环并显示 `运行中 · N 项动作`；waiting/approval 使用状态环并显示可理解的事由。状态不能只靠颜色。
- 单击悬浮件打开 Bot panel，再单击收起；键盘可达，`aria-label` 包含 Bot 名称、当前状态和动作。
- 单 Bot panel 使用 hero 头像、名称、头衔和 `详情 / 资料库 / 电脑` 三 tab；hero 点击继续打开 AvatarStudio。
- `详情`：例行任务列表/开关、名称/头衔/描述、通知、模型与思考深度、记忆范围、朗读/音色、导出/清空及其他既有 Bot 设置。例行任务完整编辑仍钻入 RoutineEditor。
- `资料库`：现有 KnowledgeSection 与 ScratchpadSection。
- `电脑`：ComputerModePicker、实时屏幕、维护动作和打开完整窗口。
- 面板头部只保留导出与关闭两个操作；既有 computer/settings 互切所需语义收进 tab，不再返回聊天头部。
- 群聊显示成员头像簇（前 3 个 + 计数），点击进入既有 group settings；不得把群设置改造成单 Bot 三 tab。
- 窄屏悬浮件收为头像/头像簇，隐藏长状态文案但保留可访问名称；不得新增另一套移动端管理页。
- 全部已有 Bot 管理能力必须逐项迁移，不能因布局重构丢失；CAP-01 平台级应用和规则明确不迁入该面板。

## 6. 后端任务

### B1. Connect Apps 现有契约不变

- 不为 Connect Apps 新增 API、schema、migration、作用域模型或第二套目录。
- 继续使用现有 `connections.catalog/list`、连接生命周期和 `PluginsOverlay` 调用链。
- `activeBotId` 及按 Bot 的 MCP assignment 只保留它们在现有自定义 MCP / 高级连接流程中的真实用途；本任务不重定义该用途。
- Draft #81 若为旧权限编辑器或错误的 per-Bot 普通应用方案改变了 Connect Apps、连接解析或 executor 可见性，应回退到 `main` 行为。
- 本项只做受影响路径的回归验证，不以 CAP-01 名义重测或重构整个应用目录。

### B2. Auto-review 与自然语言规则

保留现有 `ActionAutoReviewPreference.enabled`，作用域固定为 `spaceId + userId`。自定义规则是用户能理解的动作句子与结果，不是底层 capability policy：

```ts
type UserActionRule = {
  id: string;
  instruction: string;
  decision: "require_approval" | "allow";
  source: "settings" | "approval_card" | "legacy";
  actionKey?: string; // 仅服务端可信来源生成；表单不能提交
  sourceEffectId?: string;
  createdAt: string;
};

actionRules.list(): { autoReviewEnabled: boolean; items: UserActionRule[] }
actionRules.setAutoReview({ enabled: boolean }): { autoReviewEnabled: boolean }
actionRules.create({ instruction, decision }): { item: UserActionRule }
actionRules.update({ id, instruction, decision }): { item: UserActionRule }
actionRules.remove({ id }): { ok: true }
```

- 服务端校验 Space/用户归属、空白、长度和数量，并写现有审计事件。
- `instruction` 是用户数据，只进入既有 action-review 输入，不提升为 system 指令。
- `allow` 只跳过可由用户决定的默认/model review；它不能连接应用、扩大资源范围、推翻服务端 deny/撤权，也不能跳过 secret、takeover、Plan gate 或其他固定边界。
- 多条规则同时命中时，`require_approval` 永远优先。
- Auto-review 关闭时不运行模型审核；服务端固定要求确认或禁止的动作继续执行原有边界。

### B3. 受信任的动作展示与身份

工具进入审批边界前，由受信任适配器生成：

```ts
type ApprovalActionPresentation = {
  title: string;
  fields: Array<{ label: string; value: string }>;
  impact: string;
  detail?: string;
  approveLabel: string;
  denyLabel: string;
  remember?: {
    actionKey: string;
    actionTitle: string;
    approveLabel: string;
    scopeLabel: string;
  };
};
```

- 展示随 Intervention 白名单快照持久化。
- 模型不能提供 `actionKey`、scope 或按钮语义。
- direct/catalog 路径解析到同一真实动作身份；不得保存 wrapper 名称。
- 不同真实效果、账户或明确资源范围使用不同身份。
- 未注册动作仍可一次允许/拒绝，不显示长期按钮。

### B4. 动作卡保存为同一规则

继续使用 `ActionApprovalRule`，不增加 `botId`。动作卡里的长期按钮与 Settings 中的规则最终进入同一列表：

- 动作卡保存时，服务端以可信 `actionKey` 和面向用户的动作描述创建 `decision="allow"` 规则；客户端不能提交或改写 `actionKey`。
- 保存展示快照、可选 `sourceEffectId` 与来源 `approval_card`，用于设置页和审计。
- Settings 直接创建的自然语言规则没有伪造 `actionKey` 的能力，由既有 action-review 对用户句子做匹配。
- 旧 `matchKind/matchValue` 保持原语义，以 `source="legacy"` 显示并允许修改/删除；迁移不得扩大匹配范围。
- 同一真实动作、账户和明确资源范围的稳定身份继续由受信任适配器生成；Bot 名称不进入规则身份。

### B5. 唯一执行判定

1. 当前 actor、Space、Bot、Connection 和资源权限；
2. 服务端 deny、撤权、Plan gate、secret/takeover 等强制边界；
3. Auto-review 与用户全局自然语言规则；
4. 由真实动作卡保存的稳定 `actionKey` 规则；
5. 默认动作策略；
6. 必要时创建 Intervention。

“先问我”与“自动允许”同时命中时，先问我。一次允许只批准当前 effect；长期允许原子地批准当前 effect 并保存为同一类规则；拒绝不保存。继续使用既有 Intervention 幂等和 `ExternalEffect` exactly-once。

### B6. 结果投影

Execution detail 输出：

```ts
actions: Array<{
  effectId: string;
  title: string;
  targetSummary?: string;
  status: "pending" | "approved" | "executing" | "completed" | "failed" | "denied" | "expired" | "uncertain";
  occurredAt: string;
  result?: { kind: "file" | "link" | "message" | "change" | "receipt"; label: string; href?: string };
  failureReason?: string;
}>
```

- 数据来自 `ExternalEffect` / Intervention 和受信任结果适配器，不从模型正文反推。
- 不返回凭据、完整敏感正文、隐藏请求包装或原始 provider result。
- 对话成果卡和 Execution detail 使用同一结果投影，不复制数据库来源。

### B7. 来源状态与直接导航

- 复用 Bot avatar/read projection 表达 idle、working、waiting/approval 和 failed；不增加全局待办计数。
- attention projection 必须携带可授权的来源 Thread/Run 定位信息，点击后由正常 Thread 授权重新读取目标 Run。
- 后台 completion/delivery、失败和取消必须生成原对话可见记录，且恢复后仍能找到；不能只存在 Task Center projection。
- 同一 Bot 有多个待处理动作时，打开原对话后按事件顺序展示全部未处理 Intervention，不另建聚合队列。

### B8. 删除 Draft #81 错误后端

删除 `bots.capabilityPolicy.get/update/preview`、`capabilityPolicyRev`、`CapabilityPolicyChange`、`bots.actionAccess.*`、per-Bot 普通应用停用 API、`BUILTIN_CAPABILITY_TOOL_IDS`、编辑器 catalog 和为其新增的 preview API。可复用的聚合判定函数必须有当前执行边界的真实调用方；不得留下第二个策略系统。

### B9. UX-03 数据契约复用

- UX-03 不新增持久化模型和第二套 Bot settings API；模型/思考、通知、资料库、草稿板、电脑与例行任务继续复用现有权威契约。
- 悬浮状态复用现有 Bot avatar/read projection 与 Run/Intervention 状态；不得由前端根据文本猜测 running、approval 或动作数量。
- 群成员头像簇复用现有已授权成员投影，不能为显示计数扩大成员可见范围。
- 若删除头部后发现某项既有功能没有可调用入口，应迁移真实入口并补回归，不能保留隐藏 header 作为兼容后门。

## 7. Draft #81 单 PR 实施顺序

1. 同步最新 `main`，删除 #81 的低层权限编辑器与错误的 per-Bot 普通应用改动；Connect Apps 恢复并保持 `main` 行为。
2. 在 Settings → General 完成 Auto-review 与自然语言规则，并接入既有 action-review。
3. 完成结构化确认卡、长期选择、对话成果和 Execution detail 结果投影；移除 Task Center，把状态与重试入口迁回来源对话。
4. 完成 UX-03 头部移除、悬浮头像与三 tab Bot panel，逐项核对既有 Bot 管理能力。
5. 用至少两种不同来源的真实动作收口，并对现有 Connect Apps 做聚焦回归；回写 CAP-01、UX-03、roadmap 和实现说明。

本功能继续一个 PR 完成，不再按前端、后端或迁移拆小 PR。

## 8. 验收标准

### 现有 Connect Apps 不回归

1. 普通应用只在 Connect Apps 管理；Bot Settings 无应用权限或成果区。
2. Connect Apps 使用现有 `PluginsOverlay` 大弹窗，Settings 使用现有 `SettingsOverlay` 大弹窗；主聊天 Shell、弹窗尺寸、关闭行为和响应式外壳不被另画成页面。
3. #81 不新增 Connect Apps API、schema、migration、Bot picker、权限表或第二套目录。
4. 现有连接、重授权、断开与应用详情的聚焦回归通过；本批不重新定义其作用域。
5. 自定义 MCP 与按 Bot assignment 的既有独立语义未被误改。

### 全局操作确认偏好

6. Auto-review 与自定义规则位于 Settings → General 主内容；不新增导航项，也不藏在 Advanced。
7. 用户能开关 Auto-review，并新增、修改、删除自然语言规则；刷新一致，保存失败保留输入。
8. 一条规则只展示自然语言动作和 `先问我 / 自动允许`；页面没有 Bot picker、scope、glob、优先级、checker 或策略测试器。
9. 页面明确说明规则适用于当前 Space 中该用户的所有 Bot；两个不同 Bot 的真实动作都受同一规则影响，其他用户和 Space 不受影响。
10. `先问我` 冲突时优先；`自动允许` 不能授予连接、资源或执行权限，也不能覆盖固定安全边界。

### 当场确认与长期选择

11. 卡片展示真实动作、对象和影响，不出现 toolName、JSON、wrapper 或模型判断过程。
12. 一次按钮只执行当前 effect；刷新、恢复、重复提交和多标签页不会重复外部动作。
13. 长期按钮只在服务端有稳定 proposal 时出现；保存后同 Space 任一 Bot 的同 actionKey 命中。
14. 不同 Space、用户、actionKey、账户和明确不同资源范围不误命中。
15. 拒绝、过期和敏感接管不创建长期选择；确认前无外部副作用。
16. direct/catalog 对同一真实动作使用同一身份。

### 成果和执行结果

17. 文件、链接、发送回执等成果留在原对话；Bot Settings 不出现成果列表。
18. approved/executing/completed/failed/uncertain 来自真实 effect 状态，不能把批准显示为完成。
19. Execution detail 展示本 Run 的动作结果；Bot/对话 attention 点击直接打开并聚焦同一记录。
20. 动作卡创建的长期选择出现在同一规则列表，可修改或删除；删除后任一 Bot 的下次同类动作恢复默认确认行为。
21. legacy 规则保持原范围、可读、可移除，没有静默扩权或丢失。

### 回归与交付

22. 服务端 deny、资源权限、撤权、Plan 审批、secret/takeover 和内部 capability 边界不被绕过。
23. Task Center 导航、路由、视图、轮询计数和专用 projection 已删除；Task/Run 后端执行记录完整保留。
24. 后台 waiting/completed/failed/cancelled 四种状态都能从来源 Bot/对话发现；点击直接到原 Run，没有第二个任务列表。
25. 没有 shell 的取消 Run 在原对话仍可手动重试；MR-01 的同 Task/Thread/new Run 语义不变。
26. 删除 #81 的废弃 UI/API/schema/migration；普通用户从 Connect Apps 管应用，从 Settings → General 管 Auto-review 和自定义规则，没有第三个权限入口。
27. roster 跨 Space、approval resume、AG-08 撤权恢复与 UX-02 Plan review 不回归。
28. 至少两个 Bot、两种真实动作完成 PG/executor/E2E，断言真实 HTTP/effect/文件或消息结果。
29. 受影响包 check、后端定向单测、PG 旅程和聚焦 E2E 通过；不重复跑与本批无关的全量套件。
30. 实现说明列出连接模型迁移、Task Center 删除面、真实支持动作、降级路径、删除文件、测试数字与截图证据。未部署。

### UX-03 管理面收敛

31. 单 Bot 聊天头部不再显示名称行、模型切换器、Agent 电脑按钮或独立 run pill；这些功能均有明确新入口。
32. 悬浮头像水平居中贴顶、固定在转录区且不遮挡首条消息或输入；单击打开 panel，再次单击收起。
33. idle/running/waiting-approval/failed 使用现有头像状态投影；running 与 approval 的状态环和文案属于同一悬浮件，且不用颜色作为唯一信息。
34. Bot panel hero 显示头像、名称、头衔；点击头像仍能打开 AvatarStudio 并完成换装。
35. `详情` tab 包含例行任务、Bot 基本信息、通知、模型/思考、其他既有设置、导出/清空；RoutineEditor 仍是完整编辑入口。
36. `资料库` tab 完整承载 KnowledgeSection 与 ScratchpadSection；`电脑` tab 完整承载模式、实时屏幕、维护和完整窗口入口。
37. Bot panel 没有 Connect Apps、Auto-review、自定义规则、内部 capability policy 或成果列表。
38. 群聊显示前 3 个成员头像加计数，点击进入既有 group settings；群设置的信息架构和已有能力不变。
39. 移动端有可达的导航和悬浮头像入口；键盘、focus ring、aria-label、Esc/关闭与打开后焦点行为通过回归。
40. UX-01 执行卡、UX-02 Plan review、Avatar 状态动画、roster 跨 Space、来源对话 approval/retry 与 computer session 不回归。

## 9. 交付物

- 当前任务：`docs/tasks/CAP-01.md`
- 当前可交互原型：`/Users/rivers/Documents/WorkPal-design/cap01-global-action-controls-v6/index.html`
- 当前设计说明：`/Users/rivers/Documents/WorkPal-design/cap01-global-action-controls-v6/design-notes.md`
- UX-03 决策：`docs/ux/UX-03-decision.md`
- UX-03 冻结原型：`/Users/rivers/Documents/WorkPal-design/ux03-bot-panel-tabs/index.html`
- UX-03 设计说明与截图：`/Users/rivers/Documents/WorkPal-design/ux03-bot-panel-tabs/design-notes.md`、`shots/`
- v1/v2/v3 任务与 v1–v5 旧原型完整保留作历史，不再作为实现依据。
