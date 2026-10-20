# CAP-01 — 全局应用、操作确认与成果闭环

Status: `in-progress`。Draft PR [#81](https://github.com/huiliuxu780/WorkPal/pull/81) 必须按本任务重做；未合并、未部署。代码核对基线 `main @ 472f0b1`。

历史设计完整保留：

- [v1 低层权限规则编辑器](./archive/CAP-01-low-level-editor.md)：把内部策略暴露给用户，已否决。
- [v2 两界面草案](./archive/CAP-01-two-surface-draft.md)：仍以技术权限为中心，已否决。
- [v3 按 Bot 管理应用草案](./archive/CAP-01-per-bot-apps-draft.md)：错误地把账号级应用和长期选择放进 Bot 设置，已否决。
- 当前实施契约只有本文件。

## 1. 已核实的产品事实

Grok Bot 的信息架构不是“每个 Bot 配一套应用权限”：

- 已连接应用对同一账号下的所有 Bot 可用；应用由侧栏 `Connect apps` 管理。
- Settings 管全局的 Auto-review / Custom Rules，而不是某个 Bot 的工具表。
- 单个 Bot 的设置用于名称、头像、标签和稳定角色等 Bot 自身信息。
- 文件、图片、链接和工具结果作为卡片留在产生它们的对话中。

官方来源：

- [Connect apps](https://cursor.com/help/grok-bot/connect-apps)
- [Work with connected apps](https://cursor.com/docs/grok-bot/work)
- [Settings](https://cursor.com/docs/grok-bot/settings)
- [Bots](https://docs.x.ai/grok-bot/bots)
- [Files and results](https://docs.x.ai/grok-bot/files-and-results)

WorkPal 当前代码有按 Bot 的 MCP assignment 和 `Bot.capabilityRules`。这是现存实现事实，不是用户界面必须照搬的产品模型。本任务保留它们作为运行时兼容和强制边界；普通用户连接的应用按当前 Space 的账号级能力呈现，供该用户的所有 Bot 使用。

## 2. 设计北极星

**用户连接一次应用，所有 Bot 都能在已有授权范围内使用；用户只在平台设置里表达什么时候需要确认，在动作发生时作决定，在原对话里拿到成果。**

系统负责工具注册、资源授权、deny、撤权、幂等和审计。用户不配置 tool、scope、glob、优先级、catalog 或 Bot 级权限矩阵。

邮件、付款、文档、日历和数据库都是示例，不是固定权限分类。生产界面只能显示当前真实连接、真实动作和真实结果。

## 3. 信息架构

| 用户问题 | 唯一入口 | 内容 | 不放在这里的内容 |
| --- | --- | --- | --- |
| 我连接了哪些应用？ | 侧栏 `Connect Apps` | 当前 Space 的连接、登录状态、连接/断开 | Bot 选择器、每 Bot 开关、工具表 |
| 什么时候先问我？ | 平台 Settings → `操作确认` | 所有 Bot 共用的自然语言偏好、从真实审批保存的选择 | 内部策略、应用连接管理 |
| 这一次做不做？ | 产生动作的原对话 | 具体动作、对象、影响、一次允许/以后允许/拒绝 | 规则编辑表单、全局任务队列 |
| 做成了吗？成果在哪？ | 原对话 + Execution detail | 文件/链接/消息/变更结果、真实 effect 状态 | Bot 设置、另建成果后台 |
| 这个 Bot 是谁、怎么工作？ | Bot 设置 | 名称、头像、标签、稳定角色及既有 Bot 选项 | 应用权限、执行结果、长期允许规则 |

本任务不在 Bot 设置新增“应用与操作”“权限”“成果”或“安全”区域。

### 3.1 范围口径

WorkPal 的账号数据按 Space 隔离，因此界面写明：`这些设置适用于当前 Space 中你的所有 Bot。` 不提供 scope 下拉框。跨 Space 不共享连接或操作偏好，除非后续产品任务专门改变租户边界。

## 4. 完整用户流程

### 4.1 全局连接应用

用户从侧栏进入 `Connect Apps`：

- 看见可连接和已连接的应用；
- 登录或重新授权；
- 断开应用；
- 看见一句明确说明：`已连接的应用可供这个 Space 中你的所有 Bot 使用。`

应用行不展示 Bot 名单、每 Bot 开关、底层工具或读写级别。断开是账号级动作，必须说明会影响所有 Bot，并使用既有确认交互。

已连接不代表每个动作都能执行。服务端仍会在执行时检查当前用户、Space、资源、连接状态、强制策略和是否需要确认。

自定义 MCP/开发者服务若现有产品明确采用按 Bot 分配，可继续留在它自己的高级入口；不得混入普通连接应用列表，也不得被本任务静默改成账号级。

### 4.2 全局“什么时候先问我”

平台 Settings 的 `操作确认` 页面包含两段。

第一段 `什么时候先问你？`：

- 用户以一句自然语言新增、编辑、删除偏好，例如“向公司外的人发送内容前先问我”；
- 页面直接说明对当前 Space 中所有 Bot 生效；
- 文本只影响是否提升为确认，不能授予应用、资源或执行权限；
- 保存失败时保留当前输入并可重试。

不提供类别选择器、Bot 选择器、资源 glob、优先级、测试器、冲突工作台或高级模式。

第二段 `无需再次确认`：

- 只展示用户在真实动作确认卡里选择“以后允许”形成的选择；
- 按应用/动作组织，不按 Bot 分组；
- 显示可理解的动作、应用/账户、保存时间和适用范围 `当前 Space 中的所有 Bot`；
- 唯一编辑动作是 `移除`；设置页不能凭空新增允许规则。

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

### F1. Connect Apps 全局口径

- 修改现有 `PluginsOverlay` / Connect Apps 入口，删除普通连接应用的 active Bot 选择和每 Bot assignment 文案。
- 显示账号级说明、连接状态、重新登录、连接和断开。
- 断开前说明会影响当前 Space 中所有 Bot；成功后所有相关运行视图刷新。
- 普通应用行不读取或渲染 connector tool schema。
- 自定义 MCP 若仍是按 Bot 分配，保留独立的高级入口和现有行为，不与普通应用混排。

### F2. 平台操作确认设置

- 重构现有 `AccountSettingsOverlay` → `ApprovalRulesSettings`，页面名为 `操作确认`。
- `什么时候先问你？` 支持短句新增、编辑、删除；Enter/保存提交，Esc/取消当前编辑。
- `无需再次确认` 按应用/动作展示，不显示 Bot 分组；逐行移除。
- 页面明确写当前 Space、所有 Bot 的作用范围。
- 删除固定邮件/购买 preset、`Flag unexpected actions` 开关和内部 auto-review 术语。

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

## 6. 后端任务

### B1. 普通连接应用全局化

先列出当前 `Connection`、managed connector、MCP server 与 `BotMcpServer` 的真实关系并写入实现说明。随后只对普通用户连接应用建立一个权威读取路径：

```ts
apps.connections.list(): {
  scope: "space-user";
  availableTo: "all-bots";
  apps: Array<{
    connectionId: string;
    app: { id: string; name: string; icon: string | null };
    accountLabel: string | null;
    status: "available" | "login_required" | "revoked";
  }>;
}
```

- 连接、重授权、断开复用现有 Connection 生命周期。
- executor 为该用户当前 Space 的任一 Bot 解析普通已连接应用；不能再以 UI 中的 activeBotId 决定普通应用是否可见。
- 当前 per-Bot assignment 数据若只服务普通连接应用，迁移为全局语义后移除；若也服务自定义 MCP，拆分用途并保留 MCP 语义。
- `Bot.capabilityRules`、资源授权、连接器 allowlist 和服务端 deny 继续逐次执行，不进入这个列表。

### B2. 自然语言确认偏好

演进现有 `ActionAutoReviewPreference`，作用域固定为 `spaceId + userId`：

```ts
actionPreferences.instructions.get(): { items: Array<{ id: string; text: string }> }
actionPreferences.instructions.add({ text: string }): { item: { id: string; text: string } }
actionPreferences.instructions.update({ id: string, text: string }): { item: { id: string; text: string } }
actionPreferences.instructions.remove({ id: string }): { ok: true }
```

- 做归属、空白、长度和数量校验，写现有审计事件。
- 文本是用户数据，只进入既有 action-review 输入，不能提升为 system 指令。
- 命中只能把本来可执行的动作提升为确认，不能把 deny 变成 allow。

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

### B4. 全局长期选择

继续使用 `ActionApprovalRule`，不增加 `botId`：

- 新选择作用域为 `spaceId + createdByUserId + actionKey`，必要的账户/资源区别编码进受信任 actionKey。
- 保存展示快照与可选 `sourceEffectId`，用于设置页和审计。
- 旧 `matchKind/matchValue` 保持原语义，列入 legacy 并可移除；不静默扩权。
- 新规则只能由服务器持久化的 remember proposal 产生，客户端不能直接 create/update。

```ts
actionPreferences.saved.list(): {
  items: Array<SavedActionPreference>;
  legacy: SavedActionPreference[];
}
actionPreferences.saved.remove({ id: string }): { ok: true }
```

### B5. 唯一执行判定

1. 当前 actor、Space、Bot、Connection 和资源权限；
2. 服务端 deny、撤权、Plan gate、secret/takeover 等强制边界；
3. 用户全局“先问我”偏好；
4. 已保存的长期允许；
5. 默认动作策略；
6. 必要时创建 Intervention。

“先问我”偏好与长期允许同时命中时，当前显式偏好要求确认。一次允许只批准当前 effect；长期允许原子地批准当前 effect 并保存选择；拒绝不保存。继续使用既有 Intervention 幂等和 `ExternalEffect` exactly-once。

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

## 7. Draft #81 单 PR 实施顺序

1. 把本任务与 v4 原型作为唯一契约，删除 #81 的低层编辑器及 v3 per-Bot app 工作。
2. 盘点并区分普通 connected apps 与自定义 MCP；冻结全局连接契约。
3. 移除 Task Center 用户界面和专用投影，把注意、完成、失败、取消与重试入口迁回来源对话。
4. 完成 Connect Apps 全局化及任一 Bot 的真实工具可用性回归。
5. 完成全局确认偏好及既有 action-review 接线。
6. 完成结构化确认卡和全局长期选择。
7. 完成对话成果卡与 Execution detail 结果投影。
8. 用至少两种不同来源的真实动作收口，回写任务、roadmap 和实现说明。

本功能继续一个 PR 完成，不再按前端、后端或迁移拆小 PR。

## 8. 验收标准

### 全局应用

1. 普通应用只在 Connect Apps 管理；Bot Settings 无应用权限或成果区。
2. 连接一次后，当前 Space 中该用户的两个不同 Bot 都能通过真实 executor 使用该应用；无需逐 Bot 分配。
3. 断开/撤权后两个 Bot 都不再获得或执行相关工具，且零 provider 副作用。
4. 自定义 MCP 的既有独立语义未被普通应用全局化误改。

### 全局操作确认偏好

5. 用户能新增、修改、删除自然语言偏好，刷新一致；失败保留输入。
6. 页面明确显示“当前 Space 中所有 Bot”，没有 Bot picker、scope、glob 或规则优先级。
7. 两个不同 Bot 的真实动作都受同一偏好影响；其他用户和 Space 不受影响。
8. 偏好只能增加确认，不能授予连接、资源或执行权限。

### 当场确认与长期选择

9. 卡片展示真实动作、对象和影响，不出现 toolName、JSON、wrapper 或模型判断过程。
10. 一次按钮只执行当前 effect；刷新、恢复、重复提交和多标签页不会重复外部动作。
11. 长期按钮只在服务端有稳定 proposal 时出现；保存后同 Space 任一 Bot 的同 actionKey 命中。
12. 不同 Space、用户、actionKey、账户和明确不同资源范围不误命中。
13. 拒绝、过期和敏感接管不创建长期选择；确认前无外部副作用。
14. direct/catalog 对同一真实动作使用同一身份。

### 成果和执行结果

15. 文件、链接、发送回执等成果留在原对话；Bot Settings 不出现成果列表。
16. approved/executing/completed/failed/uncertain 来自真实 effect 状态，不能把批准显示为完成。
17. Execution detail 展示本 Run 的动作结果；Bot/对话 attention 点击直接打开并聚焦同一记录。
18. 已保存选择可移除；移除后任一 Bot 的下次同类动作恢复确认。
19. legacy 规则保持原范围、可读、可移除，没有静默扩权或丢失。

### 回归与交付

20. 服务端 deny、资源权限、撤权、Plan 审批、secret/takeover 和内部 capability 边界不被绕过。
21. Task Center 导航、路由、视图、轮询计数和专用 projection 已删除；Task/Run 后端执行记录完整保留。
22. 后台 waiting/completed/failed/cancelled 四种状态都能从来源 Bot/对话发现；点击直接到原 Run，没有第二个任务列表。
23. 没有 shell 的取消 Run 在原对话仍可手动重试；MR-01 的同 Task/Thread/new Run 语义不变。
24. 删除 #81 的废弃 UI/API/schema/migration；普通用户只有 Connect Apps 与平台操作确认两个设置入口。
25. roster 跨 Space、approval resume、AG-08 撤权恢复与 UX-02 Plan review 不回归。
26. 至少两个 Bot、两种真实动作完成 PG/executor/E2E，断言真实 HTTP/effect/文件或消息结果。
27. 受影响包 check、后端定向单测、PG 旅程和聚焦 E2E 通过；不重复跑与本批无关的全量套件。
28. 实现说明列出连接模型迁移、Task Center 删除面、真实支持动作、降级路径、删除文件、测试数字与截图证据。未部署。

## 9. 交付物

- 当前任务：`docs/tasks/CAP-01.md`
- 当前可交互原型：`/Users/rivers/Documents/WorkPal-design/cap01-global-action-controls-v4/index.html`
- 当前设计说明：`/Users/rivers/Documents/WorkPal-design/cap01-global-action-controls-v4/design-notes.md`
- v1/v2/v3 任务与旧原型完整保留作历史，不再作为实现依据。
