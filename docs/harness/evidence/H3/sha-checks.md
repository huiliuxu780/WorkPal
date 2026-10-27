# H3-04：只认最终交付 head 的 CI 结果

单元：H3。日期：2026-10-28。核查对象：PR [#147](https://github.com/huiliuxu780/WorkPal/pull/147) 的两个真实 head。

## 为什么用真实 PR 而不是构造样例

任务要求"比较新旧 head 的真实 CI 结果"。#147 在同一交付单元里连续推了多个 head，且任务书里固定的核对 head（`7e463570`）已经不是当前 head，正好是这条规则要防的情况。

## 实测：每个 head 有自己独立的一套 check run

命令：

```bash
gh api "repos/{owner}/{repo}/commits/<sha>/check-runs?per_page=100" \
  --jq '.check_runs[] | [.name,.status,.conclusion,.completed_at] | @tsv'
gh run list --commit <sha> --json databaseId,event,status,conclusion,createdAt
```

| head | run | 创建时间（UTC） | 结论 | `CI result` |
| --- | --- | --- | --- | --- |
| `7e463570f5f86ee9e792a65b509ee41fe4a8c13e`（任务书里的旧核对 head） | [40526573873](https://github.com/huiliuxu780/WorkPal/actions/runs/40526573873) | 2026-10-27T14:59:54Z | success | success @ 15:27:37Z |
| `d15cc7efb8db420c2a9509e307c41ec0c5f1e93c`（本批开工时的实际 head） | [40537649951](https://github.com/huiliuxu780/WorkPal/actions/runs/40537649951) | 2026-10-27T16:06:35Z | success | success @ 16:35:58Z |

两个 head 各自有完整 12 个 check run（`select-checks`、`docs`、`harness`、`web`、`backend`、`db-postgres`、`runtime-jar`、`agentscope`、`worker-chain`、`agent-runtime-image`、`Daily web screenshots`、`CI result`）。`Daily web screenshots` 在两个 head 上都是 `skipped`——PR 事件不请求它，这正是 H3-02 修复后仍然必须保持的行为。

完整逐 job 结论见 [checks-7e46357.tsv](./checks-7e46357.tsv) 与 [checks-d15cc7e.tsv](./checks-d15cc7e.tsv)。

## 时间线上的一个真实陷阱

2026-10-28 00:12（本地）读 `gh pr checks 147` 时，`agentscope` 与 `worker-chain` 显示 `pending`；同一 run 在 16:35:58Z 才整体完成。也就是说：

- **在途不等于失败，也不等于通过。** 那一刻既不能写"CI 全绿"，也不能写"CI 红"。
- 只有当该 head 的 run `status=completed` 且相关 job 都有 `conclusion` 时，才能引用它。
- 相关 job 被 `skipped` 时，要按 [H3-02](./ci-result/README.md) 的语义判断是"未选中"还是"该跑没跑"。

## 机制：为什么旧 head 的绿灯不会顶替新 head

1. `ci.yml` 的 `concurrency.group` 对 PR 是 `pr-<number>`，`cancel-in-progress: true`。同一 PR 推新 head 时，上一个 run 被取消，不会留下一个"更晚完成的旧 head 绿灯"。
2. GitHub 的 required status check 按 commit 评估：新 head 没有自己的 `CI result`，就没有可通过的必需检查。
3. `main` push、`schedule`、`workflow_dispatch` 用唯一并发组，不被 PR 更新取消，因此每日全量结果和 PR 结果不会互相覆盖。

## 审核口径（写进 PR 模板与流程文档）

- 引用的必须是**最终交付 head** 的 run URL，并核对该 run 的 `status=completed`。
- 逐项确认相关 job 的 `conclusion`；`skipped` 要能用选择器输出解释（见 [selection-matrix.txt](./ci-result/selection-matrix.txt)）。
- 同一 SHA 的多个 attempt 只认最终 attempt。#147 分支记录了 `runtime-jar` 的既有 flake（`docs/roundtable/audits/evidence/runtime-jar-flake/`，同 SHA attempt 1–5 红、attempt 6 绿），说明 attempt 序号必须一起读。
- 修复推送后，旧 head 的证据（截图、日志、red/green）如果覆盖的行为已改变，必须重跑，不能沿用。

## 本项未做

- 没有制造"旧 head 绿、新 head 红"的受控样例。原因：需要一个真实 PR 的两次推送，而本批不授权创建新 PR；上表两个真实 head 已能证明每个 head 各自一套 check run，机制部分由 `concurrency` 配置和 GitHub 的按 commit 评估语义覆盖。
- `CI result` 成为 required check 之前，上述判定只约束审核者，不阻止合并。见 [settings-change-order.md](./settings-change-order.md)（待授权，未执行）。
