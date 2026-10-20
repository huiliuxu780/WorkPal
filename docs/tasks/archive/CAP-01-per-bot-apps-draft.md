# CAP-01 v3（已否决）— 按 Bot 管理应用的草案

Status: `superseded`。2026-10-20 经 Grok Bot 官方资料复核后否决：连接应用是账号级能力，所有 Bot 共用；本稿错误地把应用管理放进 Bot 详情，并把长期选择按 Bot 分组。保留本文件只为决策追溯，不得作为实现契约。

历史设计完整保留：

- [v1 低层权限规则编辑器](./CAP-01-low-level-editor.md)：已否决。
- [v2 两界面草案](./CAP-01-two-surface-draft.md)：覆盖不完整，已否决。
- 当前实施契约为 [CAP-01](../CAP-01.md)。

## 1. 设计北极星

**用户面对的是 Bot、应用和真实动作：先知道 Bot 能接触什么，告诉它什么时候先问，动作发生时看清并决定，之后能确认到底发生了什么。**

底层工具、权限匹配、内部安全策略、执行器和审计都由系统承担，不能变成用户必须配置的工程字段。

这项功能不是“把权限表单做简单一点”，而是完成四个用户任务：

1. **能力可见**：这个 Bot 连接了哪些应用，通常能替我完成什么；我能停用它对某个应用的使用。
2. **事前偏好**：我可以用自己的话告诉 WorkPal 哪些动作先问我，不需要枚举工具或资源模式。
3. **当场决定**：Bot 真要做一件有后果的事时，我能看清对象和影响，决定这一次执行、以后同类动作直接执行，或拒绝。
4. **事后追溯**：我能在原任务里看到动作是否真的完成、失败、被拒绝或结果未知，并撤销已保存的长期选择。

“邮件、付款、文档”都只是例子，不是固定分类、固定栏目或本任务必须创造的新能力。界面内容必须来自 WorkPal 当前真实连接和真实执行路径。

## 2. 参考方式与 WorkPal 的取舍

参考 Grok Bot 的用户模型：审批发生在对话中的具体动作上；一次允许、长期允许和拒绝直接在卡片完成；设置管理用户规则和已保存选择；连接的应用单独管理。

来源：

- [Grok Bot approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Grok Bot settings](https://cursor.com/docs/grok-bot/settings)

WorkPal 采用相同的信息分工，不复制其企业后台或内部规则语言：

| 用户问题 | WorkPal 入口 | 权威对象 |
| --- | --- | --- |
| Alice 能用什么？ | Bot 详情 → 应用与操作 | Bot 的有效应用分配与连接状态 |
| 什么时候先问我？ | 账户设置 → 操作偏好 | 当前用户、当前 Space 的自然语言偏好 |
| 这一次做不做？ | 对话 / Task Center 的确认卡 | 持久化 Intervention + ExternalEffect |
| 最后做成了吗？ | 原执行卡第 2 层 / Task Center 回到原 Run | ExternalEffect 的真实结果 |
| 哪些动作以后不再问？ | 账户设置 → 操作偏好 → 已保存选择 | ActionApprovalRule |

## 3. 完整用户流程

### 3.1 看 Bot 能做什么

用户从 Bot 详情进入「应用与操作」。页面按应用展示：

- 应用图标和名称；
- 当前连接的账户名称；
- 这个 Bot 能进行的 2–5 条用户任务，例如“查看并整理邮件”“起草和发送邮件”，由连接器注册信息提供；
- 当前状态：可用、需要登录、已停用；
- `管理应用` 或 `为此 Bot 停用`。

这里不展示工具清单、toolName、权限等级、读写位、scope 或规则优先级。用户停用的是“这个 Bot 使用 Gmail”，不是编辑一组 Gmail 工具规则。

连接账户仍在现有 Connect Apps 管理；从某个 Bot 停用应用只解除该 Bot 的分配，不撤销用户账户连接，也不影响其他 Bot。真正撤销账户连接继续跳转 Connect Apps。

内置能力如果没有可关闭的产品入口，不在这里伪装成应用开关。页面只展示用户能够理解并采取动作的项目。

### 3.2 事前表达“什么时候先问我”

账户设置的「操作偏好」顶部提供一个简洁的自然语言区域：

- 标题：`什么时候先问你？`
- 说明：`写下你希望 WorkPal 在执行前确认的情况。`
- 每条偏好是一句用户语言，可新增、修改、删除，例如“向公司外的人发送内容前先问我”。例句只是输入提示，不生成固定类别。
- 偏好适用于当前用户在当前 Space 的所有 Bot，界面直接写清这一范围，不提供 scope 下拉框。

这不是 Bot 指令编辑器。偏好只参与动作审批判断，不能改变 Bot 任务、连接权限或服务端强制边界。

保存后即时生效；失败时保留当前文字并提供重试。无需整页草稿、跨 Bot 切换守卫、差异工作台或高级模式。

### 3.3 当场确认真实动作

确认卡回答三个问题：

- Bot 要做什么？
- 会影响谁或什么？
- 执行后会发生什么？

卡片结构：

1. 标题：`<Bot 名称> 想要 <动作>`，动作使用业务语言。
2. 关键字段：用 2–4 行展示对象和值；长正文使用“查看完整内容”。
3. 当前影响：一句话说明发送、修改、删除、发布或其他真实后果。
4. 动作按钮使用当前动作的动词：
   - 当前动作，例如 `发送这封邮件`：只批准当前 effect。
   - 长期选择，例如 `以后直接发送`：批准当前 effect，并保存服务端已定义的同类动作范围。
   - 拒绝，例如 `不发送`：拒绝当前 effect，不保存长期选择。

长期按钮只在系统能够给出稳定且人类可读的范围时出现；辅助文字必须写清范围，例如“以后 Alice 使用 Gmail 发送邮件时不再询问”。不能再弹第二个规则表单。

无法形成长期范围的动作仍完整支持当前一次执行/拒绝，用户不需要补填任何配置。

密码、验证码、支付确认、CAPTCHA 或其他需要用户亲自完成的步骤显示为“接管完成”，不提供长期允许。它们属于当前任务的交接状态，不属于操作偏好。

后台 Run 的确认继续出现在 Task Center 的注意状态，并回到同一 Run 的同一 Intervention；不另建后台审批中心。

### 3.4 查看结果与处理异常

用户做出决定后，卡片保留在原执行记录中，并分别展示：

- 已批准，正在执行；
- 已完成；
- 已失败；
- 已拒绝；
- 已过期；
- 结果未知，需要用户选择现有的恢复动作。

批准不等于完成。对外发送、文件修改等真实结果来自 `ExternalEffect`，不能用按钮成功状态冒充。

原执行卡第 2 层增加「操作」区，列出本 Run 的关键 effect：人类可读动作、对象摘要、状态和时间。Task Center 只负责导航到原 Run，不复制一份独立日志页面。

### 3.5 管理长期选择

账户设置「操作偏好」的第二部分是「无需再次确认」：

- 按 Bot 分组；
- 显示动作名称、应用/账户说明、保存时间；
- 唯一动作是 `移除`。

移除后，下次命中该动作恢复正常审批流程。长期选择只能从一次真实确认产生，设置页不提供“新增允许规则”。

旧账户/Space 级审批规则继续按原范围生效，放在「以前保存的选择」分组，可移除；不能静默转成 Bot 范围。

## 4. 界面结构

### 4.1 Bot 详情 → 应用与操作

在现有 BotSettings 中增加轻量区块，位置在通知之后、Advanced 之前：

- 默认展示最多 3 个已分配应用；更多时进入 Connect Apps。
- 每个应用一行，不展开底层工具表。
- 主动作：`管理应用`。
- 次动作：`为此 Bot 停用`；执行成功后列表更新。
- 空状态：`这个 Bot 还没有连接应用。` + `连接应用`。

### 4.2 账户设置 → 操作偏好

改造现有 `ApprovalRulesSettings`，保留一个页面内的两段：

1. `什么时候先问你？`：自然语言偏好列表。
2. `无需再次确认`：从真实审批卡保存的长期选择。

删除当前固定的邮件/购买 preset 和 `Flag unexpected actions` 开关。内部审核是否可用不展示给普通用户。

### 4.3 对话 / 执行卡

扩展现有 `AskCard`、`InterventionRegion` 和 Execution detail，不新建平行组件。审批仍位于折叠详情外；结果历史位于第 2 层。

## 5. 前端任务

### F1. Bot 应用摘要

- 新增 `BotAppsSummary`，读取后端给出的 Bot 有效应用摘要。
- 复用 PluginsOverlay/Connect Apps 的图标、名称、连接状态和管理入口。
- 停用成功就地更新；失败保留行并显示业务错误。
- 不读取或渲染 connector tool schema；用户任务描述来自后端产品元数据。

### F2. 自然语言操作偏好

- 重构 `ApprovalRulesSettings`，支持一句一条的新增、编辑、删除。
- 添加采用就地保存：Enter/保存提交当前句，Esc/取消放弃当前新句；编辑失败保留输入。
- 页面直接显示“适用于当前 Space 中你的所有 Bot”。
- 不显示 Auto Review、checker、模型、优先级或规则命中解释。

### F3. 已保存选择

- 同页按 Bot 分组展示长期选择和 legacy 分组。
- 移除时只锁当前行；失败不移除 UI，成功后刷新一致。
- 没有长期选择时显示简洁空状态，不展示预置建议按钮。

### F4. 操作确认卡

- `InterventionPresentation` 扩展为结构化动作展示，不再依赖一段模型生成的 `text/detail` 承担所有信息。
- `AskCard` 使用服务端给出的动态按钮文案；没有长期提案时不显示长期按钮。
- pending、submitting、accepted、already_handled、expired、effect executing/completed/failed/uncertain 全部使用服务器状态。
- 重复点击和页面恢复不得重复执行。

### F5. 操作结果

- Execution detail 增加 Action section，读取服务器投影的 effect summaries。
- 每项显示动作、对象摘要、结果和发生时间；失败展示安全的业务原因。
- Task Center 继续回到原执行记录，不卡片复制、不新建“安全日志”导航。

### F6. 删除旧 #81 前端

删除：

- `BotPermissionsSection`；
- capability catalog、advanced input、preview、冲突差异和整份草稿状态；
- Shell 级权限草稿与切 Bot 守卫；
- 旧 editor 专用翻译和 E2E。

恢复 roster 跨 Space 点击的原 `openSpaceChat` 路径。

## 6. 后端任务

### B1. Bot 有效应用摘要

在现有连接与 Bot assignment 之上提供只读聚合，不创建新权限源：

```ts
bots.actionAccess.get({ botId }): {
  apps: Array<{
    assignmentId: string;
    app: { id: string; name: string; icon: string | null };
    accountLabel: string | null;
    status: "available" | "login_required" | "disabled";
    actions: string[]; // 人类可读、由注册元数据提供
    canDisableForBot: boolean;
  }>;
}

bots.actionAccess.disable({ botId, assignmentId }): { ok: true }
```

- get/disable 复用现有 Bot/Space 授权和 assignment 数据。
- disable 只解除该 Bot 分配，不撤销共享 Connection，不影响其他 Bot。
- `actions` 来自连接器/工具注册的产品描述；不把工具名拆词后冒充用户任务。
- 管理账户连接继续使用现有 Connections API 和 PluginsOverlay。

### B2. 自然语言操作偏好

演进现有 `ActionAutoReviewPreference`，不要新建第二个 Auto Review 系统：

- 增加 `instructions`，存储有顺序的短句，限制总长度和条数。
- `enabled` 不再作为普通用户开关；迁移保留旧值，运行时以存在的偏好和系统配置决定是否执行审阅。
- 偏好作用域固定为当前 `spaceId + userId`。

API：

```ts
actionPreferences.instructions.get(): { items: Array<{ id: string; text: string }> }
actionPreferences.instructions.add({ text: string }): { item: ... }
actionPreferences.instructions.update({ id: string, text: string }): { item: ... }
actionPreferences.instructions.remove({ id: string }): { ok: true }
```

- API 做归属检查、空白/长度/数量校验和基本审计。
- 文本是用户偏好数据，不能拼进 system prompt 充当更高权限指令；只传给既有 action review 输入。
- 审阅只会把默认可执行动作提升为“需要确认”，不能越过 deny，也不能创造权限。

### B3. 动作展示注册

在工具进入审批边界前，由受信任适配器生成：

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

- 当前动作展示随 Intervention 白名单快照持久化，恢复与翻页后不丢。
- 模型不能提供 `actionKey`、scope 或按钮语义。
- catalog 包装调用先解析到真实工具身份，再生成展示与 actionKey；不得持久化 `__catalog_execute`。
- 同一注册动作通过 direct/catalog 路径使用同一 actionKey；具有不同真实效果的动作必须不同。
- 敏感接管动作没有 `remember`。

首批只给仓库中可以通过真实 executor 验证的动作注册产品展示；未注册动作沿用安全的一次审批卡，不伪造业务名称。

### B4. 长期选择

继续使用 `ActionApprovalRule` 作为唯一权威来源：

- 增加可空 `botId`、稳定 `actionKey`、展示快照和可选 `sourceEffectId`。
- 新长期选择固定为当前 `spaceId + userId + botId + actionKey`。
- 旧 `matchKind/matchValue` 记录保持原范围和兼容读取，列入 legacy；不静默迁移到 Bot 范围。
- `always` 选择从服务器持久化的 remember 提案创建，客户端不能直接提交 actionKey。

设置 API：

```ts
actionPreferences.saved.list(): {
  bots: Array<{ bot: BotIdentity; items: SavedActionPreference[] }>;
  legacy: SavedActionPreference[];
}
actionPreferences.saved.remove({ id: string }): { ok: true }
```

设置页没有 create/update/preview/catalog API。

### B5. 执行判定

执行顺序保持一个权威边界：

1. 当前 actor、Bot、Space 与资源权限；
2. 服务端 deny、撤权、Plan gate 和其他强制边界；
3. 用户自然语言“先问我”偏好；
4. 已保存的长期允许；
5. 默认动作策略；
6. 必要时创建 Intervention。

若“先问我”偏好与长期允许同时命中，当前明确偏好优先要求确认。用户不需要看到优先级表。

`仅这一次` 只批准当前 effect；长期选择原子地批准当前 effect 并保存偏好；拒绝不保存。重复提交保持既有 Intervention 幂等和 ExternalEffect exactly-once。

### B6. 结果投影与审计

扩展现有 execution detail 输出：

```ts
actions: Array<{
  effectId: string;
  title: string;
  targetSummary?: string;
  status: "pending" | "approved" | "executing" | "completed" | "failed" | "denied" | "expired" | "uncertain";
  occurredAt: string;
  failureReason?: string;
}>
```

- 数据来自 ExternalEffect/Intervention，不从模型消息反推。
- 不返回原始凭据、完整正文、隐藏请求包装或敏感 result。
- 创建/修改/删除自然语言偏好和长期选择写入现有审计事件体系，记录 actor、space、bot/actionKey、来源 effect 与时间，不再新增 #81 的整份 policy snapshot 审计表。

## 7. #81 改造清单

继续一个 PR #81 完成本功能，不拆前端/后端/迁移/文档 PR。

必须删除旧实现：

- `bots.capabilityPolicy.get/update/preview`；
- `capabilityPolicyRev` 与 `CapabilityPolicyChange`；
- `BUILTIN_CAPABILITY_TOOL_IDS`、旧 catalog 及 `__catalog_execute` UI 身份；
- BotPermissionsSection、policy draft、preview、CAS conflict workbench；
- 与旧编辑器绑定的 E2E、文案和状态工具。

可以保留的内容必须能被当前设计直接使用；不能为了减少删码保留无用户价值的 API 或表。

实施顺序：

1. 删除旧 UI/API/schema/migration并恢复跨 Space 导航。
2. 完成 Bot 应用摘要和停用闭环。
3. 完成自然语言偏好及既有 action review 接线。
4. 完成结构化确认卡和长期选择。
5. 完成 execution detail action result。
6. 用真实 executor 支持的两种不同来源动作做完整收口，回写任务、roadmap 和实现说明。

## 8. 验收标准

### 能力可见

1. Bot 详情只展示真实已分配/可用应用和注册的用户任务，不显示工具名或虚构能力。
2. 为此 Bot 停用应用后刷新一致，该 Bot 不再获得其工具；共享账户连接和其他 Bot 不受影响。
3. 需要登录、已撤权和不可用状态如实显示并链接现有 Connect Apps 处理。

### 事前偏好

4. 用户能用一句自然语言新增、修改、删除“先问我”偏好，重开页面一致；失败保留输入。
5. 偏好只在当前用户与 Space 生效，不改变 Bot 指令、不授予工具或资源权限。
6. 至少两类真实动作证明偏好能把默认执行提升为审批；未命中动作行为不变。

### 当场确认

7. 卡片展示真实动作、对象和影响，不出现 toolName、JSON、scope、glob 或模型判断过程。
8. 当前动作按钮只执行当前 effect 一次；刷新、恢复和重复提交不产生第二次外部动作。
9. 长期按钮只在服务器有稳定 remember 提案时出现；保存后同 Bot 同 actionKey 不再询问。
10. 不同 Bot、Space、actionKey、账户或注册为不同范围的动作不会误命中。
11. 拒绝、过期和敏感接管不创建长期允许；确认前无外部副作用。
12. direct/catalog 对同一真实动作使用同一身份，不能保存 wrapper 名称。

### 结果与管理

13. 批准后的 executing/completed/failed/uncertain 来自真实 effect 状态，不能把“已批准”显示为“已完成”。
14. Execution detail 能看到本 Run 的关键动作结果；Task Center 导航回同一记录，不复制日志。
15. 已保存选择按 Bot 分组并可移除；移除后刷新一致，下次动作重新确认。
16. legacy 规则保持原范围、可读展示和可移除；没有静默扩权或丢失。

### 系统边界与回归

17. 服务端 deny、资源权限、撤权、Plan 审批、secret/takeover 和 Bot capability 强制边界不被任何用户偏好绕过。
18. 删除 #81 旧编辑器及全部废弃 API/schema/migration；普通用户只有一个操作偏好入口。
19. roster 跨 Space 导航、Connect Apps、Task Center 回焦、approval resume、MR-01 retry、AG-08 撤权恢复与 UX-02 Plan review 不回归。
20. 至少两条来自不同执行来源的真实动作完成 PG/executor/E2E；断言真实 HTTP/effect/文件结果，而非只断言文案。
21. 受影响包 check、后端定向单测、PG 旅程和聚焦 E2E 通过；不为本批重复运行无关全量套件。
22. 实现说明列出真实支持的动作、未注册动作降级、旧数据迁移、删除文件及截图证据。未部署。

## 9. 交付物

- 当前任务：`docs/tasks/CAP-01.md`
- 当前可交互原型：`/Users/rivers/Documents/WorkPal-design/cap01-action-controls-v3/index.html`
- 当前设计说明：`/Users/rivers/Documents/WorkPal-design/cap01-action-controls-v3/design-notes.md`
- v1/v2 任务与旧原型完整保留作历史，不再作为实现依据。
