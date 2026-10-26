# CARD-01B delivery record

状态：`in-review`（未合并）

- 分支：`codex/card-ui-interactions`
- Worktree：仓库外的独立 `card-ui-interactions` worktree（按分支名定位，不记录本机路径）
- Base：`43fb44517339e2822350feec6903e40dd37b703a`（`origin/main`）
- Implementation head：`fa4ea75`（A10 并发回滚与收件人校验修复；PR head 以分支顶端为准）

## 交付内容

### CARD-01B Interaction 渲染

- 新增统一 `InteractionCardShell` 和 `InteractionRegion`，渲染 `input_request`、`action_approval`、`plan_review`、`session_control` 四种严格视图。
- `InterventionRegion` 在 `cardsUnifiedV2` 开启时委托给新 region；gate 关闭时保留原 `InterventionRegion` 路径。
- 排序统一走 `compareInteractionViewsForDisplay`：pending 先于 terminal；pending 内 PlanReview → ActionApproval → InputRequest；SessionControl 使用独立 region。
- `coveredAsks` 在 gate 开启时按 `InteractionView.source.messageId` 去重，并抑制同一消息上的 `app_connect`、`mcp_approval`、`skill_draft` 旧 block；`MessageView` 现在接收父级过滤后的 blocks，避免旧卡片从气泡再次渲染。
- Execution headline 使用 server pending 视图的 `presentation.text`；无 Run 的 interaction 渲染在 transcript tail（pending 以及仍有卡片的终态）。
- 终态不使用整卡 opacity；使用 inset outline + 文字/符号状态。每张卡最多两个按钮加一个文字入口。
- A8 丢弃是持久终态：`skill_draft.status` 新增 `discarded`；`skills.remove` 在同一事务内把消息 block 标记为 `discarded`、追加 `thread.message.updated` 事件并删除技能记录。投影把 `discarded` 映射为 `cancelled`，刷新后仍显示“Discarded”且没有保存/丢弃按钮。
- `group_membership` 不套 Card Shell，继续使用 X-GROUP 内联卡；`GroupMembershipFailureCard` 独立失败态。无成员变更 RPC 时按钮禁用并明确说明尚不可用。
- `session_control` 接管/交还独立显示；关闭面板不等于交还，交还必须点击明确动作。
- App authorization 卡优先使用 interaction 的 `source.botId`；onboarding 历史消息未记录 botId 时回退到当前对话 Bot，授权与 `appConnected` 使用同一 Bot。
- Execution detail 的 interactions 按 `interactionId` 与 revision 合并进线程 projection；消息已翻出当前页时，展开 Run 仍能显示其中的卡片。
- A10 外发草稿：`send_email` ExternalEffect 投影为 outbound 卡；同一张卡/详情内编辑，保存写入不可变 `outbound_draft_revisions`（首次编辑前固化 r1 快照），pending 只显示最新 revision，旧 revision 显示 superseded。发送决定携带 revision + fingerprint；编辑后必须匹配最新，executor 复用已批准 effect key 重放编辑后的内容。
- A10 编辑事务与审批使用同一锁序（Thread → Run → Intervention），并在 effect 条件更新失败、revision 唯一键冲突或卡片已结算时抛出哨兵回滚全部 revision 写入；不会把冲突编辑投影成最新 pending。
- A10 收件人保存前按真实发送端 `validateOutgoingMail()` 的规则校验：邮件格式、长度、1–20 个、去重；正文同时按 UTF-8 字节上限 65,536 校验。编辑器直接提示，服务端 RPC/DB 同样拒绝，不会保存必然发送失败的 revision。
- A10 编辑支持委托 Bot 在展示 Thread 中等待的场景：从绑定 Run 派生执行 Thread，按执行 Thread → 展示 Thread 加锁，保留展示 Thread 匹配与 Run owner 校验，不再要求 Run 与展示 Thread 相同。
- A10 的 legacy（gate 关闭）审批路径同样在存在 `outbound.draftState` 时提交 revision + fingerprint binding；关闭 `CARDS_UNIFIED_V2_ENABLED` 后，已编辑草稿仍可由旧卡完成审批，不会 stranded。
- A10 编辑器在打开时固定 base revision 与初始内容；其他 tab 推进服务器 revision 时，保存仍以打开时的 revision 做乐观检查，不会用新 revision 提交旧内容。冲突后需关闭/重开编辑器再基于最新 revision 编辑。
- 统一 question 输入卡沿用 legacy `AskCard` 的草稿生命周期：按 `interactionId` 存取非密文回答，提交或终态后清除；secret 输入从不写入浏览器存储。
- MCP assignment 卡在服务端把已批准视图重新打开为 pending（撤销授权）时清除本地 `Allowed` 覆盖，按钮恢复可用；乐观提交期间不误清。
- 统一输入卡保留非 secret 请求的 `presentation.detail` 说明，位置在回答控件之前，与 legacy `AskCard` 一致；secret 请求继续不渲染说明。

### RT-09 private pair

- pair 发货时源 Thread 写入 `collaboration_receipt`，包含 `target: { kind: "bot", botId }` 与 `destination: { kind: "pair_message", pairThreadId, messageId }`；pair Thread 保留完整正文。
- `isPeerReceiptBlocks`、消息分页准入与 peer 事件转发识别 bot-target `collaboration_receipt`。
- 新 `PeerReceiptRow` 单行为轻回执，多目标为展开名单；legacy 无 locator 回执显示为不可打开记录，不回退到通用 Thread 拉取。legacy 非空 `bot_message_sent` 仍按轻回执显示且不展示正文；群 Thread 的非空 send 仍由 `PublicDelegationMessage` 处理，因为群 Thread 不进入 receipt helper。
- `PeerMessagesOverlay` 方向以当前展示 Bot 为准：`bot_message_sent.toBotId` 等于当前 Bot 时是收到的回传，`bot_message_received.fromBotId` 等于当前 Bot 时是自己的发出；收到的回传显示在左侧、自己的消息显示在右侧，名称和头像跟随方向。`returnToMessageId` 仍用于去除同一投递的 wake 副本。
- `PeerMessagesOverlay` 只调用 `threads.pairMessages`，必须携带 `sourceReceiptMessageId`、pair locator 和分页 cursor；只读无输入框。
- `readPairMessages` 初始页从最新授权消息开始，避免回执之后的回复被 target boundary 隐藏；grant 仍校验 target 与 provenance。
- 删除 `peer-history.ts` / `peer-messages.ts` 及对应测试，避免两套读取路径。
- 推出说明：只有 `ROUNDTABLE_PRIVATE_PAIR_ENABLED=true` 时才会写入带 locator 的 bot-target 回执并可打开 pair 浮窗；历史上的无 locator 回执按设计显示为不可打开的记录，不做通用 Thread 回退。

### 终态交互卡

- strict `InteractionView`（任意状态）本身即为 Execution surface 信号：gate 开启时旧的 `app_connect`/`mcp_approval`/`skill_draft` block 被抑制，若 Run 结算后丢失 surface，终态卡会连同历史一起消失。`execution-surface.ts` 因此保留有 strict interaction 的 Run，终态卡在 region 内按统一排序继续显示。

### CI 选择

- 生产路径 `apps/web/src/components/ai/interactions/**`、`PeerReceiptRow`、`peer-receipts`、`peer-transcript`、`PeerMessagesOverlay`、`InterventionRegion`、`Shell`、`use-execution-transcript` 会选中 `card-ui-interactions.spec.ts` 与 `peer-messages.spec.ts`。
- E2E harness 仅在 `card-ui-interactions.spec.ts` 开启 `CARDS_UNIFIED_V2_ENABLED`，仅在该 spec 与 `peer-messages.spec.ts` 开启 `ROUNDTABLE_PRIVATE_PAIR_ENABLED`；生产默认仍为关闭。
- 不带 `--spec` 的全量 E2E 拆成两个互斥批次：gate-off（其余 spec，保留 message-group gate）与 gate-on（`card-ui-interactions.spec.ts` + `peer-messages.spec.ts`）。选择逻辑按完整文件名匹配，负向正则不会误开门禁；拆批规则有单元测试。

## A8 用户确认记录

- 原型状态：`docs/cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a8.png`、`shot-a8-390.png`（只读 playbook 详情）。
- 用户在 2026-10-26 回复“没问题”，确认 A8 playbook 原型；本任务只有这一次用户确认停点。
- 生产实现为只读 `Dialog`，展示 Name、Goal、When to use、Inputs、Steps、How to check、What to return、Approval boundaries、Failure handling 九项；查看不改变保存请求。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 18/18 通过 |
| `pnpm lint` | 0 error（仓库既有 warning/info 保留） |
| `pnpm --filter @rakazo/web test` | 98 files / 773 tests 通过 |
| `pnpm test:unit` | 457 files / 5508 passed / 2 skipped |
| `pnpm --filter @rakazo/web build` | 通过 |
| `pnpm test:ci-select` | 99 tests 通过 |
| `bot-messages-pair.postgres.test.ts` | 27 tests 通过 |
| `pnpm test:postgres` | 49/49 files、433 tests 通过（迁移后的独立 `workpal_e2e_*` 库） |
| Scripted E2E | `card-ui-interactions.spec.ts|peer-messages.spec.ts` 5/5 通过（含 A10 同卡编辑） |
| 视觉证据 | 20 张实际页面截图保存在 `docs/cards/evidence/card-ui-interactions/`，对照记录见 `CARD-01B-visual-evidence.md` |
| `git diff --check` | 通过 |
| Gate-off 回归 | transcript 测试证明 gate off 时保留 legacy app/MCP/skill 卡片并忽略 `interactions` |
| Gate-on 回归 | transcript 测试证明三张 legacy block 被抑制，新卡片位于 execution shell 且不出现双卡 |
| 终态保留 | transcript 测试证明 Run 结算后 message-backed 卡仍在 shell 内，legacy block 不回潮；无 Run 的丢弃卡在 tail 保留 |
| pair 方向 | A→B 请求为 sent、B→A 回传为 received、legacy-only wake 为 sent；overlay 同步验证作者、头像与左右位置 |
| A8 丢弃持久化 | 服务测试验证 block→`discarded`、`thread.message.updated` 事件与删除同事务；重复丢弃/错误用户/Space 无副作用；投影为 cancelled，Web 从服务端视图恢复“Discarded”且无按钮 |
| App authorization 归属 | onboarding post 带上 `botId`；Web 对历史无 botId 卡片回退当前对话 Bot，授权与 `appConnected` 使用同一 Bot |
| Execution detail 合并 | 消息翻出当前页后，展开 Run 仍从 detail interactions 恢复卡片；线程 projection 在相同 revision 优先 |
| Input 草稿 | 非密文 question 回答按 `interactionId` 恢复，提交/终态清除；secret 不写入 sessionStorage |
| A10 编辑 | 保存生成新 revision，r1 快照保留且 superseded，pending 只显示最新；effect request 与消息 block 同步 |
| A10 绑定 | 编辑后 approve 不带 binding 或使用旧 fingerprint 返回 conflict；最新 revision 通过；deny 不要求 binding |
| A10 冲突回滚 | 测试触发器在 revision 写入后把 effect 置为 approved；编辑返回 conflict 且 r1/r2、effect request、message 事件全部回滚。把哨兵回滚改为正常 return 时该测试失败（变异验证） |
| A10 收件人校验 | contract/RPC 拒绝 `abc` 与重复地址；DB 在写入前拒绝且不留 revision；Web 编辑器显示格式/去重错误且不调用 RPC |
| A10 正文字节上限 | 22,000 个中文字符（66,000 UTF-8 bytes）在 contract/DB 被拒绝；Web 编辑器显示 64 KB 错误且不调用 RPC |
| A10 跨 Thread 编辑 | 通过 `pauseRunForInput` 的 presentation Thread + origin 构造真实跨 Thread approval；编辑成功并写入 r1/r2。把执行 Run 查询改回要求展示 Thread 时该测试失败（变异验证） |
| A10 legacy 审批绑定 | gate 关闭的 `InterventionRegion` 在存在 outbound draftState 时，点击 Allow once 会提交 r2 + fingerprint；单元测试断言 RPC 入参 |
| A10 编辑器 base revision | 打开 r2 编辑器后服务器推进到 r3，保存仍发送 `expectedRevision: 2` 与打开时的内容；把基准改回 `draft.revision` 时该测试失败（变异验证） |
| 全量 E2E 拆批 | 单元测试证明 gate-off 正则排除 card/peer、gate-on 批次包含两者；两个批次分别跑 legacy MCP 与 unified MCP 用例均通过 |
| A10 E2E | 真实页面打开 r1，编辑并保存 r2，断言 r1 Superseded / r2 Pending，确认页含 revision + fingerprint，关闭后仍 pending；桌面/390/375 截图 |
| 截图对照 | 新卡片、A10、pair 的实际页面截图已保留，见 `CARD-01B-visual-evidence.md` |
| MCP 撤销重开 | 服务端 answered→pending 时本地决定清空、授权按钮恢复；同卡重复授权可再次调用 RPC |
| Input 说明 | question/choice/form 渲染服务端 detail；secret 请求不渲染 |

本地全量 `pnpm test:postgres` 在复用的一次性库上先后命中 `memory-facts` / `wakeup` 的 Graphile 任务计数残留；重建并重新 migrate 该 disposable 库后 49/49、433 tests 通过。失败来自本地库残留状态，不是代码路径回归，也不把残留状态当作基线。

全量 E2E 的门禁批次已拆开并分别验证通过；未过滤的整仓 E2E 仍会被既有 `browser-auth.spec.ts` 阻断——该文件 import 已移除的 `apps/desktop/src/browser-auth`，属于本任务之外的既有基线问题。

### E2E 与截图证据

在一次性 `workpal_e2e_*` PostgreSQL 库上运行 `card-ui-interactions.spec.ts|peer-messages.spec.ts`，5 个用例全部通过；A10 用例通过 `/__e2e/outbound-draft` 调用生产 `pauseRunForInput` 写入真实 `send_email` ExternalEffect + approval Intervention，再从正常页面完成编辑、保存 r2、查看 r1 Superseded / r2 Pending，并打开绑定 revision + fingerprint 的确认页。

实际页面截图已保留并逐项对照已确认原型：[CARD-01B visual evidence](./CARD-01B-visual-evidence.md)（文件在 `docs/cards/evidence/card-ui-interactions/`）。截图来自真实页面和真实服务端投影，不是组件拼图；390/375 截图同时断言无横向溢出。

之前本地 scripted E2E 停在 `running` 的原因是复用了旧的一次性数据库状态；换新库后同一代码路径全部通过，未修改其他 spec。

## 已知缺口（未假装实现）

1. `payment`、`routine`、`install` 的 Interaction 投影 producer 尚不存在（属于 CARD-01A 投影范围）；renderer 用严格 fixture 覆盖，但生产不会凭空出现这些卡。`outbound` 已接通真实 `send_email` 审批路径。
2. `group_membership` 的成员变更 RPC 属于 RT-12。生产按钮禁用并显示“Joining from this card is not available yet.”；无权限失败卡已实现但没有服务端权限事实可驱动自动选择。
3. A12 的“先选已保存项、完成后再出现独立付款审批”在 UI 和测试中分离成立，但 payment producer 缺失，无法端到端产生第二张付款卡。
4. 截图来自 scripted E2E harness 中的真实页面与服务端投影，不是对外部署环境的截图；A10 审批 fixture 通过生产 pause 路径写入，未经过真实模型工具调用。
