# UX-01B：Execution Progress Convergence

状态：`not-started`

冻结基线：`main @ 1ba98958edf462d85a20006e03b144d51a54b647`（UX-01A 已经通过 PR #60 合入；`apps/web/src/pages/shell/use-execution-transcript.tsx` 是执行区唯一装配入口）。实现分支使用 `codex/ux01b-progress-convergence`。只有当该基线的 main CI 全绿后才开始写产品代码；若开始时 `main` 已前进，先重新核实本文代码事实。

产品来源：[UX-01-decision.md](../ux/UX-01-decision.md) 的三条核心规则、§2、G5 和验收 1–13。UX-01A 的边界与证据见 [UX-01A.md](./UX-01A.md) 和 [UX-01A-implementation.md](../ux/UX-01A-implementation.md)。

## 目标

把当前“每个 Run 都可能出现一张执行卡、Plan/Steps/Todo 各有一套折叠和数字”的展示收敛为一个可信的三层执行区：

- 第 0 层：状态、标题、唯一的 Plan 进度、当前项和主操作；
- 第 1 层：唯一列表，有 Plan 显示 Plan，没有 Plan 显示 semantic Steps；
- 第 2 层：semantic Step 的耗时、尝试、证据、异常，或 Run-level failure reason。

执行区出现条件只能是：有结构化 Plan、有 semantic Step、有 pending Intervention、或者 Run failed。Todo、工具 Activity、Markdown、原生 `plan_write` 和普通 running 状态都不能自行制造执行区或 Plan 进度。

## 开工前事实核验

先重新定位并记录下面的符号，不依赖本文行号：

```bash
rg -n "buildExecutionCardModel|lifecycleRailFill|metaParts" apps/web/src/lib/execution-card.ts
rg -n "ExecutionCard|ExecutionShell|openByDefault|renderExecutions" \
  apps/web/src/components/ai apps/web/src/pages/shell/use-execution-transcript.tsx
rg -n "RunPlanDisclosure|RunStepsDisclosure|RunTodoList" apps/web/src/components/ai
rg -n "item.chat.preview|item.chat.status|BotAvatar" apps/web/src/pages/Shell.tsx
rg -n "useAvatarCatalog|BotAvatarState" packages/ui-web apps/web/src
```

在冻结基线上已经核实：

1. `ExecutionCardModel.railFill` 与 `lifecycleRailFill()` 当前按 semantic Steps 计算；`.exc-rail` 无论有没有可信进度都会存在。UX-01B 必须改成只由结构化 Plan 产生进度，并在无 Plan 时不渲染任何进度条/底轨。
2. `metaParts()` 当前把 `ExecutionSummary.counts.steps` 显示成 `N steps`；`RunStepsDisclosure` 还显示 `x/y done`；`RunPlanDisclosure` 又显示一份 `a/b done`。这是三套冲突数字。
3. `RunPlanDisclosure` 和 `RunStepsDisclosure` 各自拥有 `<details>`，并在 `live` 时自动展开；`use-execution-transcript.tsx` 的 `openByDefault` 也会自动打开 active/failed Run。
4. `InterventionRegion` 已经在 `.exc-details` 外面，Ask 去重由 `coveredAsks` 负责。收起详情不能隐藏审批/输入控件。
5. `ExecutionSummary` 没有 Plan 计数或 Plan item 时间；`RunPlanRevision` 有 revision/changeReason，`RunStepSnapshot` 有 `planItemId`、`startedAt`、`completedAt`、`attemptNumber` 和 evidence。
6. `loadExecutionDetail()` 当前吞掉错误；重试属于 UX-01C，本任务不要提前设计一个不完整的错误状态。
7. 侧栏 Bot 行第二行当前在 preview 为空时回退显示原始 `item.chat.status`；该状态文字必须移除。头像的可信状态来自 `AvatarCatalogProvider` / `BotAvatarState`，不是这个字符串。
8. `BotAvatarState` 已包含 `state`、`runId`、`revision`；Bot 数据已包含 `threadId`。如侧栏回焦需要读取状态，允许从 `@rakazo/ui-web` 导出已有 `useAvatarCatalog`，不得新增第二份状态源。

修改前先运行 Web 类型检查和定向测试并记录基线。任何上述事实不成立时，先在交付说明记录偏差，再决定最小调整；不要扩展 contracts/DB 来绕开 Web 限制。

## 边界裁决

### B 与 C 的“旧数字清理”

UX-01B 验收 5、6 已要求用户界面不再出现 `N steps`、Steps 的 `x/y done` 或无 Plan 的进度条，因此所有**影响生产展示**的删除必须在 B 完成。UX-01C 所说的“清理旧数字”只指兼容路径、残留测试、翻译目录和 E2E 证明，不能把 B 的可见行为拖到 C。

### 当前项耗时

Plan item 没有开始时间。只有当当前 Plan item 能通过 `planItemId` 关联到可信 semantic Step，且该 Step 有合法 `startedAt` 时，才显示“当前：… · 已 N 分钟”。没有可信时间时只显示当前项，不得用 `Run.startedAt`、`ExecutionSummary.startedAt` 或 `plan.createdAt` 冒充 item elapsed。

### Todo 不属于本任务

UX-01B 默认不渲染 Todo 列表。旧 Todo 的“事项清单”兼容兜底由 UX-01C 实现；B 不得让 Todo 单独触发执行区。

## 实施要求

### 1. 建立纯展示模型

把下列判断集中在可单测的纯函数中，推荐放在 `apps/web/src/lib/execution-card.ts` 或一个同职责的新模块：

- `shouldRenderExecutionSurface`：只认 Plan、semantic Steps、pending Intervention、failed；
- Plan 有效项：排除 `skipped` 和 `superseded`，`unresolved` 进入分母、不进分子；
- 唯一 Plan progress：`completed / effective total` 和 0..1 fraction；
- 当前 Plan item：优先 active，其次 unresolved；
- 当前项 elapsed：只来自匹配 `planItemId` 的可信 Step 时间；
- 第 1 层模式：`plan | steps | none`；
- failed Step 与 Run-level failure 的目标选择。

纯函数不得读取 DOM、RPC、全局状态或原始 runtime error。

### 2. 第 0 层

`ExecutionCard` / `ExecutionCardModel` 收敛为：

- 状态图标和状态文本继续来自现有 `deriveExecutionStatus`；
- 保留可信标题、Intervention 文本、结果去重、产物与非 Step 元数据；
- 有 Plan 才渲染一个可访问的进度条和一个 `a/b`，两者使用同一纯函数结果；
- 无 Plan 时不渲染进度 DOM、底轨或扫光；
- 删除 `N steps` 元数据；
- running/failed 默认收起；用户显式展开和“同线程只开一张”规则继续有效；
- failed 主操作是“查看原因”，普通复杂执行是“查看进展”，展开后是“收起”；
- Intervention 主操作继续聚焦第一个可操作控件，控件始终在折叠体外；
- 终态结果只在消息气泡或离页 Result 中出现一次。

Plan revision 从同一已挂载 Run 的已见 revision 增长时，第 0 层显示 3 秒“计划已更新”提示并使用 `aria-live="polite"`；初次挂载、首次加载 detail、线程切换、相同 revision 或陈旧回包都不能闪提示。定时器卸载/更新时必须清理。

### 3. 第 1 层与第 2 层

重构现有 `RunPlanDisclosure` / `RunStepsDisclosure`，或者新增一个统一组件；最终 DOM 只能有一套第 1 层列表：

- 有 Plan：第 1 层显示 goal、`v{revision}`、changeReason 和 Plan items；
- 无 Plan、有 Steps：第 1 层显示 Step 标题列表；
- Plan 和 Steps 同时存在：Steps 不再作为第二套列表平铺；按 `planItemId` 进入对应 Plan item 的第 2 层，未关联 Steps 放在一个明确的“其他执行记录”入口，不得丢失；
- 第 2 层才显示 Step 的 duration、attempt、evidence、resultSummary、异常和“部分状态未确认”；
- 点击 failed 的“查看原因”时，有 failed Step 就打开并定位到该 Step；没有 failed Step 就展示安全的 `summary.failure`，不显示 raw error。

保持现有 `data-slot="plan|steps|todos|activity"` 的语义可追踪性，但不要求继续保留旧的嵌套 `<details>` 结构。任何 selector 变化要在交付说明列出，并更新有意受影响的测试。

### 4. 普通请求与轻量状态

在 `use-execution-transcript.tsx` 形成执行数据后再做 surface eligibility 判断：

- 普通 running Run 没有四项触发条件时，不创建 `ExecutionShell`；
- 可以沿用现有 progress message 的单行浅灰状态，不另建第二份 Run 状态组件；
- 最终回复/Run 结束后该轻量状态必须从 DOM 消失；
- Activity 或 `MessageBlock.kind="steps"` 不能被误判为 semantic Step。

### 5. 侧栏

- Bot 行第二行只显示真实 preview；preview 为空时保持空，不回退到 `item.chat.status`；
- 不显示数字或“运行中/等你/失败/完成”等状态文字；状态只由现有头像徽标表达；
- 保持头像的非颜色 shape cue 和可信 `aria-label`；可访问名称必须包含 Bot 名和当前状态；
- 点击 approval/waiting Bot 时，复用 `BotAvatarState.runId` + `Bot.threadId` 和现有 Task Center nav intent，让目标 Thread 加载后聚焦 Intervention 第一个可操作控件；无可信 runId 时只导航，不猜测；
- 不增加新 RPC、URL 状态或 browser storage。

### 6. i18n 与视觉

继续使用 `@rakazo/ui-tokens`、`@rakazo/ui-web` 和现有 execution-card CSS。新增或修改的 Lingui 文案必须 extract/compile；`.po` 更新在 UX-01B 内单独提交，不能推迟到 C。不要重新设计 Avatar 或执行卡视觉语言。

## 明确不做

- 不改 contracts、Prisma、API、Worker、Java Runtime、工具 schema、事件或迁移。
- 不增加 Plan item 时间字段、Plan summary counts 或 eager detail RPC 来追求数字。
- 不把 Todo 作为执行区触发条件；不实现 UX-01C 的旧数据兜底、detail retry 或 E2E 收口。
- 不实现 UX-02 的 Plan Review、原生 Plan Mode 合并或 Todo 工具重定义。
- 不恢复 Electron/移动端，不部署。

## 验收标准（对应决策 1–13）

1. 没有 Plan、semantic Step、pending Intervention、failed 的 Run 不产生 execution shell，也不产生 plan/steps/todos slot 或相关字样。
2. 普通请求运行中最多只有现有单行轻量状态，无数字；最终回复后从 DOM 消失。
3. 一个 semantic Step 也能产生执行区；工具 Activity/消息 steps block 不能冒充 semantic Step。
4. 复杂执行默认收起；有 Plan 时第 0 层只有一份 Plan `a/b` 和进度条，并显示可信当前项/可得时长。
5. 同一卡片最多一个 `a/b`；有效项口径正确；不存在 `N steps` 或 Steps `x/y done`。
6. 无 Plan 时完全没有进度条 DOM、底轨或扫光，也没有 `0`、`--` 或估算数字。
7. 无 Plan 的 pending Intervention 仍可见、可操作、不可被详情折叠隐藏；Allow/Reject 流程不回归。
8. 无 Plan 的 failed Run 有失败提示和“查看原因”；有 failed Step 定位 Step detail，没有 Step 展示安全的 Run-level failure。
9. Plan `3/4 → 3/6` 等 revision 增长立即更新数字，提示“计划已更新”3 秒；第 1 层显示 revision 和 changeReason。
10. 第 1 层只有一套列表，默认视图不显示 Todo。
11. Step duration/attempt/evidence/异常/未确认只在第 2 层出现。
12. 侧栏无进度数字和状态文字，头像状态可被读屏识别；点击 waiting/approval Bot 后聚焦目标 Intervention 控件。
13. 完成后卡片收成一行，结果正文在页面中只出现一次。

另外必须保持：同 Thread 只展开一张、sessionStorage rev 语义、stale detail 防护、Ask 去重、Task Center summary-only 不猜 Plan 进度。

## 必跑验证

先写/更新纯函数与组件测试，再改实现。至少覆盖：四项 surface 条件、Plan 分母口径、无 Plan 零进度 DOM、revision flash、三层列表、failed 两种路径、Intervention、侧栏 aria/回焦、普通请求轻量状态消失。

```bash
corepack pnpm --filter @rakazo/web check
corepack pnpm --filter @rakazo/web build

corepack pnpm exec vitest run \
  apps/web/src/lib/execution-card.test.ts \
  apps/web/src/lib/execution-history.test.ts \
  apps/web/src/components/ai/ExecutionCard.test.tsx \
  apps/web/src/components/ai/ExecutionShell.test.tsx \
  apps/web/src/components/ai/RunPlanDisclosure.test.tsx \
  apps/web/src/components/ai/RunStepsDisclosure.test.tsx \
  apps/web/src/pages/shell-execution-transcript.test.tsx \
  apps/web/src/lib/avatar-runtime.test.tsx \
  packages/ui-web/src/agent-avatar/agent-avatar.test.tsx

corepack pnpm --filter @rakazo/web intl:extract
corepack pnpm --filter @rakazo/web intl:compile
```

运行现有 `execution-card.spec.ts` 和 `task-center.spec.ts` 做定向 E2E 回归；UX-01C 再补 A/B/C 新场景并跑完整三 spec。禁止通过 skip、扩大 timeout、删除断言或放宽 selector 消除失败。

## 交付与连续开发

1. 提交 `docs/ux/UX-01B-implementation.md`，记录前后 DOM/模型、测试数量、偏差、已知风险和所有有意更新的旧断言。
2. 更新本任务状态与 roadmap：PR 未合并时 UX-01 保持 `in-progress`，写 `delivered, ready-to-merge`；只有 main 合入后才能写 B done。
3. 推送 `codex/ux01b-progress-convergence` 并创建 base=`main` 的 PR，不自行合并。
4. B 的定向门禁全绿且接口稳定后，不等评审空转：从 B 的精确 head 创建 `codex/ux01c-compatibility-e2e`，按 UX-01C 任务卡继续。本地/PR diff 必须能分别审查 B 和 C。

