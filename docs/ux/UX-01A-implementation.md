# UX-01A 交付说明：Shell 执行区无行为变化拆分

状态：`delivered`（2026-10-18）。实施分支 `codex/ux01a-shell-extraction`，任务书见 [UX-01A.md](../tasks/UX-01A.md)，产品边界以 [UX-01-decision.md](./UX-01-decision.md) G4 为准。

## 1. 基线

- 任务书 PR #59 合入后的 `main @ ed1cf48`（含 `docs/tasks/UX-01A.md` 与 roadmap 更新，冻结基线后**只有文档改动**）。
- 冻结代码基线 `165aff7068fcddb7667463ccc3769e2f174390b2` 已验证是本分支祖先（`git merge-base --is-ancestor`）；`git diff --stat 165aff7..ed1cf48` 只含 2 个 docs 文件，因此任务书代码事实与行号无需重跑 preflight。
- 符号定位与任务书参考位置**逐一相符**：`Transcript:4852`、`coveredAsks:4940`、`plansByAnchor:4993`、`stepsByAnchor:5008`、`todosByAnchor:5027`、`executionsByAnchor:5046`、`loadExecutionDetail:5182`、`taskCenterFocus:5203`、`renderExecutions:5248`。

提交顺序（冒烟基线先绿的证据）：

| 提交 | 内容 | 验证 |
|---|---|---|
| `b0f3a44` | 冒烟基线：`shell-execution-transcript.test.tsx`（5 测试）+ `Transcript` 导出 seam | 在**未拆分**实现上 5/5 绿（vitest 19:27:09 run） |
| `51f9129` | 拆分：新增 `shell/use-execution-transcript.tsx`，`Shell.tsx` 移除 500 行 | 同一冒烟测试拆分后继续绿（19:37:58 run，7 文件 81 测试） |

## 2. 修改前后模块边界

**之前**：`apps/web/src/pages/Shell.tsx`（7545 行）中 `Transcript` 组件内联定义全部执行区职责：`settledInterventions` / `shownInterventions` / `coveredAsks`、`serverSummaries`、`expansionEntries`（sessionStorage）、`executionDetails`（rev 版本化缓存）、`activityLoading` 锁、`anchorOf`、`expansionPlan`、`plansByAnchor` / `stepsByAnchor` / `todosByAnchor` / `executionsByAnchor`、`loadExecutionDetail`、`taskCenterFocus` + 两个 effect（intent 消费 / 焦点重试）、`renderExecutions`（每锚点的 `ExecutionShell` / `ExecutionCard` / Intervention / Plan / Steps / Todo / Activity / Result 渲染）。

**之后**：

- `apps/web/src/pages/shell/use-execution-transcript.tsx`（574 行，新增）：`useExecutionTranscript(input)` 完整拥有上述全部执行区职责。输入 16 项：`threadId`、`artifactTarget`、`messages`、`messageById`（只读共享 Map，任务书事实 8）、`plans`、`steps`、`todos`、`runs`、`activeRunIds`、`interventions`、`executions`、`activity`、`showActivityAvatars`、`activityBotColors`、`onRefresh`；输出仅 `{ coveredAsks, renderExecutions }`（`coveredAsks` 供 `MessageView.suppressAsk`，`renderExecutions(anchor)` 供三处锚点渲染）。
- `apps/web/src/pages/Shell.tsx`（**7545 → 7066 行，−479**）：`Transcript` 保留普通消息列表、滚动/跟随/跳转、选择引用、回复/表情、语音、后台任务、`messageById`（继续服务回复预览）；执行区只剩一次 hook 调用。任务书验收 2 点名的符号（`plansByAnchor`、`stepsByAnchor`、`todosByAnchor`、`executionsByAnchor`、`loadExecutionDetail`、Task Center 回焦、`renderExecutions` 主体）在 `Shell.tsx` 中均已不再定义（`rg` 0 命中）。
- 导入迁移：7 个 `components/ai/*` 执行区组件、`lib/execution-history` 全部 15 个符号、`lib/intervention-view` 3 个、`lib/execution-card` 的 `resultHasText`、`lib/task-center` 的 peek/clear、`lib/work-progress-view` 的 `unlinkedRunTodos`、contracts 的 `InterventionView` 类型——都只被新模块引用；`isRunActive` 因 `ShellPage` 仍在使用而保留在 `Shell.tsx`。

**搬移代码 verbatim 验证**：脚本对比 `git show b0f3a44:apps/web/src/pages/Shell.tsx` 的被搬区间（4937–4951 + 4962–5416，共 470 行）与新模块对应区间，**逐字节一致**（`verbatim: YES`）。即执行区逻辑零改写，仅位置迁移。

## 3. Hook / effect 依赖人工审查（Biome 未启用 useExhaustiveDependencies）

新模块共 18 个 hook 调用，逐项审查（读取值 vs 依赖数组）：

| # | Hook | 体内读取 | 依赖数组 | 结论 |
|---|---|---|---|---|
| 1 | `useLingui()` | — | — | ✅ |
| 2 | `useState` settledInterventions | 惰性初始 `[]` | — | ✅ |
| 3 | `useMemo` shownInterventions | interventions, settledInterventions | [interventions, settledInterventions] | ✅ 完整；settled/pending 变化同步到 Ask 抑制 |
| 4 | `useMemo` coveredAsks | shownInterventions | [shownInterventions] | ✅ 完整 |
| 5 | `useMemo` serverSummaries | executions | [executions] | ✅ 完整 |
| 6 | `useState` expansionEntries | 惰性 `readExecutionExpansions`（sessionStorage） | — | ✅ 条目按 `threadId:runId` 键控，所有消费函数按 threadId 过滤；Transcript 以 `key={threadId}` 换线程即重挂载，状态全新 |
| 7 | `useState` executionDetails | 惰性 `{}` | — | ✅ 按 runId（全局唯一）键控；渲染处 `selectCachedDetailEntry(..., summary.rev)` 丢弃旧 rev detail，rev 前进不渲染旧 detail |
| 8 | `useRef` activityLoading | — | — | ✅ 每 Run 加载锁 |
| 9 | `useCallback` anchorOf | serverSummaries, messageById | [serverSummaries, messageById] | ✅ 完整；messages 变化 → messageById 重建 → anchor 重算 |
| 10 | `useMemo` expansionPlan | serverSummaries, executionDetails, expansionEntries, threadId | 同左 4 项 | ✅ 完整 |
| 11 | `useMemo` plansByAnchor | plans, messageById, messages, activeRunIds | [plans, messageById, messages, activeRunIds, **anchorOf**] | ⚠️ 既有超集依赖：体内未读 `anchorOf`（plan 路径本就不走 server anchor）。**原样保留**（任务书禁止顺手清理无关旧依赖）；超集只多算不 stale |
| 12 | `useMemo` stepsByAnchor | steps, messageById, messages, activeRunIds, anchorOf | 同左 5 项 | ✅ 完整 |
| 13 | `useMemo` todosByAnchor | todos, steps（经 unlinkedRunTodos）, messageById, messages, activeRunIds, anchorOf | 同左 6 项 | ✅ 完整 |
| 14 | `useMemo` executionsByAnchor | plansByAnchor, stepsByAnchor, todosByAnchor, activity, messages, messageById, activeRunIds, runs, shownInterventions, anchorOf, serverSummaries（+模块级 isRunActive） | 同左 11 项 | ✅ 完整 |
| 15 | `useCallback` loadExecutionDetail | artifactTarget（+模块级 rpc、稳定 setter、模块函数） | [artifactTarget] | ✅ artifactTarget 改变后新 callback 携新目标，不请求旧目标 |
| 16 | `useState` taskCenterFocus | 惰性 `null` | — | ✅ |
| 17 | `useEffect` intent 消费 | threadId, serverSummaries, loadExecutionDetail（+稳定 setter、模块函数 peek/clear/forceOpen） | [threadId, serverSummaries, loadExecutionDetail] | ✅ 完整；`clearTaskCenterNavIntent()` 在应用前调用 → intent 只消费一次 |
| 18 | `useEffect` 焦点重试 | taskCenterFocus（+模块常量 FOCUSABLE_CONTROL、document/window） | [taskCenterFocus] | ✅ 完整；cleanup `window.clearTimeout(timer)`，卸载/重触发即清理 |

结论：**无已知 stale closure**；除 #11 的既有超集依赖（原样保留并记录）外，全部依赖数组与体内读取一致。Transcript 侧剩余 hook（滚动、选择引用、reactionView 等）未触碰。hook 调用顺序变化仅影响 React 内部槽位顺序（同一组件内跨渲染一致即可），无行为影响；hook 在 `messageById` 之后无条件调用。

## 4. 验证结果

工具链：仓库锁定 pnpm 9.15.0 + node v24.21.0（macOS arm64，colima Postgres 5433）。

| 验证 | 命令 | 结果 |
|---|---|---|
| Web 类型检查（基线） | `pnpm --filter @rakazo/web check` | ✅ 拆分前后均 0 错误 |
| Web 构建 | `pnpm --filter @rakazo/web build` | ✅ built in 2.44s（>500kB chunk 警告为既有现象） |
| 定向 Vitest（基线，拆分前） | 任务书 6 文件 | ✅ 6 文件 / 76 测试 |
| 冒烟基线（拆分前，`b0f3a44`） | `pnpm exec vitest run apps/web/src/pages/shell-execution-transcript.test.tsx` | ✅ 1 文件 / 5 测试（原实现先绿） |
| 定向 Vitest（拆分后） | 任务书 6 文件 + 冒烟测试 | ✅ 7 文件 / 81 测试 |
| apps/web 全量 Vitest（拆分后） | `pnpm exec vitest run apps/web/src` | ✅ **82 文件 / 571 测试**，0 失败 |
| E2E（拆分后） | `WORKPAL_E2E_DATABASE_URL=postgresql://…@127.0.0.1:5433/workpal_e2e_ux01a pnpm test:e2e --spec="execution-card.spec.ts\|execution-history.spec.ts\|task-center.spec.ts"` | ✅ **3 文件 / 30 测试** passed（2.4m）；`playwright --list` 同过滤收集 `Total: 30 tests in 3 files`，无伪造文件名 |
| Lint/格式 | `pnpm exec biome check`（3 个触碰文件） | ✅ 0 错误 |
| 安全 | `git status` / `git diff --name-only ed1cf48..HEAD` | ✅ 仅 3 个 apps/web 文件（+本文档与 roadmap/任务卡回填）；无 contracts、db、Prisma、API、Java、工具、事件、迁移改动；无密钥/真实用户数据/私有 URL/本机身份信息 |

现有执行卡、执行历史、任务中心的测试断言与快照**零修改**（`git diff` 中不含任何既有 `.test.` / `.spec.` 文件）；没有 skip、放宽 selector、加大超时或更新旧断言。DOM 顺序、`data-testid` / `data-slot`、aria、文案、CSS class、翻译目录无行为性 diff（搬移代码 verbatim + 全部现有测试通过为证）。

## 5. 冒烟测试覆盖（验收 4）

`apps/web/src/pages/shell-execution-transcript.test.tsx`（jsdom，渲染真实 `Transcript`，仅 mock rpc 传输层、lingui 宏与 Markdown 呈现层；断言全部走 DOM 行为，不复制内部 Map）：

1. **锚定合并**：同一 Run 的 Plan + 2 个 semantic Steps + 未关联 Todo + 前台 Activity 合并为**恰好 1 张** `execution-shell`，四个 `data-slot`（plan/steps/todos/activity）同卡；已完成 Run 的卡位于最终 bot 气泡**之前**（`before:m2`，transcript 子元素顺序 `["m1","execution-shell","m2"]`）；已关联 Todo（linkedStepId 命中）不出现。
2. **summary-only + 失败尾部兜底**：两个 server summary 各产出恰好一张 shell（共 2 张）；锚定到 user 消息的完成 Run 卡在其后；**无消息锚点的失败 Run 落在 `__tail`**（transcript 最后一个元素，`data-status="failed"`）。
3. **Intervention/Ask 去重**：pending Intervention 位于 `execution-interventions`（折叠体 `.exc-details` **之外**、shell 之内）；被覆盖的消息 ask block 在气泡中抑制（气泡无该文本），整个页面该 Ask 文本恰好出现 1 次（region 复用源 ask block 呈现）；approval 动作渲染为可用按钮；waiting Run 卡 `data-open="1"`。
4. **Task Center 回焦（attention）**：intent 消费一次（`peekTaskCenterNavIntent()` 归 null）、目标卡打开、`rpc.runs.executionSnapshot` 以当前 `artifactTarget` 请求、焦点落在 Intervention 区第一个可操作控件（Allow 按钮）。
5. **Task Center 回焦（非 attention）**：先证完成 Run 卡默认关闭（`data-open="0"`），带 intent 重渲染后强制打开（`data-open="1"`）且焦点落在 `.exc-status` 状态行。

## 6. 偏差与剩余风险

偏差（均不改变产品行为）：

1. **`Transcript` 增加 `export`**（测试 seam）：冒烟测试必须在拆分前渲染原实现，而 `Transcript` 原为模块私有。这是 additive 修改，运行时无影响；拆分后测试继续渲染同一 seam（`Transcript` 委托 hook），满足"同一测试先绿后绿"。
2. **`plansByAnchor` 的 `anchorOf` 超集依赖原样保留**（见 §3 #11），未借拆分清理。
3. 新模块内部自持 `useLingui()`（"Load earlier activity" 按钮需要 `t`）；`Transcript` 的 `useLingui` 不变。
4. 冒烟测试 mock 了 `@rakazo/chat-ui/web`（Markdown 呈现）与 lingui 宏，并给 jsdom 补了 `Element.prototype.scrollTo` / `matchMedia` no-op——仅测试环境适配；真实渲染链路由 E2E 30 测试覆盖。
5. 流程说明：任务书 PR #59（docs-only、CI 6/6 绿、mergeState CLEAN）由本次执行合并（`ed1cf48`），以满足"从包含任务书的最新 main 建分支"的前置；未合并任何其他分支内容，PR diff 不含旧分支提交（验收 1）。

剩余风险：

- `renderExecutions` 仍是每次渲染重建的普通函数（与基线一致，未 useCallback 化）——保持 `Transcript`/`MessageView` memo 语义与基线完全相同，UX-01B 若需优化应单独评估。
- 执行区状态挂在 `Transcript` 实例上，依赖 `key={threadId}` 重挂载做线程隔离（基线同款机制，未改变）；UX-01B 改动展开策略时需连同该机制一起评估。
- 冒烟测试对 `deriveExecutionStatus`/`buildExecutionCardModel` 的断言（`data-status`、标题文本）依赖现有卡片呈现，UX-01B 重定义展示规则时这些断言属于**允许更新**的范围（它们是 UX-01A 新增测试，不是旧断言）。

## 7. Roadmap 回填

`docs/next-work-roadmap.md` UX-01 行：UX-01A 标记为 delivered（分支/提交/测试证据），UX-01 保持 `in-progress`，下一切片 UX-01B。任务卡 `docs/tasks/UX-01A.md` 状态更新为 `delivered` 并链接本文。
