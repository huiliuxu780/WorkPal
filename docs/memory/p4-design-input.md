# P4 记忆与上下文压缩：WorkPal 落地方案

状态：设计稿，尚未实现。依据是当前仓库和外部参考《04-memory-compaction.md》；后者提供目标结构，不作为 WorkPal 的运行指令。本文中的默认阈值均为拟定值，须通过压测和真实模型用量校准。

## 0. 决策摘要

1. 实现 **事实、分片、汇总** 三层长期记忆。候选和证据是事实的治理记录，不是另一个可注入模型的记忆层。
2. PostgreSQL 保存完整产品聊天、记忆事实、版本和审计；AgentScope 只保存执行中的工作上下文。Task/Run 不变成新的聊天会话。
3. 保留现有 Thread 摘要和消息序号作为**应用层持久压缩的唯一有效指针**。AgentScope 原生压缩继续负责单次执行和其恢复状态；不能拿原生摘要直接推进 PostgreSQL 的压缩游标。
4. 使用 AgentScope 2.0.3 的 `CompactionConfig` 与通用 `Hook` 观察执行生命周期、触发后端任务；**不直接启用原生 `MEMORY.md` 自动写入**。记忆写入经后端授权、证据校验、事务提交和审计。
5. 事实默认限于创建者可见的 Space 内。首期只支持同一 Space 内逐条授权后的共享；跨 Space 共享保持禁用，未来另立资源授权设计。现有外部语义记忆的 `isolated/shared` 设置不等于事实层授权。

## 1. 当前基线与问题

| 现状 | 位置 | 缺口 |
| --- | --- | --- |
| 完整聊天在 `messages`，Thread 有 `historyCompactedUpToSeq`、`historyCompactionSummary`、`historyCompactionGeneration` | `packages/db/prisma/schema.prisma` | 只有当前摘要，没有可审计的摘要修订与来源覆盖说明 |
| `history.compact` 后台任务按 50 条生成替换摘要，CAS 推进游标；正常回合在未压缩消息达到 100 条时入队 | `packages/adapters/src/history-compaction.ts`、`executor.ts` | 以条数触发，单条超长消息仍可溢出；摘要只从产品消息块构造，不能声称覆盖完整工具结果 |
| AgentScope 原生 30 条触发、留 10 条；JSON 状态及 workspace 落在按 tenant/bot/session 划分的本地目录 | `services/agent-runtime/src/main/java/com/workpal/runtime/RuntimeEngine.java` | 与应用摘要是两个不同的工作状态；原生 workspace 不是跨 Thread 的长期记忆仓库 |
| Markdown `MemoryDocument/MemoryRevision` 支持 bot/user 范围、手动修改、显式 `remember`，最多注入 32 KiB | `packages/memory/src/index.ts`、`packages/adapters/src/memory-context.ts` | 没有原子事实、来源、失效、逐条删除和版本化汇总 |
| 可选语义服务支持 recall/save/forget（forget 可选）及历史代数清理 | `packages/adapter-kit/src/interfaces.ts` | 外部索引不能承担第一方真相；删除失败需要可见重试 |
| `Message` 有 `role`、`runId`、`clientNonce`，但没有可靠的作者 ID 和来源类别；部分非人工入口也以 `user` 角色投递 | `packages/db/prisma/schema.prisma`、`packages/db/src/events.ts` | 不能只用 `role=user` 自动提炼用户偏好，须先补可信来源字段 |

**先修的配置风险。** `disableMemoryHooks()` 已设置，但 AgentScope `CompactionConfig` 在 2.0.3 中默认 `flushBeforeCompact=true`。压缩前提取可能仍写原生日志并产生额外模型调用。基线修正为显式 `.flushBeforeCompact(false)`，并用真实压缩测试验证没有 `memory/YYYY-MM-DD.md` 或 `MEMORY.md` 写入。原生工具结果卸载默认可能生成文件指针，而此运行时禁用文件系统工具；须验证读回路径，未接通前关闭相应卸载或让工具结果保留在受控持久介质中，不能留下模型无法读取的指针。

## 2. 权威边界与数据流

```text
用户/外部消息 → API 鉴权与 Thread 消息提交（PostgreSQL）
                         ├─ Run → AgentScope 工作上下文/原生压缩
                         ├─ history.compact → Thread 摘要修订
                         └─ memory.extract → 候选事实 → 校验/确认 → MemoryFact
                                                       ↓ 分片版本递增
                                             MemoryShard → ContextSummary
                                                       ↓
                                 下一 Run 的受权、限额上下文注入
```

- **用户意图的证据**：有明确 actor 和来源的产品用户消息、用户直接编辑记忆的操作。先给 `Message` 增加受信入口写入的 `authorUserId` 与 `originKind`（如 `human_web`、`human_messaging`、`webhook`、`automation`、`bot`），并让每个入口显式赋值；模型不能提供或修改这些字段。Bot 回复、工具输出、网页和 webhook 只能作背景或事实核验，不能冒充用户指令。合成 wake/ack/delivery 不以文本前缀猜测：用 `role`、`trigger`、`runId`、`originKind` 分类；旧消息只有在现存 Run/审计记录能无歧义恢复作者时才回填，否则不参加自动蒸馏。
- **执行细节**：AgentScope 状态可以包含工具调用和结果，但它不是 PostgreSQL 全量聊天的替代品。应用压缩的 `includesToolResults` 初始为 `false`。只有工具结果经过现有脱敏、权限和持久化覆盖检查后才允许改为 `true`。
- **读时权限**：每次 Run 由后端用当前 `userId/spaceId/botId` 选择事实和汇总，并写入有界、标注为“不可信历史数据”的上下文。Java 不根据模型生成的路径自行扩大范围。
- **外部语义服务**：是可重建的检索索引。它可以存带事实 ID、版本、作用域和来源代数的投影，不存唯一副本。提供方不可用时第一方事实与摘要仍可读。

## 3. 三层模型

### 3.1 事实层：`MemoryFact`

一条记录只表达一个可独立撤销的命题或偏好。建议字段：

| 字段 | 约束/用途 |
| --- | --- |
| `id`, `spaceId`, `ownerUserId` | 稳定 ID；个人事实属于 Space 内的一个用户；Space 共享事实仍保留原始创建者 |
| `scopeKind`, `scopeKey` | 首期为 `bot:<id>`、`user:<id>`、`space:<id>`；“项目”在当前产品中没有独立实体，不能用字符串项目名绕过 Space 授权 |
| `kind`, `text`, `language` | `explicit_preference`、`correction`、`workflow`、`stable_fact` 等；短文本、单一断言，归纳表达，不存整段转录或逐字复述用户语句 |
| `literalValues` | 可空、限长的结构化必要字面值（如命令、路径、称呼）；经转义后作为数据注入，不承载自由形式指令 |
| `origin`, `state` | `user_direct`、`user_confirmed`、`model_candidate`、`legacy_import`；`candidate/active/superseded/deleted` |
| `learnedAt`, `validFrom`, `expiresAt`, `lastConfirmedAt` | 区分学到的时间和事实有效期；有时效性的内容不无限注入 |
| `canonicalKey`, `revision`, `supersedesFactId` | 去重、纠正与并发版本控制；不能仅靠文本哈希识别同义事实 |
| `createdBy`, `lastChangedBy`, `sourceRunId` | 归属和审计；自动提取只能标记服务主体 |

另设 `MemoryEvidence`，包含 `factId`、`threadId`、`messageId`、`messageSeq`、`threadGeneration`、`authorUserId`、`originKind`、`evidenceType`、`sourceDigest`、`capturedAt`。`sourceDigest` 若用于去重，应是服务端密钥计算的 HMAC，避免普通文本哈希泄露可猜测内容。证据引用须经过当前访问控制；不复制原文或密钥到审计表。来源删除后该引用失效，不能作为新的蒸馏证据。候选可存同表 `state=candidate`，但**不进入读路径**。

写入规则：

- 用户在记忆界面编辑或明确要求“记住 X”：可由后端记为 `user_direct`；若模型解析有歧义，先呈现候选请用户确认。单条明确指令无需跨四个会话重复。用户明确的纠正、撤销和指令是自动激活事实的唯一可信信号。
- 自动推断的习惯：默认至少四个**不同 Thread 的独立用户证据**，跨天重复优先；同一 Thread 的复制、Bot 复述和外部内容不增加计数。达到门槛只能产生**待用户确认的候选**，不能自动激活为长期画像；证据数量本身不等于用户指令。
- `MemoryFact.text` 应为自己的归纳措辞，禁止整句搬运用户原话。命令、路径、专有名词、称呼等不可改写的必要字面值可单独保留为受限结构化字段，并在注入时转义；不能让原话中的祈使句获得新指令地位。
- 纠正/撤销：明确的新指令优先于旧事实；旧条目标记 `superseded` 或删除，派生分片与汇总失效。事实来源的模型判断不能覆盖用户直接编辑。
- 敏感字段、秘密、临时验证码、第三方私人信息：默认不自动提取；仅可按已有凭据/资源机制处理。自动蒸馏不得扩展连接权限。
- 个人事实推广至 `space` 范围：逐条由有权用户执行 `promote`，保存授权 actor、时间和目标范围；不随 Bot 配置或外部 provider 默认范围自动推广。

### 3.2 分片层：`MemoryShard`

一条分片按 `(spaceId, scopeKind, scopeKey)` 唯一。字段为 `id/version/updatedAt/profileMarkdown/profileVersion/lastRebuiltAt`。`version` 是该范围事实集合的单调版本；`profileMarkdown` 是从活跃事实生成的**可重建投影**，不是第二个可随意写入的事实源。原方案的 `folder.logs` 对应 `MemoryFact` 修订和 `MemoryEvidence`，通过查询分页访问，不在一列 JSON 中无限增长。

更新事实时同一事务内：写事实修订与证据、递增对应分片 `version`、插入汇总重建 outbox。事务提交后才发作业。作业按版本幂等；旧版本完成时不得覆盖新版本。Bot、用户、Space 分片分别维护，读时合并受权分片。分片之间的冲突先以用户直接指令、最近明确纠正和作用域的明确优先级解决；不能让较新的模型猜测压过旧的用户确认。

现有 `MemoryDocument` 保留为兼容入口和 Markdown 导出格式。迁移阶段旧文档作为旧格式上下文单独读取，**不把整篇文档伪装成一个原子事实，也不偷偷拆成高置信事实**。用户逐条确认后才迁移为 `MemoryFact`，来源标为 `legacy_import`。新系统稳定后，`MEMORY.md` 可以成为分片投影或兼容导出；要选定单向写入规则，避免旧文档和新事实互相覆盖。旧 API `memory.list/update/exportMarkdown` 保持可用，新能力集中在 API 层适配。

### 3.3 汇总层：`ContextSummary`

由当前可见分片生成一个面向接收 Bot 的短 prose。建议字段：`id`、`spaceId`、`recipientUserId`、`recipientBotId`、`sourceVersions`（分片 ID→版本）、`generatedAt`、`summaryModel`、`promptVersion`、`content`、`tokenEstimate`、`status`。`sourceVersions` 必须覆盖生成输入的每个分片；读时任一版本不匹配即视为过期，不能注入旧汇总。

生成模型与主聊天模型分开配置，优先用受控成本模型；若质量不足再提高。模型只能归纳 `active` 事实，不能创造新事实或改动授权范围。汇总输出经结构校验、敏感内容扫描和来源 ID 覆盖检查后，用版本 CAS 发布。候选、过期、已删除事实不得出现在新内容中。

读路径优先用匹配版本的汇总，再附当前任务相关的少量原子事实及引用 ID。汇总暂未生成或作业失败时，从受权活跃事实作**确定性有界拼接**；无记忆也应正常回答。原有 32 KiB Markdown 注入预算不会与新摘要预算叠加无限增长；先定义总 token 预算，按“系统/任务 > 最近原文 > 已确认新事实 > 旧文档 > 已确认的低置信事实”截取，并记录省略数。未确认的模型推断完全不注入。

初始配置建议：迁移期**旧 Markdown + 新三层合计硬上限 4,000 估算 token**，其中旧文档最多 2,000、新汇总与补充事实合计最多 2,000；新汇总最多 1,200，补充事实最多 10 条。两个子预算不能互借到突破总额。迁移完成、旧文档退出自动注入后，总上限收至 2,000。如果模型可用窗口更小，按比例收缩，不挤占最近用户消息与工具执行预算。旧的 32 KiB 只能作为读取防护，不再是可注入预算；迁移期必须在同一个上下文装配函数中统一裁剪两路内容。这是成本与稳定性起点，不是模型能力事实。每次记录实际被选中/省略的事实 ID 数，按真实用量调整。

### 3.4 表、索引与写入不变量

- `MemoryFact`：外键 `spaceId`、`ownerUserId`、可空 `botId`，唯一 `(spaceId, scopeKind, scopeKey, canonicalKey)` **仅对 active 行生效**；`revision` 从 1 单调递增。`scopeKey` 只从经后端校验的实体 ID 构造，不接受自由文本。
- `MemoryFactRevision`：`(factId, revision)` 唯一，保存状态、正文、修改者、原因、时间。删除后的正文清理策略与保留期限须和用户删除承诺一致；审计可保留不含正文的操作记录。
- `MemoryEvidence`：`(factId, messageId, evidenceType)` 唯一；`messageId` 使用可空引用或清理策略支持 Thread clear。不能只依赖 FK `SET NULL`：清空前必须显式使相应证据失效并重新计算候选资格。
- `MemoryShard`：`(spaceId, scopeKind, scopeKey)` 唯一，`version` 仅在相关事实集合变化时递增；`profileVersion` 必须等于 `version` 才能读取 profile。
- `ContextSummary`：`(spaceId, recipientUserId, recipientBotId, sourceVersionDigest)` 唯一，另存完整 `sourceVersions`；同一接收者只读最新且版本完全匹配的 `ready` 行。
- `MemoryJobOutbox`：`(kind, targetId, sourceVersionDigest)` 唯一，含尝试次数、下次重试时间和最后错误码；消费者用 claim/lease，成功后再标记完成。模型调用不得放在数据库事务或 Thread 锁内。

实际迁移需按仓库 Prisma/SQL 命名约定建表和索引，部分索引（如 active 部分唯一索引）用原生 SQL migration。所有读操作仍同时检查当前 Space 成员资格与 Bot 访问权；存在 `spaceId` 字段本身不构成授权。

## 4. 压缩：两种状态，各司其职

### 4.1 应用层 Thread 压缩

维持 `Thread` 上的当前摘要指针以兼容前端和 Worker；新增 `ThreadCompactionRevision` 记录：`threadId/generation/fromSeqExclusive/toSeqInclusive/previousRevisionId/summary/inputDigest/model/promptVersion/includesToolResults/createdAt`。不把摘要写成一条普通用户消息；这样不会污染用户意图、消息计数或蒸馏证据。

任务从 PostgreSQL 读连续消息段与上版摘要，固定 generation 和最高消息序号，生成**完整替换摘要**，校验非空、长度及锚点；一个事务中插入修订并 CAS 更新 Thread 指针。失败、超时或 clear 后的迟到结果均不推进游标。仍保留原消息以供用户查看。清空 Thread 递增 generation，令旧任务和旧语义索引投影失效。

**摘要模型选择**：默认使用覆盖该批消息的最近一个已完成主对话 Run 实际使用的 `modelProvider/modelId`，即该会话当时的模型，而不是在后台任务里重新读取可能已改变的 Bot 默认模型。现有 Run 行已记录这两个字段，但 `historyCompactJob` 目前只传 `threadId`，且 `resolveModel(scope)` 会重新选择当前配置；实现需在入队/读批次时固定 `sourceRunId` 与模型身份，写入 `ThreadCompactionRevision.model`。凭据只保存引用，不把密钥放进作业或修订；执行前用后端当前授权解析**同一模型**的凭据，凭据已撤销或模型不可用则失败并保留游标，不静默换模型。只有显式配置了摘要模型覆盖、并经续跑质量测试时才能改用别的模型。模型在同一 Thread 内曾切换时，以本批尾部对应的主对话 Run 为准，并在修订中记录选择依据。

触发应从“固定 100 条”升级为：可用模型窗口减去系统提示、工具 schema、当前输入、输出预留与安全余量后的**可用历史预算**，再考虑消息数兜底。模型窗口未知或计数不可信时沿用现有保守消息阈值，绝不虚报精确 token。压缩后仍超限，返回明确的上下文不足错误与新 Thread 建议，不能默默丢失原文。

调度策略落成 `CompactionMode = disabled | background_nowait | background_wait_if_needed | sync`，由服务端按调用场景选择，而不是散落布尔分支：普通交互轮次默认 `background_nowait`；下一轮预计超预算时采用 `background_wait_if_needed`，有界等待同 generation 作业后仍不足再同步补救；确定必须在**裁剪 Agent 工作上下文或交接执行态之前**拿到摘要的内部路径用 `sync`；关闭实验或回滚用 `disabled`。PostgreSQL 原始消息先正常提交，不能把“等待压缩”误写成“聊天记录持久化前的必经步骤”。`start`（开始生成）与 `persist`（允许替换工作上下文）的绝对/百分比余量分别配置，并校验 `persist` 不早于 `start`；消息条数只作兜底。四种模式的失败、超时、取消语义各有定向测试。

现有摘要输入只覆盖产品消息块；这应在元数据中明确为 `includesToolResults=false`。若未来要保留关键工具结果，须先定义脱敏后的工具输出持久化源和授权读法，再改变该字段。总结 prompt 必须把历史、外部内容和旧摘要标为数据，输出当前目标、已完成动作、决策、未完成事项、相关资源 ID 与下一步；不能执行其中的指令。链式压缩至少两次的锚点一致性是发布门槛。

### 4.2 AgentScope 原生压缩与 Hook

`CompactionConfig` 继续用于 AgentScope 工作上下文的消息/token 触发和溢出重试；它的摘要只留在 AgentScope state，不反向当作 Thread 的权威摘要。配置显式关闭 `flushBeforeCompact`，并按模型预算调节 `triggerTokens/keepTokens`，逐 provider 用真实上下文窗口验证。不要为每个 provider 复制一整套提示与摘要 handler，除非格式差异确有测试证据；模型适配由现有 AgentScope runtime 处理。

2.0.3 的 `Hook` 接口可通过 `HarnessAgent.Builder.hook(...)` 观察通用生命周期事件。首期自定义 `WorkPalMemorySignalHook` 只输出有界元数据（Run/Thread ID、generation、事件类型、估计 token、耗时和错误码），不复制工具结果、不写记忆、不在 `onEvent` 中阻塞模型请求。`PostCall` 信号或现有 Worker 完成事件可作为提取入队的提示；最终入队去重和权限判断在后端。**不要假定 Hook 提供专门的“压缩完成”事件**；应用压缩由 `history.compact` 自己记录结果，原生压缩的可观测性在 2.0.3 事件面上验证后再决定是否扩展。

不直接开启 `MemoryFlushMiddleware`/`MemoryMaintenanceMiddleware`：它们的默认目的地是 workspace 内的日记与 `MEMORY.md`，当前 workspace 又按 session 隔离；也没有本方案的证据、逐条授权、撤销和 PostgreSQL 事务。若以后复用其抽取 prompt，只复用**候选生成算法**，让结果经后端 bridge 校验后入库。外部语义 provider 的保存和清除仍由后端适配器负责。

## 5. 蒸馏作业与并发协议

1. **发现**：完成的人工用户回合、用户记忆编辑、明确纠正触发增量作业；周期扫描只补漏。按 `(spaceId, userId, botId?, threadId, generation, highWatermark)` 去重。仅从 `authorUserId` 与 `originKind` 均可信的结构化 PostgreSQL 消息选择有权访问的用户内容；后台唤醒、webhook、Bot-to-Bot 消息和工具输出不计为用户指令。
2. **只读分析**：记录读取的 Thread generation、最高消息 seq、已见 fact/shard 版本；取有界新消息和必要旧证据。模型产出严格 JSON 候选：命题、类别、作用域建议、证据 message ID、置信理由、冲突事实 ID、时效。此阶段不写事实、分片或摘要；模型输出只是待检提案。
3. **确定性校验**：核对证据确属该 actor 与可见范围、消息未清空、内容确实支持命题、无合成来源；过滤秘密与不可自动保存类别；对事实正文做归纳改写与注入文本检查。明确指令可按单次证据激活；四 Thread 仅满足推断候选的展示门槛。去重与冲突需审查，不能仅靠 LLM 自报的引用数量。
4. **提交**：事务中复核 generation 与读到的版本，upsert 候选或活跃事实、证据和审计，递增分片版本，写 outbox。模型推断即使证据足量也只能 `candidate`，等待用户确认后再激活。版本变化则重试分析或丢弃旧候选，不能覆盖新纠正。提取成功但摘要失败时事实仍成立，汇总作业可重试。
5. **汇总**：按目标接收者读取当前可见分片快照，生成并验证 prose，以 `sourceVersions` CAS 发布；失败维持旧行但读时判过期，回退到有界事实列表。外部语义索引异步更新，失败有重试和清理队列，不阻塞第一方读取。

周期任务使用现有 Worker/Job 基础设施，AgentScope 是唯一生产模型执行器；不引入另一个 agent 框架，也不以 `scripted` 产生生产记忆。初始扫描量、频率、token 上限、单用户每日费用和最大并发做成服务端配置，默认关闭自动推断，先对测试 Space 开启。每个阶段记录耗时、模型、输入/输出 token、失败原因与去重键，不记录原始隐私内容到日志。

## 6. API、UI 与删除语义

- 新 API：`memory.facts.list/get/confirm/correct/delete/promote`，`memory.summary.get`，以及只供审计的 `memory.factEvidence.list`。全部沿现有 actor/Space/Bot 校验；写操作用 expected revision 防止两个页面互相覆盖。`promote` 只允许向 actor 有权管理的目标范围复制，经逐条确认后形成新 fact ID 和来源关联。
- 现有 Knowledge 入口展示“已记住”“待确认”“已失效”，并给出来源、更新时间、作用域和删除/纠正动作；只在事实真正提交后显示“已记下”。自动候选不伪装成已保存。不要重新设计现有页面，组件继续用现有 UI 包，在前端 API 层集中适配新契约。
- `memory.update` 对旧 Markdown 文档继续有效。迁移期 UI 清楚区分旧文档与新事实；避免同一内容同时由两套写路径修改。
- 删除一个事实：立即从读路径排除；同一事务更新分片版本和审计，随后重建汇总、删除外部索引投影。现有 `MemoryRevision` 会保留旧正文，故真正的用户删除还必须处理历史修订、备份保留策略和外部 provider 的删除确认；不能只打 tombstone 就宣称已删除。
- 清空 Thread：取消待提取作业并以 generation 拒绝迟到结果；未确认且只有此 Thread 证据的候选直接清除。已确认的长期事实按用户看到的“清空聊天/删除记忆”语义处理：默认清空聊天不暗中删记忆，但其来源引用标记不可访问；若产品提供连记忆删除，则列出受影响事实并执行明确删除。删除 Bot/Space 走现有级联与外部索引清理。

## 7. 迁移与发布顺序

| 阶段 | 变更 | 完成条件 |
| --- | --- | --- |
| A：边界修正 | 明确关闭原生压缩前 flush；验证原生工具输出卸载可读性；记录应用/原生压缩指标 | 无未经后端授权的原生记忆写入，30/10 原生续跑不回归 |
| B：来源、事实与证据 | `Message.authorUserId/originKind` 的入口写入与保守回填；事实/证据迁移、后端仓储、显式用户记忆与候选 API；旧文档只读兼容映射 | 单次明确记忆可查看、纠正、删除；webhook 不被误认成人工用户；跨用户读取被拒绝 |
| C：分片与汇总 | 版本 CAS、outbox、摘要生成、受权读时注入；先对测试 Space 开启 | 并发纠正不丢、过期汇总不注入、外部服务故障可回退 |
| D：自动蒸馏 | 增量提取与周期补漏、证据规则、候选 UI、成本配额 | 合成消息与工具注入不成为用户事实；四会话推断门槛可验证 |
| E：压缩增强 | token 预算触发、摘要修订、双重压缩边界测试；逐步替换旧消息阈值 | 长会话跨两次压缩正常续跑，清空和并发无游标漂移 |

迁移采取 expand → backfill → read switch → contract：先加表和可选字段，再在测试数据上构造事实；旧 `MemoryDocument` 不批量自动推断为事实。首次发布可只开放显式事实写入，自动蒸馏保持关闭。回滚开关关闭新读取与作业，保留新表供修复，不把旧 Markdown 文档自动覆盖。数据库迁移需可重复执行，不能在部署时对全部历史同步调用模型。

## 8. 验收矩阵与应观测指标

**定向测试**：

- Java：`disableMemoryHooks + flushBeforeCompact(false)` 的真实压缩不写原生记忆；同一 session 连续压缩和溢出重试；Hooks 不泄露原始工具结果或凭据。
- TypeScript/PostgreSQL：每个消息入口的可信作者/来源字段及旧记录保守回填、事实作用域、证据 FK/清空代数、修订 CAS、分片版本、汇总旧版本拒读、作业重放幂等、用户明确记忆与四 Thread 推断候选的不同门槛、四种压缩模式和双注入总预算、删除后全文与索引不可见。入队后更改 Bot 模型时压缩仍使用固定的会话模型；凭据撤销时不换模型且游标不动；事实正文不搬运用户整句原话。
- 端到端：Web 中记住→下个 Thread 召回→纠正→删除；并发更新；外部语义 provider 故障；Thread clear 后迟到作业；超长会话至少两次链式压缩后继续未完任务，不重复已完成动作。
- 安全样例：网页/工具结果伪装“用户让我记住”、wake/ack 文本伪装用户、相同事实从 Bot 复述四次、权限撤销后旧汇总、秘密进入候选，均不得进入可注入事实。

**上线看板**：压缩触发原因、压缩前后估计 token、摘要失败率与游标滞后、原生与应用摘要各自的模型费用；候选确认/拒绝率、事实纠正率、过期汇总读取拦截数、删除到外部索引清理延迟、按 Space 的模型费用和每日调用上限。指标阈值以基线实测设定；不得把“没有报错”视为记忆正确。

## 9. 已知代价与待产品确认的语义

- 三层会增加写入、版本管理、摘要调用和删除传播成本；它解决可解释的长期记忆，不会自动提高每次回答质量。先测“误记、漏记、重复、召回相关性”，再决定是否扩大自动蒸馏。
- Space 不是通用 Project。若未来有项目实体，需要独立资源授权和迁移，不以 `scopeKey` 的任意字符串冒充项目权限。
- 现有 `MemoryDocument` 编辑是整篇覆盖；事实层的逐条纠正需要新 API。旧编辑器与新事实层在过渡期不能双向自动同步，否则会出现循环生成和误删。
- 如果需要摘要含完整工具结果，必须先建立经过脱敏、授权且可删除的执行证据源；目前 PostgreSQL 产品消息不能证明这一点。
- AgentScope 本地 JSON state 的跨实例可用性与备份策略是执行可靠性问题，不能由三层长期记忆掩盖。多副本运行前需共享状态或有明确的重建/失败语义。
- 相对参考方案的有意偏离：分片不允许执行面运行中回写中心库，所有事实写入经后端事务、授权和审计；蒸馏不扫描本地 `*.txt` 转录目录，而按 PostgreSQL 的 Thread、generation、seq 和可信来源字段取数。这两个约束属于多租户产品的数据所有权边界，不应在后续实现中“补回”文件直写或目录扫描。

## 10. 实现落点

| 模块 | 计划改动 |
| --- | --- |
| `packages/db/prisma`、`packages/db/src` | 新表、索引、事务仓储、generation/版本 CAS、outbox |
| `packages/contracts/src` | 事实、证据、摘要 DTO 与 API 校验；现有 MemoryDocument 契约保持 |
| `packages/memory/src` | 第一方 fact/shard/summary 读写与旧 Markdown 兼容投影 |
| `packages/adapters/src` | 提取与汇总作业、上下文预算、受权注入、外部语义索引投影；压缩修订 |
| `services/agent-runtime` | `CompactionConfig` 安全配置、只读生命周期 Hook 和协议元数据；不开放原生 memory tools |
| `apps/api`、`apps/worker` | actor 校验、API、调度、清理与重试 |
| `apps/web/src/pages/KnowledgeSection.tsx` | 在现有视觉语言中展示事实、来源、候选和操作 |

参考：AgentScope Java [Memory 文档](https://java.agentscope.io/v2/en/docs/harness/memory)说明原生 flush、consolidation、compaction 是三个独立模型调用；本方案针对仓库锁定的 2.0.3 版本设计，升级版本须重新验证钩子与默认值。
