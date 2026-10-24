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

先提交一页契约映射，产品负责人确认后才能写实现：

1. `SessionControlView` 的数据源。默认使用现有 Run `waiting_takeover` 与 computer 状态派生，不新增持久 Intervention；若必须新增持久实体，停止并另立迁移决策。
2. `skill_draft`、`mcp_approval`、`app_connect` 按批准原型映射为严格审批交互，不从 `DisplayBlock` 绕行，也不保留通用 `action` 兜底。
3. 旧 `card`、`connect` 只读兼容，不再产生新消息，并记录移除期限。
4. attention queue 只读当前用户 pending Interaction，不读 Run 历史。
5. 总 gate 建议名 `cards_unified_v2`，默认 `false`；不得复用 roundtable 四项 gate。

## 实施范围

- 在 `packages/contracts` 新增判别联合 `InteractionView`：`InputRequestView | ActionApprovalView | PlanReviewView | SessionControlView`，以及有限 `DisplayBlock`。
- 保持现有 `InterventionKindSchema`、`InterventionViewSchema` 和事件载荷为线上兼容 wire；不得直接改 kind 枚举破坏旧客户端或事件重放。
- `PlanReviewView` 对应独立 `plan_review`，永远不带 `approval.effectId`；批准计划不批准工具、连接器或凭据。
- 每个成员使用 strict schema；`presentation` 不携带答案明文、密钥或 ExternalEffect 请求/结果。
- 在服务端补齐从现有 Intervention、message block 和业务事实到新投影的适配。旧 `ask` 与 `legacy_<messageId>` 继续读时合成，不 backfill。
- 旧 `card`、`connect` 只提供只读降级；非法或未实现组合必须明确失败或保持禁用。
- 增加默认关闭的 `cards_unified_v2` 总 gate；gate 关闭时生产行为不变，开启后才允许新投影。
- 统一 `InterventionRegion` 与 `execution-card.ts` 对 plan review / approval 的排序事实，避免 Web 层各自定义优先级。

## 允许修改

- `packages/contracts/` 中 Intervention、event、RPC、snapshot、domain 相关契约与测试
- `packages/db/` 中 Intervention 投影与旧消息读时合成
- `apps/api/` 中 thread snapshot、execution snapshot、router 和适配层
- 新增 feature gate 所需的后端配置与测试
- 必要的 schema/类型导出；除非映射冻结明确需要，否则不新增数据库迁移

## 禁止

- 修改 Web 页面视觉或组件结构（由 B/C/D 完成）
- 修改 Run 状态机、ExternalEffect 执行权栅栏、权限模型或结算语义
- 将 `plan_review` 合入 `approval`
- backfill 旧消息、恢复 Task Center、或新增通用 `action` block
- 在 gate 默认关闭时改变现有生产响应

## 验收

- 契约单测证明四类成员穷尽、strict、非法组合被拒绝，`plan_review` 与 effect 互斥。
- DB/Postgres 测试覆盖 pending、terminal、legacy ask、跨线程来源、revision 和 plan review。
- API 测试证明 gate 关闭时旧响应不变；开启后投影包含可寻址来源和安全字段。
- 旧消息回放 fixture 证明已结算 ask 不会重复生成可操作卡。
- 扫描证明无答案、密钥、地址、付款正文或 ExternalEffect 请求/结果泄漏。
- 对照原型 A13 验证 `PlanReviewView(plan_review)` 没有回到 `requestApproval(tool)`。

## 交付

提交契约映射、实现、测试和 gate 说明。不得开启 gate，不得开始 B/C/D 的 UI 工作。
