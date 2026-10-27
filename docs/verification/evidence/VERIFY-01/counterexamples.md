# VERIFY-01 反例清单

分支 `codex/verify-lifecycle-concurrency`。基线 `main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`。日期 2026-10-28。

本文件只记录**已在真实 PostgreSQL 上复现**的反例，以及明确没有复现的项。形式化扫描的"模型可达"不算生产已发生。

## CX-1（P0-3）Stop 之后会话执行权不释放，会话永久卡在 queued

**状态：已复现，红。归属 [FIX-STOP-01](../../../tasks/FIX-STOP-01.md)，本单元不修。**

### 复现

`packages/db/src/stop-session-release.postgres.test.ts`，真实 PostgreSQL（一次性容器 + 隔离克隆库），命令与环境见 [runs/S1-S4-stop-session-release/red.txt](./runs/S1-S4-stop-session-release/red.txt)。

| 场景 | 结果 | 数据库事实 |
| --- | --- | --- |
| S1 生成中点 Stop（runtime 已启动） | **红** | admission `state='recovering'`、`ownerRunId` 指向 `status='cancelled'` 的 Run；下一条消息的 `acquireSessionAdmission` 返回 `kind:'recovering'`、`nextRunId=null` |
| S1b runtime 启动前点 Stop（TTL 还有 300 秒） | **红** | admission `state='owned'`、owner 已 `cancelled`；新 Run 同样拿不到 |
| S2 追加 2 条 steering 后点 Stop | **红**（会话部分） | steering 被 `user_stopped` 的 `steering:"delete"` 明确删除（这部分符合预期，已单独断言并通过）；会话仍卡住，事实同 S1 |
| S3 Stop 撞上已 `completed` 的 Run | **绿** | `applyCancelTerminalPolicy` 的 active 守卫匹配 0 行，Run 保持 `completed`，没有多余 `run.cancelled` 事件，会话可继续。**没有反例** |
| S4 Stop 后 worker 消失 + 越过 5 分钟 lease 期限 | **红** | 时钟推进到 `expiresAt + 5min` 并跑一次 reconciler 后，admission 仍是 `recovering`、owner 仍 `cancelled`；新 Run 拿不到 |

汇总：`Tests 4 failed | 1 passed (5)`，exit 1。

### 机制（逐处代码事实，均在 `a409140` 核对）

1. **取消路径完全不碰 admission。** `apps/api/src/thread-target.ts:2050` `stopThreadRuns()` → `packages/db/src/cancel-terminal.ts:274` `applyCancelTerminalPolicy()` → `packages/db/src/cancel-runs.ts:31` `cancelRunsInTransaction()`。核对命令：`grep -rn -i admission packages/db/src/cancel-runs.ts packages/db/src/cancel-child-runs.ts packages/db/src/retry-runs.ts` 无命中。`packages/db/src/session-admission.ts` 里也没有任何 cancel 专用分支，只有两处 sweep 查询把 `cancelled` 当作终态（`:172`、`:834`）。
2. **executor 的 finally 把 cancelled 当成"结局未确认"。** `packages/adapters/src/executor.ts:7736-7757`：`!sessionMayRelease && !sessionSettled` 时，只把 `waiting_input`/`waiting_takeover` 当作 parked-on-card；`cancelled` 两者都不是，于是 `settled=false`，调用 `markSessionAdmissionRecovering(..., "agentscope_runtime_outcome_unconfirmed")`。而 `sessionMayRelease` 在 runtime 启动时被置 false（`executor.ts:6130`，注释写明"only a Runtime clean/detached proof may release the chat admission. RT-25 deliberately has no timeout shortcut"）。
3. **acquire 对 recovering 无条件让路。** `packages/db/src/session-admission.ts:297-299`：`row.state === "recovering"` 直接 `return { kind: "recovering", ownerRunId }`，不看 owner Run 是否已终态。
4. **时间兜底扫不到 recovering。** `packages/db/src/session-admission.ts:552-572` `recoverExpiredSessionAdmissions` 的条件是 `state = 'owned' AND expiresAt <= now`。`recovering` 行永远不在候选里 —— 这就是 S4 红的原因，也是 QA 里"超过 5 分钟也没恢复"的原因。
5. **唤醒队列也扫不到。** `packages/db/src/session-admission.ts:823-853` `listAvailableSessionAdmissionHeads` 要求 `admission.state = 'available'`，所以排队的后继 Run 也不会被 reconciler 唤醒。
6. **唯一出口需要死执行的 runtime 证明。** `releaseRecoveredSessionAdmission`（`:759-821`）要求 `proof` 通过校验；生产侧的证明函数是 `packages/adapters/src/executor.ts:1292-1413`，它调用 `deps.runtime.inspectAndDetach` 并要求 `proof.checkpointId === checkpointId`。Stop 之后 runtime 侧会话已经中止，拿不出匹配证明，函数在 `executor.ts:1407-1413` 记 `recovering session admission could not be proven` 并返回 false。

### 影响

用户点一次 Stop，这个会话就永久不能再用，只能新开会话。Stop 是最常用操作之一，定 P0。与 2026-10-27 QA 真模型观察一致（800 字文章、6 秒后 Stop、再问「1+1 等于几」一直 Queued、超过 5 分钟未恢复）。

### 修复边界（交给 FIX-STOP-01，本单元不实现）

- owner Run 已是终态 `cancelled` 本身就是可释放的**持久事实**证明，符合 RT-26「elapsed time is never a proof」：不是用超时当证明，而是用终态当证明。
- 只改 cancel 路径与终态释放路径；不动 RT-25 的 lease 模型，不动 RT-26 对 `suspended` 的证明语义。
- **不得削弱**既有断言：`packages/db/src/session-admission.postgres.test.ts` 的 "moves every crash point to recovering after expiry and never hands off" 要求"仅凭过期"不能移交。修复必须区分"过期"（不是证明）与"owner 终态 cancelled"（是证明），不能把 `recoverExpiredSessionAdmissions` 简单扩大到 `recovering` 而绕过证明语义——那会把 RT-25 的护栏一起拆掉。
- 不靠缩短 lease、加重试或加 sleep 掩盖。

### 本文件没有覆盖的断言

任务卡要求的另外两条断言无法在持久层观察，**不在本文件的红里**，也不声称已验证：

- 顶栏不再显示 Running / Queued —— 需要 API/Web 层。
- 日志里没有 `could not be proven` —— 需要 executor/worker 进程链或真模型手测（S1、S2 的 `pnpm dev:app` 手测项，尚未执行）。

## CX-2（P0-2）工具桥接 401 导致会话停在 Queued

**状态：本轮未复现，未判定。** 与 CX-1 表象相同，判别规则（每次复现都要记录 Run 状态、admission 状态和 worker 日志）：

- 日志有 `Tool bridge returned HTTP 401` → 归 P0-2。
- 没有 401、但 admission owner 已 `cancelled` → 归 P0-3（即 CX-1）。
- 不允许只看界面下结论。

CX-1 的四条红都满足第二条：owner 是 `cancelled`，且测试路径不涉及工具桥接，所以归因明确是 P0-3，不是 401。P0-2 需要真实 runtime 的工具桥接失败注入，属于 V5/V6 范围的进程链验证，尚未执行。

## 没有反例的项

- **S3**：Stop 撞上已终态的 Run 是无副作用的 no-op，会话可继续使用。
- **S2 的 steering 处置**：`user_stopped` 的 `steering:"delete"` 确实把两条追加消息删除，是明确丢弃而不是悄悄留着，符合任务卡"要么被处理，要么明确丢弃"。
- **现有回归入口**：`cancel-terminal`、`effect-execution-fence`、`session-admission`、`session-checkpoint` 四个 postgres 套件在基线上 4 文件 54 测试全绿（[runs/S1-S4-stop-session-release/existing-regressions-green.txt](./runs/S1-S4-stop-session-release/existing-regressions-green.txt)），说明这不是环境失败。

## V1–V7 的状态

原任务卡的 V1–V7 尚未执行，见 [scenario-map.md](./scenario-map.md)。因此**不能宣称取消、恢复、路由和 session 互斥整体安全**：本轮只交付了 S1–S4 的反例与测试，以及现有回归入口的基线绿灯。
