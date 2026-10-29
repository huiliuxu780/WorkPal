# RUN-FAILURE-01：模型失败后的确定终态

状态：`done`（PR [#157](https://github.com/huiliuxu780/WorkPal/pull/157) 已于 2026-10-29 合入 `main`，merge commit `fdcaefe8ada620899c959a88f3fdd670f05bc965`）

建议分支：`codex/run-failure-terminality`

任务归属：一个 Coding Agent、一个新分支、一个 PR。

## 交付结果

当模型服务持续返回可重试失败时，同一个 Run 只按既有自动重试预算执行。预算耗尽后，Run 和 Task 进入 `failed`，释放执行租约和会话占用，停止产生新的模型请求。

如果模型在预算内恢复，原 Run 继续成功完成。用户 Stop 在退避期间仍立即生效，Stop 后不再调用模型。

## 已证事实

[RUNTIME-RELIABILITY-01 证据](../../evidence/RUNTIME-RELIABILITY-01/README.md)记录了同一 `run.id` 在约三分钟内产生 7 次 provider 500 请求，7 个 Attempt 使用不同 id。该 Run 在 180 秒内仍为 `queued`。

既有政策只有两次自动重试：`RUN_RETRY_DELAYS_MS = [5_000, 30_000]`。因此 7 次请求不能只由 `scheduleAutomaticRunRetry` 解释。至少还有一条 recovery 或 reconciler 路径在重投这个 Run。

这是一条已复现的产品缺陷，不是要求 Coding Agent 预先接受的根因结论。先列出每个重新入队来源，再确定哪个来源把“恢复会话所有权”误成了“重新执行失败的模型调用”。

## 实现边界

从最新 `origin/main` 建立独立 worktree。先用现有 `worker-chain.spec.ts` 模型失败场景复现，不新造第二套 harness。

修复必须满足以下规则：

- Runtime 的稳定失败分类可以参与控制决策。不要再从用户可见错误文案或异常文本正则猜 `provider_5xx`。
- 自动重试预算只有 `RUN_RETRY_DELAYS_MS` 定义的一份。所有执行入口都读取同一预算和持久 Attempt 事实。
- Recovery 可以重新取得 checkpoint proof、ack admission 或完成终态事务，但不能再次执行已经失败且预算耗尽的模型调用。
- 最终失败要经过现有 `finalizeRun({ outcome: "failed" })` 权威事务。不要直接拼 Run、Task 和 Event 的终态更新。
- 已有 tool call 或 committed、executing、completed、uncertain ExternalEffect 时，继续禁止自动重试。
- RT-25 和 RT-26 的 proof gate 保持不变。DELETE 200、租约过期或经过一段时间都不是 session clean 的证明。
- 错误详情继续脱敏。provider 返回的合成密钥、主机名和响应正文不能进入用户消息、Run error、Attempt error或日志。

不要先加“已处理”布尔值来绕过重投。修复要落在产生重复执行的状态转移或 job 入队位置。

## 验收场景

使用真实 Worker、真实 Java Runtime、PostgreSQL 和模型 HTTP fixture 验收整个生命周期：

1. 模型持续返回 500。同一个 Run 最多执行初次调用和两次自动重试，随后 Run 与 Task 进入 `failed`。`run.retried` 恰好两条，三次 Attempt 都有终态，之后十秒没有新的模型请求或 `run.continue` 执行。
2. 模型第一次或第二次返回 500，下一次成功。原 Run 完成，不创建替代 Run，回复只写一次。
3. 模型返回不可重试的 4xx。Run 直接失败，不进入自动重试。
4. 用户在退避期间 Stop。Run 进入 `cancelled`，剩余 retry job 不再调用模型。
5. 有 tool call 或非终态 ExternalEffect 的 Run 不自动重试。已有 execution fence、effect fence 和 session admission 护栏继续通过。

第一个场景是本缺陷的回归用例。先在未修代码上保存红，再用同一场景证明修复后转绿。红必须由调用次数超预算或 Run 未终态触发，不使用人为 sleep 失败。

## 本地交付门禁

先跑自动重试、wait timeout、session admission、checkpoint 和 effect fence 的定向测试。然后在最终本地 head 运行：

- `pnpm lint`
- `pnpm check`
- `pnpm test:unit`
- 带真实 PostgreSQL 的 `pnpm test:postgres`
- `pnpm test:agentscope`
- `pnpm test:worker-chain`
- `pnpm test:integration`
- `pnpm test:inventory`
- `pnpm test:ci-select`
- `pnpm test:docs`

`worker-chain` 日志要保留同一失败旅程在 API、Worker、adapter 和 Java Runtime 的 `trace.id`。证据放在 `docs/evidence/RUN-FAILURE-01/`，并包含 Run、Task、Attempt、Event、job 和 session admission 的最终数据库事实。

## 禁止扩大范围

- 不添加按时间强制释放 `recovering` 会话的后门。
- 不实现缺失 checkpoint manifest 的人工 override。
- 不恢复生产 subagent delegation，也不处理 `TaskRepositoryLifecycle`。
- 不顺手修改 journey 54、PD-01 或 CARD-01F。
- 不把 `Session already has an active run` 的所有形态并入本卡。只有同一根因被回归场景直接证明时才随本卡修复。

## 交付清单

最终回交必须包含：最终 head、根因说明、同一回归场景的红绿记录、四层关联日志、最终数据库事实、完整本地门禁结果和已知限制。任务卡更新为 `ready-to-merge` 后停下，不合并 PR。

## 交付记录（Coding Agent）

- 分支：`codex/run-failure-terminality`，PR [#157](https://github.com/huiliuxu780/WorkPal/pull/157)，基线 `origin/main @ dceae3234c84b110407f893e7e4e158c2e299536`。
- 证据与门禁：[`docs/evidence/RUN-FAILURE-01/README.md`](../../evidence/RUN-FAILURE-01/README.md)。
- 根因：AgentScope 把 provider 500 报成固定文案 + `internal` 类别；adapter 用正则猜 `provider_5xx` 猜不到，executor 把结果当作“Runtime 未确认”，return 后把 Run 停回 `queued`（admission `recovering`），job reconciler 每轮重新投递，RT-26 hook 释放会话后再次执行模型调用，完全绕过自动重试预算。
- 修复：Runtime 在 stream 边界按 `ModelHttpException` 的稳定 HTTP 状态和异常类型给出 `provider_unavailable` / `provider_timeout` / `provider_rejected`；adapter 不再解析文案；executor 先读唯一重试预算再判断结果是否未确认；预算耗尽和确定性失败都走 `finalizeRun({ outcome: "failed" })`，随后仅在拿到 RT-26 proof 时释放会话，终态 Run 不再执行。
- 最终复审修复：failed terminal owner 的一次即时 proof 若因 Runtime 短暂不可达失败，durable reconciler 会重投该 owner 继续走既有 RT-26 proof 链；cancelled owner 仍须先送达 `run_abort`。分类器不释放 admission，也没有时间兜底。PostgreSQL 同一回归旧实现 8/9、新实现 9/9；真实 worker-chain 常规与 Worker restart 两条链路均在 proof 后只投递一次。
- 门禁：见证据 README 的“本地门禁”表。
- 最终交付 head：`58f9d3cfc96d2dd2064bf8680daecfba7a2ab07c`；PR #157 最终 head 的相关检查在同一 CI attempt 内全部通过。
- 合入记录：merge commit `fdcaefe8ada620899c959a88f3fdd670f05bc965`；未部署、未改 GitHub 设置。
