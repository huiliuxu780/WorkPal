# CANCEL-01 统一非手动取消的收尾

状态：`not-started`

## 目标

关闭两个已确认缺陷：

- `bot_message` 触发的受托 Run 被非手动停止路径取消后，委派方收到一次「已取消」及安全的原因说明。
- 忙碌 Run 上的 steering 消息在非手动取消后不会成为孤儿。系统继续处理仍有合法执行目标的消息；无法继续时，系统明确告诉用户消息没有被处理。

输入报告为外部 `myagent/docs/WorkPal-formal/SCAN-REPORT.md`，SHA-256 `004950fcdef44df66703112b052e0c70581f3d0b0e07ad82b6e6d95babe97458`。2026-10-24 在 `origin/main @ 5a1e551` 复核确认：outcome reconciler 仍只扫描 `completed` 和 `failed`；`cancelRunsInTransaction` 仍不处理 steering；续写仍只由 `finalizeRun` 创建。

## 取消原因和策略

新增服务端类型化取消原因。不要从 `error` 文本反推策略。每个原因明确给出以下两项：

- 是否向委派方返回取消结果。
- steering 是删除、释放后续写，还是保留消息并告知无法继续。

策略基线：

| 取消来源 | 委派结果 | steering |
| --- | --- | --- |
| 用户在当前会话明确点「停止」 | 不自动回报取消 | 删除，保持现有「用户主动放弃追加消息」语义 |
| 等待超时、计划被拒、预算取消 | 返回类型化取消原因 | 释放；没有其他 active Run 时创建一个 continuation |
| Bot 开始教学且之后仍可在该会话工作 | 返回类型化取消原因 | 释放；仅在 Bot 当前仍有权限且可运行时续写 |
| Bot 被移出群、归档或删除 | 返回类型化取消原因 | 禁止为无权限或不存在的 Bot 新建 Run；保留用户消息，并追加可见的「未处理」说明，供用户重新指定 Bot |
| superseded 或系统内部替换 | 按调用点的显式策略 | 不允许静默丢失；要么迁移到替代 Run，要么显示未处理说明 |

「取消后总是再开一轮」并不安全。Bot 被移出群或删除后，新建 continuation 会绕过成员或资源边界。本任务必须按上表区分。

## 实施边界

- 把取消、pending Intervention 收尾、steering disposition 和需要的 durable delivery 或 continuation 写入同一事务边界，或使用同事务 outbox。禁止依赖进程内回调补偿。
- 委派取消结果复用 `auto-outcome:<runId>` 去重身份。reconciler 与 executor 竞争时最多返回一次。
- 用户可见原因来自白名单枚举，不回显堆栈、内部 lease、fence、Attempt 或原始 error。
- 续写仍遵守同 Bot、同 Thread 的 active Run 唯一性和 RT-25 session admission。多来源 steering 不得错误合批。
- 不扩大 Bot、群成员、文件、连接器或 Thread 权限。
- 若现有文本消息和 meta 投影足以呈现结果，本任务不改页面视觉。任何新卡片或布局改动必须另走已确认原型。

## 验收

1. 移出群、开始教学、归档和删除四条路径各产生一次取消 outcome；委派方收到不同且不泄密的原因。
2. 用户明确点「停止」不产生委派取消 outcome，并删除挂在该 Run 上的 steering。
3. 等待超时、计划被拒和预算取消各释放 steering，并在没有其他 active Run 时只创建一个 continuation。
4. Bot 被移出群、归档或删除时不创建非法 continuation。原用户消息仍可见，并出现一次「未处理，需要重新指定」的提示。
5. 重复 sweep、Worker 重启和 executor/reconciler 并发不会重复发 outcome 或重复创建 continuation。
6. 单聊、群聊、messaging channel 分批 steering 各有 PostgreSQL 测试；同一 Bot 不出现两个 active conversational Run。
7. [RT-24](../roundtable/roundtable-implementation-plan.md#rt-24-补齐群路由冲突和收尾行为) 和 [RT-27](../roundtable/roundtable-implementation-plan.md#rt-27-实施确定性-steering-和-session-排队接入) 的相关场景继续通过。
