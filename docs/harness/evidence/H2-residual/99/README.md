# H2-99：DeliveryRecord 结算竞态

单元：H2-99 投递结算竞态。分支 `codex/h2-99-delivery-settle-barrier`，独立 worktree，基线 `origin/main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`。
提交：`d9131c5`（屏障 + 旧单次读取断言，用该提交证红），随后一个提交改为释放屏障后 poll 权威事实（证绿）。本目录随绿提交纳入。
执行日期：2026-10-28。

环境：macOS arm64；Node v22.23.3；仓库锁定 pnpm；`pnpm install --frozen-lockfile` + `pnpm --filter @rakazo/db generate` 后执行。E2E 走 harness：testcontainers PostgreSQL 16（colima）、`--runtime=agentscope`（真实 Java Runtime，JDK 21 在 PATH）、模型侧用仓库既有 `startModelEmulator` 夹具。命令：

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
export PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH
pnpm test:e2e --runtime=agentscope --spec=budget-acceptance.spec.ts --grep="routine budget breach"
```

## 1. 竞态与落点

生产顺序（`packages/adapters/src/background-job-handlers.ts:65-67`）：

```ts
"run.continue": async (payload) => {
  await deps.executor.continueRun(payload.runId, deps.workerId);
  await settleDeliveryRun(deps, payload.runId);
```

`continueRun` 返回时 delivery Run 已完成、消息已持久化；`settleDeliveryRun` 随后的 UPDATE 才会把 DeliveryRecord 从 `claimed` 翻成 `sent`。旧测试在 transcript 可见后**单次读取**记录并要求 `sent`，命中这个窗口就失败；靠重复运行只会碰运气。

旧 issue 指向的 worker-chain 落点已经被 RT-25 改写，现存断言位于 `apps/web/e2e/budget-acceptance.spec.ts` 的 “routine budget breach fails the Run and queues one delivery behind recovering admission”。本单元不恢复旧 worker-chain 场景，也不改生产投递顺序、admission 或事务语义。

## 2. 可控事务屏障

同一用例内：

1. 在既有 poll 已确认 `claimed` 且 `deliveryRunId` 已绑定时，用独立连接 `BEGIN` 并 `SELECT … FROM delivery_records WHERE "runId" = $1 FOR UPDATE` 锁住该行（`holdClaimedDeliveryRecord`）。
2. 继续 owner Run；delivery Run 完成，transcript 可见。
3. 屏障未释放时断言记录仍为 `claimed`、`deliveredAt` 为空、绑定同一 delivery Run、`delivery.sent` 为 0。
4. `ROLLBACK` 释放屏障（不改任何事实）。
5. poll 权威组合直到完整结算。

注意 `deliveredAt` 的写入时刻：Prisma 在构造被锁阻塞的 UPDATE 时就生成时间戳，所以它是屏障释放前的时间（`2026-10-28T08:45:54.948Z`），但记录在释放前一直是 `claimed`（见 timeline 前两条）。这是锁阻塞的结果，不是结算提前。

## 3. 先红后绿（同一用例、同一场景）

| 阶段 | 提交 | 退出码 | 观察 | 证据 |
| --- | --- | --- | --- | --- |
| 红 | `d9131c5` | 1 | 屏障持有时单次读取：`Expected: "sent"` / `Received: "claimed"` | [red.txt](./red.txt) |
| 绿 | 本提交 | 0 | `1 passed (1.0m)`，释放后权威组合成立 | [green.txt](./green.txt) |

红由目标缺陷（结算窗口）引起：同一用例、同一环境，只把断言换成释放后 poll 即转绿。没有固定 sleep、没有接受 `claimed | sent`、没有 `repeat-each` 或重跑碰运气。

## 4. 权威组合与 exactly-once

[timeline.json](./timeline.json) 为绿跑内实测快照（用例内直接查库）：

| 阶段 | 记录状态 | delivery.sent | bot 消息 | delivery Runs |
| --- | --- | --- | --- | --- |
| barrier-held | claimed | 0 | 0 | 1 |
| run-completed-transcript-visible | claimed | 0 | 1 | 1 |
| settled | sent | 1 | 1 | 1 |
| after-settle-replay（再调 settle 2 次） | sent | 1 | 1 | 1 |

最终断言同时要求：`status=sent`、`deliveredAt != null`、`deliveryRunId` 绑定该 delivery Run、`delivery.sent` 恰 1、用户可见消息恰 1、delivery Run 恰 1；随后对同一 delivery Run 再调用两次 `settleDeliveryRun`，元组必须与结算时完全一致（[exactly-once.txt](./exactly-once.txt)）。

## 5. 未执行项

- 最终 head 的 CI 结果在推送后产出，链接记录在 PR/交付说明中，本文件不预写。
