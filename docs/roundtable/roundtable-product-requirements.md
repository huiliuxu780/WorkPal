# WorkPal 圆桌模式 PRD：完整场景、交互与实现边界

状态：最终版（产品范围已定，可进入技术设计与排期）
日期：2026-10-22
范围：Web-only；AgentScope 是唯一生产执行器

## 1. 结论

圆桌模式不需要另建一套会话、轮次、工作或发言实体。

现有 WorkPal 已有足够完整的骨架：

```text
Thread / Message
  ├─ 用户消息路由：mention > reply > Group Router > lead
  ├─ Task / Run：谁正在响应或执行
  ├─ Run.orchestration.collaboration：owner / support / parentRunId
  ├─ SteeringMessage：用户在 Agent 执行中继续下指令
  ├─ BackgroundAgentTask：Agent 派出的后台长工作
  ├─ DeliveryRecord：后台结果持久回流
  ├─ Intervention：审批与向用户提问
  └─ Event：排序、因果、重放和 UI 投影
```

需要做的不是重新定义这些概念，而是补通四个缺口：

1. **让现有 `message_bot` 拥有正确的两种投递面。** 群内公开委派仍落在当前群 Thread，显示自然的 `@小蓝 去做……`；私下通知则落在 A ↔ B 唯一的长期固定 Thread，来源页面只显示一条轻回执。
2. **恢复并扩展现有 `run_subagent` 的后台执行。** Agent 判断一件事耗时时，可以明确选择 `background: true`；底层继续使用已有 `BackgroundAgentTask`、事件、取消和 `DeliveryRecord`。
3. **允许 Agent 从自己的单聊把工作带进一个已有群。** 新增窄工具 `message_group`；它不是新会话系统，只是 Agent 侧对现有“选择群 → 发消息 → 在群 Thread 创建 Run”能力的受控包装。
4. **允许用户在几轮之后精确补充一个已有 Task。** 用户消息携带服务端校验过的 `taskId` 引用，补充以 Message + Event 追加保存；根据 Task 当前状态复用 steering、queue、retry 或 follow-up Run，不覆盖旧 prompt，也不把补充误投给同一 Agent 的其他工作。

用户在讨论期间随时发送新消息、回复某条消息、单独 `@某个 Agent`，全部复用现有群消息发送和路由，不新增“圆桌用户指令”协议。

本需求以 **96 个原子验收场景**定义完整覆盖面，分成 12 个场景族；原型以 **8 段主故事线 + 28 个高价值分支状态**表达关键交互。96 不是把所有状态机械做笛卡尔积，而是覆盖每一种权威来源、路由结果、已有任务修订、跨会话目的地、Agent-pair 生命周期、并发关系、任务状态、审批结果、失败恢复和收尾结果；组合压力测试在测试设计中处理，不重复发明产品场景。

## 2. 产品语义

### 2.1 用户的 `@` 和 Agent 的 `@` 不是同一条入口

#### 用户 `@Agent`

用户通过现有 composer mention chip 发消息：

> @小橙 你先单独把 B 版的移动端断点做出来，完成后直接发群里。

直接复用当前链路：

```text
sendThreadMessage
  → resolveGroupTurnOwner
  → explicit_mention
  → 当前有对话 Run：写 SteeringMessage
  → 当前没有对话 Run：创建 Task / Run
```

这里不调用任何 Agent 工具，因为触发者是用户，不是模型。

#### Agent `@Agent`

Agent 希望另一个 Agent 真正行动时，调用现有 `message_bot`。在公开群语境里，后端把工具调用渲染成群里的公开 `@Name` 消息。

> Joy：@小蓝 核对性能基线；@小橙 出两版首屏方案。我继续梳理发布时间线。

不能把模型输出里的裸 `@Name` 再解析成控制指令。真实触发源仍然是工具调用。

### 2.2 同一个 Agent“后台干活且还能说话”怎么成立

它指的是同一个持久 Bot 身份拥有两条执行车道，不是让同一个阻塞中的模型调用并发生成两段话：

```text
小蓝（Bot 身份）
  ├─ 当前或未来的普通 Task / Run：响应群消息
  └─ BackgroundAgentTask：替小蓝执行耗时调查
```

当前对话 Run 调用：

```ts
run_subagent({
  name: "性能基线",
  task: "运行最近三次构建的性能基线并定位 LCP 差异",
  background: true
})
```

后台任务注册成功后，当前 Run 可以正常回复并结束。后台任务继续运行；用户随后再 `@小蓝` 时，可以创建新的普通 Run，小蓝仍然能说话。

### 2.3 圆桌不是另一种聊天

- 完整聊天记录仍在当前群 Thread。
- Task/Run 仍是执行记录，不变成用户管理的新会话。
- Plan/Todo 仍属于具体 Run。
- “圆桌工作树”只是对现有 Run lineage 与 BackgroundAgentTask 的 UI 投影。
- 不增加 `RoomSession`、`RoomTurn`、`RoomWork` 表。

### 2.4 用户可以在 A 的单聊里要求 A 去别处行动

这里有两个不同目的地，不能混成一个概念：

1. **A → B**：目标是另一个持久 Agent。A 调用现有 `message_bot`。后端解析或创建 A ↔ B 唯一的长期固定 Thread，并在这个 Thread 中创建 B 的 support Run。A 当前所在的用户会话只写一条轻量 `bot_message_sent` 回执；点击后只读查看 A ↔ B 对话。它既不是 A 的用户单聊，也不是 B 的用户单聊。
2. **A → 群 G**：目标是一个共享 Thread，而且执行者仍然是 A。当前代码只有用户 composer 的群 mention reroute，没有 Agent 侧等价工具。这里新增 `message_group`，让 A 在群 G 中创建属于自己的 Run，并在 A 的单聊保留发送回显。

不能把 A→群伪装成 A→某个“群主持 Bot”。否则消息会错误地变成对某个 Bot 的私下委派，群权限、群上下文、可见性和工作归属都会错。

### 2.5 统一触发与接收机制

UI 中的 `@Name` 是人类可读的消息表现，不是统一的执行协议。真正产生工作的入口必须由触发者、目的地和所有权语义决定：

| 场景 | 谁触发 | 执行入口 / 工具 | 谁接收 | 持久化事实 | 用户看到什么 |
| --- | --- | --- | --- | --- | --- |
| 用户在群里 `@A` | 用户 | 现有 `sendThreadMessage` + mention router；不调用 Agent 工具 | A 的 conversational Run；已有 Run 时写 `SteeringMessage` | 当前群 Thread 的 Message、Task/Run、Event | 用户原消息；A 自己确认、追问或回应 |
| Agent 在群里公开给 A 派活 | 当前发言 Agent | `message_bot`，默认 public-group | 同群中 A 的 support Run | 当前群 Thread、collaboration lineage、delivery key | 发言中自然显示头像 + `@A`；A 以自己的身份应答 |
| Agent 私下给 B 派活 | A | `message_bot(visibility:"private")`；A 在用户单聊调用时默认 private | 固定 A ↔ B pair Thread 中 B 的 support Run | 唯一 pair Thread、独立 Task/Run、origin reference；来源 Thread 只写 receipt | 来源页只有“已发消息给 B”；点击打开只读的长期双 Agent 对话 |
| 用户让 A 去群 G 处理事情 | A 在自己的 Run 中响应用户 | `message_group` | 群 G 中 A 的独立 owner Task/Run；同 Bot、同 Thread 已有执行时排队 | 来源单聊 receipt、目标群 Message/Run、parent/origin reference | A 单聊显示发往群聊；群里出现 A 的真实消息；完成后 A 回来源单聊再汇报一次 |
| A 不在目标群 G | `message_group` 的权限检查 | scoped `Intervention`，批准后复用成员 mutation 并恢复原投递 | 用户在原可见 Thread 作决定 | Intervention、成员变更审计；批准前不写目标群消息 | “是否把 A 加入群？”；拒绝/过期不伪装为已送达 |
| Agent 判断自己要做长任务 | 当前 Agent | `run_subagent(background:true)` | `BackgroundAgentTask`；当前 Run 注册后继续 | task projection、progress/terminal Event、DeliveryRecord | Agent 仍可说话；群内只显示语义状态、当前动作和有意义的更新 |
| Agent 真正移交阶段所有权 | 当前 owner Agent | `handoff_to_bot` | 新 owner Agent | owner lineage / handoff event | 新负责人明确接管；不是普通并行委派 |
| 用户给已有 Task1 补充要求 | 用户 | 带服务端校验 `targetTaskId` 的现有发送协议；不调用模型工具 | Task1 的 active/queued/follow-up Run | 新 Message、task reference、`task.amended` Event；原 prompt 不覆盖 | 消息显示轻量 Task 引用；任务详情保留原要求与追加历史 |
| 用户停止某项工作 | 用户 | 现有 Task/Run/background cancel | 精确目标及其必要后代 | cancel/tombstone Event | 只停止所选工作，不扩大到同 Agent 的其他任务或整桌 |

接收方必须通过持久化 Message / Task / Run / Event 获得工作。前端不得因为看见 `@Name`、receipt 或状态胶囊就自行创建“已收到”“正在执行”等假状态。

## 3. 当前代码已经支持什么

| 场景 | 当前代码路径 | 是否直接复用 |
| --- | --- | --- |
| 用户发普通群消息 | `sendThreadMessage` + Group Router / lead | 是 |
| 用户单独 @ 一个成员 | `resolveExplicitTurnOwner` → `explicit_mention` | 是 |
| 用户回复某个 Agent 的消息 | `replyToMessageId` → `reply_target` | 是 |
| 用户 @everyone | `explicit_multi` | 是 |
| 用户要求 A/B 分别回答 | 多 mention + “分别/各自”等 → `explicit_multi` | 是 |
| 用户在 Agent 正在运行时追加指令 | `SteeringMessage` → 当前 Run 的 steering endpoint | 是 |
| 用户在非对话任务运行时发消息 | 先落消息，后续对话执行读取完整 Thread | 部分复用，见场景 S06 |
| Agent 把阶段所有权交给另一个成员 | `handoff_to_bot` | 是，但只用于真正移交 |
| Agent 私下请求另一个持久 Bot | `message_bot` + support lineage | 部分复用；当前错误落到 B 的用户单聊，需要改到固定 A ↔ B Thread |
| 用户在 A 单聊要求 A 给 B 派活 | `message_bot` + sender-side `bot_message_sent` | 发送回显已支持；目标 Thread 和回显形态需要调整 |
| 用户在 A 单聊要求 A 去某群行动 | 用户 composer 有 group reroute；Agent 工具侧没有 | 需要窄增量 `message_group` |
| 长后台工作 | `BackgroundAgentTask` + `DeliveryRecord` | 底层可复用；生产入口当前暂停 |
| 审批、向用户提问 | `Intervention` | 是 |
| 取消父任务及后代 | `parentRunId` lineage + descendant cancel | 是 |

## 4. 四项核心协议改造

### 4.1 `message_bot`：公开群委派与私下 Agent 对话

当前 `filterBuiltinToolsForThread` 在群里过滤了 `message_bot`，原因是旧实现会把消息发进目标 Bot 的用户单聊。圆桌模式不应新增 `delegate_work`，而应让 `message_bot` 根据当前 Thread 和显式可见性选择投递面：

- Agent 用户单聊中调用：私下投递到 A ↔ B 固定 Thread。
- 群聊中调用且省略 `visibility`：公开投递；目标必须是当前群成员，请求和结果都留在当前共享 Thread。
- 群聊中确实要私下通知：显式传 `visibility: "private"`，仍投递到 A ↔ B 固定 Thread。

工具 schema 基本不变：

```ts
message_bot({
  bot_id: "bot-blue",
  message: "请核对性能基线，列出前三个瓶颈、证据和回归风险。",
  intent: "request",
  visibility: "private" // 仅群内私下通知时显式提供；其他情况按来源 Thread 决定
})
```

这里不是新增一套“Agent 私聊产品”。存储层复用现有 `ChatGroup + Thread + ChatGroupMember`：

- 为 `ChatGroup` 增加可区分的 `kind=agent_pair` 与唯一 `pairKey`；`pairKey` 由同 workspace 内排序后的两个 bot id 计算，因此 A→B 与 B→A 命中同一个 Thread。
- `agent_pair` group 恰好有两个 Bot 成员，由服务端创建和维护，不进入侧边栏、群选择器、普通群搜索或成员管理页面。
- 用户只可从协作回执打开只读视图；`sendThreadMessage`、composer、reaction、审批按钮和成员 mutation 都必须拒绝这个 Thread 上的人类写入。
- 完整逐字记录仍写 PostgreSQL；该 Thread 自己持久化 AgentScope 工作上下文和压缩状态。它是长期对话，不等于把内容自动写入任一 Bot 的长期记忆。
- 创建 pair Thread 只建立通信范围，不授予文件、群、集成或工具凭据。消息引用的资源仍逐项走现有授权；B 无权访问时必须失败或把 scoped Intervention 投影回用户可见来源 Thread。
- Bot 被停用后，历史仍可只读查看；新投递明确失败。既有错误落到 B 用户单聊的历史消息不做危险搬迁，新规则只作用于新投递。

私下分支的事务行为：

1. 解析目标 Bot，按无序 bot pair 查找或创建唯一 agent-pair group / Thread。
2. 在 pair Thread 写入 A 的 outbound 与 B 的 inbound 事实，并创建 B 的 support Run；lineage、hop、去重和 outcome resumption 继续复用。
3. 在来源用户会话只写轻量 receipt：发送者、目标 Bot、pairThreadId、pairMessageId 和状态。不要复制完整委派正文或伪造“B 已收到”。
4. 点击 receipt 打开 A ↔ B 的长期完整记录；无输入框，用户不能介入。
5. 若 B 的执行需要用户审批或补充信息，不能在 pair Thread 里向用户提问；创建 scoped Intervention 并投影回原始用户可见 Thread。用户答复后，再恢复对应 pair Run。
6. B 的结果先回到 pair Thread；A 的 outcome resumption 读取最新用户 Thread 后，另发一条面向原始目标的汇报。receipt 只显示很轻的状态变化，不承担结果正文。

同一个 source Run 私下通知 A/B/C 时，后端仍是三个独立 pair Thread 和三个幂等调用；来源 UI 可以把相邻 receipt 合并成“已发消息给 3 个 Agent”。不能为此创建临时四人群。

群聊分支复用现有能力：

1. `resolveBotAddress` / 成员校验。
2. `bot_message_sent` / `bot_message_received` block。
3. `Task` / `Run` 创建。
4. `supportCollaboration({ fromBotId, parentRunId, ... })`。
5. hop、去重、ack loop 和幂等 delivery key。
6. target outcome 回到 requester 的既有 resumption 逻辑。

群聊分支只改变消息落点和 UI 投影：

```text
现状：sender group thread → target 的用户单聊 Thread
改造：sender group thread → target run in the same group thread
```

同一个 Agent 在群里给 A/B 公开派活时，可以连续调用两次 `message_bot`。前端把同一 source Run 的相邻协作 block 视觉合并成一条自然消息，不需要多目标新工具，也不需要事务性“大委派对象”。

### 4.2 后台复用 `run_subagent`

不新增 `start_background_work`。在现有 schema 上增加一个显式可选字段：

```ts
run_subagent({
  name: "性能基线",
  task: "……",
  background: true
})
```

- `background: false` 或省略：当前同步 helper 语义。
- `background: true`：创建 helper 的产品 Task、Run 和 Attempt，再注册 `BackgroundAgentTask` runtime 投影。工具立即把产品 `taskId` 返回给父 Run，父 Run 继续发言。

`BackgroundAgentTask.taskId` 当前是 AgentScope runtime task ID，不是产品 `Task.id`。实现必须把字段改成明确的 `runtimeTaskId`，并持久关联产品 Task、执行 Run、Attempt 和 consumed revision。不能依靠 `parentRunId` 推断，因为一个父 Run 可以启动多个 helper。

PostgreSQL 与 AgentScope 不能组成原子事务。后台启动必须使用持久 launch outbox、从 Run 和 Attempt 派生的幂等 launch key、AgentScope ack 和 reconciliation。进程在提交前后或 runtime 启动前后崩溃，都不能产生无法取消的孤儿任务或永远不启动的产品 Task。

沿用已有：

- `registerBackgroundTaskProjection`
- `subagent.started/progress/completed/failed/cancelled`
- `thread.subagent`
- `DeliveryRecord`
- 后台 task 取消和 tombstone
- 结果投递 Run

当前 Java Runtime 暂停了新 `run_subagent`。这不是另起炉灶的理由；应当完成既定执行边界修复后恢复这个入口，而不是再造一套后台任务系统。

### 4.3 新增窄工具 `message_group`

不把它塞进 `message_bot`。Bot 和 Group 的地址、权限以及目标 Run 语义不同；共用名字只会让实现分支和审计含义更混乱。

```ts
message_group({
  group_id: "group-release",
  // group_id 不可得且名字唯一时，允许 confirm_name
  confirm_name: "新版发布圆桌",
  message: "用户让我来核对发布风险。我先读取现有讨论，再补性能结论。",
  intent: "request"
})
```

`intent=request` 的最小行为：

1. 用现有 group repository 校验同 workspace、用户拥有访问权和 A 的成员资格。A 已在群中则继续；A 不在群中但当前用户有成员管理权时，创建“是否把 A 加入群”的审批；用户无管理权时直接说明阻塞。任何情况下都不静默加群，也不继承其他 Bot 的权限。
2. 在 A 当前单聊写入结构化发送回显，UI 显示“Joy → 新版发布圆桌”，并可跳到目标群消息。
3. 在目标群 Thread 写入 A 的可见消息。
4. 为 A 在目标群创建 owner Run；它读取目标群完整 Thread 后执行 `message` 中的任务。
5. 通过 `parentRunId` 关联来源单聊 Run；不新建跨会话任务表。
6. 完整过程和证据留在目标群；工作结束后通过 outcome resumption 唤醒来源单聊中的 A，由 A 单独向用户汇报一条面向原始目标的总结，并附目标群完整讨论入口。它不是机械复制群消息。

如果用户批准把 A 加入群，后台必须在执行前重新校验用户仍有成员管理权、群和 Bot 仍有效，然后原子完成“加成员 → 投递消息 → 创建 Task/Run”。审批拒绝或过期时不产生群消息。

跨会话请求总是在目标群创建独立 Task 和 Run。服务不能因为 A 在目标群已有 active conversational Run，就把一个新任务写进无关 Run。同 Bot、同 Thread 已有 active AgentScope chat session 时，新 Run 保持 queued，直到 session admission 可用。每次 Runtime 调用前必须持久化 Run/Attempt/fence/suspension identity；正在等待审批或用户输入的 Run 必须把 native pending state 从共享 chat state 安全脱离并持久化恢复点，取得 Runtime `clean | detached` 证明后才可释放 chat session。决定或答案带匹配 request identity 到达后重新排队。补充既有 Task 使用独立的 Task amendment 入口，不通过 `message_group` 猜测或复用 Run。

实现复用：

- `resolveComposerSendPlan` 已有的 group 地址和 reroute 语义；
- `getGroupTarget`、群成员与资源权限检查；
- `createThreadMessageInTransaction`、Task/Run、Event 与 job enqueue；
- `message_bot` 已有的 sender echo、delivery key、事务锁、去重和结果恢复模式；
- 前端 `CollaborationMarker`，增加 GroupAvatar 版本，不另造一套消息组件。

### 4.4 既有 Task 的结构化引用与追加指令

用户给 Task1 补充要求时，不增加 `update_task_prompt` 工具，也不让模型从自然语言里猜任务。触发者是用户，发送请求携带服务端可验证的 `taskId`：

```ts
sendThreadMessage({
  threadId,
  content: "再按地区拆开，并标出样本量不足的区域。",
  targetTaskId: "task_01H...",
  clientNonce
})
```

后端在同一事务里：

1. 校验 Task 属于当前用户可访问的 Thread，且不能仅凭前端传入 id 跨 Thread 修改；
2. 写入普通用户 Message，并保存 task reference；
3. 追加 `task.amended` Event，包含 `taskId/messageId/revision/sourceSeq`；
4. 按 Task 当前状态决定进入已有 Run、排队输入、重启 attempt 或创建 follow-up Run。

`Task.prompt` 是原始要求的历史快照，不做原地覆盖。执行器读取的是按服务端 seq 折叠后的 instruction envelope。这个 envelope 是输入组装逻辑，不是新表、新会话或新的用户可管理对象。

## 5. 用户在讨论中随时发新指令

### 总原则

每一条用户消息都是新的权威输入。讨论中的 Agent 请求、队列和后台任务都不能阻止用户说话。

处理顺序继续使用现有路由：

```text
显式 @成员
  > 回复某个 Agent 的消息
  > Group Router
  > lead
```

用户新消息只送给它实际路由到的 Agent；不是默认广播给所有运行中的 Agent。完整 Thread 对所有后续 Run 可见，后台任务是否需要被 steer，则按任务关联性处理。

显式 `@A` 只有在 A 恰好有一个可接收 steering 的 conversational Run 时才进入该 Run。A 有多个 active 或 queued Task 时，服务不能从无序查询中任选一个。消息带 `targetTaskId` 时进入该 Task；没有 `targetTaskId` 时创建独立 Task/Run，并在 A 的 AgentScope session 后排队。用户可以随后从 Task chip 或工作页把补充定向到具体任务。

## 6. 用户指令场景

### S01 讨论中，用户单独 @ 一个空闲 Agent

**用户消息**：

> @小紫 你先别参与视觉讨论，单独检查上线清单有没有遗漏。

**触发者**：用户。

**复用代码**：

- composer 产生 typed mention chip；
- `resolveExplicitTurnOwner` 返回小紫；
- 创建普通 `Task / Run(trigger=user)`；
- `Run.orchestration` 记录 `explicit_mention`。

**结果**：小紫立即收到新的用户 Run。其他 Agent 的发言和后台任务不取消。

### S02 用户 @ 的 Agent 正在回复

**用户消息**：

> @小蓝 先补测低端机，桌面端可以晚一点。

**当前状态**：小蓝恰好有一个 active conversational Run。

**复用代码**：创建 `SteeringMessage(messageId, botId=小蓝, runId=当前Run)`；AgentScope 的 steering endpoint 把新消息送入当前 Run。

**Agent 行为**：

- 如果这是对当前任务的纠正或补充，直接调整当前计划。
- 如果它是独立长工作，调用 `run_subagent(background:true)`，然后继续当前回复。

**不能做的事**：取消整桌、取消其他 Agent、重新创建“圆桌轮次”。

### S03 用户 @ 的 Agent 正在后台工作，但当前没有对话 Run

**用户消息**：

> @小蓝 你先说一下目前最可能的原因，不用等完整报告。

**当前状态**：小蓝只有 `BackgroundAgentTask`，没有 active conversational Run。

**处理**：按现有发送路径创建一个新的普通 Task/Run。后台任务继续，不被占用。

**结果**：小蓝可以回答：

> 目前最可疑的是主图和同步图表包，但 trace 还在后台跑，所以我只把它当假设。

这正是“后台干活但仍能说话”的主要产品场景。

### S04 用户 @ 的 Agent 正在执行别的 Agent 派来的 support Run

**用户消息**：

> @小橙 先把移动端 B 版单独做出来，完成后直接发群里。

**当前状态**：小橙恰好有一个可接收 steering 的 support Run，正在处理 Joy 通过 `message_bot` 派来的任务。

**处理**：复用 SteeringMessage，把用户消息送进小橙当前 support Run。用户指令的权威级别高于 Bot 请求。

**小橙可以**：

1. 调整当前工作，直接优先完成用户新要求；或
2. 为新要求调用 `run_subagent(background:true)`，原 support Run继续；或
3. 如果两件事冲突，公开说明冲突并询问用户。

不需要为此创建第二种 Run 类型。

### S05 用户没有 @，只是补充约束

**用户消息**：

> 另外，移动端首屏不要放视频。

**路由**：仍由当前 Group Router / lead 选择一个响应 owner；如果该 owner 有 active conversational Run，则写 SteeringMessage。

**共享效果**：消息已经在同一个 Thread，后续所有 Agent Run都能看到。主持 Agent负责判断哪些已派工作受影响；需要通知执行者时，调用 `message_bot(intent=status|request)`。

不把普通补充机械广播给所有后台任务，也不机械取消已有任务。

### S06 用户发出与当前讨论无关的新任务

**用户消息**：

> @小紫 另外帮我查一下明天客户会议的资料。

如果目标没有对话 Run，直接创建新 Run。如果目标已有对话 Run，消息先通过 SteeringMessage 到达它；Agent 判断独立后将工作放到后台。

这里有一个真实的现有实现限制：同一 Bot 的 active conversational Run 会吸收用户 steering，而不是立即并排创建第二个前台 Run。这不是丢指令；但如果产品未来要求同一 Bot 同时维护多个独立前台对话上下文，才需要引入更强的 per-Bot mailbox。圆桌一期不需要先造这个抽象。

### S07 用户回复某个 Agent 的消息

**用户行为**：点击小橙消息的“回复”并提出修改。

**复用**：`replyToMessageId` / verified quote / `reply_target`。如果同时明确 @ 另一个 Agent，仍按现有优先级由显式 mention 胜出。

### S08 用户同时 @ 多个 Agent

当前规则：

- `@everyone`：所有成员各自响应。
- `@A @B 分别……`、`各自……`：A/B 各自创建 Run。
- 只写 `@A @B` 而没有分别回答语义：当前只选择第一个响应 owner。

这条规则可以继续使用，但需要补一类自然表达测试：

> @A 做性能，@B 做视觉。

它显然是两个独立指令，即使没有“分别”两个字。这里应扩展现有 `requestsSeparateAnswers` 的判定或利用 mention span 后的命令分段，而不是引入新的群聊路由器。

### S09 用户停止一个任务

用户从后台任务胶囊或工作树点停止：复用后台 task cancel；如果停止的是一个 Run，复用现有 Run cancel 和 descendants cancel。

停止小蓝的某个后台 task，不代表禁止小蓝继续在群里说话。

### S10 用户停止整个讨论

“停止全部”是显式 UI 操作：取消当前群里可归因于本次用户根 Run 的活动后代和后台任务。父子关系从 `Run.orchestration.collaboration.parentRunId` 与 `BackgroundAgentTask.parentRunId` 推导。

不用新建 session id。若多个独立用户根 Run 同时活跃，UI 应先列出将被停止的根任务；不能凭“最近十分钟”猜范围。

### S11 用户隔了几轮给已有 Task1 补充要求

**场景**：用户先把 Task1 交给 A。群里又发生了几轮其他讨论后，用户补充：

> Task1 再补一条：不要只看均值，要按地区拆开，并标出样本量不足的区域。

这里不能把“消息发给 A”当作“Task1 已被更新”。A 此刻可能正在回答另一件事，也可能同时拥有多个前台 Run 和后台任务。权威目标必须是 `taskId`，Agent 只是这个 Task 的当前负责人。

**用户如何精确指向 Task1**：

- 回复 Task1 的原始指令或执行回执；
- 从工作树点开 Task1 后选择“补充要求”；
- 在输入框插入系统生成的 Task1 引用 chip。

纯自然语言“刚才那个任务”“Task1”只有在当前 Thread 内唯一命中时才可自动解析；存在多个候选时必须让用户选择，不能按最近消息或当前发言 Agent 猜。

**持久化方式**：继续使用现有 Message、Event、Task 和 Run，不新增“任务修订会话”或 `TaskAmendment` 表。

1. 用户补充先作为普通 Message 写入原 Thread，并携带服务端校验过的 `taskId` 引用。
2. 追加 `task.amended` Event，记录 `taskId`、`messageId`、递增 revision 和来源 seq；`Task.prompt` 保持原样，不能覆盖历史指令。
3. 执行时的有效输入是“原始 prompt + 按 seq 排序的补充消息”。冲突要求必须显式暴露，不能只取最后一条覆盖前文。
4. UI 在用户消息上方只显示一行轻量上下文：`补充到 · Task1 · 三次发布 LCP 对比`；A 的确认必须说明这次补充如何影响当前执行。

**按 Task1 当前状态处理**：

| Task1 状态 | 行为 |
| --- | --- |
| active conversational Run | 写 `SteeringMessage(runId=Task1 当前 Run)`，直接进入该 Run；不能投给 A 的另一个 active Run |
| queued、尚未租约 | 不另建 Run；Worker 获取租约时组装原始要求和全部补充 |
| `BackgroundAgentTask` 正在运行 | 先持久化补充，再唤醒负责人 A 判断：若只影响汇总口径，让后台继续并在交付时合并；若会使正在计算的输入失效，取消旧 attempt 并在同一 Task 下重启。现有后台执行器没有动态 steering 入口，不能伪装为已经注入 |
| 等待审批或用户输入 | 补充若改变受控参数、资源或目标，旧审批失效并重新申请；无关补充不扩大暂停范围 |
| 已完成 | 保留旧结果，在同一 Task 下创建 follow-up Run；UI 显示“追加复核”，不把旧结果改写成未完成 |
| 已失败或已取消 | 保存补充但不静默复活；由用户明确选择“按补充重试/重新开始” |

这仍然不是新会话：Task1 可以有多次 Run，完整历史仍属于原 Thread，工作树只把补充和新 attempt 投影到同一节点。

## 7. Agent 协作场景

### S12 主持 Agent 给 A/B 并行派活

Joy 连续调用：

```ts
message_bot({
  bot_id: "bot-blue",
  intent: "request",
  message: "核对性能基线和回归风险，返回前三个瓶颈及证据。"
})

message_bot({
  bot_id: "bot-orange",
  intent: "request",
  message: "给出两版首屏方案，标注移动端处理和实现成本。"
})
```

系统在群里投影为自然的一组消息：

> Joy：我先拆成两路。@小蓝 核对性能基线和回归风险；@小橙 出两版首屏方案。我继续梳理发布时间线。

两个 target Run 拥有相同 parentRunId，各自是 support role。执行可以并行；群消息按 Thread seq 提交。

### S13 接收 Agent 确认并把长活放后台

小蓝收到 `bot_message_received` 对应的 support Run 后：

1. 调用 `run_subagent(background:true)`；
2. 正常向群里回复“收到，我放后台跑，有结果回来”；
3. support Run结束；
4. BackgroundAgentTask 继续。

确认消息来自小蓝真实的模型 Run，不由前端伪造。

### S14 干活 Agent 再找第三个 Agent

小蓝在 support Run 或后续结果 Run中调用群内 `message_bot` 给小紫。现有 collaboration lineage 已有 parentRunId、role、messageHop，可以形成：

```text
Joy owner Run
  ├─ 小蓝 support Run
  │    ├─ 小蓝 BackgroundAgentTask
  │    └─ 小紫 support Run
  └─ 小橙 support Run
       └─ 小橙 BackgroundAgentTask
```

工作树直接从这些记录投影，不新建 Work 表。

### S15 Agent 只是提到另一个成员，但没有派活

例如“小蓝刚才的结论值得参考”，只是普通文本。

若要对方回答或工作，必须调用 `message_bot`。UI 可以显示普通 mention，但只有带 target run 的协作 block 才显示“已派给 / 已接收 / 后台中”。

### S16 真正移交下一阶段

只有“从现在开始由小蓝全权负责上线执行”才用现有 `handoff_to_bot`。征求观点、并行调查、复核、子任务都使用 `message_bot`。

## 8. 后台任务、审批和结果回流

### 8.1 后台任务期间继续聊天

后台任务不是 active conversational Run。产品 Task、Run 和 Attempt 负责产品身份与修订，`BackgroundAgentTask` 负责 AgentScope runtime 投影；新的用户 @ 可以继续创建普通 Run。

如果后台任务需要使用同一台电脑，工具租约可以排队，但这只影响工具，不影响 Agent 基于群上下文回复消息。

### 8.2 审批

后台 helper 保持只读。它需要受控动作或用户输入时返回结构化阻塞结果：动作请求创建一次性 Intervention，输入请求创建带问题与答案约束的 InputRequest，不能用假工具调用代替提问。用户在来源 Thread 作出的决定或答案持久化后，由隔离的 continuation Run 消费：

- 只暂停与该 helper Task 关联的执行路径。
- 同一 Agent 仍可以通过另一个普通 Run发言。
- 其他 Agent 不受影响。
- Runtime 调用前先持久化 execution fence；等待期间把 pending state 按 Run/Attempt 从共享 AgentScope chat state 脱离，取得 `clean | detached` 证明后再释放 session；恢复时只消费身份匹配的决定或答案，并重新排队或进入隔离的后台 continuation scope。
- 审批通过后读取期间新增消息，再决定结果是否仍相关。

### 8.3 结果回流

后台完成继续走 `DeliveryRecord`。terminal callback 先对当前 Attempt、runtime task identity 和 consumed revision 做 compare-and-set。被新 Attempt 替代的迟到 callback 只写审计。DeliveryRecord 持久化 Task、Run、Attempt、runtime task 和 revision identity；同一个 delivery 批次必须具有相同的 Thread、执行 Bot、origin lineage 和完整 execution identity：

1. terminal event 持久化；
2. 创建 delivery Run；
3. delivery Run读取最新 Thread；
4. 以执行 Agent 身份发一条新的结果消息；
5. 如需原 requester 综合，复用现有 bot outcome resumption。

不修改旧确认消息来塞入结果。旧消息只显示状态引用。

## 9. UI 需求

### 9.1 消息流

- 群消息中的 Agent mention 在发送后显示为“头像 + 名字”的内联链接。点击只导航到当前用户与该 Bot 的长期单聊，并保留返回来源群的路径；不能打开 Agent-pair Thread，也不能触发消息、Task 或 Run。
- Bot 停用、删除、跨 workspace 或用户无访问权时，mention 保留可读身份但不提供可用跳转；后端仍需在打开目标单聊时重新鉴权，不能只依赖前端链接状态。

- 用户任何时候都能发消息，不因 Agent 正在讨论而锁输入框。
- 用户 typed mention 使用当前 composer mention chip。
- Agent 在群里公开调用 `message_bot`，展示为自然的 `@Name` 文本。
- Agent 私下调用 `message_bot`，来源会话只显示一行独立轻回执，例如“已发消息给 小蓝”；它位于正常消息之间，不嵌进 Agent 回复气泡，也不承载委派正文、运行详情或整张目的地卡。
- 单目标 receipt 点击后直接打开两个 Agent 的长期固定对话；聚合 receipt 点击后在原行下方展开 Agent 下拉列表，选择目标后再打开对应 pair。双 Agent 对话可滚动、可看历史、不可输入，不出现在用户会话列表。
- Agent 收到任务后的确认、追问、拒绝、结果都是正常新消息。
- 消息状态不承担后台事实；后台事实来自 Run / BackgroundAgentTask 投影。

### 9.2 同一 Agent 的组合状态

不要把成员压成 `idle / speaking / working` 三选一。

```text
小蓝
  正在回复你的新问题
  后台任务 1 · 性能基线 · 02:14
```

### 9.3 群聊右栏与工作视图

进行中的工作放在群聊既有右侧详情面板的“工作”页签，不另造永久任务侧栏。该面板的信息架构固定为 `详情 / 工作 / 资料库 / 成员`：

- 聊天区顶部居中显示“成员头像簇 + 群名”的群聊胶囊。头像簇同时包含当前用户和群内 Agent，并使用各自真实头像；点击胶囊展开右栏并默认进入“详情”，再次点击收起。
- 右栏顶部复用同一组成员头像簇。群名是无边框文本栏：单击编辑，失焦或 `Enter` 保存，`Esc` 放弃本次修改。
- “工作”页签和顶部“工作”入口都不显示数量。Task、Agent、Run 与后台任务不存在一个不会误导用户的共同计数口径；具体状态进入工作页查看。
- “详情”继续承载群信息和例行任务；例行任务和成员页的新增入口使用无框的 `＋ 文本`，成员为无边框纵向名单。
- “资料库”按日期分组，文件列表不套外部描边卡片；每行只显示缩略图、文件名、更新时间和悬停更多操作。
- “成员”只管理 Agent；当前用户虽出现在群头像簇中，不混入“Agent 数量”。本期不存在多真人成员模型。
- 点击一个工作节点，在“工作”页签内原位进入 Task 详情；返回后恢复该群工作列表，不叠加第二个抽屉或模态框。
- 侧边栏全局任务中心展示跨会话工作；群内“工作”只按当前群过滤。两处复用同一 Task/Run/BackgroundAgentTask 投影和状态语义，不创建新的任务实体。
- 普通用户默认只看负责人、当前动作、语义状态、需要介入的动作和结果；只有确有子委派时才显示一层必要关系，不默认展开 Run、attempt 或工具流水。

工作视图的数据来源：

- 根：用户触发的 owner Run。
- Agent 分支：`Run.orchestration.collaboration.parentRunId`。
- Agent 自己的后台分支：`BackgroundAgentTask.parentRunId`。
- 重试：同一 Task 或 retry lineage 显示成一个节点的 attempts。
- 审批：Intervention 挂到对应 Run / task。

工作视图是执行投影，不是第二套任务数据库。

进度采用语义状态，不把开放式 Agent 工作伪装成线性百分比：

- 工作树节点只显示负责人、状态、当前动作和最近一次有意义的更新。
- Task 详情使用“当前动作 + 阶段节点 + 最近进展”；阶段不等长，不换算百分比。
- 只有输入总量客观可知的批处理才显示真实计数，例如“已核对 3/5 份报告”。
- 需要用户介入时，状态立即变为“需要你确认”并给出动作，不与“进行中”或加载动画同时出现。
- Run id、attempt、工具流水、token、内部事件和无依据的预计完成时间不进入普通用户界面。

### 9.4 用户插话的可见反馈

- `@小蓝` 命中正在回复的小蓝：活动胶囊短暂显示“已把你的新要求交给小蓝”。
- 命中只有后台 task 的小蓝：出现新的“小蓝正在回复”，原“后台做性能基线”胶囊继续存在。
- 命中其他 Agent：该 Agent 加入回复队列，不取消当前说话者。
- 新指令与旧工作冲突：由接收 Agent明确说明，不由 UI 默默覆盖。

## 10. 基于现有代码的改动清单

### 必改

1. `filterBuiltinToolsForThread`
   - 群聊不再过滤 `message_bot`。

2. `messageBot`
   - 根据 `source.thread.groupId` 与可选 `visibility` 选择 public-group 或 private-pair 分支。
   - public-group：目标限定为当前群成员；outbound/inbound 共享同一群 Thread，不进入目标用户单聊。
   - private-pair：按无序 Bot pair 解析或创建唯一 `agent_pair` ChatGroup / Thread；support Run 与完整记录均落在该 Thread。
   - 复用现有 support lineage、hop、去重、结果返回。

3. `run_subagent` schema 与 Runtime
   - 增加 `background?: boolean`。
   - 修复并恢复当前暂停的生产委派入口。
   - 后台模式复用现有 BackgroundAgentTask 注册和结果投递。
   - 每个 helper 创建独立的产品 Task、Run 和 Attempt；`BackgroundAgentTask.taskId` 改为明确的 runtime task identity，并持久关联执行 Run、Attempt 和 consumed revision。

4. 群消息 UI
   - `bot_message_sent` 在群里渲染为自然 @ 协作消息。
   - 私下发送只渲染轻量 receipt；点击用只读层打开 pair Thread，用户不能从该层发消息。
   - Run lineage + BackgroundAgentTask 投影为工作树和胶囊。
   - 同一 Bot 可同时展示 speaking 与 background work。

5. 多 mention 判定
   - 为“@A 做 X，@B 做 Y”补定向测试并扩展当前纯关键词规则。

6. `message_group` 薄包装
   - 复用 group target 解析、权限检查和 Thread send transaction。
   - 为每个跨会话新任务在目标群创建独立 Task 和 Run。只有请求显式携带目标群 `targetTaskId` 时才转入 Task 补充路径。
   - Bot 不在群中时，复用 Intervention 请求“加入群”批准；批准后调用现有群成员 mutation，再恢复原始投递。
   - 来源单聊显示结构化“发往群聊”回显；完成后显示状态和跳转。
   - 增加 `group_message_sent` MessageBlock，或把 `CollaborationMarker` 抽成可区分 Bot/Group target 的统一 destination receipt；不能拿 `toBotId` 冒充 group id。

7. 固定 Agent-pair Thread
   - `ChatGroup` 增加 `kind=agent_pair` 与唯一 `pairKey`，仍复用现有成员、Thread、Message、Task/Run、事件和压缩能力，不新增会话表。
   - 所有普通群列表与查询在服务端排除 `agent_pair`；仅 receipt 引用可打开。
   - Thread 写入入口拒绝用户身份向 `agent_pair` 发消息；前端同时移除 composer，但不能只靠前端隐藏保证边界。
   - `bot_message_sent` 增加 `pairThreadId` / `pairMessageId`（或等价 destination ref），以便来源回执稳定打开正确位置。

8. 已有 Task 的补充
   - 发送协议允许携带经服务端校验的 `targetTaskId`；回复原指令、工作树和 task chip 最终都归一成该字段。
   - 在 Message/Event 中追加 amendment 引用，保留原始 `Task.prompt`；不新增 TaskAmendment 表。
   - active conversational Run 继续复用 SteeringMessage，但必须校验它属于目标 Task；queued Run 在 lease 时组装补充；completed Task 在同一 Task 下创建 follow-up Run。
   - 迁移所有会覆盖 `Task.prompt` 的既有输入恢复路径，以及所有直接读取 `Task.prompt` 的执行和重试路径。
   - 后台 attempt 没有真实 steering 能力时，由负责人 Run 决定继续合并或取消重启，不显示虚假的“已实时更新后台执行”。

### 不新增

- 不新增 Round / RoomSession 表。
- 不新增 RoomTurn / speaker queue 表。
- 不新增 Work 表。
- 不新增 `delegate_work`、`invite_agent`、`start_background_work`、`complete_work` 工具。
- 不新增独立 AgentChat / AgentConversation 表；固定双 Agent 对话复用 `ChatGroup + Thread`。
- 不新增 TaskAmendment 表或“任务修订会话”；补充复用 Message + Event + Task/Run。
- 不重做用户消息路由。
- 不重做 Plan/Todo、审批、取消、重试、事件流或结果投递。

## 11. 验收标准

1. Agent 在群里调用 `message_bot` 后，目标成员获得同一群 Thread 的 support Run，私聊不产生新消息。
2. 同一 source Run 连续给 A/B 调用 `message_bot`，UI 合并成自然的一组 @ 委派，但后端仍是两个可独立重放的调用。
3. A/B 确认消息来自各自真实 Run。
4. A/B 可调用 `run_subagent(background:true)`；父 Run结束后后台任务继续。
5. 小蓝只有后台任务时，用户新发 `@小蓝` 能立即创建新的普通 Run；后台任务不中断。
6. 小蓝正在回复时，用户新发 `@小蓝` 复用 SteeringMessage 进入当前 Run。
7. 用户 `@小橙` 不取消 Joy、小蓝或小紫的 Run 与后台任务。
8. 用户普通补充由现有 router/lead 接住；需要影响其他任务时由 Agent用 `message_bot` 通知。
9. `@A 做 X，@B 做 Y` 能稳定路由为两个目标，不要求用户额外写“分别”。
10. 后台 helper 保持只读。需要受控动作时创建一次性 Intervention，需要用户信息时创建可回答的 InputRequest；Runtime 调用前已有可恢复 execution identity，等待路径的 pending state 按 Run/Attempt 隔离且取得安全脱离证明后不再占 chat session。同一 Agent 仍能通过新 Run 说话，新 prompt 不能误答或批准旧请求。
11. 工作树完全由 Run lineage、BackgroundAgentTask、Intervention 和 Event 重建，不依赖内存队列。
12. 重试或工具重放不重复发送 Agent 请求、不重复启动后台任务、不重复发布结果。
13. 用户在 Joy 单聊要求“去新版发布圆桌处理性能风险”后，Joy 的单聊立即出现发往群聊的结构化回显，目标群出现 Joy 的真实消息和 Run。
14. Joy 不是目标群成员但用户有成员管理权时，`message_group` 创建“把 Joy 加入目标群？”审批；批准后原子加群并继续原请求，拒绝或过期时不产生群消息。用户没有成员管理权时直接失败，不展示假审批。
15. 跨会话新请求在目标群创建独立 Task 和 owner Run，不进入 Joy 的其他 active Run；只有显式携带目标群 `targetTaskId` 的补充才 steering 该 Task 当前 Run。
16. 用户在 Joy 单聊要求“给小蓝安排性能回归”时，继续使用现有 `message_bot`；Joy 单聊只显示轻量 `bot_message_sent` 回执，support Run 落在 Joy ↔ 小蓝 pair Thread。
17. 私下 A→B 不再污染 B 的用户单聊；support Run 和完整往来落在唯一 Joy ↔ 小蓝 pair Thread，Joy 单聊只显示可点击的轻回执。
18. 同一对 Agent 无论谁先发起、跨多少次任务都复用同一 pair Thread；它不出现在侧边栏，用户可读但所有人类写入 API 都被拒绝。
19. 私下通知多个 Agent 时，来源 UI 可合并为一条轻回执，但每个目标仍对应独立 pair Thread 与独立 Run；不能创建临时多人 Agent 对话。
20. pair Run 需要用户审批或补充信息时，Intervention 回到原始用户可见 Thread；用户不能在 pair 对话层直接回复。
21. 跨会话工作完成后，完整过程保留在实际执行 Thread；来源单聊恢复 A 的 owner 身份，由 A 再向用户汇报一次针对原始请求的结论，并提供目标 Thread 跳转。
22. A→B 与 B→A、以及双方并发首次联系，只能得到一个由无序 `pairKey` 标识的固定 Thread。
23. 同一 pair 同时承接多个来源任务时，每个结果、审批、取消和重试都按持久化 origin reference 回到正确来源，不使用最近会话推断。
24. 聚合 receipt 点击后在原行下方展开 Agent 下拉列表；选择具体 pair 后再打开双 Agent 对话，任何一个选择都不能暴露第三个 Agent 的消息。
25. Bot 改名或更换头像不切断 pair；停用或软删除后历史仍可查看、新投递失败；新建替代 Bot 不继承旧 pair。
26. 用户从原消息、工作树或 task chip 给 Task1 补充要求时，补充消息持久化并携带唯一 `taskId`；不能按当前发言 Agent 或最近消息猜任务。
27. Task1 有 active conversational Run 时，SteeringMessage 必须绑定该 Task 的 Run；同一 Agent 的其他 Run 和后台任务不接收这条补充。
28. Task1 排队未开始时不产生竞争 Run；Worker 获取租约后能读取原始 prompt 和按 seq 排序的全部补充。
29. Task1 在后台运行时，输出口径类补充可由负责人在 delivery 时合并；改变输入的补充会取消旧 attempt 并重启，迟到结果不会覆盖新 revision。
30. Task1 已完成时，旧结果仍保持完成和可审计；补充在同一 Task 下创建 follow-up Run，UI 显示“追加复核”。
31. “刚才那个任务”等指代命中多个候选时不修改任何执行；用户选择后才写 amendment。并发重复补充按幂等键去重、按服务端 seq 排序。
32. 群聊顶部胶囊和右栏头部显示同一组“用户 + Agent”真实头像；点击顶部胶囊可以展开与收起同一个右栏。
33. 右栏群名可以单击编辑，失焦或 `Enter` 后同步更新群聊胶囊、会话名称和输入框目的地；`Esc` 不保存本次输入。
34. “工作”页签和顶部“工作”入口不显示数量；工作页内也不把开放式 Agent 工作伪装成百分比进度。
35. 例行任务与成员页的新增入口是无框 `＋ 文本`；成员名单没有行卡片或分隔边框，且 Agent 数量不包含当前用户。
36. 资料库按日期和留白分组，文件列表没有整组外框；每个文件行仍具有独立点击、键盘焦点和悬停反馈。
37. 单 Agent receipt 点击直接打开一整个只读浮窗；浮窗顶部用一个身份胶囊同时呈现 A、双向关系与 B，用户没有输入框。
38. 多 Agent receipt 只展开头像与 Agent 名称组成的紧凑选择列表；选择后打开相应固定 pair，不展示任务正文或第三个 Agent 的内容。
39. 群消息中的 Agent mention 是“头像 + 名字”的可访问链接，点击进入用户与该 Agent 的长期单聊；链接本身不触发工具、不创建 Run。

## 12. 代码依据

- `apps/api/src/thread-target.ts:1231-1428`：当前群消息写入、owner 路由、SteeringMessage、Task/Run 创建和 routed event。
- `packages/core/src/product-harness/response-owner.ts:77-117`：mention、reply、multi-response 的现有确定性规则。
- `packages/db/prisma/schema.prisma:533`：Message；`:607`：Run；`:791`：BackgroundAgentTask；`:843`：SteeringMessage；`:967`：Intervention。
- `packages/db/prisma/schema.prisma` 中 Task 与 Run 的一对多关系允许同一 Task 保留原结果并追加 follow-up Run；当前没有 Task amendment 记录，也没有 BackgroundAgentTask steering 字段，这是本场景必须补窄协议而不能假装直接复用的依据。
- `packages/core/src/product-harness/collaboration.ts:1-108`：现有 owner/support、parentRunId、handoffDepth、messageHop。
- `packages/adapters/src/bot-messages.ts:74`：现有 `message_bot` 目标解析、投递、support Run 与结果回流。
- `packages/adapters/src/bot-messages.ts:210-340`：A→B 时已经在 A 的 Thread 原子写入 `bot_message_sent`，但当前会在 B 的用户 Thread 创建 inbound 消息与 support Run；这是需要改成 pair Thread 的现状依据，不是目标设计。
- `packages/db/prisma/schema.prisma` 的 `ChatGroup`、`ChatGroupMember` 与 `Thread`：可承载隐藏的固定 Bot pair，而无需另建会话表。
- `packages/adapters/src/schedule-tools.ts:24`：当前群聊过滤 `message_bot` 的位置。
- `packages/core/src/composer-mentions.ts:230-276`：用户 composer 已支持选择另一个群、剥离群 mention 并把剩余文本改投目标群；`message_group` 应复用这套目标语义。
- `apps/web/src/components/ai/CollaborationMarker.tsx`：现有 A→B 发送回显组件，可扩展 GroupAvatar 目的地版本。
- `packages/adapters/src/executor.ts:5430-5702`：BackgroundAgentTask 注册、进度、完成和 DeliveryRecord。
- `services/agent-runtime/src/main/java/com/workpal/runtime/RuntimeEngine.java:129-145,370-405`：当前生产 `run_subagent` 暂停边界的声明与执行约束。
- `packages/db/src/background-task-registration.ts`：当前只用 runtime task ID 和 `parentRunId` 注册后台投影，没有产品 Task、执行 Run、Attempt 或 revision 关系。
- `packages/db/src/delivery-records.ts` 与 `packages/adapters/src/result-delivery.ts`：当前 delivery 主要按 Thread 和时间窗合并，且用首条记录的 Bot 创建 delivery Run。多 Bot 群 Thread 上线前必须扩展 batch identity。
- `packages/db/src/events.ts` 的 `commitAnswerRunInput`：当前追问回答会覆盖 `Task.prompt`。instruction envelope 上线前必须迁移该写路径和所有直接读取者。

因此，圆桌模式的正确增量不是再建一层编排系统，而是让已有协作原语在共享群 Thread 中闭环，并让已有后台执行真正从对话 Run 中脱离。

## 13. 完整场景矩阵：96 个原子验收场景

### 13.1 完整性的边界

这份矩阵穷举的是产品状态机的**独立语义和状态转换**，不是所有排列组合。每一项都必须能够回答：谁触发、路由到谁、落成什么现有记录、其他工作是否继续、用户看到什么，以及失败时如何恢复。

- 12 个场景族，每族 8 项，共 96 项。
- 每项至少对应一个后端验收测试；有关键视觉差异的项再进入原型。
- 两项以上的组合，例如“Agent 离线 + 审批超时 + 用户同时改指令”，属于 pairwise/chaos 测试，不另算一种产品机制。
- 标记“增量”的项目只允许扩展已有路径，不引入新的 Room/Turn/Work 实体。

### U. 用户介入与指令权威（U01–U08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| U01 | 用户发普通消息，无 `@`、无回复 | Group Router / lead 选择唯一 owner；消息先持久化 | 复用群消息路由 |
| U02 | 用户 `@` 一个空闲 Agent | 为目标创建 `Task/Run(trigger=user)`；其他工作不取消 | 复用 explicit mention |
| U03 | 用户 `@` 一个恰好只有一个可接收 steering 的 conversational Run 的 Agent | 写入 `SteeringMessage`；若有多个候选且没有 `targetTaskId`，创建独立 queued Task/Run，不任选一个 | 复用 steering，增量：候选消歧 |
| U04 | 用户 `@` 一个只有后台任务的 Agent | 新建普通 Run；原 `BackgroundAgentTask` 继续 | 复用双车道 |
| U05 | 用户回复某个 Agent 的消息 | `reply_target` 命中原作者；显式 `@` 仍优先 | 复用 reply route |
| U06 | 用户一句话写“`@A 做 X，@B 做 Y`” | 按 mention 后命令分段，创建两个独立目标 Run | 增量：扩展 multi mention 判定 |
| U07 | 用户 `@everyone` 或明确要求各自回答 | 每个可用成员获得独立 Run；响应可并行 | 复用 `explicit_multi` |
| U08 | 用户修改、暂停、恢复或取消具体工作 | 精确命中对应 Run/task；不扩大到同 Agent 或整桌 | 复用 cancel/resume，补 UI 定位 |

### A. 已有任务的补充与修订（A01–A08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| A01 | 用户通过回复、工作树或 task chip 给 active Task1 补充要求 | 追加 Message/Event，并把 SteeringMessage 精确绑定 Task1 当前 Run；不命中 A 的其他 Run | 复用 steering，增量：task reference |
| A02 | Task1 已排队但尚未获得执行租约 | 不另建竞争 Run；租约开始时按 seq 组装原要求与补充 | 复用 Message/Event + queue |
| A03 | Task1 的后台 attempt 正在运行，补充只改变分析或输出口径 | 后台继续；负责人 A 被唤醒并在 delivery/synthesis 时合并补充 | 复用普通 Run + delivery，增量：amend event |
| A04 | Task1 的后台 attempt 正在运行，补充使当前输入或计算失效 | 取消旧 attempt，在同一 Task 下以新 revision 重启；迟到结果不得覆盖 | 复用 cancel/retry lineage |
| A05 | Task1 正等待审批或用户输入 | 若补充改变受控参数/目标则旧审批失效并重提；无关补充不影响审批 | 复用 Intervention 重校验 |
| A06 | Task1 已完成 | 保留旧结果；同一 Task 下创建 follow-up Run，显示“追加复核” | 复用 Task 多 Run + trigger=user |
| A07 | Task1 已失败或已取消 | 保存补充但不自动复活；用户明确选择后才重试或重开 | 复用 terminal state + retry |
| A08 | 自然语言任务指代命中零个或多个候选，或并发收到多条补充 | 零/多候选先消歧；多补充按服务端 seq 追加、按幂等键去重，不做 last-write-wins | 增量：resolver + append-only event |

### R. 路由、发言与应答（R01–R08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| R01 | 无明确目标的新问题 | lead/router 只选一个主响应者，避免全员抢答 | 复用 response owner |
| R02 | 用户明确点名目标 | 被点名者直接回应；主持人不代答 | 复用 explicit mention |
| R03 | 用户要求多个成员各自回答 | 各 Agent 独立生成；消息按 Thread seq 展示 | 复用 multi Run + Message seq |
| R04 | Agent 收到真实委派 | 目标 Agent 自己发确认、追问或拒绝；前端不伪造“收到” | 复用 target support Run |
| R05 | 另一 Agent 正在说话时用户点名新 Agent | 新目标加入响应，不取消当前说话者 | 复用独立 Run |
| R06 | Agent 有阶段进展但未完成 | 可主动发进度消息，明确“假设/中间结果” | 复用 delivery/status 消息 |
| R07 | 多个 Agent 结论冲突 | 各自保留证据；主持人呈现分歧，不抹平成一个答案 | 复用 Thread + owner 汇总 |
| R08 | Agent 无法回答、拒绝或认为不应行动 | 明确说明原因和可选下一步；不制造空白“已读” | 复用普通消息与失败状态 |

### D. Agent 间委派与所有权（D01–D08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| D01 | 主持 Agent 在群里公开给一个或多个成员派活 | 每个目标各调用一次 `message_bot`，在同群创建独立 support Run；UI 可合并成自然 @ 消息 | 增量：group-aware `message_bot` |
| D02 | 主持 Agent 私下给一个 Agent 派活 | 调用 `message_bot`，在固定 A ↔ B pair Thread 创建 support Run；来源只显示轻回执 | 增量：pair Thread + receipt ref |
| D03 | support Agent 再委派第三个 Agent | 继承 `parentRunId`、hop 与来源 Bot | 复用 collaboration lineage |
| D04 | 当前阶段真正交给另一 Agent 负责 | 使用 `handoff_to_bot`；新 Agent 成为 owner | 复用 handoff |
| D05 | 仅请求状态、意见或复核 | 使用 `message_bot(intent=status/request)`，不转移 owner | 复用 intent |
| D06 | 同一 source Run 私下通知 A/B/C | 来源可合并为“已发消息给 3 个 Agent”；底层仍是三个固定 pair Thread 和三个 Run | UI 合并，执行不合并 |
| D07 | 工具调用被重试或重复投递 | delivery key 去重，只产生一个 target Run；不重复写 pair 消息 | 复用幂等与 dedupe |
| D08 | A→B→A 循环或 hop 超限 | ack loop / hop guard 阻止继续委派；失败写入实际投递 Thread | 复用 loop guard |

### X. 跨会话目的地与发送回显（X01–X08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| X01 | 用户在 A 单聊说“去群 G 看看并做 X”，A 是 G 成员且空闲 | A 调用 `message_group`；A 单聊显示发送回显，G 中创建 A 的 owner Run | 增量：Agent→Group 薄包装 |
| X02 | 跨会话新任务到达时 A 在 G 中已有 active conversational Run | 创建独立 Task 和 owner Run，保留独立 origin、取消和结果回流；只有显式 `targetTaskId` 的补充才 steering | 复用 Task/Run，增量：明确边界 |
| X03 | A 只有 G 相关后台任务，没有 active conversational Run | 在 G 中创建新的普通 Run，后台任务继续 | 复用双车道 |
| X04 | A 不是 G 成员 | 用户有成员管理权时询问是否把 A 加入群；批准后原子加群并继续，拒绝/过期不投递；无管理权则直接失败 | 复用 group member mutation + Intervention |
| X05 | 用户在 A 单聊说“给 B 安排 X” | A 调用现有 `message_bot`；A 单聊只写轻回执，B 的 support Run 落在固定 A ↔ B pair Thread | 改造目标 Thread，不新增工具 |
| X06 | B 重名、停用、不存在或跨 workspace | `message_bot` 明确失败；A 页面不显示为已送达 | 复用 Bot 地址解析 |
| X07 | 跨会话目标工作完成、失败、等待审批或被取消 | 来源单聊只轻量更新 receipt 状态；完成时 A 另发用户汇报，完整证据留在目标群或 pair Thread；审批回到用户可见来源 Thread | 复用 outcome resumption + scoped Intervention |
| X08 | 用户从 A 单聊取消跨会话工作 | 根据 `parentRunId` 精确取消目标 child Run/task；不停止目标群其他根任务 | 复用 lineage + cancel |

### C. 并发、抢占与消息时序（C01–C08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| C01 | A/B 同时执行不同 support Run | 两者并行，互不抢占；工作树显示兄弟节点 | 复用独立 Run |
| C02 | 同一 Agent 前台回应且有后台长任务 | 普通 Run 与 `BackgroundAgentTask` 同时存在 | 增量：恢复后台入口 |
| C03 | 同一 Agent 正在前台回应时收到用户新要求 | 唯一候选时 steering；多个候选时按 `targetTaskId` 定向，否则创建独立 queued Run | 复用 SteeringMessage + session admission |
| C04 | 同群存在两个无关用户根任务 | 各自保持 lineage；停止或收尾不串线 | 复用 root Run 边界 |
| C05 | 后台结果与用户新消息几乎同时到达 | 都先持久化；以 Thread seq 与因果元数据稳定展示 | 复用 Message/Event seq |
| C06 | 一个节点等审批或用户输入，其他节点仍在跑 | 先按 Run/Attempt 脱离 pending state，再释放 chat admission；只暂停绑定请求的路径，恢复时重新排队 | 复用 scoped Intervention，增量：隔离 checkpoint |
| C07 | 两个任务争用同一电脑或工具租约 | 工具层排队；Agent 仍可基于已有上下文发言 | 复用工具 lease / queue |
| C08 | 网络乱序、重连或客户端延迟 | UI 按服务端 seq 重排，不按本地到达时间推断因果 | 复用持久事件顺序 |

### B. 后台长任务生命周期（B01–B08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| B01 | Agent 判断工作耗时 | `run_subagent(background:true)` 注册任务后立即返回 task id | 增量：恢复 schema/runtime |
| B02 | 后台任务运行中产生进度 | 持久化 progress event；UI 更新同一节点 | 复用 task projection |
| B03 | 后台任务成功 | terminal event → `DeliveryRecord` → delivery Run → 新结果消息 | 复用 delivery |
| B04 | 后台任务失败 | 节点显示明确失败原因；不伪装结果 | 复用 failed event |
| B05 | 用户或父 Run 取消后台任务 | 写 cancel/tombstone；迟到结果不能重新复活 | 复用 cancel 语义 |
| B06 | 可重试失败 | 在同一 task 下新增 attempt；不重复确认或工作节点 | 复用 retry lineage |
| B07 | 创建任务的前台 Run 已结束 | 后台继续；完成后仍能通过 delivery Run 回群 | 复用脱离父调用生命周期 |
| B08 | 完成时群上下文已经变化 | delivery Run 先读最新 Thread，标记过期或调整结论 | 复用最新 Thread 上下文 |

### P. 审批、权限与安全边界（P01–P08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| P01 | Run 或后台任务要执行受控动作，或缺少继续所需的用户信息 | 动作创建绑定具体调用的 Intervention；信息缺口创建带 schema 的 InputRequest | 复用审批，增量：结构化输入请求 |
| P02 | 用户允许一次 | 只恢复这一次调用；不扩大长期凭据或资源权限 | 复用一次性批准 |
| P03 | 用户拒绝 | 危险动作终止；Agent 可继续讨论和给替代方案 | 复用拒绝结果 |
| P04 | 审批超时或被撤回 | 调用保持终止/等待态，不自动放行 | 复用过期状态 |
| P05 | 同一 Agent 有其他普通 Run 或后台任务 | 等待路径的 native pending state 已隔离且不占 chat session；新 prompt 不能被当成旧请求的答案，未关联路径继续运行 | 复用 scoped pause，增量：可恢复 admission |
| P06 | 目标 Agent 天生无资源权限 | 失败并说明缺失权限；不得借主持 Agent 凭据执行 | 复用后端授权边界 |
| P07 | 等审批期间参数或用户目标变化 | 旧批准失效；基于新参数重新请求 | 增量：恢复前重校验 |
| P08 | 重连或重试重复提交审批决策 | 同一个 Intervention 只消费一次，审计可追溯 | 复用幂等决策 |

### F. 失败、超时与恢复（F01–F08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| F01 | 被委派 Agent 停用、离线或不存在 | `message_bot` 明确失败，不创建假 support Run | 复用目标解析失败 |
| F02 | Agent 在执行中被移出群 | 停止后续群资源访问；当前 Run 按策略取消并留审计 | 复用成员授权 + cancel |
| F03 | 工具调用失败 | Run 可解释失败、重试或给替代方案；错误不吞掉 | 复用 tool result |
| F04 | AgentScope/runtime 或 executor 在持有 session admission、或刚写入 pending state 时重启 | reconciler 用调用前持久化的 fence 验证 Runtime 已 clean/detached 后才释放 owner；从 PostgreSQL/Event/Task 恢复 | 增量：fenced stale-owner 与 pending-state 回收 |
| F05 | 消息或结果投递暂时失败 | 按 delivery key 重试；成功后只出现一次 | 复用 DeliveryRecord |
| F06 | 重复事件或 webhook 重放 | 去重，不重复派活、审批或发布结果 | 复用幂等键 |
| F07 | support Run 超时或长期无响应 | 节点标超时，通知 requester；允许改派或继续等 | 复用 terminal outcome |
| F08 | 部分分支成功、部分失败 | 主持人可做有条件收尾，必须列出缺口 | 复用 owner 汇总 |

### M. 成员、资源与上下文边界（M01–M08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| M01 | 新 Agent 中途加入群 | 加入后的 Run 可读授权范围内的完整 Thread；不会自动接活 | 复用群成员授权 |
| M02 | 未执行工作的 Agent 被移出群 | 后续不可被群内 `@` 或 public-group `message_bot` 命中；若 Bot 本身仍有效，同 workspace 的 private-pair 通信不因此失效 | 复用成员校验，区分投递面 |
| M03 | 有 active Run 的 Agent 被移出群 | 取消/终止该 Run，保留已发消息与审计 | 复用授权撤销 |
| M04 | 目标 Agent 有权访问群文件 | Run 使用现有文件引用，不复制私有数据 | 复用资源权限 |
| M05 | 目标 Agent 无权访问某个文件/系统 | 明确缺权；可请求用户授权，不能继承发送者权限 | 复用 backend authorization |
| M06 | 发送者单聊中的资源被群或 pair 委派引用 | 不自动传播；目标 Agent 必须已有权限，或经用户可见来源 Thread 的 scoped Intervention 授权 | 复用资源隔离 |
| M07 | AgentScope 工作上下文被压缩 | PostgreSQL Thread 是完整记录；压缩状态单独持久化 | 复用既定存储边界 |
| M08 | 跨 workspace / tenant 指定 Agent | 地址解析拒绝，不泄露成员或资源是否存在 | 复用租户隔离 |

### Q. 固定双 Agent 对话生命周期（Q01–Q08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| Q01 | A 首次私下联系 B，尚无 pair Thread | 在同一事务中创建 `kind=agent_pair` 的 ChatGroup、两个成员和 Thread；来源只写轻回执 | 增量：canonical pair resolver |
| Q02 | A 与 B 几乎同时首次联系对方 | 无序 `pairKey` 唯一约束保证只产生一个 Thread；冲突方重新读取后继续投递 | 增量：唯一键 + create-or-get 重试 |
| Q03 | B 后来反向联系 A | 仍命中同一个 A ↔ B Thread，历史连续，不创建“B ↔ A”第二条会话 | 复用 canonical pair resolver |
| Q04 | 同一对 Agent 多次承担不同任务 | 消息追加到固定 Thread；每次委派仍有独立 Task/Run、parentRunId、delivery key 和完成状态 | 复用 Thread + 独立 lineage |
| Q05 | 同一 pair 同时承接来自多个用户会话或群的任务 | 每个 Run 保留 `sourceThreadId/sourceRunId`；结果、审批、取消和重试只回到自己的来源，不按“最近会话”猜归属 | 增量：持久 origin reference |
| Q06 | 用户从 receipt 查看 pair 对话 | 可读取完整历史并定位对应消息；pair 不出现在列表、搜索、群选择器，所有人类消息、reaction、成员修改和 pair 内审批 API 均拒绝 | 增量：只读入口 + 服务端写保护 |
| Q07 | 同一 source Run 私下通知多个 Agent | 来源可合并为“已发消息给 N 个 Agent”；点开在原行下方展开 Agent 下拉列表，再选择一组双人对话；每个目标仍有独立 pair Thread 和 Run | 增量：聚合 receipt，不合并执行 |
| Q08 | Bot 改名、停用、删除或恢复 | 改名/头像更新不改变 pair 身份；停用或软删除后历史保留只读、新投递失败；同一 Bot id 恢复后续用原 pair，新建的替代 Bot 不继承旧历史 | 增量：生命周期与保留策略 |

### O. 结果回流、收尾与审计（O01–O08）

| ID | 触发与前置状态 | 必须产生的行为 | 复用 / 增量 |
| --- | --- | --- | --- |
| O01 | 执行 Agent 得到独立结果 | 以自己的身份发新结果消息，不篡改旧确认消息 | 复用 delivery Run |
| O02 | support 结果需要回到 requester | 结果关联原 `fromBotId/parentRunId`，可唤醒 requester | 复用 bot outcome resumption |
| O03 | 多路结果齐备 | 主持 Agent 综合结论、证据、风险和下一步 | 复用 owner Run |
| O04 | 多路结果互相冲突 | 保留每路来源和置信度；主持人说明未决点 | 复用消息与 lineage |
| O05 | 一部分结果提前返回 | 可以先展示和行动，但不得把未完成分支标为完成 | 复用独立节点状态 |
| O06 | 用户提前结束讨论 | 停止指定根 Run 的后代；保留已产生结果和审计 | 复用 descendant cancel |
| O07 | 讨论自然结束但后台仍运行 | 明确“讨论已收尾、后台仍有 N 项”；结果仍可回群 | 复用独立生命周期 |
| O08 | 用户查看工作树或审计 | 从 Run lineage、BackgroundAgentTask、Intervention、Event 重建 | 复用持久投影 |

## 14. 原型覆盖：8 段主线 + 28 个分支状态

主故事线保持原来的连续叙事，不把异常硬塞进正常流程。顶部“场景”选择器用于切换七组分支，每组 4 个：

| 原型组 | 4 个可切换状态 | 对应矩阵 |
| --- | --- | --- |
| 用户介入 | 单独 @ active Agent；一句话多目标；新旧指令冲突；精确停止一个节点 | U03、U06、U08、C03 |
| 任务补充 | active Run 精确续写；后台任务追加口径；已完成后追加复核；自然语言指代不清 | A01、A03、A06、A08 |
| 跨会话调度 | A 单聊→目标群；A 单聊→B；A 不在群时申请加入；A 回来源单聊汇报结果 | X01、X05、X04、X07 |
| 固定 Agent 对话 | 反向联系仍复用同一对话；一条回执联系多个 Agent；同一 pair 多来源并发；Bot 停用后历史只读 | Q03、Q07、Q05、Q08 |
| 并发与时序 | 多 Agent 同时应答；同 Agent 前后台双车道；两个独立根任务；旧结果晚到 | R03、C02、C04、B08 |
| 审批与权限 | 节点级等待；允许一次；拒绝但继续聊；审批期间上下文变化 | P01、P02、P03、P07 |
| 异常与恢复 | Agent 不可用；后台失败重试；重复投递去重；部分失败收尾 | F01、B06、F06、F08 |

其余 68 项不必各画一张几乎相同的界面，但必须进入 API、Runtime、投影和端到端测试。这样既不缩减产品语义，也不把测试排列组合伪装成几十套新 UI。
