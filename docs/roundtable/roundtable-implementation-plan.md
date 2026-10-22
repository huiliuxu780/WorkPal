# 圆桌模式实施任务

状态：可实施（终审通过）

依据：

- [产品需求](./roundtable-product-requirements.md)
- [架构骨架](./roundtable-architecture.md)
- [第一轮对抗审查](./roundtable-interrogation.md)
- [最终对抗审查](./roundtable-final-interrogation.md)
- [交互原型](./prototype/index.html)
- [原型约束](./prototype/DESIGN.md)

本文按可验证单元拆分开发工作。每个任务对应一个可以单独合入的 PR。任务按拓扑顺序排列。`依赖` 字段由验证脚本检查。

## 1. 实施边界

1. PostgreSQL 中的 `Thread`、`Message`、`Task`、`Run`、`Attempt`、`Event`、`Intervention`、`BackgroundAgentTask` 和 `DeliveryRecord` 仍是事实来源。
2. 不新增 Round、RoomTurn、Work、AgentConversation 或 TaskAmendment 实体。
3. 跨会话新任务创建独立 Task 和 Run。只有显式 `targetTaskId` 的补充才进入既有 Run。
4. 每个后台 helper 创建独立产品 Task 和 Run。`BackgroundAgentTask` 只表示某个 Attempt 的 runtime 投影。
5. Web 只显示服务端投影，不推断路由、审批归属、工作状态或百分比。
6. AgentScope 是唯一生产执行器。`scripted` 只用于确定性测试。
7. 未闭环能力保持关闭，并返回明确的未启用错误。

## 2. 待定产品参数

这些参数不改变核心类型。启用相关 feature gate 前需要确认取值。

| ID | 决策 | 建议默认值 | 影响任务 |
| --- | --- | --- | --- |
| D1 | 群工作中最近完成项的默认窗口和分页大小 | 24 小时，每页 20 项 | RT-20、RT-23 |
| D2 | 四项能力是否独立灰度 | private pair、public collaboration、`message_group`、background helper 分别控制 | RT-00、RT-29 |
| D3 | support 结果如何被 requester 引用 | 使用 locator，不复制全文 | RT-05、RT-18、RT-24 |
| D4 | 是否允许永久删除 Bot | 第一版只允许停用和软删除 | RT-02、RT-03 |

## 3. 交付阶段

| 阶段 | 任务 | 结束状态 |
| --- | --- | --- |
| 0. 验收底座 | RT-00 | gate 和计划验证器可用 |
| 1. 协议与 pair | RT-01 至 RT-05 | private pair 后端闭环，但 gate 仍关闭 |
| 2. 群公开协作与回执 | RT-06 至 RT-10 | 两类 Agent 协作 UI 闭环 |
| 3. 跨群与审批 | RT-11 至 RT-12 | 跨群新任务和来源审批闭环 |
| 4. Task 补充 | RT-13 至 RT-14 | 原始要求、修订和状态转换闭环 |
| 5. AgentScope 后台执行 | RT-15 至 RT-18 | 安全能力、身份、revision 和 delivery 闭环 |
| 6. 授权与群投影 | RT-19 至 RT-23 | 取消、资源、工作和右栏闭环 |
| 7. 群行为与运行准入 | RT-24 至 RT-29 | 路由、session 排队、checkpoint 和后台生产入口闭环 |
| 8. 集成与灰度 | RT-30 | 全场景验收并按 gate 灰度 |

阶段是 feature gate 的合流条件，不是人员排期。除 RT-00、RT-01 和最终 RT-30 外，不要求完成整个上一阶段才启动下一阶段任务；只看任务自己的 `依赖`。

### 3.1 并行工作流

RT-00 和 RT-01 合入后，至少可以同时启动六条开发线。每条线可以由独立负责人维护自己的分支和 PR 队列。

| 工作流 | 可并行任务链 | 主要交付面 | 首次合流点 |
| --- | --- | --- | --- |
| A. 固定 pair | RT-02 → RT-03 → RT-05 → RT-09 | pair identity、访问策略、private delivery、只读浮窗 | RT-19 |
| B. 群内公开协作 | RT-06 与 RT-07 并行；之后 RT-08、RT-10 | public `message_bot`、mention、公开委派 UI、多 mention | RT-24 |
| C. 跨群调度 | RT-11 → RT-12 | `message_group`、成员审批、跨会话回流 | RT-19 |
| D. Task 修订 | RT-13 → RT-14 | instruction log、prompt 迁移、状态转换 | RT-17、RT-20、RT-27 |
| E. AgentScope 后台 | **暂停**：RT-15 两轮探针后，RT-16 → RT-17 → RT-18 不启动；先验证新 AgentScope 版本的三项最低能力 | SDK 探针、后台身份、revision、delivery | 待定 |
| F. 群数据与 Web | RT-21 → RT-22；RT-20 可与其并行；之后 RT-23 | 详情、资料库、成员、例行任务、工作页 | RT-30 |
| G. session 与路由 | RT-25；之后 RT-26 与 RT-27 并行 | admission lease、Runtime checkpoint、确定性 steering | RT-28、RT-24 |

并行约束：

1. RT-01 的类型和接口签名合入后视为冻结面；后续任务不得在各自页面或 adapter 内复制协议分支。
2. 一个共享文件同一时间指定一个 owner。其他工作流通过已冻结接口集成，必要变更单独提交小型 contract PR，不把跨线重构夹进功能 PR。
3. RT-19、RT-24、RT-28 和 RT-30 是合流任务，不是前置大设计。它们只集成已完成能力并补跨线测试。
4. Web 任务可以在后端 contract 合入后使用类型化 fixture 开发，但 feature gate 保持关闭；不得伪造生产成功结果。
5. 每个任务独立建 PR、独立跑验收。不要把同一工作流的整条链压成一个长期分支。

### 3.2 首轮派工顺序

这张表表示“依赖一满足就发出去”，不是迭代批次。前一行中的其他任务不需要全部完成。

| 解锁条件 | 立即可派任务 |
| --- | --- |
| 现在 | RT-00 |
| RT-00 合入 | RT-01、RT-15、RT-21 |
| RT-01 合入 | RT-02、RT-04、RT-06、RT-07、RT-11、RT-13、RT-25 |
| RT-02 合入 | RT-03 |
| RT-07 合入 | RT-10 |
| RT-13 合入 | RT-14；若 RT-15 也完成，同时派 RT-16 |
| RT-21 合入 | RT-22 |
| RT-25 合入 | RT-26；若 RT-11、RT-14 也完成，同时派 RT-27 |
| RT-03、RT-04 合入 | RT-05 |
| RT-06、RT-07 合入 | RT-08 |
| RT-04、RT-11 合入 | RT-12 |
| RT-14、RT-16 合入 | RT-17 |
| RT-16、RT-17 合入 | RT-18 |
| RT-05 合入 | RT-09 |
| RT-14、RT-18 合入 | RT-20 |
| RT-04、RT-05、RT-06、RT-12、RT-18 合入 | RT-19 |
| RT-14、RT-20、RT-22 合入 | RT-23 |
| RT-08、RT-10、RT-11、RT-18、RT-19、RT-20、RT-27 合入 | RT-24 |
| RT-04、RT-16、RT-18、RT-19、RT-25、RT-26 合入 | RT-28 |
| RT-15、RT-16、RT-18、RT-28 合入 | RT-29 |
| RT-02 至 RT-29 全部满足依赖 | RT-30 |

## 4. 开发任务

### RT-00 建立 gate 和计划验证器

独立任务单：[RT-00](./tasks/RT-00.md)

目标：让未完成能力保持关闭，并让任务覆盖和依赖可以自动检查。

输出：

- 四个独立服务端 feature gate。
- 稳定的未启用错误契约。
- 可解析的任务、依赖、AC 和场景覆盖格式。
- 验证器及负例测试。

验收：

- 所有 gate 默认关闭。
- 删除一个实施 owner、增加重复任务、未知 ID、未知依赖或依赖环时，验证器失败。
- 集成验收任务不能充当 AC 或场景的唯一实施 owner。
- `node --test docs/roundtable/verify-implementation-plan.test.mjs` 通过。

依赖：无。

覆盖：AC12。场景 F06。

### RT-01 固化跨模块类型

目标：先固定 destination、origin、Task revision、后台执行身份、delivery batch 和群投影类型。

输出：

- branded `TaskId`、`RunId`、`AttemptId` 和 `RuntimeTaskId`。
- `CollaborationDestination`、`CollaborationOrigin` 和 locator。
- `TaskInstructionEnvelope` 和 `RunInstructionRef`。
- `BackgroundExecutionRef` 和 `DeliveryBatchKey`。
- group read contract 和穷举分支测试。

验收：

- contracts 在边界解析外部数据。core 不接收松散对象。
- destination union 没有默认分支。
- receipt 不用 `toBotId` 表示 group。
- TypeScript check 和 contracts、core 定向测试通过。

依赖：RT-00。

覆盖：AC23、AC39。场景 C08、Q05、O08。

### RT-02 增加固定 Agent pair 身份

目标：同一 workspace 内的一对 Bot 只有一个长期 `agent_pair` ChatGroup 和 Thread。

输出：

- `ChatGroup.kind` 和 canonical `pairKey`。
- workspace 范围内的无序 pair 唯一约束。
- `AgentPairRepository.getOrCreate`。
- 并发首次创建、反向联系和事务冲突重试测试。

验收：

- A 到 B、B 到 A 和并发首次联系返回同一个 Thread。
- 名称和头像变化不改变 pair identity。
- Prisma migration 兼容现有普通群数据。
- DB check 和测试通过。

依赖：RT-01。

覆盖：AC18、AC22、AC25。场景 Q01、Q02、Q03、Q08。

### RT-03 实施 pair Thread 访问策略

目标：用户可以从 receipt 只读查看自己有权访问的 pair 历史投影，但 pair 不成为用户可管理的会话。

输出：

- list、read、write、react、archive、member mutation 和 Routine binding 规则。
- receipt locator 驱动、逐条按 origin source Thread 授权的只读接口。
- 服务端列表、搜索、群选择器和未读过滤。
- 停用和软删除后的历史读取规则。

验收：

- 所有人类消息、reaction、成员变更、归档和 pair 内审批写入都被服务端拒绝。
- pair 不出现在普通列表、搜索、群选择器或未读数中。
- 同一 pair 承接多个来源时，用户只看到其有权读取的 origin；分页、定位和总数不会侧漏未授权消息。
- 软删除保留历史，新建替代 Bot 不继承旧 pair。
- API 和 DB 定向测试通过。

依赖：RT-02。

覆盖：AC17、AC18、AC25。场景 Q06、Q08、M07、M08。

### RT-04 实施来源 Thread 审批

目标：执行发生在群或 pair Thread 时，用户仍可在原始可见 Thread 完成审批或补充。

输出：

- `executionThreadId` 与 `presentationThreadId` 分离的 Intervention contract。
- origin-aware Intervention 创建、展示、授权提交和恢复。
- 来源 receipt 与 execution origin 校验。
- 重复提交、过期、撤回和参数 revision 失效处理。

验收：

- pair Run 的审批和补充可以从来源 Thread 提交。
- pair Thread 继续拒绝所有人类写入。
- 决策只恢复绑定的 Run 和 Attempt。
- 同一个 Intervention 只消费一次。
- API、DB 和 Web 定向测试通过。

依赖：RT-01。

覆盖：AC20。场景 P01、P02、P03、P04、P07、P08。

### RT-05 把 private `message_bot` 迁入 pair Thread

目标：保留现有 collaboration lineage、hop、去重和回流，但把私下协作完整记录写入固定 pair Thread。

输出：

- private-pair 原子投递事务。
- 来源 Thread 的轻量 receipt。
- pair Thread 的 inbound Message、Task 和 support Run。
- 每个 target Run 的持久 origin。
- target、hop、loop、timeout 和 delivery dedupe 回归测试。

验收：

- 私下 A 到 B 不再写入 B 的用户单聊。
- 多目标通知仍产生独立 pair Thread 和独立 Run。
- 结果、取消、重试和审批按 origin 返回。
- delivery key 重放不重复写入或创建 Run。
- adapters 和 API 定向测试通过。

依赖：RT-03、RT-04。

覆盖：AC12、AC16、AC17、AC19、AC20、AC21、AC23。场景 D02、D03、D05、D06、D07、D08、X05、X06、X07、F01、F07、Q04、Q05、Q07、O02。

### RT-06 增加群内 public `message_bot`

目标：Agent 可以在当前群公开委派群成员，目标 Agent 从真实 support Run 回应。

输出：

- current-group 分支的成员校验和原子写入。
- 群 Thread 内的 collaboration Message、Task 和 support Run。
- 安全开放后的 `filterBuiltinToolsForThread`。
- 一次 source Run 多目标投递的独立调用数据。

验收：

- 只有当前群成员能成为 public target。
- inbound 和 outbound 都留在同一个群 Thread。
- 前端不伪造目标 Agent 的确认消息。
- 只有 destination-aware dispatch 上线后才开放群聊 `message_bot`。
- adapters 和 API 定向测试通过。

依赖：RT-01。

覆盖：AC01、AC02、AC03。场景 R04、D01、C01。

### RT-07 增加结构化 Agent mention

目标：消息中的 Agent mention 使用稳定 Bot ID，显示头像和名字，并导航到用户与该 Agent 的长期单聊。

输出：

- mention 写入、读取和渲染契约。
- 可访问的 mention link。
- 旧纯文本消息的无链接回退。
- 键盘和导航测试。

验收：

- 点击 mention 只导航，不调用工具，也不创建 Run。
- Bot 改名后保留 identity。
- Web 不从裸文本正则推断链接。

依赖：RT-01。

覆盖：AC39。场景 R02、M01。

### RT-08 渲染公开群委派消息

目标：把 public collaboration block 显示为自然的公开 `@` 委派，不复用 private receipt UI。

输出：

- 公开委派正文、发送者和目标 mention。
- 同一 source Run 相邻调用的视觉合并。
- 独立投递状态和失败状态。
- 公开消息的键盘与窄屏行为。

验收：

- 视觉合并不改变底层独立 Run、重试或取消。
- 公开委派不会打开 pair 浮窗。
- 目标 Agent 的确认来自真实 Run。
- Web 组件测试和 Playwright 断言通过。

依赖：RT-06、RT-07。

覆盖：AC02、AC03。场景 R04、D01、C01。

### RT-09 实现 private receipt 和 pair 浮窗

目标：来源只显示轻量投递痕迹，用户按需打开经 origin 授权过滤的 pair 历史。

输出：

- 单目标 receipt 独立行。
- 多目标 receipt 紧凑 Agent 名单。
- 全尺寸只读浮窗和 A、双向关系、B 组合胶囊。
- 消息定位和更早历史加载。

验收：

- 单目标 receipt 不先显示任务正文。
- 多目标名单只显示头像和 Agent 名称。
- 选择一个 Agent 不泄露第三个 Agent 的消息。
- 浮窗没有输入框和写操作。

依赖：RT-05。

覆盖：AC19、AC24、AC37、AC38。场景 D06、Q06、Q07。

### RT-10 扩展多 mention 指令分段

目标：稳定处理“@A 做 X，@B 做 Y”，同时避免从普通提及中创造任务。

输出：

- 基于 typed mention span 的命令分段器。
- single owner、explicit multi 和定向多任务判定表。
- 无法可靠分段时的澄清结果。
- 中英文标点、交错文本、重复 mention 和空片段测试。

验收：

- 明确多目标命令创建独立 Run。
- 普通提及不派活。
- 模糊输入不执行部分任务。
- core property test 和 API 路由测试通过。

依赖：RT-07。

覆盖：AC09。场景 U06、U07、R03。

### RT-11 实施已入群 Bot 的 `message_group`

目标：用户可以在 A 的单聊要求 A 去群 G 做一个新任务。

输出：

- 窄 `message_group` 工具和 schema。
- group target、成员和权限校验。
- 来源 receipt、目标消息、独立 Task 和 owner Run 的原子事务。
- 目标 Run 先保持 queued，并通过抽象的 session admission 请求执行资格。
- 来源状态更新和目标 Thread locator。

验收：

- 跨会话新任务不进入 A 的其他 active Run。
- `message_group` 不接受 `targetTaskId`。已有 Task 的补充只走 RT-13 和 RT-14。
- A 只有后台任务时，新 Run 与后台任务并存。
- 来源 receipt 与目标消息要么一起提交，要么都不提交。
- gate 在 RT-25 的 session admission 上线前保持关闭。
- adapters、API 和集成测试通过。

依赖：RT-01。

覆盖：AC13、AC21。场景 X01、X03、X07。

### RT-12 增加跨群成员审批和恢复

目标：A 不在目标群时，只在用户有成员管理权的情况下请求一次性加群审批。

输出：

- 与原始 `message_group` 绑定的 Intervention。
- 批准后的权限重校验和原子加群续跑。
- 拒绝、过期、撤回和重复决策处理。
- 来源单聊的审批和最终状态。

验收：

- 没有成员管理权时直接失败，不显示假审批。
- 批准前不向目标群写消息。
- 批准时重新校验用户、Bot、群和参数 revision。
- 拒绝或过期不加群，也不创建目标 Run。

依赖：RT-04、RT-11。

覆盖：AC14。场景 X04、P02、P03、P04、P07、P08。

### RT-13 建立 Task 指令日志并迁移 prompt 路径

目标：补充要求使用明确 `targetTaskId`，保留原始 prompt，并形成服务端排序的 instruction envelope。

输出：

- 经授权校验的 `targetTaskId`。
- append-only Message 和 `task.amended` Event。
- Task revision 聚合值和服务端 seq。
- `TaskInstructions.append` 与 `readEnvelope`。
- 所有 `Task.prompt` 写入者和 executor、retry 消费者的迁移。

验收：

- 追问回答、选项回答和补充都不覆盖原始 `Task.prompt`。
- 零个或多个自然语言候选时不写 amendment。
- 并发请求按服务端 seq 排序，重复请求只追加一次。
- “原任务、追问回答、amendment、retry 或 follow-up”测试保留完整历史。

依赖：RT-01。

覆盖：AC26、AC31。场景 A08。

### RT-14 按 Task 状态应用补充

目标：active、queued、completed、failed 和 cancelled Task 使用明确的状态转换。

输出：

- active Run 的 Task 绑定 steering。
- queued Run 在 lease 时读取最新 envelope。
- completed Task 的 follow-up Run。
- failed 或 cancelled Task 的 record-only 路径和显式 retry。
- 旧结果、补充和当前要求的读取 API。

验收：

- steering 不进入同一 Agent 的其他 Run。
- queued Task 不创建竞争 Run。
- completed Task 保留旧结果并显示“追加复核”。
- failed 或 cancelled Task 不因补充自动复活。

依赖：RT-13。

覆盖：AC27、AC28、AC30。场景 A01、A02、A06、A07。

### RT-15 验证 AgentScope 后台安全能力

目标：先证明选定 AgentScope SDK 可以安全运行后台 child，再允许实施生产入口。

输出：

- 可用 SDK 版本或兼容适配方案。
- 真实 child session 派生测试。
- 真实压缩测试和 memory 行为断言。
- registration、delivery 和 cancel 的最小探针。
- suspension 解除条件文档。

验收：

- helper 压缩不触发不可读的 native memory flush 或 offload。
- child 使用派生 session，不复用父 session。
- 探针失败时 production suspension 保持不变。
- Maven 定向测试使用真实 AgentScope 路径，不用 scripted 代替。

依赖：RT-00。

覆盖：AC04。场景 B01。

交付记录：[RT-15 AgentScope 后台安全能力探针报告](RT-15-agentscope-background-probe.md)。结论：真实 helper 压缩会触发 native memory flush、memory ledger 写入和 transcript offload，压缩安全验收未通过；失败归因与 child session 持久化也未满足，delegation 继续 suspended。
追加验证（2026-10-22）：custom `subagentFactory` 可在 factory 内关闭 flush/offload 并隔离 child session，但失败归因仍被 `AgentSpawnTool` 拍平，且内置 `general-purpose` 仍暴露 mutating 工具；RT-16 继续阻断。详见报告第 7 节。

### RT-16 建立后台执行身份和注册事务

**状态：暂停（2026-10-22）。** RT-15 两轮探针确认失败归因、内置 `general-purpose` 暴露和 child session native 回传仍未满足。不启动 RT-16；不开启 `background_helper`；不接受文本匹配失败状态；不继续堆 WorkPal 侧后台代码。唯一允许的下一步是验证满足三项最低能力的新 AgentScope 版本，详见 [RT-15 报告第 8 节](RT-15-agentscope-background-probe.md)。

目标：每个 helper 都有独立产品 Task、Run、Attempt 和 runtime task identity，并通过崩溃安全协议启动。

输出：

- `BackgroundAgentTask.runtimeTaskId`。
- 指向产品 Task、Run、Attempt 和 consumed revision 的 nullable 持久关系。
- child Task、Run、Attempt 和 background launch command 的数据库事务。
- 幂等 launch key、AgentScope acknowledgement 和 launch reconciliation。
- 一个父 Run 创建多个 helper 的唯一性和查询。
- TurnPolicy 与 Runtime safety gate。
- 旧格式 live row 的 legacy callback、cancel 和 delivery 兼容路径。

验收：

- 工具返回产品 `taskId`，内部 runtime ID 不暴露给用户。
- 一个父 Run 的两个 helper 拥有不同 Task、Run、Attempt 和 runtime task identity。
- 启动失败把 Task/Run 转为明确失败，不留下虚假的 running 节点。
- 在数据库提交后、runtime 启动后和 ack 前注入崩溃，reconciler 都收敛到一个已启动任务或明确失败。
- 滚动升级时旧格式 live task 继续完成、取消和投递，drain 后才移除 legacy 路径。
- AgentScope 是唯一生产执行器。

依赖：RT-13、RT-15。

覆盖：AC04。场景 B01、P06、M04、M05、M06。

### RT-17 处理后台 revision 和迟到结果

目标：区分只改变输出口径的补充和使输入失效的补充，不让旧 revision 覆盖新要求。

输出：

- amendment impact 的确定性分类接口。
- 输出口径补充的分类 Event，供 RT-18 的 delivery synthesis 消费。
- 输入失效时的旧 Run 取消和同 Task 新 Run。
- consumed revision 和 terminal result fence。
- 等审批时的 revision 失效规则。

验收：

- 输出口径变化不伪装成实时修改 helper。
- 输入变化创建新 Run，不把 Attempt 当作新输入。
- 旧 revision 结果只保留审计，不能成为当前结果。
- 一个父 Run 的两个 helper 只推进命中 Task 的 revision。

依赖：RT-14、RT-16。

覆盖：AC29。场景 A03、A04、A05、B08、P07。

### RT-18 完成后台生命周期和隔离 delivery

目标：后台任务的进度、失败、取消、重试、恢复和结果回流由持久记录驱动，并按正确身份分批。

输出：

- heartbeat、progress、terminal、cancel 和 retry 写入。
- 包含 Thread、Bot、origin、execution Task、execution Run、Attempt、runtime task 和 revision 的 delivery batch key。
- terminal callback 的 Attempt-level compare-and-set。
- DeliveryRecord 和 delivery Run 的幂等链路。
- launch outbox、Runtime 重启、ack 丢失和重复事件恢复。
- 工具 lease 排队状态。

验收：

- 同群不同 Bot 的结果不会由错误 Bot 发布。
- 同 pair 不同来源和不同 revision 不进入同一 delivery Run。
- 同一父 Run 的两个 helper 即使 revision 数字相同，也不进入同一 delivery Run。
- 被替代 Attempt 的迟到失败或成功只写审计，不创建 DeliveryRecord。
- retry 在同一 Task 和 Run 下创建新 Attempt，不重复工作节点。
- cancel 后的迟到结果不能复活任务。
- 同一 Bot 的普通 Run 与后台任务并存。

依赖：RT-16、RT-17。

覆盖：AC05、AC10、AC12。场景 C02、C05、C07、B02、B03、B04、B05、B06、B07、F05、F06、M07、O01、O02、O07。

### RT-19 收紧取消、成员和资源边界

目标：暂停、取消和权限变化只影响绑定的工作路径。

输出：

- scoped Intervention 的统一校验器。
- 精确 Run、Task、root descendants 和跨会话 child 取消 API。
- Agent 被移出群时的授权撤销和 Run 终止。
- 加入后的 Thread 可读范围和 private pair 独立性。
- 资源授权、tenant 和一次性批准检查。

验收：

- 决策、撤销和取消只改变绑定的 Run/Task；Runtime 排队与 checkpoint 隔离由 RT-25 负责。
- 移出群后不能继续访问群资源或接受 public 委派。
- 移出群不影响同 workspace private pair。
- 取消一个 child 不停止目标群其他根任务。
- 资源权限不沿委派链继承。

依赖：RT-04、RT-05、RT-06、RT-12、RT-18。

覆盖：AC07、AC14。场景 U08、X08、C04、P06、F02、M01、M02、M03、M04、M05、M06、M08、O06。

### RT-20 建立群工作和审计投影

目标：从持久事实重建 active 和 recent 工作，不新增 Work 表，也不显示百分比。

输出：

- `GroupQueries.listWork` 和 `getWork`。
- 面向用户的离散状态、最近事件和下一等待项。
- active 加 recent 的分页。
- 重连和乱序下的稳定 reducer。

验收：

- 删除进程内缓存后查询结果不变。
- API 不返回虚构百分比。
- 同一 Agent 的普通 Run 和后台工作可以同时存在。
- 部分完成、等待、失败和取消有不同状态。

依赖：RT-14、RT-18。

覆盖：AC11、AC34。场景 C01、C02、C04、C05、C08、F08、O05、O07、O08。

### RT-21 补齐群资料、例行任务和成员查询

目标：右栏读取真实 group scope 数据，不从全局列表做客户端过滤。

输出：

- group-scoped artifact 分页。
- 按目标 Thread 查询的 Routine 列表。
- 用户加 Agent 的成员列表和身份数据。
- 资料、例行任务和成员授权测试。

验收：

- Artifact 分页在服务端按 group scope 过滤。
- Routine 仍有具体执行 Bot。
- Agent 数量不包含当前用户。
- 无权文件不因群委派被复制或暴露。

依赖：RT-00。

覆盖：AC32、AC35、AC36。场景 M01、M04、M05、M06。

### RT-22 还原群聊胶囊和右栏基础页

目标：把确认后的详情、资料库、成员和例行任务交互接到生产数据。

输出：

- 中间上部可开合右栏的群聊胶囊。
- 用户加 Agent 的真实堆叠头像。
- 群名单击编辑、失焦或 Enter 保存和 Esc 取消。
- 详情、资料库和成员页。
- 无框新增入口、无成员行边框和无资料整组外框。

验收：

- 胶囊和右栏使用同一组身份数据。
- 群名同步到胶囊、会话标题和输入框目的地。
- “工作”页签不显示数量。
- 键盘、hover 和窄屏行为可用。
- Playwright 与确认后的原型关键截图对比通过。

依赖：RT-21。

覆盖：AC32、AC33、AC34、AC35、AC36。场景 U01、M01。

### RT-23 实现工作页和 Task 详情

目标：展示负责人、状态、当前要求和最近事件，不暴露 Attempt 内部细节。

输出：

- active 和 recent 工作列表。
- 离散工作状态。
- 原要求、补充时间线和当前有效要求。
- 补充要求和精确停止入口。

验收：

- 页面不显示百分比。
- 消息 chip、工作页和 Task 详情命中同一个 `taskId`。
- 普通视图不展示 runtime task、lease、hop 或 revision 编号。
- 精确停止只影响目标节点。

依赖：RT-14、RT-20、RT-22。

覆盖：AC26、AC30、AC31、AC34。场景 U08、A01、A06、O08。

### RT-24 补齐群路由、冲突和收尾行为

目标：保留现有 Group Router，补齐用户插话、独立回应、冲突呈现、状态消息和有条件收尾。

输出：

- single owner、reply target、explicit mention 和 explicit multi 测试。
- active Task steering、后台旁路和新目标加入测试。
- Agent 拒绝、阶段进展、结论冲突和部分失败消息规范。
- handoff 与 `message_bot(intent=...)` 边界测试。
- 来源 owner 的跨会话二次汇报。

验收：

- 普通消息只选一个 owner。
- 点名新 Agent 不取消当前说话者或后台任务。
- 用户补充只 steering 明确命中的 Task。
- 冲突结果保留来源和证据。
- 结束根任务只取消它的后代。

依赖：RT-08、RT-10、RT-11、RT-18、RT-19、RT-20、RT-27。

覆盖：AC03、AC05、AC06、AC07、AC08、AC21。场景 U01、U02、U04、U05、U07、R01、R02、R03、R05、R06、R07、R08、D04、F03、F08、O03、O04、O05、O06、O07。

### RT-25 实施持久 session admission lease

目标：让独立 Task/Run 公平、可恢复地串行进入同 Bot、同 Thread 的 AgentScope chat session。

输出：

- 与 Runtime chat session key 一致的持久 admission ownership。
- 带 expiry、heartbeat 和单调 fence 的 admission lease；Runtime 调用与完成 CAS 携带 fence。
- 每次 Runtime 调用前预持久化的 execution fence 和 suspension key。
- queued Run 的公平唤醒、fenced release 和 recovering 状态。
- Runtime 409 到 queued 状态的转换，不把 Run 标为失败。
- dedicated computer 与 chat admission 相互独立的租约规则。

验收：

- 同 Bot、同 Thread 的第二个独立 Run 保持 queued，前一个 Run 释放 session 后才进入 AgentScope。
- worker 在 acquire 后、Runtime 执行中和 release 前崩溃时，owner 进入 recovering；旧 worker 的迟到完成不能覆盖新 fence。
- 没有 RT-26 提供的 Runtime `clean | detached` 证明时，recovering owner 不被释放。
- dedicated computer 排队不阻止 Agent 基于已有上下文回复。
- PostgreSQL 并发、租约过期、重复 acquire/release 和 Runtime 409 定向测试通过。

依赖：RT-01。

覆盖：AC15。场景 F04。

### RT-26 隔离和恢复 AgentScope pending state

目标：Run 等待审批或输入时安全释放 chat admission，而且后续 Run 不会继承、回答或批准旧 Run 的 pending call。

输出：

- 按 Run、Attempt 和 pending request 隔离的 Runtime checkpoint contract。
- Runtime `inspectAndDetach`、`resume` 和 `clean | detached` proof。
- Runtime pending state 从创建时就绑定 execution fence；暴露 suspended 响应前原子 snapshot-and-detach。
- checkpoint acknowledgement、恢复决定和答案的幂等持久化。
- resume 前的新 execution fence 和 suspension key；新增 Thread 上下文合并规则。
- RT-25 recovering owner 的安全释放接点。

验收：

- Run A 安全脱离 pending state 后释放 admission；同一 Bot、同一 Thread 的 Run B 可以完成独立回复。
- Run B 的 prompt、批准或答案不能恢复 Run A；Run A 只消费自己的 request identity。
- 在 pending state 写入、suspended 响应、checkpoint ack 和 admission release 任一边界注入崩溃，都不会把匿名 pending state 留给下一 Run。
- Run A 恢复后再次阻塞时使用新的 execution fence 和 suspension key，第二次崩溃仍可恢复。
- Runtime 暂时不可达时 owner 保持 recovering，不以可用性换跨 Run 错误执行。
- 真实 AgentScope 交错测试覆盖 A 暂停、B 回复、A 恢复和二次暂停。

依赖：RT-25。

覆盖：AC10。场景 C06、P05、F04。

### RT-27 实施确定性 steering 和 session 排队接入

目标：新要求、Task 补充和跨会话请求使用确定性规则选择 steering 或独立 queued Run。

输出：

- 唯一候选、显式 `targetTaskId` 和多候选的路由判定。
- 新独立 Run 与 RT-25 admission queue 的接入。
- Task amendment 与普通新任务的分流。
- 不依赖数据库返回顺序的候选排序和拒绝规则。

验收：

- 普通 `@A` 只有一个可接收候选时 steering。
- 多个候选且无 `targetTaskId` 时创建独立 queued Task/Run，不任选一个。
- 跨会话新任务不进入无关 active Run；明确 Task 补充只命中对应 Run。
- 数据库查询顺序不能决定 steering 目标。
- 同 Bot、同 Thread 的独立 Run 通过 RT-25 排队，不把 Runtime 409 标成失败。

依赖：RT-11、RT-14、RT-25。

覆盖：AC06、AC15。场景 U03、X02、C03。

### RT-28 实施 blocked helper 的受控续跑

目标：只读 helper 需要受控动作或用户输入时，由用户可见的 continuation Run 承接，不给普通 delivery Run 开工具。

输出：

- `BlockedHelperRequest` 的 `action | input` 判别联合、持久 Event、InputRequest 答案与幂等消费状态。
- `background_continuation` Run、来源 Intervention/InputRequest 和最小工具 allowlist。
- 独立的 Runtime `background_continuation` scope；session key 包含 continuation Run/Attempt，不占 chat admission，也不复用 tool-less auxiliary scope。
- 批准、拒绝、回答、过期和父 Run 已结束时的恢复。
- 动作完成后创建新 Attempt 或新 Run 的规则。

验收：

- 普通 delivery Run 继续 tool-less。
- 父 Run 已结束时，用户仍能从来源 Thread 批准或拒绝。
- helper 缺少信息时，来源 Thread 能展示问题、校验并持久化答案；pair Thread 保持人类不可写，答案只被对应 request 消费一次。
- 批准只开放请求中经过授权的动作和参数。
- 拒绝或过期不执行动作，helper Task 保留可解释终态。
- continuation 等待审批或答案时，同一 Bot 能在同一来源 Thread 完成新的普通回复；恢复执行使用独立 scope，不争用 chat admission。
- 真实 AgentScope contract test 证明该 scope 可携带精确 allowlist，普通 auxiliary 和 delivery scope 仍拒绝工具。

依赖：RT-04、RT-16、RT-18、RT-19、RT-25、RT-26。

覆盖：AC10、AC20。场景 B04、P01、P02、P03、P04、P05、P06。

### RT-29 恢复生产 `run_subagent(background:true)`

目标：把已验证的 SDK、安全身份、生命周期和续跑能力接到真实生产工具入口。

输出：

- `run_subagent` 的 `background?: boolean` schema。
- 同步默认语义和后台语义的跨语言映射。
- AgentScope child 注册、状态回调和取消 wiring。
- 全部安全探针通过后的 production suspension 解除。
- 任一前置能力关闭时的明确拒绝。

验收：

- 省略 `background` 时保持现有同步语义。
- `background:true` 返回产品 `taskId`，父 Run 可以继续或结束。
- gate 未开启或安全探针失败时，Runtime 不暴露后台入口。
- 没有 Pi 或 scripted 生产回退。
- TypeScript、Java 和真实 AgentScope contract test 通过。

依赖：RT-15、RT-16、RT-18、RT-28。

覆盖：AC04、AC05。场景 B01、B02、B03、B05、B06、B07。

### RT-30 运行集成、故障和灰度验收

目标：用真实 PostgreSQL、API、Worker、AgentScope 和 Web 验证完整链路，再逐项开启 feature gate。

输出：

- 39 条验收标准的追溯报告。
- 96 个原子场景的测试结果。
- pair 并发创建、重复投递、Runtime 重启、session owner 过期回收、网络乱序、审批/输入等待不阻塞聊天、审批过期和迟到结果的故障测试。
- gate 灰度顺序、回滚条件和审计查询。

验收：

- `pnpm check` 和受影响包的定向测试通过。
- `mvn -q -f services/agent-runtime/pom.xml test` 通过。
- `pnpm test:integration` 和圆桌定向 E2E 通过。
- 关闭任一 gate 后，相关入口明确禁用，已有记录仍可读。
- diff 不包含密钥、真实用户数据、私有 URL 或本机身份信息。

依赖：RT-02、RT-03、RT-04、RT-05、RT-06、RT-07、RT-08、RT-09、RT-10、RT-11、RT-12、RT-13、RT-14、RT-15、RT-16、RT-17、RT-18、RT-19、RT-20、RT-21、RT-22、RT-23、RT-24、RT-25、RT-26、RT-27、RT-28、RT-29。

验证覆盖：AC01、AC02、AC03、AC04、AC05、AC06、AC07、AC08、AC09、AC10、AC11、AC12、AC13、AC14、AC15、AC16、AC17、AC18、AC19、AC20、AC21、AC22、AC23、AC24、AC25、AC26、AC27、AC28、AC29、AC30、AC31、AC32、AC33、AC34、AC35、AC36、AC37、AC38、AC39。场景 U01、U02、U03、U04、U05、U06、U07、U08、A01、A02、A03、A04、A05、A06、A07、A08、R01、R02、R03、R04、R05、R06、R07、R08、D01、D02、D03、D04、D05、D06、D07、D08、X01、X02、X03、X04、X05、X06、X07、X08、C01、C02、C03、C04、C05、C06、C07、C08、B01、B02、B03、B04、B05、B06、B07、B08、P01、P02、P03、P04、P05、P06、P07、P08、F01、F02、F03、F04、F05、F06、F07、F08、M01、M02、M03、M04、M05、M06、M07、M08、Q01、Q02、Q03、Q04、Q05、Q06、Q07、Q08、O01、O02、O03、O04、O05、O06、O07、O08。

## 5. PR 规则

每个任务的 PR 必须满足以下条件：

1. 只包含该任务和必要的前置适配。
2. 数据库 migration 可以单独部署，并兼容关闭 feature gate 的应用版本。
3. 新写路径有幂等键、授权检查和失败测试。
4. 新读模型有分页、空状态和无权限测试。
5. PR 描述列出覆盖的 AC 和场景 ID。
6. PR 合入前运行任务中的最小验证命令。
7. 后续 PR 不复制前置逻辑来绕过依赖。

## 6. 不属于本轮的工作

- 多真人群聊。
- 移动端或 Electron 实现。
- 新的 Agent 编排器。
- 新的用户会话类型。
- 百分比进度。
- 让用户介入 Agent pair 对话。
- 自动传播发送者的凭据或文件权限。
- 为原型中的每个视觉分支分别实现状态机。
