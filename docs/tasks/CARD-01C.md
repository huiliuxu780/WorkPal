# CARD-01C：DisplayBlock、详情视图与安全 HTML

状态：`not-started`

父任务：[CARD-01 卡片统一与拓展](./CARD-01.md)

依赖：[CARD-01A](./CARD-01A.md)。可以在 A 后并行开发，但 `Shell.tsx` 的接入必须等待 [CARD-01B](./CARD-01B.md) 冻结接入接口。CARD-01B 是 Interaction renderer 接入、Card Shell、`InterventionRegion` 统一和 interaction 排序的唯一 owner；CARD-01C 是 DisplayBlock registry、展示成员、详情组件和安全 HTML 的唯一 owner。

## 用户结果

Markdown、结构化表格、图表、集合、媒体、安全 HTML、任务状态、Page 和语音使用统一的只读展示路径。复杂内容可以展开而不改变消息本身；展示区没有任何批准、付款、发送、删除或授权控件。

## 输入

- [CARD-01 决策](../cards/CARD-01-decision.md)
- [生产实现盘点](../cards/CARD-01-implementation-inventory.md)
- [STYLE-SPEC](../cards/source/card-unification-v2/mockup/cards-hifi-v4/STYLE-SPEC.md)
- 主要场景：`cards.html` D1–D7、B4–B7；`a-detail.html` V2–V4
- 验收截图：[cards](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-cards.png)、[details](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-a-detail.png)

## 范围

- 本任务是 DisplayBlock registry 的唯一 owner：markdown、table、chart、collection、media、html、task_status、page、voice，以及独立详情组件、安全 HTML 和对应测试。
- B 未冻结接入接口前，C 不修改 `Shell.tsx` 的同一交互/展示 block。需要接入时二选一：
  - 由 CARD-01B owner 提交集成 commit；
  - 等 CARD-01B 合入后 rebase 到 main。
- 不允许两个独立分支并行修改同一 Shell block。
- 建立有限 `DisplayBlock` 渲染注册表：markdown、table、chart、collection、media、html、task_status、page、voice。
- `collaboration_receipt` 与 private pair receipt 不是 DisplayBlock；C 不得把它们纳入展示注册表或改写成普通 Markdown。
- Markdown 长文按渲染高度或行数折叠，不按字符数决定 UI 高度；详情面板打开/关闭不修改消息。
- Markdown 表格只用于简单静态内容；复杂数据使用结构化 `table`，支持 columns/rows、排序和分页。
- 图表提供可访问的数据表替代。
- 媒体支持图片灯箱、文件预览和不支持类型降级；Esc 关闭灯箱。
- task_status 只显示运行工作投影，不进入 attention queue。
- Page 是展示入口，语音是展示类型；B6 表情回应仍是消息操作，B7 消息内跳转仍是 inline reference，都不能被做成卡片。
- HTML 只用于复杂只读报告，复用 `SandboxedHtmlViewer` 的无同源、无网络、无表单提交、无父页面访问和无顶层跳转边界；HTML 中不能出现副作用控件。
- 分享默认要求登录并限制在 Space 内；公开分享必须单独展示 expiry 与撤销能力。
- 旧式 `card` KV 展示仅做只读兼容；孤儿 `connect` 不新增生产者。
- 尺寸、圆角、边框和标题层级按 `STYLE-SPEC.md` 映射到现有设计系统，不复制沙盒色值。

## 允许修改

- `apps/web/src/pages/Shell.tsx` 的展示分支
- `apps/web/src/pages/shell/message-cards.tsx`
- `apps/web/src/components/ArtifactFileCard.tsx`、`SandboxedHtmlViewer.tsx`、`VoiceChatCard.tsx`、`CloudAgentCard.tsx`
- 图表、表格、媒体、Page 和 task_status 的渲染组件与样式
- `packages/chat-ui/` 中 Markdown 渲染适配
- 对应单元、集成和 e2e 测试

## 禁止

- 修改 Interaction 生命周期、审批/输入权限或 Run/ExternalEffect 状态
- 在 B 冻结接入接口前修改 `Shell.tsx` 的同一 block，或与 B 并行改建同一交互区域
- 把 `collaboration_receipt`、private pair receipt、PD-01 Retry 纳入 DisplayBlock
- 在展示块中加入批准、付款、发送、删除、安装或连接控件
- 把 B6/B7 变成卡片
- 扩大 HTML 沙盒权限或允许网络、表单、父页面访问
- 在 gate 关闭时替换现有展示组件

## 验收

- D1–D7、B4–B7 和 V2–V4 的打开、关闭、折叠和降级路径可操作。
- 结构化 table 有真实 columns/rows 行为，不是 Markdown 增强。
- HTML 沙盒测试证明无网络、无表单提交、无同源、无父页面和顶层跳转；副作用控件为零。
- task_status 不进入 pending/attention queue。
- B6/B7 不作为卡片渲染。
- 媒体、图表和长文在 390px、375px 无横向溢出；深色模式可读。
- 现有 `artifact-preview`、`artifacts-tab`、`chart-links`、`voice` 和 `SandboxedHtmlViewer` 测试继续通过。
- 对照原型截图验证视觉层级、间距、圆角、边框和状态表达；不引入第二套 token。
- 接入证据证明只修改了 B 冻结的接口：要么包含 B owner 的集成 commit，要么基于 B 合入后的 main rebase；没有与 B 并行修改同一 Shell block。
- `collaboration_receipt` 和 private pair receipt 的既有渲染路径保持不变，未进入 DisplayBlock registry。

## 交付

展示组件、详情交互、安全测试和 390/375 截图。总 gate 保持默认关闭。
