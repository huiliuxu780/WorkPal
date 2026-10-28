# FIX-STOP-01 Stop 后释放会话执行权

状态：`in-progress`（2026-10-28 在 `codex/verify-lifecycle-concurrency` 上完成修复与定向绿；完整 CI 与进程链证据见下）

- 类型：bug
- 高风险：是（涉及 cancel、session admission 和 `recovering` 证明）
- 原型：不涉及 UI 改动，不需要原型
- 回归测试：`packages/db/src/stop-session-release.postgres.test.ts`（VERIFY-01 S1–S4，已落地）
  - "S1: cancelling an in-flight generation lets the next message run"
  - "S1b: cancelling before the runtime started must not wait out the admission TTL"
  - "S2: appended steering is explicitly discarded and the conversation keeps working"
  - "S3: Stop that lands on an already terminal Run changes nothing and leaves the session usable"（修复前就是绿的，作为不误伤的护栏）
  - "S4: a worker restart or expired lease must still free a session whose owner was cancelled"
- 关联：RT-25 session admission lease、RT-26 `recovering` 证明、[CANCEL-01](./CANCEL-01.md) / PR [#139](https://github.com/huiliuxu780/WorkPal/pull/139)
- 分支：与 VERIFY-01 同一模块分支，验证与修复分开 commit

## 事实（2026-10-27 QA，真模型）

- 产品经理 bot 写 800 字文章，6 秒后点 Stop，Run 变成 `cancelled`。
- 再发「1+1 等于几」，一直停在 Queued，超过 5 分钟也没有恢复。
- 截图：`real/10-before-stop.png`、`real/11-after-stop.png`、`real/12-after-stop-new.png`。

这是已观察到的生产现象，不是模型推演。但归因仍需在修复前用 S1–S4 的红灯确认：同一「停在 Queued」的表象也可能来自工具桥接 401（P0-2），判别规则见 VERIFY-01 覆盖范围最后一项。

## 复现步骤

1. `pnpm dev:app`，配置 DashScope 真模型。
2. 新建私聊，让 bot 写一篇长文章。
3. 生成过程中点 Stop，确认 Run 变成 `cancelled`。
4. 同一会话发一条短问题。
5. 观察：新 Run 一直是 `queued`。查 admission 表，看是否还被已经 `cancelled` 的 Run 占着。

## 影响

用户只要点过一次 Stop，这个会话就永久不能用了，只能新开会话。Stop 是最常用的操作之一，所以定 P0。

## 修复边界

- 只改 cancel 路径和终态释放路径，不动 RT-25 的 lease 模型和 RT-26 对 `suspended` 状态的证明语义。
- owner 已是终态 `cancelled` 本身就是可以释放的证明。不能用「超时了」当证明，这和 RT-26 的「elapsed time is never a proof」原则一致。
- 不靠缩短 lease、加重试或加 sleep 来掩盖问题。

## 已确认根因（2026-10-28，`a409140` 上复现）

一次 Stop 之后没有任何路径能释放会话：

1. 取消路径完全不碰 admission：`apps/api/src/thread-target.ts:2050 stopThreadRuns` → `packages/db/src/cancel-terminal.ts:274 applyCancelTerminalPolicy` → `packages/db/src/cancel-runs.ts:31 cancelRunsInTransaction`，三者都没有 admission 引用。
2. executor 的 finally 把 cancelled 当作"结局未确认"：`packages/adapters/src/executor.ts:6130` 在 runtime 启动后置 `sessionMayRelease=false`，`:7736-7757` 只把 `waiting_input`/`waiting_takeover` 当作 parked-on-card，于是对 cancelled 调 `markSessionAdmissionRecovering(..., "agentscope_runtime_outcome_unconfirmed")`。
3. `acquireSessionAdmission` 对 `recovering` 无条件让路（`packages/db/src/session-admission.ts:297`），不看 owner Run 是否已终态。
4. 时间兜底扫不到：`recoverExpiredSessionAdmissions`（`:552`）只选 `state='owned'`；`listAvailableSessionAdmissionHeads`（`:849`）只认 `state='available'`。
5. 唯一出口 `releaseRecoveredSessionAdmission`（`:759`）需要 runtime checkpoint 证明，而 Stop 已经中止了那个 runtime 会话，证明函数在 `executor.ts:1407-1413` 记 `recovering session admission could not be proven` 并返回 false。

## 已实施修复（收窄方案 B：仅 Stop/取消路径）

- `packages/db/src/session-admission.ts`：新增内部 `releaseCancelledOwnerAdmission(tx, row, now)`。放行必须**同时**满足两条，缺一不可：
  1. owner Run 是 `cancelled`（不是"任意终态"）；
  2. 该 Run 的 `run_abort` execution revocation 已经不存在。
  满足时把 admission 置回 `available`，`lastReleaseReason='cancelled_owner_abort_confirmed'`，并释放其 request 行。查询顺序是**先读 owner 终态、再读 revocation**，且都在调用方的事务内：READ COMMITTED 下两次读之间被删掉的行，是因为 abort 已返回才被删的；反过来先读 revocation 会把"还没写入"误判成"已经 abort 完"。
- `acquireSessionAdmission` 在锁行之后、判定 `recovering`/`owned` 之前调用它，因此下一条消息在**同一个事务**内就能取得执行权。
- 新增导出 `releaseSettledCancelledSessionAdmissions(prisma, now, limit)`：`FOR UPDATE OF admission SKIP LOCKED`，候选查询带 `run.status = 'cancelled'` 与 `NOT EXISTS (run_abort revocation)` 两个条件，未确认 abort 的行不会被选中。
- `apps/worker/src/session-admission-reconciler.ts`：在过期 sweep 之前先跑这条释放，把释放出的后继与可用 FIFO head 去重后各入队一次，返回值新增 `released`。

**`failed` / `completed` owner 明确不在本规则内**：这两条路径根本不写 `run_abort` 行，所以"没有 revocation"对它们恒真；按它放行会在会话状态尚未落定时就移交，正是 `worker-chain.spec.ts:546`/`:785` 禁止的。新增 PG 用例 "a failed owner stays parked" 把这条边界钉成断言，而不是只靠代码形状。

没有做的事，以及为什么不算削弱护栏：

- **没有**把 `recoverExpiredSessionAdmissions` 扩大到 `recovering`。仅凭过期仍然不移交：`session-admission.postgres.test.ts` 的 "moves every crash point to recovering after expiry and never hands off" 仍然绿。
- **没有**改 RT-26 的证明语义：`session-checkpoint.postgres.test.ts` 的两条 proving 用例仍然绿。
- **没有**用时间阈值：S4 显式把时钟推到 `expiresAt + 5min` 并跑 reconciler，abort 未确认时断言仍然 `recovering`。
- **没有**缩短 lease、加重试或加 sleep；S1–S4 的时钟全部显式传入。
- **没有**改 cancel 的业务语义（steering disposition、notice、continuation 都不动）；`cancel-terminal` 12 项、`effect-execution-fence` 18 项仍然绿。

## 失败场景（`:546`/`:785`）的三个未决问题：另记为后续调查

按负责人裁决，本交付单元只处理 Stop/取消路径，失败场景保持现状。以下三点不塞进本单元，作为独立调查：

1. 失败 Run 的 Attempt 由谁、在哪一步之后写终态；
2. worker 中途被杀时该 Attempt 停在什么状态（必须停在 `running` 才符合"未落定"）；
3. `:546`/`:785` 两个用例里失败 Run 的 Attempt 实际处于什么状态。

## 阻塞：与三个已交付的进程级契约直接冲突（待负责人裁决）

`pnpm test:worker-chain` 在 fix SHA `6ce9376` 上 **3 failed / 2 passed**，证据见 [chain-conflict.txt](../evidence/FIX-STOP-01/chain-conflict.txt)。三个失败用例不是过时断言，而是**故意**要求相反行为：

| 用例 | 位置 | 它断言什么 |
| --- | --- | --- |
| `a retry after an in-flight cancellation stays queued behind recovering admission` | `apps/web/e2e/worker-chain.spec.ts:402` | 取消后（`source.status === "cancelled"`）admission 必须变成 `recovering`；等 12 秒后手动重试 Run 仍是 `queued`、`leaseOwner` 为 null、**模型夹具没有被调用**（`task.requests.length` 不变）、转录里没有回复；`agentSessionAdmissionRequest` 仍是 `queued` |
| `a Routine failure queues one delivery behind recovering chat admission` | `:546` | Routine 失败后 admission 必须停在 `{ state: "recovering", ownerRunId: runId }`，投递排在其后 |
| `an outbox restart creates one queued delivery behind recovering admission` | `:785` | outbox 重启后同样必须停在 `recovering` |

失败形式：修复后 admission 被释放为 `available`，后继 acquire 覆盖了 `ownerRunId`，于是 `agentSessionAdmission.findFirstOrThrow({ where: { ownerRunId: original.id } })` 找不到记录并抛 `PrismaClientKnownRequestError`。

两个通过的用例正是必须保住的护栏：`a Worker killed mid-Run parks chat admission in recovering without retrying`（owner 非终态，仍 park）与 `a user Run stays queued while the Worker is down...`。

**冲突的本质**：`:402` 断言的行为，就是 2026-10-27 QA 报的 P0-3 现象本身（取消后新消息永远 Queued）。executor.ts:7727-7735 的注释写明了它的理由——"its Worker-side abort chain may still be settling and the delivery that follows must queue behind the admission instead of entering a half-persisted session"。也就是说：

- 现有契约认为：取消后立刻放行，可能让后继进入一个**尚未持久化完成**的 AgentScope 会话。
- 本卡的前提认为：owner 已终态 `cancelled` 就是可释放的证明，否则会话永久不可用。

两者不能同时成立。这不是实现问题，是范围/设计裁决，按 AGENTS.md「修复超出既定范围时提交具体反例、最小修复建议及影响，等待范围决定」上交，**不自行改写这三个已交付用例来让修复变绿**（那等于放宽断言、拆掉 RT-26 的护栏）。

### 可选方向与影响

| 方案 | 做法 | 代价与风险 |
| --- | --- | --- |
| A 接受新契约 | 保留当前修复，改写 `:402`/`:546`/`:785`，把"必须停在 recovering"改成"终态 owner 释放后后继可执行"，并保留一个 owner 非终态仍 park 的用例 | 直接放弃"不进入半持久化会话"的保护。需要先证明：取消时 Worker 侧 abort 链是否真的可能留下半持久化会话；若可能，会出现上下文错乱这类更难查的缺陷 |
| B 用持久事实替代等待 | 释放条件从"owner 终态"收紧为"owner 终态 **且** abort 链已落定"（例如该 Run 的 ExternalEffect / DeliveryRecord 全部终态、execution revocation 已记录），并据此改写三个用例：已落定→放行，未落定→仍 park | 需要确认"abort 链已落定"有哪些可查的持久事实；工作量中等，但两边契约都能保住，且符合 RT-26「不用时间当证明」的原则 |
| C 给终态 owner 一条真实证明路径 | 保持 `recovering`，但让 reconciler 能对新起的 runtime 做一次 inspect/detach 取得证明，而不是依赖已死的 Worker | 最忠于现有语义，改动面最大（要动 runtime 证明获取路径），且需要 Java 侧配合 |
| D 撤回修复 | 只交付 S1–S4 的红作为反例证据，设计定案后再修 | P0 用户可见缺陷继续存在 |

实施者建议 **B**：它同时满足"Stop 后会话必须能用"和"不进入半持久化会话"，并且不需要用时间当证明。但 B 需要先确认哪些持久事实能证明 abort 链已落定，这一步需要负责人确认边界后再做。

### 裁决（2026-10-28，负责人）

**采用方案 B：用持久事实当证明。** 释放条件从"owner 终态"收紧为"owner 终态 **且** abort 链已落定"；`worker-chain.spec.ts:402`/`:546`/`:785` 按此改写为两个分支——已落定则放行后继，未落定则仍停在 `recovering`。不得用超时、缩短 lease 或重试代替该事实。

执行前置：先查证哪些**可查询的持久事实**能证明 abort 链已落定（候选：该 Run 的 ExternalEffect 全部终态、DeliveryRecord 全部终态、execution revocation 已记录、Attempt 已 `interrupted` 且无 `running` 残留），把结论与最小改动方案写回本卡后再改代码。当前 `6ce9376` 的实现在此之前不算交付完成。

在裁决之前：本卡不判定完成，`chain.log` 的"通过"要求未满足，PR #149 不是 `ready-to-merge`。

## 方案 B 前置查证（2026-10-28，在 `a409140` 上逐处核对）

要回答的问题是：**有没有可查询的持久事实能证明"abort 链已落定"？** 结论：取消场景有现成事实且语义正好对应；失败场景还缺一条，需要确认边界后再定规则。

### 1. 取消场景：有现成事实

`executionRevocations` 的 `run_abort` 行本身就是一个生命周期标记：

- 写入：`packages/db/src/cancel-runs.ts` 在**取消的同一事务**里调用 `recordRunAbortRevocations(tx, cancelledIds)`，`kind='run_abort'`、`subjectId=<runId>`。此时只代表"取消意图已持久化"。
- 删除：`packages/adapters/src/revoke-cancelled-work.ts:75-100 deliverRunAborts()`——`await abort(runId)` 成功后才 `deleteMany({ kind:'run_abort', subjectId: runId })`；抛错则保留该行并 `attempts+1`、记录 `lastError`。
- 重试：`:102-122 retryPendingRunAborts()` 由 worker sweep 重试未成功的行。

因此 **`run_abort` 行不存在 ⇒ 该 Run 的原生 AgentScope abort 已成功返回**，这正是 RT-26 担心的"Worker 侧 abort 链可能还没落定"的持久化表示；行存在 ⇒ 未落定 ⇒ 继续 park。这是"删除即证明"，不是超时，符合 RT-26 的 "elapsed time is never a proof"。

注意区分：取消事务里同时把 Attempt 置成 `cancelled`（`cancel-runs.ts:74-85`），那是**取消意图**的一部分，早于 worker abort，不能当作落定证据。

### 2. 失败场景（`:546` Routine failure、`:785` outbox restart）：还没有对应事实

`recordRunAbortRevocations` 只在 `cancelRunsInTransaction` 里调用；一个自身失败的 Run 没有 `run_abort` 行，所以"行不存在"对失败场景恒真——直接套用会让这两个用例重新变成放行，等于拆掉它们的护栏。

候选事实是**该 Run 的 Attempt 是否已到"只有持有者本人在收尾时才写"的终态**：`packages/adapters/src/executor.ts:7772-7777` 在 `finally` 里执行 `attempt.updateMany({ where: { id, status: 'running' }, data: { status: 'interrupted' } })`，位置在 stream/abort 收尾之后；worker 进程被杀则根本不会写。

但这一点**还没验证充分，不能直接落码**，原因具体：

1. 取消场景的 Attempt 是被取消事务直接置成 `cancelled` 的，所以 Attempt 状态在取消场景**不是**"持有者收尾"的证据，只在失败场景有指示意义。
2. 需要确认失败 Run 的 Attempt 由谁、在什么之后写终态，以及 worker 中途死亡时它会停在什么状态（必须停在 `running` 才符合"未落定"）。
3. 需要确认 `:546`/`:785` 两个用例里失败 Run 的 Attempt 实际处于什么状态，否则改写断言等于猜。

### 3. 方案 B 的最小可行规则（待第 2 点确认后实施）

```
release(session) when owner Run is terminal AND
  ( owner was cancelled AND no executionRevocations row (kind='run_abort', subjectId=owner) )
  OR
  ( owner failed/completed AND <持有者收尾事实，待定> )
otherwise keep `recovering`   -- RT-26 的证明语义不变
```

`run_abort` 分支可以立即实现并用 S1/S1b/S2/S4 与 `:402` 验证；失败分支必须先把第 2 点核完。

### 4. 对三个用例的改法（等规则定稿后再改）

- `:402`（取消后重试）：改成两个分支——abort 尚未送达时断言仍 `recovering`、后继仍排队；abort 成功（`run_abort` 行消失）后断言后继可执行。不是简单删掉排队断言。
- `:546` / `:785`（失败后投递排队）：等第 2 点核对完再定断言。

**当前进度**：查证第 1 点已完成并可直接落码；第 2、3 点的失败场景规则与三个用例改写尚未完成，因此本卡仍未交付完成，`6ce9376` 的实现仍然不能作为最终交付。

## 完成标准

证据放在 `docs/evidence/FIX-STOP-01/`：

- `red.log`：修复前跑 S1–S4，至少 S1 是红的，带运行命令。红色必须由目标缺陷引起，环境错误不算。
- `green.log`：修复后跑同一组测试，全绿，带运行命令。同一用例、同样有效的断言，不 skip、不放宽、不加 retry。
- `chain.log`：`pnpm test:worker-chain` 和 `pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` 都通过。
- 真模型手测截图：Stop 之后发新消息，正常收到回复。
- 回写 RT-25、RT-26 以及 CANCEL-01 / #139 对应的 AC。
- 和 VERIFY-01 的其它范围分开交付：可以在同一个模块分支里，但要分开 commit。

`red.log` 与 `green.log` 必须记录 baseline SHA 与 fix SHA。若红灯实际来自 P0-2（工具桥接 401）而不是本卡的释放缺陷，停止本卡并把事实转给对应归属，不在本卡里修 401。
