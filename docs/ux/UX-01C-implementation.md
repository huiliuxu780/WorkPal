# UX-01C 交付说明：Compatibility, Retry and E2E Closure

状态：`delivered, ready-to-merge`（2026-10-18 首发；2026-10-19 完成审查修复轮并 rebase）。实施分支 `codex/ux01c-compatibility-e2e`，从 UX-01B 的精确已验证 head `7599874` 创建；B 审查修复轮（P1/P2 + live 卡 rekey，`2f2e757`）后 `git rebase --onto 2f2e757 7599874` 到新 B head（两处冲突均为同款修复去重，见 §9）；初始 PR base=`codex/ux01b-progress-convergence`（stacked）。任务书见 [UX-01C.md](../tasks/UX-01C.md)，B 的行为契约见 [UX-01B-implementation.md](./UX-01B-implementation.md)，产品边界以 [UX-01-decision.md](./UX-01-decision.md) §2.6/G6 与验收 14–20 为准。

## 1. 红色证明（先证明缺陷，再修复）

提交 `3e25f78`（红）→ `ebb4f9a`（绿）。两条任务卡点名的基线缺口均先以失败测试实证：

1. **detail error 被吞**：transcript 测试打开卡片后断言 `execution-detail-error` + `execution-detail-retry` 出现且不含原始错误文本——在 `loadExecutionDetail().catch(() => undefined)` 的旧实现上失败（无任何错误 UI）。
2. **两条 Todo 路径不一致**：`executionDataForRun` 测试构造 Step S1 + Todo T1(`linkedStepId=S1`) + T2（未关联），断言 detail 分支与 legacy 分支都只返回 T2——旧实现 detail 分支直接返回 `detail.todos.items`（含 T1），测试失败。

红色基线：4 文件 6 失败（含 `execution-detail-request` 模块缺失、`RunTodoList` 旧文案）。

## 2. 实现总览

- **`lib/execution-detail-request.ts`（新）**：per-Run `idle | loading | error` 纯 reducer（begin/settle/fail/clear/status），**与 rev-versioned `ExecutionDetailCache` 完全分离**——错误是传输事实，不是快照版本。成功清 error；`begin` 对 loading 幂等。
- **`use-execution-transcript.tsx`**：`detailRequests` state + `detailInFlight` ref（同 Run 并发去重：in-flight 时重复点击是 no-op，不发第二个请求）；失败在**打开的卡片第 2 层**渲染稳定安全文案 +「重试」（`execution-detail-error` / `execution-detail-retry`），绝不显示原始网络/服务错误；Retry 用当前 `artifactTarget` + runId；已有 summary/Plan 数字/卡头不因失败被清空（错误块只在 `!detail` 时出现，缓存数据继续权威）。陈旧防护：线程/target 切换经既有 `key={threadId}` 重挂载得到全新请求状态；晚到回包只落在卸载后的 no-op setter 上；rev guard（`selectCachedDetailEntry`/`installExecutionDetail`）原样保留。Activity「Load earlier」错误路径未动（不在本项范围，实现也未被迫共享状态）。
- **固定降级顺序（验收 16）**：第 1 层严格 Plan → Steps → 事项清单。事项清单（`RunTodoList` 重写）只在**合法执行区已存在**（B 的四项资格过滤先行）、**展开数据无 Plan 且无 Steps**、且**卡片已展开**时渲染——收起时完全不在 DOM（条件渲染，不是 hidden）；标题「Work items/事项清单」+ 批准前言「这次运行没有计划，以下是当时的事项清单」；用户可见文字无 `Todo`/`待办`、无数量/分数/进度条；只显示未被 semantic Step 关联的 Todo（经 `unlinkedRunTodos`）。Todo-only 普通成功 Run 仍不产生执行区。
- **两条 Todo 路径一致（验收 17）**：`executionDataForRun` 的 detail 与 legacy 分支现在都套用 `unlinkedRunTodos`（同 Run 键控 `runId+stepId`，跨 Run 的 `linkedStepId` 不误杀）；hook 侧 legacy 预过滤保留，函数层自洽。新增 `RunTodoList.test.tsx`（排序=order→todoId、批准文案、禁止词、无数字、空列表不渲染、reason 次要文本）。
- **Summary-only（验收 15）**：Task Center 与对话历史的 summary-only 卡片无 Plan 输入 → `planProgress` null → 无数字/进度条/底轨/0/--/估算（B 的模型语义 + C 的 TC 单测守卫和 E2E 守卫）；`ExecutionSummary.counts.steps` 仅作资格信号与摘要元数据，不显示为 `N steps`、不产生进度；summary contract 未扩展。
- **原生 Plan Mode 隔离（验收 19）**：Web 的 Plan slot/进度唯一数据源是 `RunPlanRevision` 投影（`ThreadSnapshot.plans` / `ExecutionSnapshot.plan`），本次 diff 未新增任何 Plan 来源；`plan_enter/plan_write/plan_exit` 的原生 Markdown、工具 Activity（含 kind="planning"）、Markdown 列表和 `MessageBlock.kind="steps"` 都有单测守卫证明不产生 Plan slot、progressbar 或执行区。
- **文案与证据语义（验收 20）**：`rg "已核验|已确认"` 在 `apps/web/src`、`apps/web/e2e` 为 0 命中；旧数字文案（`{n} steps`、`{done}/{eligible} done`、`some statuses unconfirmed`、`To do`）已从源码与全部翻译目录清除（extract --clean）；Step evidence reference 计数仍在第 2 层可见（RunSteps/RunPlan 单测 + agentscope CI spec 的 "Fixture inspected" 路径）。
- **scripted fixtures（测试层专用）**：`publish tracked todos`、`fail this todo run`、`show a tracked secret card`——全部经生产 `publish_run_todo`/`publish_run_step` 工具路径（executor `applyTool`），不在页面注入内部 Map。

## 3. UX-01 全部 20 条验收证据矩阵

图例：**U**=单元测试，**E**=E2E，**D**=代码 diff/结构性证明。1–13 由 B 实现、C 复验无回归（C 收口全量重跑）。

| # | 验收 | 证据 |
|---|---|---|
| 1 | 四项条件皆无 → 无执行区/slot/字样 | U: `execution-surface.test.ts` 全部、transcript（Todo-only/Activity-only/plain active/summary-only plain）；E: `a plain request keeps no execution surface…`（含 reload）、`a Todo-only Run never triggers…` |
| 2 | 轻量状态一行、无数字、回复后消失 | U: transcript"leaves a plain active Run with only the lightweight progress bubble"；E: scenario A `a plain active Run shows only the lightweight status until it stops`（运行中无 shell/slot/progressbar、"still working…" 可见；stop 后 progress 气泡从 DOM 消失） |
| 3 | 单个 semantic Step 即有执行区；Activity/steps block 不冒充 | U: transcript"single semantic Step"（同时断言无进度 DOM）、"never synthesizes a Plan from Activity, Markdown or message steps blocks"；E: tracked 系列 fixtures 全部走真实 publish_run_step |
| 4 | 默认收起；第 0 层结构 | U: `planExpansionDefaults`（默认全关）、ExecutionShell/Card（waiting/failed 收起）；E: approval 收起、paced-plan `data-open="0"`、failed 收起 |
| 5 | 唯一 a/b、有效项口径、无 N steps / x-y done | U: `planProgress`/`effectivePlanItems`（unresolved 进分母）、metaParts 无 steps、RunPlan/RunSteps 第 1 层无分数、`occurrences("1/2")===1`；E: `cards never render invented percentages`（含 /\d+ steps/ 断言）、paced-plan `plan.innerText()` 无分数 |
| 6 | 无 Plan → 无进度 DOM/0/-- | U: ExecutionShell/Card"no rail without Plan"；E: failed-with-step（rail/count=0）、scenario B approval（rail/count/progressbar=0）、TC summary-only 守卫（U+E） |
| 7 | 无 Plan 审批可见可操作、不受折叠影响 | U: ExecutionShell/Card interventions-outside 系列、transcript region 测试；E: `pending approval stays discoverable…`（收起态 Deny enabled + attention 聚焦） |
| 8 | 失败两条查看路径 | U: shell failure-target 聚焦、RunSteps/RunPlan failed 自动展开、transcript failure-reason；E: `a failed Run shows the safe failure summary`（Run-level）、`a failed Run with a failed Step lands View reason on that Step's detail`（Step 级） |
| 9 | revision 倒退立即更新 + 3s 提示 + v2/changeReason | U: ExecutionShell flash（fake timers：增长闪、首见/相同/陈旧不闪、unmount 清理）、RunPlanDisclosure v2+changeReason；E: `a paced Plan revision moves the single a/b and flashes the update hint`（3/4→3/6 实时倒退 + flash 可见，4s/turn 确定性 pacing） |
| 10 | 第 1 层唯一列表；默认视图无 Todo | U: RunPlan（steps 不平铺、Other records 显式入口）、transcript（todos slot 不渲染）；E: paced-plan 第 1 层断言、`hides Todos behind Steps/Plan in the fixed degradation order` |
| 11 | Step 耗时/尝试/证据/异常/未确认只在第 2 层 | U: RunStepsDisclosure（第 1 层无 duration/attempt/evidence/resultSummary/batch；Details 后全部出现）；E: paced-plan（"Checked" 在 Details 前 count 0）、agentscope CI spec（匹配 Step 进 item 第 2 层） |
| 12 | 侧栏无数字/状态文字、aria、回焦 | U: `rosterAttentionIntent`、transcript ping 测试、既有 `agent-avatar.test.tsx`(17)/`bot-avatar.test.tsx` aria 断言；D: Shell.tsx 回退删除 diff；E: `clicking a waiting Bot in the sidebar focuses its approval control`（row 文本无分数/状态词 + 真实审批回焦） |
| 13 | 完成收成一行、结果只出现一次 | U: rev-keyed 展开语义、resultOnPage 去重；E: `a completed Run restores its card…`（恰一次）、paced-plan（outcome 行 0） |
| 14 | detail 失败 → 安全错误+重试；重试成功；第 0 层数字不变 0/-- | U: `execution-detail-request.test.ts`（5 转移测试）、transcript"shows a safe retry…recovers on retry"（1/1 保持、原文错误不泄漏、retry 用当前 target）+"keeps a failed detail request from clearing an already-cached detail"；E: `a failed detail load shows a safe retry and recovers`（route 注入 500 → 错误块无 raw text → unroute → Retry → 错误消失） |
| 15 | summary-only 无数字/进度 DOM/估算 | U: `TaskCenterView.test.tsx`"never renders a percentage…"（扩展：无 exc-rail/plan-count/progressbar/--）；E: task-center.spec TC 卡守卫（rail/count/progressbar=0、无 --）；transcript plain-reload（对话侧 summary-only 无 shell） |
| 16 | 固定降级顺序；事项清单全部规则；Todo 不触发卡片 | U: transcript fallback（收起时 slot 不在 DOM；展开后批准文案+条目；无 Todo/待办字样）+ degradation（Steps 压过 Todos）+ Todo-only 无 shell；`RunTodoList.test.tsx`（5 测试）；E: `a Todo-only Run never triggers…`（含 reload）、`the legacy 事项清单 fallback shows only in an expanded legal surface`（收起 count 0、展开可见、innerText 无 todo/待办/数字） |
| 17 | detail/legacy 双路径过滤 linked Todo；RunTodoList 独立单测 | U: `executionDataForRun Todo dedupe`（detail 路径、legacy 路径、跨 Run linkedStepId 不误杀——红测试先证明旧分歧）；`RunTodoList.test.tsx` 存在（5 测试） |
| 18 | 契约零 diff、零迁移、既有测试全绿 | D: `git diff 7599874..HEAD -- packages/contracts packages/db apps/api apps/worker services prisma` 为空（§6）；U: apps/web 全量 85 文件/649 测试绿；CI(#62): web-and-backend + agentscope 全绿（契约/DB/回放测试在 CI 门禁内） |
| 19 | 无 RunPlanRevision → 无 Plan slot/进度（含原生 plan_write） | D: Web Plan 数据源唯一（`ThreadSnapshot.plans`/`ExecutionSnapshot.plan`，本 diff 未新增来源；executor 提示词区分原生 plan_write 与 publish_run_plan 属既有后端行为，未改）；U: transcript"never synthesizes a Plan…"（planning Activity + Markdown 列表 + steps block 全部不产生）；E: plain/todo-only 场景无任何 Plan DOM |
| 20 | 无「已核验/已确认」暗示；证据引用数第 2 层可查 | D: `rg 已核验|已确认 apps/web/src apps/web/e2e` 0 命中；U: RunSteps 第 2 层 "N evidence references"；E: agentscope CI spec（真实 Java runtime 下 item 第 2 层展示 Step 结果） |

## 4. 门禁与数字

### C 开发中的定向门禁

- 定向 Vitest（任务卡 9 文件 + B 新增 4 文件，共 13 文件）：**191 / 191 绿**（4.4s）。
- `pnpm --filter @rakazo/web check`：0 错误；`@rakazo/adapters` tsc：0 错误。
- biome：触碰文件 0 错误。

### 整个 UX-01 批次的最终门禁（C 收口，一次性）

- `vitest run apps/web/src`：**85 文件 / 649 测试全绿**（7.0s；B 基线 83/631 → C 新增 `execution-detail-request.test.ts`、`RunTodoList.test.tsx`）。
- `pnpm --filter @rakazo/web build`：成功（>500kB chunk 警告为既有现象）。
- `intl:extract` + `intl:compile`：完成，zh-CN 填齐，`.po` 单独提交（`d36de3c`）。
- 三份 focused E2E（`test:e2e --spec="execution-card.spec.ts|execution-history.spec.ts|task-center.spec.ts"`，独立库 `workpal_e2e_ux01c` @ colima 5433，chromium，单次收口运行）：**38 / 38 passed（2.1m）**（execution-card 15、execution-history 9、task-center 14）。
  - 迭代记录：第一轮收口 34/38——①`long Activity paginates` 因 120 个相邻同构 publish 行被 Activity 折叠吞掉（既有 fixture 注释明确警告过需交替两种工具），修复为 trackedStepCalls 交替 shell echo；②stale-detail 测试在 waiting 卡上调用 expand（B 规则下 waiting 卡主动作是 attention 不是 toggle），展开时机移到 answer 之后；③scenario A 断言了 activity-flagged progress 的气泡文本，而该类块按既有产品规则任何模式都不渲染（`tool-activity-view.ts` 注释），改为断言 scripted 层诚实信号；④approval 测试的 "Denied" 回执断言与新规则竞态（plain Run 的 settled 回执是瞬态的，B 门禁两次通过属首查竞态幸存），改为确定性终态断言。修复后单独验证 2/2，再以全新数据库单次跑完整收口 38/38。
  - flake 观察：第一轮中 `task-center.spec.ts` 的 "a Run cleared after the list loaded"（本次未改动的测试）在 3 spec 并行、单后端高负载下一次超时，收口重跑通过——归类为负载 flake，非本次回归。
  - 收口期间的仓库级说明：`packages/adapters`/`packages/testkit` 的 7 个文件（5 个 agentscope `.integration.test.ts`、compose-installer-smoke、computer-replay）在本机失败，全部属既有 env-only 类别（需 JDK/Java runtime 与 Docker topology，本机不可用，见项目环境记录），不涉及 scripted-runtime 或本次改动路径；该仓库级门禁由 GitHub CI 执行（PR #62 上同类 CI 已全绿）。

## 5. 修改过的旧断言及产品理由（C 增量）

1. `execution-history.spec.ts` 六个测试的 fixture 全部从 plain/shell 变体切换为 tracked 变体（`write a tracked file…`、`run 2/60/120 tracked steps…`、`run 1 tracked steps echo beta-marker`、`show a tracked secret card…`）——产品规则（验收 1）使 plain tool Run 不再有执行区，而该 spec 的目的（rev 恢复、分页、单开、secret 边界、stale detail）需要合法执行区存在；tracked fixtures 经真实 publish_run_step 路径，工具事件数量与原 shell fixtures 相同，分页数学不变。断言逻辑本身零改动。
2. `execution-card.spec.ts`：approval 测试增加无 Plan 无进度 DOM 守卫（验收 6/场景 B 的 C 侧补强）；新增 scenario A 测试。既有断言未改。
3. `task-center.spec.ts`：「查看结果」测试增加 summary-only 无进度守卫（验收 15）；既有断言未改。
4. `TaskCenterView.test.tsx`：扩展"never renders a percentage"（rail/count/placeholder 守卫）；原断言保留。
5. `intervention-region.spec.ts` / `approval-resume.spec.ts` 的规则性更新属于 B 提交（见 B 交付说明 §5 第 13 条），C 未再改动。
6. `execution-history.spec.ts` stale-detail 测试：展开时机从 waiting 阶段移到 answer 之后——B 规则下 waiting 卡主动作是 attention（不是 toggle），waiting 卡无法经主动作展开；该测试的 route 拦截 glob 与实际 RPC URL 不匹配属既有状态，原样保留（见 §7.1）。
7. `execution-card.spec.ts` approval 测试：Deny 后的 "Denied" 回执断言改为确定性终态（region 消失、无可操作控件）——plain Run 的 settled 回执在新规则下是瞬态的，原断言依赖首查竞态幸存；回执渲染本身由 `InterventionRegion.test.tsx` 单测覆盖。scenario A 的 Stop 断言 scope 到 composer-bar（roster 行可访问名合法包含 preview 文本 "…i stop you…"，strict mode 冲突）。

## 6. 安全 diff 检查

- `git diff 7599874..HEAD --stat`：仅 `apps/web`（src/e2e/locales）与 `packages/adapters/src/scripted-runtime.ts`（测试 runtime fixtures）。
- `git diff 7599874..HEAD -- packages/contracts packages/db apps/api apps/worker services prisma`：**空**——6 个 Prisma 模型、3 个工具 schema、事件、`ExecutionSnapshot`/`ExecutionSummary` 契约零改动，零迁移（验收 18）。
- 无密钥、真实用户数据、私有 URL、本机身份信息；E2E 全部使用独立测试库（workpal_e2e_ux01b/ux01c），未接触生产或个人数据。

## 7. 偏差、观察与剩余风险

1. **既有观察（未改动）**：`execution-history.spec.ts` 的 stale-detail 测试用 `page.route("**/rpc/runs.executionSnapshot")` 拦截，而实际 RPC URL 是 `/rpc/runs/executionSnapshot`（点号 vs 斜杠）——该 route 很可能从未命中，测试实际以普通流通过。这是 C 之前的既有状态，本次仅切换其 fixture，未改变该测试语义；建议后续独立小 PR 修正 route 模式并验证竞态真被行使。
2. **验收 19 的证据等级**：scripted runtime 没有原生 `plan_enter/plan_write`（那是 Java runtime 的内部工具），E2E 层无法在 scripted 闭环里直接调用它；隔离由结构性事实（Web Plan 唯一来源是 `RunPlanRevision` 投影，diff 未新增来源）+ 单测守卫（Activity/Markdown/steps block 不产生 Plan）证明。原生 Plan Mode 与结构化 Plan 的统一属 UX-02。
3. `show a tracked secret card` fixture 的 semantic Step 在 Run 完成后由读投影标记为 `unknown`（"Status unconfirmed"）——诚实投影，secret 测试断言不涉及该 Step 状态。
4. detail 错误状态只在**打开的卡片**内呈现（第 2 层），收起的卡片不打扰；错误不写入 sessionStorage、不进快照（符合任务卡"不要把错误塞进 ExecutionSnapshot 或 sessionStorage"）。
5. `Todo-only 且成功` 的旧 Run 在对话中完全无执行区（三条核心规则优先于兜底）——事项清单只在合法执行区内出现，这是任务卡"Todo-only 矛盾"裁决的直接实现。
6. 翻译目录中其他 9 个 locale 的新字符串保持未翻译（与仓库既有状态一致），zh-CN 已按批准文案填齐。

## 8. 合并顺序

C PR 初始 base=`codex/ux01b-progress-convergence`；**B（PR #62）合入 main 后**把 C base 改为 `main`，此时 PR diff 自动只剩 C 的 5 个提交（红测试、实现、i18n、docs、roadmap 回填）。合并严格 B → C；两者都未合并、未部署，等待审查。UX-01 只有在 C 合入 main 且 main CI 绿后才可标 `done`。

## 9. 修复轮（2026-10-19 审查反馈：P3 + rebase）

### P3：summary revision 前进后旧加载错误未清理

- **缺陷（审查复现确认）**：请求状态只按 runId 键控——rev 5 请求失败后线程推进到 rev 6，rev 5 的错误仍然显示；且被取代请求的晚到失败可覆写新状态。违反任务卡"summary rev 前进、Thread/target 切换时不能显示旧错误；防止旧请求晚到失败重新写入"。
- **修复**：`DetailRequestMap` 条目改为 `{status, rev}`（请求发起时的 summary rev 戳记）；**读取按当前 rev 解析**——`entry.rev !== currentRev` 一律读作 idle，投影移动即自然失效旧错误，无需显式清理；`failDetailRequest` 对 rev 不匹配的条目整体忽略（晚到失败永不覆写）；in-flight 去重键改为 `runId@rev`（新 rev 的请求不被旧 in-flight 阻塞）。hook 三处调用点（toggle/intent/retry）传入各自 rev。
- **回归**：reducer 单测 2 条点名场景（"invalidates an old error when the summary revision moved on"、"a late failure from a superseded request never rewrites newer state"）+ transcript 集成 2 条（同 root 重渲染推进 rev 后错误消失；deferred promise 排序验证晚到失败不 surfaced、新请求成功渲染 detail）。红→绿：5 failed → 0。

### 第二轮审查（2026-10-19）：旧请求晚到成功清除新请求错误

- **缺陷（审查反向时序复现）**：`settleDetailRequest` 不检查 revision——A@rev5 在途、rev 前进后 B@rev6 失败并正确显示错误+重试，随后 A 晚到**成功**，settle 直接删除该 Run 的请求状态，rev6 的错误与重试入口被旧成功清掉（旧快照本身已被 rev-guard 丢弃，无法满足 rev6）。
- **修复**：`settleDetailRequest(map, runId, rev)` 只清理**自己拥有**的状态（`entry.rev === rev` 才删除）；hook 成功回调传入发起请求时的 rev。新请求的 loading 同样不被旧成功清除；owning settle 行为不变。
- **回归**：reducer 单测 2 条（stale success vs 新 error / vs 新 loading，含 identity 断言）+ transcript deferred-promise 集成 1 条（A@5 pending → rev6 → B@6 failed → 错误+重试可见 → A@5 晚到成功 → 错误+重试仍在、旧快照内容不渲染）。红 3 failed → 绿。
- 门禁：apps/web 全量 **85 文件 / 666 测试绿**（5.4s）、web check 0 错误、build 成功；三 spec E2E 收口以全新库 `workpal_e2e_ux01c3` 单次重跑：**38 / 38 passed（1.4m）**，0 失败 0 flake。

### Rebase 记录

- `git rebase --onto 2f2e757 7599874`：6 个 C 提交全部保留；两处冲突均为 B 修复轮与 C 的同款修改（`loadExecutionDetail.then` 的 rekey+settle 并存；approval E2E 的 Denied 终态断言注释措辞），按"两者都保留/取 B 版本"解决，无语义丢失。
- rebase 后全量验证：`@rakazo/web` check 0 错误、apps/web 全量 **85 文件 / 663 测试绿**（6.3s）、build 成功；三 spec E2E 收口以全新库 `workpal_e2e_ux01c2` 单次重跑：**38 / 38 passed（1.7m）**，0 失败 0 flake。
