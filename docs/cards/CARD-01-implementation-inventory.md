# CARD-01 生产实现盘点

状态：只读盘点完成，2026-10-25。基线为 `origin/main @ f1a63a0`（ROADMAP-CARD-CONVERGE 的执行时 main）。本文是任务拆分依据，不是运行指令，也不授权实现。

## 结论

`main` 尚无 CARD-01 的目标协议层和统一渲染器：

- 不存在 `InteractionView`、`DisplayBlock`、`InputRequestView`、`ActionApprovalView`、`PlanReviewView`、`SessionControlView`。
- 现有线上契约是 strict 的 `InterventionView`（`approval | input | plan_review`）和消息层 `MessageBlock`。
- `plan_review` 已是独立 Intervention，明确不是工具授权；实现必须保持这个边界。
- RT-11 已落地 `collaboration_receipt` MessageBlock、`DestinationLocator`、`GroupDestinationReceipt` 和 `message_group` outcome 回流。receipt 仍由生产代码独立渲染，不属于目标 InteractionView。
- Web 已有 `AskCard`、`PlanReviewCard`、`InterventionRegion`、`ExecutionCard` 和多个独立展示卡，但没有统一 Card Shell，也没有跨会话 attention queue。
- `card`、`connect` 等旧消息仍有兼容负担；`effect-view.ts` 是孤儿，Task Center 已退役。

## 协议与投影事实

### Intervention

参考 `packages/contracts/src/intervention.ts`：

- `InterventionKindSchema = approval | input | plan_review`（:12）；没有 `session_control`。
- `InterventionViewSchema`（:89）是非判别联合：`input/approval/planReview/presentation` 均可选。
- `planReview` 与 `effectId` 在服务端插入时互斥。
- `approval.effectStatus` 是自由字符串（:125），不是枚举。
- `presentation` 是 strict 白名单，不能携带答案明文、密钥或 ExternalEffect 请求/结果。
- `plan_review` 复用 `waiting_input`；`WaitKind` 仍为 `input | approval | takeover`，没有 `plan_review`。
- DB 投影在 `packages/db/src/interventions.ts`：pending 全量加有界 terminal 窗口；旧 `ask` 在读时合成 `legacy_<messageId>`（:613-614、:660），不 backfill。
- 线程快照在 `apps/api/src/thread-target.ts:734-902` 读取；实时 view 由 `apps/web/src/lib/thread-events.ts` 重建（:743-746）。

### MessageBlock

参考 `packages/contracts/src/events.ts:343-559`：

- `ask` 同时承载文本、密钥、选择、审批、建空间和计划审阅，子类型由可选字段组合推导。
- `app_connect`、`mcp_approval`、`skill_draft`、`computer` 是各自独立的 message block，不是 Intervention。
- `chart`、`image`、`file`、`voice_call`、`progress`、`subagent`、`cloud_agent` 属于展示消息。
- `MessageBlock` 成员使用非 strict 的 `z.object`，会 strip 未知字段。

### RT-11 已落地的 receipt 事实

- `CollaborationReceiptTarget = group | bot`（`packages/contracts/src/events.ts:315-319`）。
- `DestinationLocator = group_message | pair_message`（:321-325）。`group_message` 携带 `groupId`、`threadId`、`messageId`。
- `CollaborationReceiptBlock`（:327-341）是 `MessageBlock` 成员，携带 `target`、`state = sent | completed | failed | cancelled`、可空 `destination` 和可选的 `display.groupName/topic`。它不是 InteractionView。
- `packages/adapters/src/message-group.ts:231-248` 在来源单聊写入 `state=sent` 的 receipt，并在同一事务中写目标群消息、独立 Task 和 owner Run；Run 持久化 `trigger=message_group` 与 `originThreadId/originRunId/originMessageId`（:262-289）。
- `returnMessageGroupOutcome`（:486-659）把目标 Run 的 `completed | failed | cancelled` 回写到同一 receipt；completed 还会创建来源单聊的汇报 Run。`replaceReceiptState`（:666-677）保留 receipt 的 locator，不伪造完成。
- `replayFromReceipt`（:449-478）用 receipt 的 destination 和 origin 做投递重放。
- `packages/adapters/src/run-origin.ts` 解析可见来源；`message_group` 的等待仍留在目标群（:149），不会把审批投影回来源单聊。
- `apps/web/src/components/ai/GroupDestinationReceipt.tsx:6` 是当前生产 receipt 渲染器，只处理 `target.kind === "group"`，校验 locator 与 target 一致，并从 `destination` 导航。
- `apps/web/src/pages/Shell.tsx:6910-6919` 在来源单聊独立渲染 `GroupDestinationReceipt`；群会话分支直接 `return null`，不复用 private receipt 路径。
- private pair receipt 仍走 `CollaborationMarker` / `onOpenPeerMessages` 的来源轻回执与 peer 对话路径（CF-02 / FIX-PAIR-B）；RT-09 尚未开工。它与 `GroupDestinationReceipt` 是两条独立路径。
- 生产 e2e：`apps/web/e2e/message-group.spec.ts` 覆盖来源 receipt、390px、目标群定位跳转、completed 回流和来源汇报；断言 receipt 不包含 `queued/Run/Task/Thread/attempt/steering`。

### 现有卡片与渲染路径

- 根渲染器：`apps/web/src/pages/Shell.tsx` 的 `MessageView`（:6704 起）。
- Interaction 路径：`apps/web/src/components/AskCard.tsx:49`、`apps/web/src/components/ai/PlanReviewCard.tsx:45`、`apps/web/src/components/ai/InterventionRegion.tsx`、`apps/web/src/components/ai/ExecutionShell.tsx` / `ExecutionCard.tsx:44`。
- 独立消息卡：`ChoiceCard`（`apps/web/src/pages/shell/message-cards.tsx:13`）、`AppConnectCard`（:143）、`McpApprovalCard`（:332）、`SkillDraftCard`（`apps/web/src/components/teach/SkillDraftCard.tsx:25`）、Computer 内联卡（`Shell.tsx:7244`）、`CloudAgentCard`。
- 展示路径：`chart`（`Shell.tsx:7098`）、`image`/`file`（:7114/:7128）、`SandboxedHtmlViewer`（`apps/web/src/components/SandboxedHtmlViewer.tsx:39`）、`VoiceChatCard`、旧式 KV `card`（`Shell.tsx:7202`）。
- `ask` 分支在 `Shell.tsx:7218` 渲染 `AskCard`；`suppressAsk` 来自 `coveredAsks`，用于避免气泡 ask 与 Intervention region 双卡。
- `PlanReviewCard` 仍是独立 `plan_review` 卡，提交 `approve | request_changes | reject`，绑定 `contentVersion`；它与工具审批卡分属不同组件。
- `ExecutionCard` 的显示状态来自 `deriveExecutionStatus`；`plan_review` 在 `apps/web/src/lib/execution-status.ts:51` 映射为 approval rail 的等待标签，但卡片本身仍是独立的。
- `ExecutionCard` 的四种表面信号冻结在 `apps/web/src/lib/execution-surface.ts:17-37`：结构化 Plan、语义 Step、pending Intervention、失败。`cancelled` 不是信号，Retry 是卡上的独立动作。
- 现有 pending 排序在 `apps/web/src/lib/execution-card.ts` 的 `sortedPending` 中只把 `approval`/`plan_review` 并列为同一优先级，再按 `createdAt` 排序；它不是 CARD-01 冻结的 `pending plan review → approval → input` 顺序。CARD-01B 必须统一 `InterventionRegion`、`execution-card.ts` 和共享 renderer。
- 已有去重：`Shell.tsx` 的 `coveredAsks` / `suppressAsk`（:5007、:5370-5371、:5435）避免气泡 ask 与 Intervention region 双卡。
- 不存在整卡 40% opacity 的旧实现；失败/过期卡没有重试。
- `SkillDraftCard` 当前直接读写 `skill_draft` 的 draft/saved 状态；它不是 Intervention。
- `AppConnectCard` 和 `McpApprovalCard` 当前分别执行连接授权和 MCP assignment 审批，使用各自消息块状态（`pending/connected`、`pending/connected/dismissed`），没有统一的严格 ActionApprovalView payload。

### 待处理与通知事实

- 没有跨会话 pending Intervention 队列，也没有 `interventions.list` 类 RPC。
- `apps/web/src/pages/ActivityList.tsx` 只列 Run（`rpc.runs.list`），不能区分 input/approval/plan_review，也不携带 intervention id。
- 浏览器通知只覆盖 bot 消息、`run.failed`、`run.cancelled`（`apps/web/src/lib/browser-notifications.ts:49-66`），不覆盖 Intervention 创建/结算。
- `collaboration_receipt` 是 bot-role 消息，当前 `thread.message.created` 的 bot 分支会把它视为可通知事件；CARD-01D 必须显式排除 receipt，不能靠现有路径继承。
- `Task Center` 已退役；CARD-01 不得恢复它。

## 设计系统与测试事实

- 卡片正文使用 `@rakazo/chat-ui` 的 `ChatMarkdown`。
- `@rakazo/ui-tokens` 提供卡片、边框和状态语义色；`@rakazo/ui-web` 提供 Button/Card/Dialog 等 primitives。
- 现有卡片宽度、圆角和标题层级各自实现，统一前必须先固定映射，不能复制 sand 色值。
- 契约、DB/Postgres、API、Core、Web 单元和 Playwright e2e 均有可复用套件。
- 视觉验收目前是 opt-in PNG 输出，没有 `toHaveScreenshot` 基线。
- 现有 feature gate 只有 roundtable 四项，与 CARD-01 无关；CARD-01 需要一个独立总 gate，默认关闭。

## 已冻结映射

2026-10-24 产品负责人已确认，2026-10-25 规划收敛补充 RT-11 和 UI 所有权。实现不得另行发挥：

1. `SessionControlView` 从 Run、执行租约和 Computer 控制租约派生，不新增持久 Intervention。`takeover` 来自 `waiting_takeover`；`return` 要求 `Computer.controlRunId === run.id` 且用户控制租约仍有效。历史 `computer` block 只展示，不提供权限或当前状态。
2. `app_connect → requestApproval(connect.app_authorization)`；`mcp_approval → requestApproval(connect.mcp_assignment)`。两者使用不同 strict payload，MCP 必须展示 `allowAllTools: true` 的风险范围。
3. `skill_draft → requestApproval(skill_save)`；权威事务是 TaughtSkill 保存，不是工具执行。
4. 旧 `card`、`connect` 合并后禁止新增生产者，历史记录长期只读。移除必须另立迁移任务，完成 backfill 并证明库内无旧形态后才能删除解码器；CARD-01 不负责移除。
5. attention queue 范围为当前 actor 有权访问线程中仍需本人处理的 Interaction：持久 Intervention、当前有效 `SessionControlView`、严格映射后的 pending 业务审批（含 `group_membership`）。排除普通 Run、Run 历史、后台任务、旧 `connect` 回放、`collaboration_receipt`、private pair receipt、`task_status` 和 PD-01 Retry。排序 `expiresAt ASC NULLS LAST → attentionAt ASC → stableId ASC`，按 `interactionId + revision` 去重并分页。
6. 总 gate 使用 `cards_unified_v2` / `CARDS_UNIFIED_V2_ENABLED`，默认 `false`，非法值启动失败。服务端解析并向 Web 投影能力；Web 不读环境变量。gate 关闭时旧行为不变，不复用 roundtable gate。
7. `group_membership` 是 `ActionApprovalView` 的严格成员：`requestApproval(group_membership)`，只支持 `add_bot_to_group`、目标 standard group、一个明确 Bot、一个明确的 `message_group` 请求、`requestRevision`、可选 `expiresAt` 和可寻址来源。它不是通用 `requestApproval(tool)`。详细 payload 和重校验规则见 [CARD-01 决策](./CARD-01-decision.md#group_membership) 与 [CARD-01A](../tasks/CARD-01A.md)。
8. `collaboration_receipt` 保持业务 MessageBlock，不是 Input/Action/Plan/Session 视图，不进入 attention queue。CARD-01B 之后可以复用 Card Shell 的无状态展示组件，但不能改变 receipt 的持久协议、状态所有权或 destination locator。
9. private pair receipt 属于消息 affordance：单行轻回执或展开名单，不使用 Card Shell，不进入 attention queue，不新增侧栏入口；对应 RT-09 / FIX-PAIR-B，CARD-01B 必须保留。
10. `task_status` 属于 DisplayBlock，只展示正式工作投影，不进入 attention queue，不从原始 Run/Attempt 字段猜状态。
11. PD-01 Retry 属于消息操作，不是 CARD-01 卡片成员；不改变 ExecutionCard 四信号规则，不恢复 Task Center，单独走 PD-01P 和 PD-01F。
12. UI owner：CARD-01B 拥有 `Shell.tsx` Interaction renderer 接入、Card Shell、InteractionView renderer、InterventionRegion 统一和 interaction 排序；CARD-01C 拥有 DisplayBlock registry、展示成员、详情组件和安全 HTML。C 在 B 冻结接入接口前不得修改同一 Shell 区域；需要接入时由 B owner 提交集成 commit，或等 B 合入后 rebase。

## 建议切片

与 [CARD-01 决策](./CARD-01-decision.md) 的交付顺序一致：

- A：协议、服务端投影与旧消息适配。
- B：核心 Interaction、Card Shell、Interaction renderer 和排序（依赖 A 与 RT-09）。
- C：DisplayBlock、详情视图与安全 HTML（按 B 冻结的接入接口进入 Shell）。
- D：attention queue 与 Web 通知（排除 receipt 和 private receipt）。
- E：无障碍、窄屏、深色、旧消息回放、视觉回归与总 gate，含 `group_membership` 的 Roundtable 视觉验收。
