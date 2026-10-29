# PD-01 交付证据：消息级重试入口收口

- 分支：`codex/pd01-message-retry-entry`（原 PR [#100](https://github.com/huiliuxu780/WorkPal/pull/100)，未新建 PR）
- 开工基线：`37a7927`（PR #100 原 head，工作树干净）
- 合流方式：`git merge origin/main`（`origin/main @ dceae323`），未 rebase、未 force-push；冲突解决时删除被 main 等价实现的旧投影，采用 `loadExecutionSummariesForMessages`
- 产品确认：`docs/ux/prototypes/pd-01-message-retry/`（可运行原型，产品负责人 2026-10-29 确认）

## 行为收口

| 项 | 落点 |
| --- | --- |
| 初始 `threads/get` 与 `threads/messages` 同一套 message→runs 投影 | main 的 `loadExecutionSummariesForMessages`；本分支只保留一条投影 |
| 从历史页合入的旧 summary 在重试成功后失效 | `use-execution-transcript.tsx` 的 `retriedSuccessors` 覆盖层，跟随服务端 successor 状态规则 |
| 单聊和群聊都从 `sourceMessageId` 恢复关联 | E2E `manual-retry.spec.ts` 群聊 D10 用例 + PG 投影测试 |
| 有卡 Run 只显示卡内 Retry、denied 不显示入口 | `use-execution-transcript` 单测 |
| 点击复用 `runs/retry` + 稳定 `clientNonce` + `retryOfRunId` + `ExternalEffect.operationId` | 复用既有 `retryRun`，未新增发送路径 |
| 入口不进入 Attention / 通知 / `task_status` | 消息操作区独立渲染，未接入执行卡或 Attention 投影 |
| journey 54 明确 separate-answer 语义 | `packages/testkit/src/journeys.test.ts` |

## P1 红绿（初始快照投影）

- 回归用例：`apps/api/src/thread-execution-snapshot-window.postgres.test.ts`
- 场景：触发消息留在首屏，其两个 cardless cancelled Run 被 55 个更晚的 terminal Run 挤出 50 条窗口；`threads/get` 仍须返回两个 Run 且 `manualRetry.allowed=true`。
- 红：`p1-red.txt` —— 同一用例在修复前 head `37a7927` 失败：`expected [] to deeply equal [run-a, run-b]`（快照完全不含该消息的 Run）。
- 绿：`p1-green.txt` —— 最终 head 通过。
- PostgreSQL 16 实跑，`VERIFY_DATABASE=1`，未跳过。

## P2 红绿（分页旧 summary 成功后失效）

- 回归用例：`apps/web/src/pages/shell-execution-transcript.test.tsx` › "drops a stale paged retry entry after success…"
- 场景：入口来自历史分页，刷新后的快照不含前驱 Run（合并保留旧 summary，`allowed=true`）；重试成功后入口必须立即消失，并在本地已知 successor 失败/取消时按服务端规则恢复。
- 红：`p2-red.txt` —— 修复前 hook 下失败：`expected … to have a length of +0 but got 1`。
- 绿：`p2-green.txt` —— 最终 head 通过。

## 实际页面证据（真实 App + 脚本化 Agent）

由 `apps/web/e2e/manual-retry.spec.ts` 在真实页面截取（`WORKPAL_PD01_EVIDENCE_DIR` 控制，CI 不写库内文件）：

| 文件 | 内容 |
| --- | --- |
| `desktop-hover.png` | 桌面 hover 消息操作区，无卡 cancelled Run 的 Retry |
| `desktop-keyboard-focus.png` | Tab 键盘焦点环落在 Retry |
| `mobile-390.png` / `mobile-375.png` | 390 / 375 宽度 |
| `desktop-dark.png` | 深色主题 |
| `retry-entry-gone.png` | 重试成功后入口立即消失，successor 显示 Running |
| `group-desktop-two-entries.png` | 群聊一条消息上两个可区分入口（Planner / Coder） |
| `db-facts.txt` | 数据库事实：前驱唯一 successor、successor 继承 `sourceMessageId`、群聊一条消息 legacy `runId` 仅首个而 `sourceMessageId` 关联 2 个 Bot |
| `p1-*.txt` / `p2-*.txt` | 红绿记录 |
| `integration*.txt` / `postgres-gate.txt` / `gates.txt` | 门禁原始输出 |

## 本地门禁

（见 `gates.txt` 原始输出）

## PR #100 复审线程

- P1（`apps/api/src/thread-target.ts:884`）：已由 main 的集中投影修复，并新增窗口回归用例；回复后未 Resolve。
- P2（`apps/web/src/pages/shell/use-execution-transcript.tsx`）：已修复并带红绿；回复后未 Resolve。
- review summary：已回复。
