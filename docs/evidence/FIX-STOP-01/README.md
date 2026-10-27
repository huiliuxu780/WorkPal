# FIX-STOP-01 证据索引

单元：FIX-STOP-01（Stop 后释放会话执行权）。分支 `codex/verify-lifecycle-concurrency`，与 VERIFY-01 同分支、分开 commit。
日期：2026-10-28。主机：macOS arm64，Node v24.18.0，pnpm 9.15.0，JDK 21.0.12.1（Homebrew，`JAVA_HOME` 指向 `/opt/homebrew/opt/openjdk@21/...`，未改动系统 Java 配置）。

| 项 | 值 |
| --- | --- |
| baseline SHA（红） | `e72108f`（S1–S4 测试已在，修复未做） |
| fix SHA（绿） | `6ce9376cfbe4412fba926622529fda5797f97a41` |
| 回归用例 | `packages/db/src/stop-session-release.postgres.test.ts` 的 S1、S1b、S2、S3、S4 |
| 数据库 | 一次性 `postgres:16` 容器，OS 分配端口，库名 `workpal_e2e_wt_verify_lifecycle_concurr_c57d79f7d1`（取自本 worktree 的 `pnpm agent:doctor` 计划，conflicts: none）；每个套件用 `createIsolatedPostgresDatabase()` 从迁移模板克隆独立库并在 `afterAll` 删除 |
| 真实 SDK / 模型夹具 / scripted | 都不涉及。红绿两轮都是持久层验证，驱动的是生产取消策略（`applyCancelTerminalPolicy` + `cancelPolicyFor("user_stopped")`，即 `apps/api` `stopThreadRuns` 的事务体）和 executor 实际调用的 admission 函数 |

## 文件

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| [red.log](./red.log) | 修复前同一命令、同一用例 | exit 1，`Tests 4 failed \| 1 passed (5)` |
| [green.log](./green.log) | 修复后同一命令、同一用例、同样断言 | exit 0，`Tests 5 passed (5)` |
| [guards.txt](./guards.txt) | 修复后跑 RT-25/RT-26 邻接护栏（session-admission、session-checkpoint、cancel-terminal、effect-execution-fence、wait-timeouts） | exit 0，6 文件 65 测试全绿 |
| [postgres-group.txt](./postgres-group.txt) | 修复后 `pnpm test:postgres` 全组 | exit 0，51 文件 454 测试全绿 |

命令（红绿完全一致，只有被测代码不同）：

```bash
pnpm --filter @rakazo/db generate
pnpm --filter @rakazo/db exec prisma migrate deploy
VERIFY_DATABASE=1 DATABASE_URL=postgresql://***:***@127.0.0.1:<port>/workpal_e2e_wt_verify_lifecycle_concurr_c57d79f7d1 \
  pnpm exec vitest run packages/db/src/stop-session-release.postgres.test.ts --no-file-parallelism
```

凭据已脱敏，且本来就是一次性容器的测试账号。文件名沿用任务卡要求的 `red.log`/`green.log`；`.gitignore` 排除 `*.log`，因此这两个文件用 `git add -f` 提交。

## 红为什么是目标缺陷而不是环境问题

- 红的断言消息直接给出数据库事实：admission `state='recovering'`（S1/S2/S4）或 `state='owned'`（S1b），`ownerRunId` 指向 `runStatus='cancelled'` 的 Run；下一条消息的 `acquireSessionAdmission` 返回 `kind:'recovering'`、`nextRunId=null`。
- 同一环境、同一命令下，任务卡指定的四个既有回归（`cancel-terminal`、`effect-execution-fence`、`session-admission`、`session-checkpoint`）在修复前就是 4 文件 54 测试全绿，见 VERIFY-01 的 [existing-regressions-green.txt](../../verification/evidence/VERIFY-01/runs/S1-S4-stop-session-release/existing-regressions-green.txt)。数据库与 harness 可用，因此红不是环境失败。
- 没有 skip、没有 `it.fails`、没有放宽断言、没有加 retry。红绿之间只有 `session-admission.ts`、`session-admission-reconciler.ts` 与其单测的改动。
- 归因判别（P0-2 工具桥接 401 vs P0-3 Stop 卡死）：本轮红的路径完全不涉及工具桥接，日志里没有也不需要 `Tool bridge returned HTTP 401`，owner 是 `cancelled`，按任务卡规则归 P0-3。

## 一次环境缺口的记录（不计入证红）

第一次跑 `pnpm test:postgres` 时报 12 文件 / 24 测试失败，原因是 `The table public.organization does not exist in the current database`：裸命令不会自动迁移，CI 的 `db-postgres` job 在 `pnpm test:postgres` 之前先跑 `prisma migrate deploy`。补上该步骤后同一命令 51 文件 454 测试全绿（[postgres-group.txt](./postgres-group.txt)）。这属于环境前提缺失，按规则不算目标缺陷的红，也没被当作绿灯证据使用。

## 未完成项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `chain.log`：`pnpm test:worker-chain` | **已执行，红，阻塞** | 3 failed / 2 passed（5.7m）。三个失败用例是**已交付的进程级契约**，故意要求"取消/失败后 admission 必须停在 `recovering`、后继必须继续排队"，与本卡的释放前提直接矛盾。证据与四个可选方向见 [chain-conflict.txt](./chain-conflict.txt) 和 [任务卡的"阻塞"一节](../../tasks/FIX-STOP-01.md)。**没有**通过改写这三个用例来让修复变绿 |
| `chain.log`：`pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` | 未执行 | 在 worker-chain 的契约冲突裁决前执行没有意义；裁决后一并补 |
| 真模型手测截图（Stop 后发新消息正常收到回复） | **未执行** | 需要 `pnpm dev:app` + DashScope 真模型 + 浏览器操作。不用持久层测试或 scripted 夹具冒充真模型验证 |
| 回写 RT-25、RT-26 与 CANCEL-01 / #139 的 AC | 未执行 | 契约冲突未裁决前回写会把未定案的结论写进别的卡片 |
| 顶栏不再显示 Running / Queued | **未验证** | 属 API/Web 层，持久层测试观察不到；需要手测或 E2E |
| 日志里没有 `could not be proven` | **未验证** | worker-chain 的日志已捕获（见 chain-conflict.txt），但该项要在契约裁决与修复定案后再核对 |

本机环境事实（都已解决，不是缺陷）：系统没有安装 Java（`/usr/libexec/java_home` 找不到运行时），改用 Homebrew 的 openjdk@21 并只设置 `JAVA_HOME`，未改动系统配置；Docker 走 colima，testcontainers 需要显式 `DOCKER_HOST`，且必须 `TESTCONTAINERS_RYUK_DISABLED=true`，否则 Ryuk 挂载 socket 路径会以 HTTP 500 失败。

按 [AGENTS.md](../../../AGENTS.md) 第 6 条，上述缺项在本分支补齐，不另拆"补验收"任务；在补齐之前本卡不判定完成，也不建议合并。

## 修复内容摘要

详见 [任务卡的"已实施修复"](../../tasks/FIX-STOP-01.md)。一句话：owner Run 处于终态（`completed`/`failed`/`cancelled`）时，把这当作可释放的**持久事实**证明，在 `acquireSessionAdmission` 锁行后立即释放，并由 worker reconciler 在过期 sweep 之前批量释放并唤醒后继；**没有**把过期 sweep 扩大到 `recovering`，因此"仅凭过期不移交"的 RT-25 护栏保持不变。
