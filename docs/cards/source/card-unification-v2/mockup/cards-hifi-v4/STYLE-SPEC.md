# WorkPal 卡片 STYLE-SPEC · CARD-01 v4 对齐版

页面：`index.html` / `cards.html` / `a-detail.html` / `b-alerts.html` / `c-states.html`。

本规范与 CARD-01 决策一致。协议名是目标示意，不代表现有生产 API。原型沿用 WorkPal 的聊天密度、头像、圆角、浅填充和胶囊控件，不新增品牌、导航或聊天布局。

## 1. 协议在视觉上的分类

```ts
type InteractionView =
	| InputRequestView        // requestInput(question | choice | form | secret | saved_item)
	| ActionApprovalView      // requestApproval(tool | payment | outbound | routine | install | skill_save | connect.app_authorization | connect.mcp_assignment)
	| PlanReviewView          // plan_review：计划版本审阅，独立成员
	| SessionControlView      // requestSessionControl(takeover | return)

type DisplayBlock = showContent(markdown | table | chart | collection | media | html | task_status | page | voice)
```

- 四个 Interaction 成员共用 Card Shell，但 payload、状态与权限严格分开。
- `PlanReviewView`（`plan_review`）视觉上复用“等待决定”外壳，但它是独立成员，不进入工具授权分支；批准计划版本不批准任何工具调用、连接器或凭据。
- 展示成员没有批准、付款、发送、删除或授权控件。
- B6 表情回应是消息操作，B7 消息跳转是 inline reference；B4 Page 与 B5 语音是展示类型。
- 当前兼容输入由适配层转换为上述目标投影，不在页面中猜字段组合。

## 2. 原型语义色值

| 原型变量 | 浅色值 | 语义用途 |
|---|---|---|
| `tx` | `#1c1c1c` | 主文字、主按钮背景 |
| `tx2` | `#1c1c1cad` | 次级正文 |
| `tx3` | `#1c1c1c8f` | 元信息、中性状态 |
| `tx4` | `#1c1c1c66` | 辅助装饰，不承载唯一关键信息 |
| `inv` | `#fcfcfc` | 主按钮文字 |
| `fill` | `#1c1c1c0f` | 卡片与浅填充 |
| `ln3 / ln4` | `#1c1c1c14 / #1c1c1c0f` | 分隔与内描边 |
| `accent` | `#1680f3` | 等待、焦点、当前可操作 |
| `ok` | `#00854a` | 已确认的业务成功或完成 |
| `err` | `#cd2834` | 失败、危险与阻断 |

深色使用可读变体：页面 `#1c1c1c`、浮层 `#262626`、文字 `#ececec`、蓝 `#4da3ff`、绿 `#63ce91`、红 `#ff858d`。状态不能只靠颜色。

**这些值不是生产 token，不得直接声称为 `@rakazo/ui-tokens` 色值。**

## 3. 到生产设计系统的语义映射

实现时以生产 token 与既有组件为准，下表只表示语义对应，不要求逐一复制 hex。

| 原型语义 | `@rakazo/ui-tokens` | `@rakazo/ui-web` | `@rakazo/chat-ui` / `apps/web/src/components/ai/` 使用位置 |
|---|---|---|---|
| 页面底 / 主文字 | `--background` / `--foreground` | `bg-background`、`text-foreground` | 聊天页面与 Execution Shell 容器 |
| 卡片底 / 卡片文字 | `--card` / `--card-foreground` | `bg-card`、`text-card-foreground` | Card Shell、`BuiCard` 与消息卡表面 |
| 次级填充 / 次级文字 | `--muted` / `--muted-foreground` | `bg-muted`、`text-muted-foreground` | 元信息、来源、空态与 Markdown 次级内容 |
| 主按钮 / 次按钮 | `--primary(-foreground)` / `--secondary(-foreground)` | Button primary / secondary variants | 本人决定按钮与普通操作 |
| 用户气泡 | `--chat-user(-foreground)` | `bg-chat-user` 等语义类 | 既有聊天气泡，不改布局 |
| 分隔 / 输入 / 焦点 | `--border` / `--input` / `--ring` | `border-border`、`bg-input`、`outline-ring` | 卡片分隔、表单、`:focus-visible` |
| 链接 / 等待强调 | `--link`；等待背景用既有 accent/secondary 组合 | `text-link` 或既有链接组件 | 来源链接、待处理入口，不新建品牌蓝 token |
| 成功 | `--success` | `text-success` / 既有成功样式 | 有业务事实的完成状态，配 ✓ 与文字 |
| 失败 / 危险 | `--destructive(-foreground)` | destructive Button 与文字样式 | 失败、删除，配 !/方形与文字 |
| 遮罩 / 浮层 | `--overlay`、`--popover(-foreground)` | Dialog/Popover 既有样式 | 模态、详情与 queue 浮层 |
| 圆角 | `--radius` 及派生 radius | `rounded-lg/xl/2xl` 等既有尺度 | Shell、输入、按钮；保留当前视觉语言 |

`@rakazo/chat-ui` 继续负责 Markdown、表格等展示；`apps/web/src/components/ai/` 承接 Intervention 来源、状态与执行上下文。attention queue 不复用或恢复 Task Center 的数据模型和路由。

## 4. 尺寸与排版

- 桌面卡宽使用当前布局可容纳宽度，原型内容卡最大 360px；窄屏卡宽 100%。
- 卡片圆角 16、内边距 12、内部间距 10；浅填充，不用厚重阴影。
- 标题 15/22、字重 500；正文 13/18；消息 14/20；元信息与徽标 12/16。
- 图标位 22×22、圆角 7；头像沿用现有资产。
- 徽标包含图标/形状和文字。等待为圆点，失败为方形/!，成功为 ✓，过期为空心环。
- 按钮桌面最小高 32；390/375px 下最小高 44。允许换行，不能截断或遮挡。
- 每张互动卡最多两个按钮和一个文字入口。关闭图标属于导航 chrome；详情内 consequential 动作仍需本人确认。

## 5. 三个状态所有者的呈现

| 所有者 | 可展示内容 | 禁止表达 |
|---|---|---|
| Intervention | 等你回答/决定、已回答、已拒绝、已过期、superseded | 不从 Run 结束推导全部作废 |
| Run | 运行中、完成、停止 | 不把 Run 状态当外部动作结果 |
| ExternalEffect / 业务事务 | 执行中、成功、失败、结果未知 | 不以 `agent.tool.completed` 单独证明外部成功 |

组合示例：Run stopped + Effect uncertain 显示“运行已停止，发送结果未确认”。不要显示“已作废”，不要提供重新执行。

计划审阅的 pending 状态由 Intervention 的 `plan_review` kind 投影。批准计划只结束该计划版本的审阅，不改变任何工具授权、连接器或 ExternalEffect；后续工具与连接器必须各自出现审批。

同一 interaction region 的组顺序固定为 `PlanReviewView → ActionApprovalView → InputRequestView`；同组按 `createdAt ASC → stableId ASC`。计划审阅先于工具审批是因为它约束整个 Run 的后续执行。`SessionControlView` 保持专用入口，不混入该排序。

失败、过期、拒绝、完成和未知结果的正文保持正常可读。禁止 `.rej .body`、`.void .body`、`.exp .body`、`.done .body` 等整块 40% opacity 表达。

## 6. 关键场景

### A7 连接授权

- 同一场景展示两张真实卡：`app_connect → connect.app_authorization`；`mcp_approval → connect.mcp_assignment`。视觉可复用 Shell，但 payload、业务范围和审计不同。
- MCP assignment 的标题、风险说明和主操作都写明“全部工具”；正文必须出现 `allowAllTools: true`。不得只写“授权连接”。
- OAuth 窗口关闭但未完成时保持 pending；与安装、技能保存分开。

### A8 技能保存

- 使用 `requestApproval(skill_save)`，不得写成工具审批。
- 保存的权威是 TaughtSkill 业务事务；不是一次工具执行，也不产生工具授权。
- 保存绑定当前内容快照；播放/查看 playbook 不改变消息。

### A9 / B1 接管与交还

- `SessionControlView` 只从 Run、执行租约和 Computer 控制租约派生，不新增持久 Intervention。
- `takeover` 来自 `waiting_takeover`；`return` 要求 `Computer.controlRunId === run.id` 且用户控制租约仍有效。
- 历史 `computer` block 只能展示，不能充当权限或当前状态来源。

### A10 外发草稿

- 对话卡显示摘要、最新 revision 和来源；同卡/同详情进入编辑。
- 保存形成不可变 revision；旧 revision 显示 superseded 并保留审计，待处理只显示最新 pending。
- 最终确认页显示收件人、主题、完整正文、revision 和 fingerprint。
- 发送只记录决定；结果区域等待 ExternalEffect 或业务事务，不提前显示送达。
- 关闭、遮罩和 Esc 不等于拒绝或取消；未保存关闭需单独询问。

### A12 与付款

- saved_item 卡只选择脱敏卡/地址，主文案不得暗示付款。
- 选择完成后出现独立 payment approval，显示金额、商户和卡末四位。
- 两个 Intervention 连续但独立；付款结果来自 ExternalEffect 或支付事务。

### A13 计划审阅

- 独立 `PlanReviewView`（`plan_review`），不是工具审批卡；标题与正文不出现工具审批入口。
- 只显示最新 pending plan revision；旧 revision 标记 superseded 并保留审计。
- 主按钮“批准计划”只结束该计划版本的审阅；批准计划版本不批准任何工具调用、连接器或凭据。
- 后续工具、连接器与付款仍按各自 `ActionApprovalView` 出现，不能复用本次计划批准。

### B3 安装与授权

- stepper 可分为“安装”“授权”，每步有独立状态、失败和审计。
- 安装完成后才进入授权；安装失败时授权未开始；授权失败时安装仍保持已完成。
- 不把两个后端动作合成一个“安装并授权”请求。

### N1 Attention queue

- 轻量列表，只含当前 actor 有权访问线程中仍需本人处理的 Interaction 投影：持久 Intervention、当前有效 `SessionControlView` 和严格映射后的 pending 业务审批。
- 不显示运行历史、完成历史、普通后台工作、旧 `connect` 回放或执行详情。
- 排序为 `expiresAt ASC NULLS LAST → attentionAt ASC → stableId ASC`；按 `interactionId + revision` 去重并分页。
- 点击只跳回来源；处理后立即消失。

### D2 / D6 / V2

- table 使用结构化 columns/rows；Markdown 表格仅简单静态内容。
- HTML 仅复杂只读报告，画面明确：无同源、无网络、无表单提交、无父页面访问、无顶层跳转。
- HTML 内无副作用控件。
- 分享默认 Space 内且登录；公开分享单独显示 expiry 和撤销能力。

## 7. 详情与层级

- 对话 0 → 并排详情 0 → queue 浮层 1 → 模态遮罩 2 → 模态 3 → tooltip/焦点 4。
- 同一时刻只开一个业务模态；未保存确认可位于其上。
- Esc 关闭最上层并恢复焦点；关闭不等于拒绝或取消。
- 宽屏右侧面板或模态；窄屏使用可用全宽，不造成文档横向溢出。
- 灯箱只展示媒体；工具审批详情的决定仍要求本人明确确认。

## 8. 提醒与通知

- N2 成员标记只对应等待中的 Bot；N3 未读、@我和待处理用文字/形状区分。
- N4 只画 Web Notification 或仓库已有 Web Push，不画原生手机锁屏。
- 通知不含敏感内容，不直接批准。
- 只有可信 expiresAt 存在时，提醒策略才可引用过期时间；不固定提前量。

## 9. 响应式、深色与无障碍

- 390px 是主视觉验收 viewport；375px 运行 `document.documentElement.scrollWidth <= 375` 回归。
- 表格在自身容器横向滚动；其他内容不得撑宽文档。
- 页面提供实际深色切换；检查正文、边框、焦点、徽标和暗色对比。
- Tab 按 DOM 顺序；原生 dialog 约束焦点；Enter/Space 只触发当前聚焦控件。
- 没有全局 Enter、Cmd/Ctrl+Enter 发送或批准快捷键。
- 状态变化使用 `aria-live="polite"`；图表有数据表；语音有转写。
- 遵循 `prefers-reduced-motion`。

## 10. 生成与截图

在 `mockup/cards-hifi-v4/` 内：

```bash
python3 gen.py
python3 shot.py
```

- `gen.py` 从 Python 组件和 `style.css` 生成五个页面及根目录统一说明 HTML。
- `shot.py` 使用 Chromium/Chrome 生成 `shot-index.png`、四组验收图、根目录方案图、四组旧/新同 viewport 并排图和 overview。
- `verify.py` 用真实浏览器检查七条核心路径、A13 独立计划审阅语义、390/375px、深色、键盘、按钮数量和横向溢出，并静态检查文档层的计划审阅兼容映射。最终计数由脚本动态输出，不在文档中写死。
- 旧截图只保存在 `old/`，对比图以 `compare-*.png` 命名并明确旧/新。
