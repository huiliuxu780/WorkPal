# VERIFY-01 补齐取消、排队和群路由验证

状态：`in-progress`

## 开工记录

- 分支：`codex/verify-lifecycle-concurrency`，一个验证 PR。
- 基线：`main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`（2026-10-28 用 `git ls-remote origin main` 核对）。
- 实施者与提交整合者：第一批的唯一 coding agent；审核者由负责人指定，本卡不虚构人名。
- 范围新增：2026-10-28 由负责人补入单 Bot 单会话基础取消（S1–S4）、P0-2 与 P0-3 的判别规则，以及验收第 6 条；修复拆到 [FIX-STOP-01](./FIX-STOP-01.md)。
- 共享文件：`scripts/testing/test-inventory.mjs`、`packages/testkit/src/cli/worker-chain.ts` 等由第一批 README 指定 owner；新增测试需要登记时按 H3 证据里记录的方式处理，不与 PR #147 并发写同一区域。
- 环境：真实 PostgreSQL 用一次性库，不接生产库；进程链用 `pnpm test:worker-chain`；Java 用 `pnpm test:agentscope`。

## 目标

补齐 2026-10-24 形式化扫描明确没有覆盖的边界。未覆盖不等于存在 bug。本任务先验证，再根据反例创建独立修复任务；没有反例时提交可重复的通过证据。

输入报告为外部 `myagent/docs/WorkPal-formal/SCAN-REPORT.md`，SHA-256 `004950fcdef44df66703112b052e0c70581f3d0b0e07ad82b6e6d95babe97458`。

## 覆盖范围

- 子 Run 树的级联取消，包括 `cancelDescendantsNow`、跨会话 child 和迟到结果。
- `waiting_takeover` 的停止、超时、lease 丢失、steering 和 session admission。
- 一条消息派给多个 Bot 的 multi-dispatch，包括部分失败和去重。
- messaging 与 app steering 分批，以及两条以上追加消息。
- 第一轮扫描留下的「同一 Bot 同一 session 同时跑两轮」疑点。RT-25 已在 `main` 引入 session admission lease，所以必须从当前实现重查，不能照抄旧结论。
- 真实时钟边界：1 秒事件检查、60 秒心跳和 5 分钟 lease 回收。用可控时钟与进程级故障测试补足无时间模型的限制。
- **单 Bot 单会话的基础取消**（已知反例，来自 2026-10-27 QA 的 P0-3）。这是最常见的用户路径：没有子 Run，没有接管，也没有多 Bot。必须单独覆盖，不能用复杂场景的通过结果代替。
  - **S1 空闲中取消**：Bot 生成长回复，用户点 Stop，Run 变成 `cancelled`。同一会话再发一条新消息，新 Run 必须开始执行。
  - **S2 带追加消息时取消**：生成中先追加 2 条 steering 消息，再点 Stop，然后发新消息。追加的消息要么被处理，要么明确丢弃，同时不能把会话卡住。
  - **S3 Stop 正好撞上终态**：Run 已经 `completed` 或 `failed` 时点 Stop。会话照样能继续用，也不会多出一个 `cancelled` 状态。
  - **S4 Stop 撞上 worker 重启或 lease 过期**：admission 处于 `recovering`、owner Run 已经是终态 `cancelled` 时，必须有一条能证明、能释放的路径。否则只能靠 5 分钟 lease 回收兜底，而且兜底也必须真的生效。

  生产代码路径（按嫌疑大小排序，需要从当前 `main` 重查，不能照抄行号）：

  1. `packages/db/src/session-admission.ts`：cancel 之后有没有调用 `releaseSessionAdmission` 或 `completeSessionAdmission`，有没有把 `nextRunId` 交给下一个 Run。
  2. `packages/adapters/src/executor.ts` 约 1277–1460 行，即 RT-26 的 `recovering` 证明：owner 已经是终态 `cancelled` 时，证明会返回 false，日志里出现 `recovering session admission could not be proven`，会话就停住了。
  3. `packages/adapters/src/executor.ts` 约 1674–1712 行：终态分支是不是只处理了 `completed`、`failed` 和预算失败，没有处理 `cancelled`。
  4. `apps/worker/src/session-admission-reconciler.ts`：对终态 owner 的 sweep（`session-admission.ts:167`/`:834`，条件是 `status IN ('completed','failed','cancelled')`）是不是真的会跑，跑完之后有没有把排队的 Run 重新入队。

  每个场景都必须断言：

  - cancel 之后，这个会话没有 `state IN ('owned','recovering')` 且 `ownerRunId` 指向已终态 Run 的 admission。
  - 新消息对应的 Run 在 1 个事件检查周期内离开 `queued`。用可控时钟验证，不用 sleep。
  - 顶栏不再显示 Running 或 Queued。
  - 日志里没有 `could not be proven`。

  测试形式：真实 PostgreSQL 测试覆盖 S1–S4。S1 和 S2 另做一次 `pnpm dev:app` 真模型手测，留截图，以及 Run 和 admission 两张表的查询结果。
- **区分「Stop 卡死」和「工具桥接 401 卡死」**（P0-2 与 P0-3）。两者表面现象一样，都是会话停在 Queued。每次复现都要记录 Run 状态、admission 状态和 worker 日志：
  - 日志里有 `Tool bridge returned HTTP 401` 的，归 P0-2。
  - 没有 401、但 owner 已经是 `cancelled` 的，归 P0-3。
  - 不允许只看界面就下结论。

## 插话策略

当前产品契约是方案 A：用户先点名 X，X 排队时再点名 Y，X 和 Y 都可以回复。RT-24 已写明「点名新 Agent 不取消当前说话者或后台任务」。这不是 bug。

本任务为方案 A 增加明确测试。除非产品负责人另行批准方案 B，否则不得把第二条消息解释为对 X 的隐式取消。若未来选择 B，必须先补原型中的取消提示与恢复路径，再修改路由代码。

## 验收

1. 每个范围都有模型性质、对应的生产代码路径和至少一个真实 PostgreSQL 或进程级测试。
2. 变异检查证明测试能发现缺失的 fence、错误的级联范围、steering 丢失和重复 dispatch。
3. 方案 A 的测试证明 X 与 Y 的归属独立，且每条消息只有一个负责 Bot。
4. 任一新反例单独记录事实、复现条件、影响和修复边界；不得把「模型可达」写成「生产已发生」。
5. 验证结果回写 RT-19、RT-24、RT-27 和 RT-30 的对应 AC 与场景，不新建第二套状态表。
6. S1–S4 每个都有真实 PostgreSQL 测试，在修复前的 `main` 上至少有一个是红的，作为反例证据。修复本身不在 VERIFY-01 里做，交给 [FIX-STOP-01](./FIX-STOP-01.md)；VERIFY-01 只负责留下反例和测试。
