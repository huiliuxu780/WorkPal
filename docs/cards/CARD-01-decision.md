# CARD-01 卡片统一决策

状态：产品决策已确认，2026-10-24。可运行原型已批准入库；生产实现未开始，总 gate 默认关闭。

## 用户要完成什么

用户需要看懂 Bot 在问什么、准备做什么、是否已经执行，以及自己现在必须做什么。用户不需要理解 MessageBlock、Run、Attempt、Intervention 或 ExternalEffect。

正常调用只表达业务意图：

```text
requestInput(question | choice | form | secret | saved_item)
requestApproval(tool | payment | outbound | routine | install | skill_save | connect.app_authorization | connect.mcp_assignment)
requestSessionControl(takeover | return)
showContent(markdown | table | chart | collection | media | html | task_status | page | voice)
```

Web 从服务端投影渲染这些类型。Web 不从可选字段组合、工具日志或文本内容猜类型、权限和状态。

- `skill_save` 对应 TaughtSkill 业务事务，不是一次工具执行；保存决定不得经过工具授权链。
- `connect.app_authorization` 与 `connect.mcp_assignment` 必须是不同的严格 payload。MCP assignment 当前会写入 `allowAllTools: true`，审批卡必须展示该风险范围。

## 已核实的现状

- `MessageBlock` 已经是按 `kind` 区分的联合类型，但 `ask` 同时承载文本输入、密钥、审批、建空间和计划审阅。调用方仍要检查字段组合。
- `InterventionView` 已经分开 `approval`、`input` 和 `plan_review`，也将 Intervention 状态与 `approval.effectStatus` 分开。CARD-01 应扩展这个边界，不应退回一个全是可选字段的 `action` 对象。
- `ExternalEffect` 负责外部动作事实。`agent.tool.completed` 是执行活动事件，不能单独证明外部系统已经完成动作。
- 当前前端仍有 AskCard、ChoiceCard、连接卡、MCP 审批卡、Computer 卡和 SkillDraftCard 等独立入口。

## 选择的结构

统一 Card Shell，不统一成一个万能业务类型。

```ts
type InteractionView =
	| InputRequestView
	| ActionApprovalView
	| PlanReviewView
	| SessionControlView;

type DisplayBlock =
	| MarkdownBlock
	| TableBlock
	| ChartBlock
	| CollectionBlock
	| MediaBlock
	| HtmlBlock
	| TaskStatusBlock
	| PageLinkBlock
	| VoiceMessageBlock;
```

`PlanReviewView` 对应现有独立的 `plan_review` Intervention。批准一个计划版本只结束该计划版本的审阅，不批准任何工具调用、连接器或凭据，也不进入 `requestApproval(tool)` 的授权链。

每个 `InteractionView` 共享身份、来源、presentation revision 和安全展示字段。每个成员使用自己的严格 payload。新增成员时，TypeScript 和 Zod 的穷尽检查必须指出所有未处理的投影与渲染位置。

表情回应和消息内跳转不是卡片。它们属于消息 affordance 和 inline reference。

## 三个状态所有者

CARD-01 不再用一条状态机同时描述请求、运行和外部动作。

| 状态 | 所有者 | 回答的问题 |
| --- | --- | --- |
| `InterventionStatus` | Intervention | 用户是否仍需回答或决定 |
| Run 状态 | Run | Bot 的这一轮是否仍在执行 |
| ExternalEffect 状态 | ExternalEffect | 外部动作是否执行，以及结果是否确定 |

UI 可以合成一句用户文案，但不能合并持久状态。例如 Run 已取消且 ExternalEffect 为 `executing` 或 `uncertain` 时，卡片显示「运行已停止，发送结果未确认」。卡片不得显示「已作废」，也不得提供重试。

Run 结束不会自动终止所有 Interaction。生命周期由 Intervention 或 ExternalEffect 决定。需要在父 Run 结束后继续处理的来源审批仍可保持有效，但必须保留来源、权限和 expiry。

## 权威事实

- 输入和选择以 Intervention 的事务性 resolution 为准。
- 外部动作以 ExternalEffect 或对应业务事务为准。
- `agent.tool.completed` 只更新活动记录。它不是付款、发信、创建 Routine 或安装成功的最终凭据。
- EFFECT-01 在动作执行前校验当前 Run 执行权。CARD-01 只呈现结果，不能替代该数据库边界。

## 已确认的产品规则

1. A12 选择银行卡或地址不是 consequential 动作。后续付款审批才是 consequential 动作。
2. 群聊中的问题和选择使用轻量、可寻址的 Interaction。回复必须绑定 Bot 和 Task 或明确的 reply target。不得依赖孤立的「A」或「可以」。
3. B3 安装与 A7 授权是两个后端动作。UI 可以把它们显示在一个 stepper 中，但每一步有独立状态、失败和审计记录。
4. A10 在同一卡片中编辑。每次保存创建不可变 revision。发送决定绑定内容 fingerprint，不能批准旧正文后发送新正文。
5. 每张卡最多显示两个按钮和一个文字入口。隐藏在详情中的 consequential 动作仍需本人确认。
6. 桌面采用当前布局可容纳的卡宽。窄屏视觉验收统一使用 390px，并额外运行 375px 无横向溢出回归。
7. 失败、过期和结果未知状态不提供重新执行按钮。读取失败可以提供「重新加载」，该操作只重新读取服务端状态。
8. 终态内容必须保持可读。禁止用固定 40% opacity 降低整张卡。状态使用文字、图标或形状和颜色共同表达。
9. N4 仅使用 Web Notification 或仓库已有的 Web Push。CARD-01 不新增原生移动端。
10. `SessionControlView` 只从 Run、执行租约和 Computer 控制租约派生，不新增持久 Intervention。`takeover` 来自 `waiting_takeover`；`return` 要求 `Computer.controlRunId === run.id` 且用户控制租约仍有效。历史 `computer` block 只能展示，不能充当权限或当前状态来源。
11. 外部连接授权拆为 `connect.app_authorization`（来自 `app_connect`）和 `connect.mcp_assignment`（来自 `mcp_approval`）。两者使用不同严格 payload，并显示各自业务范围；不得共用一个可选字段对象。
12. 旧 `card` 和 `connect` 在 CARD-01A 合并后禁止新增生产者，历史记录长期只读回放。移除必须另立迁移任务，完成历史 backfill 并证明库内无旧形态后才能删除解码器；CARD-01 不负责移除。
13. 同一 interaction region 的排序固定为：
    1. 所有 pending 卡排在 terminal 卡之前。
    2. pending 内按 `PlanReviewView → ActionApprovalView → InputRequestView`。
    3. terminal 历史不按类型抢优先级，只按 `createdAt ASC → stableId ASC`。
    4. 同一 pending 类型内按 `createdAt ASC → stableId ASC`。
    5. `SessionControlView` 保持专用入口，不混入该排序。

    类型优先级只适用于 pending 卡，不能把已结算的旧 PlanReviewView 抬到当前待审批或待输入之前。计划审阅先于工具审批，是因为它约束整个 Run 的后续执行；普通输入最后。CARD-01A 只定义排序字段/语义，CARD-01B 统一 Web 实现和测试。

## 九个开放问题的决定

| 原问题 | 决定 |
| --- | --- |
| 执行结果来源 | ExternalEffect 或业务事务是权威来源 |
| 私聊完成后是否回群 | 仅当请求来自群聊时回一条脱敏状态，不携带密钥、地址、付款内容或外发正文 |
| D2 table | 新增结构化 block。Markdown 表格保留简单静态展示 |
| 长消息阈值 | 以渲染高度或行数折叠，不以字符数决定 UI 高度 |
| 安装与授权 | 后端分开，UI 可组合 stepper |
| 手机推送 | 只做 Web 能力 |
| 分享链接 | 默认要求登录并限制在 Space 内。公开分享需要独立确认、expiry 和撤销能力 |
| 过期前 5 分钟提醒 | 不固定为 5 分钟。先建立可信 `expiresAt`，再按通知策略决定是否提醒 |
| 多次编辑 | 后端保留全部 revision。待处理列表只显示最新 pending revision，旧卡显示 superseded |

## 待处理不是第二个 Task Center

N1 是 attention queue，只列当前用户必须处理的 pending Interaction。它不显示普通运行、后台工作、完成历史或执行详情。处理完成后条目立即消失。点击条目只返回来源消息。

数据边界是当前 actor 有权访问的线程中，所有仍需本人处理的 Interaction 投影：持久 Intervention、当前有效的 `SessionControlView`，以及完成严格映射后的 pending 业务审批。普通 Run、Run 历史、后台任务和旧 `connect` 回放不进入。

排序固定为 `expiresAt ASC NULLS LAST → attentionAt ASC → stableId ASC`。条目按 `interactionId + revision` 去重并分页；过期、结算或失去权限后立即移除。

已有工作列表和 Task 详情继续由 Roundtable 的工作投影负责。CARD-01 不恢复已删除的 Task Center 路由和数据模型。

## HTML 的边界

HTML 是复杂只读报告的兜底，不是默认回复格式。实现复用 `SandboxedHtmlViewer` 的安全边界。默认无同源、无网络、无表单提交、无父页面访问和无顶层跳转。

HTML 中不能出现批准、付款、发送、删除或授权控件。任何副作用必须创建 `ActionApprovalView`。

## 交付方式

产品只开放一个总 feature gate，但实现按可审查边界提交：

1. 严格协议、服务端投影和旧消息适配器。
2. 核心 Interaction 与 Card Shell。
3. DisplayBlock、详情视图和安全 HTML。
4. attention queue 与 Web 通知。
5. 无障碍、窄屏、深色、旧消息回放和视觉回归。

所有部分通过后才开启总 gate。未实现的 variant 返回明确错误或保持禁用，不能显示模拟成功。

总 gate 的内部 key 固定为 `cards_unified_v2`，环境变量为 `CARDS_UNIFIED_V2_ENABLED`，默认 `false`，非法值必须使启动失败。服务端统一解析 gate 并向 Web 投影能力；Web 不得自行读取另一套环境变量。gate 关闭时旧 API 和页面行为保持不变，不得复用 Roundtable 的四项 gate。

## 未选择的方案

### 一个 `action` block 加大量可选字段

拒绝。它让非法字段组合进入协议，并把现有 `ask` 的问题扩大到更多场景。

### 只统一前端组件，保留所有旧协议

拒绝作为最终方案。短期兼容适配器可以这样做，但后端仍会保留多套状态和权限判断。

### 每种卡继续拥有完整协议和生命周期

拒绝。它保留重复状态、重复权限检查和迁移成本。

## 剩余门槛

状态：第 1–4 项已于 2026-10-24 完成，批准原型入库于 `docs/cards/source/card-unification-v2/`；第 5 项已拆为 CARD-01A–E，生产实现尚未开始。

1. 根据本决策更新 v4 PRD、STYLE-SPEC、HTML、CSS 和生成脚本。
2. 重新生成 cards、detail、alerts 和 states 四组截图。旧截图不再是验收基准。
3. 将去除本机信息和私有数据的原型存入 `docs/cards/source/card-unification-v2/`。
4. 产品负责人确认更新后的可运行原型。
5. 对照确认后的原型拆分实现任务。每个任务写明允许范围、禁止改动、场景文件和截图验收。
