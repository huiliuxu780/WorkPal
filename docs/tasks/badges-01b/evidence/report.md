# BADGES-01b 证据报告

分支：`codex/badges-01b`
基线：`origin/main` @ `d0f4556`（BADGES-01 合入后）

## 解决的问题

BADGES-01 的会话角标与成员「等你批准」都读 `attentionItems`，而它是 Attention 队列的**第 1 页**：`attention.list` 上限 50，每 15s 轮询用第 1 页替换整个列表。于是待处理条目排在第 1 页之外的会话没有角标，手动翻页也只能维持到下一次轮询。

## 改了什么

1. **合约**（`packages/contracts/src/card-interaction.ts`）：`AttentionQueuePageSchema` 增加 `conversationHeads`，每会话一条，字段只含跳转身份与排序键：
   `conversationKind` / `conversationId` / `interactionId` / `messageId` / `botId` / `kind` / `attentionAt` / `expiresAt`。
   不含 `presentation` / `botName` / `conversationName` / `taskTitle`——角标只需要「有没有」和「跳哪」。
2. **数据层**（`packages/db/src/attention.ts`）：新增 `loadAttentionConversationHeads`。
   - durable 源：`SELECT DISTINCT ON (thread."botId", thread."groupId")` 复用**同一个** `durableFilters`（archived / 过期 / renderable / 可管理成员与列表完全一致），按冻结排序 `expiresAt ASC NULLS LAST → attentionAt → interactionId` 取每会话首条。
   - live 源：当前 SessionControl 本就在内存里全量计算，按会话归并。
   - 与分页查询在**同一事务、同一快照**内返回，因此不存在「total 与列表来自两个快照」的问题；聚合结果规模只与会话数相关，不随 pending 行数增长。
3. **前端**：`AttentionQueue` 每页回传 `conversationHeads`；Shell 用 heads 建 `pendingByConversation`（会话角标）与 `waitingMembers`（成员「等你批准」）；新增轻量 `openAttentionJump`，`openAttentionItem` 委托给它，行为不变。

## 检查结果

| 检查 | 结果 |
|---|---|
| `pnpm --filter @rakazo/contracts check` | 0 |
| `pnpm --filter @rakazo/db check` | 0 |
| `pnpm --filter @rakazo/web check` | 0 |
| `pnpm --filter @rakazo/web test` | 101 files / 810 tests passed（`checks/unit.log`） |
| `attention.postgres.test.ts`（真实 PostgreSQL） | 19 passed（含新增用例，`checks/postgres.log`） |
| `card-attention.spec.ts`（gate 开） | 3 passed（含会话行角标跳回） |

新增用例：

- postgres：`reports one conversation head per conversation regardless of the page`——造两个会话、`limit: 1` 取页，断言第 1 页装不下所有会话时 `conversationHeads` 仍与全量查询一致，且 head 携带正确的 `interactionId` / `messageId`。
- web 单测：`reports per-conversation heads independently of the page`——页面 `items` 为空时仍回传 heads。

## 边界

- heads **每会话一条**，代表该会话当前最早的一条 pending；跳转落到这张卡。
- 角标与成员标签都来自同一份 heads，因此两者覆盖范围一致。
- 未读计数（`Thread.unread` boolean → 计数）仍不在范围，另卡。
