# RT-14 Task 状态补充要求实现与证据

## 结论

RT-14 把显式 Task amendment 从 RT-13 的底层 append 操作提升为状态驱动操作。原始 `Task.prompt` 仍然不可变，补充仍写入 append-only Message 和 `task.amended` Event。新增逻辑只决定这条 revision 应该 steering、等待首次消费、创建 follow-up，还是仅记录。

failed 和 cancelled Task 的 amendment 不等于 retry。两者只增加 instruction revision，保持 terminal 状态，也不创建 Run。只有现有 `createManualRetryRun` 服务能创建 retry Run。

## 状态决策表

数据库当前不会在 Run 进入 `leased`、`running` 或 waiting 状态时把 `Task.status` 改为同名状态。因此 active 的合法 Task 投影仍是 `queued`。决策同时检查 Task 投影、绑定 Run 状态和 `consumedRevision`，不能只看 Task。

| Task 投影 | 绑定 Run | revision 状态 | decision | 写行为 |
| --- | --- | --- | --- | --- |
| `queued` | `queued` | `consumedRevision = null` | `queued_update_only` | 只追加 revision，不创建 Run，不写 steering |
| `queued` | `queued` | 已固定 | `active_steering` | revision 保持为新历史，steering 精确绑定该 Run。用于已固定输入的技术或手动 retry |
| `queued` | `leased`、`running`、`waiting_input`、`waiting_takeover` | 任意 | `active_steering` | 若尚未固定，先固定旧 revision，再原子追加 amendment 和 steering |
| `completed` | `completed` | 任意 | `completed_follow_up` | 保留旧 Run 和结果，创建同 Task 的 queued follow-up Run |
| `failed` | `failed` | 任意 | `failed_record_only` | 只记录，返回 `requiresExplicitRetry: true` |
| `cancelled` | `cancelled` | 任意 | `cancelled_record_only` | 只记录，返回 `requiresExplicitRetry: true` |
| 任意 | 缺少 Run | 任意 | `not_found` | 不写入 |
| 未知状态、Task/Run 状态不一致、分叉或不完整 lineage、错误 amendment ref | 任意 | 任意 | `conflict` | 不写入 |

`decideTaskAmendment` 使用可判别联合返回全部结果。Run 状态先经过 `RunStatus` 解析，switch 带 `never` 穷举检查。新增 Run 状态会让 TypeScript 指出遗漏的分支。

## 绑定 Run 和 lineage

一个 Task 可以包含原始 Run、manual retry 和 amendment follow-up。服务锁定该 Task 的全部 Run，并验证它们组成单一、无分叉、无环的 lineage。唯一没有 successor 的 Run 是 amendment 的绑定 Run。发现两个 head、跨 Task predecessor、一个 predecessor 的两个 child，或同时带 retry/follow-up predecessor 的 Run 时直接 conflict。

新增 `Run.followUpOfRunId`，与 `retryOfRunId` 分开。它有唯一约束，因此一个 completed Run 只产生一个 amendment follow-up。follow-up 的 operation identity 是 `task-amendment:<messageId>`，同时受 Space 内 Run `clientNonce` 唯一约束和 `followUpOfRunId` 唯一约束保护。事务重试或相同 nonce 重放不会创建第二个 Run。

execution summary 新增 `followUpOfRunId` 和 `followUpSuccessorRunId`。产品可以区分原结果、manual retry 和“追加复核”，无需把普通 `follow_up` trigger 猜成 amendment。

## 事务边界和锁顺序

显式 amendment 的事务顺序如下：

1. 用 `spaceId + threadId + taskId + owner` 做不可枚举的候选检查。
2. 锁 Thread。
3. 按 `createdAt, id` 锁 Task 的全部 Run。
4. 锁 Task。
5. 完整读取当前 instruction envelope。Thread clear 或 Event/Message 缺失在任何写入前失败。
6. 解析或创建 nonce Message，并检查既有 `task.amended` Event。
7. 在同一事务中提交 Task revision、Message/Event 和状态动作。

active 路径在追加前处理 `consumedRevision`。若 Run 已 active 但尚未固定 revision，事务先把旧 revision 写入 Run，然后追加新 revision 和指定 Run 的 SteeringMessage。结果只能是“旧 revision + steering”，不会出现新 revision 已记录但两种输入方式都没消费的半状态。

queued 路径持有 Run 锁直到 revision 提交。lease 赢得 Run 锁时会先固定旧 revision；amendment 赢得 Run 锁时，lease 后续读取新 envelope。两者不会混合 revision。

completed 路径把 revision、`task.amended` application、follow-up Run、`Task.status = queued` 和 Message 到 follow-up 的关联放在一个事务。旧 completed Run 和旧结果 Message 不更新。

failed/cancelled 路径不更新 terminal 状态，也不创建 Run。后续显式 retry 仍调用 `createManualRetryRun`。该服务在 Thread 锁内读取完整 envelope，并把当时 revision 写入新 Run 的 `consumedRevision`，所以用户选择后的新 amendment 不会静默改变 retry 输入。

## 幂等与并发证据

- Message 的 `(threadId, clientNonce)` 唯一约束确定 amendment identity。
- `task.amended.causationId = messageId` 用于重放查找。新 Event 持久化 application 和目标 Run/follow-up Run。
- replay 返回第一次提交的 revision 和 application，不根据后来 Task 状态重新决策。
- SteeringMessage 的 `(messageId, botId)` 唯一约束防止重复 steering。
- follow-up 同时受 Run clientNonce 和 predecessor 唯一约束保护。
- `withTransactionRetry` 包裹整个状态应用事务。数据库重试重新读取持久化 Event，并走 replay 结果。
- 同一 Run 的 automatic technical retry 不创建新 Run，也不清除 `consumedRevision`。现有固定 revision 行为保持不变。

## 读取接口

`threads.taskInstructions` 返回：

- immutable original；
- 按服务端 seq 排序的 amendments；
- 当前完整 instruction envelope 和 revision；
- 同一 Task 的 Run 列表；
- 每个 Run 的 `original`、`manual_retry` 或 `amendment_follow_up` lineage；
- terminal Run 的真实结果 Message。

接口不返回 lease owner、lease expiry、fence、Attempt 或 checkpoint。instruction log 不完整或 lineage 不可证明时 fail closed。

## 范围控制

本实现没有增加 `TaskAmendment` 表，没有把 Attempt 当输入，没有实现 RT-17 impact 分类、后台 helper revision、RT-20/RT-23 工作页，也没有改变 AgentScope 的生产执行器地位。

## 验证证据

可重跑入口是 `scripts/verify-rt14.sh`。它要求调用方显式提供一次性测试 PostgreSQL 的 `VERIFY_DATABASE=1` 和 `DATABASE_URL`。

| 检查 | 结果 |
| --- | --- |
| Task 状态决策、executor、router、execution projection 定向测试 | 4 files，204 tests passed |
| task-instructions、manual-retry、intervention、origin-intervention PostgreSQL | 4 files，77 tests passed |
| `pnpm --filter @rakazo/db check` | passed |
| `pnpm --filter @rakazo/adapters check` | passed |
| `pnpm --filter @rakazo/api check` | passed |
| `pnpm check` | 18 tasks passed |
| `git diff --check` | passed |

PostgreSQL 用例直接覆盖指定 Run steering、同 Bot 另一 Run 隔离、queued 不创建竞争 Run、lease/amendment 两种合法串行结果、completed nonce 双提交单一 follow-up、failed/cancelled record-only、显式 retry revision 固定、Thread clear fail closed，以及同一 Run revision 固定。
