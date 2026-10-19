# UX-01C：Compatibility, Retry and E2E Closure

状态：`done`（PR [#63](https://github.com/huiliuxu780/WorkPal/pull/63) 已于 2026-10-19 以 merge commit `dcc73c5` 合入 main——B 合入后 base 已改 `main` 并确认 diff 仅含 C 的 26 个文件；含审查修复轮 P3（rev 戳记请求状态）与第二轮 settle 所有权修复；20 条验收矩阵见 [UX-01C-implementation.md](../ux/UX-01C-implementation.md)；未部署）

依赖：UX-01B 的实现、定向门禁和接口边界已经完成。开发分支 `codex/ux01c-compatibility-e2e` 必须从 UX-01B 的精确已验证 head 创建；初始 PR base 指向 `codex/ux01b-progress-convergence`。B 合入 main 后再把 C 的 base 改成 `main`，确认 PR diff 只剩 C。

产品来源：[UX-01-decision.md](../ux/UX-01-decision.md) 的 §2.6、G6 和验收 14–20；B 的行为契约见 [UX-01B.md](./UX-01B.md)。

## 目标

在 UX-01B 已经完成执行区出现条件、三层结构和 Plan-only 进度之后，闭合兼容性和失败路径：

- detail 加载失败有诚实、可重试的状态；
- summary-only 永不猜进度；
- 旧 semantic Steps / Todo 数据按固定顺序降级；
- detail 与 legacy 两条 Todo 去重路径一致；
- 原生 `plan_write` 不会变成结构化 Plan；
- 用单测和 A/B/C E2E 把 UX-01 的 20 条验收整体封口。

本任务不是继续改 UX-01B 的产品规则。若 B 的验收 1–13 尚未通过，应回到 B 修复，不能把缺口包装成 C 的“兼容工作”。

## 已核实的基线缺口

在 `main @ 1ba9895` 上已经核实，开始 C 时要在 B head 重新定位：

1. `loadExecutionDetail()` 当前 `.catch(() => undefined)`，用户看不到失败，也没有 retry；错误不能写入 `ExecutionDetailCache`，否则会与 rev-versioned snapshot 混为一谈。
2. `executionDataForRun()` 的 detail 分支直接返回 `detail.todos.items`；legacy 路径在进入该函数前已经过 `unlinkedRunTodos()`。同一个 linked Todo 在两条路径结果不一致。
3. `RunTodoList` 当前标题为 `To do`，默认直接渲染；冻结规则要求只有合法执行区已经存在、且 Plan/Steps 都不存在时，展开后才显示“事项清单”。
4. `TaskCenterView` 只有 `ExecutionSummary`，没有 Plan；它不得从 `counts.steps`、Activity 或状态推导 Plan 进度。
5. `ExecutionSummary.failure` 是安全投影；raw Run/Attempt error 不得进入卡片。

## 边界裁决

### Todo-only 矛盾

三条核心规则优先于旧数据兜底：Todo **单独存在不能创建执行区**。只有执行区已因 Plan、semantic Step、pending Intervention 或 failed 合法存在，且展开数据没有 Plan/Steps 时，旧 Todo 才显示为“事项清单”。因此普通、成功、仅 Todo 的旧 Run 仍不显示执行区。

### Summary counts

`ExecutionSummary.counts.steps` 可以作为摘要元数据存在，但不能显示成 `N steps`、不能作为 Plan 进度，也不能产生 0/`--`。C 不扩展 summary contract。

### B/C 测试分工

B 已经移除生产可见的旧数字。C 负责搜索和清除剩余兼容分支、测试/快照与翻译残留，并以完整 E2E 证明它们没有从历史/summary 路径回流。

## 实施要求

### 1. Detail 加载状态与 Retry

在 `use-execution-transcript.tsx` 为每个 Run 建立独立的 detail request 状态，至少区分 `idle | loading | error`：

- 状态与 `ExecutionDetailCache` 分离；已有 summary、Plan 进度和卡片头不能因请求失败被清空或改成 `0`/`--`；
- 打开需要 detail 的卡片时加载；失败后第 2 层显示稳定的安全文案和“重试”，不显示原始网络/服务错误；
- Retry 使用当前 `artifactTarget` 和 runId；防止重复并发请求；
- 成功后清 error；summary rev 前进、Thread/target 切换时不能显示旧错误；
- 卸载或晚到回包不能覆盖另一个 Thread/target 的状态；继续使用现有 snapshot rev guard；
- Activity “Load earlier” 的错误不在本项范围，除非实现共享状态时必须改动，届时单独记录。

推荐把 request 状态和转移写成纯 helper/reducer并单测，不要把错误塞进 `ExecutionSnapshot` 或 sessionStorage。

### 2. 固定降级顺序

第 1 层严格使用：

1. 有结构化 Plan：显示 Plan；
2. 无 Plan、有 semantic Steps：显示 Steps 标题；
3. 无 Plan、无 Steps、执行区因其他合法条件存在且有未关联 Todo：展开后显示“事项清单”。

事项清单要求：

- 收起时完全不在 DOM；
- 标题/前言使用“这次运行没有计划，以下是当时的事项清单”或等价批准文案；
- 用户可见文字不得出现 `Todo` 或“待办”；
- 不显示数量、分数或进度条；
- 只显示未被 semantic Step 关联的 Todo。

### 3. 两条 Todo 路径一致

把 `unlinkedRunTodos()` 接到 `executionDataForRun()` 的 detail 分支，并保证 legacy 路径仍得到同样结果。测试必须使用：

- Step S1；
- Todo T1，`linkedStepId=S1`；
- Todo T2，未关联。

detail 和 legacy 两条路径都只能返回 T2。补 `RunTodoList.test.tsx`，覆盖排序、批准文案、收起隐藏和禁止词。

### 4. Summary-only 与原生 Plan Mode

- Task Center 和对话历史里的 summary-only 卡片没有 Plan 时不显示数字、进度条 DOM、底轨、`0`、`--` 或估算值；
- 失败 summary 仍显示安全原因和可导航/查看原因动作；
- 只有原生 `plan_enter/plan_write/plan_exit`、工具 Activity、Markdown 列表或 `MessageBlock.kind="steps"` 的 Run，若没有 `RunPlanRevision`，不得产生 Plan slot 或 Plan progress；
- 不为满足测试改 contracts、DB 或提示词。

### 5. 文案与证据语义

搜索 Web 源码、测试和翻译目录中的进度文案：

```bash
rg -n "steps|done|Todo|待办|已核验|已确认|progressbar|exc-rail" \
  apps/web/src apps/web/e2e apps/web/src/locales
```

只删除/修改与 UX-01 规则冲突的呈现；不要误删普通工具步骤或其他业务文案。进度不得暗示外部事实已经核验，Step evidence reference 数量仍能在第 2 层查看。

### 6. A/B/C E2E

在现有 `execution-card.spec.ts`、`execution-history.spec.ts`、`task-center.spec.ts` 中补稳定场景，优先复用真实产品 fixture/RPC，不在页面注入内部 Map：

- **A 普通请求**：无 Plan/semantic Step/Intervention/failure；运行中最多轻量状态，最终回复后无 execution shell、plan/steps/todos slot 和进度 DOM。
- **B 无 Plan 审批/失败**：审批卡在折叠体外可操作；失败有 Step 时定位 Step detail，无 Step 时显示 Run-level reason；两者均无进度条。
- **C 有 Plan**：默认收起；唯一 `a/b` 按有效项计算；revision `3/4 → 3/6` 可倒退并提示更新；第 1 层一套列表，第 2 层才见证据；结果不重复。
- **兼容补充**：summary-only 无进度、detail 首次失败后 Retry 成功、Todo-only 不触发 surface、合法卡片里的 Todo fallback 只在展开后出现、Task Center 返回仍正确。

测试要通过稳定 testid/role/accessible name 定位；不得依赖动画毫秒、网络睡眠或宽泛文本 locator。revision flash 使用可控时钟或确定性事件，不等待真实 3 秒。

## 明确不做

- 不改 UX-01B 的四项 surface 条件和 Plan-only 口径。
- 不改 contracts、DB、Prisma、API、Worker、Java Runtime、工具 schema、事件或迁移。
- 不增加 summary Plan counts，不为了历史数字 eager-load 所有 detail。
- 不实现 Plan Review、原生 Plan Mode 合并、Todo 工具重定义或 manual retry。
- 不做 CI-01 路径优化；那是独立任务。
- 不部署。

## 验收标准（对应决策 14–20）

14. Detail 加载失败显示安全错误和“重试”；重试可成功；第 0 层已有 Plan 数字保持原值，不变成 `0`/`--`。
15. Summary-only、拿不到 Plan 的卡片没有数字和任何进度 DOM，也没有估算值。
16. 降级顺序固定；旧 Todo 只在合法执行区展开、且没有 Plan/Steps 时显示“事项清单”；Todo 单独不触发卡片；用户文案无 `Todo/待办` 和数字。
17. `executionDataForRun` 的 detail 与 legacy 路径都过滤 linked Todo；`RunTodoList` 有独立单测。
18. 6 个 Prisma 模型、3 个工具 schema、事件、`ExecutionSnapshot` / `ExecutionSummary` 均无 diff，没有迁移；现有相关测试全绿。
19. 没有 `RunPlanRevision` 的 Run，包括只用过原生 `plan_write` 的 Run，不出现 Plan slot 或 Plan progress。
20. 进度文案不出现“已核验/已确认”等外部事实暗示；第 2 层 evidence reference 仍可查看。

同时复验 UX-01B 1–13，无回归才能把 UX-01 整体判定为完成。

## 必跑验证

### C 开发中的定向门禁

```bash
corepack pnpm --filter @rakazo/web check
corepack pnpm --filter @rakazo/web build

corepack pnpm exec vitest run \
  apps/web/src/lib/execution-history.test.ts \
  apps/web/src/lib/execution-card.test.ts \
  apps/web/src/components/ai/ExecutionCard.test.tsx \
  apps/web/src/components/ai/ExecutionShell.test.tsx \
  apps/web/src/components/ai/RunPlanDisclosure.test.tsx \
  apps/web/src/components/ai/RunStepsDisclosure.test.tsx \
  apps/web/src/components/ai/RunTodoList.test.tsx \
  apps/web/src/pages/shell-execution-transcript.test.tsx \
  apps/web/src/components/ai/TaskCenterView.test.tsx
```

### 整个 UX-01 批次的最终门禁

```bash
corepack pnpm exec vitest run apps/web/src

corepack pnpm test:e2e --spec="execution-card.spec.ts|execution-history.spec.ts|task-center.spec.ts"

corepack pnpm --filter @rakazo/web intl:extract
corepack pnpm --filter @rakazo/web intl:compile
```

记录实际文件数、测试数、数据库/浏览器环境和耗时。若 E2E 需要 PostgreSQL，使用独立测试库；不得复用生产或个人数据。提交前用 diff 证明没有 contracts/DB/Prisma/API/Java/迁移改动，并检查无密钥、真实用户数据、私有 URL 或本机身份信息。

## 交付与合并顺序

1. 提交 `docs/ux/UX-01C-implementation.md`，按 20 条验收给出证据矩阵，区分单测、E2E 和仅由代码 diff 证明的项目。
2. C PR 初始 base=B 分支；B 合入后改 base=`main`，确认 diff 只剩 C。不要 squash 掉 B/C 边界，也不要自行合并。
3. B、C 可以连续开发和评审；合并必须按 B → C。若两者 PR head 都基于相同已验证 ancestry 且树未变化，不机械重复本地全套测试；C 的最终门禁是批次完整证据。
4. C 合入 main 且 main CI 绿后，roadmap 才把 UX-01 标成 `done`，并链接 B/C PR、两份交付说明和最终 20 条证据。未部署。
