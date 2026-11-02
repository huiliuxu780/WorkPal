# H3-02：CI result 判定核查

单元：H3。基线：`main @ a409140`。日期：2026-10-28。

## 核查对象

`CI result` 是固定名称的汇总 job（`.github/workflows/ci.yml` → `ci-result`，脚本 `scripts/ci/verify-result.mjs`）。要核查的判定：选中检查、失败、cancelled、意外 skipped、docs-only、schedule 专属 job、以及每次新 head。

## 已确认并修复的缺陷

**`Daily web screenshots`（job id `visual-web`）不在 `ci-result` 的 `needs` 里，也不在 `ALL_JOBS` 里。**

后果：schedule（每日 `17 3 * * *`）和 `workflow_dispatch mode=visual` 是唯一会运行该 job 的事件。它失败、被取消或还在运行时，`CI result` 都会成功并且不会等它。H2（PR #138）把每日视觉检查迁进 `ci.yml` 时，只迁了 job，没有把它接进汇总。

真实运行佐证（未修复前的行为）：schedule run [40478390317](https://github.com/huiliuxu780/WorkPal/actions/runs/40478390317)（`main @ 91c92e36`，2026-10-27）中 `Daily web screenshots` 09:07:37→09:09:16 成功，`CI result` 09:25:06→09:25:17 成功；两者之间没有依赖关系，`CI result` 的 `needs` 列表里没有 `visual-web`。本次刚好该 job 成功，所以缺陷没有外显——但它对失败同样不敏感。

修复（`.github/workflows/ci.yml` + `scripts/ci/verify-result.mjs`）：

- `visual-web` 加入 `ci-result` 的 `needs`，并传 `RESULT_VISUAL_WEB`。
- 新增 `VISUAL_WEB_REQUIRED`，只在该 run 真的请求了每日视觉 job 时为 `true`（`schedule` 或 `workflow_dispatch mode=visual`），表达式在 `env:` 里求值，不拼进 shell。
- 汇总器新增 `requiredConditional`：被请求时必须 `success`；未被请求时保持原有语义（skip 不算失败，但 failure/cancelled 仍然失败）。

这样"所需检查没有运行不能汇总为成功"和"无关 schedule skip 不误判"同时成立。

## 先红后绿

同一个回归用例（`scripts/ci/verify-result.test.mjs` 里新增的 `verifyResult scheduled visual job`），只切换被测实现：

| 阶段 | 实现 | 命令 | 结果 |
| --- | --- | --- | --- |
| red | `git show HEAD:scripts/ci/verify-result.mjs`（基线 `a409140`） | `node --test scripts/ci/verify-result.test.mjs` | exit=1，`# pass 13 / # fail 2`，失败项为 `verifyResult scheduled visual job` — [RED-visual-web-baseline.txt](./RED-visual-web-baseline.txt) |
| green | H3 工作树修复版 | 同一命令 | exit=0，`# tests 15 / # pass 15 / # fail 0` — [GREEN-visual-web-fixed.txt](./GREEN-visual-web-fixed.txt) |

红色输出确实由目标缺陷引起（汇总器忽略 `requiredConditional`，被请求的 visual job 失败/跳过仍返回 ok），不是环境错误；绿色没有放宽断言、没有 skip、没有加 retry。

## 判定矩阵（真实运行）

- 选择器：docs-only / web / backend / postgres 测试 / worker-chain / CI 文件强制 full / `mode=full`，各自实际选中与跳过的 job — [selection-matrix.txt](./selection-matrix.txt)
- 汇总器：9 个 CLI 用例，覆盖成功、failure、cancelled、意外 skipped、选择器自身失败、未请求的 visual skip、被请求的 visual failure/skip/success — [aggregator-cli.txt](./aggregator-cli.txt)
- 单元回归：`pnpm test:ci-select` 120/120 通过（修复前 100 项，新增 14 项 hygiene + 6 项 visual 判定）

## 未在本项处理

- 每次新 head 的判定属于 GitHub 侧语义，见 [sha-checks.md](../sha-checks.md)。仓库内无法强制"只看最终 head"，只能靠并发取消 + 审核规则；`CI result` 成为 required check 后才真正阻止合并，见 [settings-change-order.md](../settings-change-order.md)（待授权）。
- 选择器 `full()` 在 CI 文件变更时返回 `mode: "selective"` 但选中全部 job。这是显示口径问题，不影响判定（所有 job 都被要求 success），本次未改；`scripts/ci/select-checks.mjs` 由 PR #147 占用，H3 不改该文件。
