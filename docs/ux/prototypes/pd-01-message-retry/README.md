# PD-01 消息级重试入口 · 可运行原型

打开 `index.html` 即可运行（无构建、无外部依赖）。用于产品负责人确认消息操作区的重试入口，确认后才继续修改生产页面。

## 场景

1. `无卡 cancelled（单 Bot）`：触发消息仍在首屏，消息操作区出现 Retry；hover 和键盘 focus 都可见。
2. `群聊双 Bot（无卡）`：两个 cardless cancelled Run 从 `sourceMessageId` 恢复，accessible name 分别是 `Retry Planner` / `Retry Coder`。
3. `有卡 Run（无消息入口）`：Retry 只在执行卡内，消息操作区没有第二个入口。
4. `allowed=false（不显示入口）`：`manualRetry.allowed=false` 时不显示可执行入口。
5. `重试提交中` / `重试成功后入口消失`：提交中按钮 disabled、`Retrying…`；成功后入口立即消失并提示 successor 已创建。

主题切换按钮可检查深色；窄窗口（<=640px）下操作区按现有触屏规则落到气泡下方。

## 边界（与决策一致）

- 入口只是消息操作：不进入 ExecutionCard 四信号、Attention、通知或 `task_status`。
- 点击复用 `runs/retry` + 稳定 `clientNonce` + `retryOfRunId` + `ExternalEffect.operationId`，不重发消息。
- 视觉沿用现有消息操作区（React / Reply / More 图标区、28px 图标按钮、20px 用户气泡），不重新设计聊天页面。
