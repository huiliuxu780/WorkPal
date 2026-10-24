# RT-03：agent_pair Thread 访问策略与验证证据

- 状态：已实现并完成本地验证
- 范围：receipt 驱动的只读历史投影、用户写入拒绝、普通产品入口隔离
- 非目标：RT-05 `message_bot` 迁移、RT-09 pair 浮窗、RT-16/background helper、永久删除

## 1. 授权模型

`agent_pair` Thread 不是用户拥有或管理的普通会话。用户获得的是一次由来源 receipt 证明、按来源 Thread 权限裁剪的历史读取能力。

集中策略位于 `packages/db/src/thread-policy.ts`，读取授权同时绑定：

1. 当前 actor 的 `spaceId` 与 `userId`；
2. locator 中的 `pairThreadId`、目标 `messageId` 与 `sourceReceiptMessageId`；
3. pair 消息的持久化 origin 记录；
4. origin 指向的来源 Thread、来源 Run 和 receipt；
5. actor 对来源 Thread 的现有所有权，以及 pair Thread 自身的空间和用户边界。

授权不以“两个 Bot 是否属于同一用户”代替来源检查。一个 pair 可以承载多个来源；查询先按 actor 可访问的来源 Thread 建立 authorized projection，再在该投影内定位、计数和分页。未写入 origin 的 pair 消息对用户默认不可见。

`agent_pair_message_origins` 为每条可投影的 pair 消息保存一个不可变来源：pair Thread、来源 Thread、来源 Run 和来源 receipt。`recordAgentPairMessageOrigin` 在写入前验证 pair 消息类型、来源 Thread 类型，以及 Run 对 receipt 的引用。它是后续投递路径可调用的原子边界；本任务没有实现 RT-05 的新消息投递或 `message_bot` 迁移。

## 2. 只读查询语义

RPC `threads.pairMessages` 必须携带 receipt ID 和 `pair_message` locator。只传 `pairThreadId`、猜测目标消息、使用无权 receipt，或使用其他用户 locator，均返回相同的 `NOT_FOUND`，不区分哪一项存在。

查询语义如下：

- 目标定位只在 actor 的 authorized projection 内成功；`visibleIndex` 是该投影中的零基位置。
- `totalCount` 只统计 authorized projection。
- `hasMore` 和 `olderCursor` 只由 authorized projection 计算。
- `olderCursor` 使用可见消息 ID，是稳定的不透明游标；调用方看不到物理 Thread `seq`，避免通过序号缺口推断隐藏消息。
- reply 指向未授权消息时，服务端移除 `replyToMessageId` 与 quote，避免通过引用元数据泄露隐藏消息。
- 读取在 PostgreSQL `REPEATABLE READ` 事务中完成，授权、计数和页面来自同一快照。

## 3. 写入与普通入口边界

用户写入的 Thread kind 判定集中在 Thread policy；router 不散落 `agent_pair` 字符串比较。普通 target resolver 仍只解析 Bot Thread 与 `standard` 群，pair ID 不能伪装成普通群 target。

服务端拒绝以下操作进入 pair Thread：

- 用户消息、任务修订、follow-up、reaction、clear/stop/cancel；
- approval/input/intervention 提交；
- mark read/unread；
- Routine 从聊天绑定；
- 群 archive/restore/remove、详情读取和成员变更。

群管理继续复用既有 `standardGroupScope` 和 `CHAT_GROUP_KIND_STANDARD`。pair 不进入会话列表、跨空间群选择器及其未读徽标、搜索结果、普通群详情或成员管理入口。这里没有新增前端隐藏逻辑，也没有把 pair 暴露成普通 Thread。

## 4. 生命周期

- Bot 改名、停用或软删除不改变既有 pair identity，也不撤销 actor 对仍有权来源的历史读取。
- 替代 Bot 使用新的 Bot ID，因此生成新的 pair identity，不继承旧 pair Thread 或历史。
- 本任务没有增加 pair 会话列表、归档、成员管理或永久删除能力。

## 5. 验证证据

受影响包类型检查：

```bash
pnpm --filter @rakazo/contracts check
pnpm --filter @rakazo/db check
pnpm --filter @rakazo/api check
pnpm --filter @rakazo/adapters check
```

结果：全部通过。

定向单测：

```bash
pnpm exec vitest run \
  packages/adapters/src/schedule-tools.test.ts \
  apps/api/src/router.test.ts \
  apps/api/src/search.test.ts \
  apps/api/src/thread-message-pages.test.ts \
  packages/db/src/agent-pairs.test.ts \
  packages/db/src/groups.test.ts \
  --reporter=dot
```

结果：6 个文件、176 tests 全部通过。覆盖 pair RPC、send/react/archive/member mutation/Intervention/Routine 拒绝，以及 list/search/group picker/unread 隔离。

真实 PostgreSQL：

```bash
VERIFY_DATABASE=1 DATABASE_URL=<isolated-postgres-url> \
  pnpm exec vitest run packages/db/src/agent-pairs.postgres.test.ts --reporter=dot
```

结果：21 tests 全部通过。覆盖真实迁移、origin 表与查询、两个来源的交错消息、授权过滤后的分页/定位/计数、统一不存在响应、Bot rename/soft-delete/replacement 生命周期。

全仓类型检查：

```bash
pnpm check
```

结果：18 个 Turbo tasks 全部通过。

提交前差异检查：

```bash
git diff --check
```

结果：通过，无空白错误。
