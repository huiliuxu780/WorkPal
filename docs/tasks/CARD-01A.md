# CARD-01A：严格协议、服务端投影与旧消息适配

状态：`not-started`

父任务：[CARD-01 卡片统一与拓展](./CARD-01.md)

依赖：无。阻塞 [CARD-01B](./CARD-01B.md)、[CARD-01C](./CARD-01C.md)、[CARD-01D](./CARD-01D.md)。

## 用户结果

服务端向 Web 提供一组严格、可穷尽检查的 Interaction 与 Display 投影。旧消息继续可读，但新协议不再靠可选字段组合猜类型。CARD-01 总 feature gate 已存在且默认关闭。

## 输入

- [CARD-01 决策](../cards/CARD-01-decision.md)
- [生产实现盘点](../cards/CARD-01-implementation-inventory.md)
- 已批准原型：[PRD](../cards/source/card-unification-v2/card-requirements.md)、[统一说明](../cards/source/card-unification-v2/card-unification.md)、[STYLE-SPEC](../cards/source/card-unification-v2/mockup/cards-hifi-v4/STYLE-SPEC.md)
- 目标场景：`cards.html` 的 A1–A13、D1–D7、B1–B7；`a-detail.html` 的 V1–V7；`b-alerts.html` 的 N1–N4

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

## 实施范围

- 在 `packages/contracts` 新增判别联合 `InteractionView`：`InputRequestView | ActionApprovalView | PlanReviewView | SessionControlView`，以及有限 `DisplayBlock`。
- `ActionApprovalView` 使用不同严格 payload：`tool`、`payment`、`outbound`、`routine`、`install`、`skill_save`、`connect.app_authorization`、`connect.mcp_assignment`。`skill_save` 的权威是 TaughtSkill 业务事务；`connect.mcp_assignment` 投影携带 `allowAllTools: true` 的明确风险字段，供 CARD-01B 渲染。
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
- backfill 旧消息、恢复 Task Center、或新增通用 `action` block
- 在 gate 默认关闭时改变现有生产响应

## 验收

- 契约单测证明四类成员穷尽、strict、非法组合被拒绝，`plan_review` 与 effect 互斥。
- `ActionApprovalView` 测试证明 `skill_save`、`connect.app_authorization`、`connect.mcp_assignment` 是不同 payload；A8 不出现 `requestApproval(tool)`。
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

提交契约映射、实现、测试和 gate 说明。不得开启 gate，不得开始 B/C/D 的 UI 工作。
