# Attention 队列查询边界复审（CARD-01D / PR #147）

日期：2026-10-28。触发：复审要求在删除每源 500 行上限后，重新评估“只读 pending”的无上限扫描是否可接受，并在合入前给出可证明的查询边界方案。

结论先行：**`4a69d67` 不能按现状合入**。删除上限修正了 `total` 少算，但把“单请求成本”交给了数据规模与 20s 事务超时；超时是失败保护，不是查询边界。

## 1. 四类来源的真实成本

| 来源 | 谓词 | 可用索引 | 单次读取成本 |
| --- | --- | --- | --- |
| pending Intervention | `threadId in (用户线程)` + `status='pending'` | `interventions(threadId, status)` | O(pending 行数)，量级为“仍需处理的请求” |
| SessionControl（派生） | `threadId in (...)` + `status in ACTIVE_RUN_STATUSES` | `runs(threadId, status, createdAt)` | O(该用户线程上的活跃 Run) |
| 委托接管（派生） | `spaceId` + `status in ACTIVE` + `originThreadId/originRunId/originMessageId` 非空 + `trigger != message_group` | 无完全匹配的复合索引（`runs(spaceId, botId)`、`runs(status, …)` 可用） | O(空间内的活跃 Run)，依赖 active 集合小 |
| 消息内业务审批 | `threadId in (...)` + `role='bot'` + `blocks @> …`（4 组 JSONB containment） | `messages(threadId, seq)` 只能限定线程；**`blocks` 没有任何 GIN 索引** | **O(该用户所有线程的 bot 消息数)**——每 15s 轮询重复一次 |

## 2. 最坏规模

- 内存：只有命中的行被物化（pending 项与命中消息），不是全表；**堆内存不是主要风险**。
- 数据库与延迟：消息审批源对每个线程按 `threadId` 走索引后逐行做 JSONB containment 判断。举例：40 个线程 × 5 万条 bot 消息 = 200 万行/次请求；按 15s 轮询，这是持续的顺序扫描负载，单个用户即可把 API 的读能力压低。20s 事务超时只会让请求**失败**（前端显示“Couldn't load pending requests.”），不会缩小成本。
- 因此“只读 pending”这个说法不成立：谓词是 pending，但**扫描面不是**。

## 3. 可选方案

### A. 按来源做数据库级游标分页 + 合并（推荐）

- 对 `blocks` 增加 GIN 索引（`jsonb_path_ops`；Prisma 支持 `@@index([blocks(ops: JsonbPathOps)], type: Gin)`），让 containment 变成索引检索；
- 每个来源用 keyset 游标（`(expiresAt NULLS LAST, attentionAt, stableId)` 对应到各源的列）只取 `limit+1` 行，k 路合并得到一页；
- `total` 由各源 `COUNT` 得出（GIN 支撑；消息审批的块计数用 `jsonb_array_elements` 精确统计 pending 块）；
- 单请求成本变为 **O(page size + COUNT)**，与历史消息总量无关；新增验收：`EXPLAIN` 断言消息谓词走索引、历史消息量放大后延迟不增长、>500 行与多页无重复。
- 代价：查询重写（4 个来源的游标与合并）、一次迁移（索引）、契约里明确 `total` 精确含义。

### B. 持久化可计数的 attention 投影

- 新建 `attention_items` 表，由写侧（intervention 创建/结算、Run 状态变化、审批块写入）维护，读取只做 keyset 分页与 `COUNT`；
- 单请求成本 O(page)，`total` 天然精确；但需要迁移、写侧改动、回填与漂移对账任务，风险与工作量最大。

### C. 写入侧 pending 数量硬上限

- 对每个用户/线程的 pending Intervention/Run 设硬上限，超过则拒绝或自动过期最旧项；
- 只能约束前两个来源；**消息审批源仍然是 O(历史消息) 扫描**，除非同时做 A 的索引与分页。单独实施不满足边界要求。

## 4. 建议

选 **A**：它对应“按来源做数据库级游标分页和合并”，同时用 GIN 索引把当前最大的成本项（消息 containment 扫描）降到索引检索；`total` 保持精确。B 可作为后续把读取进一步收敛到 O(page) 的演进，不必在本卡承担迁移与写侧风险；C 只适合作为产品侧的容量策略，不能替代 A。

在 A 落地前，`#147` 保持 `in-progress`；不会用修改任务措辞的方式取消失效的有界性要求。

## 5. 本轮已落地与残余（2026-10-28）

已落地：删除每源 500 行上限（`total` 精确）+ `messages.blocks` GIN 索引（`jsonb_path_ops`，迁移 `20261028150000_messages_blocks_gin`）。消息审批源不再顺序扫描历史消息：`attention.postgres.test.ts` 在 5,001 条历史消息下用 `EXPLAIN (ANALYZE, BUFFERS)` 断言走 `messages_blocks_gin` 且扫描行数 < 500；另有 520 行分页用例。

残余（不宣称已解决）：`total` 要求精确，就必须投射全部 pending 候选，单请求成本因此 ∝ pending 候选数（已不随历史消息量增长，但 pending 本身没有写入侧硬上限）。按来源的游标分页只能约束「物化规模」，不能降低精确 `total` 的工作量；要把单请求降到 O(page)，只有方案 B（持久化 projection）能同时满足精确计数与有界读取。本卡保持 `in-progress`，方案 B 是否另立单元由负责人决定。

## 6. CARD-01E 落地（2026-10-28）

CARD-01E 按方案 B 落地持久化读模型，并把查询边界写进测试：

- 新表 `attention_interventions`（迁移 `20261028210000_attention_intervention_projection`）只保存 pending 持久 Intervention 的 frozen 排序元组：`interactionId / spaceId / userId / threadId / botId / kind / attentionAt / expiresAt`。由 `interventions_attention_projection` 行级触发器维护，`userId` 从所属 Run 派生；触发器同时覆盖当前和后续写入路径、`createMany/deleteMany` 以及迁移时的回填，不依赖某一条 TypeScript 结算路径。Intervention 离开 `pending` 的同一事务会删除投影行。
- 读路径 `packages/db/src/attention.ts:loadDurableAttention`：分页是投影表上的 keyset 切片（`expiresAt ASC NULLS LAST → attentionAt ASC → interactionId ASC`），`total` 是对同一过滤条件的精确 `COUNT(*)`；只有当前页的 Interaction 行、effect 状态和 RT-12 membership facts 会被加载。整个读取在同一 `RepeatableRead` 事务快照内完成，避免计数与分页在结算并发下答出不同快照。用户线程可见性、Bot 归档、目标群成员管理权限和 `expiresAt` 都在 SQL 内过滤，过期条目在 timeout job 结算前就不再出现在队列。
- 其余三类来源保持「当前事实」有界读取：可见线程上的活跃 Run（takeover/return）、活跃委托 Run 的 origin 链（深度上限 8）、以及经 `messages_blocks_gin` 命中的 pending 业务审批。它们不读取普通 Run 历史，也不把已完成消息当候选。
- 证据：`packages/db/src/attention.postgres.test.ts` 的 520 行分页/精确 total、分页锚点结算后继续、过期即时移除、归档 Bot（含群内 post bot）、失去群管理权限、5,001 条历史消息下 `EXPLAIN (ANALYZE, BUFFERS)` 走 `messages_blocks_gin` 且扫描 <500 行，以及 520 行 pending 投影的第一页 `EXPLAIN` 走 `attention_interventions_user_order` 且扫描 <100 行。整套 15/15。

本方案仍有明确残余，不写成 O(1)：

- `total` 的 `COUNT(*)` 是窄表索引扫描，成本 ∝ 当前 pending 投影行数（仍是用户待处理队列本身），不是与队列规模无关的常数；要 O(1) 需要写侧维持计数器，本卡不承担。
- 消息内业务审批的候选仍来自 GIN 命中集合；命中量 ∝ pending 审批块数（不是历史消息数）。它们没有持久化投影。
- 投影触发器要求所属 Run 行存在（缺失会抛错，而不是静默漏行）；这是数据完整性前提，不是兼容分支。
- 投影内容合法性由生产写入保证；若历史行违反 strict 契约，读取会跳过该行，`total` 可能比可见条目多 1。此时应修数据，不应放宽契约。
