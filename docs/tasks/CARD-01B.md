# CARD-01B：核心 Interaction 与 Card Shell

状态：`not-started`

父任务：[CARD-01 卡片统一与拓展](./CARD-01.md)

依赖：[CARD-01A](./CARD-01A.md) 和 [RT-09](../roundtable/roundtable-implementation-plan.md#rt-09-实现-private-receipt-和-pair-浮窗)。RT-09 必须先完成；CARD-01B 保留 private receipt 的非卡片语义。RT-12 依赖本任务。

## 用户结果

用户能从统一卡片外壳处理输入、审批、计划审阅和会话控制。四种成员的来源、状态、权限与后续动作清楚分开；不再出现气泡 ask 与 Intervention region 双卡、计划审阅混入工具授权或关闭面板被当成拒绝。

## 输入

- [CARD-01 决策](../cards/CARD-01-decision.md)
- [生产实现盘点](../cards/CARD-01-implementation-inventory.md)
- [STYLE-SPEC](../cards/source/card-unification-v2/mockup/cards-hifi-v4/STYLE-SPEC.md)
- 主要场景：`cards.html` A1–A13、B1；其中 A7 同时包含 `connect.app_authorization` 与 `connect.mcp_assignment` 两张卡；`a-detail.html` V1、V5、V6、V7
- 验收截图：[cards](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-cards.png)、[details](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a-detail.png)、A7 风险卡 [390px](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a7-390.png) / [375px](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a7-375.png)
- `group_membership` 视觉基线（Roundtable 已确认原型，不新增 CARD A14）：
  - `docs/roundtable/prototype/index.html?branch=X-GROUP-APPROVE`
  - `docs/roundtable/prototype/index.html?branch=X-GROUP-FAIL`
  - `docs/roundtable/audits/evidence/prototype/branch-X-GROUP-APPROVE.png`
  - `docs/roundtable/audits/evidence/prototype/branch-X-GROUP-FAIL.png`
  - `docs/roundtable/audits/evidence/prototype/narrow-branch-X-GROUP-APPROVE.png`
  - `docs/roundtable/audits/evidence/prototype/narrow-branch-X-GROUP-FAIL.png`

## 范围

- 本任务是以下位置的唯一 owner：`apps/web/src/pages/Shell.tsx` 的 Interaction renderer 接入、Card Shell、InteractionView renderer、`InterventionRegion` 统一和 interaction 排序。CARD-01C 不得在接入接口冻结前修改同一 Shell 区域。
- 新增统一 Card Shell 和 Interaction renderer，渲染 `InputRequestView`、`ActionApprovalView`、`PlanReviewView`、`SessionControlView`。
- 统一来源区：Bot、Task、Run/Step 或明确 reply target；群聊请求必须可寻址。
- 输入：question、choice、form、secret、saved_item。敏感值只显示脱敏摘要。
- 审批：`tool`、`payment`、`outbound`、`routine`、`install`、`skill_save`、`connect.app_authorization`、`connect.mcp_assignment`、`group_membership`。外部结果只引用 ExternalEffect 或业务事务，不用 `agent.tool.completed` 冒充成功。
- `group_membership` 使用 CARD-01A 的严格 payload 渲染，视觉和用户语言对齐 Roundtable X-GROUP-APPROVE / X-GROUP-FAIL；批准动作只表示加入群并继续绑定的 `message_group` 请求，不得展示为通用工具审批，也不得自行补第三种视觉。
- `collaboration_receipt` 保持 RT-11 的独立 MessageBlock 语义；本任务不做卡片化改造，不把 receipt 加入 InteractionView、attention queue 或排序。若复用 Card Shell 的无状态展示组件，不得改变 receipt 的持久协议、状态所有权或 destination locator。
- private pair receipt 保持消息 affordance：单行轻回执或展开名单，不使用 Card Shell，不新增侧栏入口。RT-09 的视觉实现必须原样保留。
- A7 必须分别渲染 app authorization 与 MCP assignment。MCP assignment 卡要显示 `allowAllTools: true` 的明确风险标题/说明、服务器范围和对应操作；不得只写“授权连接”，不得共用 app authorization payload。
- A12 先选择已保存项，完成后再出现独立付款审批。
- A10 同卡编辑、不可变 revision、fingerprint 绑定发送决定；待处理只显示最新 pending，旧 revision 显示 superseded。
- B3 安装与授权使用独立状态、失败和审计；允许在 stepper 中组合。
- A13 使用独立 `PlanReviewView`，按钮只批准计划版本；不得批准工具、连接器或凭据。
- A9/B1 接管与交还是会话控制视图，不扩展为新的持久状态机。
- 每张互动卡最多两个按钮和一个文字入口；consequential 动作必须本人确认。
- 关闭详情、面板或弹窗不等于拒绝、取消或结算。
- 失败、过期和结果未知不提供重试；只有读取失败提供“重新加载”，且不重新执行动作。
- 不再用整卡 40% opacity 表达终态；状态同时使用文字和图标/形状，不只靠颜色。
- 统一 `InterventionRegion` 与 `execution-card.ts` 的 interaction 排序：所有 pending 卡先于 terminal；pending 内 `PlanReviewView → ActionApprovalView → InputRequestView`，同类型按 `createdAt ASC → stableId ASC`；terminal 历史不按类型抢优先级，只按 `createdAt ASC → stableId ASC`。不得保留两套优先级。
- 替换现有 `AskCard`/`InterventionRegion`/`PlanReviewCard` 的重复 surface，保留 `coveredAsks` 去重目标。

## 允许修改

- `apps/web/src/components/ai/` 中的 Interaction 组件、Card Shell、primitive 和样式
- `apps/web/src/components/AskCard.tsx`
- `apps/web/src/pages/Shell.tsx` 的卡片调用点
- `apps/web/src/pages/shell/use-execution-transcript.tsx`
- `apps/web/src/lib/intervention-view.ts`、`execution-surface.ts`、`execution-status.ts` 等纯映射
- 对应 Web 单元测试和 Playwright 场景

## 禁止

- 修改 Interaction 契约/投影或外部动作执行权；Interaction 契约/投影属于 CARD-01A
- 修改 attention 查询/RPC 或 queue 数据边界；这些属于 CARD-01D
- 修改展示族、详情面板或 attention queue；分别属于 CARD-01C/D
- 在 CARD-01C 的接入接口冻结前与其并行修改 `Shell.tsx` 的同一 block
- 为 `group_membership` 创建第二套审批卡、第二套状态 renderer 或通用工具审批
- 把 `collaboration_receipt` 或 private pair receipt 改造成 Card Shell 成员，或把它们加入 attention queue/排序
- 新增 Task Center、移动端实现、第二套导航或第二套品牌
- 在 gate 关闭时替换现有生产卡片路径

## 验收

- A1–A13 与 B1 都有可见、可操作的状态和停止条件。
- A10 编辑保存后显示 r1 superseded、r2 pending；最终发送内容、revision 和 fingerprint 一致。
- A12 在选择完成前不出现付款审批；付款审批是独立决定。
- A13 的 DOM 和文案不存在 `requestApproval(tool)`；计划批准与工具授权在测试中互斥。
- A7 同时出现 `connect.app_authorization` 与 `connect.mcp_assignment`；MCP 卡显示 `allowAllTools: true` 风险、服务器范围和操作，操作上限仍为两个按钮加一个文字入口。
- `group_membership` 卡使用 CARD-01A 的严格 payload；有成员管理权限时渲染 X-GROUP-APPROVE 的“加入并继续/暂不加入”，无权限时不渲染审批卡而是 X-GROUP-FAIL 的独立失败状态；DOM/文案不出现 `requestApproval(tool)` 或任意工具名。
- `collaboration_receipt` 仍由 RT-11 的独立渲染路径处理，未进入 Interaction 排序或 attention queue；复用 Card Shell 展示组件时 receipt 的 `state`、`target` 和 `destination` 不变。
- private pair receipt 保持 RT-09 的单行轻回执或展开名单，不使用 Card Shell；打开 pair 浮窗的只读语义不变。
- `InterventionRegion`、`execution-card.ts` 和共享 renderer 使用同一排序：pending 领先 terminal；pending 内 plan review → approval → input；同类型和 terminal 历史均按 `createdAt` 升序、再按 `stableId`。
- 冲突用例覆盖 `answered PlanReviewView + pending ActionApprovalView/InputRequestView`：region 中 pending approval/input 必须排在已结算的计划审阅之前，execution-card headline 也必须指向 pending 卡。
- B3 安装完成才进入授权；安装失败与授权失败可区分。
- A9/B1 的接管、交还不改变 Run/Interaction 的权威状态。
- 每卡按钮不超过两个、文字入口不超过一个；失败/过期/未知没有重试。
- 键盘 Tab 可浏览，Esc 关闭最上层，Enter 不是全局 consequential 快捷键，关闭后焦点回到触发点。
- 390px 主画面和 375px 回归无横向溢出、按钮截断或遮挡；深色模式可读。
- 现有 `intervention-region`、`plan-review`、`approval-resume`、`secret-card`、`login-card`、`execution-card` 套件继续通过。

## 交付

Web 实现、组件测试、场景 e2e 和 390/375 截图。总 gate 保持默认关闭。CARD-01C 的 Shell 接入由本任务 owner 提交集成 commit，或等本任务合入后由 C 分支 rebase。
