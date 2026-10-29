# PD-01 交付证据：消息级重试入口收口

- 分支：`codex/pd01-message-retry-entry`（原 PR [#100](https://github.com/huiliuxu780/WorkPal/pull/100)，未新建 PR）
- 开工基线：`37a7927`（PR #100 原 head，工作树干净）
- 合流：`git merge origin/main`（`origin/main @ dceae323`），未 rebase、未 force-push
- 代码 head：`ae665b0`（其后只有本目录证据与任务卡文档提交）
- 产品确认：`docs/ux/prototypes/pd-01-message-retry/`（可运行原型，产品负责人 2026-10-29 确认）

## 行为收口

| 项 | 落点 |
| --- | --- |
| 初始 `threads/get` 与 `threads/messages` 同一套 message→runs 投影 | 采用 main 的 `loadExecutionSummariesForMessages`；删除分支原 cancelled-only 旧投影，只保留一套 |
| 从历史页合入的旧 summary 在重试成功后失效 | `use-execution-transcript.tsx` 的 `retriedSuccessors` 覆盖层，按服务端 successor 状态规则隐藏/恢复 |
| 单聊和群聊都从 `sourceMessageId` 恢复关联 | 群聊 E2E D10 + PostgreSQL 投影测试（main 已有）+ 新窗口回归 |
| 有卡 Run 只显示卡内 Retry、denied 不显示入口 | `shell-execution-transcript.test.tsx` 单测 |
| 点击复用 `runs/retry` + 稳定 `clientNonce` + `retryOfRunId` + `ExternalEffect.operationId` | 复用既有 `retryRun`；E2E 断言前驱唯一 successor |
| 入口不进入 Attention / 通知 / `task_status` | 只渲染在消息操作区，未接入执行卡、Attention 或状态投影 |
| journey 54 separate-answer 语义 | `packages/testkit/src/journeys.test.ts`：普通多 mention 单 owner；显式“Reply separately.”才是多 owner；steering replay 轮带显式语义 |

## P1 红绿（初始快照投影）

- 回归用例：`apps/api/src/thread-execution-snapshot-window.postgres.test.ts`
- 场景：触发消息留在首屏，其两个 cardless cancelled Run 被 55 个更晚的 terminal Run 挤出 50 条窗口；`threads/get` 仍须返回两个 Run 且 `manualRetry.allowed=true`。
- 红：`p1-red.txt` —— 同一文件在修复前 head `37a7927` 实跑失败：`expected [] to deeply equal [run-a, run-b]`（快照完全不含该消息的 Run）。
- 绿：`p1-green.txt` —— 最终 head 通过。
- PostgreSQL 16 实跑，`VERIFY_DATABASE=1`，未跳过。

## P2 红绿（分页旧 summary 成功后失效）

- 回归用例：`apps/web/src/pages/shell-execution-transcript.test.tsx` › "drops a stale paged retry entry after success…"
- 场景：入口来自历史分页，刷新快照不含前驱 Run（合并保留旧 summary，`allowed=true`）；重试成功后入口必须立即消失；本地已知 successor 失败/取消时按服务端规则恢复（再次点击只回放该 successor，不产生第二个）。
- 红：`p2-red.txt` —— 同一用例在修复前 hook 下失败：`expected … to have a length of +0 but got 1`。
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
| `group-desktop-two-entries.png` | 群聊一条消息上两个可区分入口（Retry Chief / Retry Writer） |
| `db-facts.txt` | 数据库事实：前驱唯一 successor、successor 继承 `sourceMessageId`、群聊一条消息 legacy `runId` 仅首个而 `sourceMessageId` 关联 2 个 Bot |

## 本地门禁（原始输出见各 txt）

| 门禁 | 结果 |
| --- | --- |
| `pnpm lint` | 0 error（76 warning、7 info 均为 main 既有） |
| `pnpm check` | turbo 18/18 任务通过 |
| `pnpm test:unit` | 461 文件，5557 passed，2 skipped |
| `pnpm test:postgres`（真实 PostgreSQL 16） | 首跑 `memory-facts` 1 例失败；同 SHA 重跑 54 文件 / 477 tests 全绿（`postgres-gate.txt`） |
| `pnpm test:integration`（JDK 21 + PG16 容器） | journeys 41/41 绿（`integration.txt`）；`executor-lifecycle` 4 例与 `bot-secrets` 1 例的失败在 `origin/main dceae32` 上完全一致，属既有基线（`integration-main-baseline-*.txt`）；其余 suite 全绿（`integration-rest.txt`） |
| Web build | `vite build` 成功 |
| Gate-off E2E（manual-retry / execution-card / message-quote / group-chats） | 27 passed（`e2e-gates.txt`） |
| Gate-on E2E（message-group / group-membership） | 4 passed（同上） |
| `manual-retry.spec.ts` 最终 head 重跑 | 4 passed，22.8s，并生成本目录截图 |

`message-hover-actions.spec.ts` 在本地与 `origin/main` 上同样失败（rail 静止态 opacity），记录于 `e2e-main-baseline-hover.txt`，不属于本单元改动。

## PR #100 复审线程

- P1（`apps/api/src/thread-target.ts:884`）：初始快照改由 main 的集中投影覆盖，并新增窗口回归用例；已回复，未 Resolve。
- P2（`apps/web/src/pages/shell/use-execution-transcript.tsx`）：已修复并带红绿；已回复，未 Resolve。
- P2（`apps/web/src/pages/Shell.tsx:6855`）：多 Bot 重试入口现在同时以 `aria-label` 和原型约定的原生 tooltip 显示 Bot 名；Web 单测 798/798、`manual-retry.spec.ts` 4/4；待回复，未 Resolve。
- review summary：已回复。
