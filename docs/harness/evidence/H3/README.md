# H3 证据索引

单元：H3 交付门禁与规则落库。分支 `codex/harness-delivery-gates`，一个 PR。
基线：`main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`。工作树：独立 worktree（主 checkout 之外），开工时干净，只带入两份未提交的规则文件作为交接输入。
执行日期：2026-10-28。环境：macOS arm64，Node v24.18.0，pnpm 9.15.0（仓库锁定），`pnpm install` 在本 worktree 完成后执行所有命令。
任务书：`docs/tasks/first-batch-20261027/H3.md` 与同目录 `README.md`。这两份是派发输入，截至本次交付**尚未纳入 git**（干净 checkout 里不存在），因此这里用路径而不是链接；缺口已记录在 [rule-diff.md](./rule-diff.md) §3。

本索引把每个 H3-xx 映射到实际文件、命令、环境与结果。交付 head SHA 与最终 CI 见 §7。

| 场景 | 结论 | 证据 | 命令与环境 |
| --- | --- | --- | --- |
| H3-01 规则一致性与合并记录回写 | 已执行；20 处冲突在原位置修正，另有 3 处明确未改并写明依赖 | [rule-diff.md](./rule-diff.md) | 逐文件 `diff` / GitHub API 核对 PR 状态；`shasum` 核对交接输入 |
| H3-02 CI result 判定 | 已执行；发现并修复 1 个真实缺陷（schedule 专属 job 不在汇总内），同一用例先红后绿 | [ci-result/README.md](./ci-result/README.md)、[RED-visual-web-baseline.txt](./ci-result/RED-visual-web-baseline.txt)、[GREEN-visual-web-fixed.txt](./ci-result/GREEN-visual-web-fixed.txt)、[selection-matrix.txt](./ci-result/selection-matrix.txt)、[aggregator-cli.txt](./ci-result/aggregator-cli.txt) | `node --test scripts/ci/verify-result.test.mjs`；`node scripts/ci/select-checks.mjs --files …`；`env … node scripts/ci/verify-result.mjs`；`pnpm test:ci-select` 120/120 |
| H3-03 受限文件与大文件门禁 | 已执行；CI 等价门禁 + 可选本地 hook，临时 Git 仓库夹具覆盖三类文件 | [hygiene/runs.txt](./hygiene/runs.txt)、[check-repo-hygiene.test.mjs](../../../../scripts/ci/check-repo-hygiene.test.mjs) | `node --test scripts/ci/check-repo-hygiene.test.mjs` 14/14；`node scripts/ci/check-repo-hygiene.mjs`（本 worktree exit 0，主 checkout 正向对照 exit 1 并列出 7 个嵌套 worktree） |
| H3-04 只认最终 head | 已执行；用 #147 两个真实 head 的完整 check run 对比 | [sha-checks.md](./sha-checks.md)、[checks-7e46357.tsv](./checks-7e46357.tsv)、[checks-d15cc7e.tsv](./checks-d15cc7e.tsv) | `gh api repos/{owner}/{repo}/commits/<sha>/check-runs`；`gh run list --commit <sha>` |
| H3-05 排除审计 | 已执行；188 项逐项枚举分类，五组原型路径实测承重 | [exclusion-audit.md](./exclusion-audit.md)、[exclusion-audit.json](./exclusion-audit.json) | 临时解除 `biome.json` override 后 `pnpm exec biome check . --max-diagnostics=5000 --reporter=json`，测完还原（`git diff biome.json` 为空） |
| H3-06 GitHub 设置 | **待授权，未执行**；变更单已编制，含当前值实测证据、目标值、旁路主体、影响范围、回滚与验证方法 | [settings-change-order.md](./settings-change-order.md)、[settings/settings-before.json](./settings/settings-before.json) | 只读查询：`gh api …/branches/main/protection`（404）、`…/rulesets`（`[]`）、`…/rules/branches/main`（`[]`）。**没有任何写操作** |

## 1. 实际改动清单

代码与配置：

- `.github/workflows/ci.yml`：`select-checks` job 新增仓库卫生检查步骤，分类器测试改为 glob（避免新增测试忘记登记）；`ci-result` 的 `needs` 加入 `visual-web`，新增 `RESULT_VISUAL_WEB` 与 `VISUAL_WEB_REQUIRED`（表达式在 `env:` 求值，不拼进 shell）。
- `scripts/ci/verify-result.mjs`：新增 `requiredConditional`，schedule 专属 job 被请求时必须成功，未被请求时 skip 不算失败、failure/cancelled 仍算失败。
- `scripts/ci/verify-result.test.mjs`：新增选择矩阵与 schedule 视觉 job 的回归。
- `scripts/ci/check-repo-hygiene.mjs`、`scripts/ci/check-repo-hygiene.test.mjs`（新）。
- `scripts/hooks/pre-commit`、`scripts/hooks/install.mjs`（新）。
- `package.json`：新增 `repo:hygiene`、`hooks:install`。
- `scripts/testing/test-inventory.mjs`：把新增的 `scripts/ci/check-repo-hygiene.test.mjs` 登记进 `NODE_TEST_CI`（1 行，冲突面见 §4）。
- `.github/pull_request_template.md`（新）。

文档：

- `AGENTS.md`、`docs/development-workflow.md`（迁入的规范输入，含 §2 第 1、2 项修正）。
- `CONTRIBUTING.md`、`docs/ci01-selective-checks.md`、`docs/agent-verification.md`。
- `docs/tasks/HARNESS-01.md`、`docs/tasks/CI-01.md`、`docs/tasks/UX-01BC-start-prompt.md`、`docs/tasks/AG-03-04-start-prompt.md`、`docs/tasks/MR-01-start-prompt.md`。
- `docs/harness/evidence/H3/`（本目录）。

**未改**：`biome.json`（审计后决定不机械改写）、`scripts/ci/select-checks.mjs`、`packages/testkit/src/cli/harness.ts`、`packages/testkit/src/cli/e2e-spec-selection.ts`（PR #147 占用）、`docs/next-work-roadmap.md` 与 `docs/tasks/EFFECT-01.md`（PR #136 占用）。

## 2. 未执行项

| 项 | 状态 | 缺什么 |
| --- | --- | --- |
| H3-06 设置执行与受控失败验证 | 待授权，未执行 | 负责人对变更单（含 `enforce_admins` 取值）的明确批准；批准后才能执行 `gh api -X PUT` 并开验证 PR |
| 188 项排除的实际收口 | 未执行 | G-C 的 168 个文件需等 #147 合入（3 个文件重叠）并作为独立可回退单元；G-D 的 20 个文件需逐条代码决定；G-A/G-B 的永久排除需负责人批准 |
| roadmap 合并记录回写 | 待依赖 | PR #136 占用了同样的行；需其合入或关闭 |
| `skills-lock.json` 生成/校验入口（原卡 H3 步骤 9） | 未核查 | 不在第一批 H3 任务书的六个步骤内 |
| 真实 GitHub 上的受控失败 run（H3-02 的端到端） | 未执行 | 需要推送本分支后由 CI 产生；本地已用同一脚本的 CLI 与单元回归覆盖判定逻辑。本 PR 自身的 CI run 会提供 `select-checks` 含卫生步骤的真实结果 |

## 3. bug 的先红后绿

只有一个修复被判定为缺陷（H3-02 的 `visual-web` 未纳入汇总）。同一回归用例 `scripts/ci/verify-result.test.mjs` → `verifyResult scheduled visual job`：

- red：把 `scripts/ci/verify-result.mjs` 换回 `git show HEAD:…`（基线 `a409140`），exit=1，`# pass 13 / # fail 2` — [ci-result/RED-visual-web-baseline.txt](./ci-result/RED-visual-web-baseline.txt)
- green：换回修复版，同一命令 exit=0，`# tests 15 / # pass 15 / # fail 0` — [ci-result/GREEN-visual-web-fixed.txt](./ci-result/GREEN-visual-web-fixed.txt)

红色由目标缺陷引起（汇总器忽略 `requiredConditional`），不是环境错误。没有 skip、没有 `it.fails`、没有放宽断言、没有增加 retry。

H3-03 与 H3-01 是新增门禁与文档修正，不是 bug 修复，因此没有 red/green；H3-03 的正向对照（主 checkout 报 7 个嵌套 worktree、exit 1）证明门禁真的会拦，不是空跑。

## 4. 共享文件与并行

按第一批 README，H3 不改 #147 占用的 CI/inventory/harness 文件。实际处理：

| 文件 | 处理 |
| --- | --- |
| `scripts/ci/select-checks.mjs` | **未改**。`verify-result.mjs` 只 import `ALL_JOBS` |
| `packages/testkit/src/cli/harness.ts`、`packages/testkit/src/cli/e2e-spec-selection.ts` | **未改** |
| `scripts/testing/test-inventory.mjs` | **改了 1 行**：新增的 `scripts/ci/check-repo-hygiene.test.mjs` 必须在 `NODE_TEST_CI` 里显式登记，否则 `pnpm test:inventory` 报 `node:test file requires an explicit classification` 并让 `harness` job 失败。冲突面已核对：#147 对该文件的唯一改动在 `POSTGRES_ONLY`（约 209 行，新增 `packages/db/src/attention.postgres.test.ts`），本次改动在 `NODE_TEST_CI`（约 283 行），相隔 74 行，3 行上下文下可干净合并。本批由同一实施者作为两个单元的唯一提交整合者，不存在并发写入 |
| `.github/workflows/ci.yml`、`package.json` | 不在 #147 的文件清单内（用 `gh pr view 147 --json files` 核对）。两者都会让选择器强制 full，本 PR 的 CI 因此运行全部 job |
| `biome.json` | **未改**。审计结论见 [exclusion-audit.md](./exclusion-audit.md)：需要真实修复或永久排除批准，不做机械改写 |
| `docs/next-work-roadmap.md`、`docs/tasks/EFFECT-01.md` | **未改**，open PR #136 正在改同样的行 |

登记后实测：`pnpm test:inventory` 564 个文件、Errors 0、`ci-self-check=5`；`pnpm test:ci-select` 120/120。

## 5. 复现命令

```bash
pnpm install
pnpm test:ci-select                                  # 120/120
node --test scripts/ci/check-repo-hygiene.test.mjs   # 14/14
node scripts/ci/verify-result.test.mjs 2>/dev/null || node --test scripts/ci/verify-result.test.mjs
pnpm repo:hygiene                                    # exit 0（本 worktree）
node scripts/ci/check-docs.mjs --all                 # 文档相对链接
pnpm lint
pnpm test:docs
```

## 6. 判定

- 仓库内变更（H3-01 至 H3-05）：已执行，证据齐备，可进入审核。
- H3-06：**待授权，未执行**，按任务书不算通过。
- 因此 **H3 整体不能记为 `done`**。审核通过后仓库内部分可标 `ready-to-merge`；H3 的完成还取决于设置执行与 188 项排除的收口决定。

## 7. 交付 head 与 CI

- 本单元的交付 head SHA 与 PR 链接记录在 PR 正文和回交报告里；本目录不复制一份容易过期的 SHA 副本。
- 审核者按 [sha-checks.md](./sha-checks.md) 的口径核对该 head 自己的 run：`status=completed`、相关 job 的 `conclusion` 逐项确认、被 `skipped` 的 job 能用选择器输出解释。旧 head 的绿灯不可替代最终 head。
- 改动包含 `.github/workflows/ci.yml` 与 `package.json`，选择器会强制 full，因此该 head 的 run 应包含全部 job；`select-checks` 里应能看到新增的仓库卫生步骤实际执行。
