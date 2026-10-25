# CARD-01A：严格协议、服务端投影与旧消息适配

状态：`not-started`（implementation-ready；协议输入已冻结）

父任务：[CARD-01 卡片统一与拓展](./CARD-01.md)

依赖：RT-11 已合入（`message_group` 请求身份、`collaboration_receipt` 和 outcome 事实）。阻塞 [CARD-01B](./CARD-01B.md)、[CARD-01C](./CARD-01C.md)、[CARD-01D](./CARD-01D.md)。[RT-12](../roundtable/roundtable-implementation-plan.md#rt-12-增加跨群成员审批和恢复) 依赖本任务与 CARD-01B。

## 用户结果

服务端向 Web 提供一组严格、可穷尽检查的 Interaction 与 Display 投影。旧消息继续可读，但新协议不再靠可选字段组合猜类型。CARD-01 总 feature gate 已存在且默认关闭。

## 输入

- [CARD-01 决策](../cards/CARD-01-decision.md)
- [生产实现盘点](../cards/CARD-01-implementation-inventory.md)
- 已批准原型：[PRD](../cards/source/card-unification-v2/card-requirements.md)、[统一说明](../cards/source/card-unification-v2/card-unification.md)、[STYLE-SPEC](../cards/source/card-unification-v2/mockup/cards-hifi-v4/STYLE-SPEC.md)
- 目标场景：`cards.html` 的 A1–A13、D1–D7、B1–B7；`a-detail.html` 的 V1–V7；`b-alerts.html` 的 N1–N4
- RT-11 已合入事实：`packages/contracts/src/events.ts` 的 `CollaborationReceiptBlock` / `DestinationLocator`，`packages/adapters/src/message-group.ts` 的来源 receipt、Run origin 和 outcome 回流
- `group_membership` 视觉基线（Roundtable 已确认原型，不是 CARD A14）：
  - `docs/roundtable/prototype/index.html?branch=X-GROUP-APPROVE`
  - `docs/roundtable/prototype/index.html?branch=X-GROUP-FAIL`
  - `docs/roundtable/audits/evidence/prototype/branch-X-GROUP-APPROVE.png`
  - `docs/roundtable/audits/evidence/prototype/branch-X-GROUP-FAIL.png`
  - `docs/roundtable/audits/evidence/prototype/narrow-branch-X-GROUP-APPROVE.png`
  - `docs/roundtable/audits/evidence/prototype/narrow-branch-X-GROUP-FAIL.png`

## 开工前冻结

以下规则已由产品负责人确认，直接作为开工条件；实现发现冲突时必须停止并报告，不得自行改设计：

1. `SessionControlView` 只从 Run、执行租约和 Computer 控制租约派生，不新增持久 Intervention。`takeover` 来自 `waiting_takeover`；`return` 要求 `Computer.controlRunId === run.id` 且用户控制租约仍有效。历史 `computer` block 只能展示，不能充当权限或当前状态来源。
2. 旧块使用三个不同严格成员：
   - `app_connect → connect.app_authorization`
   - `mcp_approval → connect.mcp_assignment`，且必须展示当前 `allowAllTools: true` 的风险范围
   - `skill_draft → requestApproval(skill_save)`，权威事务是 TaughtSkill 保存，不是工具执行
   三者都不得退化为通用 `requestApproval(tool)`、其他审批变体或 `DisplayBlock`。
3. 旧 `card`、`connect` 在 CARD-01A 合并后禁止新增生产者；历史记录长期只读回放。移除必须另立迁移任务，完成历史数据 backfill 并证明库内无旧形态后才能删除解码器；CARD-01 不负责移除。
4. attention queue 的数据边界是当前 actor 有权访问的线程中，所有仍需本人处理的 Interaction 投影：持久 Intervention、当前有效的 `SessionControlView`，以及完成严格映射后的 pending 业务审批。排除普通 Run、Run 历史、后台任务和旧 `connect` 回放。排序冻结为 `expiresAt ASC NULLS LAST → attentionAt ASC → stableId ASC`，按 `interactionId + revision` 去重并分页。
5. 总 gate 内部 key 为 `cards_unified_v2`，环境变量为 `CARDS_UNIFIED_V2_ENABLED`，默认 `false`，非法值启动失败。服务端统一解析并向 Web 投影能力；Web 不得读取另一套环境变量。不得复用 roundtable 四项 gate。
6. `group_membership` 是 `ActionApprovalView` 的严格成员，语义固定为 `requestApproval(group_membership)`，不是通用 `requestApproval(tool)`。只支持 `action = add_bot_to_group`、目标 standard group、一个明确 Bot、一个明确的 `message_group` 请求、`requestRevision`、可选 `expiresAt` 和可寻址来源。严格 payload 至少包含：
   - `kind: group_membership`
   - `action: add_bot_to_group`
   - `groupId`
   - `botId`
   - `messageGroupRequestId` 或等价稳定请求标识
   - `requestRevision`
   - `sourceThreadId`
   - `sourceMessageId` 或等价 receipt 关联
   - `expiresAt`，允许为空
   - 安全 presentation 字段

   约束：
   - 不使用任意 tool name 或任意 args，不退化为 `requestApproval(tool)`。
   - 批准只表示允许把该 Bot 加入该群，并继续绑定的 `message_group` 请求；不授权群内其他动作、文件、连接器或凭据。
   - RT-12 在执行批准时重新校验当前用户、Space、group、Bot、成员管理权限、`requestRevision` 和 expiry。
   - 批准前不加群、不写目标群消息、不创建目标 Task/Run；拒绝、过期或撤回不产生目标群副作用。
   - 用户没有成员管理权限时不创建 `ActionApprovalView`；无权限路径使用 X-GROUP-FAIL 的独立失败状态。
   - `group_membership` 的状态仍由 Intervention 管理；成员变更结果由业务事务和审计事实管理。不把 Intervention、Run 和成员变更合成一个状态字段。
7. `collaboration_receipt` 保持业务 receipt MessageBlock，不是 `InputRequestView`、`ActionApprovalView`、`PlanReviewView` 或 `SessionControlView`；不进入 attention queue，不转换成普通 Markdown。CARD-01B 之后可以复用 Card Shell 的无状态展示组件，但不得改变 receipt 的持久协议、状态所有权或 destination locator。
8. private pair receipt 属于消息 affordance：只显示单行轻回执或展开名单，不使用 Card Shell，不进入 attention queue，不新增侧栏入口。对应 RT-09 / FIX-PAIR-B，RT-09 在 CARD-01B 之前完成。
9. `task_status` 属于 `DisplayBlock`，只展示正式工作投影，不代表 pending Interaction，不进入 attention queue，不从原始 Run/Attempt 字段猜状态。
10. PD-01 Retry 属于消息操作，不是 CARD-01 卡片成员；不改变 ExecutionCard 四信号规则，不恢复 Task Center，单独走 PD-01P 和 PD-01F。
11. 本任务只提供 `group_membership` 的协议和投影；RT-12 负责业务状态和持久事实，CARD-01B 负责 Card Shell 和 Interaction renderer，CARD-01E 承担最终视觉验收。不得在本任务修改 Web 页面。

## 实施范围

- 在 `packages/contracts` 新增判别联合 `InteractionView`：`InputRequestView | ActionApprovalView | PlanReviewView | SessionControlView`，以及有限 `DisplayBlock`。
- `ActionApprovalView` 使用不同严格 payload：`tool`、`payment`、`outbound`、`routine`、`install`、`skill_save`、`connect.app_authorization`、`connect.mcp_assignment`、`group_membership`。`skill_save` 的权威是 TaughtSkill 业务事务；`connect.mcp_assignment` 投影携带 `allowAllTools: true` 的明确风险字段，供 CARD-01B 渲染；`group_membership` 使用上面的严格 payload，绑定 `message_group` 请求身份和 request revision。
- 保留 RT-11 已落地的 `collaboration_receipt` MessageBlock 和 `DestinationLocator`：在投影层原样透传，不把 receipt 映射成 InteractionView、DisplayBlock 或 attention 条目。若复用 Card Shell 展示组件，只允许无状态展示复用。
- 保留 private pair receipt 的消息 affordance 语义；不在本任务为它新增 Interaction 或 Card Shell 成员。RT-09 的视觉实现独立完成。
- 为 `DisplayBlock.task_status` 保留独立契约；不得把 `collaboration_receipt`、private receipt 或 PD-01 Retry 归入 `task_status`。
- `SessionControlView` 从 `waiting_takeover`、执行租约和 Computer `controlRunId`/控制租约派生；`return` 必须同时校验 Run 与用户控制租约。不新增持久 Intervention。
- 保持现有 `InterventionKindSchema`、`InterventionViewSchema` 和事件载荷为线上兼容 wire；不得直接改 kind 枚举破坏旧客户端或事件重放。
- `PlanReviewView` 对应独立 `plan_review`，永远不带 `approval.effectId`；批准计划不批准工具、连接器或凭据。
- 每个成员使用 strict schema；`presentation` 不携带答案明文、密钥或 ExternalEffect 请求/结果。
- 在服务端补齐从现有 Intervention、message block 和业务事实到新投影的适配。旧 `ask` 与 `legacy_<messageId>` 继续读时合成，不 backfill。
- 旧 `card`、`connect` 只提供历史只读降级，合并后不得新增生产者；非法或未实现组合必须明确失败或保持禁用。
- 增加默认关闭的 `cards_unified_v2` gate（`CARDS_UNIFIED_V2_ENABLED=false`），非法值启动失败。gate 关闭时生产行为不变，开启后才允许新投影；capability 由服务端投影，Web 不读环境变量。
- 定义 attention DTO/投影契约，覆盖三类 pending 来源和排序键；不在本任务实现有界查询/RPC、Web queue 或卡片渲染。
- 在投影中定义固定排序字段/语义：pending 卡全部先于 terminal；pending 内 `PlanReviewView → ActionApprovalView → InputRequestView`，同类型按 `createdAt ASC → stableId ASC`；terminal 历史不按类型排序，只按 `createdAt ASC → stableId ASC`。不在本任务修改 Web，统一排序由 CARD-01B 实现和测试。

## 允许修改

- `packages/contracts/` 中 Intervention、event、snapshot、domain 相关契约与测试；既有交互 RPC 只可调整 Interaction 投影返回形状，不新增 attention 查询
- `packages/db/` 中 Intervention 投影与旧消息读时合成
- `apps/api/` 中 thread snapshot、execution snapshot、router 和适配层
- 新增 feature gate 所需的后端配置与测试
- 必要的 schema/类型导出；除非映射冻结明确需要，否则不新增数据库迁移

## 禁止

- 修改 Web 页面视觉或组件结构（由 B/C/D 完成）
- 实现 attention 有界查询/RPC 或 Web queue（由 CARD-01D 完成）
- 修改 Run 状态机、ExternalEffect 执行权栅栏、权限模型或结算语义
- 将 `plan_review` 合入 `approval`
- 把 `group_membership` 退化为 `requestApproval(tool)`，或在本任务实现加群事务
- 把 `collaboration_receipt`、private pair receipt 或 PD-01 Retry 映射成 InteractionView、DisplayBlock 或 attention 条目
- backfill 旧消息、恢复 Task Center、或新增通用 `action` block
- 在 gate 默认关闭时改变现有生产响应

## 验收

- 契约单测证明四类成员穷尽、strict、非法组合被拒绝，`plan_review` 与 effect 互斥。
- `ActionApprovalView` 测试证明 `skill_save`、`connect.app_authorization`、`connect.mcp_assignment` 是不同 payload；A8 不出现 `requestApproval(tool)`。
- `group_membership` 契约测试证明：只接受 `add_bot_to_group` 的严格 payload（`groupId`、`botId`、`messageGroupRequestId`、`requestRevision`、`sourceThreadId`、`sourceMessageId`、可选 `expiresAt`、安全 presentation），拒绝任意 tool name/args；不会退化为 `requestApproval(tool)`；无成员管理权限时不生成 ActionApprovalView。
- `collaboration_receipt` 测试证明它仍是 MessageBlock，不被投影成任一 InteractionView，不进入 attention DTO；`sent/completed/failed/cancelled` 和 locator 由 RT-11 事实原样透传。
- private pair receipt、`DisplayBlock.task_status` 和 PD-01 Retry 的分类测试：前者是消息 affordance，中者是展示成员，后者是消息操作；三者都不进入 attention queue。
- 本任务 diff 不包含 Web 页面视觉或组件结构改动。
- MCP assignment 投影必须携带明确的 `allowAllTools: true` 风险字段和 `connect.mcp_assignment` 类型；卡片如何分层展示由 CARD-01B 验收，A 不修改 Web。
- DB/Postgres 测试覆盖 pending、terminal、legacy ask、跨线程来源、revision 和 plan review。
- API 测试证明 gate 关闭时旧响应不变；开启后投影包含可寻址来源和安全字段；gate 非法值启动失败。
- 旧消息回放 fixture 证明已结算 ask 不会重复生成可操作卡；旧 `card`/`connect` 只读且无新生产者。
- `SessionControlView` 测试覆盖 `waiting_takeover`、`controlRunId` 匹配、控制租约失效和历史 computer block 无权限作用。
- attention DTO 测试覆盖三类来源（持久 Intervention、有效 `SessionControlView`、strict pending 业务审批）、排序键、去重键和排除普通 Run/历史/旧 connect；有界查询、排序执行、分页和 Web 渲染由 CARD-01D 验证。
- Interaction 投影包含排序字段/语义：pending 先于 terminal；pending 内 `PlanReviewView → ActionApprovalView → InputRequestView`，同类型和 terminal 历史均按 `createdAt ASC → stableId ASC`；Web 排序实现由 CARD-01B 验证。
- 扫描证明无答案、密钥、地址、付款正文或 ExternalEffect 请求/结果泄漏。
- 对照原型 A13 验证 `PlanReviewView(plan_review)` 没有回到 `requestApproval(tool)`。

## 交付

提交契约映射、实现、测试和 gate 说明。不得开启 gate，不得开始 B/C/D 的 UI 工作。`group_membership` 在本任务只冻结协议和投影；加群事务、权限重校验和副作用由 RT-12 交付。
