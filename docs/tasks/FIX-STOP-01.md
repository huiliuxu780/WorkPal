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

## 已实施修复

- `packages/db/src/session-admission.ts`：新增内部 `releaseTerminalOwnerAdmission(tx, row, now)`——owner Run 处于 `completed`/`failed`/`cancelled` 时把 admission 置回 `available`，`lastReleaseReason='owner_run_terminal'`，并释放其 request 行。终态集合与文件里既有的两处 request sweep（`:172`、`:834`）一致。
- `acquireSessionAdmission` 在锁行之后、判定 `recovering`/`owned` 之前调用它，因此下一条消息在**同一个事务、同一个事件检查周期**内就能取得执行权（覆盖 S1/S1b/S2/S4）。
- 新增导出 `releaseSessionAdmissionsWithTerminalOwner(prisma, now, limit)`，用 `FOR UPDATE ... SKIP LOCKED` 批量释放，并返回每个会话的排队后继。
- `apps/worker/src/session-admission-reconciler.ts`：在过期 sweep **之前**先跑终态释放（终态优先于过期，避免把已终态的 owner 又 park 成 recovering），把释放出的后继与可用 FIFO head 去重后各入队一次，返回值新增 `released`。

没有做的事，以及为什么这样不算削弱护栏：

- **没有**把 `recoverExpiredSessionAdmissions` 扩大到 `recovering`。仅凭过期仍然不移交：`session-admission.postgres.test.ts` 的 "moves every crash point to recovering after expiry and never hands off" 修复后仍然绿（其 owner Run 是 `queued`，非终态，不落入新规则）。
- **没有**改 RT-26 的证明语义：`session-checkpoint.postgres.test.ts` 的 "keeps an RT-25 recovering owner until a fresh proof is acknowledged" 与 "releases a suspended admission only after the proof is acknowledged" 修复后仍然绿。
- **没有**缩短 lease、加重试或加 sleep；S1–S4 的时钟全部显式传入。
- **没有**改 cancel 的业务语义（steering disposition、notice、continuation 都不动）；`cancel-terminal.postgres.test.ts` 12 项、`effect-execution-fence.postgres.test.ts` 18 项修复后仍然绿。

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

在裁决之前：本卡不判定完成，`chain.log` 的"通过"要求未满足，PR #149 不是 `ready-to-merge`。

## 完成标准

证据放在 `docs/evidence/FIX-STOP-01/`：

- `red.log`：修复前跑 S1–S4，至少 S1 是红的，带运行命令。红色必须由目标缺陷引起，环境错误不算。
- `green.log`：修复后跑同一组测试，全绿，带运行命令。同一用例、同样有效的断言，不 skip、不放宽、不加 retry。
- `chain.log`：`pnpm test:worker-chain` 和 `pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` 都通过。
- 真模型手测截图：Stop 之后发新消息，正常收到回复。
- 回写 RT-25、RT-26 以及 CANCEL-01 / #139 对应的 AC。
- 和 VERIFY-01 的其它范围分开交付：可以在同一个模块分支里，但要分开 commit。

`red.log` 与 `green.log` 必须记录 baseline SHA 与 fix SHA。若红灯实际来自 P0-2（工具桥接 401）而不是本卡的释放缺陷，停止本卡并把事实转给对应归属，不在本卡里修 401。
