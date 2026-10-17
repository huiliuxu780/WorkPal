# UX-01 决策：Plan / Todo / Steps 展示收敛

> **状态：决策已由徐哥于 2026-10-18 02:16（UTC+8）亲自批准。UX-01 仍是 in-progress，不是 done。**
> 本文计划放进仓库的 `docs/ux/UX-01-decision.md`，目前只是 box 上的稿子，还没进仓库，roadmap 也没改。
> 代码行号按 `codex/dep01-deploy-rehearsal @96283eb`。#54 和 #55 合入后，`Shell.tsx` 的行号会偏移（#54 改了 +19/−8，#55 改了 +107/−1），开工时以最新 main 为准，重新定位。
> 依据：`REQ-plan-todo-steps.md`、`ux-notes.md`、`code-facts.md`、`gpt-advice-review-product.md`、`gpt-advice-review-dev.md`、`gpt-advice2-review-dev.md`、`prototype/`。

---

## 0. 三条核心规则（写死，任何实现都不能违反）

1. **执行区是否出现，不由 Plan 决定。** 一个 Run 只要满足下面任意一条，就**必须**有执行区（Execution surface）：
   - 有结构化 Plan；
   - 有 semantic Step；
   - 有 pending 的 Intervention（approval 或 input）；
   - Run 失败（failed）。
2. **进度数字和进度条只看结构化 Plan。** 有 Plan 才显示「a/b」和进度条；没有 Plan，两者都不显示，也不能用 Steps 或 Todo 凑一个出来。
3. **Intervention 和失败，永远不能因为没有 Plan 而被隐藏。**

徐哥给的三个示例：

```
① 没有 Plan，等审批            ② 没有 Plan，失败              ③ 有 Plan
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│ 需要你的批准              │  │ 执行失败                  │  │ 正在整理发布方案      3/5 │
│ 允许这个操作继续吗？      │  │ 无法访问数据源            │  │ ██████░░░░               │
│ [允许]  [拒绝]            │  │ 查看原因                  │  │ 当前：整理部署配置 · 已 6 分钟 │
└──────────────────────────┘  └──────────────────────────┘  │ 查看进展                  │
  没有数字，没有进度条            没有数字，没有进度条          └──────────────────────────┘
```

---

## 1. 三者的产品职责

| | 产品职责 | 用户能不能看到 | 数据和工具 |
|---|---|---|---|
| **Plan** | 准备怎么做：目标、阶段；是**唯一**的进度口径 | 有 Plan 时，在第 0 层显示进度，在第 1 层显示唯一的列表 | `publish_run_plan`、`RunPlan` / `RunPlanRevision`，**都不改** |
| **Steps**（semantic Step） | 执行到哪了：过程、结果、证据、异常 | 第 2 层显示证据；没有 Plan 时，第 1 层用 Steps 标题兜底 | `publish_run_step`、`RunStep` / `RunStepMutation`，**都不改** |
| **Todo** | Agent 内部的工作清单 | **默认隐藏**。只有老数据既没 Plan 也没 Steps 时，展开后显示成「事项清单」 | `publish_run_todo`、`RunTodo` / `RunTodoMutation`，**都不改** |

- 这里的 Steps 指 `publish_run_step` 发布的语义 Step，不是工具活动的聚合（`MessageBlock.kind="steps"`）。
- Java 原生的 Plan Mode（`plan_enter` / `plan_write` / `plan_exit`）不属于本期范围（见 §4）。

---

## 2. 场景与展示规则

### 2.1 执行区有三层

| 层 | 内容 | 什么时候出现 |
|---|---|---|
| **第 0 层**（默认，运行中也一样） | 状态图标 + 标题 +（有 Plan 时）`a/b` +（有 Plan 时）进度条 +（有 Plan 时）「当前：<当前项> · 已 N 分钟」+ 操作按钮（「查看进展」/「查看原因」/「收起」） | 执行区存在时一直显示 |
| **第 1 层** | **只有一套列表**：有 Plan 时显示 Plan 的目标和各项；没有 Plan 时显示 Steps 标题列表；都没有就显示「事项清单」（见 2.6） | 点「查看进展」后 |
| **第 2 层** | Steps 的耗时、尝试次数、证据引用、异常原因、「部分状态未确认」 | 点第 1 层的某一项，或者点「查看原因」 |

规则：
- 运行中**不再自动展开**。要删掉三处自动展开：`RunPlanDisclosure.tsx:53`、`RunStepsDisclosure.tsx:85`、`Shell.tsx:5278-5280` 里对运行中 Run 的 `openByDefault`。
- 「同一线程同一时间只展开一张卡」和「用户展开状态记忆」两条规则保留（`Shell.tsx:4962-4976`）。
- 完成后收成一行，结果只在回复气泡里出现一次（沿用 `resultOnPage` 规则）。
- 失败时保持收起，显示失败那一步和「查看原因」，点了直接进第 2 层。

### 2.2 按场景展示

| 场景 | 判定 | 显示什么 |
|---|---|---|
| **普通请求** | Plan、semantic Step、pending Intervention、failed **一项都没有** | 不出现执行区。运行中可以显示**一行浅灰色的轻量状态**（比如「正在读 …」），不带数字，不出现「计划 / 执行进度 / 待办」字样；**最终回复出来后就消失** |
| **复杂执行** | 有 Plan，或者有 semantic Step | 显示执行区。数字和进度条只按核心规则 2 处理 |
| **需要用户决策** | 有 pending Intervention（approval / input） | 沿用现有的统一审批卡，放在折叠区外面，不能收起。**没有 Plan 时也必须出现**（示例 ①）。和其他场景同时成立时，以这个场景为准 |
| **失败** | Run failed | 必须有失败提示和「查看原因」，**没有 Plan 时也必须出现**（示例 ②） |

- **不再用 Steps 的数量判断复杂度**。原来的「Steps ≥ 2」规则作废。只有 1 个 semantic Step，也要出执行区，但没有数字。
- Plan 由模型按需产生（TurnPolicy 为 `auto` 加提示词），**不加复杂度 Router**。前端只看「有没有结构化 Plan」。

### 2.3 进度数字的口径

- `a` = 有效项里 `completed` 的数量；`b` = 有效项的数量。有效项指排除 `skipped` 和 `superseded` 后剩下的项，现成口径在 `RunPlanDisclosure.tsx:40-43`。
- **`unresolved` 算进分母**，不算进分子。
- 进度条宽度 = `a/b`。只在有 Plan 时显示。**没有 Plan 时不画任何底条，也不放扫光动画。**
- 进度是 Agent 自己报的状态，**不代表外部事实已经确认**。任何地方都不能出现「已核验 / 已确认」这类暗示，证据要留在第 2 层可查。
- 每张卡在任何时候最多只显示一个 `a/b`。要删掉的内容：
  - Steps 摘要里的「x/y done」（`RunStepsDisclosure.tsx:88`）；
  - 卡片元信息里的「N steps」（`execution-card.ts:135-136`）；
  - 按 Steps 计算的进度条（`execution-card.ts:159-187`），改成按 Plan 计算。
- Steps 摘要里的「N 个受阻或失败」可以保留，改成纯文字，不带分数。

### 2.4 计划修订

- Plan 修订后，分母可能变化，比如 `3/4` 变成 `3/6`，**允许数字倒退**。
- 数字变化的同时，第 0 层**短暂提示「计划已更新」**。第 1 层显示 `v{revision}` 和 `changeReason`（沿用 `RunPlanDisclosure.tsx:55-73`）。

### 2.5 侧栏

- Bot 行**不显示 `3/5`**，也不写「在等你 / 运行中 / 失败 / 完成」等状态文字，**只用头像徽标**表示状态。
- **必须保留无障碍 aria 文案**：读屏要能读出「<Bot 名>，在等你」「<Bot 名>，运行中」这类状态。徽标本身 `aria-hidden`，状态写进行或头像的 `aria-label`。
- 点一下在等待的 Bot，进入对话后，焦点落在审批卡的第一个可操作控件上（沿用 `ExecutionShell.tsx` 的 attention focus）。

### 2.6 只有 summary 时降级，以及旧数据怎么兜底

- **只有 summary 的卡片**（比如超出线程快照 20 个 Run 上限的旧 Run，或者任务中心列表）：拿不到 Plan，算不出 `a/b`，就**不显示数字和进度条**。不能显示成 `0`、`--` 或估算值。**不为了这个数字去扩 contracts 或 db。**
- **旧数据兜底的顺序**：
  1. 有 Plan：显示 Plan；
  2. 没有 Plan：显示 Steps 标题；
  3. Steps 也没有：显示「事项清单」，来源是 Todo。只在展开后出现，小标题写成「这次运行没有计划，以下是当时的事项清单」，**不出现「Todo / 待办」字样，不显示数字**。

---

## 3. 本期范围

**在范围内（Web 和测试层）**
- 执行区的展示收敛：§2 的全部规则。
- 已关联 Todo 的去重：把 `unlinkedRunTodos`（`work-progress-view.ts:4-12`）也接到详情路径上（`execution-history.ts:71`）。
- 补 `RunTodoList` 的单测，补 A/B/C 三个场景的 E2E。
- 清理旧的「N steps」和多套「done」数字。
- 更新受影响的 Plan/Steps 单测、E2E 断言（`data-slot="plan|steps|todos"`），以及 i18n 的 `.po` 文件（`.po` 改动单独提交）。

**不在范围内**
- 不改 3 个工具（`builtin-tools.ts:686-784`）、6 个 Prisma 模型（`schema.prisma:635-730`）、事件（`events.ts:16-29`）和 `ExecutionSnapshot` 契约，**不加迁移**。
- 不给 `ExecutionSummary.counts` 加 Plan 计数（只有 summary 时按降级处理）。
- 不加复杂度 Router。

**放到 UX-02**
- Plan Review 审阅卡及其细则：要不要「总是允许」、拒绝时要不要写原因、计划变更多大要重新审阅、哪些任务需要审阅。本期继续用现有的 approval / input。
- Java 原生 Plan Mode 要不要和结构化 Plan 统一。
- Todo 工具的长期定位。

---

## 4. 实施顺序与关卡

> 每一步里凡是不可逆、或者对外可见的操作（push、retarget、resolve、merge、删分支、部署），**都要徐哥逐步批准**后才执行。

| 关卡 | 内容 | 通过标准 |
|---|---|---|
| **G0 头像 stack 先达到可合状态** | 修 #50 的三条 finding（16px 下状态只靠颜色区分、冻结规格只有 SHA 没进仓库、状态过期规则没定义）、#52 P1（`avatar-activity.ts:31` 漏掉群聊和外部会话里的 Run）、#53 的两条 P2（`director.ts:177` 的 pending 没清、`dom-motion.ts:18` 的 transform 叠加）；在有 Postgres 的环境里补跑 avatar 单测、`VERIFY_DATABASE=1` 的 PG 测试、`avatar-studio.spec.ts` 和群聊回归；复验 #54 和 #55 | 上面每一条都修完，或者明确登记；测试结果有证据；#54 和 #55 的最终 head 复验通过 |
| **G1 #49 合入最新 main** | 在 #49 上合入最新 main，roadmap 冲突**以 #56 已合入的版本为准** | 冲突只出现在 `docs/next-work-roadmap.md`，并已解决；CI 全绿 |
| **G2 逐级合入** | #49 → #55，每一级先把 base 改成 `main`，确认 diff 只剩本级改动，CI 全绿后，用 **merge commit 合并（不用 squash）** | 每级合并前确认 base 是 `main`；每合一级，main 上的 CI 都是绿的 |
| **G3 合入 ≠ 部署** | stack 合完后，生产要跑的迁移会有 25 个，部署要等 DEP-01 演练和回滚准备好 | 不在 UX-01 范围里部署 |
| **G4 UX-01A Shell extraction** | **#55 进 main 之后**，从最新 main 开分支。只拆执行区（`plansByAnchor` / `stepsByAnchor` / `todosByAnchor` 锚定逻辑，加上执行区渲染），**产品行为零变化**，作为前端拆分第 2 步的子步骤。开工前先补 Shell 冒烟基线，并核实 §7 里的待核实项 | 现有快照和 E2E 一条都不用改就全部通过；人工审查 effect 依赖，因为 `biome` 关了 `useExhaustiveDependencies` |
| **G5 UX-01B Progress convergence** | 落地 §0 和 §2 | §6 验收第 1–13 条 |
| **G6 UX-01C Compatibility + E2E** | 去重修复、`RunTodoList` 单测、A/B/C 场景 E2E、清理旧数字、旧数据兜底 | §6 验收第 14–20 条 |

- `refactor/shell-split-01` **整支放弃**。里面 4 个有价值的小模块（`collapse-storage.ts`、`computer-labels.ts`、`message-text.ts`、`apply-thread-event.ts`）从最新 main 重新做。
- #56 已经在 2026-10-18 01:21（UTC+8）合入 main（merge commit `4448400`），不用再拍板。
- 如果后续有新迁移，时间戳必须晚于 `20261017040000`。UX-01 本身不加迁移。

---

## 5. 三个 PR 的边界

| PR | 只做 | 不做 |
|---|---|---|
| UX-01A | 把执行区从 `Shell.tsx` 搬出去，行为零变化 | 改任何展示规则 |
| UX-01B | 执行区出现条件、三层折叠、数字和进度条口径、侧栏徽标和 aria、轻量状态、「计划已更新」提示 | 改工具、模型、事件、契约、db |
| UX-01C | 去重、兜底、单测、E2E、清理旧数字 | 同上 |

---

## 6. 验收标准（20 条）

**UX-01B**

1. 一个 Run 如果没有 Plan、没有 semantic Step、没有 pending Intervention，也没有失败：DOM 里不出现执行区，不出现 `data-slot="plan|steps|todos"`，也不出现「计划 / 执行进度 / 待办」字样。
2. 普通请求运行中最多只有一行浅灰色的轻量状态，没有数字；**最终回复出现后，这一行从 DOM 里消失**。
3. 只要有 semantic Step（哪怕只有 1 个），就有执行区。
4. 复杂执行运行中，执行区默认收起。有 Plan 时，第 0 层只有标题、`a/b`、进度条、「当前：… · 已 N 分钟」和「查看进展」。
5. 同一张卡在任何时候最多只有一个「a/b」，数值等于 Plan 有效项中已完成的数量除以有效项总数；`unresolved` 项算进分母。页面上不出现「N steps」，也不出现 Steps 的「x/y done」。
6. 没有 Plan 时，卡片和侧栏都没有「a/b」，**也没有进度条元素**（包括 0% 宽的底条和扫光动画）。
7. **没有 Plan、等审批时**，统一审批卡可见、可以操作，不能折叠，「允许」「拒绝」都能用。
8. **没有 Plan、失败时**，对话里能看到失败提示和「查看原因」，点了直接进第 2 层对应的步骤。
9. Plan 修订导致数字倒退时（比如 `3/4` → `3/6`），数字立刻更新，第 0 层**出现「计划已更新」短暂提示**，第 1 层显示 `v2` 和修订原因。
10. 第 1 层只有一套列表；任何默认视图里都看不到 Todo 列表。
11. Steps 的耗时、尝试次数、证据、异常、「部分状态未确认」只在第 2 层可见。
12. 侧栏 Bot 行不显示数字，也没有状态文字，只有头像徽标；读屏能读出「<名字>，在等你」或「<名字>，运行中」；点在等待的 Bot，焦点落在审批卡的第一个可操作控件上。
13. 完成后卡片收成一行，结果文本在页面上只出现一次。

**UX-01C**

14. 详情加载失败时显示「重试」，第 0 层已有的数字不会变成 `0` 或 `--`。
15. 只有 summary、拿不到 Plan 的卡片，第 0 层不显示数字和进度条，也不显示 `0`、`--` 或估算值。
16. 旧数据兜底：没有 Plan 时第 1 层显示 Steps 标题；Steps 也没有时，展开后显示「事项清单」，**全文不出现「Todo / 待办」，也不显示数字**；收起时不出现事项清单。
17. **去重（数据函数层断言）**：先构造 Step S1，再构造带 `linkedStepId=S1` 的 Todo。详情路径（`executionDataForRun` 的 detail 分支）和旧快照路径的输出里，这条 Todo 都被过滤掉，两条路径结果一致。另外补上 `RunTodoList.test.tsx`。
18. 6 个 Prisma 模型、3 个工具的 schema、事件、`ExecutionSnapshot` 和 `ExecutionSummary` 契约都没有 diff，也没有新迁移；现有契约测试、DB 测试、回放测试全部通过。
19. 没有发布结构化 Plan 的 Run，包括只调用过原生 `plan_write` 的 Run，界面上不出现由工具调用、Activity 或 Markdown 合成出来的 Plan。
20. 进度相关文案里不出现「已核验 / 已确认」之类的暗示；第 2 层的证据引用数仍然可以查看。

**相对 REQ 原 16 条的变化**
- **删除 4 条**：
  - 原第 5 条：侧栏和卡片的数字 2 秒内同步（侧栏已经不显示数字）；
  - 原第 8、9、10 条：Plan 审阅卡（放到 UX-02）。
- **修改 4 条**：
  - 原第 1 条：判定条件从「Steps < 阈值」改成「四项条件都不满足」；
  - 原第 3 条：补上 `unresolved` 算进分母，并明确禁止「N steps」和 Steps 的「x/y」；
  - 原第 4 条：从「只画底条」改成「没有进度条元素」；
  - 原第 16 条：去重改成在数据函数层断言。
- **原样保留 8 条**：原第 2、6、7、11、12、13、14、15 条。
- **新增 8 条**：第 2 条（轻量状态消失）、第 3 条（单个 Step 也出执行区）、第 7 条（没有 Plan 时审批可见）、第 8 条（没有 Plan 时失败可见）、第 9 条（修订倒退时出提示）、第 12 条（侧栏徽标和 aria）、第 15 条（只有 summary 时降级）、第 16 条（「事项清单」兜底）。

---

## 7. 还要按本决策更新的文档（只列出来，本次没有改）

| 文档 | 要改的地方 |
|---|---|
| `REQ-plan-todo-steps.md` | §0 结论；§3 场景表（「Steps 达到阈值」改成四项条件；C 场景里侧栏「X 在等你」改成徽标加 aria）；§3「旧数据只有 Todo」的兜底文案；§5 `execution-card.ts` 那一行（「只画底条」改成不画）；§6 验收（按本文 §6 替换）；§7 拍板项标成已决；§8 分歧标成已决 |
| `ux-notes.md` | §1 场景触发条件（Steps ≥ 2）；§1 和 §3 侧栏「3/5」；§3「没有 Plan 时只画底条」；§4 Plan 审阅卡标为 UX-02；§5「历史 Run」兜底；§6 验收第 1、4、5、8–10 条，以及待拍板项 |
| 侧栏对齐的 UX 评审（`WorkPal-ui-review/` 下） | P0-1 Bot 行第二行写状态文案；§1.4 状态表；验收第 2–5、7、15 条里的状态文字，改成「只用徽标，加 aria」 |
| `prototype/` | `index.html:326`：没有 Plan 时仍画 0% 宽的底条加扫光，要改成不画；拍板默认值改成本决策的结果（d04=A、d05=A、d06=B、d07=A、d08=A、d09=A、s1=A）；场景 4 的审阅卡标成「UX-02 示意」；`README.md` 的拍板表标成已决 |
| `gpt-advice-review-product.md` | 加一句「已由 UX-01-decision 取代」 |
| 仓库 `docs/next-work-roadmap.md` | UX-01 保持 in-progress，可以注明「决策已批准，实施等头像 stack」（**本次没改**，由徐哥或指定的人改） |
| 仓库 `docs/execution-card.md`、`docs/task-implementation-audit.md` | UX-01B 落地后，更新 Task 15/15.1 的冻结描述（展开区结构、Duplication rules、进度条数据来源） |

---

## 8. 还没核实的代码点（UX-01A 开工前核实）

1. **在 96283eb 和最新 main 上，审批区和失败提示是不是挂在执行卡上。** 产品在 main-ro 8d263ad 上读到：`InterventionRegion` 是作为 `interventions` 属性传给 `ExecutionShell` 的（`Shell.tsx` 约 5357–5372，`ExecutionShell.tsx:41,131`），而且消息里的 AskCard 被覆盖时会被压掉（`Shell.tsx:5651` 的 `suppressAsk`）。如果确实挂在执行卡上，UX-01B 必须保证这两种情况下执行区一定出现（核心规则 1、3），不能沿用「普通请求不出卡」的分支。
2. **`planItemId` 在不在 `ExecutionSnapshot` 的 steps 里。** 前端现在没用到它，只有测试命中。如果不在，第 2 层「把 Steps 挂到对应 Plan 项下面」就不是纯 Web 改动，本期 Steps 只能平铺。
3. 现在一个普通 chat Run，什么时候会出执行卡或末尾状态 Header。这决定了第 1、2 条验收要删哪条分支。
4. 任务中心卡片是不是只用 summary（关系到第 15 条）。
5. 原生 `plan_exit` 的「workpal-plan-approval」审批在界面上怎么显示，是不是走统一审批卡（关系到第 7 条）。
6. 头像徽标现在的 aria 实现：#54 给上传头像加了状态化的 `aria-label`，但角色头像和侧栏行是不是已经有等价文案，还不清楚（关系到第 12 条）。
7. 16px 下状态有没有非颜色的区分方式（#50 的 finding，和侧栏只用徽标有关）。
8. #54 和 #55 合入后，`Shell.tsx` 的执行区行号会变，本文行号要重新定位。
