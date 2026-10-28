# FIX-STOP-01 证据索引

单元：FIX-STOP-01（Stop 后释放会话执行权）。分支 `codex/verify-lifecycle-concurrency`，与 VERIFY-01 同分支、分开 commit。
日期：2026-10-28。环境：macOS arm64，Node v24.18.0，pnpm 9.15.0，JDK 21.0.12.1（Homebrew，只设 `JAVA_HOME`，未改系统配置）。

| 项 | 值 |
| --- | --- |
| 最终修法 | 收窄方案 B：**仅 Stop/取消路径**；放行需同时满足「owner 是 `cancelled`」与「该 Run 的 `run_abort` revocation 已不存在」 |
| fix SHA | `55bb228`（收窄实现）；E2E 两分支改写 `22da16f` |
| baseline（红） | `main a409140` 的两个源文件（`git show a409140:<path>` 还原）+ 当前测试文件 |
| 回归用例 | `packages/db/src/stop-session-release.postgres.test.ts` 六个用例；`apps/web/e2e/worker-chain.spec.ts:402` 两个分支 |
| 真实模型 / 模型夹具 / scripted | 红绿两轮都不用真模型（持久层）。E2E 用本地模型夹具 + 真实 Java runtime。真模型复测见"未完成项" |

## 文件

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| [red.log](./red.log) | 当前测试 + `a409140` 的两个源文件 | exit 1，**4 failed / 2 passed**——红的就是目标缺陷：abort 确认后会话仍不释放。S3 与 failed-owner 边界用例在基线上本来就绿，它们防的是"修过头" |
| [green.log](./green.log) | 同一条命令、同一组用例，`55bb228` | exit 0，**6 passed** |
| [guards.txt](./guards.txt) | RT-25/RT-26 邻接护栏（session-admission、session-checkpoint、cancel-terminal、effect-execution-fence、wait-timeouts） | exit 0，6 文件 66 测试全绿 |
| [postgres-group.txt](./postgres-group.txt) | `pnpm test:postgres` 全组 | exit 0，**51 文件 455 测试全绿** |
| [chain.log](./chain.log) | `pnpm test:worker-chain` | 见文件 |
| [chain-conflict.txt](./chain-conflict.txt) | 历史记录：被否决的"任意终态即释放"修法如何打破三个已交付契约，以及据此收窄的经过 | 保留作决策依据 |

## 放行条件与为什么它不是超时

- `run_abort` revocation 由 `cancelRunsInTransaction` 在**取消的同一事务**里写入（`recordRunAbortRevocations`）。
- `deliverRunAborts`（`packages/adapters/src/revoke-cancelled-work.ts:75-100`）**只在 `runtime.abort()` 成功返回后**删除该行；抛错则保留并累加 `attempts`、记 `lastError`。
- 因此「owner 已 `cancelled` 且该行不存在」= 原生 abort 已返回，也就是 RT-26 等的那个"落定"；用删除当证明，不用时间。
- 查询顺序：**先读 owner 终态、再读 revocation**，都在调用方事务内。READ COMMITTED 下两次读之间被删的行只可能因 abort 返回而删；先读 revocation 则会把"尚未写入"误判为"已完成"。
- 行仍在 → 保持 `recovering` 并排队。**S4 显式把时钟推到 `expiresAt + 5min` 跑 reconciler，abort 未确认时断言仍 `recovering`**，证明时间不是放行信号。

## 两个分支都有覆盖

每个取消场景（S1/S1b/S2/S4）都断言两段：

1. abort 未送达：后继拿不到会话（`recovering`；runtime 未启动时是 `owned`，后继表现为 `queued`），且 holder 仍是那个 `cancelled` Run；
2. abort 确认后：同一 tick 取得执行权，且没有终态 owner 残留。

E2E `:402` 同样两个分支：Worker 停止时 revocation 在、重试排队且模型不被调用；Worker 启动后 sweep 清掉该行，重试取得会话、离开 `queued`、回复进入转录。

## 边界：failed / completed owner 不在规则内

这两条路径根本不写 `run_abort` 行，所以"没有 revocation"对它们恒真。照此放行会在会话状态尚未落定时移交，正是 `worker-chain.spec.ts:546`/`:785` 禁止的。新增 PG 用例 **"a failed owner stays parked"** 把这条边界钉成断言；两个 E2E 用例未改动且通过。

## 未完成项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真模型手测（Stop 后发新消息正常收到回复 + 截图 + Run/admission 两表查询） | **未执行** | 需要真模型凭据与浏览器操作。不用夹具或 scripted 冒充 |
| 顶栏不再显示 Running / Queued | **未验证** | 属 API/Web 层；E2E 覆盖了"重试离开 queued"与"回复出现"，但没有断言顶栏文案 |
| 日志里没有 `could not be proven` | **未验证** | 需要 worker/executor 日志断言；本轮未加 |
| 回写 RT-25、RT-26 与 CANCEL-01 / #139 的 AC | 未执行 | 等真模型手测齐了再写，避免把未验证的结论写进别的卡 |
| 失败场景（`:546`/`:785`）的三个未决问题 | 另案 | 按负责人裁决不塞进本单元，见任务卡"后续调查" |

按 [AGENTS.md](../../../AGENTS.md) 第 6 条，缺项在本分支补齐，不另拆"补验收"任务；补齐前本卡不判定完成、不建议合并。
