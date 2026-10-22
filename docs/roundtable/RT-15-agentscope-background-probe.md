# RT-15：AgentScope 后台安全能力探针报告

- 状态：探针完成；真实 helper 压缩会触发 native memory flush 与 transcript offload，压缩安全验收未通过；生产 delegation 继续 suspended，未解除
- SDK：AgentScope 2.0.3（`io.agentscope:agentscope-harness` / `agentscope-core`）
- 测试：`services/agent-runtime/src/test/java/com/workpal/runtime/AgentScopeBackgroundProbeTest.java`
- 追加：2026-10-22 的 `subagentFactory` 验证见第 7 节；safe compaction 可通过，但失败归因和内置 `general-purpose` 仍阻断。
- 结论：**helper 压缩不安全，整体解除条件未满足。**

## 1. 探针方法

所有用例都通过公开的 `RuntimeEngine.execute()` 驱动真实 `HarnessAgent`。HTTP fixture 只承担两个角色：

- OpenAI-compatible 模型端点，按请求内容返回真实流式文本或 tool call；
- WorkPal 的 registration / terminal / tool-execution 后端桥。

没有使用 `scripted` runtime、mock child 或手工伪造的 terminal 事件。生产入口仍然关闭 delegation；探针只使用 `RuntimeEngine` 的 package-private 构造器跳过“暂停 delegation”这一项，其余 compaction、工具桥、注册、投递、取消路径与生产一致。

关键取值：

- 生产 helper 使用 `SubagentDeclaration` 默认值：`steps=10`、`persistSession=false`。
- 生产主 Agent 使用 `disableToolResultEviction()`、`disableMemoryHooks()` 和安全 compaction 配置。
- 压缩探针让 helper 每轮发起 6 个并行 `probe_note` 调用，每次工具结果约 1,800 字符；这样在第 50 条消息时上下文约 32,858 tokens，超过 stock 派生 keep 预算（8,000 tokens），使 compactor 能算出非零 cutoff，真正执行压缩。

### 用例清单

| 用例 | 验证点 |
| --- | --- |
| `childSessionsAreFreshAndNeverReuseTheParentConversation` | 派生 session、父子会话隔离、两次 spawn 互不复用 |
| `declaredHelperCompactionTriggersNativeFlushAndOffloadDespiteSuspension` | 真实 helper 压缩，以及 memory flush / memory ledger / transcript offload 产物 |
| `registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession` | 注册、terminal 归因、投递绑定 owning parent session |
| `cancellationIsOwnerOnlyStopsTheChildAndIsAttributedToItsTask` | 越权取消拒绝、真实终止、taskId 归因 |
| `childFailureIsFlattenedIntoACompletedTerminalInAgentScope203` | child 失败的 terminal 状态 |
| `agentScope203StillOffersNoHelperCompactionOrEvictionConfiguration` | SDK 公共 API 能力边界 |
| `productionConstructorStillRefusesNewDelegation` | 生产构造器仍不暴露 `agent_spawn` |

## 2. 已证明

### 2.1 child 使用独立 session，不复用父 session

- 两次 spawn 的注册回调分别携带不同的 `sessionId`，均为 spawn 时分配的 `sub-<uuid>`。
- `SubagentDeclaration` 的 `deriveChildSessionId`（`helper@<parent>#<user>`）只用于 child builder 的 `defaultSessionId`，不是实际执行的 session。
- 两次 spawn 的原生 `TaskRecord.parentSessionId` 相同，但都不同于 child session。
- child 模型请求中不包含父对话里的 `PARENT_ONLY_SECRET_7F3A`。

**结论：已证明。**

### 2.2 helper 真实压缩会触发 native memory flush、memory ledger 写入和 transcript offload

压缩探针在 helper 上下文中观测到一次真实压缩。临时打开 AgentScope debug 日志（未提交）得到：

```text
Compaction trigger: message count 50 >= 50
Compaction triggered: total=50 msgs / 32858 tokens, cutoff=36, keeping=14 msgs
Memory flush before compaction done
Offloaded 50 messages for agent=helper, session=sub-<uuid>
Compaction complete: 50 msgs → 1 summary + 14 tail = 15 total
```

模型请求与工作区产物进一步确认：

- 出现一次 memory flush 模型调用（memory extraction prompt）；
- 出现一次 compaction summary 模型调用，压缩后的 summary 被带入后续 helper 上下文；
- helper 工作区写入 `agents/helper/workspace/.../memory/2026-10-22.md`（当天 memory ledger）；
- helper 工作区写入 `agents/helper/sessions/sub-<uuid>.jsonl`（offload 的完整会话 transcript）；
- 后续 helper 模型请求携带 offload 指针 `The full conversation history has been saved to ...`。

机制（均已通过 2.0.3 字节码与真实运行确认）：

1. `buildDeclaredFactory` 不向 child builder 传递父级的 `compactionConfig` / `disableCompaction` / tool-result eviction 配置；declared helper 拿到 stock 默认值：`triggerMessages=50`、`flushBeforeCompact=true`、`offloadBeforeCompact=true`。
2. 同一路径会传递父级的 `disableMemoryHooks`，但 `ConversationCompactor.compactIfNeeded` 直接调用 `MemoryFlushManager.flushMemories` 和 `offloadMessages`，不经过 memory hook 开关，所以 `disableMemoryHooks` 拦不住这两个副作用。
3. `CompactionMiddleware.onReasoning` 在每次 ReAct reasoning 迭代都会执行，不是只包住初始调用。stock 配置先从模型窗口派生 token 预算（200k 窗口 → keep 8,000 tokens），消息数达到 50 时触发；小消息探针因 cutoff 为 0 被跳过，本探针用较大的工具结果把 cutoff 推到 36，压缩因此真实发生。

**结论：就“helper 压缩不触发不可读的 native memory flush 或 offload”这一验收项，未通过。**
helper 压缩不仅会写 WorkPal 不读取的 memory ledger，还会把完整会话 offload 到 native transcript，并让模型看到 offload 指针。这是解除 suspension 的阻断项。

### 2.3 registration、delivery、cancel 的最小闭环

- **registration**：spawn 结果被解析后，bridge 收到 `taskId`、`agentId=helper`、`sessionId`；同一父 Run 的多个 helper 各自注册。
- **delivery**：child 完成后，同一 parent session 的下一次 Run 收到结果提醒；另一个 Thread 的 Run 收不到；原生记录写入 `deliveredAt`。
- **cancel**：使用 user/space/bot/thread 不匹配的身份取消返回 `false`，不会产生 terminal；owner 取消返回 `true`，child 真实停止，之后不再触达 backend 工具，原生状态为 `CANCELLED`。
- **terminal 归因**：completion / cancel 事件都带正确的 `taskId` 与 `runId`。

**结论：registration、delivery、cancel 的最小探针已证明。**

### 2.4 生产入口仍关闭

`productionConstructorStillRefusesNewDelegation` 与既有 `DelegationSuspensionTest` 均确认：生产构造器不向模型暴露 `agent_spawn`，也不会生成原生 task record。

**结论：已证明，suspension 未被本次探针改变。**

## 3. 尚未证明 / 当前不支持

### 3.1 child 失败无法归因为失败（当前不支持）

child 模型返回 500 后，`AgentSpawnTool` 捕获 child 的 `RuntimeException`，把 `getMessage()` 当作正常字符串结果写回。结果是：

- terminal 状态为 `completed`，不是 `failed`；
- 原生记录也是 `COMPLETED`；
- 错误只以文本 `Error: Retries exhausted: 2/2` 存活在 result 中。

因此 WorkPal 无法仅凭 2.0.3 的 terminal 事件区分“child 成功”和“child 失败”，也无法稳定地把失败归因到 Task。**这是解除 suspension 的阻断项。**

### 3.2 原生 TaskRecord 不携带 child session（当前不支持）

`TaskRecord` 有 `subSessionId` 字段，但 `WorkspaceTaskRepository.putTask` 构造时传 `null`，SDK 内没有任何代码调用 `setSubSessionId`。实测记录中的 `subSessionId` 为空。

目前只有 WorkPal 的 registration body 带有 child session。RT-16 必须把该值持久化到 WorkPal 自己的 Task/Run/Attempt 记录，不能依赖原生 task record。

### 3.3 SDK 公共 API 不能为 declared helper 配置 compaction / eviction（当前不支持）

- `SubagentDeclaration.Builder` 只有 `steps` / `maxIters` 等字段，没有 compaction 或 eviction 配置方法。
- `asLeafSubagent()` 只阻止继续安装 subagent middleware，不会跳过 compaction / eviction。
- `HarnessAgent.Builder` 虽有 `disableCompaction()` / `disableToolResultEviction()`，但这些配置不会传递到 declared helper。
- `subagentFactory` 自定义工厂是潜在适配点，但它不会自动复用 declared helper 的 session 派生与约束；本任务未验证该路径，不能据此解除 suspension。

### 3.4 尚无可用的 helper 压缩安全通道

2.0.3 的 declared-helper 路径只有两个选择：

- 保持 stock compaction：压缩可以工作，但会触发 native memory flush、memory ledger 写入和 transcript offload（2.2 已证明）；
- 依赖现有 `disableMemoryHooks` / `disableToolResultEviction`：它们只覆盖 memory hook 和工具结果 eviction，不覆盖 compactor 的 flush/offload。

因此当前版本没有“既压缩又不产生不可读产物”的声明式配置。可行方向是升级 SDK 或使用自定义 `subagentFactory`，两者都必须重新跑本探针。

**结论：尚未证明 helper 在长任务下具备安全的上下文保护。**

## 4. 兼容适配与解除条件

### 4.1 可选适配方向（均未实施）

1. **等待 SDK 升级**：选择 declared helper 能继承父级安全 compaction / eviction 配置，或公开相关配置方法的版本；升级后必须重跑本探针。
2. **自定义 subagent factory**：用 `subagentFactory` 构建带 `disableCompaction()` 或安全 compaction 配置（关闭 `flushBeforeCompact` / `offloadBeforeCompact`）的 child。需要单独证明 spawn 的 session 派生、父子隔离、注册与取消仍成立。
3. **改为 WorkPal 可读的压缩存储**：如果必须保留压缩，flush 与 offload 必须写入 WorkPal 的 PostgreSQL 或可读工作区，而不是 native memory ledger / transcript；需要单独实现和审计。
4. **保持 declared helper + 父级预算**：限制 helper 迭代次数、并行工具数和单次结果大小，把上下文控制在压缩阈值内；这不能替代失败归因和 runtime identity 的修复。

### 4.2 解除 production suspension 必须同时满足

1. 选定并锁定一个 AgentScope 版本或自定义 factory，使 declared helper 的 compaction / eviction 可显式配置；真实 helper 跨越 50 条消息且超过 8,000 tokens 后，不产生 native memory flush、memory ledger 写入或 transcript offload。
2. child 失败能产生可归因的失败 terminal（或等价的可信失败通道），不能继续以 `completed` + 错误文本表示。
3. child session 由 WorkPal 持久记录，且 registration / terminal / cancel / delivery 全部通过 taskId 和 owning identity 绑定。
4. RT-16 的数据库注册事务、RT-17 的 revision、RT-18 的 delivery 闭环完成；`background_helper` feature gate 仍默认关闭。
5. 长任务探针证明 helper 上下文受控：不会因超过模型窗口而静默变成“成功”。
6. 本文件第 2 节的探针与既有 runtime / compaction / eviction / suspension 测试继续通过。

## 5. 验证命令与结果

```bash
JAVA_HOME="$JDK21_HOME" mvn \
  -Dtest='AgentScopeBackgroundProbeTest,CompactionBoundaryIntegrationTest,CompactionTokenBudgetTest,DelegationSuspensionTest,InterruptibleTaskRepositoryTest,MemoryCompactionPurgeIntegrationTest,ToolResultEvictionBoundaryTest,RuntimeIntegrationTest' \
  test
```

结果：63 tests，0 failures，0 errors（其中 RT-15 探针 7 tests）。

```bash
node --test docs/roundtable/verify-implementation-plan.test.mjs
```

结果：计划验证器通过（31 个任务、39 条 AC、96 个场景）。

## 6. 最终判定

| 验收项 | 结果 |
| --- | --- |
| helper 压缩不触发不可读 memory flush 或 offload | **未通过**：真实压缩触发 flush、memory ledger 写入和 transcript offload |
| child 使用派生 session，不复用父 session | 通过 |
| registration / delivery / cancel 最小探针 | 通过 |
| child 失败 / 取消稳定归因 | 取消通过；失败**当前不支持** |
| 探针失败时 production suspension 保持不变 | 通过 |
| Maven 定向测试使用真实 AgentScope 路径 | 通过 |

**因此：不解除 production suspension，不开启 `background_helper` gate，不进入 RT-16 实现。**
压缩安全、失败归因和 child session 持久化仍是阻断项；在 RT-16 补齐 WorkPal 侧记录与失败通道、并解决 helper 压缩副作用之前，后台 helper 不能进入生产。

## 7. 追加探针：自定义 subagentFactory 的适配边界

本节是 2026-10-22 的追加验证，保留第 1–6 节 declared helper 首次探针的事实，不覆盖历史结论。测试入口：`AgentScopeSubagentFactoryProbeTest`（8 tests）。生产构造器、`background_helper` gate 和 RT-16 均未改动；也没有使用私有 fork 或运行时反射 patch。

### 7.1 方法

- 通过公开的 `HarnessAgent.Builder.subagentFactory(name, description, Function<String, Agent>)` 注册工厂；工厂在每次 spawn 时新建一个只读子 `HarnessAgent`。
- 子 Agent 显式配置：`CompactionConfig.builder().flushBeforeCompact(false).offloadBeforeCompact(false).build()`、`disableMemoryHooks()`、`disableToolResultEviction()`、`disableSubagents()`、只读 toolkit、独立 workspace/state store、`disableSessionPersistence()`。
- 父 Agent 使用真实 `HarnessAgent`，模型端点仍是本地 OpenAI-compatible HTTP fixture；任务仓库使用 WorkPal 的 `InterruptibleTaskRepository`（与生产取消路径一致）。
- 由于本任务禁止修改生产代码，工厂探针没有向 `RuntimeEngine` 增加 factory 注入口；它直接驱动 HarnessAgent 和相同的 TaskRepository/ spawn 输出契约。`RuntimeEngine.registerBackground` 对 factory 是无感知的，仍从 spawn 输出的 `session_id` 读取 child session，这一路径未被本探针改写。

### 7.2 生命周期、session 与异常传播机制

1. **factory 入口**：`HarnessAgent.Builder.subagentFactory` 把 `Function<String, Agent>` 包装成 `SubagentFactoryEntry`；`buildSubagentEntries` 生成一个 `SubagentEntry`，其 declaration 为 `null`。工厂的 `Function` 只收到固定的 agent name，不收到 parent `RuntimeContext`；`SubagentFactory.create(RuntimeContext)` 的 context 被 builder 的适配 lambda 丢弃。
2. **session 派生**：`AgentSpawnTool` 在 declaration 为空时走非 declared 分支，为每次 spawn 生成随机 `task-<uuid>` 和 `sub-<uuid>`。两个 sibling 因此天然得到不同 session；child 通过 `DefaultAgentManager.invokeAgent` 的 `RuntimeContext` 收到自己的 `sub-<uuid>`。实际执行 session **不是** `deriveChildSessionId` 的结果。
3. **parent 正文隔离**：factory 每次创建新的 HarnessAgent 和新 state store；child 的 system prompt/任务消息中没有父聊天正文。探针在 child 请求中找不到 `PARENT_ONLY_SECRET_FACTORY_9C1`。
4. **失败传播**：`DefaultAgentManager.invokeAgent(...).block()` 的异常仍由 `AgentSpawnTool` 的 local supplier 处理。HTTP 500 被转成 `Error: Retries exhausted: 2/2`；即使 child 模型直接抛 `TypedFailureError extends Error`，Reactor 的 `block()` 仍把它包装成 `RuntimeException`，`AgentSpawnTool` 最终返回 `Error: ...TypedFailureError...`。`WorkspaceTaskRepository` 看到的是正常 supplier 结果，记录为 `COMPLETED`。
5. **取消**：原生 `TaskRepository.cancelTask` 会设置 cancel 标志和终态，但默认 `WorkspaceTaskRepository` 不会中断正在执行的 local supplier；WorkPal 的 `InterruptibleTaskRepository` 包装 supplier 并中断 worker，探针使用该仓库后取消能真实停止 child。factory 本身不改变这条路径。
6. **内置 general-purpose**：`buildSubagentEntries` 总是先加入 `general-purpose`，再追加 custom factory；factory 没有删除或替换内置项的公开方法。父 Agent 的 system prompt 仍列出 `general-purpose`，模型可以 spawn 它；它复制父 toolkit（包括 mutating 工具），只是 `asLeafSubagent()` 阻止继续嵌套。

### 7.3 逐项对比

| 能力 | declared helper（首次探针） | custom subagentFactory（本次） | 判定 |
| --- | --- | --- | --- |
| child 独立 session / sibling 不复用 | 通过（实际 `sub-<uuid>`） | 通过（每次 spawn 随机 `sub-<uuid>`） | 适配可行 |
| child 不继承父聊天 | 通过 | 通过 | 适配可行 |
| safe compaction | 未通过：stock flush/offload | **通过**：`flushBeforeCompact=false`、`offloadBeforeCompact=false` | 适配可行 |
| >50 msgs / >8k tokens 无 memory/offload 产物 | 未通过 | **通过**：max 50 msgs / 32,903 tokens，有 summary，无 flush/offload | 适配可行 |
| success / cancel / failure 可区分 | success/cancel 通过；failure 拍平 | success/cancel 通过；**failure 仍拍平** | **阻断** |
| registration / terminal / delivery identity | 通过（spawn 输出 + native record） | 通过（taskId + parentSessionId + sessionId） | 适配可行 |
| owner-only cancel 真实停止 | 通过（WorkPal interrupt wrapper） | 通过（同一 `InterruptibleTaskRepository`） | 适配可行 |
| WorkPal 取得 child session | registration body 的 `sessionId` | spawn 输出的 `session_id`；native `subSessionId` 仍为空 | 需要 WorkPal 持久化 |
| helper 只读 / 无嵌套 | declared leaf + 只读工具 | custom child 只读且 `disableSubagents()` 通过 | 适配可行 |
| 不暴露内置 unsafe agent | 未覆盖 | **未通过**：`general-purpose` 仍可 spawn 并继承父 mutating toolkit | **阻断** |

### 7.4 关键证据

- safe compaction 探针在压缩前观测到 **50 messages / 32,903 tokens**；出现 `SUMMARY` 模型调用，未出现 `FLUSH`、offload pointer、`memory/`、`memory/YYYY-MM-DD.md` 或 `sessions/*.jsonl`。
- 标准 child HTTP 500：terminal 和 native record 都是 `COMPLETED`，结果文本为 `Error: Retries exhausted: 2/2`。
- typed `Error` 探针：terminal 仍为 `COMPLETED`，结果文本为 `Error: ...$TypedFailureError: typed factory child model failure`；没有 `FAILED` terminal，也没有 typed error 字段。**不能**把这类文本匹配当作生产失败判断。
- 取消探针：foreign parent session 返回 `false` 且不改变状态；owner parent session 返回 `true`，状态为 `CANCELLED`，取消后只读工具调用数为 0。
- delivery 探针：同一 parent session 的下一次 Run 收到 child 结果，foreign session 收不到；native `deliveredAt` 被写入。
- child session：spawn 输出包含 `session_id: sub-<uuid>`；两个 sibling 不同；native `TaskRecord.subSessionId` 仍为空。WorkPal 只能从 spawn 输出持久化该身份。
- 内置 `general-purpose` 探针：custom factory 注册后仍能成功 spawn `general-purpose`，其 child tools 包含父级的 `probe_write`；因此“所有 helper 只读”不成立。

### 7.5 最终判定与下一步

**自定义 subagentFactory 可以作为“安全压缩 + 独立 session + 只读 leaf”的兼容适配基础，但不足以解除生产阻断。** 失败归因仍被 2.0.3 拍平，内置 `general-purpose` 仍提供绕过 custom factory 的 mutating 路径，child session 也没有进入 native TaskRecord。RT-16 继续阻断；production suspension 保持不动。

在继续实现 RT-16 前，至少需要 AgentScope 提供以下公开能力（不猜测不存在的版本号）：

1. **typed failure propagation**：child 的失败必须让 `BackgroundTask`/`TaskRecord` 进入 `FAILED`，并保留可读取的异常类型；不能由 `AgentSpawnTool` 把子异常转成 `COMPLETED` 文本。
2. **built-in agent 的可控暴露**：注册 custom factory 时能禁用/移除内置 `general-purpose`，或明确只暴露显式注册的 agent id；不能依赖模型不去选择内置 unsafe agent。
3. **child session 的 native 身份回传**：factory 创建时拿到本次 spawn 的 child session，或 `TaskRecord.subSessionId` 由 SDK 填充；否则 WorkPal 只能依赖 spawn 文本，无法形成稳定的数据库注册事务。
4. 继续保留可配置的 safe compaction（当前 custom factory 已能做到）和 WorkPal 的 interruptible cancel（现有实现已能真实停止 child）。

同名覆盖内置 `general-purpose` 未在本探针验证，不能写成已解决；私有 fork 和运行时反射 patch 明确不可接受（高维护成本）。下一步应先升级并重新运行 `AgentScopeSubagentFactoryProbeTest` 与 `AgentScopeBackgroundProbeTest`，再评估 RT-16。

### 7.6 验证命令与结果

```bash
JAVA_HOME="$JDK21_HOME" mvn \
  -Dtest='AgentScopeBackgroundProbeTest,AgentScopeSubagentFactoryProbeTest,CompactionBoundaryIntegrationTest,CompactionTokenBudgetTest,DelegationSuspensionTest,InterruptibleTaskRepositoryTest,MemoryCompactionPurgeIntegrationTest,ToolResultEvictionBoundaryTest,RuntimeIntegrationTest' \
  test
```

结果：**71 tests，0 failures，0 errors**。其中首次 RT-15 探针 **7/7**、factory 探针 **8/8**、`DelegationSuspensionTest` **3/3**。计划验证器与 node 测试结果见第 5 节同一命令，未因本次追加改变。
