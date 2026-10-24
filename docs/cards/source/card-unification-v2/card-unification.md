# WorkPal 卡片统一说明 · CARD-01 对齐版

状态：产品原型对齐版，2026-10-24。本文描述目标协议与兼容方向，不声称目标类型已经作为生产 API 存在，也不解除生产实现阻塞。

## 1. 结论

统一 Card Shell、身份、来源、安全展示与交互约束；保留严格区分的业务成员。Web 只消费服务端投影，不从可选字段组合、工具日志或文本内容猜类型、权限和状态。

**CARD-01 目标结构（示意类型名，非现有生产 API 声明）：**

```ts
type InteractionView =
	| InputRequestView        // requestInput(question | choice | form | secret | saved_item)
	| ActionApprovalView      // requestApproval(tool | payment | outbound | routine | install | connect)
	| PlanReviewView          // plan_review：计划版本审阅，独立成员
	| SessionControlView      // requestSessionControl(takeover | return)

type DisplayBlock = showContent(markdown | table | chart | collection | media | html | task_status | page | voice)
```

- `InteractionView` 是 `InputRequestView | ActionApprovalView | PlanReviewView | SessionControlView` 的目标概念；每个成员拥有自己的严格 payload。
- `PlanReviewView`（`plan_review`）是独立成员，不与 `ActionApprovalView` 合并、不经过工具授权链；批准一个计划版本不批准任何工具调用、连接器或凭据。
- `DisplayBlock` 对应展示成员。表情回应是消息操作，消息内跳转是 inline reference；语音与 Page 是展示类型。
- 新增成员时，目标实现应由类型与 schema 的穷尽检查指出投影和渲染缺口。未实现成员必须明确失败或禁用。

## 2. 当前兼容输入与目标投影

下表来自原型输入中的旧代码快照，只用于说明兼容适配方向，不作为当前生产代码事实。旧消息适配应集中在服务端投影或前端 API 适配层。

| 当前兼容输入 | 目标投影方向 |
|---|---|
| `ask` 的文本、密钥、登录变体 | `requestInput(question | secret)`；登录使用严格 secret payload |
| `ask` 的审批、建空间变体 | `requestApproval(tool)`，以严格业务 payload 区分 |
| `ask` 的计划审阅变体 | 独立 `PlanReviewView`（`plan_review`）；只决定计划版本，批准计划不批准任何工具调用、连接器或凭据 |
| `choice` | `requestInput(choice)` |
| `app_connect`、`mcp_approval`、旧 `connect` | `requestApproval(connect)`；旧块只读回放 |
| `skill_draft` | `requestApproval(tool)` 的技能保存 payload |
| `computer` 接管与交还 | `requestSessionControl(takeover | return)` |
| `text` | `showContent(markdown)` |
| `card`、结果列表 | `showContent(collection)` |
| `chart` | `showContent(chart)` |
| `image`、`file` | `showContent(media)` |
| `subagent`、`cloud_agent`、`child_bot` | `showContent(task_status)` |
| `progress`、`steps`、`meta`、群中继与通话记录 | 保持系统专用，不开放给模型自由组合 |
| reaction、消息引用 | 消息操作 / inline reference，不转为卡片 |

兼容层不能把旧输入重新包装成一个充满可选字段的万能业务对象，也不能让页面各自猜协议分支。

## 3. 三个状态所有者

| 所有者 | 回答的问题 | UI 使用方式 |
|---|---|---|
| Intervention | 用户是否仍需回答或决定 | pending、answered、declined、expired、superseded 等按自身生命周期投影 |
| Run | 这一轮 Bot 是否仍在执行 | 运行详情和活动展示；不代替请求或外部事实 |
| ExternalEffect / 业务事务 | 外部动作是否执行、结果是否确定 | 付款、发信、安装、连接与 Routine 的结果权威 |

规则：

1. 三者可以合成一句用户文案，但不能合并为一条持久状态机。
2. Run 完成、失败或停止不自动作废所有 Interaction。仍有效的请求必须保留来源、权限与 expiry。
3. Run 已停止且 ExternalEffect 为 executing 或 uncertain 时，显示“运行已停止，发送结果未确认”或等价文案；不显示“已作废”，不提供重新执行。
4. 输入和选择以 Intervention 的事务性 resolution 为准。
5. `agent.tool.completed` 只表示执行活动，不能单独证明付款、发信、安装、连接或 Routine 已完成。
6. CARD-01 只呈现外部结果，不替代执行权、幂等、权限和审计的数据库边界。

## 4. 27 个产品场景的唯一归类

| 场景 | 目标归类 | 关键边界 |
|---|---|---|
| A1 工具审批 | `requestApproval(tool)` | 显示 Bot、Task、Run/Step；详情决定仍需本人确认 |
| A2 密钥输入 | `requestInput(secret)` | 私聊收集，明文不进入消息、事件或日志 |
| A3 登录 | `requestInput(secret)` | 严格登录 payload；只回显允许公开的信息 |
| A4 提问 | `requestInput(question)` | 群聊绑定 Bot 与 Task 或 reply target |
| A5 选择 | `requestInput(choice)` | 不依赖孤立的“A”或“可以” |
| A6 建空间 | `requestApproval(tool)` | 创建结果以业务事务为准 |
| A7 授权 | `requestApproval(connect)` | 与安装分离；OAuth 未完成不等于授权失败 |
| A8 保存技能 | `requestApproval(tool)` | 保存绑定内容快照 |
| A9 接管电脑 | `requestSessionControl(takeover)` | 主入口“打开桌面” |
| A10 外发草稿 | `requestApproval(outbound)` | 同卡编辑、不可变 revision、发送绑定 fingerprint |
| A11 表单 | `requestInput(form)` | 敏感支付与密钥不混入普通表单 |
| A12 已保存卡/地址 | `requestInput(saved_item)` | 只选择，不付款；随后独立 `requestApproval(payment)` |
| A13 计划审阅 | 独立 `PlanReviewView`（`plan_review`） | 只有最新 pending revision 可审阅；批准计划版本不批准任何工具调用、连接器或凭据 |
| D1 Markdown | `showContent(markdown)` | 简单静态内容；按渲染高度或行数折叠 |
| D2 结构化表格 | `showContent(table)` | columns/rows、排序、分页；不是 Markdown 表格增强 |
| D3 图表 | `showContent(chart)` | 提供数据表替代 |
| D4 键值/集合 | `showContent(collection)` | 条目只读；执行动作另发审批 |
| D5 媒体 | `showContent(media)` | 图片预览与文件下载/预览 |
| D6 HTML | `showContent(html)` | 仅复杂只读报告，使用沙箱 |
| D7 任务状态 | `showContent(task_status)` | 普通后台工作不进入 attention queue |
| B1 交还桌面 | `requestSessionControl(return)` | 与接管对应，不批准后续动作 |
| B2 Routine 变更 | `requestApproval(routine)` | 结果以 Routine 业务事务为准 |
| B3 安装插件/连接器 | `requestApproval(install)`，需要时接 `connect` | 两个后端动作、独立状态与审计 |
| B4 Page 入口 | `showContent(page)` | 按 Page 权限打开 |
| B5 语音消息 | `showContent(voice)` | 播放、时长与转写 |
| B6 表情回应 | 消息操作 | 聚合计数，不是卡片 |
| B7 消息内跳转 | inline reference | 校验目标可见性，不携带权限 |

## 5. 已确认产品规则

1. **来源**：问题与选择显示可寻址来源；群聊回复绑定 Bot 和 Task 或明确 reply target。
2. **付款两步**：A12 resolution 后另出付款审批；未经本人确认不得扣款。
3. **A10 revision**：同卡编辑，每次保存形成不可变 revision。旧 revision 显示 superseded 并保留审计；待处理入口只显示最新 pending revision。发送决定绑定内容 fingerprint。
4. **安装与授权**：可在一个 stepper 中呈现，但每一步有独立状态、失败和审计含义。
5. **按钮**：每张互动卡最多两个按钮和一个文字入口。详情中的 consequential 动作仍需本人确认。
6. **终态**：失败、过期和结果未知不提供重新执行。只有读取服务端状态失败可显示“重新加载”，且它只刷新展示状态。
7. **可读性**：终态正文不整块淡化；状态由文字、图标或形状与颜色共同表达。
8. **N1**：attention queue 只列当前用户必须处理的 pending Interaction；处理后立即消失，点击只返回来源。无运行历史、完成历史或普通后台工作。
9. **群回执**：仅当请求来自群聊时，私聊完成后回一条脱敏状态；不带密钥、地址、付款内容或外发正文。
10. **分享**：默认要求登录并限制在 Space 内。公开分享单独确认，明确 expiry 和撤销能力。
11. **提醒**：只有可信 `expiresAt` 存在时，通知策略才可引用过期时间，不承诺固定提前量。
12. **通知**：只使用 Web Notification 或仓库已有 Web Push，不增加原生移动应用。
13. **窄屏**：390px 主画面，375px 额外验证无文档横向溢出、按钮截断或遮挡。
14. **计划审阅**：`plan_review` 是独立 `PlanReviewView`，只决定计划版本；批准计划版本不批准任何工具调用、连接器或凭据。后续工具、连接器与付款各自审批。

## 6. HTML、表格与长文边界

- HTML 只用于复杂只读报告，复用目标实现中的现有沙箱边界：默认无同源、无网络、无表单提交、无父页面访问、无顶层跳转。
- HTML 内不得出现批准、付款、发送、删除或授权控件；副作用必须创建独立 Approval。
- `table` 是结构化展示成员，支持列定义、行数据、排序与分页。Markdown 表格仅用于简单静态内容。
- 长文以渲染高度或行数折叠，不以字符数推导 UI 高度。

## 7. 原型范围与验收入口

- `mockup/cards-hifi-v4/cards.html`：27 个产品场景，含可操作的 A12 与 B3。
- `mockup/cards-hifi-v4/a-detail.html`：V1–V7，含可操作的 A10、报告面板、灯箱与审批详情。
- `mockup/cards-hifi-v4/b-alerts.html`：N1–N4，含可操作的 attention queue。
- `mockup/cards-hifi-v4/c-states.html`：状态所有者、加载/读取失败、390px、深色、键盘与终态。
- 原型状态切换是本地确定性演示，不代表真实网络或外部系统已成功执行。
