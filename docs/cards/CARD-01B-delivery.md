# CARD-01B delivery record

状态：`in-review`（未合并）

- 分支：`codex/card-ui-interactions`
- Worktree：`/Users/rivers/Documents/WorkPal-worktrees/card-ui-interactions`
- Base：`43fb44517339e2822350feec6903e40dd37b703a`（`origin/main`）
- Implementation head：`c78dd29`（本文件单独提交，PR head 以分支顶端为准）

## 交付内容

### CARD-01B Interaction 渲染

- 新增统一 `InteractionCardShell` 和 `InteractionRegion`，渲染 `input_request`、`action_approval`、`plan_review`、`session_control` 四种严格视图。
- `InterventionRegion` 在 `cardsUnifiedV2` 开启时委托给新 region；gate 关闭时保留原 `InterventionRegion` 路径。
- 排序统一走 `compareInteractionViewsForDisplay`：pending 先于 terminal；pending 内 PlanReview → ActionApproval → InputRequest；SessionControl 使用独立 region。
- `coveredAsks` 在 gate 开启时按 `InteractionView.source.messageId` 去重，并抑制同一消息上的 `app_connect`、`mcp_approval`、`skill_draft` 旧 block；`MessageView` 现在接收父级过滤后的 blocks，避免旧卡片从气泡再次渲染。
- Execution headline 使用 server pending 视图的 `presentation.text`；无消息锚点的 pending interaction 渲染在 transcript tail。
- 终态不使用整卡 opacity；使用 inset outline + 文字/符号状态。每张卡最多两个按钮加一个文字入口。
- `group_membership` 不套 Card Shell，继续使用 X-GROUP 内联卡；`GroupMembershipFailureCard` 独立失败态。无成员变更 RPC 时按钮禁用并明确说明尚不可用。
- `session_control` 接管/交还独立显示；关闭面板不等于交还，交还必须点击明确动作。

### RT-09 private pair

- pair 发货时源 Thread 写入 `collaboration_receipt`，包含 `target: { kind: "bot", botId }` 与 `destination: { kind: "pair_message", pairThreadId, messageId }`；pair Thread 保留完整正文。
- `isPeerReceiptBlocks`、消息分页准入与 peer 事件转发识别 bot-target `collaboration_receipt`。
- 新 `PeerReceiptRow` 单行为轻回执，多目标为展开名单；legacy 无 locator 回执显示为不可打开记录，不回退到通用 Thread 拉取。
- `PeerMessagesOverlay` 只调用 `threads.pairMessages`，必须携带 `sourceReceiptMessageId`、pair locator 和分页 cursor；只读无输入框。
- `readPairMessages` 初始页从最新授权消息开始，避免回执之后的回复被 target boundary 隐藏；grant 仍校验 target 与 provenance。
- 删除 `peer-history.ts` / `peer-messages.ts` 及对应测试，避免两套读取路径。
- 推出说明：只有 `ROUNDTABLE_PRIVATE_PAIR_ENABLED=true` 时才会写入带 locator 的 bot-target 回执并可打开 pair 浮窗；历史上的无 locator 回执按设计显示为不可打开的记录，不做通用 Thread 回退。

### 终态交互卡

- strict `InteractionView`（任意状态）本身即为 Execution surface 信号：gate 开启时旧的 `app_connect`/`mcp_approval`/`skill_draft` block 被抑制，若 Run 结算后丢失 surface，终态卡会连同历史一起消失。`execution-surface.ts` 因此保留有 strict interaction 的 Run，终态卡在 region 内按统一排序继续显示。

### CI 选择

- 生产路径 `apps/web/src/components/ai/interactions/**`、`PeerReceiptRow`、`peer-receipts`、`peer-transcript`、`PeerMessagesOverlay`、`InterventionRegion`、`Shell`、`use-execution-transcript` 会选中 `card-ui-interactions.spec.ts` 与 `peer-messages.spec.ts`。
- E2E harness 仅在 `card-ui-interactions.spec.ts` 开启 `CARDS_UNIFIED_V2_ENABLED`，仅在该 spec 与 `peer-messages.spec.ts` 开启 `ROUNDTABLE_PRIVATE_PAIR_ENABLED`；生产默认仍为关闭。

## A8 用户确认记录

- 原型状态：`docs/cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a8.png`、`shot-a8-390.png`（只读 playbook 详情）。
- 用户在 2026-10-26 回复“没问题”，确认 A8 playbook 原型；本任务只有这一次用户确认停点。
- 生产实现为只读 `Dialog`，展示 Name、Goal、When to use、Inputs、Steps、How to check、What to return、Approval boundaries、Failure handling 九项；查看不改变保存请求。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 18/18 通过 |
| `pnpm lint` | 0 error（仓库既有 warning/info 保留） |
| `pnpm --filter @rakazo/web test` | 98 files / 752 tests 通过 |
| `pnpm test:unit` | 454 files / 5472 passed / 2 skipped |
| `pnpm --filter @rakazo/web build` | 通过 |
| `pnpm test:ci-select` | 98 tests 通过 |
| `bot-messages-pair.postgres.test.ts` | 27 tests 通过 |
| `pnpm test:postgres` | 46/48 files 通过；`effect-execution-fence` 与 `execution-fenced-events` 共 10 个 lease-expired 失败，与本任务路径无关 |
| `git diff --check` | 通过 |
| Gate-off 回归 | transcript 测试证明 gate off 时保留 legacy app/MCP/skill 卡片并忽略 `interactions` |
| Gate-on 回归 | transcript 测试证明三张 legacy block 被抑制，新卡片位于 execution shell 且不出现双卡 |
| 终态保留 | transcript 测试证明 Run 结算后 message-backed 卡仍在 shell 内，legacy block 不回潮 |

### E2E 本地阻塞（需 CI 复核）

本地 scripted E2E 中所有工具调用路径停在 `running`，未产生工具消息或 intervention：

- 新 `card-ui-interactions.spec.ts` 两项失败于等待卡片/`waiting_input`。
- 未修改的 `mcp-approval-card.spec.ts` 同样失败（找不到 legacy `mcp-approval-card`）。
- 未修改的 `intervention-region.spec.ts` 三项同样停在 `running`。
- 无工具调用的 `choice-card.spec.ts` 通过，说明 harness、数据库与 onboarding 本身可用。
- `peer-messages.spec.ts` 的 pair 路径同样停在工具调用后，Postgres 适配器测试则证明 pair 事务本身通过。

因此本 PR 未伪造“生产截图”。新增 E2E 已通过 `playwright test --list` 与 `@rakazo/web check`，需要在 CI 的 scripted E2E 环境复核并生成截图工件。A8 与 X-GROUP 的视觉基线目前引用已确认原型与组件级截图能力。

## 已知缺口（未假装实现）

1. `payment`、`routine`、`install`、`outbound` 的 Interaction 投影 producer 尚不存在（属于 CARD-01A 投影范围）；renderer 用严格 fixture 覆盖，但生产不会凭空出现这些卡。
2. `group_membership` 的成员变更 RPC 属于 RT-12。生产按钮禁用并显示“Joining from this card is not available yet.”；无权限失败卡已实现但没有服务端权限事实可驱动自动选择。
3. A10 同卡编辑需要 Interaction contract 提供 draft body/revisions；当前仅按 revision + fingerprint 显示只读详情并绑定发送决定，未实现同卡编辑。
4. A12 的“先选已保存项、完成后再出现独立付款审批”在 UI 和测试中分离成立，但 payment producer 缺失，无法端到端产生第二张付款卡。
5. A8 discard 调用 `skills.remove` 后只更新本地终态；消息上的 `skill_draft` block 未被重写，刷新后可能在快照更新前重新显示。保存路径以 skill 事务为准。
6. 生产截图未生成，原因见上节本地 E2E 阻塞。
