# CARD-01D：Attention queue 与 Web 通知

状态：`not-started`

父任务：[CARD-01 卡片统一与拓展](./CARD-01.md)

依赖：[CARD-01A](./CARD-01A.md)、[CARD-01B](./CARD-01B.md)。

## 用户结果

用户能在一个轻量入口看到自己当前必须处理的 pending Interaction，并跳回来源消息。处理后条目和计数立即消失。通知只覆盖 Interaction 创建/需要处理，不恢复 Task Center，也不包含运行历史。

## 输入

- [CARD-01 决策](../cards/CARD-01-decision.md)
- [生产实现盘点](../cards/CARD-01-implementation-inventory.md)
- 主要场景：`b-alerts.html` N1–N4；来源交互 `cards.html` A1–A13
- 验收截图：[alerts](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-b-alerts.png)、[states](../cards/source/card-unification-v2/mockup/cards-hifi-v4/shot-c-states.png)

## 范围

- 增加服务端有界查询/RPC，只返回当前用户可处理且 `pending` 的 Intervention，附带可寻址来源和最小展示字段。
- 查询不得扫描或暴露 Run 历史、完成记录、普通后台工作或无关 Space。
- Web 增加轻量 attention queue：条目显示来源 Bot、Task 或 reply target，点击跳回来源 Interaction 并聚焦。
- 结算后条目立即消失，计数同步；关闭队列不等于处理请求。
- 未读角标、待处理角标和 @我使用文字、形状与颜色共同区分。
- 群聊成员等待标记只标等待中的 Bot，决定后移除；点击只回来源。
- 浏览器通知只使用 Web Notification 或仓库已有 Web Push，覆盖需要本人处理的 Interaction；普通展示、后台进度和终态不再提醒。
- 通知内容脱敏，不包含收件人、正文、金额、卡号、地址、验证码、密码、参数或文件名；通知内不能直接批准。
- 只有可信 `expiresAt` 存在时才能引用过期时间；不承诺固定提前量。
- 点击通知回到来源 Interaction；已终态时只展示终态。
- 不得恢复已退役的 Task Center 路由或数据模型。

## 允许修改

- `packages/contracts/src/rpc.ts` 及查询 schema
- `packages/db/` 中新增的有界 pending Intervention 查询
- `apps/api/src/router.ts` 和鉴权/授权适配
- `apps/web/src/pages/ActivityList.tsx` 或新的轻量 queue 组件
- `apps/web/src/pages/Shell.tsx` 的入口、计数和来源跳转
- `apps/web/src/lib/browser-notifications.ts` 及相关设置
- 对应 API、Web、e2e 和通知测试

## 禁止

- 修改 Interaction 的创建、结算、权限或 ExternalEffect 语义
- 读取全部 Run 历史来计算待处理
- 恢复 Task Center、任务完成列表或运行详情入口
- 新增原生移动端通知
- 在通知中放敏感正文或直接执行决定
- 在 gate 关闭时改变现有 ActivityList/未读行为

## 验收

- 只有当前用户的 pending Interaction 进入 queue；answered、expired、cancelled、superseded 和普通 Run 不进入。
- 来源跳转准确，处理后条目和计数同步消失；空队列有明确空态。
- 群聊来源可按 Bot 和 Task/reply target 寻址，不依赖孤立的“可以”或“A”。
- 未读、待处理、@我语义在测试中互不混用。
- 通知覆盖 Interaction 创建/需要处理，终态停止；内容扫描无敏感字段；不提供通知内批准。
- `expiresAt` 缺失时不生成固定提前量承诺。
- 现有 `ActivityList`、未读和通知行为在 gate 关闭时保持不变；开启后 15s 轮询或新查询不造成重复条目。
- 390px、375px 和深色模式可用；键盘可达，处理后焦点合理。

## 交付

查询/RPC、Web queue、通知、测试和 390/375 截图。总 gate 保持默认关闭。
