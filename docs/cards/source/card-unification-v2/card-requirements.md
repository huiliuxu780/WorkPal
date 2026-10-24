# WorkPal 卡片统一 · 产品需求文档（CARD-01 对齐版）

- 状态：产品原型评审版 · 2026-10-24
- 视觉与操作：`mockup/cards-hifi-v4/`
- 范围：27 个产品场景、7 个详情场景、4 类提醒，以及加载、窄屏、深色和无障碍
- 边界：目标协议是产品示意，不代表现有生产 API；本原型不解除生产实现阻塞

## 1. 用户目标与原则

用户需要看懂 Bot 在问什么、准备做什么、是否已经执行，以及自己现在必须做什么，不需要理解内部执行模型。

1. 统一 Card Shell，不统一业务 payload。
2. 后端负责鉴权、授权、权限、幂等、状态和审计；Web 只渲染服务端投影。
3. 未实现能力必须失败或禁用，不能用模拟成功代替真实执行。
4. 原型中的状态切换是本地确定性演示，不产生真实网络或外部动作。

## 2. 目标协议与当前兼容输入

**CARD-01 目标结构（示意类型名，不是已存在的生产 API）：**

```ts
type InteractionView =
	| InputRequestView        // requestInput(question | choice | form | secret | saved_item)
	| ActionApprovalView      // requestApproval(tool | payment | outbound | routine | install | skill_save | connect.app_authorization | connect.mcp_assignment)
	| PlanReviewView          // plan_review：计划版本审阅，独立成员
	| SessionControlView      // requestSessionControl(takeover | return)

type DisplayBlock = showContent(markdown | table | chart | collection | media | html | task_status | page | voice)
```

目标 `InteractionView` 分为四个独立成员：输入请求、动作审批、计划审阅和会话控制；`DisplayBlock` 分为有限展示成员。每个成员有严格 payload，不使用一个带大量可选字段的万能业务对象。

`PlanReviewView` 对应当前生产契约中独立的 `plan_review` Intervention kind，展示与决定都不经过工具授权链：**批准一个计划版本不批准任何工具调用、连接器或凭据**。后续工具、连接器与付款仍需各自审批。

**当前兼容输入**只包括旧消息和现有服务端投影可明确适配的 `ask`、`choice`、`app_connect`、`mcp_approval`、`connect`、`skill_draft`、`computer`、`text`、`card`、`chart`、`image`、`file`、`subagent`、`cloud_agent`、`child_bot` 等。适配集中在服务端投影或前端 API 适配层；旧快照不作为当前代码事实。旧 `ask` 的计划审阅变体适配到独立 `PlanReviewView`（`plan_review`），不归入输入请求或动作审批。`app_connect` 映射到 `connect.app_authorization`，`mcp_approval` 映射到 `connect.mcp_assignment`，两者使用不同严格 payload；MCP assignment 必须展示 `allowAllTools: true` 的实际风险范围。`skill_draft` 映射到 `requestApproval(skill_save)`，权威事务是 TaughtSkill 保存，不是工具执行。未识别或非法组合必须拒绝渲染为可操作卡。

旧 `card` 和 `connect` 只做历史只读回放；CARD-01A 合并后禁止新增生产者。移除必须另立迁移任务，完成历史数据 backfill 并证明库内无旧形态后才能删除解码器，CARD-01 不负责移除。

## 3. 状态、权威事实与权限

### 3.1 三个状态所有者

| 所有者 | 职责 | 结果示例 |
|---|---|---|
| Intervention | 用户是否仍需回答或决定 | pending、answered、declined、expired、superseded |
| Run | 本轮 Bot 是否仍执行 | running、completed、stopped |
| ExternalEffect / 业务事务 | 外部动作是否执行、结果是否确定 | executing、succeeded、failed、uncertain |

UI 可合成用户文案，但不能合成持久状态。Run 结束不自动作废 Interaction；每个请求按 Intervention 或 ExternalEffect 的生命周期结束。

- Run 停止且外部结果不确定：显示“运行已停止，发送结果未确认”，不显示“已作废”，不提供重新执行。
- 输入与选择以 Intervention 的事务性 resolution 为准。
- 外部结果以 ExternalEffect 或业务事务为准。`agent.tool.completed` 只表示执行活动。
- 来源审批在父 Run 结束后仍可有效，但必须保留来源、权限和 expiry。

### 3.2 权限

- consequential 决定只接受运行所属用户本人；Bot 转述、群聊文字和记忆中的同意均无效。
- 计划审阅（`plan_review` / `PlanReviewView`）只决定计划版本；批准计划版本不批准任何工具调用、连接器或凭据，后续工具与连接器按各自审批处理。
- 群聊问题与选择必须可寻址：绑定 Bot，以及 Task 或明确 reply target。
- 私聊完成群来源请求后，只在原群回一条脱敏状态，不携带密钥、地址、付款内容或外发正文。
- 双击和多端决定由后端幂等与事务保证，前端禁用只是辅助。

## 4. 27 个产品场景

以下 A1–A13、D1–D7、B1–B7 是产品场景编号，不表示 27 张同构动作卡。

### 4.1 A1–A13：互动场景

| 编号 | 场景与目标成员 | 产品要求与验收 |
|---|---|---|
| A1 | 工具审批 · `requestApproval(tool)` | 显示工具、目标、风险、Bot、Task、Run/Step；群聊不出现持久授权入口；拒绝后 Bot 收到决定。 |
| A2 | 密钥 · `requestInput(secret)` | 私聊收集；提交后明文不出现在消息、事件或日志；群聊只给私聊引导。 |
| A3 | 登录 · `requestInput(secret)` | 严格登录 payload；用户名为空不可提交；密码不回显。 |
| A4 | 提问 · `requestInput(question)` | 回答绑定 Bot、Task/reply target；完成后显示非敏感答案摘要。 |
| A5 | 选择 · `requestInput(choice)` | 选中与提交清晰；答案以 resolution 为准，不接受孤立“A”作为群回复凭据。 |
| A6 | 建空间 · `requestApproval(tool)` | 本人确认；创建成功后链接来自业务事务。 |
| A7 | 授权 · `requestApproval(connect.app_authorization)` | 来自 `app_connect`；与 MCP assignment 使用不同严格 payload；OAuth 关闭且未完成时保持 pending；与安装独立。 |
| A8 | 保存技能 · `requestApproval(skill_save)` | 可查看 playbook；保存绑定当前内容快照；权威事务是 TaughtSkill 保存，不是工具执行。 |
| A9 | 接管电脑 · `requestSessionControl(takeover)` | 主按钮“打开桌面”；只暂停对应 Bot；群聊引导本人到可操作上下文。 |
| A10 | 外发草稿 · `requestApproval(outbound)` | 同卡编辑；不可变 revision；最新 pending 才可发送；决定绑定 fingerprint；收件人与正文必须与确认页一致。 |
| A11 | 表单 · `requestInput(form)` | 必填就地校验；敏感支付/密钥不混入；完成后只显示非敏感摘要。 |
| A12 | 已保存卡/地址 · `requestInput(saved_item)` | 仅显示脱敏 saved item；此步不付款；完成后出现独立 `requestApproval(payment)`，金额、商户和卡末四位清晰。 |
| A13 | 计划审阅 · `PlanReviewView`（独立 `plan_review` 成员） | 只有最新 pending revision 可审阅；批准计划版本不批准任何工具调用、连接器或凭据；后续工具、连接器与付款各自审批。 |

### 4.2 D1–D7：展示场景

| 编号 | 场景与目标成员 | 产品要求与验收 |
|---|---|---|
| D1 | Markdown · `showContent(markdown)` | 普通回复与简单静态表格；长文按渲染高度或行数折叠。 |
| D2 | 表格 · `showContent(table)` | 结构化 columns/rows；排序与分页；不是 Markdown 表格增强。 |
| D3 | 图表 · `showContent(chart)` | 超限明确失败；提供数据表替代；无半张图冒充完成。 |
| D4 | 集合 · `showContent(collection)` | 键值与结果列表；条目只读，执行动作另发审批。 |
| D5 | 媒体 · `showContent(media)` | 图片可放大；文件按能力预览或下载；HTML 文件走沙箱。 |
| D6 | HTML · `showContent(html)` | 仅复杂只读报告；无同源、无网络、无表单提交、无父页面访问、无顶层跳转；无副作用控件。 |
| D7 | 任务状态 · `showContent(task_status)` | 展示 Run/来源/结果；普通后台工作不进入 attention queue。 |

### 4.3 B1–B7：补充场景

| 编号 | 场景与归类 | 产品要求与验收 |
|---|---|---|
| B1 | 交还桌面 · `requestSessionControl(return)` | 与 A9 对应；交还不批准后续操作；记录控制权状态。 |
| B2 | Routine 变更 · `requestApproval(routine)` | 显示新旧值、cron/人读描述与时区；暂停、修改、删除都需独立确认；结果以 Routine 事务为准。 |
| B3 | 安装 · `requestApproval(install)`，需要时接 `connect` | 安装与授权是两个后端动作；stepper 各步独立状态、失败与审计；安装失败不进入授权，授权失败不回写安装失败。 |
| B4 | Page · `showContent(page)` | 入口展示；按 Page 权限打开；更新与不可用状态明确。 |
| B5 | 语音 · `showContent(voice)` | 播放/暂停、进度、时长与转写；同时只播放一条。 |
| B6 | 表情回应 · 消息操作 | 聚合与取消自己的回应；不是卡片，不进入 Interaction 协议。 |
| B7 | 消息内跳转 · inline reference | 定位并高亮；不可用时显示不可用且不泄露原文；不是卡片。 |

## 5. 通用互动卡规则

1. 每张互动卡最多两个按钮和一个文字入口；详情中的 consequential 动作仍需本人确认。
2. 快照完整前控件禁用；决定后防止重复提交。
3. 失败、过期、拒绝和结果未知保持正文可读，不提供重新执行。
4. 只有读取服务端状态失败可显示“重新加载”；它只重新读取展示状态。
5. 状态使用文字、图标或形状与颜色共同表达，终态不整块降低透明度。
6. 旧 revision 保留 superseded 审计；待处理只显示最新 pending revision。
7. 卡号只显示末四位；密钥不可复制、不可回显；通知不包含敏感内容。

## 6. 七个详情场景

通用：宽屏右侧或模态，窄屏使用可用全宽；关闭返回来源位置。✕、遮罩与 Esc 只关闭，不等于拒绝、取消或放弃修改。详情内决定与来源 Intervention 同步且只记录一次。

| 编号 | 详情 | 要求与验收 |
|---|---|---|
| V1 | A10 外发草稿 | 摘要、完整收件人/主题/正文/附件；同卡编辑；未保存关闭先询问；保存形成 revision；最终确认显示准确内容与 fingerprint；不伪造送达。 |
| V2 | HTML 报告与图表 | 入口只读；面板可开关；图表提供数据表；沙箱边界可见；默认 Space 内登录分享，公开分享独立确认并显示 expiry/撤销。 |
| V3 | 长消息全文 | 按渲染行数/高度折叠；全文目录、复制与下载不改变消息。 |
| V4 | 图片与文件 | 灯箱可开关、Esc 关闭；多图导航；不支持类型显示文件信息与下载；HTML 走沙箱。 |
| V5 | 工具审批详情 | 完整参数、命令、来源与风险；敏感值遮罩；无全局 Enter 批准；Esc 不等于拒绝。 |
| V6 | task_status 运行详情 | 步骤、日志、结果与 Run 状态；Run 停止不自动作废 Interaction；未知外部结果无重新执行。 |
| V7 | Routine 详情与历史 | 配置、历史运行与业务事实；历史留在工作投影；暂停/修改/删除另发 B2 审批。 |

## 7. 四类提醒

### N1 · Attention queue

- 只列当前用户必须处理的 pending Interaction。
- 点击只返回来源消息并聚焦原 Interaction；处理后条目和计数立即更新。
- 不显示普通运行、后台工作、完成历史或执行详情，不恢复 Task Center。
- 排序只使用 pending 请求自身信息；可信 expiresAt 可用于排序，但不得编造时效。

### N2 · 成员等待标记

- 只标记正在等待当前用户的 Bot；显示文字与数量。
- 决定、回答、过期或 superseded 后消失；普通后台工作使用其他工作投影。

### N3 · 未读与待处理角标

- 未读、@我和待处理使用文字/形状与颜色共同区分。
- Bot 间中继与进度不增加未读；待处理角标由 Intervention 生命周期驱动。

### N4 · Web Notification / 现有 Web Push

- 仅 Web 能力，不新增原生手机应用。
- 新 consequential 请求和接管请求可按设置提醒；当前会话前台不提醒。
- 只有可信 expiresAt 存在时，策略才可引用过期时间；不承诺固定提前量。
- 文案只含 Bot、动作类型和会话；不得含收件人、正文、金额、卡号、地址、验证码、密码、参数或文件名。
- 点击回到来源 Interaction；通知内不能直接批准外发或付款。

## 8. 状态与环境

| 类别 | 加载/流式 | 空内容 | 出错 |
|---|---|---|---|
| Interaction | 快照完整前禁用控件 | 非法空请求不出卡 | 读取失败可“重新加载”；业务失败无重新执行 |
| Markdown/Page/Voice | 逐段或按产物状态展示 | 显示明确空态 | 显示内容错误，不伪造成功 |
| Table/Chart/Collection/Media | 骨架或逐步追加 | 显示无数据/无结果 | 保留可用替代内容；HTML 渲染失败不越出沙箱 |
| task_status | 显示 Run 投影 | 无子任务可显示空态 | 显示错误摘要，不以活动事件替代外部事实 |

- **窄屏**：390px 为主验收；375px 额外验证文档无横向溢出、按钮截断或遮挡。表格只在自身容器滚动。
- **深色**：文字、边界、焦点和状态对比可读；HTML 报告按主题适配或使用安全浅色容器。
- **键盘**：Tab 浏览控件；Enter/Space 只触发当前聚焦控件；没有全局 consequential 快捷键；Esc 关闭最上层并恢复焦点。
- **读屏**：卡片组名称含标题与状态；状态变化 polite 播报；图表有数据表；语音有转写。
- **动效**：遵循减少动态效果设置。

## 9. 已确认决策替换旧问题

| 主题 | 唯一口径 |
|---|---|
| 执行结果来源 | ExternalEffect 或业务事务；工具完成事件仅是活动 |
| 私聊完成后群回执 | 仅群来源请求回一条脱敏状态 |
| D2 table | 独立结构化展示成员；Markdown 仅简单静态表格 |
| 长消息阈值 | 渲染高度或行数，不用字符数 |
| 安装与授权 | 后端分开，UI 可组合 stepper |
| 移动通知 | 只做 Web Notification / 现有 Web Push |
| 分享 | 默认 Space 内且登录；公开需独立确认、expiry、撤销 |
| 过期提醒 | 依赖可信 expiresAt 与通知策略，无固定提前量 |
| 多次编辑 | 保留全部 revision；只有最新 pending 进入待处理 |

## 10. 兼容与交付边界

1. 先定义严格目标协议、服务端投影和旧消息适配，再实现 Shell 与各成员。
2. 旧消息只读兼容需有回放测试；不在页面散落协议分支。
3. 总 feature gate 下按协议/投影、核心 Interaction、展示与详情、queue/Web 通知、无障碍与回归分边界审查。
4. 所有部分通过后才开放；未实现 variant 明确失败或禁用。
5. 原型获产品负责人确认后，才可清理入库并拆生产实现任务。

## 11. 原型验收清单

- 27 个产品场景、7 个详情场景、4 类提醒均可从总索引到达并返回。
- A10 编辑、保存 revision、最新 pending、fingerprint 和最终确认内容一致。
- A13 是独立 `PlanReviewView`（`plan_review`），未归入工具审批；批准计划不批准任何工具调用、连接器或凭据。
- A12 与付款审批为两个连续场景；安装与授权独立。
- A8 使用 `requestApproval(skill_save)`，权威是 TaughtSkill 保存；`app_connect` 与 `mcp_approval` 分别使用 `connect.app_authorization` 和 `connect.mcp_assignment`，不共用 payload。
- queue 跳回来源并在处理后移除条目。
- 读取失败只重新加载；失败、过期与未知结果无重新执行。
- Run、Intervention、ExternalEffect 不合并；工具完成事件不冒充外部成功。
- 终态正文可读；每卡按钮与文字入口不超额。
- 390px 画面完整，375px 无文档横向溢出；深色、键盘焦点和非颜色状态表达可用。
- 生成源可重复产出 HTML 和截图；包内无密钥、真实用户数据、私有 URL 或本机绝对路径。
