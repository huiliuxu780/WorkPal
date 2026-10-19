# UX-02 实施记录：计划与审批完整统一

状态：已交付，等待验收。分支 `codex/planning-review-unification`，PR [#80](https://github.com/huiliuxu780/WorkPal/pull/80)（基线：共同任务文档提交 `ee8db3c`，其父即 `main @ 12fea0e`，已含 MR-01 #73 与 AG-05/08 #78）。一个功能 PR，整批一次收口；未部署。任务书：[UX-02.md](../tasks/UX-02.md)；保留的 UX-01 规则：[UX-01-decision.md](./UX-01-decision.md)。

## 1. 交付概览

用户现在只面对一份计划：Bot 制订 → 用户看到具体版本并**批准 / 提出修改 / 拒绝** → 批准后同一 Task/Run 恢复执行 → 重要修订重新审阅 → 完成或以 `plan_rejected` 明确终止。原生 `plan_enter/plan_write/plan_exit` 与结构化 `publish_run_plan` 操作**同一个** PostgreSQL 计划身份、内容版本与审批状态；没有隐藏或关闭任何一套，也没有第二条可获批的真相。

核心提交组（内部小步）：

1. `feat(contracts)` — typed plan_review 契约、事件、RPC feedback；
2. `feat(db)` — 统一计划服务（指纹/内容版本/审阅轮次/决定事务）+ 迁移；
3. `feat(executor)` — 桥接接线、执行边界守卫、阶段工具面、恢复与旧兼容、retry 豁免；
4. `feat(runtime)` — Java `PlanBridgeTool` facade、移除 `workpal-plan-approval` ASK、提示词；
5. `feat(web)` — `PlanReviewCard` 与展示/状态/侧栏接线、zh-CN i18n；
6. `test` — AG-03 registry、AG-04 baseline（trust-rules 逐字节不变）、PG 旅程、组件测试、e2e。

## 2. native → 产品计划/审阅映射表（任务书 §4 要求）

| 原生链（AgentScope 2.0.3） | 统一后的落点 | 权威 |
| --- | --- | --- |
| `plan_enter`（进入 PLAN 模式，只读阶段） | 后端工具（bridge 执行）：`runs.planPhase='planning'`；Java facade 成功后调 `HarnessAgent.enterPlanMode(ctx)`；原生 `PlanModeMiddleware` 只读拦截保留 | PG `runs.planPhase` |
| `plan_write`（原自由 Markdown 全量覆写） | 后端工具，**输入 schema 改为结构化**（goal/items/expectedRevision/changeReason，与 `publish_run_plan` 同一 `PublishRunPlanInputSchema`）→ `applyPlanSubmission(submit:false)` 落 PG 草稿；facade 用结果里的 plan 投影重写 `plans/PLAN.md` | PG `run_plans.current`（修订） |
| `plan_exit`（原 ASK `workpal-plan-approval` 泛审批卡） | 后端工具 → `submitDraftForReview` 开审阅轮次 → typed `plan_review` Intervention + `waiting_input` 暂停（bridge `paused` 协议，`ToolSuspendException`）；决定后**同一 executionId** 的桥接重放拿到 `approved` / `changes_requested(+feedback)` 结果；facade 据此 `exitPlanMode` / 重进 PLAN 模式 | PG `run_plan_reviews` + `interventions` |
| `PlanModeContextState`（planActive/currentPlanFile，随 AgentState 持久化） | 保留为**可恢复投影**：facade 用与原生工具完全相同的活状态通道（`RuntimeContext.resolveAgentState` + `PlanModeManager.enter/exit/writePlan`）由后端决定驱动；随 AgentState 持久化，暂停/重启后仍然存在（Java 测试断言 resume 流携带 PLAN MODE 横幅）。注意：库的系统提示横幅按**流**渲染一次，流中途 enter 的横幅从下一条流才可见；流中途的只读强制由 `PlanModeMiddleware.onActing`（每次工具调用）+ 后端 planPhase/审阅 gate 双层承担 | 投影 |
| `plans/PLAN.md` 工作区文件 | 保留为投影：每次携带 plan 的工具结果都从后端内容重写；文件尾部声明"以 plan_write/publish_run_plan 修改，勿直接写文件" | 投影 |
| `workpal-plan-approval` ASK 规则 | **删除**（RuntimeEngine + ToolSurfaceRefresh 两处）；不再出泛审批卡 | — |
| 结构化 `publish_run_plan` | 同一服务 `applyPlanSubmission(submit:true)`：首次发布即提交审阅；状态-only 重发布=进度修订；内容变化=新内容版本+暂停 | PG |

两入口互相可见：任何一侧写入，另一侧读取/修改得到同一 `planId`（`plan:{runId}`）与版本序列；`plan_exit` 不再额外产生第二张卡。

## 3. 规则决定（对应任务书 §3 U1–U4）

**U1 唯一计划与是否审阅**
- 每个 Run 一个 `run_plans` 行（planId 唯一）；`revision` 是执行进度轴，`contentVersion` 是审批依据轴。
- planning=auto 下模型自主决定是否规划；无 Router、无强制。planning=disabled（automation/bot_message 等）不提供任何 plan 工具（`selectBuiltinToolsForRun` 的 `planningEnabled` 门），不会产生无人审批的等待；辅助 scope 依旧零工具（RunRequest.validate 拒绝携带）。
- 提交（`plan_exit` 或 `publish_run_plan`）统一进入版本审阅并暂停，保留同一 Task/Run；草拟前读取资料不受影响（PLAN 模式只读阶段允许读工具与计划记录）。
- 计划审批只同意该版本执行方向：决定不产生 ExternalEffect、不发 `approval.requested/resolved`，逐工具审批与权限检查原样保留（批准后执行仍走全部现有 gate）。

**U2 审阅卡与三种动作**
- 新 Intervention kind `plan_review`，复用 `waiting_input` 状态与统一 Intervention 位置（折叠体外，`data-testid=intervention-region` 内、`.exc-details` 外）；`runs.waitKind='approval'`（决策等待：24h 窗口、头像"需要批准"态、summary-only 兜底诚实）。
- 卡显示 Bot 名、目标、`v{contentVersion}`、阶段列表（>8 折叠 + "显示全部"），全部来自后端投影（Intervention 行 `planReview` JSON + ask block 绑定），不解析 Markdown/工具日志。
- 动作固定三个，无"总是允许"；提出修改必须非空具体意见（服务端 `invalid_submission` 拒绝空白）；拒绝原因可选。
- 批准：owner-only + `planId+contentVersion` CAS 持久化（`run_plan_reviews` 记 actor/时间/feedback/来源/submissionId），`run.continue` 入队恢复；重复提交按 clientSubmissionId 幂等（accepted/applied=false），他人已处理返回 already_handled；过期版本返回 conflict 业务结果并刷新出当前卡，不静默套用到新内容。
- 拒绝：Run `cancelled`、`run.cancelled{reason:'plan_rejected'}`、`runs.error='plan_rejected'`，Task/版本/操作者审计保留，无后续工具发送，侧栏头像回到 Bot 真实状态（e2e 断言 idle）。

**U3 内容版本 vs 进度修订**
- 指纹 = sha256(规范化 goal + 有序 items 的 id/title)；状态/耗时/证据/reason 不入指纹。
- 指纹不变 → 进度修订（新 revision，不动 contentVersion，不弹审批）；指纹变化 → 新 contentVersion + 待审 + **先原子标记再允许前进**（暂停发生在同一工具调用内；执行边界另有 gate：`reviewStatus='pending'` 或 PLAN 阶段时 mutating 工具零外发被拒）。
- 完全相同内容（含状态）→ `unchanged`，不产生新修订/新审阅；同 executionId 重放 → `replayed`。规范化只吃空白差异（trim + 空白折叠），不猜语义。
- 模型不能自报"小改动"：轴由指纹决定。批准后发布重要修订同样强制重审（`approvedBasis ⇒ opensReview`）。

**U4 Plan / Steps / Todo 定位**
- Plan=唯一用户计划与审批/进度来源；Steps=执行记录（`planItemId` 关联，允许无 Plan 执行）；Todo=Agent 内部清单：不参与审批、不产生进度分母、不进 helper/后台面；提示词（platform / turn-policy-planning-auto / chat/plan-instruction / chat/step-instruction）已改写为单计划职责分工，不再引导维护两份"主计划"。
- 三张表未合并；旧数据 Plan→Steps→事项清单兜底沿用 UX-01（`RunTodoList` 仅在无 Plan 无 Steps 的展开详情出现）。

## 4. 迁移与兼容

迁移 `20261020090000_unified_plan_review`（纯增量，无破坏性变更）：
- `runs.planPhase TEXT`（null/planning/build；不进 `runs_snapshot_rev` 触发器列，不影响 UI 展开态）；
- `run_plans` + `contentVersion INT NOT NULL DEFAULT 1`、`contentFingerprint`、`reviewStatus`、`approvedContentVersion`、`approvedFingerprint`；存量行回填 `contentVersion = revision`，`reviewStatus NULL`；
- `interventions.planReview JSONB`（版本绑定 + 决定 + feedback 的净化投影）；
- `run_plan_reviews` 表：每轮审阅的持久审计（来源、toolExecutionId 配对、interventionId、decidedBy、feedback、decisionSubmissionId），`UNIQUE(runId, toolExecutionId)`，部分唯一索引保证每 Run 至多一个 pending 轮次。

兼容规则：
- **旧 Run/历史**：`reviewStatus NULL` = legacy 计划，按当前内容祖父豁免继续执行（进度更新不弹审批）；首次内容变化开第一轮真实审阅。旧执行记录展示不变（无 review 状态时披露层仍显示 `v{revision}`）。
- **旧版挂起的 native plan 审批**：旧 `workpal-plan-approval` ASK 卡（kind=input）原样可继续操作；Java `resumeConfirmation` 路径保留；恢复后原生 `plan_exit` 经 facade/bridge 走一次性兼容分支：由已回答的旧 ask（approve/reject，无 planReview 绑定）恰好决定一次，落 `legacy_native` 审计轮次（按恢复 executionId 键控，绝不重复批准/执行、不丢原 Run、不再出第二张卡）；后续同 Run 的新 `plan_exit` 永不重入该分支。纯 native（无 PG 计划行）的旧审阅同样终结并审计（round 记 `plan:{runId}` cv0）。
- **崩溃恢复**：提交事务与暂停事务之间崩溃 → 轮次 pending 且无 intervention → 下一次 attempt 启动时 `loadPendingPlanReviewRepair` 重新开出同一版本绑定的卡；Run 永不越过 pending 审阅继续执行。Worker/Java 重启读同一持久状态（AgentState 磁盘 + PG），决定从不存放在页面状态。
- **Clear/Stop/终态/superseded**：既有取消漏斗（`cancelRunsInTransaction → cancelPendingInterventions → transitionPending`）顺带结算轮次（cancelled/expired）与 `reviewStatus='cancelled'`；旧卡点击得到 already_handled/conflict，不能继续执行。
- **MR-01**：初始/动态/fallback 三条 schema 路径都经 `toolsForRetryRun`，plan 工具同样携带 `retryOperationId`；计划/步骤/待办记录被排除出 retry operation 匹配与操作清单（后继 Run 发布自己的计划、面对自己的审阅，不重发也不沿用旧批准）。

## 5. U-A01–15 证据矩阵

| ID | 证据 |
| --- | --- |
| U-A01 | Java `RuntimeIntegrationTest.unifiedPlanLifecyclePausesForBackendReviewAndResumes`（真实 jar：桥接执行、无 ask 卡、同 executionId 恢复、PLAN.md 投影断言）；PG `run-plans.postgres.test.ts`（两入口同一 planId/版本序列）；e2e `agentscope-product.spec.ts`（结构化发布经真实 Java 暂停→批准→完成） |
| U-A02 | AG-03 registry：ROUTINE/MESSAGING/AUTOMATION 集不含任何 plan 工具（`scenario-contract.test.ts` 36 例 + integration 真实边界捕获）；`auxiliary-isolation`（辅助 scope 422 拒绝、零工具、无 plan 泄漏）；`RunRequestPolicyTest.planToolsAreBackendOwnedAndRequirePlanningPolicy` |
| U-A03 | e2e `plan-review.spec.ts` 测试 1：恰好一张卡、region 内/`.exc-details` 外、目标+v1+条目、无 always-allow；组件测试 `PlanReviewCard.test.tsx`（>8 折叠/展开、三动作、feedback 必填） |
| U-A04 | e2e 测试 1：批准后同一 runId 恢复至 completed（真实 Worker `run.continue`）；审批前无副作用（暂停即无模型调用）；批准后工具审批不变（`executor-readonly-approval` 41 例）；HTTP fixture=真实 RPC |
| U-A05 | e2e 测试 2 + PG `intervention.postgres.test.ts`（request_changes→旧卡 Changes requested→同 Run v2→重审）；`run-plans.postgres.test.ts`（changes_requested 循环、旧批准不覆盖新版本） |
| U-A06 | e2e 测试 3（拒绝原因可选、cancelled、无 result 气泡、无 pending、头像 idle）；PG 断言 `run.cancelled{plan_rejected}`、轮次 rejected+decidedBy、无 `approval.resolved` |
| U-A07 | PG：进度修订不开轮次、内容变化开 v2、幂等重放不重复发卡（`unchanged`/`replayed`）；e2e paced 场景 v1→批准→v2 自动重审（`execution-card.spec.ts`） |
| U-A08 | e2e 测试 4：同 submissionId 重放 accepted、异 client already_handled、竞态 reject 不生效；PG：过期版本 CAS conflict、owner-only |
| U-A09 | 执行边界 gate：pending/PLAN 阶段 mutating 工具零外发（executor gate + 阶段工具面过滤，`filterToolsForPlanPhase`）；已发未知结果沿用既有 uncertain 语义（未触碰）；AG-05 撤权路径不变（`agentscope-tool-visibility` 4 例绿） |
| U-A10 | Java `legacyAskingPlanExitResumesThroughTheBridgeOnce`（合成旧 ASKING 状态→bridge 恰好一次、无第二张卡）；`PermissionRevokedResumeIntegrationTest` 绿；attempt-start repair（PG `loadPendingPlanReviewRepair` + executor 接线）；无 `workpal-plan-approval` 字符串残留于新流程 |
| U-A11 | e2e 测试 1/3：头像 `data-state=approval`（等待）/`idle`（拒绝后）；region 卡继承 `FOCUSABLE_CONTROL` 回焦（既有机制，plan 卡为首组）；Task Center 经 `deriveExecutionStatus`→attention verb 定位同一审阅（`task-center.spec.ts` 回归绿）；详情仍可展开（`execution-card.spec.ts`） |
| U-A12 | UX-01 定向回归全绿：`execution-card`/`execution-history`/`task-center`/`intervention-region` specs + web 674 单测（唯一 a/b、summary-only 兜底、detail-retry、失败原因、去重） |
| U-A13 | `manual-retry-reuse.test.ts` 13 例绿（plan 记录豁免后原语义不变）+ `PLAN_RECORD_OPERATION_KINDS` 过滤操作清单；e2e `manual-retry.spec.ts` 回归绿；后继 Run 新计划走新审阅（PG cycle 测试） |
| U-A14 | `ToolVisibilityRefreshIntegrationTest`（每次模型调用刷面）+ registry 阶段集：planning 阶段面=只读+计划记录（`filterToolsForPlanPhase`）；`retryOperationId` 三路保留（`toolsForRetryRun` 未绕过）；ME-00 边界不变（无新原生记忆写入：compaction 配置未动，`MemoryCompactionPurgeIntegrationTest` 10 例绿） |
| U-A15 | 迁移在真实 PG 落库（e2e harness `prisma migrate deploy` 全部成功）；i18n 22 条 zh-CN 翻译+编译；受影响包检查见 §6 |

## 6. 验证命令与原始计数（收口时点）

- Java：`JAVA_HOME=openjdk@21 mvn -f services/agent-runtime/pom.xml test` → **90/90**（新增 3 个统一计划测试 + 1 个策略测试；原 nativePlanLifecycle 被 bridge 化重写；含 facade 活状态投影修复后的复跑）。
- 仓库单测：`pnpm exec vitest run`（含 JAVA_HOME 时 jar-lane 全绿）→ **5646 例中除 1 个既有基线失败外全绿**：
  - `apps/api/src/execution-rpc.test.ts` 1 例为 **ee8db3c 基线固有失败**（已用干净树验证，与本批无关，未掩盖）；
  - `agentscope-provenance` 在满负荷并行下偶发（单独跑绿）；
  - 顺手修复 `packages/db/src/repos.test.ts` 基线期望（avatar body color 合并后未跟进的一行）。
- PG 契约测试：`VERIFY_DATABASE=1 DATABASE_URL=…/workpal_plans_src pnpm exec vitest run packages/db/src/run-plans.postgres.test.ts packages/db/src/intervention.postgres.test.ts` → run-plans **7/7**、intervention **27/27**（含新增 6 个 plan review 旅程）；execution-history/wait-timeouts/task-center PG 全绿。
- 生产链集成（真实 Java runtime + PG + createApp）：`scenario-contract.postgres.test.ts` **10/10**、`agentscope-offline.postgres.test.ts` **3/3**（CI 的两个 integration spec）。
- E2E（scripted，真实 API+Worker+PG+Web）：`pnpm test:e2e --spec=plan-review` → **4/4 passed (14.6s)**；受影响回归批 `execution-card|intervention-region|task-center|execution-history|manual-retry` → 修正 paced 断言后 `execution-card.spec` **16/16**，其余全绿（合计 43 例）。
- E2E（`--runtime=agentscope` 真实 Java）：`agentscope-product.spec` **6/6**（含重写后的 native Harness plan 统一旅程：结构化 plan_write → plan_review 卡 → UI 批准 → 桥接同 executionId 重放 → BUILD 完成，并断言旧泛审批卡与 "Allow plan_exit to continue?" 绝迹）；CI 三件套合计 **11/11**（budget-acceptance 3/3、capability-rules 2/2）。
- E2E（worker-chain，CI 选中）：**5/5 passed (8.6m)**，含 5.3 分钟 no-seam mid-run kill 恢复——attempt-start 计划审阅 repair 在真实 lease-loss 重试路径上零回归。
- AG-04 baseline：`AG04_WRITE_BASELINE=1` 再生成 25 个 fixture；`<content-trust-rules>` 段落经脚本逐字节对比 **25/25 不变**。
- 类型检查：contracts/db/adapters/core/api/worker/web `tsc --noEmit` 全绿；`mvn compile` 绿。

## 7. 与记忆线（ME-01/02）的共享接口协调

两线同携文档提交 `ee8db3c`。本批触碰的共享面及让位规则：
- **executor/工具面**：plan 工具加入 builtin 目录并在 `selectBuiltinToolsForRun` 按 planningEnabled 门控；未改动 memory/history 工具与 `loadRunHistoryMessages`。
- **TurnPolicy**：planning 值仍为 `disabled|auto`，未新增档位；`turnPolicyFromRun`/orchestration 未改。
- **prompt registry**：只改 planning 相关四个文件并重生成镜像；`content-trust-rules.md`、memory/durable 段落零触碰（字节断言保留）。
- **schema/rpc**：`resolveIntervention` 仅新增可选 `feedback`；`ThreadSnapshot` 未变形（planReview 走 InterventionView 与 ExecutionSnapshot 可选字段）——记忆线新增字段不会冲突。
- 截至本批收口，记忆线分支 `codex/memory-context-upgrade` 尚无提交；先合入的一方携带公共文档提交，另一方按任务书合最新 main 并核对自身 diff。
- **端口冲突事故记录（2026-10-20）**：`test:worker-chain` 使用固定端口（API 3120），与记忆线 worktree 同时段的一次运行冲突；本线在清场时误杀了记忆线占用 3120 的 API 进程，其当次运行受损。本线等待对方进程退出后完整重跑 worker-chain 5/5。**协调规则：两线不得并发运行 worker-chain（或任何固定端口 harness）；并发前先核对 3120/3121/3122 占用。**

## 8. 剩余限制（诚实清单）

1. **fixture 证明协议，不证明规划质量**：scripted/emulated 模型验证的是暂停-决定-恢复-版本语义；真实模型的规划质量与"何时主动规划"校准留待线上观察（任务书本批不新增 Router）。
2. `execution-rpc.test.ts` 基线失败未在本批修复（范围外，已验证为 ee8db3c 固有）。
3. PLAN.md 投影是尽力而为：写入失败仅记日志（PG 权威不受影响）；投影在每次携带 plan 的结果后重写，两次写入之间文件可能短暂落后于 PG。原生 PLAN MODE 系统提示横幅按流渲染（库行为），同一条流中途进入 PLAN 模式时横幅自下一条流可见；只读强制不受此影响（onActing 每次工具调用检查 + 后端 gate）。
4. 旧版纯 native（无 PG 计划行）挂起审批的兼容决定以 `plan:{runId}` cv0 轮次审计，无内容版本可绑定。
5. 群聊线程中计划审阅与其它 Intervention 同享"每 Run 至多一个 pending"约束；跨 Run 的多卡排序为 plan_review → approval → input。
6. `threads.answer`（deprecated RPC）不支持 feedback：经它对 plan_review 选择 request_changes 会得到 conflict；Web 使用 `threads.resolveIntervention`。
