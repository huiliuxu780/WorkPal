# UX-01B 交付说明：Execution Progress Convergence

状态：`delivered, ready-to-merge`（2026-10-18）。实施分支 `codex/ux01b-progress-convergence`，任务书见 [UX-01B.md](../tasks/UX-01B.md)，产品边界以 [UX-01-decision.md](./UX-01-decision.md) §0/§2/G5 与验收 1–13 为准。前置切片 UX-01A 见 [UX-01A-implementation.md](./UX-01A-implementation.md)。

## 1. 基线与 Phase 0 预检

- 冻结基线 `main @ 1ba9895`（PR #60 / UX-01A 的 merge commit）。开工时核实 main CI：`agent-runtime-image`、`web-and-backend`、`agentscope` 三项 check 全部 `success`（run 39129514939），满足任务卡"main CI 全绿后才写产品代码"的前置。
- **偏差（分支基点）**：两张任务卡（`docs/tasks/UX-01B.md`、`UX-01C.md`）当时只存在于未合并的 docs PR #61（`codex/ux01bc-task-cards`，基于 1ba9895，`web-and-backend` 绿）。为满足"更新任务卡状态"的要求又不自行合并 #61，本分支从 `origin/main @ 1ba9895` 创建后 fast-forward 到 #61 的 head `5f5ea7a`（3 个 docs-only 提交）。PR base 仍为 `main`；#61 先合入时本 PR diff 自动收敛为纯 B 改动（与 C-on-B 的 stacked 语义一致）。
- 修改产品代码前的基线：任务卡定向 Vitest **9 文件 / 99 测试全绿**（2.84s）；`pnpm --filter @rakazo/web check` **0 错误**。
- 任务卡 8 条代码事实**逐一核实成立**（符号定位以最新 main 为准）：
  1. `lifecycleRailFill()` 按 semantic Steps 计算、`.exc-rail` 无条件渲染（`execution-card.ts:174-188`、`ExecutionCard.tsx:77`）；
  2. 三套冲突数字：`metaParts()` 的 `N steps`（`execution-card.ts:135-137`）、`RunStepsDisclosure` 的 `x/y done`（:88）、`RunPlanDisclosure` 的 `a/b done`（:57-62）；
  3. 自动展开：`RunPlanDisclosure.tsx:53`、`RunStepsDisclosure.tsx:85` 的 `<details open={live}>`、`use-execution-transcript.tsx:451-453` 的 `openByDefault`；**补充发现**另外两处——`ExecutionShell.tsx:72-81` 非受控 local state 对 live/failed/attention 的强制展开，和 `execution-history.ts planExpansionDefaults` pass-2 的 active/failed 默认打开。五处全部按验收 4 移除（任务卡只点名三处）；
  4. `InterventionRegion` 在 `.exc-details` 之外（`ExecutionCard.tsx` interventions slot 先于 details 渲染）；
  5. `ExecutionSummary` 无 Plan 计数；`RunPlanRevision` 有 `revision`/`changeReason`；`RunStepSnapshot` 有 `planItemId`、`startedAt`、`completedAt`、`attemptNumber`、`evidence` —— **决策 §8.2 的待核实项就此确认：`planItemId` 在快照契约里，Steps 按 Plan item 分组是纯 Web 改动**；
  6. `loadExecutionDetail()` `.catch(() => undefined)` 吞错（本任务未动，retry 属 UX-01C）；
  7. 侧栏 Bot 行第二行 preview 为空时回退原始 `item.chat.status`（`Shell.tsx:3330-3332`）；**补充发现**：`BotAvatar` 组件根本不消费 `status` prop（可信状态一直来自 catalog），roster 传入的 `status={...}` 是死代码，一并移除（头部 avatar 的同款死 prop 不在侧栏范围，未动）；
  8. `BotAvatarState` 含 `state`/`runId`/`revision`；`Bot` 含 `threadId`；`useAvatarCatalog` 原本未从 `@rakazo/ui-web` 导出，按事实 8 的许可导出，未新增第二状态源。**细节偏差**：roster 行数据是 `SpaceBot`（`BotSchema.pick`，无 `threadId`），点击时通过 ShellPage 已有的完整 `Bot[]` state 解析 `threadId`，解析不到则只导航不设 intent。

## 2. 实现总览（提交结构）

| 提交 | 内容 |
|---|---|
| `584e5d4` | **红色测试先行**：10 个测试文件（新增 `execution-surface.test.ts`），58 failed / 81 passed 记录在案 |
| `c8b51fb` | 实现：15 个产品文件（下详） |
| `108b6ed` | i18n：`lingui extract --clean` + zh-CN 翻译 + compile（`.po` 单独提交） |
| `1dc9e39` | E2E fixtures（scripted-runtime 新增 tracked 系列）与 spec 收敛 |
| `5c1284b` | E2E 修复：paced-plan fixture 4s/turn + 独立 revision turn；settled-ask 气泡回声断言 |

### 纯函数层（可单测，无 DOM/RPC/全局状态）

- **`lib/execution-surface.ts`（新）**：`shouldRenderExecutionSurface`（四项条件：Plan / semantic Step / pending Intervention（含 waiting_input、waiting_takeover）/ failed）；`eligibleExecutionRunIds` 复用 `executionDataForRun` + `selectCachedDetailEntry` + `executionRunState` 的**同一套数据优先级**，保证资格判定与打开卡片后所见永远一致。`summary.counts.steps > 0`（服务器可信计数）在 detail 未加载时也算"有 semantic Step"，否则历史窗口里的 Steps Run 会永久失去入口。
- **`lib/execution-card.ts`**：`effectivePlanItems`（排除 skipped/superseded，unresolved 进分母不进分子）、`planProgress`（唯一进度：completed/total/fraction + 可访问 label；无 Plan 或无有效项 → null，绝不 0/--/估算）、`currentPlanItem`（active 优先，其次 unresolved）、`currentItemElapsedMinutes`（**只**认 `planItemId` 匹配且 `startedAt` 可解析的 Step；完成态用 `completedAt`，运行态用注入的 `now`；不足 1 分钟诚实显示 under 1 min）。模型字段 `railFill` → `planProgress`；`metaParts` 删除 `N steps`；动词：failed → `View reason`，普通可展开 → `View progress`，done 保持 `View result`，attention 保持；aux 优先级调整为 Intervention > failure > (Plan 当前项 | activity) > outcome；新增 `planUpdatedLabel`。`lifecycleRailFill` 删除（Steps 不再产生任何进度）。
- **`lib/execution-history.ts`**：`planExpansionDefaults` 移除 pass-2 状态默认展开；rev 匹配的存储决策仍然权威，单开归一化（priority 顺序 first-wins）不变。
- **`lib/intervention-view.ts`**：`coveredAskMessageIds` 增加可选 context——settled view 且其 Run 已无执行区、且气泡内 ask block 已是 settled 状态（answered/expired）时，把 ask 交还气泡（历史回声）；block 仍是 pending 的（被 Stop 的 Run）保持抑制，**绝不渲染假的可操作卡片**。无 context 调用保持旧语义。
- **`lib/task-center.ts`**：`rosterAttentionIntent`（纯函数：仅 waiting/approval + 可信 runId 才生成 intent，`rev` 携带 avatar state 的 revision，消费端仍用 summary 自己的 rev）；`EXECUTION_NAV_INTENT_EVENT` 窗口事件常量（同线程点击时唤醒 intent 消费 effect；模块内存 + 一个事件，无新 RPC/URL/storage）。

### 组件层

- **`ExecutionCard.tsx`**：`.exc-rail` 只在 `planProgress` 存在时渲染，且升级为可访问进度条（`role="progressbar"` + `aria-label/valuemin/valuemax/valuenow`），填充高度 = fraction；标题行改 `.exc-title-row`（标题 + 唯一 `a/b`，`data-testid="execution-plan-count"`）；`planUpdated` prop 渲染 `role="status" aria-live="polite"` 的"计划已更新"提示（`data-testid="execution-plan-updated"`）。无 Plan 时**没有任何进度 DOM**（无底轨、无扫光、无 0/--）。
- **`ExecutionShell.tsx`**：非受控默认收起（`useState(false)`），仅保留 done/cancelled 的自动收起；删除 attention/failed 强制展开；新增 `plan`/`now` props 透传给模型；**revision flash**：`useRef` 记忆已见 revision，仅在增长时点亮 3s（`PLAN_UPDATED_FLASH_MS`），首挂载、首次见 Plan、相同或陈旧 revision 都不闪，定时器 cleanup 完整；**失败定位**：failed 卡片打开时一次性聚焦 `[data-failure-target]`（failed Step 的第 2 层或 Run-level reason 块）。
- **`RunPlanDisclosure.tsx`**（重写）：第 1 层唯一 Plan 列表——goal、`v{revision}`、`Plan updated: {changeReason}`、items（status mark/label、reason 折叠保留、>8 折叠保留）；**不再显示 a/b**（数字只在卡头一处）；`<details open={live}>` 结构删除。每个 item 的第 2 层 = `planItemId` 匹配的 Steps（Details 折叠；Run failed 时含 failed Step 的 item 自动展开并携带 `data-failure-target`）；未匹配 Steps 收进明确的 `Other execution records`（`data-slot="steps"`），不丢失。
- **`RunStepsDisclosure.tsx`**（重写）：无 Plan 时的第 1 层——Step 标题 + 状态 mark/label + 纯文字 `N blocked or failed`（无任何分数）；duration/resultSummary/batch/attempt/evidence 全部移入每步的 Details 第 2 层（`data-testid="step-detail"`，failed Step 自动展开 + `data-failure-target`）；`live` 自动展开删除。共享件 `StepList`/`StepRow`/`StepDetailBody`/`stepMarks`/`stepStatusLabel` 供 Plan 分组复用。
- **`RunTodoList.tsx`**：**B 不再渲染 Todo**（hook 中移除）；组件文件保留给 UX-01C 的"事项清单"兜底。Todo 数据管道（`todosByAnchor`）保留但 Todo 不参与执行区资格。
- **`execution-card.css`**：新增 `.exc-title-row`/`.exc-count`/`.exc-flash`（全部走 token）；rail 注释更新为 Plan-only 语义。

### 装配层（`pages/shell/use-execution-transcript.tsx`）

- `eligibleRunIds` memo（runs/plans/steps/summaries/detail cache/interventions 全输入）；`renderExecutions` 对不合格 Run 返回 null——**普通 running Run 不再创建 ExecutionShell**，只剩现有 progress message 单行轻量状态（其生命周期由 thread-events 管理，最终回复后从 DOM 消失，未改动）。
- `coveredAsks` 带 context（eligibleRunIds + settledAskMessageIds）。
- `expansionPlan` 只纳入合格 Run；`openByDefault` 恒 false（受控/非受控都不自动展开）。
- children：`plan ? RunPlanDisclosure(plan, steps, failed) : steps.length ? RunStepsDisclosure(steps, failed)`；failed 且无 failed Step 时渲染安全的 Run-level `execution-failure-reason`（`summary.failure` 白名单投影，携带 `data-failure-target`）；Activity/Load earlier/Result 保持不变；Todo 渲染移除。
- intent 消费 effect 监听 `EXECUTION_NAV_INTENT_EVENT`（侧栏同线程点击路径），cleanup 完整。

### 侧栏（`pages/Shell.tsx` + `packages/ui-web`）

- Bot 行第二行**只显示真实 preview**，为空则空（删除 `item.chat.status` 回退）；行内无数字、无状态文字；状态只由头像徽标表达（既有 shape cue + `aria-label`"名字 · 状态" + waiting/approval/failed 的 `aria-live="polite"`，来自可信 catalog）。
- roster BotAvatar 的死 `status` prop 移除。
- 行按钮包一层 `RosterRowCatalog`（render-prop 消费 `useAvatarCatalog`，单一状态源）：点击 waiting/approval Bot 时 `rosterAttentionIntent` 生成 intent（`threadId` 由完整 Bot 列表解析）→ `setTaskCenterNavIntent` + ping 事件 → 目标 Thread 加载后聚焦 Intervention 第一个可操作控件（复用 Task Center 回焦机制，含同线程点击）；无可信 runId/threadId 只导航。
- `@rakazo/ui-web` 导出既有 `useAvatarCatalog`。

## 3. 验收 1–13 证据

| # | 验收 | 证据 |
|---|---|---|
| 1 | 四项条件都没有 → 无执行区/slot/字样 | 单测 `execution-surface.test.ts`（4 条件独立 + 组合）、transcript 测试"Todo-only、Activity-only、plain active 无 shell"+"summary-only plain 无 shell"；E2E `a plain request keeps no execution surface…`（含 reload 后仍为 0） |
| 2 | 普通请求只有轻量状态，回复后消失 | transcript 测试"leaves a plain active Run with only the lightweight progress bubble"；E2E plain-request 测试断言 `[data-message-id^="progress:"]` 为 0；既有 `chat-progress-messages.spec.ts` 覆盖 progress 气泡生命周期（未改动该机制） |
| 3 | 单个 semantic Step 即有执行区；Activity/steps block 不冒充 | transcript 测试"creates a surface for a single semantic Step"（同时断言无 count/bar/rail）+ Activity-only 无 shell；`eligibleExecutionRunIds` 只读 `RunStepSnapshot` 数组/detail steps/counts.steps |
| 4 | 默认收起；第 0 层结构 | `planExpansionDefaults` 测试（全部默认关）、ExecutionShell/Card 测试（waiting/failed 收起）、transcript 测试（waiting data-open="0"）；E2E approval 测试（收起但 region 可操作）、paced-plan 测试（running data-open="0"）；第 0 层元素 = 状态图标/句 + 标题 + a/b + progressbar + current 行 + 动作（ExecutionCard 测试） |
| 5 | 唯一 a/b、有效项口径、无 N steps / x/y done | `planProgress`/`effectivePlanItems` 测试（unresolved 进分母、skipped/superseded 排除、3/4→3/6 倒退）；ExecutionCard 测试 `occurrences("1/2")===1`、metaParts 无 steps；RunPlan/RunSteps 测试（第 1 层无分数）；E2E `cards never render invented percentages`（含 /\d+ steps/ 断言）+ paced-plan `plan.innerText()` 无分数 |
| 6 | 无 Plan → 无进度条 DOM/底轨/扫光/0/-- | ExecutionShell/Card 测试（有 steps 无 plan：无 exc-rail、无 progressbar、无 count、无 "--"）；E2E failed-with-step 测试断言 `.exc-rail` 与 plan-count 为 0；`planProgress` null 语义（无有效项也 null） |
| 7 | 无 Plan 审批可见可操作不可折叠 | region 始终在 `.exc-details` 外（ExecutionShell/Card 测试：interventions 位于 hidden 之前；transcript 测试：`region.closest(".exc-details")===null` + Allow 可用）；E2E approval 测试（收起态下 Deny enabled、attention 聚焦 region） |
| 8 | 失败两条查看路径 | failed 无 Step：hook 渲染 `execution-failure-reason`（安全投影）+ `View reason` 动词（card 测试）+ Shell 聚焦 `data-failure-target`（jsdom 测试）+ E2E `a failed Run shows the safe failure summary`；failed 有 Step：StepDetailBody/PlanItemSteps 自动展开 + failure-target（RunSteps/RunPlan 测试）+ E2E `a failed Run with a failed Step lands View reason on that Step's detail` |
| 9 | revision 倒退 + 3s 提示 + v2/changeReason | ExecutionShell jsdom 测试（fake timers：增长闪 3s、首见/相同/陈旧不闪、unmount 清理）；RunPlanDisclosure 测试（v2 + "Plan updated: Source reviewed"）；E2E paced-plan（3/4→3/6 实时倒退 + `execution-plan-updated` 可见，4s/turn 确定性 pacing） |
| 10 | 第 1 层唯一列表；默认视图无 Todo | RunPlanDisclosure 测试（plan 存在时 steps 不再平铺，未匹配进 Other records）；hook 移除 RunTodoList 渲染；transcript 测试（todos slot null、UNLINKED-TODO-1 不出现）；E2E plain/plan 测试 slots 断言 |
| 11 | Step 耗时/尝试/证据/异常/未确认只在第 2 层 | RunStepsDisclosure 测试（第 1 层无 duration/attempt/evidence/resultSummary/batch，Details 打开后全部出现）；RunPlanDisclosure 测试（item 第 2 层同款）。解释性说明：unknown Step 的状态 label（"Status unconfirmed"）保留在第 1 层——它是状态本身，被移除的是聚合提示"some statuses unconfirmed"与全部分数 |
| 12 | 侧栏无数字/状态文字、aria、回焦 | Shell.tsx diff（回退删除、死 prop 删除）；`rosterAttentionIntent` 单测（waiting/approval + runId 才生成，idle/working/failed/null 拒绝）；aria 由既有 `agent-avatar.test.tsx`/`bot-avatar.test.tsx`（17+ 测试）覆盖（label=名字·状态、approval/waiting/failed 带 aria-live）；transcript ping 测试（同线程 intent 消费 + 聚焦 Allow）；E2E `clicking a waiting Bot in the sidebar focuses its approval control`（跨线程真实审批 + row 文本无分数/状态词） |
| 13 | 完成收成一行、结果只出现一次 | rev-keyed 展开语义（完成时 rev 前进 → 存储决策失效 → 默认收起）+ 非受控 done/cancelled 收起 effect；`resultOnPage` 去重未动；E2E `a completed Run restores its card…`（结果恰一次、卡片不复读）+ paced-plan（outcome 行 0 次） |

另外保持项：同 Thread 单开（`planExpansionDefaults`/`toggleExpansion` 测试）、sessionStorage rev 语义（`isExpansionOpen` 测试）、stale detail 防护（rev-versioned cache 测试全绿）、Ask 去重（transcript 测试 + `intervention-region.spec` 3/3 实跑通过）、Task Center summary-only 不猜进度（TC 不传 plan → `planProgress` null，无 bar/count）。

## 4. 测试与门禁

| 验证 | 命令 | 结果 |
|---|---|---|
| 红色基线 | 定向 vitest（10 文件） | 58 failed / 81 passed（提交 `584e5d4` 为证） |
| 实现后定向 | 任务卡 9 文件 + `execution-surface.test.ts` + `intervention-view.test.ts` + `task-center.test.ts` | 见 §4.1 最终数字 |
| apps/web 全量 | `vitest run apps/web/src` | **83 文件 / 631 测试全绿**（10.6s；基线 82/571 → 新增 1 文件 60 测试） |
| ui-web 包 | `vitest run packages/ui-web` | 6 文件 / 46 测试全绿 |
| adapters 包 | `tsc --noEmit` + `index.test.ts` | 0 错误；17 测试全绿 |
| Web 类型检查 | `pnpm --filter @rakazo/web check` | 0 错误 |
| Web 构建 | `pnpm --filter @rakazo/web build` | built（>500kB chunk 警告为既有现象） |
| i18n | `intl:extract` + `intl:compile` | 10 locale 更新，zh-CN 按决策文案翻译，单独提交 `108b6ed` |
| 定向 E2E | `test:e2e --spec="execution-card.spec.ts\|task-center.spec.ts"`（独立库 `workpal_e2e_ux01b` @ colima 5433） | 见 §4.1 最终数字 |
| 非门禁受影响 spec | `intervention-region.spec.ts`（3/3 ✅ 实跑）、`approval-resume.spec.ts`（✅ 实跑）、`execution-card-visuals.spec.ts`（opt-in，未实跑，仅规则同步） | — |

### 4.1 最终门禁数字

- **定向 Vitest**（任务卡 9 文件 + 新增 `execution-surface.test.ts` + 受影响的 `intervention-view.test.ts`、`task-center.test.ts`，共 12 文件）：**176 / 176 绿**，2.89s（红色基线 58 failed → 0 failed）。
- **apps/web 全量 Vitest**：**83 文件 / 631 测试全绿**，10.6s。
- **Web typecheck / build**：0 错误 / built 2.29s。
- **定向 E2E（B 门禁）**：`WORKPAL_E2E_DATABASE_URL=postgresql://…@127.0.0.1:5433/workpal_e2e_ux01b pnpm test:e2e --spec="execution-card.spec.ts|task-center.spec.ts"` → **27 / 27 passed（1.9m）**（execution-card 14，task-center 13；chromium；独立测试库，非生产/个人数据）。
- **非门禁受影响 spec 实跑**：`intervention-region.spec.ts` **3/3 passed（36.2s）**、`approval-resume.spec.ts` **1/1 passed（12.7s）**。

## 5. 修改过的旧断言及产品理由（逐条）

规则来源均为 UX-01-decision §0/§2（已由徐哥批准）与 UX-01B 任务卡验收 1–13。

**单元**
1. `execution-card.test.ts`：删除 `lifecycleRailFill` 套件（Steps 进度条被核心规则 2 废除）；`metaParts` 断言去掉 "3 steps"（验收 5）；`View execution` → `View progress`/`View reason`（§2.1 动作动词）；`railFill` → `planProgress`。
2. `ExecutionCard.test.tsx`：waiting 卡从"永远展开"改为收起 + region 外置可操作（验收 4/7）；failed 动词 `View reason`（验收 8）；truncated-steps 保守 rail 测试替换为 Plan-only rail 测试（验收 6：Steps 不再产生进度）。
3. `ExecutionShell.test.tsx`：waiting/failed 自动展开断言反转为收起（验收 4"运行中不再自动展开"+§2.1"失败时保持收起"）；受控/单开/标识符安全等断言原样保留。
4. `RunPlanDisclosure.test.tsx`：旧断言 `1/2 done` 与 `<details open>` 自动展开删除（验收 5 唯一 a/b、§2.1 删自动展开）；重写为三层结构测试。
5. `RunStepsDisclosure.test.tsx`：旧摘要行 `x/y done`/`some statuses unconfirmed` 删除（验收 5/11）；duration 移入第 2 层；重写。
6. `execution-history.test.ts`：`planExpansionDefaults` 的默认展开期望全部反转为默认收起；存储决策/单开归一化断言保留（§2.1 保留两条规则）。
7. `shell-execution-transcript.test.tsx`（UX-01A 新增测试，交付说明 §6 已预告属允许更新范围）：todos slot 断言反转（B 不渲染 Todo）；summary-only plain Run 从"必有一张 shell"改为"无 shell"（验收 1）；waiting 卡 data-open 1→0（验收 4/7）；非 attention 回焦 fixture 补 semantic Step（plain Run 无卡可聚焦）。
8. `intervention-view.test.ts`：新增 context 语义用例（旧无 context 行为原样保留并有测试）。

**E2E**
9. `execution-card.spec.ts`：card 依赖的 Run 全部换成 tracked fixtures（plain tool Run 不再有卡——验收 1 的直接后果，spec 的目的需要合法执行区）；approval 卡展开断言反转（验收 4/7）；failed 卡从"默认展开 + Collapse/View execution"改为"默认收起 + View reason + reason 块"（验收 8）；active+failed 单开测试改为"双双默认收起，用户打开时单开保持"（验收 4）；长标题/百分比/reduced-motion 测试换 tracked prompts。新增 3 个场景（paced plan、plain request、sidebar refocus）。
10. `task-center.spec.ts`：回对话断言的 4 个测试换 tracked prompts（回焦目标必须有合法执行区）；TC 列表级断言全部未动（TC 是 summary 列表面，不受执行区资格影响）。
11. `agentscope-product.spec.ts`（CI 运行）：`[data-slot="steps"]` 平铺断言改为"匹配 Step 进 Plan item 第 2 层 + 无平铺 slot"（任务卡 §3 明文：Plan 与 Steps 同存时 Steps 不再平铺）。
12. `execution-card-visuals.spec.ts`（opt-in 非门禁）：prompts/动词/默认态同步新规则。
13. `approval-resume.spec.ts`、`intervention-region.spec.ts`（非门禁）：settled 回执断言从"region 常驻"改为"region 短暂持有 → 气泡 answered 回声"（新覆盖规则的实证：E2E 实跑观察到 "Saved"/"Answered: Seoul"/"Answered: Paris" 气泡回声）；被 Stop 的 plain Run 断言改为"无 region、无任何可操作卡片"；`prompt count 3→1`（每个 waiting Run 的 region 只含自己的卡）。

## 6. Selector / DOM 变化清单

- **移除**：两个 Disclosure 的嵌套 `<details>`（含 `open={live}`）；无 Plan 时的 `.exc-rail` DOM；`N steps` 元数据；`x/y done`、`a/b done`、`some statuses unconfirmed`、`N items in progress` 摘要；`data-slot="todos"` 在对话中的渲染（组件与数据管道保留给 C）。
- **新增**：`data-testid="execution-plan-count"`、`execution-plan-updated`、`execution-failure-reason`、`step-detail`、`plan-item-steps`；`data-failure-target` 属性；`.exc-rail` 的 `role="progressbar"` + aria-value*；`.exc-title-row`/`.exc-count`/`.exc-flash` class；`.exc-line[data-kind="current"]`。
- **保留**：`data-slot="plan|steps|activity"`（steps slot 现只在无 Plan 平铺或 Other execution records 时出现）、`data-plan-item-id/status`、`data-step-id/status`、`execution-shell/card/interventions`、`intervention-region`、`exc-status/details/glyph/line/meta/entry` 等既有钩子。

## 7. 偏差、已知风险与未做事项

**偏差**
1. 分支基点含 PR #61 的 3 个 docs 提交（见 §1，最小解决，PR diff 随 #61 合入自动收敛）。
2. 自动展开实际有 5 处（任务卡点名 3 处），全部移除。
3. roster 行是 `SpaceBot` 投影（无 `threadId`），经完整 Bot 列表解析（见 §1 事实 8）。
4. 头像 aria 状态词（`avatarStateNames`）是 ui-web 包内英文常量（包无 lingui 依赖，本地化需包级 i18n 接入，超出 B 范围）；读屏可读出"<Bot 名> · Waiting for you/Working"等，语义满足验收 12，中文本地化登记为后续项。
5. waiting（input/takeover）状态在 Intervention 投影到达前也构成执行区条件——核心规则 3"不得隐藏"的保守读法。

**已知行为后果（决策的直接结果，非缺陷）**
- 普通完成的 Run 在对话里不再有历史卡：结果气泡即全部呈现；任务中心仍可列出并回跳（回跳后无卡可聚焦时按既有 5s 重试自然放弃，不报错）。
- plain Run 的 settled ask：region 随执行区消失，气泡 answered 回声接棒（E2E 实证）；被 Stop/deny 且 block 仍 pending 的 ask 保持隐藏（宁可不见，不给假的可操作卡片）——"Denied/Effect denied" 回执在 region 消失后不再持久可见，如需持久回执建议列入 UX-02。
- 同一 Run 的 rev 前进（如完成）会使存储的展开决策失效并收起卡片——既有冻结语义，paced-plan E2E 依此重排断言。

**风险**
- `execution-history.spec.ts`（C 的门禁、非 B 门禁、CI 不跑）依赖"answered 后 plain Run 卡片仍在"的旧前提，B 合入后到 C 修复前处于已知红灯；按任务卡分工由 C 用 tracked fixtures 修复。
- paced-plan E2E 的 3/4 窗口为 4s（fixture pacing），本地稳定通过；极端慢环境下首个断言可能错过窗口（登记为潜在 flake 源，C 收口时观察）。
- 跨 Space 点击侧栏 Bot 走整页跳转，模块内存 intent 丢失（与既有 Task Center intent 相同的边界）。

**未做（按边界裁决属 C 或 UX-02）**：detail 加载失败/重试状态；"事项清单"旧数据兜底；`executionDataForRun` detail 分支 Todo 去重；`RunTodoList.test.tsx`；A/B/C 场景 E2E 收口与三 spec 全量；原生 Plan Mode 隔离测试；翻译残留清理。

## 8. 安全 diff 检查

- `git diff 5f5ea7a..HEAD --stat`：仅 `apps/web`（src+e2e+locales）、`packages/ui-web/src/index.ts`（导出既有 hook）、`packages/adapters/src/scripted-runtime.ts`（测试 runtime fixtures）。
- **无** contracts、数据库、Prisma、API、Worker、Java Runtime、工具 schema、事件、迁移改动（`packages/contracts`、`packages/db`、`apps/api`、`apps/worker`、`services/` 零 diff；scripted-runtime 仅新增 fixture 分支，既有分支与 `applyTool` 生产路径未动）。
- 无密钥、真实用户数据、私有 URL、本机身份信息入库；`.qoder/`（本机会话期外部工具生成的未跟踪目录）已从提交中剔除并保持未跟踪。

## 9. 修复轮（2026-10-19 审查反馈：P1/P2）

审查确认 CI 全绿、既有相关测试通过，但补充回归暴露两项缺陷，均已红→绿修复于本分支：

### P1：等待审批时执行详情无法展开

- **缺陷**：主按钮被 attention action 替换且 `onToggle` 在 `needsAttention` 时直接返回；默认收起后用户无法从卡片查看已有 Plan/Steps/证据。
- **修复**：`ExecutionCardModel` 新增 `secondaryAction` —— attention 主动作卡在 `canExpand` 时渲染**独立**的「View progress / Collapse」toggle；`aria-expanded`/`aria-controls` 从 attention 按钮移到这个真正的 disclosure 控件上（顺带修正了 aria 语义：attention 是聚焦动作，不是展开控件）；`ExecutionShell.onToggle` 移除 `needsAttention` 拦截。审批卡仍渲染在折叠体外，展开/收起不影响其可操作性；`actionOverride`（Task Center）无 secondary。
- **回归**：ExecutionShell jsdom 交互测试（真实 `RunPlanDisclosure` 子组件：默认收起 → View progress 展开见 `[data-slot="plan"]` → attention 仍聚焦 Allow → Collapse 收起）；模型 `secondaryAction` 3 条（waiting 收起/展开、无 detail 或 override 时省略、非 attention 卡省略）；E2E approval 测试更新为双按钮断言 + 展开后 region 仍可操作。

### P2：「查看原因」没有真正定位到失败 Step

- **缺陷**：生产路径的 `data-failure-target` 节点（`StepDetailBody`、`PlanItemSteps` 容器）不可聚焦，`.focus()` 无效；旧测试用手写 `tabIndex={-1}` 节点掩盖了这一点；且详情异步到达后焦点 effect 不再执行。
- **修复**：两处真实失败目标容器补 `tabIndex={-1}`；焦点 effect 从一次性布尔改为**目标身份跟踪**（`focusedFailureTarget` ref），依赖加入从 `steps` 派生的 `failedStepId` —— 详情晚到时随失败 Step 身份变化重跑并把焦点移到新目标；Run-level reason 块先获焦、随后被真实 failed Step detail 接管的路径同样覆盖；收起或状态离开 failed 时重置。
- **回归**：3 条组合真实组件的 jsdom 测试（`RunStepsDisclosure` 同步、`RunPlanDisclosure` plan-item 分组、延迟到达后焦点迁移），断言 `document.activeElement` 就是真实 `data-failure-target` 且位于对应 `data-step-id` / `data-plan-item-id` 内；E2E `a failed Run with a failed Step…` 增加 `activeElement.closest("[data-failure-target]")` 轮询断言（覆盖真实异步 detail 路径）。

### 追加缺陷（本轮门禁重跑暴露的 B 潜伏问题）：live 卡"自关闭"循环

- **缺陷**：打开活动 Run 的卡片时，toggle 以 thread summary rev（R1）写入存储展开决策，而这次打开触发的 `loadExecutionDetail` 对持续产生事件的 Run 会带回更高的 detail rev（R2，rev=MAX(event seq)，hang/流式 Run 每 50ms 前进）；`expansionPlan` 以 detail 优先计算当前 rev → 存储条目（R1）被判陈旧丢弃 → 卡片在打开后立刻自动收起。此前 3 次门禁通过属轮询竞态幸存（采样早于 detail 返回），本轮时序变化后确定性复现（E2E "an active Run and a failed Run never open two details at once"）。
- **修复**：新增纯函数 `rekeyExpansionRev`（只升不降、未知 Run/Thread 不动、收起决策同样只换 rev 不改 open），`loadExecutionDetail` 成功安装快照后把该 Run 的存储决策 re-key 到 detail rev——用户刚打开的同一投影的新版本到达不构成"rev 移动"。真实投影移动（后续新事件）仍按冻结语义丢弃决策。Task Center 回焦 force-open 在活动 Run 上的同类竞态一并修复。
- **回归**：`rekeyExpansionRev` 3 条单测 + transcript 集成回归"keeps a live card open when its own detail load lands on a fresher rev"（summary rev5 / detail rev9，红→绿实证）+ 上述 E2E 恢复确定性通过。

### 同轮顺带修正（本分支规则引起的 E2E 竞态）

- approval E2E 的 "Denied" 回执断言在 B 规则下是瞬态竞态（plain Run 的 region 随取消卸载；此前两次门禁通过属首查竞态幸存），改为确定性终态断言（region 消失、无可操作控件），与 C 分支同一修法（C rebase 后该提交去重）。

### 修复轮门禁

- 红色回归：4 failed（3 条 `rekeyExpansionRev` 单测 + 1 条 transcript 集成回归）→ 实现后全绿。
- `pnpm --filter @rakazo/web check`：0 错误；`build`：成功。
- apps/web 全量 Vitest：**83 文件 / 641 测试全绿**（修复前 637 → 新增 4 条回归；P1/P2 修复轮此前已 +6）。
- 定向组件/纯函数（ExecutionShell + ExecutionCard + RunPlan/RunSteps + execution-card lib + execution-history + transcript）：60/60 绿。
- E2E 门禁重跑（`execution-card.spec.ts|task-center.spec.ts`，独立库 `workpal_e2e_ux01b3`）：**27 / 27 passed（1.6m）**，含更新后的 approval 双按钮断言与 failed-step 焦点轮询断言。
