# CARD-01 生产实现盘点

状态：只读盘点完成，2026-10-24。基线为 `main @ 37bb38a`。本文是任务拆分依据，不是运行指令，也不授权实现。

## 结论

`main` 尚无 CARD-01 的目标协议层和统一渲染器：

- 不存在 `InteractionView`、`DisplayBlock`、`InputRequestView`、`ActionApprovalView`、`PlanReviewView`、`SessionControlView`。
- 现有线上契约是 strict 的 `InterventionView`（`approval | input | plan_review`）和消息层 `MessageBlock`。
- `plan_review` 已是独立 Intervention，明确不是工具授权；实现必须保持这个边界。
- Web 已有 `AskCard`、`PlanReviewCard`、`InterventionRegion` 和多个独立展示卡，但没有统一 Card Shell，也没有跨会话 attention queue。
- `card`、`connect` 等旧消息仍有兼容负担；`effect-view.ts` 是孤儿，`Task Center` 已退役。

## 协议与投影事实

### Intervention

参考 `packages/contracts/src/intervention.ts`：

- `InterventionKindSchema = approval | input | plan_review`；没有 `session_control`。
- `InterventionViewSchema` 是非判别联合：`input/approval/planReview/presentation` 均可选。
- `planReview` 与 `effectId` 在服务端插入时互斥。
- `approval.effectStatus` 是自由字符串，不是枚举。
- `presentation` 是 strict 白名单，不能携带答案明文、密钥或 ExternalEffect 请求/结果。
- `plan_review` 复用 `waiting_input`；`WaitKind` 仍为 `input | approval | takeover`，没有 `plan_review`。
- DB 投影在 `packages/db/src/interventions.ts`；pending 全量加有界 terminal 窗口，旧 `ask` 在读时合成 `legacy_<messageId>`，不 backfill。
- 线程快照在 `apps/api/src/thread-target.ts` 读取；实时 view 由 `apps/web/src/lib/thread-events.ts` 重建。

### MessageBlock

参考 `packages/contracts/src/events.ts`：

- `ask` 同时承载文本、密钥、选择、审批、建空间和计划审阅，子类型由可选字段组合推导。
- `app_connect`、`mcp_approval`、`skill_draft`、`computer` 是各自独立的 message block，不是 Intervention。
- `chart`、`image`、`file`、`voice_call`、`progress`、`subagent`、`cloud_agent` 属于展示消息。
- `MessageBlock` 成员使用非 strict 的 `z.object`，会 strip 未知字段。

## Web 实现事实

- 根渲染器：`apps/web/src/pages/Shell.tsx` 的 `MessageView` 分支。
- 互动路径：`AskCard`、`InterventionRegion`、`PlanReviewCard`、`ExecutionShell/Card`。
- 独立入口：`ChoiceCard`、`AppConnectCard`、`McpApprovalCard`、Computer 内联卡、`SkillDraftCard`、`CloudAgentCard`。
- 展示路径：图表、图片/文件、`SandboxedHtmlViewer`、`VoiceChatCard`、旧式 KV `card`。
- 已有去重：`coveredAsks` / `suppressAsk` 避免气泡 ask 与 Intervention region 双卡。
- plan review 排序在 `InterventionRegion` 与 `execution-card.ts` 不一致；已冻结为 `PlanReviewView → ActionApprovalView → InputRequestView`，同组 `createdAt ASC → stableId ASC`，由 CARD-01B 统一实现。
- 不存在整卡 40% opacity 的旧实现；失败/过期卡没有重试。
- `plan_review` 当前在 `execution-status.ts` 与 approval 同轨显示，UI 仍为独立卡片。

## 待处理与通知事实

- 没有跨会话 pending Intervention 队列，也没有 `interventions.list` 类 RPC。
- 现有 `ActivityList` 只列 Run，不能区分 input/approval/plan_review，也不携带 intervention id。
- 浏览器通知只覆盖 bot 消息、`run.failed`、`run.cancelled`，不覆盖 Intervention 创建/结算。
- `Task Center` 已退役；CARD-01 不得恢复它。

## 设计系统与测试事实

- 卡片正文使用 `@rakazo/chat-ui` 的 `ChatMarkdown`。
- `@rakazo/ui-tokens` 提供卡片、边框和状态语义色；`@rakazo/ui-web` 提供 Button/Card/Dialog 等 primitives。
- 现有卡片宽度、圆角和标题层级各自实现，统一前必须先固定映射，不能复制 sand 色值。
- 契约、DB/Postgres、API、Core、Web 单元和 Playwright e2e 均有可复用套件。
- 视觉验收目前是 opt-in PNG 输出，没有 `toHaveScreenshot` 基线。
- 现有 feature gate 只有 roundtable 四项，与 CARD-01 无关；CARD-01 需要一个独立总 gate，默认关闭。

## 已冻结映射

2026-10-24 产品负责人已确认，实现不得另行发挥：

1. `SessionControlView` 从 Run、执行租约和 Computer 控制租约派生，不新增持久 Intervention。`takeover` 来自 `waiting_takeover`；`return` 要求 `Computer.controlRunId === run.id` 且用户控制租约仍有效。历史 `computer` block 只展示，不提供权限或当前状态。
2. `app_connect → requestApproval(connect.app_authorization)`；`mcp_approval → requestApproval(connect.mcp_assignment)`。两者使用不同 strict payload，MCP 必须展示 `allowAllTools: true` 的风险范围。
3. `skill_draft → requestApproval(skill_save)`；权威事务是 TaughtSkill 保存，不是工具执行。
4. 旧 `card`、`connect` 合并后禁止新增生产者，历史记录长期只读。移除必须另立迁移任务，完成 backfill 并证明库内无旧形态后才能删除解码器；CARD-01 不负责移除。
5. attention queue 范围为当前 actor 有权访问线程中仍需本人处理的 Interaction：持久 Intervention、当前有效 `SessionControlView`、严格映射后的 pending 业务审批。排除普通 Run、Run 历史、后台任务和旧 `connect` 回放。排序 `expiresAt ASC NULLS LAST → attentionAt ASC → stableId ASC`，按 `interactionId + revision` 去重并分页。
6. 总 gate 使用 `cards_unified_v2` / `CARDS_UNIFIED_V2_ENABLED`，默认 `false`，非法值启动失败。服务端解析并向 Web 投影能力；Web 不读环境变量。gate 关闭时旧行为不变，不复用 roundtable gate。

## 建议切片

与 [CARD-01 决策](./CARD-01-decision.md) 的交付顺序一致：

- A：协议、服务端投影与旧消息适配。
- B：核心 Interaction 与 Card Shell。
- C：DisplayBlock、详情视图与安全 HTML。
- D：attention queue 与 Web 通知。
- E：无障碍、窄屏、深色、旧消息回放、视觉回归与总 gate。
