# CARD-01B：核心 Interaction 与 Card Shell

状态：`not-started`

父任务：[CARD-01 卡片统一与拓展](./CARD-01.md)

依赖：[CARD-01A](./CARD-01A.md)。

## 用户结果

用户能从统一卡片外壳处理输入、审批、计划审阅和会话控制。四种成员的来源、状态、权限与后续动作清楚分开；不再出现气泡 ask 与 Intervention region 双卡、计划审阅混入工具授权或关闭面板被当成拒绝。

## 输入

- [CARD-01 决策](../cards/CARD-01-decision.md)
- [生产实现盘点](../cards/CARD-01-implementation-inventory.md)
- [STYLE-SPEC](../cards/source/card-unification-v2/mockup/cards-hifi-v4/STYLE-SPEC.md)
- 主要场景：`cards.html` A1–A13、B1；其中 A7 同时包含 `connect.app_authorization` 与 `connect.mcp_assignment` 两张卡；`a-detail.html` V1、V5、V6、V7
- 验收截图：[cards](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-cards.png)、[details](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a-detail.png)、A7 风险卡 [390px](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a7-390.png) / [375px](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a7-375.png)

## 范围

- 新增统一 Card Shell 和 Interaction renderer，渲染 `InputRequestView`、`ActionApprovalView`、`PlanReviewView`、`SessionControlView`。
- 统一来源区：Bot、Task、Run/Step 或明确 reply target；群聊请求必须可寻址。
- 输入：question、choice、form、secret、saved_item。敏感值只显示脱敏摘要。
- 审批：`tool`、`payment`、`outbound`、`routine`、`install`、`skill_save`、`connect.app_authorization`、`connect.mcp_assignment`。外部结果只引用 ExternalEffect 或业务事务，不用 `agent.tool.completed` 冒充成功。
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
- 统一 `InterventionRegion` 与 `execution-card.ts` 的 interaction 排序：`PlanReviewView → ActionApprovalView → InputRequestView`，同组 `createdAt ASC → stableId ASC`；不得保留两套优先级。
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
- 新增 Task Center、移动端实现、第二套导航或第二套品牌
- 在 gate 关闭时替换现有生产卡片路径

## 验收

- A1–A13 与 B1 都有可见、可操作的状态和停止条件。
- A10 编辑保存后显示 r1 superseded、r2 pending；最终发送内容、revision 和 fingerprint 一致。
- A12 在选择完成前不出现付款审批；付款审批是独立决定。
- A13 的 DOM 和文案不存在 `requestApproval(tool)`；计划批准与工具授权在测试中互斥。
- A7 同时出现 `connect.app_authorization` 与 `connect.mcp_assignment`；MCP 卡显示 `allowAllTools: true` 风险、服务器范围和操作，操作上限仍为两个按钮加一个文字入口。
- `InterventionRegion`、`execution-card.ts` 和共享 renderer 使用同一排序：plan review → approval → input；同组按 `createdAt` 升序、再按 `stableId`，并有冲突用例证明两套旧实现已被统一。
- B3 安装完成才进入授权；安装失败与授权失败可区分。
- A9/B1 的接管、交还不改变 Run/Interaction 的权威状态。
- 每卡按钮不超过两个、文字入口不超过一个；失败/过期/未知没有重试。
- 键盘 Tab 可浏览，Esc 关闭最上层，Enter 不是全局 consequential 快捷键，关闭后焦点回到触发点。
- 390px 主画面和 375px 回归无横向溢出、按钮截断或遮挡；深色模式可读。
- 现有 `intervention-region`、`plan-review`、`approval-resume`、`secret-card`、`login-card`、`execution-card` 套件继续通过。

## 交付

Web 实现、组件测试、场景 e2e 和 390/375 截图。总 gate 保持默认关闭。
