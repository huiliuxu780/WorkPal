# WorkPal UI 重设计功能底账（UI Redesign Inventory）

> 目的：作为 UI 重设计期间的**完备性底账**。新 UI 每迁移一个区域，就在对应条目打勾；
> 五个完备性来源（路由表 / 全局挂载点 / 渲染契约 / RPC 面 / e2e 回归网）交叉核对，保证"不漏"。
> 状态标注：☐ 待迁移 · ◐ 进行中 · ☑ 已迁移并跑绿 e2e。
> 生成于 2026-10-06，基于 commit 670d737 + 未提交的品牌化改动。产品名待定（brand.json 现为 "MyPal"，仓库/远程为 "WorkPal"）。

---

## 0. 防漏机制（迁移时必须遵守）

1. **渲染契约全覆盖**：`MessageBlock` 23 种、`ProductEvent` 45 种、`AgentRuntimeEvent` 9 种（见 §7）。新 UI 不允许出现"未知类型不渲染"的静默丢弃——每种都要有渲染方案或明确的降级占位。
2. **RPC 面核对**：`AppContract` 35 个过程组（见 §8）。每个过程要么有新 UI 入口，要么在底账标注"暂无 UI，属后端能力"。
3. **data-testid 原样保留**：e2e（§10）依赖现有 testid（如 `bots-sidebar`、`side-panel`、`create-bot-form`、`mcp-approval-card`…）。重设计只换视觉，不换 testid，则 73 个 e2e spec 就是免费的回归网；必须改动时同步改 spec。
4. **状态矩阵**：每个页面/面板至少核对 loading、empty、error、busy(pending)、disabled 五态；聊天区额外有 streaming、awaiting-approval、offline-reconnect。
5. **i18n**：全部用户可见文案走 Lingui catalog（10 语言 × 922 条，`apps/web/src/locales/`）。新组件不允许硬编码英文。
6. **数据层不动**：`lib/rpc.ts`、`lib/thread-events.ts`（事件折叠）、`@rakazo/core` reducers、`lib/auth.ts`、`lib/call-session.ts` 等 keep as-is；只换渲染层。

---

## 1. 路由表（`apps/web/src/App.tsx`）

预路由拦截：`/desktop-settings` → `LocalSettingsPage`（绕过 router 直渲染）。
鉴权门：`SessionApp`（Better Auth `useSession`）→ loading 态 `ShellSkeleton`；不可达态 `SessionUnavailable`（"Reconnecting…" + 指数重试）。
**已知缺口**：无 catch-all 404 路由——未知路径渲染空白 `div[data-rakazo-app-state="ready"]`。

| 路径 | 组件 | 加载 | 守卫 | 独立于 Shell |
|---|---|---|---|---|
| `/` | WelcomePage | lazy | 登录后 → `/app` | ✅ |
| `/sign-in` | AuthPage(mode=in) | lazy | 登录后 → next 或 `/app` | ✅ |
| `/sign-up` | AuthPage(mode=up) | lazy | 登录后 → `/onboarding` | ✅ |
| `/forgot-password` | AuthPage(mode=forgot) | lazy | 登录后 → `/app` | ✅ |
| `/reset-password` | PasswordResetPage | lazy | 无 | ✅ |
| `/onboarding` | OnboardingPage | lazy | 匿名 → `/sign-in` | ✅ |
| `/mcp/oauth/callback` | McpOAuthCallbackPage | eager | 匿名 → `/sign-in` | ✅ |
| `/integrations/setup` | IntegrationSetupPage | eager | 匿名 → `/sign-in?next=…`；无权限→`/app`；无 bot→`/onboarding` | ✅ |
| `/app`、`/app/:botId`、`/app/g/:groupId` | ShellPage | eager | 匿名 → `/sign-in` | — |
| `/app/artifacts[/:artifactId]` | ArtifactsPage | lazy | 匿名 → `/sign-in` | ✅（自有 header） |

☐ 全部路由在新 UI 有对应页面；☐ 新增 404 页。

## 2. 全屏流程核对清单（12 项）

☐ 1. Welcome 落地页 → Sign up
☐ 2. Auth 三态（in/up/forgot）+ 邮箱验证"Check your email"态
☐ 3. 密码重置（`/reset-password?token=…`，含失效/过期预错误态）
☐ 4. Onboarding 向导：模型 → 集成 → 首个 Bot（含 OAuth device-code/paste-code、OpenAI-compatible 探测子流程）
☐ 5. MCP OAuth 回调（popup 与 tab 两种形态）
☐ 6. 集成设置页（`/integrations/setup`，`?mode=mcp`）
☐ 7. 桌面本地设置页（`/desktop-settings`，pre-router）
☐ 8. Artifacts 浏览/预览（全窗口、自有 header）
☐ 9. 首次运行 HostComputerPrompt（强制选择 Docker vs 本机，不可关闭）
☐ 10. Teach 录制全屏 overlay（shell 内）
☐ 11. 语音通话流程（CallCard 条 + VoiceChatCard + 语音设置往返）
☐ 12. 全局态：SessionUnavailable 重连、ShellSkeleton 骨架

## 3. 独立页面明细

### 3.1 Auth（`pages/Auth.tsx`）
- 结构：居中 AuthFrame（logo + `aria-live` 标题）+ 460px 表单列。
- 字段：Name（仅注册）、Email、Password（显隐眼睛）、"Forgot password?"（能力位控制）、提交按钮三态文案、注册↔登录互链、"Check your email"已发送态。
- 状态：pending("Working…")、inline `role="alert"` 错误、能力探测（8s 超时静默失败）。
- API：`/api/auth/capabilities`；`authClient.signUp.email/signIn.email/requestPasswordReset/resetPassword`；成功后 `clearSpaceSelection()`。
- PasswordResetPage：新密码+确认；token 无效/过期预错误；成功态。

### 3.2 Welcome（`pages/Welcome.tsx`）
拖拽区 header + WindowChrome；居中品牌 logo+名+slogan；"Sign up →"按钮。无数据调用。

### 3.3 Onboarding（`pages/Onboarding.tsx`）
- 三步：loading → model 表单 → integrations（内嵌 IntegrationSetup）→ bot（"Opening chat…"/错误重试）。
- model 步：Provider Select；OpenAI-compatible 分支（Server URL、"Find models"探测、模型 Select/手输 id、ModelThinkingOptions 高级折叠：thinking 开关/effort 档/max tokens/上下文上限/图片支持/max images、可选 API key 折叠）；托管 provider 分支（Model Select + API key）；OAuth 订阅登录面板（device-code 展示/粘贴码提交/"Waiting for sign-in…"）；Continue。
- API：`rpc.me/models.*/integrationSetup.get/onboarding.start|promptFocus/bots.create`（首个 bot "Chief"，`spawnKey:"onboarding:first"`，Web Lock 去重）。

### 3.4 McpOAuthCallback（`pages/McpOAuthCallback.tsx`）
单行状态（Finishing/Connected/Failed+错误文本）；仅错误+tab 模式显示"Return to {brand}"；BroadcastChannel 通知；成功 → `/app?mcp_oauth=connected`。

### 3.5 IntegrationSetup 页（`pages/IntegrationSetup.tsx`）
bot NativeSelect（>1 时）+ 共享 IntegrationSetup 组件（见 §5.7）。

### 3.6 LocalSettings（`pages/LocalSettings.tsx`）
标题 + 两按钮：Models（内嵌 ModelSettingsOverlay `localOwner`）、Server integrations（`serverSetup managedOnly`）。

### 3.7 Artifacts（`pages/Artifacts.tsx`）
- Header：返回链接、标题、Filters 开关、grid/list 视图切换、WindowChrome（桌面）。
- 筛选条：搜索、日期 NativeSelect、"All bots" chip + 按 bot 彩色 chip。
- 主体：BrowsingPane（卡片网格/列表行 + hover 删除）或 IndexPane(320px 列表)+PreviewPane；删除 AlertDialog。
- PreviewPane：版本 NativeSelect、Download、Maximize/回列表；渲染器：SandboxedHtmlViewer（"Isolated preview" 锁徽标）、ChatMarkdown、PdfViewer、图片 object URL、类型兜底文案。
- 状态：loading/load error/empty/Load more 分页/删除 busy+error；localStorage 视图偏好。

## 4. Shell 主界面（`pages/Shell.tsx`，6600 行——重设计最大风险点，建议借迁移拆分）

### 4.1 布局区域
- 移动端：侧滑边缘 + scrim（`mobile-sidebar-swipe`）。
- 顶部横幅：ComputerUpdateProgress（§5.13）、HostComputerPrompt（§2.9）。
- **左侧栏** `data-testid="bots-sidebar"`：WindowChrome、Activity 铃铛切换、折叠按钮、"+"创建 Popover（→BotCreatePicker）、搜索（实时 SpaceSearchResults）、ActivityList（Now/Recent runs，15s 轮询，状态色点）、bot/group 分区（拖拽排序、归档区 Restore/Delete、右键菜单 BotContextMenu、分区折叠）、"Integrations"按钮（→PluginsOverlay）、用户菜单 Popover（Artifacts/Settings/Usage/Log out）。
- **主区**：header（窗口 chrome/hamburger/bot·group 标题按钮→面板设置/Monitor 按钮→computer 面板）；Transcript（历史分页、MessageView + hover 操作、ToolActivityDisclosure、MessageHoverMetadata、QuoteSelectionButton portal、消息卡族见 §5.5、§7 渲染契约）；Composer（拖拽附件、reply/quote、@mentions 含 routines/connectors/skills、/ 斜杠命令、听写、发送错误横幅）。
- **右侧栏** `data-testid="side-panel"` 按 Panel 切换：computer（ComputerWorkspace + 启动遮罩"Booting up X's computer"进度条 + ComputerMaintenanceActions）、settings（BotSettings）、routine（RoutineEditor）、create（CreateBotForm）、create-group/create-group-settings（GroupPanel）。
- 常驻 CallCard 通话条（§5.6）。
- URL 参数：`?m=<messageId>` 深链跳转、`?routine=<id>` 自动打开编辑器、`?mcp_oauth=connected`。

### 4.2 全局挂载（Shell.tsx / App 级）
- CommandPalette（⌘/Ctrl+K，§5.3）；SettingsOverlay（§6.1）；PluginsOverlay（§6.7）；McpServersOverlay（§6.6）；MessagingSettingsOverlay（§6.5）；PeerMessagesOverlay（只读 bot↔bot 记录：Loading/错误重试/空态/气泡+footer"view-only"）；BotContextMenu（Pin/Unpin、Move to 分区、Mark read/unread、Edit Profile、Duplicate、Clear conversation、Archive、Delete）；HostComputerPrompt；7 个确认/信息对话框（§5.4）；空间/分区上下文菜单；Booting 遮罩；Teach overlays（§5.5）；CallCard；QuoteSelectionButton（选中文本浮动引用按钮）。
- App 级：DesktopUpdatesProvider（2s 轮询 + 右下更新 toast）、ComputerUpdateProgress 栈、SessionUnavailable、ShellSkeleton。
- **已知缺口（重设计机会）**：无 toaster 系统（现用 inline 文案/SuccessPop）、无顶层 ErrorBoundary、无 404 页、无分析/特性开关系统。

## 5. Shell 内功能组件明细

### 5.1 Bot 面板（`pages/shell/bot-panel.tsx`）
- **CreateBotForm**：Name（限长）/Title/Description(4 行) + ComputerModePicker（Team/Private 双列 Toggle，默认 team）+ Create/Creating… + 错误行。
- **BotSettings**：76px AvatarStudio 入口（选色即存）；Name/Title/Description **失焦自动保存**（保存队列防竞态）；Notifications Switch；Advanced 折叠（一次性打开标记）内含：ComputerModePicker、懒加载 ScratchpadSection + KnowledgeSection、Model NativeSelect（Space default/孤立选项/connected 组合目录）、Thinking NativeSelect（档位由模型元数据决定，加载失败不清空已存值）、Memory scope 三选（Inherit/Isolated/Shared）、Read replies aloud Switch + Voice NativeSelect；页脚 Save/Export/Clear conversation。

### 5.2 嵌入小节
- **ScratchpadSection**（"Open work"清单）：Checkbox 完成（完成的移除）、Park/Reopen、删除 ×、底部添加表单（限长 200）；空态"None yet"；部分失败提示（"Saved, but list refresh failed"）。
- **KnowledgeSection**：Tabs Memory / Skills。Memory = MemoryDocumentList（path+rev 行、展开 Textarea 编辑 Save/Cancel、"Download as markdown"导出；空态"Nothing remembered yet"；复用于 space 级"Shared documents"）。Skills = AgentSkills（列表+只读徽标、SKILL.md Textarea 编辑、"New skill"模板、Delete 两击确认；空态"No skills yet"）。

### 5.3 BotCreatePicker / CommandPalette
- **BotCreatePicker**（320px Popover）："To:" 搜索；"Create new Bot"；匹配 bot 行（头像+名）；分隔线；Create new Group / Create new Space（各带 ⓘ 信息按钮，opens PickerInfoDialog）。
- **CommandPalette**（CommandDialog "Switch bot"）：搜索输入；bot 行（32px 头像+名+title Badge+副标题）；⌘1–9 快捷键直达；空态"No bots"。

### 5.4 对话框族（`pages/shell/dialogs.tsx`，busy 时禁 Escape/点外关闭）
NewSpaceDialog（名称限长 60）/PickerInfoDialog（group vs space 解释）/NewBotSectionDialog/RenameBotSectionDialog/ClearConversationDialog（AlertDialog 永久清除警告）/DeleteBotDialog（**memory 单选**：保留→移入共享记忆 vs 连记忆删除）/DeleteItemDialog（group|routine|space 通用破坏性确认）。

### 5.5 消息卡与交互
- **ChoiceCard**（onboarding 焦点卡 420px）：问题+副标题；X 跳过（`onboarding.dismissFocus`）；选项字母徽标、答后禁用+✓、仅留已选项。
- **AppConnectCard**（420px）：logo/首字母块+名+描述；Authorize → OAuth popup(560×720) → 2s×60 轮询 complete → SuccessPop"Connected"；超时/错误/abort 态。
- **ChartBlockView**：懒加载 `@rakazo/core/plot`；标题+系列图例+SVG；hover Expand → 全屏 Dialog（1320px/94vw）；渲染失败态。
- **McpApprovalCard**：pending/connecting（Authorize|Approve + Not now）、connected（SuccessPop）、dismissed（"Reconnect anytime from MCP settings"）三态；服务端重置会重绘回 pending。
- **ArtifactImage**：IntersectionObserver 懒加载、缩略图→全屏预览 Dialog、加载中/失败占位。
- **AskCard**（`components/AskCard.tsx`，max-w 74%）：markdown+detail mono（secret 隐藏）；三类变体——action ask（含审批按钮组 Allow once/Always allow this tool/Deny 及"Created/Cancelled"结果覆盖）、secret ask（Password/API key/Code 输入 + login 时 Username，提交清空）、plain text ask（"Send it"快批 + "Edit first"表单）；answered/expired/busy/error 态。
- **CloudAgentCard**（320px）：任务标题+状态 Badge（running/finished/cancelled/failed 配色）+ PR/分支副标题；整卡外链。
- **ArtifactFileCard**：不可预览=下载 chip（含失败重试文案）；可预览（md/html/pdf）=行卡→预览 Dialog（960×88vh：SandboxedHtmlViewer/PdfViewer/ChatMarkdown + Download 条 + Loading/Error 态）。
- **ToolActivityDisclosure**（`components/ToolActivityDisclosure.tsx`）：ToolSteps（✓/◷ 行、"+N earlier steps"）、`<details>` 活跃期常开→结束后折叠"Done · N tools · duration"、StandaloneToolActivity（消息间弱化行，活跃窗口 6 条）、ToolOnlyNarration（纯步骤消息渲染为细行无气泡）。
- **MessageHoverMetadata / MessageHoverActions**（Actions 在 Shell.tsx ~5916）：hover 侧轨（触摸变静态下方全宽）；操作=React（emoji popover，MESSAGE_REACTIONS）、Reply、More(→Copy)；streaming 气泡跳过；popover 打开时 pinned。
- **CollaborationMarker / ActiveBotGlyph**：peer 事件 chip、"bots are working" 行。
- **AvatarStudioPopover**：Dialog（Bot/Upload tabs + Reset + Done）；Bot tab=8 形状×6 色网格；Upload tab=拖拽/选文件/粘贴 → canvas 256×256 中心裁圆 → webp 0.9 dataURL。

### 5.6 Computer 工作区（`components/computer/`）
- **ComputerWorkspace**：桌面=实时屏幕+可拖浮窗+底部 dock（Browser/Terminal/Files，Browser 仅非 desktop-host，aria-pressed "收起"保会话）；浮窗 560×min(420,70%)、拖拽钳制、点按置顶、关闭后保持挂载；teaching 录制时隐藏 dock。
- **FilesApp**：浏览（3s 自动刷新+事件触发 diff 刷新、防陈旧）、进目录/图片预览/文本读取、任意文件 Download、多文件 Upload（限 ATTACHMENT_MAX_BYTES、Ctrl+拖放）、预览（text `<pre>`/图片）；**无重命名/删除/建目录**。工具栏 Back/面包屑/Upload/Download。
- **TerminalApp**（懒载 xterm）：Tabs Activity/Shell；ActivityTerminal 只读回放 bot 操作流（3s 轮询+live 合并、humanized 动作标签、"No bot activity yet."、ESC c 清屏）；ShellTerminal 二进制 WebSocket 交互（断线重连≤3 次、`[closed]` 提示）；"Open shell"按钮请求控制权。
- **ComputerMaintenanceActions**：More 菜单——Recover/Reset（AlertDialog"恢复上次保存的工作区，未保存工作丢失"）/Update，按状态显隐，busy 禁用。

### 5.7 Teach 教学（`components/teach/`）
流程：TeachComputerOverlayControl（目标 Textarea+"Start recording"→boot+`skills.start`；含刷新恢复 popover"Recording started. Refresh the view…"）→ TeachCaptureOverlay（透明覆盖层转发指针/滚轮/键盘，逐 bot 串行队列保序）→ TeachRecordingChrome（"Recording: {goal}"、倒计时、"bot is watching, not acting"、"Use Protected input for passwords."、Stop teaching）+ ProtectedTeachInput（密码打字不录制，sensitive clipboard 注入）→ SkillDraftCard（Name/When to use/Inputs/Steps/How to check/What to return/Approval boundaries/Failure handling 编辑；Save/Test/Add to routine）。

### 5.8 通话（`components/call/`）
- **CallCard**：固定右上 360px 通话条；头像+名（点击跳 bot）、动效声浪（thinking/speaking 两相）；Settings/Transcript/Mute/Hang up；Esc 挂断；Transcript 区=最近 4 轮+实时字幕。
- **VoiceChatCard**：群语音折叠卡（图标+"Voice chat"+时长+chevron+单行摘要）；展开逐轮气泡；sr-only 锚点支持跳转；`revealMessageId` 强制展开。

### 5.9 IntegrationSetup 组件（`components/integrations/IntegrationSetup.tsx`）
两种模式（server setup / inline "Add MCP server"）+ `managedOnly`（隐藏 Direct MCP/Executor）。Provider 单选行：**Direct MCP**（"Search apps"→catalog 搜索→远程 MCP Connect→可选拨配；"Add server URL"折叠）、**Composio**（API key+"Get credentials"链接；无权限提示"Ask the server owner…"）、**Pipedream**（Client ID+Project ID+Secret+文档链接）、**Executor**（Server URL+token+"Download Executor" 帮助）。Onboarding 页脚 Continue/Skip。busy"Connecting…"/错误/`connected[]`。

### 5.10 系统进度与更新
- **ComputerUpdateProgress**：顶部居中进度 pill 栈（Updating/Recovering…+阶段副标题：Getting ready/Saving workspace/Recreating/Restoring/Reconnecting）；点击开进度 Dialog（阶段 checklist、失败/中断警示、Release computer/Recover/Continue in Background 按钮）。
- **DesktopUpdates**：桌面更新——右下 toast（Restart to update/Later）+ 设置区版本行（Check/Downloading%/Restart 循环按钮+状态行）。

### 5.11 ApprovalRulesSettings（"Action confirmations"）
两个预设按钮（"Ask before sending external email"/"Ask before purchases"，幂等建规则）；Auto Review Switch（checker 不可用时提示"Add a model in Settings to use this."）；已存规则列表（humanized 文案+Remove）；loading/error。

## 6. 设置体系

### 6.1 SettingsOverlay 壳（模态 ≤920px，models/voice 1080px）
左侧图标导航 7 区 + 右侧面板；子面板 busy 时禁止关闭；关闭时回调 `voice.status`。
☐ General ☐ Models ☐ Memory ☐ Voice ☐ Usage ☐ Computer（仅 owner+computers 不可用） ☐ Updates

### 6.2 Account/General（`pages/AccountSettingsOverlay.tsx`）
Account（只读名+邮箱）、ChangePasswordSection（三字段+SuccessPop）、Messaging 卡（→§6.5）、Appearance（System/Light/Dark 分段）、Language（无障碍 combobox，10 语言）、Avatars（Robot/Organic 风格切换+预览）、"Server integrations"入口（owner）、Advanced 折叠（Stream replies Switch、Show tool activity Switch、ApprovalRulesSettings）、页脚 Help/Feedback/Privacy 外链。
Usage 面板（runs+tokens，"Model spend uses your provider keys."）；Computer 面板；Updates 面板（DesktopUpdateSection+SoftwareUpdateSection）。

### 6.3 Models（`pages/ModelSettingsOverlay.tsx`）
"Active model"卡；双列：Providers 搜索+分组列表（计数/本地化提示/Connected 徽标/空态）；详情：OpenAI-compatible（URL+探测+模型选择/手输+ThinkingOptions）、托管（ModelPicker 搜索分组+"Free"标签+max tokens）、账单说明、不可用原因、Personal credential 卡（"Stored securely. Never shown here."）、OAuth 登录盒（验证 URI+粘贴码/设备码展示+"Waiting for sign-in…"）、API key 输入+Save/Connect/Replace、"Use this model"。

### 6.4 Memory（`pages/MemorySettingsOverlay.tsx` + `pages/memory-providers/`）
已连接卡（provider+ScopePicker Isolated/Shared+Disconnect）或安装表单：provider NativeSelect（Supermemory：Cloud/Local+Base URL+API key"sm_…"；Serenity：MCP endpoint+Bearer token≥8+Brain label+Allow writing 双档）；SpaceMemorySection"Shared documents"；"provider not available in this build"态。

### 6.5 Messaging（`pages/MessagingSettingsOverlay.tsx` + `pages/ExternalConversationSettings.tsx`）
四节：Chat apps（身份列表→bot 映射+Unlink；bot 选择+Link 发码+10 分钟指引）；Channels（群聊频道：provider·agent·状态·成员数；受邀 Approve/Decline；已加入 Leave）；Agent connections（对端 bot+状态；pending Approve/Decline；已批 Revoke）；Team conversations（展开 ExternalConversationSettings：Listening 三档、Room guidance 4000 字+重置、Automated senders 逐发送者策略+rollup 小时数、Save+SuccessPop）。

### 6.6 MCP Servers（`pages/McpServersOverlay.tsx`）
双列：添加卡（名称；transport Tabs HTTP/SSE/STDIO；URL 或 command+args；Advanced：token/header 名值；agent pill 多选；"Add server"）+ 已配置卡（transport 徽标、端点、OAuth 状态文案、逐 bot 配 pill、Connect/Reconnect OAuth+Disconnect、Delete 两击确认）；BroadcastChannel 刷新；空态"No MCP servers yet."。

### 6.7 Plugins / Integrations（`pages/PluginsOverlay.tsx`）
搜索；"Browse MCP servers"开关（内嵌 IntegrationSetup）；featured 连接器瓦片+过滤目录（logo、Add/Added/"Adding…"、"Show more"）；详情视图（返回、Uninstall、Accounts 卡：改名/Remove/"Add another"+Tools 卡）；Advanced（"Search by domain"目录 feed、五种手动源添加 MCP/OpenAPI/GraphQL/Executor/Treg + 表单（名称/URL/auth none|bearer|header）、"Tool sources"列表+Remove、"Manage MCP servers"→§6.6）；连接轮询 45×2s；无鉴权即时连接；卸载中止。

### 6.8 Routine 编辑（`pages/RoutineEditor.tsx` + `RoutineSchedule.tsx`）
列表头（Routines+新建）；行（时钟/暂停图标、名、触发摘要 cron/webhook/Git/Slack、"Running · Stop" pill）。编辑器：Active 开关+Delete+Test run；Name；Instruction Textarea；"When to run"（+时区）：schedule 卡（频率 NativeSelect、interval 数量+单位、时刻、Advanced cron 输入）、Webhook/Git InboundTriggerCard（POST URL、key、header、"Rotate key"）、MessageTriggerCard（Slack，messaging 关时禁用）、one-shot datetime-local；"Add trigger"下拉（hourly/daily/weekdays/weekly/monthly/Interval/Advanced；Slack；禁用 Coming-soon：Teams/Linear/Sentry/PagerDuty；Git event；Webhook）；无触发禁 Save；"Run history—No runs yet"占位。

## 7. 聊天渲染契约（新 UI 必须全类型覆盖）

### 7.1 MessageBlock（`packages/contracts/src/events.ts:95`，23 种）
`text` · `card`(kv) · `ask`(text|secret 输入, otp|password|api_key 目的, actions, approvalEffectId, status) · `choice` · `app_connect` · `connect` · `computer` · `voice_call` · `meta` · `progress`(pendingToolNames) · `steps` · `subagent` · `child_bot` · `cloud_agent` · `skill_draft` · `chart`(Observable Plot, 5000 行上限) · `mcp_approval` · `image` · `file` · `handoff`(bot→bot 带 hop) · `channel_message` · `bot_message_sent` · `bot_message_received`(intent: request|result|question|status|fyi)
事件折叠逻辑在 `packages/core/src/events.ts`（`reduceLiveMessageBlocks`/`mergeThreadHistory` 等），被 `apps/web/src/lib/thread-events.ts` 消费——**保留不动**。

### 7.2 ProductEvent（`packages/contracts/src/events.ts:6`，经 `threads.subscribe` SSE，45 种）
Thread(13)：message.created / cleared / message.updated / message.reaction / progress / artifact / ask / choice / meta / computer / subagent / cloud_agent / call.ended
Run(6)：started / checkpointed / waiting_input / completed / failed / cancelled
Computer(5)：status / takeover.requested / takeover.granted / takeover.released / command
Memory·Routine·Skill(8)：memory.revised / routine.created|updated|fired / skill.teaching.started|stopped / skill.draft.created / skill.saved
Actions(4)：effect.recorded / agent.tool.called / agent.tool.completed / effect.reconciled
Usage(1)：usage.recorded
Roster(7)：bot.spawned|updated|archived|deleted / group.created|updated|handoff
心跳(1)：heartbeat（seq 0 不持久化）

### 7.3 AgentRuntimeEvent（`packages/adapter-kit/src/types.ts:466`，9 种）
text / progress(activity?) / tool / ask / takeover / usage / checkpoint / subagent(running|completed|failed) / done

## 8. RPC 功能面（`packages/contracts/src/rpc.ts` AppContract，35 组）

| 组 | 过程要点 | 现有 UI 入口 |
|---|---|---|
| aiConsent | status/allow/revoke | ☐ 待确认入口 |
| health | 健康检查 | —（无 UI） |
| me/preferences | 当前用户；avatarStyle | 用户菜单/General |
| spaces | list/create/remove | 侧栏菜单+NewSpaceDialog |
| bootstrap | 一次拉全启动数据 | Shell 启动 |
| deployment | get/update（注册开关/allowlist/computer host） | HostComputerPrompt；（owner 设置 UI 待确认） |
| updater | status/check/apply | SoftwareUpdateSection |
| models | list/credentials/connect/probe/begin·submit·complete·finish·cancelOAuth/setDefault | ModelSettings/Onboarding/BotSettings |
| bots | list/get/create/duplicate/reorder/update/setComputer/archive/restore/remove/rotateWebhookSecret | 侧栏/BotSettings/对话框 |
| groups | create/list/get/duplicate/update/archive/restore/remove | GroupPanel |
| botSections | list/create/update | 侧栏分区 |
| threads | head/get/messages/subscribe/send/react/stop/followUp/endCall/clear/answer/markRead|Unread | Transcript/Composer/AskCard |
| computer | status/boot/stop/recover/reset/update(s)/releaseInterrupted/dismissUpdate/takeover/release/input/files/readFile/downloadFile/uploadFile/terminalUrl/commands/screenUrl/heartbeat | ComputerWorkspace/Files/Terminal/Maintenance/Progress |
| memory | list/update/exportMarkdown/providerConfig/connectProvider/setDefaultScope/disconnectProvider | KnowledgeSection/MemorySettings |
| routines | list/create/update/remove/testRun | RoutineEditor |
| scratchpad | list/create/update/remove | ScratchpadSection |
| skills | list/get/start/appendEvent/snapshot/stop/updateDraft/save/testRun/remove | Teach 流程/SkillDraftCard |
| agentSkills | list/get/create/update/remove | KnowledgeSection Skills tab |
| capabilities | list/catalogSearch/install/remove | PluginsOverlay/IntegrationSetup |
| mcp | servers.*、assignments.*、oauth.* | McpServersOverlay/McpApprovalCard/IntegrationSetup |
| onboarding | start/promptFocus/choose/dismissFocus/appConnected | ChoiceCard/Onboarding |
| integrationSetup | get/save | IntegrationSetup |
| connections | catalog/list/begin/complete/rename/revoke/tools | PluginsOverlay/AppConnectCard |
| messaging | status/link.start/identities.*/channels.*/connections.* | MessagingSettingsOverlay |
| approvalRules / autoReview | list/set/remove；get/set | ApprovalRulesSettings |
| artifacts | list/listSpace/listVersions/create/get/getById/remove | Artifacts 页/附件/ArtifactImage/FileCard |
| usage | list/summary | UsageSettingsPanel |
| export | bot | BotSettings Export |
| notifications | registerPush/unregisterPush | browser-notifications（☐ 入口待确认） |
| search | query | 侧栏搜索 |
| runs | list(active|recent) | ActivityList |
| voice | catalog/status/credentials/connect/disconnect/setVoice/setSpeechModel/voices/prepare | VoiceSettings/CallCard |
| externalConversations | updatePolicy | ExternalConversationSettings |
| agentSecrets | list/put/remove（otp/password/api_key） | ☐ 入口待确认（AskCard secret 提交侧） |

鉴权不在 oRPC 契约内：Better Auth REST `/api/auth/*`。

## 9. 现有 UI 资产盘点（新组件库的需求依据）

### 9.1 ui-tokens（`packages/ui-tokens/src/index.ts`）
33 个语义色槽 × 明/暗 = 66 值（shadcn 槽位命名）+ overlay/scrollbar + chat 专用槽（chatUser 等）+ sidebar 槽；单一圆角 `--radius: 0.75rem`；无字体/间距/阴影 token（Tailwind 直用）；字体 Geist Variable；暗色为一等公民（`data-theme` + index.html no-flash 脚本 + theme-color 交换）；bot 调色板 7 色（botColors）；存储键 `rakazo.uiAppearance`（**重命名产品时注意迁移 localStorage 键**）。

### 9.2 ui-web 组件（25 原语 + 品牌复合件）与使用频次
Button 42 处 · Input 19 · Dialog 14 · Field 6 · Label 5 · Toggle 5 · Card 5 · AlertDialog 4 · DropdownMenu 4 · Switch 4 · Command 3 · Tabs 3 · Badge 3 · Select 3 · Popover 2 · Skeleton 2 · Checkbox/Kbd/InputGroup 各 1 · **零使用**：Tooltip、Spinner、Separator、ScrollArea。
品牌件：BotAvatar+GrokShape 形状族、AvatarStyleProvider、GroupAvatar、ModelThinkingOptions、cn、styles.css（tailwind preflight）。

### 9.3 chat-ui
仅 markdown 渲染（web+RN 双端）：ChatMarkdown、LinkifiedText、MarkdownTable/TableCard（交互表格卡）、Copy/Check icons、sanitize/linkify 工具。**事件→组件映射在 web 应用内**（Shell.tsx 6113–6531 的 block switch + `pages/shell/message-cards.tsx` + AskCard/CloudAgentCard/SkillDraftCard/CallCard）。

## 10. e2e 回归网（`apps/web/e2e/`，~71 spec）

**聊天/消息（19）**：chat-progress-messages、response-streaming、tool-activity、tool-activity-disclosure、choice-card、secret-card、login-card、computer-needs-you-card、mcp-approval-card、cloud-agent-card、message-hover-actions、message-quote、message-jump、markdown-table、chart-links、mention-picker-keyboard、slash-skills、composer-paste、peer-messages
**群聊/审批/失败/语音（5）**：group-chats、run-failure、approval-resume、consequential-approval、voice
**Computer/工作区（8）**：computer-workspace、computer-update、computer-screen-error、screen-proxy-isolation、mobile-computer-keyboard、team-computer、host-computer-prompt、desktop-update
**Bot/侧栏/导航（10）**：bot-crud、bot-organization、collapsible-sidebar-sections、sidebar-reporting-tree、sidebar-roster-title、sidebar-preview-identifiers、new-bot-ux、spaces、command-palette、mobile-sidebar-swipe
**模型/引导/设置（12）**：model-settings、model-picker-search、onboarding-conversation、onboarding-model-auto-skip/-labels/-required、settings-shell、ui-appearance、ui-locale、local-settings、knowledge-panel、avatar-studio、avatar-style、avatar-motion
**集成/消息平台（6）**：integration-setup、graphql-integrations、mcp-oauth、messaging-settings、messaging-transport、routine-crud、routine-execution
**账号/内容/横切（5）**：auth-lifecycle、browser-auth、golden（两用户隔离+持久工作冒烟）、artifacts-tab、artifact-preview、teach-task
静态 fixtures：avatar-motion、chart-links、chat-progress-messages、markdown-table、response-streaming、tool-activity(+disclosure)。

## 11. 横切关注点（每项都要在新 UI 有答案）

☐ 主题：明/暗/跟随系统，`data-theme`，no-flash 脚本，theme-color 交换
☐ RTL：`applyUiDirection`
☐ i18n：Lingui，10 语言（en/de/es/fr/hi/ko/pt-BR/ru/tr/zh-CN）× 922 条；语言切换即编译目录
☐ 附件限制：10MB、4 文件、图片 jpeg/png/webp/gif + 文件 pdf/plain/markdown/csv/html/json
☐ 桌面桥：`lib/desktop`（Electron bridge）、WindowChrome、DesktopUpdates、LocalSettings 页
☐ 推送：`lib/browser-notifications`（registerPush）
☐ 会话门：SessionUnavailable 指数重试；ShellSkeleton
☐ 品牌注入：`product-brand-assets.ts` vite 插件（`__PRODUCT_*__` → index.html/site.webmanifest；brand.json 单一来源）
☐ 无障碍现状：aria-live 标题、role=alert、sr-only 锚点、reduced-motion（avatar-motion）——新 UI 保持并加强
☐ 键盘：⌘K 面板、⌘1–9、Esc 挂断/关弹层、mention/斜杠 picker 键盘导航
☐ 移动：侧栏边缘滑动、触摸键盘、hover 轨变静态
☐ 性能：Transcript memo、IntersectionObserver 懒加载、懒路由、plot 懒载、SSE churn 下禁用过渡动画

## 12. 已知缺口（重设计时应顺带补齐）

1. 无全局 toaster（错误反馈散落在 inline 文案/SuccessPop）——新组件库应内置 Toast。
2. 无顶层 ErrorBoundary——渲染异常会白屏。
3. 无 404 路由——未知路径空白。
4. Shell.tsx 6600 行单文件——迁移时拆分（transcript/composer/sidebar/panels/hooks 各自成模块），但按批次进行。
5. analytics/特性开关不存在（是否引入由产品决策）。
6. FilesApp 无重命名/删除/建目录（若产品需要，属功能新增而非迁移）。
7. `pnpm-workspace.yaml` 残留 `infra/updater` 引用。
8. 产品名未定（brand.json "MyPal" vs 仓库 "WorkPal"）——**必须先定名**，避免品牌层返工。

## 13. 迁移策略（建议）

- **保留层**（不重写）：oRPC 契约与 `lib/` 数据层、事件折叠 reducers、auth glue、e2e 的 testid 契约。
- **替换层**：ui-tokens（新设计 token 集）→ ui-web（新组件库，新包并行如 `@workpal/ui`）→ chat 渲染壳 → 页面逐页替换（strangler，路由/面板粒度）。
- **批次建议**：① 定名+brand.json 收敛 → ② tokens+25 原语（现成需求清单见 §9.2，补 Toast/Tooltip/Separator）→ ③ 聊天渲染器族（§7 全类型）→ ④ 独立页（Auth/Welcome/Onboarding/Artifacts）→ ⑤ Shell 分批拆分+换肤（sidebar → transcript → composer → 右侧面板）→ ⑥ 设置 overlay 族 → ⑦ Computer/Teach/Voice 工作区。
- **每批完成的定义**：对应 e2e spec 全绿 + 状态矩阵核对 + i18n 无硬编码。
- **同步动作**：更新 AGENTS.md 的 UI 约束条款（现为"继续使用 @rakazo/ui-*"）。
