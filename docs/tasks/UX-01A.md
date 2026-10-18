# UX-01A：Shell 执行区无行为变化拆分

状态：`delivered`。实施分支 `codex/ux01a-shell-extraction`，PR [#60](https://github.com/huiliuxu780/WorkPal/pull/60)（基线 `main @ ed1cf48`，冻结代码基线 `165aff70` 为其祖先）；冒烟基线先在原实现跑绿（`b0f3a44`），拆分提交 `51f9129` 搬移代码逐字节 verbatim。证据见 [UX-01A 交付说明](../ux/UX-01A-implementation.md)。

冻结代码基线：`main @ 165aff7068fcddb7667463ccc3769e2f174390b2`（Avatar stack #49–#55 全部以 merge commit 进入 `main`，最终 main CI run `39110281001` 全绿；未部署）。实现分支应从**包含本任务书的最新 `main`**创建，并证明该提交是其祖先；如果其后有任何产品代码改动，先重新核实本文代码事实和冒烟基线。

## 目标

从 Avatar stack 全部进入 `main` 后的最新提交开分支，把 `apps/web/src/pages/Shell.tsx` 中属于对话执行区的状态、锚定、详情加载、Task Center 回焦与渲染搬到独立模块。此次只降低 `Shell.tsx` 的职责和后续 UX-01B 的冲突面，产品行为、DOM 顺序、数据契约和视觉表现全部保持不变。

这不是 UX-01B。不要提前实现“普通请求不出执行区”、三层折叠、Plan 进度口径、侧栏状态收敛或 Todo 兼容规则。

## 开工基线

1. 从包含本任务书的最新 `main` 新建 `codex/ux01a-shell-extraction`，确认冻结代码基线 `165aff7068fcddb7667463ccc3769e2f174390b2` 是其祖先；不要接着使用废弃的 `refactor/shell-split-01`。如果冻结基线后出现了非文档代码改动，先重跑 preflight，不得直接沿用本文行号和结论。
2. 先读 `docs/ux/UX-01-decision.md`，本任务以其中 G4 和“UX-01A”边界为准。
3. 重新用 `rg -n` 定位下列符号，不依赖本文行号：
   - `Transcript`
   - `plansByAnchor`
   - `stepsByAnchor`
   - `todosByAnchor`
   - `executionsByAnchor`
   - `loadExecutionDetail`
   - `taskCenterFocus`
   - `renderExecutions`
   - `coveredAsks`
   冻结基线上的参考位置是：`Transcript:4852`、`coveredAsks:4940`、`plansByAnchor:4993`、`stepsByAnchor:5008`、`todosByAnchor:5027`、`executionsByAnchor:5046`、`loadExecutionDetail:5182`、`taskCenterFocus:5203`、`renderExecutions:5248`；这些行号只是定位证据，不是契约。
4. 修改实现前，先运行受影响 Web 类型检查与定向测试，并把命令、数量和结果写入交付说明。然后先补一条能覆盖 Shell 执行区装配行为的冒烟回归；它必须在原实现上通过，再开始拆分。

## 已核实的代码事实

以下结论已经在 Avatar stack 顶部代码核实。若最终 `main` 与这里不一致，应先记录差异并停下扩大范围，不能凭猜测改产品行为。

1. `InterventionRegion` 通过 `interventions` 交给 `ExecutionShell`，在可折叠详情外渲染；被 Intervention 覆盖的 Ask 消息由 `coveredAskMessageIds` / `suppressAsk` 隐藏。拆分后审批与输入卡仍须可见、可操作且不重复显示 Ask。
2. `ExecutionSnapshot.steps.items` 使用的 `RunStepSnapshotSchema` 已包含可空 `planItemId`。UX-01A 不使用它重排 Steps，也不改契约。
3. 当前 `serverSummaries` 会为窗口内每一个 Run 建立执行 Shell；没有锚点的失败 Run 会落到 `__tail`。这可能被 UX-01B 改掉，但本任务必须原样保留。
4. `TaskCenterView` 使用 summary，不加载对话页的完整执行区详情。对话页的 Task Center 返回意图由 `peekTaskCenterNavIntent` 消费，打开对应卡片并把焦点放到 Intervention 控件或状态行。
5. Java 原生 `plan_exit` 使用 `workpal-plan-approval` ASK 规则；适配器最终通过 `pauseRunForInput` 进入统一 Intervention 展示，但当前没有 `approvalEffectId`，数据库语义仍是 input。UX-01A 只保留现状。
6. 角色头像与上传头像已有状态化 `aria-label`，紧急状态使用 `aria-live="polite"`，内部状态点为 `aria-hidden`。本任务不改头像或 aria。
7. 16px 状态已有非颜色形状：working 圆点、approval 菱形、waiting 圆环、failed 警示形。不要重复修改 Avatar。
8. `messageById` 同时服务普通消息的回复预览和执行区锚定。只拆执行职责；可以把 Map 作为输入传给新模块，或在新模块内只读构造，不能连普通消息渲染一起搬走。

## 实施范围

### 1. 先补行为冒烟基线

在未拆分实现上新增一个稳定、面向行为的测试，至少同时证明：

- 同一 Run 的 Plan、semantic Steps、未关联 Todos 与前台 Activity 合并为一张执行 Shell，并保持当前锚点位置；
- server-summary-only Run 仍只出现一张 Shell；没有消息锚点的失败 Run 仍落到尾部；
- pending Intervention 位于折叠内容外，被覆盖的 Ask 不再作为第二张 Ask 卡出现；
- Task Center 返回意图仍能打开正确 Run，并把焦点放到既有目标。

可以把场景拆成少量定向测试，但不要复制内部 Map 实现作为断言。测试必须在搬代码前通过；交付说明要记录这个基线提交或至少记录先后顺序。

### 2. 抽出执行区控制器/模块

推荐新增 `apps/web/src/pages/shell/use-execution-transcript.tsx`，或采用职责同等清楚的命名。推荐边界是一个 Hook/控制器，输入执行区所需数据，输出：

- `coveredAskMessageIds`，供 `MessageView.suppressAsk` 使用；
- `renderExecutions(anchor)` 或等价的 `<ExecutionAtAnchor>` 渲染接口。

具体名称可以调整，但新模块必须完整拥有下面这些执行区职责，`Shell.tsx` 不再定义它们：

- `settledInterventions`、`shownInterventions` 和 covered Ask 推导；
- `serverSummaries`；
- 展开状态 `expansionEntries` 及 sessionStorage 语义；
- `executionDetails`、Activity 分页/加载锁和 stale revision 防护；
- `anchorOf` 以及 Plan / Steps / Todo / Activity / summary / Intervention / active Run 的锚定与合并；
- `loadExecutionDetail`；
- Task Center 返回意图的消费、打开和焦点重试；
- 每个锚点的 `ExecutionShell`、`ExecutionCard`、Intervention、Plan、Steps、Todo、Activity、Result 渲染。

`Transcript` 保留普通消息列表、滚动、选择引用、回复/表情、语音、后台任务和其他非执行区职责。不要为了减少参数顺手重写消息页状态管理。

### 3. 保持现有行为

拆分前后必须保持：

- 执行区相对消息的 DOM 顺序，包括 `before:<messageId>`、`messageId` 和 `__tail`；
- 同一 Thread 同时最多展开一张卡、revision 匹配和 sessionStorage 键/值语义；
- detail 新旧 revision 的整包替换规则、旧 Activity 页合并和 stale response 丢弃；
- server anchor 优先、分页外 anchor 不错误跳尾部、无消息失败 Run 的尾部兜底；
- transcript 气泡与 detached result 的去重；
- Intervention 合并、settled 状态、回答后的刷新，以及 Ask 抑制；
- Task Center 返回后的打开和焦点行为；
- 现有 `data-testid`、`data-slot`、aria、文案、CSS class 和翻译 key；
- 当前 active/failed 默认展开规则。UX-01B 才会删除运行中自动展开。

现有快照和 E2E 断言不得为了让重构通过而修改。允许新增测试；若任何旧断言确实必须变化，视为越界，先报告而不是更新断言。

### 4. 手工审查 Hook / effect 依赖

仓库的 Biome 配置关闭了 `useExhaustiveDependencies`。提交前逐项审查新模块中每个 `useMemo`、`useCallback`、`useEffect` 的读取值与依赖数组，并在交付说明列出结果。至少重点检查：

- `threadId` 切换后不能沿用旧 expansion、detail、focus 或 Intervention；
- summary `rev` 前进后不能渲染旧 detail；
- `messages` / `messageById` 变化后 anchor 必须重算；
- `interventions` settled/pending 变化后 Ask 抑制必须同步；
- `artifactTarget` 改变后 detail RPC 不能请求旧目标；
- Task Center intent 只消费一次，定时器卸载时清理。

不要借此“清理”与拆分无关的旧依赖或更改展开策略。

## 明确不做

- 不实现 UX-01B/UX-01C 的任何展示规则。
- 不改 `packages/contracts`、`packages/db`、Prisma、API、Java Runtime、工具 schema、事件或迁移。
- 不改 Plan / Steps / Todo 的含义、数量、排序、进度算法或关联方式。
- 不改 Task Center summary-only 边界。
- 不改 Avatar、侧栏状态、aria 或动效。
- 不增加 Router、模型提示词、模型调用或权限。
- 不恢复 `refactor/shell-split-01`；其中模块如后续需要，应从最新 main 独立重做。

## 验收标准

1. 分支从包含本任务书的最新 `main` 创建，冻结代码基线 `165aff7068fcddb7667463ccc3769e2f174390b2` 是其祖先；若其后有产品代码变化，preflight 已重新核实。PR diff 不包含其他旧分支提交。
2. `Shell.tsx` 不再定义 `plansByAnchor`、`stepsByAnchor`、`todosByAnchor`、`executionsByAnchor`、`loadExecutionDetail`、Task Center 执行卡回焦逻辑或 `renderExecutions` 主体。
3. 新模块的输入/输出只暴露执行区所需能力；普通消息、滚动、回复、语音和后台任务仍由 `Transcript` 管理。
4. 冒烟测试在原实现上先绿，拆分后继续绿，并覆盖锚定合并、summary-only、失败尾部兜底、Intervention/Ask 去重和 Task Center 回焦。
5. 现有执行卡、执行历史和任务中心测试文件的断言与快照不修改且全部通过；没有通过删除、skip、放宽 selector 或增大超时消除失败。
6. DOM 顺序、`data-testid` / `data-slot`、aria、文案、CSS class 和翻译目录没有行为性 diff。
7. 展开状态、revision cache、防 stale response、Activity 翻页、结果去重和 Intervention settle 行为保持不变。
8. 当前每个 server summary 都产生 Shell 的行为保持不变；当前 active/failed 默认展开规则保持不变。
9. `git diff` 中没有 contracts、db、Prisma、API、Java、工具、事件或迁移改动。
10. Hook/effect 依赖人工审查有逐项记录，没有已知 stale closure。
11. 类型检查、构建、定向单测和指定 E2E 全绿；提交前检查 `git status` 和 diff，无密钥、真实用户数据、私有 URL 或本机身份信息。
12. 交付说明记录最终文件边界、前后 `Shell.tsx` 行数变化、测试命令/数量/结果、偏差和风险；roadmap 只把 UX-01A 标为 done，UX-01 仍为 `in-progress`，下一切片为 UX-01B。

## 必跑验证

使用仓库锁定的 pnpm：

```bash
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web build

pnpm exec vitest run \
  apps/web/src/lib/execution-history.test.ts \
  apps/web/src/lib/execution-card.test.ts \
  apps/web/src/components/ai/ExecutionCard.test.tsx \
  apps/web/src/components/ai/ExecutionShell.test.tsx \
  apps/web/src/components/ai/RunPlanDisclosure.test.tsx \
  apps/web/src/components/ai/RunStepsDisclosure.test.tsx \
  <新增的 Shell 执行区冒烟测试>

pnpm test:e2e \
  --spec="execution-card.spec.ts|execution-history.spec.ts|task-center.spec.ts|<新增冒烟 spec（如有）>"
```

若新增的是 Vitest 冒烟测试，不要在 E2E 命令里伪造文件名。先用 `--list` 或 Vitest collection 输出证明实际收集到预期测试；最终报告分别写测试文件数与测试数。

## 交付物

- 实现分支：`codex/ux01a-shell-extraction`
- 新的执行区模块与冒烟回归
- `docs/ux/UX-01A-implementation.md`，包含：基线、模块边界、effect 依赖审查、验证结果、偏差与剩余风险
- `docs/next-work-roadmap.md` 回填 branch / PR / 测试结果；UX-01 保持 `in-progress`

## 停下并报告的条件

出现以下任一情况，不要自行扩大范围：

- 最终 main 与“已核实代码事实”冲突；
- 保持旧断言无法完成拆分；
- 需要改 contracts、db、API、Java 或迁移；
- 发现现有执行区行为本身有 P1/P0 缺陷；
- 必须同时落地 UX-01B 规则才能让测试通过。

报告真实基线、最小复现、受影响文件和两种可选处理，不要用新产品行为掩盖结构问题。
