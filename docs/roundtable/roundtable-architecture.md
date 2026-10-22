# WorkPal 圆桌模式架构骨架

状态：架构定稿，已完成任务拆分与终审  
日期：2026-10-22  
输入：`roundtable-product-requirements.md`、`prototype/`、当前 WorkPal 源码  
范围：模块边界、核心类型、接口签名、依赖和主流程，不包含实现代码

## 1. 结论

圆桌模式不应该成为新的顶层子系统。它由六项现有能力组合而成：

1. 用户消息路由。
2. Agent 间协作投递。
3. 跨群投递。
4. Task 指令追加。
5. AgentScope 后台执行。
6. 群级查询投影。

持久事实继续由 PostgreSQL 的 `Thread / Message / Task / Run / Event` 拥有。AgentScope 只执行已经创建好的 Run，并单独保存工作上下文。Web 只读取服务端事实，不根据 `@Name`、回执或动画创建工作状态。

架构上新增的是少量服务操作、类型和查询，不新增 `RoomSession`、`RoomTurn`、`Work`、`AgentConversation` 或 `TaskAmendment` 实体。

## 2. Usage

先从调用者看系统。正常使用不应该要求调用者理解 pair key、事务锁、Run lineage 或 Event payload。

### 2.1 Agent 给另一个 Agent 派活

```ts
const result = await collaborationDispatch.deliverToBot({
  actor: currentRunActor,
  target: { botId },
  visibility: "public",
  intent: "request",
  content,
  deliveryKey,
});
```

调用者提供执行身份、目标、可见性、意图和内容。服务负责：

- 决定落在当前群还是固定 pair Thread。
- 校验群成员、Bot 状态和用户范围。
- 原子写入消息、Task、Run 和 Event。
- 固化 owner/support lineage。
- 处理 delivery key、hop 和 loop guard。
- 返回稳定 destination locator。

### 2.2 Agent 去另一个群工作

```ts
const result = await groupDispatch.deliver({
  actor: currentRunActor,
  target: { groupId },
  content,
  deliveryKey,
});

if (result.kind === "waiting_for_membership_approval") {
  return result.interventionId;
}
```

如果 Agent 已是成员，服务写来源回执，并在目标群创建独立 Task 和 Run。跨会话请求不能因为目标 Agent 已有 active Run 就写入该 Run。两个请求需要独立的归属、取消和结果回流。只有用户明确提交目标群中的 `targetTaskId` 时，服务才走既有 Task 的 amendment 和 steering 路径。

如果 Agent 不是成员，服务先在用户可见来源 Thread 创建 scoped Intervention。批准后，服务重新校验权限，再原子执行加成员和投递。

### 2.3 用户给已有 Task 补充要求

```ts
const result = await taskInstructions.append({
  actor: currentUserActor,
  threadId,
  taskId,
  content,
  clientNonce,
});
```

服务写普通 Message 和 `task.amended` Event，推进 revision，并返回后续动作：

```ts
type AmendmentAction =
  | { kind: "steered"; runId: RunId }
  | { kind: "queued"; runId: RunId }
  | { kind: "follow_up"; runId: RunId }
  | { kind: "requires_choice"; candidates: TaskRef[] }
  | { kind: "recorded_terminal"; taskId: TaskId };
```

### 2.4 Web 读取群级工作和资料

```ts
const work = await groupQueries.listWork({
  actor: currentUserActor,
  groupId,
  cursor,
  limit,
});

const artifacts = await groupQueries.listArtifacts({
  actor: currentUserActor,
  groupId,
  cursor,
  limit,
});
```

Web 获得展示用语义状态。它不读取内部 Attempt，不计算百分比，也不从当前消息窗口重建完整工作历史。

## 3. 核心类型

### 3.1 身份类型

下面的 ID 在 TypeScript 中应使用项目现有 schema 派生类型或 branded type，避免把 Bot、Group、Thread 和 Task 的字符串互换。

```ts
type UserId = Brand<string, "UserId">;
type SpaceId = Brand<string, "SpaceId">;
type BotId = Brand<string, "BotId">;
type GroupId = Brand<string, "GroupId">;
type ThreadId = Brand<string, "ThreadId">;
type MessageId = Brand<string, "MessageId">;
type TaskId = Brand<string, "TaskId">;
type RunId = Brand<string, "RunId">;
type AttemptId = Brand<string, "AttemptId">;
type RuntimeTaskId = Brand<string, "RuntimeTaskId">;
type InterventionId = Brand<string, "InterventionId">;
```

### 3.2 collaboration destination

```ts
type CollaborationDestination =
  | {
      kind: "current_group";
      groupId: GroupId;
      threadId: ThreadId;
    }
  | {
      kind: "agent_pair";
      pairThreadId: ThreadId;
      peerBotId: BotId;
    };
```

`current_group` 和 `agent_pair` 是互斥变体。调用方不能同时传 `groupId` 与 `pairThreadId`。

### 3.3 origin 与 locator

```ts
type CollaborationOrigin = {
  sourceThreadId: ThreadId;
  sourceRunId: RunId;
  sourceMessageId?: MessageId;
};

type CollaborationRequestRef = {
  origin: CollaborationOrigin;
  targetTaskId: TaskId;
  targetRunId: RunId;
  receiptMessageId: MessageId;
  deliveryKey: string;
};

type DestinationLocator =
  | {
      kind: "group_message";
      groupId: GroupId;
      threadId: ThreadId;
      messageId: MessageId;
    }
  | {
      kind: "pair_message";
      pairThreadId: ThreadId;
      messageId: MessageId;
    };
```

locator 用于导航，不是 bearer secret。所有读取仍校验当前用户、Space、来源 receipt 和目标 Thread。

### 3.4 固定 pair

```ts
type AgentPair = {
  groupId: GroupId;
  threadId: ThreadId;
  botAId: BotId;
  botBId: BotId;
};

type ChatGroupKind = "standard" | "agent_pair";
```

`pairKey` 是 repository 私有的 canonical unordered key。它不进入 UI 和工具 contract。

### 3.5 结构化消息正文

```ts
type MessageInline =
  | { kind: "text"; text: string }
  | { kind: "bot_mention"; botId: BotId; label: string };

type CollaborationReceipt = {
  kind: "collaboration_receipt";
  targetBotId: BotId;
  destination: DestinationLocator;
  state: "sent" | "failed" | "completed" | "cancelled";
};
```

Agent mention 不使用 Markdown 渲染后的字符 offset。旧纯文本消息继续显示，但不会被反解析成工具调用、Run 或可导航身份。

### 3.6 Task instruction envelope

```ts
type TaskInstructionEnvelope = {
  taskId: TaskId;
  revision: number;
  original: {
    content: string;
    messageId?: MessageId;
  };
  amendments: ReadonlyArray<{
    messageId: MessageId;
    seq: number;
    content: string;
  }>;
};

type RunInstructionRef = {
  taskId: TaskId;
  consumedRevision: number;
};
```

`Task.prompt` 继续保存原始要求。追问回答和审批回答不能覆盖它。`task.amended` Event 是审计事实。Task 上的当前 revision 是同一事务维护的查询聚合值。Attempt 只表示相同输入的技术重试，不表示 instruction revision。

### 3.7 后台执行状态

```ts
type BackgroundExecutionRef = {
  taskId: TaskId;
  runId: RunId;
  attemptId: AttemptId;
  runtimeTaskId: RuntimeTaskId;
  consumedRevision: number;
};

type BackgroundWorkState =
  | { kind: "queued"; execution: BackgroundExecutionRef }
  | { kind: "running"; execution: BackgroundExecutionRef; currentAction?: string }
  | { kind: "blocked"; execution: BackgroundExecutionRef; reason: string }
  | { kind: "completed"; execution: BackgroundExecutionRef; deliveryId: string }
  | { kind: "failed"; execution: BackgroundExecutionRef; error: string }
  | { kind: "cancelled"; execution: BackgroundExecutionRef };

type BlockedHelperRequest = {
  execution: BackgroundExecutionRef;
  origin: CollaborationOrigin;
  request:
    | Readonly<{
        kind: "action";
        toolName: string;
        arguments: unknown;
        reason: string;
      }>
    | Readonly<{
        kind: "input";
        question: string;
        answerSchema?: unknown;
        reason: string;
      }>;
};
```

每个后台 helper 对应一个产品 Task 和执行 Run。`BackgroundAgentTask` 是该 Run 某次 Attempt 的 AgentScope 投影，不是产品 Task。一个父 Run 可以创建多个 helper Task。输入 revision 改变时，在同一 Task 下创建新 Run。相同输入的技术重试在同一 Run 下创建新 Attempt 和新的 runtime task。

后台 helper 保持只读。需要写操作或缺少用户信息时，它返回 `blocked` 和结构化 `BlockedHelperRequest`。`action` 分支创建一次性审批；`input` 分支创建可回答的输入请求，不能伪装成工具调用。两类请求都由用户可见的来源 Thread 承接，pair Thread 仍不可写。

### 3.8 群工作投影

```ts
type GroupWorkState =
  | { kind: "queued" }
  | { kind: "working"; currentAction?: string }
  | { kind: "waiting"; reason: "approval" | "input" | "resource" }
  | { kind: "failed"; summary: string }
  | { kind: "done"; resultMessageId?: MessageId }
  | { kind: "cancelled" };

type GroupWorkItem = {
  taskId: TaskId;
  rootRunId: RunId;
  ownerBotId: BotId;
  state: GroupWorkState;
  updatedAt: string;
  children: GroupWorkItem[];
};
```

这个类型是只读投影，不是新的持久 Work 实体。

## 4. 接口签名

### 4.1 collaboration dispatch

```ts
interface CollaborationDispatch {
  deliverToBot(input: DeliverToBotCommand): Promise<DeliverToBotResult>;
  returnOutcome(input: ReturnCollaborationOutcomeCommand): Promise<OutcomeResult>;
}

type DeliverToBotCommand = {
  actor: RunActor;
  target: { botId?: BotId; confirmName?: string };
  visibility: "public" | "private";
  intent: "request" | "question" | "status" | "result" | "fyi";
  content: string;
  deliveryKey: string;
};

type DeliverToBotResult =
  | {
      kind: "delivered";
      destination: CollaborationDestination;
      targetRunId: RunId;
      locator: DestinationLocator;
    }
  | {
      kind: "replayed";
      targetRunId: RunId;
      locator: DestinationLocator;
    }
  | {
      kind: "rejected";
      reason:
        | "target_not_found"
        | "target_unavailable"
        | "not_group_member"
        | "cross_space"
        | "hop_exhausted"
        | "ack_loop"
        | "source_not_active";
    };
```

这个接口隐藏 private/public 的存储差异。`handoff_to_bot` 不属于此接口，它继续表示 owner 移交。

### 4.2 pair repository 与 thread policy

```ts
interface AgentPairRepository {
  getOrCreate(input: {
    actor: SystemActor;
    spaceId: SpaceId;
    userId: UserId;
    botAId: BotId;
    botBId: BotId;
  }): Promise<AgentPair>;

  resolveReadable(input: {
    actor: UserActor;
    sourceReceiptMessageId: MessageId;
    pairThreadId: ThreadId;
  }): Promise<AgentPair>;
}

interface ThreadPolicy {
  classify(threadId: ThreadId): Promise<"bot" | "group" | "agent_pair">;
  assertHumanCanRead(actor: UserActor, threadId: ThreadId): Promise<void>;
  assertHumanCanWrite(actor: UserActor, threadId: ThreadId): Promise<void>;
}
```

所有用户写入口调用同一个 `ThreadPolicy`。页面隐藏 composer 只是表现，不是权限边界。

`agent_pair` 的完整 Thread 只供两个 Agent 的执行上下文连续使用。人类读取必须从来源 receipt 进入，并对返回的每条消息按持久化 `origin.sourceThreadId` 再做授权；pair Thread 本身可读不代表其中所有来源都可读。分页、定位和计数都在授权过滤后的投影上计算，不能先返回整页再由 Web 隐藏。

### 4.3 group dispatch

```ts
interface GroupDispatch {
  deliver(input: DeliverToGroupCommand): Promise<DeliverToGroupResult>;
  resumeAfterMembershipDecision(input: ResumeGroupDeliveryCommand): Promise<DeliverToGroupResult>;
}

type DeliverToGroupResult =
  | {
      kind: "delivered";
      targetRunId: RunId;
      locator: DestinationLocator;
    }
  | {
      kind: "waiting_for_membership_approval";
      interventionId: InterventionId;
    }
  | {
      kind: "rejected";
      reason:
        | "group_not_found"
        | "cross_space"
        | "cannot_manage_members"
        | "bot_unavailable"
        | "source_not_active";
    };
```

批准后的 resume 必须重新读取用户权限、Bot 状态和群状态。加成员、写目标消息、创建 Task 和 Run，以及写来源 receipt，在服务定义的事务边界内完成。明确补充既有 Task 的请求不调用 `GroupDispatch`，而调用 `TaskInstructions.append`。

### 4.4 origin-aware intervention

```ts
interface InterventionDelivery {
  createForExecution(input: {
    executionThreadId: ThreadId;
    presentationThreadId: ThreadId;
    runId: RunId;
    attemptId: AttemptId;
    origin: CollaborationOrigin;
    request: InterventionRequest;
  }): Promise<InterventionId>;

  resolveFromPresentationThread(input: {
    actor: UserActor;
    presentationThreadId: ThreadId;
    interventionId: InterventionId;
    clientSubmissionId: string;
    answer: InterventionAnswer;
  }): Promise<InterventionOutcome>;
}
```

`executionThreadId` 决定被恢复的 Run。`presentationThreadId` 决定用户在哪里看到并提交审批或补充。服务同时校验来源 receipt、当前用户、Space 和 execution origin。pair Thread 仍拒绝所有人类写入。

### 4.5 task instructions

```ts
interface TaskInstructions {
  append(input: AppendTaskInstructionCommand): Promise<AppendTaskInstructionResult>;
  readEnvelope(input: {
    actor: ExecutionActor;
    taskId: TaskId;
  }): Promise<TaskInstructionEnvelope>;
}
```

调用者不能直接推进 revision。repository 在写 Message 和 Event 的同一事务内推进它。

### 4.6 background delegation gate

```ts
interface BackgroundDelegationPolicy {
  resolve(input: {
    run: RunContext;
    requestedBackground: boolean;
  }): BackgroundDelegationDecision;
}

type BackgroundDelegationDecision =
  | {
      kind: "allowed";
      maxChildren: number;
      maxDepth: number;
      toolNames: ReadonlyArray<ReadonlyToolName>;
    }
  | {
      kind: "denied";
      reason: "runtime_suspended" | "run_policy" | "budget" | "nested_delegation";
    };
```

Runtime gate 和 product TurnPolicy 都必须同意。任何一个拒绝时，都不向 AgentScope 暴露 `run_subagent`。

### 4.7 session admission

```ts
interface AgentSessionAdmission {
  acquire(input: {
    userId: UserId;
    spaceId: SpaceId;
    botId: BotId;
    threadId: ThreadId;
    threadGeneration: number;
    runId: RunId;
    runLeaseId: string;
  }): Promise<
    | { kind: "acquired"; admissionLeaseId: string; fence: number; expiresAt: string }
    | { kind: "queued"; ownerRunId: RunId }
  >;

  heartbeat(input: {
    runId: RunId;
    admissionLeaseId: string;
    fence: number;
  }): Promise<{ expiresAt: string }>;

  suspend(input: {
    runId: RunId;
    admissionLeaseId: string;
    fence: number;
    checkpointId: string;
    reason: "approval" | "input";
  }): Promise<void>;

  release(input: {
    runId: RunId;
    admissionLeaseId: string;
    fence: number;
    terminalState: string;
  }): Promise<void>;
}

type RuntimeCheckpointRef = {
  checkpointId: string;
  suspensionKey: string;
  runId: RunId;
  attemptId: AttemptId;
  pendingRequestId: string;
  sessionKey: string;
  checkpointVersion: number;
  admissionFence: number;
};

type RuntimeExecutionFence = {
  runId: RunId;
  attemptId: AttemptId;
  sessionKey: string;
  admissionLeaseId: string;
  admissionFence: number;
  suspensionKey: string;
};

interface AgentRuntimeSuspension {
  detach(input: {
    execution: RuntimeExecutionFence;
  }): Promise<RuntimeCheckpointRef>;

  inspectAndDetach(input: {
    execution: RuntimeExecutionFence;
  }): Promise<
    | { kind: "clean" }
    | { kind: "detached"; checkpoint: RuntimeCheckpointRef }
  >;

  resume(input: {
    checkpoint: RuntimeCheckpointRef;
    execution: RuntimeExecutionFence;
    resolutionId: string;
    resolution: unknown;
    latestThreadSeq: number;
  }): Promise<void>;
}
```

admission key 与 AgentScope chat session key 一致。它不包含 Run ID。一个 key 同时只有一个 active owner Run，但 ownership 是有期限且带单调 fence 的持久 lease，不是永久锁。executor 心跳续租；Runtime 调用和完成 CAS 都携带 fence，旧 worker 的迟到写入不能越过新 owner。Runtime 返回 409 时，executor 把 Run 放回 admission queue，不把它标为失败。

每次进入 Runtime 之前，executor 必须先在 PostgreSQL 预分配并持久化 `RuntimeExecutionFence`，其中 `suspensionKey` 在是否产生 pending call 之前就已存在，然后把完整 fence 传给 Runtime。Runtime 创建 tool confirmation 或 ask-user pending state 时，从一开始就标记 Run、Attempt、admission fence 和 suspension key；不能再写匿名的共享 pending call。Runtime 在向 executor 暴露 suspended 响应前，原子完成 checkpoint snapshot-and-detach，并在响应中返回 checkpoint identity。

admission lease 过期或 worker 丢失时，reconciler 先把 owner 标为 `recovering`，不能直接释放或唤醒下一 Run。它用预持久化的 execution fence 调用 `inspectAndDetach`；只有 Runtime 对旧 fence 返回 `clean`，或返回已安全脱离且可恢复的 checkpoint，并且该证明已持久化后，才释放 owner 并公平唤醒下一项。Runtime 暂时不可达时保持 recovering，优先保证不会跨 Run 执行错误的 pending action。

Run 创建 Intervention 等待审批或用户输入时，不能只记录数据库 checkpoint。Runtime 使用调用前已持久化的 `suspensionKey`，在自己的状态存储中原子地把 pending tool/ask-user state 从 Bot+Thread+generation 的共享 `agent_state` 移到按 Run、Attempt 和 pending request 隔离的 checkpoint namespace，并清除共享 session 的 pending state。executor 收到 suspended 响应后持久化 suspension intent 和 checkpoint acknowledgement；只有该 acknowledgement 已持久化后，才能用 fenced `suspend` 释放 chat admission。若 Runtime 已 detach 但响应或数据库 acknowledgement 丢失，reconciler 用预注册的 execution fence 取回同一 checkpoint；不得生成第二份或把共享状态留在半脱离状态。

决定或答案必须携带与 checkpoint 一致的 `pendingRequestId`，不能把下一条普通 prompt 猜成答案或批准。resolution 持久化后，该 Run 以同一 Run identity 重新排队；取得新的 admission lease 后，executor 为这次 resume 预持久化一套新的 `RuntimeExecutionFence` 和新的 `suspensionKey`。Runtime 用旧 checkpoint + 新 execution fence 恢复，只恢复匹配的 checkpoint，合并 checkpoint 之后新增的 Thread 消息，再消费该 resolution。旧 fence、错 Run/Attempt、错 request 或重复 resolution 都被拒绝。恢复再次阻塞时，新的 pending state 从创建起绑定新 fence，并按新 suspension key 重新 detach；完成后清除旧 checkpoint。进程在 acquire 后、detach 前后、Runtime 执行中或 release 前崩溃时，lease expiry + reconciler 都必须收敛；不能依赖进程 finally。

`background_continuation` 不使用 chat admission，也不复用拒绝工具的 `auxiliary` scope。Runtime 新增 `executionScope="background_continuation"`，session key 至少包含 continuation Run 与 Attempt identity。该 scope 只读取来源 Thread 的显式上下文快照、原阻塞请求和已持久化的决定或答案：`action` 分支只暴露批准后的精确工具与参数，`input` 分支保持 tool-less。等待用户决定或答案时不创建活跃 Runtime session；只有恢复执行时才获取该独立 scope 的执行 lease。

### 4.8 delivery batch identity

```ts
type DeliveryBatchKey = {
  threadId: ThreadId;
  threadGeneration: number;
  botId: BotId;
  originRunId: RunId;
  executionTaskId: TaskId;
  executionRunId: RunId;
  attemptId: AttemptId;
  runtimeTaskId: RuntimeTaskId;
  consumedRevision: number;
};
```

同一个 delivery Run 只能合并相同 key 的记录。群 Thread 中不同 Bot 的结果、pair Thread 中不同来源的结果、不同 Task 的相同 revision、同一 Task 的不同 revision，以及同一 Run 的不同 Attempt 不能进入同一批次。

terminal callback 先执行 Attempt-level compare-and-set。只有仍是当前 Attempt、runtime task identity 匹配且 consumed revision 仍有效的回调可以创建 DeliveryRecord。被替代 Attempt 的迟到回调只写审计 Event。

### 4.9 group queries

```ts
type GroupQuery = { actor: UserActor; groupId: GroupId };
type GroupPageQuery = { actor: UserActor; groupId: GroupId; cursor?: string; limit: number };

type GroupMembersSummary = {
  groupId: GroupId;
  threadId: ThreadId;
  currentUser: GroupUserMember;
  agents: readonly GroupAgentMember[];
  agentCount: number;
  memberCount: number;
};

interface GroupPanelQueries {
  listArtifacts(input: GroupPageQuery): Promise<Page<ArtifactSummary>>;
  listRoutines(input: GroupQuery): Promise<readonly GroupRoutineSummary[]>;
  listMembers(input: GroupQuery): Promise<GroupMembersSummary>;
}

interface GroupWorkQueries {
  listWork(input: GroupPageQuery): Promise<Page<GroupWorkItem>>;
  getWork(input: GroupWorkQuery): Promise<GroupWorkDetail>;
}

/** Composite for consumers that need both projections. */
interface GroupQueries extends GroupPanelQueries, GroupWorkQueries {}
```

群面板和工作投影由不同模块拥有。`GroupPanelQueries` 只覆盖资料库、例行任务和成员，`GroupWorkQueries` 只覆盖工作列表和 Task 详情；任何模块只实现自己真正拥有的接口，不得为了满足 `GroupQueries` 而实现不属于自己的方法并抛出“未实现”异常。`GroupQueries` 仅组合给同时消费两边的调用方。

群最多只有 6 个 Agent，因此成员和例行任务不做人为分页。Work 和 Artifact 继续分页：`listArtifacts` 必须把 group scope 和冻结的 `asOf` 快照编入游标，不能先拉全空间数据再在 Web 过滤。`ArtifactSummary` 携带来源身份 `botId`、`groupId`、`runId`（不适用时为 `null`）和 `versionCount`，供右栏的文件归属与版本操作使用。

`GroupAgentIdentity` 是群胶囊、成员行和例行任务执行者标签共用的 Agent 头像身份：`kind: "agent"`、`botId`、`name`、`color`、`avatarMode`、`avatarCharacter`、`avatarBodyColor`。`GroupAgentMember` 在此基础上增加 `status`。`GroupUserMember` 保持独立：`kind: "user"`、`userId`、`name`、`image`、`avatarStyle`。`agentCount` 不包含当前用户，`memberCount` 恒等于 `agentCount + 1`。

`listRoutines` 查询绑定到目标 `threadId` 的 Routine，但 Routine 仍由具体 `botId` 的 Bot 拥有。每个 `GroupRoutineSummary` 都必须携带 `botId`、`threadId` 和具体的 `executorBot` 身份；不存在没有执行 Agent 的群级 Routine。

`packages/contracts` 负责 RPC/Zod wire schema，`packages/core` 负责带 branded ID 的领域类型和 `GroupQueries` port。两层可以在边界映射，但不得出现语义不同的第二套定义。

## 5. Ownership

| 规则或状态 | 唯一 owner | 其他模块能做什么 |
| --- | --- | --- |
| 用户群消息路由 | `apps/api` + core response-owner policy | Web 只发送 typed mention payload |
| collaboration role、parent、hop | core orchestration types | adapters 创建时固化，Web 只读 |
| pair identity 与唯一性 | DB pair repository | adapters 请求 get-or-create |
| pair 人类读写权限 | backend `ThreadPolicy` | Web 隐藏写控件但不承担授权 |
| public/private destination | collaboration dispatch | 工具只提交 visibility |
| 跨群成员审批与续跑 | group dispatch + Intervention | Web 只提交决策 |
| Task instruction revision | task instruction repository | executor 读取 envelope |
| Run/Attempt 生命周期 | 现有 Run state machine 与 executor | UI 读取投影 |
| AgentScope chat session admission | executor + durable Run queue | Runtime 只执行当前 owner Run |
| BackgroundAgentTask | 产品 Task/Run/Attempt + AgentScope runtime projection | Web 不直接更新状态 |
| 审批 | origin-aware Intervention delivery | helper 只返回阻塞需求 |
| blocked helper 的受控续跑 | background continuation service | 普通 delivery Run 保持无工具 |
| 异步结果 | DeliveryRecord + typed batch key + delivery Run | requester 可综合，不修改原结果 |
| 群工作 | group query projection | Web 不持久化第二份状态 |
| 群资料 | Artifact repository | Web 按 group scope 分页 |
| 群例行任务 | 具体 Bot 的 Routine | 群右栏按 target Thread 查询 |

## 6. Module map

```text
packages/contracts
  typed RPC、MessageBlock、Event schema
          |
packages/core
  collaboration domain、routing policy、instruction fold、work-state reducer
          |
          +-----------------------+
          |                       |
packages/db                 packages/adapters
  pair identity               message_bot
  thread policy               message_group
  instruction revision        executor / delivery
  group projections           AgentScope bridge
          |                       |
          +-----------+-----------+
                      |
                 PostgreSQL facts
                      |
        +-------------+-------------+
        |                           |
apps/api                     services/agent-runtime
  user commands                AgentScope execution
  authorization               background child lifecycle
  read RPC                    read-only tool enforcement
        |
apps/web
  transcript、receipt、pair dialog、group panel
  只读取 contract 投影
```

依赖方向：

- contracts 不依赖实现包。
- core 不依赖 API、Web、Prisma row 或 AgentScope SDK。
- DB 和 adapters 依赖 core domain，不向 core 泄漏存储或工具 wire type。
- API 调用 services/repositories，不复制事务规则。
- Web 只依赖 contracts 和 UI packages，不引用 DB 或 adapter 类型。
- AgentScope runtime 不决定 Thread、群成员或资源授权。

## 7. Main flows

### 7.1 群内公开委派

```text
Agent tool call
  -> parse DeliverToBotCommand
  -> collaboration dispatch resolves current_group
  -> lock source Run + group Thread
  -> validate target membership and delivery key
  -> write public collaboration Message
  -> create target Task + support Run
  -> append Events
  -> enqueue target Run
  -> return group locator
```

目标 Agent 从自己的真实 Run 发确认、追问或结果。requester 可以被 outcome 唤醒做综合。两条消息目的不同，不应复制同一正文。

### 7.2 私下 Agent pair 委派

```text
Agent tool call
  -> collaboration dispatch resolves agent_pair
  -> pair repository get-or-create
  -> lock source Thread + pair Thread
  -> write source receipt
  -> write pair inbound Message
  -> create target Task + support Run with origin
  -> enqueue
  -> return pair locator
```

结果、审批、取消和重试都按持久 origin 回到正确来源，不使用“最近会话”。

### 7.3 跨群投递

```text
message_group
  -> validate group and actor
  -> bot is member?
       yes -> atomic receipt + target Message + create Task/Run
       no  -> user can manage members?
                no  -> reject
                yes -> create scoped Intervention
  -> approval decision
  -> revalidate all authority and entity state
  -> atomic member add + receipt + target Message + create Task/Run
```

拒绝、过期或权限撤销不产生目标群消息。

跨会话请求总是创建独立 Task 和 Run。补充目标群中的既有 Task 使用 7.4 的 Task 补充入口，不通过 `message_group`。服务不能根据“这个 Bot 当前有 active Run”猜测两个请求属于同一项工作。

同一个用户、Space、Bot、Thread 和 generation 在 AgentScope 中只有一个 active chat session。独立 Run 仍可创建，但只有持有有效 fenced admission lease 的 Run 能进入 chat scope，其余 Run 保持 queued。Run 等待审批或用户输入时持久化 checkpoint 并释放 admission；恢复时重新排队，因此同一 Agent 的未关联普通 Run 可以继续。`background_continuation` 使用按 Run/Attempt 隔离的专用 scope，不占 chat admission。dedicated computer 是单独的工具租约；它可以继续排队，但不能反向阻塞 Agent 基于已有上下文回复。

### 7.4 Task 补充

```text
user sends content + targetTaskId
  -> validate actor, Thread and Task ownership
  -> append Message + task.amended + revision in one transaction
  -> inspect current Task/Run state
       active conversational -> steering bound to that Run
       queued -> lease reads latest envelope
       completed -> follow-up Run under same Task
       failed/cancelled -> record only; explicit retry required
       input-invalidating background result -> cancel old execution, new Run consumes revision
```

旧 revision 的迟到结果保留审计，但不能成为当前结果。

### 7.5 后台 helper

```text
Run requests run_subagent(background=true)
  -> TurnPolicy check
  -> Runtime safety gate check
  -> transaction creates child Task + Run + Attempt + background launch command
  -> launcher sends idempotent launch key to AgentScope
  -> AgentScope returns runtimeTaskId and durable acknowledgement
  -> projector binds BackgroundAgentTask(runtimeTaskId, runId, attemptId, revision)
  -> parent Run receives child task id and may finish
  -> child reports heartbeat/progress/terminal event
  -> terminal callback wins Attempt-level CAS or becomes audit-only
  -> terminal event creates DeliveryRecord with typed batch key
  -> delivery Run reads latest Thread and reports result
```

同一 Bot 可以同时有 BackgroundAgentTask 和新的 conversational Run。电脑或浏览器租约仍可能排队，产品不能承诺所有工具工作立即并行。

PostgreSQL 和 AgentScope 之间没有跨系统事务。后台启动使用持久 outbox 状态：`pending_launch`、`launching`、`acknowledged`、`cancel_requested` 和 terminal。launch key 由预分配的 Run 与 Attempt identity 派生。重复发送返回同一个 runtime task。reconciler 处理“已提交但未启动”和“已启动但 ack 丢失”。部署前已有的 `BackgroundAgentTask` 行保持 nullable legacy identity，并走旧 cancel、callback 和 delivery 路径直到 drain；新 feature gate 不能为 legacy 行伪造 Task 或 Attempt。

只读 helper 需要受控动作或用户信息时返回结构化 `BlockedHelperRequest`。系统在用户可见来源 Thread 创建 `background_continuation` Run：`action` 请求关联 Intervention，`input` 请求关联可回答的 InputRequest；决定、答案和幂等消费状态都持久化。等待期间不持有任何 Runtime session。恢复时 continuation 使用按 Run/Attempt 隔离的 `background_continuation` scope；动作分支只暴露批准后的精确工具与参数，输入分支 tool-less。普通 result delivery Run 继续 tool-less。完成后，系统为原 helper Task 创建新的 Run 或 Attempt，并把决定或答案作为显式输入继续工作。

## 8. UI boundary

原型中的 UI 只消费下列服务端结果：

- 群顶部胶囊和右栏头部读取 current user + group members。
- `详情 / 工作 / 资料库 / 成员` 共用现有 Shell 右栏。
- 工作页读取 `GroupWorkItem`，不读取百分比。
- Task 详情读取 original instruction、amendments 和当前有效 envelope，不显示 Attempt 内部结构。
- 单目标 receipt 直接打开 pair read API。
- 多目标 receipt 只聚合 locator 列表，不合并执行。
- pair dialog 没有任何写 API。
- Agent mention link 只导航到用户与该 Bot 的长期单聊。

视觉约束由 `prototype/DESIGN.md` 负责。生产组件继续使用 `@rakazo/ui-tokens`、`@rakazo/ui-web`、`@rakazo/chat-ui` 和 `apps/web/src/components/ai/`。

## 9. Alternatives

### 9.1 选择方案：按现有能力 owner 增加深接口

本方案保留 Thread、Task/Run、Intervention 和 DeliveryRecord 的现有所有权。新增的 collaboration dispatch、group dispatch、task instructions 和 group queries 各自隐藏事务与状态转换。

优点：

- 普通聊天、handoff、Task Center 和 Artifact 继续使用原来的事实。
- private pair、public collaboration、message_group 和 background helper 可以独立关闭。
- Web 不需要了解锁、revision、lineage 或 runtime 回调。
- 失败和重试继续使用现有幂等与审计机制。

代价：

- 一个用户故事会跨 DB、core、adapters、API 和 Web。
- origin 和 destination 类型必须先稳定，否则后续模块会互相猜字段。

### 9.2 淘汰方案：建立 `RoundtableCoordinator` 与 Round/Work 实体

这个方案会增加 Round、Turn、Work、speaker queue 和独立状态机，再把现有 Run 映射进去。

它输了，因为调用者需要同时理解 Round Work 和 Task/Run。取消、审批、重试和结果投递会出现两个 owner。UI 也会有机会展示 Round 状态与真实 Run 状态不一致。

### 9.3 淘汰方案：全部由 Event 推导，不保存 pair identity 和 Task revision 聚合

这个方案只追加 Event。每次读取时重放所有事件来推导 pair、revision 和工作状态。

它保留完整审计，但并发 create-or-get pair 无法只靠应用层重放保证唯一。Task lease、审批 revision 和列表分页也需要高频聚合。最终仍会增加缓存或隐藏索引，反而形成第二个不透明状态源。

选择方案保留 append-only Event，同时给并发唯一性和高频读取增加最小数据库约束与事务聚合值。

## 10. Risks

1. `message_bot` 当前在群里被过滤，原因是旧实现投递到目标 Bot 的用户 Thread。解除过滤必须与 destination-aware dispatch 同时完成，不能只改工具列表。
2. Java Runtime 目前主动暂停新 `run_subagent`。恢复条件包含 AgentScope SDK 能力证明、真实 child session 压缩、background registration、delivery 和 cancel。它不是一个开关任务。
3. support Run 当前 TurnPolicy 也禁止 background。Runtime 和 product policy 两层都要满足。
4. 当前 peer overlay 从用户单聊中的 sent/received block 重建历史。新 pair read 上线前不能删除旧只读路径，也不能猜测迁移历史。
5. 当前消息正文没有稳定 mention identity。Web 不能对裸文本加正则后宣称可导航。
6. `Artifact.groupId` 已存在，但 list API 没有 group scope。客户端过滤首屏会在分页后漏数据。
7. Routine 可以绑定 `threadId`，但仍由 Bot 拥有。右栏不能显示没有执行 Bot 的 group-owned Routine。
8. Bot archive/restore 可以保留 identity。永久删除若级联清理历史，则不承诺 pair 历史保留。
9. group work 只能显示 active + recent 分页。当前 Thread snapshot 是有界窗口，不能作为完整工作历史来源。
10. 多目标用户命令必须依赖 typed mention 与明确片段。无法可靠分段时应请求澄清，不让模型从普通文本创造执行指令。
11. 当前 `commitAnswerRunInput` 会覆盖 `Task.prompt`。instruction envelope 上线前必须迁移所有 prompt 写入者和 executor 消费者。
12. 当前 delivery batch 主要按 Thread 和时间窗合并。多 Bot 群 Thread 上线前必须把 Bot、origin 和 revision 纳入 batch key。
13. AgentScope chat admission 不含 Run ID。同 Bot、同 Thread 的独立 Run 必须通过持久 session queue 串行进入 Runtime，不能把 409 当普通失败。
14. 当前用户 steering 按 Bot 从无序 active Run 查询中取一个候选。允许独立 Run 后，router 必须在多候选时要求 task identity 或创建 queued Run。
15. PostgreSQL 和 AgentScope 无法原子提交后台启动。必须使用持久 launch outbox、幂等 launch key、ack 和 reconciliation。
16. 已存在的 BackgroundAgentTask 行没有产品 Task、Run、Attempt 和 revision identity。滚动升级必须保留 legacy nullable 路径直到旧行 drain。

## 11. 尚未决定但不阻塞骨架的问题

- group work 的 recent 分页默认窗口。
- private pair、public collaboration、message_group 和 background helper 的 feature gate 粒度。
- support 结果唤醒 requester 后，综合消息如何引用原结果而不重复正文。
- Bot 永久删除在 UI 中是否允许，以及它与历史保留的产品说明。

这些问题会影响具体任务验收，不改变模块 owner 和依赖方向。
