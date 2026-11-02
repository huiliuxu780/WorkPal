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

## 本 PR 自己的一手案例：同 SHA 四个 attempt

H3 交付 head `23f42b24521fd738b26f80cf5320cabd805deac1`，run [40547603862](https://github.com/huiliuxu780/WorkPal/actions/runs/40547603862)。因为改了 `.github/workflows/ci.yml` 与 `package.json`，选择器强制 full，`SELECT_RESULT` 里 9 个 job 全部 selected。

| attempt | 触发方式 | 结果 |
| --- | --- | --- |
| 1 | 首次 PR run | `runtime-jar` fail（`AgentScopeBackgroundProbeTest.registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession:253`，126 个 Java 测试里 1 个）→ `agentscope`/`worker-chain` skipped → `CI result` fail |
| 2 | `gh run rerun --failed` | `runtime-jar` pass，但 `agentscope` fail（`agentscope-untrusted-content.integration.test.ts` 套件级失败：`Tests 55 passed \| 6 skipped`，**0 个测试失败**，错误 `AgentScopeSessionConflictError: Session already has an active run`）→ `CI result` fail |
| 3 | `gh run rerun --failed` | `agentscope` 再次同样失败 → `CI result` fail |
| 4 | `gh run rerun`（**完整重跑**，所有 job 同一 attempt） | 全部 pass：`CI result`、`select-checks`、`docs`、`harness`、`web`、`backend`、`db-postgres`、`runtime-jar`、`agentscope`(6m20s)、`worker-chain`(5m47s)、`agent-runtime-image`；`Daily web screenshots` skipped（PR 事件不请求它，符合 H3-02 修复后的预期）。run conclusion `success` |

从这次真实经历得到的审核口径，比抽象规则更有用：

1. **同 SHA 连续两次红不能直接判 flake**，但也不能直接判回归。要先看红的形态：attempt 2/3 的 `agentscope` 是**套件级**失败且 0 个测试失败（未处理错误，不是断言回归），attempt 1 的 `runtime-jar` 是 126 个里 1 个 Java 断言。
2. **归因要用 diff 事实，不用猜测。** 本 head 相对 `a409140` 的改动分布是 `docs` 23、`scripts` 7、`.github` 2、`package.json` 1、`CONTRIBUTING.md` 1、`AGENTS.md` 1，`services/`、`packages/`、`apps/` 下**一个文件都没有**。因此 Java runtime 与 AgentScope 集成套件的失败不可能由本 head 的产品代码引起。命令：`git diff --name-only <base>..<head>`。
3. **`--failed` 局部重跑会让不同 job 来自不同 attempt。** attempt 2/3 里 `agentscope` 用的是另一次 attempt 产出的 `agent-runtime-jar-<sha>` artifact；两次局部重跑都失败、而一次完整重跑全绿，说明"只重跑失败 job"本身会引入 attempt 混合状态。**结论：判定最终 head 要用一次所有相关 job 都在同一 attempt 内完成的 run**，局部重跑的绿灯或红灯都不能单独作为最终依据。
4. **`CI result` 在这四次里都给出了正确判定**：attempt 1–3 因选中 job 失败而 fail，attempt 4 全绿而 pass；`Daily web screenshots` 在 PR 事件下 skipped 且没有把 `CI result` 拖红——这正是 H3-02 修复要保住的两侧行为，等于在真实 GitHub 上验证了它。

注意这一段是**判定口径的案例**，不是"本 PR 最终 head 的 CI 已绿"的声明。把该记录提交进分支本身就会移动 head，所以 `23f42b2` 只是案例里的那个 head。审核时必须按上面四条口径，核对**实际最终 head** 自己的 run：所有相关 job 在同一 attempt 内完成、conclusion 逐项确认、被 skipped 的 job 能用选择器输出解释。

## 追加数据点：`7b9d821` 上 agentscope 一次红、同 SHA 局部重跑转绿

run [40601388297](https://github.com/huiliuxu780/WorkPal/actions/runs/40601388297)，head `7b9d821310c7909a9852bf872e4c03a950c50275`。

| attempt | 方式 | `agentscope` | `CI result` |
| --- | --- | --- | --- |
| 1 | 首次 PR run | **fail**，51s | fail |
| 2 | `gh run rerun --failed`（只重跑失败 job） | **pass**，6m50s | **pass** |

attempt 1 的失败形态（由负责人核对原始日志后更正）：不是"0 个测试失败的启动故障"，而是**实际跑了 61 个测试、60 绿 1 红**，失败在 approval pause 场景，报 `Session already has an active run`。这个 head 的 diff 里 `services/`、`packages/`、`apps/` 一个文件都没有，所以不是本 head 的产品代码引起。

**结论口径（按负责人裁决）**：同 SHA 重跑转绿**只记为非确定性证据，不等于问题解决**；若同形态再次出现，按真实缺陷处理。同时注意 attempt 2 是 `--failed` 局部重跑，按本文前面的规则它混合了 attempt（`agentscope` 下载的 jar 来自 attempt 1），所以这次绿色**不能**单独当作最终 head 的判定依据——要看该 head 是否有一次所有相关 job 在同一 attempt 内完成的 run。GitHub 侧这个 head 的必需检查现在是绿的，审核时仍要按这四条口径读。

## 本项未做

- 没有制造"旧 head 绿、新 head 红"的受控样例。原因：需要一个真实 PR 的两次推送，而本批不授权创建新 PR；上表两个真实 head 已能证明每个 head 各自一套 check run，机制部分由 `concurrency` 配置和 GitHub 的按 commit 评估语义覆盖。
- `CI result` 成为 required check 之前，上述判定只约束审核者，不阻止合并。见 [settings-change-order.md](./settings-change-order.md)（待授权，未执行）。
