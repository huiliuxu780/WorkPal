# RT-UI-AUDIT-01：圆桌原型一致性全量扫描

- 日期：2026-10-23
- 分支：`codex/rt-ui-prototype-conformance-audit`
- Base SHA：`4571a9eaf88a20e7ca37c4846d523389ba95c378`（origin/main，PR #114 合入点）
- 审计范围：RT-00～RT-30 全部 31 个任务、已合入圆桌 PR（#102–#115）、三个在途 PR（#116 RT-08 / #117 RT-14 / #118 RT-03）、origin/main 的 Web 实现实际渲染。
- 结构化数据：[ui-prototype-conformance.json](./ui-prototype-conformance.json)（本文件的机器可读事实源，由 `verify-ui-conformance.mjs` 验证）。

> **声明：本审计不代表生产 UI 偏差已经修复。** 所有确认冲突由 §8 的修复任务在后续独立 PR 中承担；本 PR 只包含审计材料、任务定义修订和验证器。

## 1. 范围前提（裁决基线）

96 个验收场景不等于 96 个页面状态。原型只裁决 **8 段主故事线 + 28 个高价值分支** 的实际渲染（DESIGN.md L4、PRD §13.1、§14）；其余场景由 API、Runtime、投影和端到端测试覆盖。不得为“覆盖完整”新增 UI，也不为 96 个场景分别创建 UI 状态机（计划 §6 已明确禁止）。

用户可见 UI 的裁决顺序（任务书 §二）：

1. `prototype/DESIGN.md` 明确约束；
2. `prototype/index.html` 实际渲染（本审计重新渲染取证，见 §3）；
3. `roundtable-product-requirements.md` 产品语义；
4. WorkPal 现有组件与视觉语言（补足原型未规定细节）；
5. 实施计划与历史任务提示词（派生材料，冲突时修订）。

安全、权限、数据和执行语义由 PRD、architecture 与 AGENTS.md 约束，不在本审计改写范围。两个高优先级来源真实冲突时不自行选边，列为 blocking decision（§7 D1、D2）。

**渲染取证纪律**：`index.html` 源码中存在仅用于场景 fixture 的 progress 数值，页面从未渲染百分比；本审计以实际渲染截图为证据，不以源码文本搜索为准。

## 2. 方法

1. 在浏览器中以 1440×900 重新渲染原型，逐屏截图：8 个主故事阶段、28 个分支场景、工作页签、任务详情、补充要求回流、回执展开、pair 浮窗、右栏三页签；再以 430×900 验证窄屏（隐藏左导航、详情覆盖层、胶囊直达工作页签）。证据：`audits/evidence/prototype/`（47 张）。
2. 以同一浏览器实际运行 origin/main（独立 worktree + 独立数据库 `workpal_rt_audit`），截图 main 现有对应 surface：群聊胶囊、右栏四页签、mention 链接、失败 Run 呈现、窄屏覆盖层。证据：`audits/evidence/main-app/`（8 张）。
3. 审阅已合入 PR #102–#115 的 UI 面（`AgentMentionText.tsx`、`group-panel.tsx`、`group-identity-cluster.tsx`、`CollaborationMarker.tsx`、`Shell.tsx` 协作 block 分支）与在途 PR #116/#117/#118 的 diff。
4. 将 31 个 RT 分类为 backend-only / direct-ui / ui-projection-contract，逐条裁决差异（confirmed / missing-requirement / intentional-non-UI / ambiguous / false-positive）。

## 3. 证据清单

| 证据组 | 位置 | 数量 |
| --- | --- | --- |
| 主故事线 8 阶段 | `evidence/prototype/main-stage-1..8.png` | 8 |
| 分支 7 组 × 4 | `evidence/prototype/branch-<ID>.png` | 28 |
| 交互子状态（工作页签/任务详情/补充 chip/回执展开/浮窗/右栏页签） | `evidence/prototype/work-*.png`、`rail-*.png`、`branch-Q-MULTI-expanded.png`、`pair-float-open.png` | 8 |
| 窄屏（收起态/覆盖层/胶囊直达） | `evidence/prototype/narrow-*.png` | 3 |
| main 应用 surface | `evidence/main-app/*.png` | 8 |

每个原型状态的 surface、入口、可见元素、操作、状态文案与禁止内容记录在 §4。

## 4. 原型状态记录（裁决证据）

### 4.1 主故事线（8 阶段）

| 阶段 | Surface / 入口 | 可见元素与操作 | 状态文案（权威样本） | 禁止出现 |
| --- | --- | --- | --- | --- |
| 1 | 群聊；顶栏「工作」按钮、群胶囊开右栏 | 用户消息、Joy 开场 | 侧边栏「后台任务 6」徽标（D2 待裁决） | 状态机解释、内部术语 |
| 2 | 群聊 | Joy 一条自然消息含 `@小蓝` `@小橙` mention 链接 + **两个语义药丸「性能基线 · 已派给小蓝」「首屏方案 · 已派给小橙」**（可点击，直达工作） | 「已派给」；活动胶囊「小蓝、小橙 正在接收任务」 | queued/running 等执行状态、逐目标状态列表 |
| 3 | 群聊 | 小蓝/小橙各自真实确认消息 + 绿点状态行 | 「已启动后台工作 · 跑性能基线」 | 前端伪造确认 |
| 4 | 群聊 | 用户插话 + 小蓝带假设声明的回复 | 「后台任务仍在运行 · 2 / 4」（客观计数）；胶囊「小蓝正在回复 · 后台工作未暂停」 | 推测百分比 |
| 5 | 群聊 | 小蓝子委派（mention + 药丸「网络瀑布复核 · 子任务」）+ 小紫确认 | 「已启动后台工作 · 复核瀑布图」 | 第二层抽屉 |
| 6 | 群聊 | 用户 @ 小橙新指令 + 小橙确认 | 「新增后台工作 · 移动端 B 版断点」；胶囊「你的 @ 指令已交给小橙 · 原任务未取消」「小橙后台工作 2 项」 | 取消其他任务 |
| 7 | 群聊 | 审批卡内嵌消息流 | 「允许小橙发布到预览环境？」拒绝/允许一次；「审批只暂停发布；我仍然可以继续讨论」；胶囊「小橙等你批准 · 仍可发言」 | 模态审批弹窗 |
| 8 | 群聊 | 小紫引用回复、小蓝结果卡（「性能结果 · 已完成」+ 打开完整性能报告 →）、Joy 综合 | 结果卡状态「已完成」 | 修改旧消息塞结果 |

### 4.2 分支（7 组 × 4）

| 分支 | 关键渲染 | 状态文案样本 |
| --- | --- | --- |
| U-ACTIVE | 新指令确认消息 + 状态行 | 「正在回复 · 后台任务未暂停」；胶囊「小蓝已接收你的新指令 · 后台基线继续」 |
| U-MULTI | 一句话两目标各自确认 | 「收到，我负责性能回归。」 |
| U-CONFLICT | Agent 主动说明冲突并提问 | 「我暂停最终导出……要按你的新指令切 B，还是保留周五上线优先？」 |
| U-STOP | 系统状态行 + Agent 确认 | 「已停止“小橙 · 移动端 B 版断点”；没有取消同一 Agent 的其他工作。」 |
| A-ACTIVE | 用户消息带 **task chip「补充到 Task1 · 三次发布 LCP 对比」** | 「Task1 · 已追加 1 条要求」；胶囊「小蓝继续 Task1 · 已纳入你的补充」 |
| A-BACKGROUND | 同上，后台口径补充 | 「Task1 后台继续 · 交付口径已更新」 |
| A-COMPLETED | 结果卡 + 追加复核 | 「Task1 · 已完成」结果卡；「Task1 · 追加复核进行中」；胶囊「Task1 已追加复核 · 原结果仍保留」 |
| A-AMBIGUOUS | 消息内候选选择列表 | 「Task1 · 最近三次发布 LCP［进行中］／Task2 · 低端机首屏回归［后台中］」；胶囊「等待你选择具体任务 · 尚未修改任何执行」 |
| X-GROUP | 单聊结构化回显卡 | 「Joy 已进入「新版发布圆桌」［已入群］／已接手 · 正在推进｜去现场看看 ↗」 |
| X-BOT | **独立轻回执行**（两消息之间） | 「已发消息给 小蓝 ›」 |
| X-GROUP-FAIL | 加群审批卡 | 「把 Joy 加入「新版发布圆桌」？」暂不加入/加入并继续 |
| X-RETURN | 回源汇报 + 来源卡 | 「结论来自「新版发布圆桌」［已带回］｜查看现场 ↗」；胶囊「跨会话工作已完成 · 结果可跳转」 |
| Q-REVERSE | 反向联系同样回执 | 「已发消息给 Joy ›」 |
| Q-MULTI | 聚合回执可展开 | 「已发消息给 ３头像 3 个 Agent ⌄」→ 原行下方头像+名字名单 |
| Q-ORIGINS | 同 pair 多来源审批隔离说明 | 「这个审批只恢复你在这里发起的任务……」 |
| Q-UNAVAILABLE | 红色失败回执 | 「未发送给 小蓝 ›」；「没有发出去：小蓝已停用……之前的协作记录还在」 |
| C-MULTI | 两个独立回复 | 胶囊「2 项任务已独立完成」 |
| C-DUAL | 前台回复 + 后台并存 | 「当前假设是……不是最终结论」「后台 trace 仍在运行 · 2 / 4」 |
| C-ROOTS | 两个独立根任务胶囊 | 「发布方案仍在推进」「客户材料独立进行」 |
| C-LATE | 旧结果归档 | 「旧结果已归档 · 未覆盖当前目标」 |
| P-SCOPED | 单节点审批不扩散 | 胶囊「小橙一个节点等审批 · 仍可发言」「小蓝后台继续」 |
| P-ALLOW | 授权结果卡 | 「移动端预览 · 已发布／授权范围：单次／其他环境：未授权」 |
| P-DENY | 拒绝后继续讨论 | 「发布已停止 · 小橙仍可讨论」 |
| P-STALE | 旧审批失效 | 「旧审批已失效 · 等待新确认」 |
| F-OFFLINE | 失败系统行 | 「未能派给小紫：该 Agent 已被停用，没有开始这项工作。」；胶囊「委派失败 · 等待改派」 |
| F-RETRY | 重试状态行 | 「重试中 · 第 2 / 3 次尝试」 |
| F-DEDUPE | 幂等系统行 | 「检测到重复投递；沿用首次派活，没有再次通知小蓝。」；胶囊「小蓝只有 1 项有效任务」 |
| F-PARTIAL | 有条件收尾 | 「性能结果已完成」「证据复核失败」双胶囊 |

### 4.3 交互与响应式

- **工作页签**（点击顶栏「工作」或药丸/胶囊直达）：336px 右栏、头像簇、扁平页签「详情/工作/资料库/成员」、无卡片工作树（根行「发布方案拆解 · 进行中」+ 一层子行「后台中」）、页头「进行中的工作 **3 项进行中**」（页面内计数，非入口计数——CF-09）。无标题栏、无树状套卡、无解释文案、无第二层抽屉。
- **任务详情**（点击工作行原位切换）：负责人、当前动作、阶段节点（接收任务→推进工作→交付结果）、最近进展、当前要求（「正在按这些要求执行」）、要求与补充时间线（含「本轮」标记）、动作「补充要求 / 停止」。不显示 Run/attempt 内部结构、百分比。
- **补充要求** → 返回工作列表，composer 出现 chip「补充到 发布方案拆解 ×」。
- **多目标回执展开**：原行下方紧凑名单（头像+名字）。
- **pair 浮窗**：整张独立浮窗、顶部居中「Joy ⇔ 小蓝」身份胶囊、说明行「这段对话不会出现在你的会话列表……」、只读历史（含状态行）、无输入框、底部唯一「关闭聊天」。
- **右栏三页签**：详情（群信息 + 例行任务 + ＋设置例行任务）、资料库（日期分组无外框文件行）、成员（4 个 Agent、无框行、＋添加 Agent）。
- **窄屏 430×900**：左导航隐藏、群详情面板变覆盖层、（场景选择器固定左下——仅评审工具）。点活动胶囊直接打开工作页签覆盖层。

## 5. RT 分类总表（31/31）

| 任务 | 状态 | 分类 | 原型引用（direct-ui / projection 必填） | 冲突 |
| --- | --- | --- | --- | --- |
| RT-00 gate | #103 合入 | backend-only | — | — |
| RT-01 类型 | #104 合入 | backend-only | — | — |
| RT-02 pair 身份 | #109/#112 合入 | backend-only | — | — |
| RT-03 pair 访问策略 | #118 在途（暂停） | ui-projection-contract | DESIGN L8；branch-Q-ORIGINS | CF-10 |
| RT-04 来源审批 | #110 合入 | ui-projection-contract | main-stage-7；branch-P-SCOPED | — |
| RT-05 private 迁入 pair | 未开工 | ui-projection-contract | branch-X-BOT；DESIGN L8 | — |
| RT-06 群内 message_bot | #107/#115 合入 | ui-projection-contract | main-stage-2/3；DESIGN L8 | CF-02 |
| RT-07 结构化 mention | #108 合入 | direct-ui | main-stage-2；DESIGN L9 | — |
| RT-08 公开委派 UI | #116 在途（暂停） | direct-ui | main-stage-2/3；branch-F-OFFLINE；DESIGN L8/23/24 | CF-01、CF-02 |
| RT-09 receipt+浮窗 | 未开工 | direct-ui | branch-X-BOT/Q-MULTI/Q-UNAVAILABLE；interaction:pair-float/receipt-expanded；DESIGN L8/10/11 | — |
| RT-10 多 mention 分段 | #113 合入 | ui-projection-contract | branch-U-MULTI/A-AMBIGUOUS | — |
| RT-11 message_group | 未开工 | ui-projection-contract | branch-X-GROUP；DESIGN L7 | — |
| RT-12 跨群审批 | 未开工 | ui-projection-contract | branch-X-GROUP-FAIL/X-RETURN；DESIGN L7 | — |
| RT-13 指令日志 | #114 合入 | backend-only | — | — |
| RT-14 按状态补充 | #117 在途（暂停） | ui-projection-contract | branch-A-COMPLETED/A-ACTIVE/A-BACKGROUND | CF-03 |
| RT-15 SDK 探针 | #106 合入（suspended） | backend-only | — | — |
| RT-16 后台身份 | 官方暂停 | backend-only | — | — |
| RT-17 revision/迟到 | blocked | backend-only | — | — |
| RT-18 生命周期/delivery | blocked | backend-only | — | — |
| RT-19 取消/成员/资源 | 未开工 | backend-only | — | — |
| RT-20 工作投影 | 未开工 | ui-projection-contract | interaction:work-tab/task-detail；DESIGN L14/24 | — |
| RT-21 群数据查询 | #105 合入 | ui-projection-contract | interaction:rail-*；DESIGN L20 | — |
| RT-22 胶囊+右栏 | #111 合入 | direct-ui | main-stage-1；interaction:rail-*/narrow-overlay；DESIGN L14–19 | CF-06、CF-07、CF-12 |
| RT-23 工作页+详情 | 未开工 | direct-ui | interaction:work-tab/task-detail/amend-chip；branch-A-COMPLETED；DESIGN L15/22/24 | CF-03 |
| RT-24 路由/冲突/收尾 | 未开工 | ui-projection-contract | branch-U-ACTIVE/U-CONFLICT/C-*/F-*；DESIGN L23 | CF-04、CF-07 |
| RT-25 session lease | 未开工（零提交） | backend-only | — | CF-11 |
| RT-26 pending state | 未开工 | backend-only | — | — |
| RT-27 确定性 steering | 未开工 | backend-only | — | — |
| RT-28 受控续跑 | 未开工 | ui-projection-contract | branch-P-SCOPED；main-stage-7；DESIGN L25 | — |
| RT-29 run_subagent 恢复 | blocked | backend-only | — | — |
| RT-30 集成验收 | 未开工 | ui-projection-contract | main-stage-1/8；DESIGN L4 | CF-05 |

统计：backend-only 13、direct-ui 5、ui-projection-contract 13。全部 direct-ui 与 ui-projection-contract 均引用具体原型状态或 DESIGN 条款（JSON `prototypeRefs`，验证器强制）。

### main 实测（已合入实现）

- **符合**：RT-22 四页签骨架/无框群名编辑（单击编辑、失焦/Enter 保存、Esc 取消）/日期分组无外框资料库/无框成员行＋「＋ 添加 Agent」/工作页签诚实占位「该群的工作视图尚未接入。」；RT-07 mention 链接（发送后渲染为头像+名字链接 `/app/<botId>`，旧文本无链接回退，不可用身份降级徽标）；窄屏覆盖层与胶囊；键盘页签方向键导航。
- **偏差**：见 §6 CF-02（公开委派走私有回执路径）、CF-06（资料库行悬停操作缺失）、CF-07（成员状态映射）、CF-08（AgentScope 文案）、CF-12（顶部工作直达缺失）、CF-05（侧边栏后台任务中心缺失）。

## 6. 冲突矩阵

每条含：编号与严重级别、当前事实、原型证据、冲突位置（任务/PR/文件/行号）、为什么是冲突、正确行为、修复归属、是否阻断。机器可读版见 JSON `conflicts`。

### CF-01 · P1 · confirmed · 阻断
- **当前事实**：PR #116 `PublicDelegationMessage.tsx` 为每个目标渲染 `Queued/Running/Completed/Failed/Cancelled` 徽标（`statusPresentation`），`data-status` 暴露执行枚举，可展开 detail（「Waiting to start」）；`public-collaboration.ts` 从 Run 状态推导。
- **原型证据**：prototype:main-stage-2 —— 自然 @ 消息 + 语义药丸「性能基线 · 已派给小蓝」；DESIGN L8/L23/L24。
- **位置**：`roundtable-implementation-plan.md:297`（原「独立投递状态和失败状态」，本 PR 已修订）；PR #116 `PublicDelegationMessage.tsx:13-79`；`group-chats.spec.ts` data-status 断言。
- **为什么**：把 Run 状态机塞进聊天消息，违背「自然 @ 委派」与不暴露执行术语约束。
- **正确行为**：语义药丸（已派给/未发送给）；逐目标真实状态只进 RT-20/RT-23 工作投影。
- **归属**：RT-08 重开 #116（FIX-MSG-A）。**阻断 RT-08 恢复开发。**

### CF-02 · P1 · confirmed · 阻断
- **当前事实**：main `Shell.tsx:6779-6795` 把群 Thread 的 `bot_message_sent/received` 与私下 peer 回执共用 `CollaborationMarker`（label「Messaged X」），点击 `onOpenPeerMessages` 打开 peer 对话视图。
- **原型证据**：prototype:main-stage-2/3；DESIGN L8「群内公开 @Agent 仍留在群 Thread，不与私下对话混用」、L9。
- **位置**：`apps/web/src/pages/Shell.tsx:6779-6795`、`apps/web/src/components/ai/CollaborationMarker.tsx`。
- **为什么**：公开协作与私下 receipt 混用 UI 与导航语义。
- **正确行为**：群内协作 block 渲染为自然 @ 消息；`CollaborationMarker` 仅留给来源会话私下回执（RT-09）。
- **归属**：RT-08（FIX-MSG-A）。**阻断 RT-08 恢复开发。**

### CF-03 · P1 · confirmed
- **当前事实**：计划 RT-14 验收「completed Task 保留旧结果并显示“追加复核”」（原 :441）把 UI 展示写进后端任务。
- **原型证据**：prototype:branch-A-COMPLETED —— 状态行「Task1 · 追加复核进行中」+ 胶囊「Task1 已追加复核 · 原结果仍保留」；任务详情「要求与补充」时间线。
- **位置**：`roundtable-implementation-plan.md`（本 PR 已修订）；PRD AC30/A06 定义产品语义。
- **为什么**：后端任务不得发明 UI 投影；展示归 RT-23 且必须复刻原型位置与结构。
- **正确行为**：RT-14 只交付 follow-up Run 事实；展示由 RT-23 按 prototype:branch-A-COMPLETED 实现。
- **归属**：RT-23（FIX-WORK-D）；计划已修订。不阻断（RT-23 未开工，语义已在任务书）。

### CF-04 · P1 · confirmed · **blocking decision D1**
- **当前事实**：原型聊天区 6 处文案包含实现术语：`index.html:662`（「小蓝已接收 steering」）、`:825`（「2 个目标 Run 已独立完成」）、`:896`（「没有创建 support Run」）、`:905`（「重试中 · attempt 2 / 3」）、`:915`（「已复用现有 Run」）、`:917`（「小蓝仅有 1 个有效 Run」）。DESIGN 的术语禁令（L24）只限定工作页签文案；任务书却把「聊天消息中展示 Run/Attempt/steering…」列为冲突类型。
- **原型证据**：prototype:branch-U-ACTIVE / C-MULTI / F-OFFLINE / F-RETRY / F-DEDUPE 截图。
- **位置**：`docs/roundtable/prototype/index.html:662,825,896,905,915,917`；RT-24 输出（:675）。
- **为什么**：两个高优先级来源真实冲突，按任务书不得自行选边。
- **正确行为**：见 §7 D1（方案 A：独立原型修订 PR 扩展禁令并改写 6 处；方案 B：原型逐字文案为权威）。裁决前 RT-24 不得新增含这些术语的文案（计划已加该约束）。
- **归属**：用户裁决 D1；RT-24 按裁决执行。
- **裁决（D1=A，2026-10-24）**：维持禁令并扩展到聊天区。原型 6 处文案已改写为用户语言，DESIGN.md 新增聊天区文案边界条款（stacked PR `codex/rt-d1-prototype-copy-revision`），RT-24 按修订后原型实现。

### CF-05 · P2 · missing-requirement
- **当前事实**：main 侧边栏无「后台任务」入口（CAP-01 已退役旧 Task Center）；RT-00～RT-30 无任务负责该 surface。
- **原型证据**：prototype:main-stage-1 侧边栏「后台任务 6」；DESIGN L20；PRD §9.3。
- **位置**：实施计划 §4（覆盖缺口）。
- **正确行为**：新增 FIX-SIDEBAR-G（读取与群内「工作」同一投影）；计数徽标按 D2=B 保留（单一口径后台任务数）。RT-30 全链验收前需落位。
- **归属**：FIX-SIDEBAR-G（新任务）。

### CF-06 · P3 · missing-requirement
- **当前事实**：`group-panel.tsx:390-431` 资料库行无悬停更多操作。
- **原型证据**：prototype:interaction:rail-library；DESIGN L19。
- **正确行为**：行内悬停更多操作；保持无外框、无逐行「打开」按钮。归属 FIX-GROUP-C（RT-22 后续）。

### CF-07 · P3 · ambiguous
- **当前事实**：`group-panel.tsx:486-492` 把 running/queued/interrupted 统一显示为「后台工作中」；正在回复的会话 Run 也显示为后台工作中。
- **原型证据**：prototype:branch-C-DUAL —— 「正在回复」与「后台工作」是并存两条信息。
- **为什么是 ambiguous**：PRD §9.2 要求不压成三选一，但成员行是否需要区分「正在回复」取决于 RT-24 活动胶囊的语义合并方案。
- **正确行为**：RT-24 与 RT-22 联合澄清（信息架构：成员行状态 vs 活动胶囊）。归属 FIX-GROUP-C / FIX-APPROVE-E。

### CF-08 · P3 · confirmed
- **当前事实**：`packages/adapters/src/agentscope-runtime.ts:909` 写入用户可见 Run error「AgentScope service connection failed」，ExecutionCard 原样展示（main-app:group-chat-after-run）。
- **原型证据**：branch-F-OFFLINE / F-RETRY —— 失败以 Agent 视角或中性状态行呈现，无执行器名称。
- **正确行为**：错误投影使用用户语义文案；实现细节进日志/审计。归属 FIX-APPROVE-E（存量修复，非 RT 任务）。

### CF-09 · P3 · false-positive（记录性裁决）
- 工作页页头「进行中的工作 3 项进行中」是页面内容计数，不属于 DESIGN L14 禁止的「入口/页签数量」。入口与页签永不显示数量；页面内计数按原型保留。源码中的 progress fixture 数值未渲染，不得当作百分比要求。

### CF-10 · P2 · confirmed（计划文本）
- **当前事实**：RT-03 输出「服务端列表、搜索、群选择器和未读过滤」（原 :183）表述诱导后端任务实现 UI 面；在途 PR #118 实为纯后端。
- **正确行为**：改写为 `agent_pair` 的服务端排除查询契约；UI 归 RT-09/RT-22。本 PR 已修订，RT-03 保持 backend-only。

### CF-11 · P2 · confirmed（预防性）
- **当前事实**：RT-25 的 queued/lease/fence/409/recovering 是合法内部语义，但计划缺少「禁止成为产品文案」的显式边界；此前任务提示词曾把 409/recovering 当作文案方向。
- **正确行为**：计划已加边界条款；JSON 将这些词声明为 `userVisible:false`，验证器强制。RT-25 恢复时只能做后端、不得引入任何新界面语义。

### CF-12 · P3 · missing-requirement
- **当前事实**：原型顶栏「工作」直达按钮在 main 无对应物；RT-22 只交付页签。
- **正确行为**：顶部窄入口随 FIX-GROUP-C/RT-23 落地，直达工作页签、不显示数量。

## 7. Blocking decisions（已裁决 2026-10-24）

| ID | 问题 | 裁决 | 落点 |
| --- | --- | --- | --- |
| D1 | 原型聊天区 6 处文案中的 Run / attempt / steering / support Run 是否保留（CF-04） | **A：维持禁令并扩展到聊天区** | 原型 6 处文案改写为用户语言、DESIGN.md 新增聊天区文案边界条款（stacked PR）；RT-24 按修订后原型实现 |
| D2 | 侧边栏「后台任务」入口是否显示计数徽标（CF-05） | **B：保留徽标** | 口径定义为「运行中的后台任务数」——单一口径客观计数（PRD O07「后台仍有 N 项」先例），不属于 L14 针对混合口径工作入口的禁令；FIX-SIDEBAR-G 按此实现 |

## 8. 后续修复任务清单（按可独立合入的 surface 拆分）

| 任务 | Surface | 依赖 | 文件范围 | 原型引用 | 验收与截图 |
| --- | --- | --- | --- | --- | --- |
| **FIX-MSG-A** 群消息与公开委派（RT-08 重开） | 群聊消息/回执 | RT-06 ✓、RT-07 ✓、D1=A ✓ | `PublicDelegationMessage.tsx`、`public-collaboration.ts`、`Shell.tsx:6779` 分支、`group-chats.spec.ts` | main-stage-2/3、branch-F-OFFLINE、DESIGN L8/23/24 | 无执行状态枚举；公开协作不打开 peer 视图；失败为「未发送给 X」红行；键盘+390px 不溢出；重放 stage-2/3 截图对比 |
| **FIX-PAIR-B** private receipt 与 pair 浮窗（RT-09） | receipt/浮窗 | RT-05（依赖 #118、#110） | receipt 行组件、pair 浮窗组件、`Shell.tsx` 回执路径 | branch-X-BOT/Q-MULTI/Q-UNAVAILABLE、interaction:pair-float/receipt-expanded、DESIGN L8/10/11 | 单行轻回执；展开名单；只读浮窗（身份胶囊+唯一关闭）；不进侧边栏；停用 Bot「未发送给 X」；三态截图对比 |
| **FIX-GROUP-C** 群详情基础页（RT-22 后续） | 右栏/顶栏 | RT-22 ✓ | `group-panel.tsx`、`Shell.tsx` 顶栏 | interaction:rail-library/members、main-stage-1、DESIGN L14/19 | 资料库行悬停操作；成员状态语义澄清（CF-07）；顶部工作直达无数量；悬停态截图 |
| **FIX-WORK-D** 工作页与 Task 详情（RT-23） | 右栏工作/详情/composer | #117、RT-20（依赖 RT-18 链）、RT-22 ✓ | `group-panel.tsx` work 面板、task chip 组件 | interaction:work-tab/task-detail/amend-chip、branch-A-COMPLETED、DESIGN L15/22/24 | 原位详情无二层抽屉；「追加复核」按原型（CF-03 落点）；补充要求回 composer 带 chip；无百分比；三态截图对比 |
| **FIX-APPROVE-E** 审批、失败和恢复投影（RT-12/24/28 面 + 存量文案） | 审批卡/消息/胶囊/ExecutionCard | RT-12、RT-24、RT-28、D1=A ✓ | `agentscope-runtime.ts:909`、`ExecutionCard.tsx`、状态消息渲染 | main-stage-7、branch-P-*/X-GROUP-FAIL/F-* | 审批卡内嵌消息流（拒绝/允许一次/加入并继续）；授权范围卡；失败恢复文案遵循 D1=A 的修订后原型；清除「AgentScope」字样（CF-08）；四态截图 |
| **FIX-GLOBAL-F** 响应式与键盘行为 | 全局 | A–E | e2e specs | interaction:narrow-*、DESIGN L12 | 窄屏覆盖层；胶囊/药丸直达工作页签；页签键盘导航；430px 截图两张 |
| **FIX-SIDEBAR-G** 侧边栏后台任务中心（新） | sidebar | D2=B ✓、RT-20 | `Shell.tsx` 侧边栏 | main-stage-1、DESIGN L20、PRD §9.3 | 跨会话工作入口；与群内「工作」同一投影；徽标为单一口径后台任务数（D2=B）；侧边栏截图对比 |

拆分原则：每个 FIX 任务可独立合入（对应一个 PR），不互相夹带；A/B 是 UI 重建，C/D/E 增量修补，F 是收尾验收，G 需先裁决 D2。在审计合入前：RT-08、RT-14 的 UI 部分保持暂停；RT-03、RT-25 只做后端且不得引入任何新界面语义。

## 9. 本 PR 包含的修订

1. `roundtable-implementation-plan.md`：
   - RT-08 输出改为语义化派发痕迹，明确禁止执行状态枚举与逐目标状态机，禁止复用私有回执路径；
   - RT-14 验收移除「显示“追加复核”」，展示职责划归 RT-23 并要求复刻原型结构；
   - RT-03 输出改写为服务端排除查询契约；
   - RT-25 增加内部语义边界条款（lease/fence/409/recovering 禁止成为产品文案）；
   - RT-24 增加 D1 裁决前的文案禁令；
   - RT-22 补资料库悬停操作与顶部工作直达挂点；
   - RT-20 增加用户可见状态词表约束（仅 `GroupWorkState`）；
   - RT-09 补「不新增侧边栏会话入口」；
   - RT-11 补来源回显卡对齐原型分支。
   已确认的后端安全语义（事务边界、gate、幂等、授权）未做任何修改。
2. `audits/ui-prototype-conformance.json`：31 个 RT 分类/可见性声明 + 12 条冲突 + 2 项 blocking decision + 7 项修复任务。
3. `verify-ui-conformance.mjs` + `verify-ui-conformance.test.mjs`：一致性验证器（非全局禁词扫描——内部术语在 backend 任务中合法存在，验证器只检查它们是否被声明为 user-visible，且 direct-ui/projection 任务必须有原型引用、confirmed 冲突必须有修复归属、backend-only 任务不得声明新 UI 面）。

## 10. 验收对照

- 31 个 RT 全部有分类与裁决：§5 + JSON `tasks`（验证器强制无遗漏）。
- 8 个主阶段与 28 个分支全部有实际渲染证据：`evidence/prototype/`（JSON `evidenceManifest`，验证器强制引用可解析）。
- 当前 main 与未来任务定义都被覆盖：§5「main 实测」+ 计划修订 + 在途 PR 审视。
- 每个确认冲突都能落到明确修复任务：CF-01→FIX-MSG-A、CF-02→FIX-MSG-A、CF-03→FIX-WORK-D、CF-05→FIX-SIDEBAR-G、CF-06/07/12→FIX-GROUP-C、CF-08→FIX-APPROVE-E、CF-10/11→本 PR 计划修订、CF-04→D1=A 已裁决（原型修订 stacked PR 落地）。
- 实施计划已消除冲突性要求：§9 修订清单。
- 验证器与测试通过：`node docs/roundtable/verify-ui-conformance.mjs`、`node --test docs/roundtable/verify-ui-conformance.test.mjs`；原计划验证器继续通过（31 任务/39 AC/96 场景）。
- PR 只包含审计材料、任务定义修订和验证器；未改 prototype/index.html 与 DESIGN.md；未顺手重做生产 UI。

## 11. 裁决落地记录（stacked PR，2026-10-24）

D1=A、D2=B 裁决后，在审计分支之上叠加 `codex/rt-d1-prototype-copy-revision` 落地：

1. `prototype/index.html`：改写 6 处聊天区文案——U-ACTIVE 胶囊「小蓝已接收你的新指令 · 后台基线继续」、C-MULTI 胶囊「2 项任务已独立完成」、F-OFFLINE「……没有开始这项工作。」、F-RETRY「重试中 · 第 2 / 3 次尝试」、F-DEDUPE「沿用首次派活……」/「小蓝只有 1 项有效任务」；受影响的 5 张分支证据截图已重拍覆盖（源码 `note` 注释字段从不渲染，不属聊天区文案，未改）。
2. `prototype/DESIGN.md`：新增「聊天区文案边界」条款（术语禁令扩展至聊天区，批处理/重试允许客观计数）与「侧边栏徽标口径」条款（D2=B 单一口径后台任务数）。
3. 实施计划 RT-24 行改为已裁决表述；JSON 中 D1/D2 → resolved、CF-04 blocks 解除、FIX 依赖更新；验证器 RT-24 检查模式同步。
