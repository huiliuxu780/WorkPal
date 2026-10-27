# VERIFY-01 场景矩阵

分支 `codex/verify-lifecycle-concurrency`。基线 `main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`。日期 2026-10-28。

矩阵只写**实际执行过**的场景和实际测试名。拟议文件不算已有命令。V1–V7 尚未执行，本文件如实标注，不用"已有测试通过"冒充任务完成。

环境：一次性 `postgres:16` 容器（OS 分配端口），库名取自本 worktree 的 `pnpm agent:doctor` 计划（`workpal_e2e_wt_verify_lifecycle_concurr_c57d79f7d1`，conflicts: none）；每个套件用 `createIsolatedPostgresDatabase()` 从迁移模板克隆独立库并在 `afterAll` 删除。未接触生产库或共享库。前置：`pnpm --filter @rakazo/db generate`（缺失时套件无法收集，属环境错误，不计入证红）。

真实 SDK / 确定性模型夹具 / scripted 的区分：本文件里所有已执行场景都是**持久层**验证，不涉及 runtime，因此三者都不适用；需要 runtime 的断言在下表明确标为未覆盖。

## 已执行：S1–S4（2026-10-28 新增范围）

| 场景 | 可检查性质 | 生产路径 | 实际测试名 | 结果 | 生产可达 |
| --- | --- | --- | --- | --- | --- |
| S1 生成中 Stop | Stop 后同一会话的下一条消息必须在同一个事件检查周期内取得执行权；不得留下被终态 Run 占用的 admission | `apps/api/src/thread-target.ts:2050 stopThreadRuns` → `packages/db/src/cancel-terminal.ts:274 applyCancelTerminalPolicy` → `cancel-runs.ts:31 cancelRunsInTransaction`；`packages/adapters/src/executor.ts:6130` 置 `sessionMayRelease=false`，`:7736-7757` finally 调 `markSessionAdmissionRecovering` | `stop-session-release.postgres.test.ts` → "S1: cancelling an in-flight generation lets the next message run" | **红** | 是（QA 已观察到） |
| S1b runtime 启动前 Stop | 同上，且不能靠等 TTL 过期解决 | 同上，admission 仍 `owned` | "S1b: cancelling before the runtime started must not wait out the admission TTL" | **红** | 是 |
| S2 追加 steering 后 Stop | 追加消息要么被处理要么明确丢弃；会话不能卡住 | `cancelPolicyFor("user_stopped")` 的 `steering:"delete"` + `abandonThreadSteering` | "S2: appended steering is explicitly discarded and the conversation keeps working" | **红**（会话）；steering 删除断言本身通过 | 是 |
| S3 Stop 撞上终态 Run | 已 `completed`/`failed` 的 Run 不得变成 `cancelled`，不得多一个终态事件，会话可继续 | `cancel-runs.ts` 的 `ACTIVE_RUN_STATUSES` 守卫 | "S3: Stop that lands on an already terminal Run changes nothing and leaves the session usable" | **绿** | 是 |
| S4 Stop + worker 重启/lease 过期 | 越过 lease 期限后 reconciler 必须真的释放会话 | `apps/worker/src/session-admission-reconciler.ts` → `session-admission.ts:552 recoverExpiredSessionAdmissions` | "S4: a worker restart or expired lease must still free a session whose owner was cancelled" | **红** | 是 |

命令与输出：[runs/S1-S4-stop-session-release/red.txt](./runs/S1-S4-stop-session-release/red.txt)（`Tests 4 failed | 1 passed (5)`，exit 1）。反例归因与机制：[counterexamples.md](./counterexamples.md) CX-1。

**任务卡要求但持久层无法观察、因此未覆盖的两条断言**（不用其他证据冒充）：

- 顶栏不再显示 Running / Queued —— 需 API/Web 层。
- 日志里没有 `recovering session admission could not be proven` —— 需 executor/worker 进程链或 `pnpm dev:app` 真模型手测（S1、S2 的手测项**尚未执行**，截图与 Run/admission 两表查询结果待补）。

## 已执行：任务卡列出的最小现有回归入口

命令：

```bash
pnpm exec vitest run packages/db/src/cancel-terminal.postgres.test.ts \
  packages/db/src/effect-execution-fence.postgres.test.ts \
  packages/db/src/session-admission.postgres.test.ts \
  packages/db/src/session-checkpoint.postgres.test.ts --no-file-parallelism
```

结果：4 文件 54 测试全绿，exit 0 — [runs/S1-S4-stop-session-release/existing-regressions-green.txt](./runs/S1-S4-stop-session-release/existing-regressions-green.txt)。这证明数据库与 harness 可用，S1–S4 的红不是环境失败。

## 未执行：V1–V7

按任务卡要求逐项列出缺口。"已有部分覆盖"只写实际存在的测试名，不推断未读过的行为。

| 步骤 | 要求 | 已有部分覆盖（实际测试名） | 缺口 | 状态 |
| --- | --- | --- | --- | --- |
| V1 级联取消 | root + 两个 child + 跨 Thread child + 无关 root；先取消一个 child 再取消 root；注入迟到完成 | `wait-timeouts.postgres.test.ts` 断言 `cancelChildrenOfCancelledRuns` 的后代集合；`bot-messages-pair.postgres.test.ts:660,1770` 断言 pair Run 的后代处理 | 没有覆盖"跨 Thread child"、"无关 root 存活"、"迟到完成不复活"三点；`listDescendantRunIds` 没有专门测试 | 未执行 |
| V2 等待接管 | `waiting_takeover` 下 Stop / 超时 / 丢 lease，期间写两条 steering；只恢复绑定执行；手动 Stop 与非手动取消不同 disposition；最多一个 continuation | `cancel-terminal` 的 "releases steering on wait timeout and creates one continuation"、"does not duplicate a continuation after a Worker restart"、"does not report or keep steering when the user stops"；`session-checkpoint` 的 "releases a suspended admission only after the proof is acknowledged"、"keeps an RT-25 recovering owner until a fresh proof is acknowledged" | "期间写入两条 steering"与"手动 Stop vs 非手动取消的 disposition 差异"没有单独用例 | 未执行 |
| V3 多目标派发 | 一条消息 @A/@B，一支失败；重复请求与回放；无重复 Task/Run/外部副作用 | 未核对到对应 PostgreSQL 用例；`packages/core/src/product-harness/group-routing.test.ts`、`response-owner.test.ts` 是内存单测 | 缺真实 PostgreSQL 的归属与去重验证 | 未执行 |
| V4 多消息与渠道 | app 与 messaging 交错，连续追加 ≥2 条；交换查询结果顺序；不由数据库返回顺序决定目标 | `cancel-terminal` 的 "does not batch direct, group, and channel steering into one continuation"、"migrates superseded steering onto one replacement and retains otherwise" | 缺"交换查询结果顺序仍稳定"的显式用例，缺消息 seq/consumed 事实断言 | 未执行 |
| V5 session 并发 | 同 Bot 同 Thread 两个独立 Run；A 暂停、B 回复、A 恢复；旧 Worker 迟到写入 | `session-admission` 的 "keeps a second independent Run queued for the same Bot and Thread"、"hands a paused session to the same Run without admitting another Run"；`session-checkpoint` 的 "isolates Run A from Run B and only resumes the owning Run"；`effect-execution-fence` 的 "rejects the old worker after a new worker reclaims the lease"、"rejects a different lease fence" | 需要补"A 暂停 → B 回复 → A 恢复"的完整时序与旧 fence 伪造 `tool.called` 的组合用例；`execution-fenced-events.postgres.test.ts` 尚未逐一核对 | 未执行 |
| V6 时间与崩溃 | acquire 后 / Runtime 中 / release 前终止 Worker；真实 lease 回收；至少一个进程级真实时钟案例 | `session-admission` 的 "moves every crash point to recovering after expiry and never hands off"（三个崩溃点，可控时钟）、"requeues an expired Run claim that crashed after persisting its queued request"；`effect-execution-fence` 的 "rejects a claim whose lease expires while it waits for the effect lock" | **缺进程级真实时钟案例**（现有全部是可控时钟的持久层测试）；S4 已证明 `recovering` 不在 lease 回收范围内 | 未执行 |
| V7 插话策略 A | X 排队时用户再点名 Y；普通单目标与显式多目标分别执行；Y 不隐式取消 X | `session-admission` 的 "keeps a second independent Run queued for the same Bot and Thread"、"does not let a cancelled queued Run block the durable FIFO head" | 缺"显式多目标各目标独立归属"的用例；缺路由层（`group-routing`）与持久层的联合验证 | 未执行 |

## 变异检查

`mutations/` 目录尚未产生结果。计划对 fence、取消范围、steering、重复 dispatch 做定向变异，证明测试能发现违约；CX-1 的修复不属于本单元，因此 S1–S4 的变异验证与 FIX-STOP-01 的 green 一起交付更合适（同一个用例先红后绿）。

## 结论边界

本轮交付的是：S1–S4 的真实 PostgreSQL 测试与已复现反例 CX-1、现有回归入口的基线绿灯、以及 V1–V7 的逐项缺口清单。**不得据此宣称取消、恢复、路由和 session 互斥整体安全**：V1–V7 未执行，且已存在一个 P0 级未修复反例。
