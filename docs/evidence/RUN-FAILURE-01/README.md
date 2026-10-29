# RUN-FAILURE-01 — 模型失败后的确定终态：证据

任务卡：[`docs/tasks/third-batch-20261029/RUN-FAILURE-01.md`](../../tasks/third-batch-20261029/RUN-FAILURE-01.md)。

- 分支：`codex/run-failure-terminality`
- PR：[#157](https://github.com/huiliuxu780/WorkPal/pull/157)
- 基线：`origin/main @ dceae3234c84b110407f893e7e4e158c2e299536`
- 状态：`ready-to-merge`（PR 见下方交付记录，未合并）
- 环境：macOS arm64、Node 24、pnpm 9.15.0、JDK 21、PostgreSQL 16（Colima 容器）、真实 Worker 进程、真实 Java AgentScope Runtime、回环模型 HTTP fixture

证据文件：

| 文件 | 内容 |
| --- | --- |
| `red-worker-chain.txt` | 同一回归场景在未修代码上的红（`attempts: 5`，Run 未终态）与重投时间线 |
| `green-worker-chain.txt` | 修复后完整 `pnpm test:worker-chain`（11 passed）与五个验收场景断言 |
| `four-layer-trace.txt` | 同一失败旅程在 API / Worker / adapter / Java Runtime 的同一 `trace.id` |
| `db-facts.txt` | 该 Run 的 Run / Task / Attempt / Event / job / checkpoint / admission 最终数据库事实 |
| `baseline-journey-54.txt` | `pnpm test:integration` 唯一红的基线对照 |
| `gates.txt` | 本地门禁命令与结果 |

## 根因（已由复现与数据库事实确认）

1. **运行时把 provider 500 报成固定文案 + `internal` 类别。** Java Runtime 在
   `RuntimeEngine` 的 stream 边界记录 `runtime.stream.failed`（`error.type` 是
   SDK 的 `RetryExhaustedException`，cause 为带 HTTP 500 的 `OpenAIException`），
   `RuntimeServer` 发出 `{type:"error", message:"Agent execution failed",
   category:"internal"}`。`FailureCategory` 当时**没有** provider 类别，模型失败统一
   归为 `internal`。
2. **adapter 用文案正则猜类别。** `transientWireError(message)` 从
   “Agent execution failed” 里找 `500/502/503/504/timeout`，永远命中不了 →
   抛普通 `Error`，把一次**已知的确定性失败**降级成“未确认结果”。
3. **executor 把确定性失败当成未确认。** catch 里 `admission && !sessionMayRelease`
   的守卫在自动重试代码之前 `return`，随后 `finally` 用
   `markSessionAdmissionRecovering` → `parkRunForRecovery` 把 Run 停回 `queued`
   （attempt 记为 `interrupted: agentscope_runtime_outcome_unconfirmed`）。
4. **recovery 把“恢复会话所有权”误成了“重新执行失败的模型调用”。** 重新入队来源有两处：
   - `packages/adapters/src/job-reconciler.ts` 每轮把 `queued`（`retryAt` 为空或已到）
     和租约过期的 Run 重新投递为 `run.continue`；
   - `continueRun` 的 RT-26 hook（`executor.ts:1727`）拿 fresh proof 释放 `recovering`
     会话后，同一个 claim 继续执行这个 `queued` Run，创建全新 Attempt 并再次调用模型。
   `scheduleAutomaticRunRetry` 从未被调用，所以 `RUN_RETRY_DELAYS_MS` 的预算完全被绕过；
   `run.retried` 事件为 0。

红记录（`red-worker-chain.txt`）：约 2.1 分钟内同一 `run.id` 出现 5 个不同 `attempt.id`，
Run 始终没有 `failed`；第一次复现的数据库事实是 attempt 1 被 `interrupted`，随后一个全新
Attempt 消费了下一次 provider 请求。

## 修复

1. **Runtime 提供稳定分类（Java）。**
   - 新增 `ModelStreamFailure`：stream 边界抛出的包装异常，携带在该边界选出的类别，消息固定为
     “Agent execution failed”（provider 文案、正文、URL 不进入 wire、日志或持久化错误）。
   - `FailureCategory.forModelStream` 只依据**异常类型与 provider HTTP 状态**：
     `ModelHttpException.isRetryableHttpStatus()`（429/5xx）→ `provider_unavailable`；
     408 与 socket/http timeout 类型 → `provider_timeout`；其余 4xx → `provider_rejected`；
     无法识别的 stream 失败 → `internal`（终态，不复用为可重试）。
   - `FailureCategory.of` 识别 `ModelStreamFailure`，`RuntimeServer` 原有的 `category`
     wire 字段因此带上真实类别。
2. **adapter 不再解析文案（TS）。** 删除 `transientWireError`：
   `provider_unavailable` → `AgentScopeTransientError("provider_5xx")`，
   `provider_timeout` → `AgentScopeTransientError("llm_timeout")`，其余（含
   `provider_rejected`、`internal`、无类别）→ 新增的 `AgentScopeRunFailedError`
   （确定性失败）。自动重试预算仍然只有 `RUN_RETRY_DELAYS_MS` 一份，由
   `scheduleAutomaticRunRetry` 读取持久 Attempt 事实。
3. **executor 修正状态转移。**
   - 先读重试预算、再判断“是否未确认”：transient 失败在预算内 → 既有
     `scheduleAutomaticRunRetry` + `run.retried`；预算耗尽 → 继续走到
     `finalizeRun({ outcome: "failed" })`。这修复了守卫在重试之前 `return` 的缺陷。
   - `AgentScopeRunFailedError` 与预算耗尽的 transient 都视为确定性失败，
     经现有 `finalizeRun` 权威事务进入 `failed`（Run、Task、Attempt、`run.failed`
     一次写完，lease 清空）。
   - `finally` 在 Run 已经终态后，才用**同一执行绑定**的 RT-26 proof 结算会话；
     没有 proof 就维持原有 `recovering` park。proof 只是释放所有权，终态 Run
     不会再次进入 Runtime（`continueRun` 的 terminal 分支只做 `recoverSessionOwner`）。
   - 既有护栏不变：有 `agent.tool.called` 或 committed/executing/completed/uncertain
     ExternalEffect 时不自动重试；RT-25/RT-26 proof gate 没有增加时间后门；
     DELETE 200/租约过期仍不是 clean 证明。

改动文件：`services/agent-runtime`（`RuntimeEngine`、`FailureCategory`、
`ModelStreamFailure` 与测试）、`packages/adapters/src/agentscope-runtime.ts`、
`packages/adapters/src/executor.ts`、`apps/web/e2e/worker-chain.spec.ts`、任务卡与
本证据目录。没有前端页面变化（不需要原型），没有改 API 契约、数据库 schema、
`RUN_RETRY_DELAYS_MS`、gate 或 GitHub 设置。

## 先红后绿（同一用例）

- 红：`red-worker-chain.txt`，同一 `worker-chain.spec.ts` 场景
  `a persistent provider failure ends the Run after the automatic retry budget`，
  `Received: "attempts: 5"` / Run 未终态。红由调用次数超预算与 Run 未终态触发，
  不是人为 sleep 失败。
- 绿：`green-worker-chain.txt`，修复后同一场景 1.1m 通过，且完整套件 11 passed。

## 验收场景（真实链路）

| 场景 | 结果 | 关键事实 |
| --- | --- | --- |
| 1. 持续 500 | 通过 | 3 Attempt、2 `run.retried`、Run/Task `failed`、3 次模型调用；之后 10s 无新模型调用/新 Attempt |
| 2. 预算内恢复 | 通过 | 原 Run `completed`，2 Attempt，1 `run.retried`，无替代 Run，回复 1 条 |
| 3. 不可重试 4xx | 通过 | 1 Attempt 直接 `failed`，0 `run.retried`，错误脱敏 |
| 4. 退避期间 Stop | 通过 | Run `cancelled`，剩余 retry job 未调用模型（模型调用数保持 1） |
| 5. tool call 后失败 | 通过 | 1 Attempt、0 `run.retried`、1 `agent.tool.called`；effect fence 由 `pnpm test:postgres` 覆盖 |

四层关联日志见 `four-layer-trace.txt`：同一 `trace.id=c3437a1a1607c70b0ef396d05b9982a5`
贯穿 API `http.request.completed`、Worker `run.continue`/`agentscope.run.requested`/
`agentscope.run.failed`、Java `runtime.run.accepted → stream.started →
stream.failed → run.failed`（`error.category=provider_unavailable`）。

## 已知限制（如实记录）

1. **SDK 内部重试仍在。** AgentScope OpenAI 模型默认
   `ExecutionConfig.MODEL_DEFAULTS.maxAttempts=3`，一个 Attempt 可能对 provider 发起最多
   3 次 HTTP 请求后才失败。产品重试预算按 Attempt 计（`RUN_RETRY_DELAYS_MS`），本次未改；
   持续 500 时最坏 HTTP 请求数是 3 Attempt × 3 = 9，但 Attempt、`run.retried` 与模型调用
   次数严格受预算约束。
2. **无 HTTP 状态、非 timeout 类型的 Java 模型失败归为 `internal`，直接终态不重试。**
   这是刻意的保守选择：无法稳定识别为可重试的失败不会被重放。Java 侧由
   `ModelUtils` 包装的超时（`ModelException`，无 cause）也不会被识别为 timeout。
3. **拿不到 RT-26 proof 时仍停在 `recovering`。** 与既有一致：不按时间强制释放；
   本任务没有新增后门。预算失败发生在 executor 之外的路径（如 `enforceRunBudgets`
   先 finalize）保持原有的 park 行为，`a Routine failure queues one delivery behind
   recovering chat admission` 场景继续通过。
4. **`pnpm test:integration` 的 journey 54 是基线红**（群聊多人 mention 的 owner 语义，
   与本 diff 无关，baseline-journey-54.txt 有对照）。
5. **`409 Session already has an active run` 未处理**，与本卡根因无直接关系（任务卡明确
   禁止把它的所有形态并入本卡）。Worker 被杀后 admission 过期的既有恢复场景
   （`a Worker killed mid-Run …`）行为不变。

## 交付记录

- 最终 head：见 PR（分支 `codex/run-failure-terminality`）。
- 任务卡状态：`ready-to-merge`；未合并、未部署、未改 GitHub 设置。
- diff 中无密钥、无真实用户数据、无私有 URL、无本机路径；测试用的 provider 合成密钥与
  合成主机只作为“必须不出现”的断言输入。
