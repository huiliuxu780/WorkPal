# FIX-STOP-01 修正后的规则：释放要 proof，不要 abort 200

日期 2026-10-28。分支 `codex/verify-lifecycle-concurrency`。

## 为什么改

最初的修法把「`run_abort` revocation 消失」当成 abort 已落定。复审指出这是错的，代码事实核对后确认：

1. `AgentScopeAgentRuntime.abort()` 只在 DELETE 返回成功时结束。
2. Java 的 DELETE 处理只调 `engine.cancel(runId)`、中断线程，随即返回 200。
3. `activeRuns` / `activeSessions` 要等原执行线程进入 `finally` 才被移除。
4. DELETE 不调用 `inspectAndDetach`，也不清理已持久化的 pending tool/ask 状态。
5. Worker 随后删除 revocation 行。

所以「行不存在」只证明 **abort 请求被接收**。照它放行会让后继进入旧执行可能仍占用的会话。

## 现在的规则

| 情形 | 行为 |
| --- | --- |
| `runtimeStartedAt` 为空 + owner `cancelled` | 直接释放（runtime 从未进入共享会话，没有可继承的状态） |
| `runtimeStartedAt` 非空 + revocation 仍在 | 保持 `recovering` |
| `runtimeStartedAt` 非空 + revocation 已删除 | **仍保持 `recovering`**；reconciler 只把 owner Run 重新投递 `runContinueJob`，由现有 RT-26 terminal-owner hook 取 `inspectAndDetach` 的 `clean`/`detached` 证明并 ack，之后才由 `releaseRecoveredSessionAdmission` 释放 |
| 拿不到证明 | 一直 `recovering`；不得用时间、租约过期或 DELETE 200 放行 |

- `acquireSessionAdmission` 对 runtime 已启动的 owner **永不**直接释放。
- `apps/worker/src/session-admission-reconciler.ts` 只做分类与重投，**没有**复制 checkpoint id、watermark、intervention、ack 逻辑。

## 四个确定性分支与证据

| 分支 | 用例 | 结果 |
| --- | --- | --- |
| 1 runtime 从未启动 | `branch 1: a session the runtime never entered is released on the cancelled status` | 绿 |
| 2 revocation 仍在 | `branch 2: a started session with the abort still outstanding stays parked` | 绿 |
| 3 revocation 删除但无 proof | `branch 3: revocation gone but no detach proof still keeps the session parked` | **旧实现红**（`expected 'acquired' to be 'recovering'`），新实现绿 |
| 3b 时间不是证明 | `branch 3b: the lease horizon is still not a proof` | 绿 |
| 4 proof 落库后释放 | 释放半边由既有用例覆盖：`packages/adapters/src/session-checkpoint-recovery.postgres.test.ts` 的 **"releases a terminal owner's recovering admission without resuming that Run"**（terminal owner + recovering → 走 RT-26 proof 释放、且不恢复该 Run）；触发重投由 `apps/worker/src/session-admission-reconciler.test.ts` 的 "re-dispatches a cancelled owner whose runtime started instead of releasing it" 覆盖；端到端由 `apps/web/e2e/worker-chain.spec.ts` 的 proof gate 覆盖（gate 3） | 既有绿 + 新增 |

红绿：[v2-red.log](./v2-red.log)（`c53bea1` 的两个源文件 + 新测试，6 红）、[v2-green.log](./v2-green.log)（新实现，7 绿）。

## 已知限制

- runtime 不可达、旧 binding 无法重新认领、manifest 缺失或 proof 冲突时，会话会持续 `recovering`。这并非"所有 JVM 重启都永久阻塞"：已有 manifest 且 binding 完整时支持重新认领。没有 manifest 的极端情况需要一个单独的人工/运维出口，本卡不提供时间兜底。
- 旧版 `docs/evidence/FIX-STOP-01/README.md`、`real-model/` 与 `chain.log` 对应的是被撤回的实现，**不能**作为本规则的证据；本文件才是。

## 完成情况

- `apps/web/e2e/worker-chain.spec.ts` 已改为确定性三栅：runtime 已启动断言 → 停 Worker 后 Stop（revocation 存在、阻塞）→ 用生产 `deliverRunAborts` 送 abort（revocation 消失、仍阻塞）→ 启动 Worker，由真实 RT-26 链产出并 ack proof 后放行。worker-chain **5/5 通过**。
- 分类器补上"转成 recovering"：Worker 先停会让 admission 停在 `owned`，而 RT-26 hook 只认 `recovering`，因此 `listCancelledSessionsToRecover` 先用 `parkRunForRecovery` 把 `owned` 转成 `recovering`（该 Run 已终态，不会被重新入队）。
- 受控真模型验收已按新规则重做：[real-model-v2/README.md](./real-model-v2/README.md)。
- branch 4 的释放半边由既有 `session-checkpoint-recovery.postgres.test.ts` 覆盖，本次护栏运行包含它（6 文件 62 测试全绿）；当前完整 PostgreSQL 组为 51 文件 456 测试全绿。
