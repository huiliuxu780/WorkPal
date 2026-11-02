# H3-01：规则迁入与原位置冲突修正

单元：H3（`codex/harness-delivery-gates`）。基线：`main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`。日期：2026-10-28。

## 1. 迁入的规范输入

两份规则文件在主工作区是**未提交**内容，按第一批 README 要求作为交接输入带进本 worktree，逐字节核对后迁入，没有让本 worktree 只读远端旧版：

| 文件 | 交接输入 SHA-1 | 迁入方式 |
| --- | --- | --- |
| `AGENTS.md` | `4d5bdac8e7988284194181f6f0b33b490d2b2365` | 主工作区未提交版本 = 本 worktree 版本（`diff` 无输出），作为本单元提交 |
| `docs/development-workflow.md` | `9128d1d1a4a86cb35f315acc9563e43da4cb03dd`（迁入前） | 新增文件，`a409140` 上不存在 |

迁入时只做了一处内容修正（见 §2 第 1 项），修正后 `docs/development-workflow.md` 的 SHA-1 与交接输入不同，差异已在本文件列出，交接双方都能核对。

## 2. 在原位置修正的冲突条款

| # | 文件 | 冲突内容 | 事实依据 | 处理 |
| --- | --- | --- | --- | --- |
| 1 | `docs/development-workflow.md` | 写"`test:unit`、`test:postgres`、`test:ci-select`、`test:inventory`、`evidence:check` 等命令尚未实现，不能作为当前可用门禁" | `a409140` 的根 `package.json` 里前四个都存在；实测 `pnpm test:ci-select` 100/100 通过、`pnpm test:inventory` 覆盖 563 个测试文件 0 错误；只有 `evidence:check` 确实不存在 | 原位置改写：列出已落地的命令与实测结果，保留"未落地命令不能当门禁"的规则，只把 `evidence:check` 留为未实现 |
| 2 | `AGENTS.md` | 缺少集中 worktree、禁止嵌套、用 Git 方式删除 worktree 的规则 | [HARNESS-01 H3 步骤 12](../../../tasks/HARNESS-01.md) 明确要求写入 AGENTS.md 与 agent-verification.md，并给出可验证入口 | 在"项目边界"的敏感信息条款后新增一条，指向 `docs/agent-verification.md`；这是**新增**条款，不改写用户已确认的任何既有句子 |
| 3 | `CONTRIBUTING.md` | "The web and Electron-hosted UI…"、整段 Expo mobile / `apps/mobile` / `apps/www` / Electron setup window 的本地化指引 | `apps/` 下只有 `api`、`web`、`worker`；没有 mobile、www、desktop | 删除该段，保留真实存在的 web Lingui 流程 |
| 4 | `CONTRIBUTING.md` | "The Playwright workflow also accepts these providers through its manual **Sandbox provider** input" | `.github/workflows/` 只有 `ci.yml`，其中没有任何 sandbox 输入 | 删除该句 |
| 5 | `CONTRIBUTING.md` | 检查表缺少 H1 落地的分层入口 | `package.json` 有 `test:unit`/`test:postgres`/`test:process`/`test:inventory`/`test:docs` | 补入表格并写明各自环境前提 |
| 6 | `CONTRIBUTING.md` | PR 段只有"keep PRs small / describe how you tested" | 与新规则的交付单元、最终 head CI、真实证据、先红后绿、原型声明口径不一致 | 改为指向 `.github/pull_request_template.md`、AGENTS.md 与 development-workflow.md，并写明只认最终 head |
| 7 | `CONTRIBUTING.md` | `pnpm test:e2e -- --sandbox=e2b` | `harness.ts` 直接读 `process.argv` 的 `--sandbox=` | 改为 `pnpm test:e2e --sandbox=e2b` |
| 8 | `docs/ci01-selective-checks.md` | 状态 `in-progress`、"Not merged" | CI-01 PR #67 已于 2026-10-19 合入，合并提交 `e4fd366` | 改为已合并并记录合并提交与保护现状 |
| 9 | `docs/ci01-selective-checks.md` | "They do not reuse `nightly-verification.yml`（该 workflow 仍引用缺失的 `playwright.yml`；CI-01 不声称修好它）" | 该 workflow 已被 H2（PR #138，合并 `5e2676f`）删除，`a409140` 上只剩 `ci.yml` | 改为记录删除事实与当前唯一每日视觉入口 |
| 10 | `docs/ci01-selective-checks.md` | `CI result` 语义描述未含 schedule 专属 job | 见 [H3-02](./ci-result/README.md) 的缺陷与修复 | 补上"被请求时必须成功、未被请求时 skip 不算失败"，并补"只认最终 head" |
| 11 | `docs/ci01-selective-checks.md` | "Admin follow-up: none required for protection"、"Optional later: make `CI result` the required check" | 保护仍未配置（实测 404 / `[]` / `[]`），且变更单已编制 | 指向 [settings-change-order.md](./settings-change-order.md)，明确待授权未执行 |
| 12 | `docs/ci01-selective-checks.md` | job graph 缺 `harness` 与 `Daily web screenshots`；本地检查缺 `test:inventory`/`repo:hygiene` | `ci.yml` 与 `package.json` 实际内容 | 补全，并注明这两个 job 是 CI-01 之后由 H1/H2 加入，不属于该卡的 before/after 对比 |
| 13 | `docs/tasks/CI-01.md` | 状态 `in-progress / delivered, ready-to-merge` | PR #67 已合入 `e4fd366` | 改为 `done`，按 AGENTS.md 第 8 条（合入后才 `done`） |
| 14 | `docs/tasks/HARNESS-01.md` | 状态 `not-started`；批次表无交付事实 | H1 #137 `810a223`、H2 #138 `5e2676f`、H4 #140 `b6e4343` 均已合入（GitHub API 核对） | 改为 `in-progress` 并新增"已核实的交付记录"表；H3 交付中、H5/H6 未开始 |
| 15 | `docs/tasks/HARNESS-01.md` | 全卡规则写于新规则落库之前 | 新 AGENTS.md/development-workflow.md 是现行规范 | 在卡首加一段：冲突处以两份现行文件为准，本卡保留为历史依据，H3/H5/H6 范围描述仍有效 |
| 16 | `docs/tasks/HARNESS-01.md` | H3 步骤 11 与验收里的"五组 / 188 个"是 2026-10-25 快照 | `a409140` 重新枚举：188 项（14 docs + 174 source），全部仍触发诊断，共 283 条 | 原位置补实测结果与审计链接；验收项标注"尚未闭合，永久排除批准待负责人" |
| 17 | `docs/tasks/UX-01BC-start-prompt.md` | 指示创建 stacked PR 并在前置合入后 retarget base | 现行规则：跨单元依赖默认等前置合入 `main`，不默认建立 stacked PR 队列 | 加"历史提示词"横幅，说明是个案安排、现行规则优先；不改写原始派发正文 |
| 18 | `docs/tasks/AG-03-04-start-prompt.md` | "推送后立即继续、无需等待合并" | 同上 | 加历史横幅，保留原文 |
| 19 | `docs/tasks/MR-01-start-prompt.md` | 无交付状态与现行规则指引 | MR-01 已由 PR #73 合入 | 加历史横幅并链接 PR |
| 20 | `docs/agent-verification.md` | 有 worktree 资源隔离（H4），但无 worktree 布局/删除规则，也无仓库卫生门禁说明 | H3 步骤 5/6/12 | 新增 "Worktree layout and removal" 与 "Repository hygiene gate" 两节，给出 `pnpm repo:hygiene`、`pnpm hooks:install` 与规则表 |

## 3. 明确没有改的地方（含原因）

| 文件 / 位置 | 原因 |
| --- | --- |
| `docs/next-work-roadmap.md` 的 Status 行、Count/order 段、row 27（EFFECT-01）、Current state、Immediate next batches 第 1 项 | 这些行正被 open PR [#136](https://github.com/huiliuxu780/WorkPal/pull/136)（`docs/effect01-done-writeback`）修改。H3 任务书要求"先核对其差异，避免两个分支重复改同一行"。**依赖：#136 合入或关闭后**，才能把 CANCEL-01（#139 合并 `3d54c4a`）、RT-12（#146 合并 `a409140`）、CARD-01B/C（#144 `dc9be38`、#145 `91c92e3`）等已核实合并记录写回 roadmap。本单元不代改，也不因此把 roadmap 记为已更新 |
| `docs/tasks/EFFECT-01.md` | 同样由 #136 修改状态行 |
| `docs/agent-workflow-harness-review-2026-10-25.md` | 评审记录，含时间点快照（如"当前 6 个打开 PR"）。按 H3-01"历史条款明确标为历史"，它整体就是历史输入，HARNESS-01 卡首已声明其快照性质；不逐句改写评审原文 |
| `docs/ux/UX-01B-implementation.md`、`docs/ux/UX-01C-implementation.md`、`docs/tasks/AG-04.md`、`docs/roundtable/audits/ui-prototype-conformance.json` 里的 stacked PR 记录 | 已交付事实的记录，不是现行指示，改写会破坏交付追溯 |
| `scripts/ci/select-checks.mjs`、`scripts/testing/test-inventory.mjs`、`packages/testkit/src/cli/harness.ts`、`packages/testkit/src/cli/e2e-spec-selection.ts` | 第一批 README 指定由 CARD-01D（PR #147）作为唯一整合者。H3 未改这些文件；`verify-result.mjs` 只 import `ALL_JOBS`，不修改它 |
| `biome.json` 的 188 项与五组原型排除 | 审计结论是需要真实修复或永久排除批准，见 [exclusion-audit.md](./exclusion-audit.md)；本次不改配置，避免把门禁交付和全仓格式化混在一个 PR |
| `.gitignore` 里的 `apps/desktop/*`、`apps/mobile/*` 条目 | 属于遗留清理，改动会影响 biome 的 `useIgnoreFile` 行为；不在第一批 H3 的六个步骤内，留作后续 |
| `skills-lock.json` 的生成与校验入口（原卡 H3 步骤 9） | 不在第一批 H3 任务书的六个步骤内；未核查，留作后续，不声称已处理 |
| `docs/tasks/first-batch-20261027/`、`docs/tasks/NEXT-BATCH-20261027.md` | **发现的缺口，未代为提交。** 第一批的权威任务书（README、H3、VERIFY-01、CARD-01D、H2-TRIAGE、SINGLE-AGENT-PROMPT）与全项目规划入口目前只存在于主工作区的未跟踪文件里，`git ls-files` 为空。后果：干净 checkout、CI 的 docs 链接检查、以及任何审核者都读不到派发依据；本目录的证据也无法用相对链接指向它们（`node scripts/ci/check-docs.mjs --all` 会判为 broken link，已改为路径引用）。提交这批任务书属于派发者的动作，且 `apps/grokbot-prototype/`、`docs/roundtable/` 的归属在 HARNESS-01 里仍标注未确认，H3 不代为决定。建议负责人单独提交任务书目录，之后把本目录的路径引用换回链接 |

## 4. 新增而非修正的内容

- `.github/pull_request_template.md`（新文件）：任务卡与交付单元、实际验证命令表（含 head SHA 与退出码）、最终 head 的 CI run、真实运行证据索引、bug 的先红后绿、未执行项与缺口、风险与回滚、文档回写、UI 原型声明或"不涉及 UI"。字段依据 [HARNESS-01 H3 步骤 4](../../../tasks/HARNESS-01.md) 与第一批 README 第 7 条。
- `scripts/ci/check-repo-hygiene.mjs`、`scripts/ci/check-repo-hygiene.test.mjs`、`scripts/hooks/pre-commit`、`scripts/hooks/install.mjs`、`package.json` 的 `repo:hygiene` 与 `hooks:install`。
- `docs/harness/evidence/H3/`（本目录）。

## 5. 需要负责人注意的两处规则文本改动

1. §2 第 1 项改动了用户本次确认的 `docs/development-workflow.md` 一句话。改动理由是可验证的事实冲突（命令已存在），且 AGENTS.md 本身规定"命令以根 `package.json` 为准"。若负责人希望保留原句，请明确指出，我会还原并把冲突改记为"待确认"。
2. §2 第 2 项在用户确认的 `AGENTS.md` 里**新增**了一条 worktree 规则（来自 HARNESS-01 H3 步骤 12）。它不改写任何既有句子。若不希望 AGENTS.md 承载这条，可只保留 `docs/agent-verification.md` 的版本。
