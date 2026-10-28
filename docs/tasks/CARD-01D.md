# CARD-01D：Attention queue 与 Web 通知

状态：`ready-to-merge`（PR #147 未合入；合入后才为 `done`）

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

- 消费 CARD-01A 定义的 attention DTO，增加服务端有界查询/RPC，只返回当前 actor 有权访问线程中仍需本人处理的 Interaction 投影：
  - 持久 pending Intervention
  - 当前有效的派生 `SessionControlView`
  - 完成严格映射后的 pending 业务审批，包括 `ActionApprovalView(group_membership)`
- 查询不得扫描或暴露 Run 历史、完成记录、普通后台工作、旧 `connect` 回放、`collaboration_receipt`、private pair receipt、`task_status` 或 PD-01 Retry。
- 排序固定为 `expiresAt ASC NULLS LAST → attentionAt ASC → stableId ASC`；按 `interactionId + revision` 去重并分页。
- Web 增加轻量 attention queue：条目显示来源 Bot、Task 或 reply target，点击跳回来源 Interaction 并聚焦。
- 结算后条目立即消失，计数同步；关闭队列不等于处理请求。
- 未读角标、待处理角标和 @我使用文字、形状与颜色共同区分。
- 群聊成员等待标记只标等待中的 Bot，决定后移除；点击只回来源。
- 浏览器通知只使用 Web Notification 或仓库已有 Web Push，覆盖需要本人处理的 Interaction；普通展示、后台进度、终态、`collaboration_receipt` 和 private pair receipt 不再提醒。
- 通知内容脱敏，不包含收件人、正文、金额、卡号、地址、验证码、密码、参数或文件名；通知内不能直接批准。
- 只有可信 `expiresAt` 存在时才能引用过期时间；不承诺固定提前量。
- 点击通知回到来源 Interaction；已终态时只展示终态。
- 不得恢复已退役的 Task Center 路由或数据模型。

## 允许修改

- `packages/contracts/src/rpc.ts` 及查询 schema
- `packages/db/` 中新增的有界 attention 查询（三类来源）
- `apps/api/src/router.ts` 和鉴权/授权适配
- `apps/web/src/pages/ActivityList.tsx` 或新的轻量 queue 组件
- `apps/web/src/pages/Shell.tsx` 的入口、计数和来源跳转
- `apps/web/src/lib/browser-notifications.ts` 及相关设置
- 对应 API、Web、e2e 和通知测试

## 禁止

- 修改 Interaction 的创建、结算、权限或 ExternalEffect 语义
- 读取全部 Run 历史来计算待处理
- 恢复 Task Center、任务完成列表或运行详情入口
- 把 `collaboration_receipt`、private pair receipt、`task_status` 或 PD-01 Retry 加入 queue 或通知
- 新增原生移动端通知
- 在通知中放敏感正文或直接执行决定
- 在 gate 关闭时改变现有 ActivityList/未读行为

## 验收

- 三类来源都进入 queue：持久 pending Intervention、当前有效 `SessionControlView`、strict pending 业务审批（含 `group_membership`）；answered、expired、cancelled、superseded、普通 Run、Run 历史、后台任务、旧 `connect` 回放、`collaboration_receipt`、private pair receipt 和 `task_status` 不进入。
- 服务端按 `expiresAt ASC NULLS LAST → attentionAt ASC → stableId ASC` 排序，按 `interactionId + revision` 去重并分页；无权限或失去资格后立即排除。
- 来源跳转准确，处理后条目和计数同步消失；空队列有明确空态。
- 群聊来源可按 Bot 和 Task/reply target 寻址，不依赖孤立的“可以”或“A”。
- 未读、待处理、@我语义在测试中互不混用。
- 通知覆盖 Interaction 创建/需要处理，终态停止；`collaboration_receipt` 的创建/更新和 private pair receipt 不触发通知；内容扫描无敏感字段；不提供通知内批准。
- `expiresAt` 缺失时不生成固定提前量承诺。
- 现有 `ActivityList`、未读和通知行为在 gate 关闭时保持不变；开启后 15s 轮询或新查询不造成重复条目。
- 390px、375px 和深色模式可用；键盘可达，处理后焦点合理。

## 交付

查询/RPC、Web queue、通知、测试和 390/375 截图。总 gate 保持默认关闭。

## 交付记录（2026-10-28 复审轮）

- 分支/PR：`codex/card-attention` / [#147](https://github.com/huiliuxu780/WorkPal/pull/147)，复审后代码 head `ad7f8d9`（此后只有证据与状态类文档提交）。
- 证据：[docs/cards/evidence/card-attention](../cards/evidence/card-attention/README.md)（N1/N2/N3/N4 实拍、红绿、E2E 运行日志）。
- 复审轮修复：通知正文改为按类型的固定文案（不再拼接 Bot 生成的 `presentation.text`，与更新后的 N4 原型一致，红绿见 `red-green/RED-p2-5-*`/`GREEN-p2-5-*`）；gate 开启时停用旧的按 Bot 通知（`shouldNotifyLegacyBrowser`），普通消息与终态不再提醒；N3 增加未读圆点与数字计数分离的断言和截图；修正 E2E 中失效的敏感扫描正则。
- 代码 head `ad7f8d9` 的 CI：[run 40661217374](https://github.com/huiliuxu780/WorkPal/actions/runs/40661217374) 全部通过，`web` job 实跑 `card-attention.spec.ts` 2 passed；PR 最终 head 的 checks 见 #147。
- 遗留（不阻塞本卡，已在证据 README 记录）：`@我` 在仓库中没有产品概念，未实现也未断言；`expiresAt` 已过但仍 pending 的行由超时任务结算，读取模型保留；`SOURCE_LIMIT=500` 截断、群来源不复查 bot 归档未覆盖。
