# 圆桌模式实施任务审查

状态：第一轮审查已处理（保留为历史记录）

审查范围：

- `roundtable-product-requirements.md`
- `roundtable-architecture.md`
- `roundtable-implementation-plan.md`
- `verify-implementation-plan.mjs`
- `prototype/DESIGN.md`
- 相关生产代码和数据库模型

本轮只审查，不修改实施任务。

## Intent

> 把已经确认的圆桌 PRD 和架构骨架拆成按依赖排列的实施任务。每个任务可以单独合入和验证。计划必须保留现有 Thread、Task 和 Run 架构，覆盖 39 条验收标准和 96 个原子场景，并保留需要用户决定的产品参数。计划不能建立第二套圆桌状态机，不能伪造未实现能力，不能削弱授权边界，不能引入 AgentScope 以外的生产执行器，也不能重新设计已确认的 UI。

## Reviewers

- Reviewer A：`gpt-6-astra`，7 项发现。
- Reviewer B：`gpt-6.1-sol`，5 项发现。

上游提示词默认的 Claude 和 Grok 模型在当前 Codex harness 中不可用。本轮使用当前可用的两个不同模型。两位 reviewer 使用同一份 pstack reviewer prompt、rubric 和 code-quality lens。

## Act on

### 1. 给跨会话 steering 增加请求级 origin

Reviewer A 和 B 都发现了这个问题。

RT-09 允许两个来源请求进入目标群的同一个 active Run，但当前 Run 只有一个创建时固定的 `parentRunId`。`SteeringMessage` 也没有独立的跨会话 origin。现有 descendant cancel 因此无法只取消其中一个来源请求，结果回流也无法分别完成。

修订要求：

- 在 RT-01 和 RT-09 之间增加请求级持久关联。
- 关联至少包含来源 Thread、来源 Run、来源消息、目标 Run、steering 消息和 receipt。
- 明确取消的是请求、steering 尚未消费的输入，还是整个目标 Run。
- 增加“两个来源进入同一 Run，只取消一个来源，结果分别回流”的测试。

### 2. 区分产品 Task、后台 runtime task 和执行 attempt

Reviewer A 发现了这个问题。代码证据成立。

`BackgroundAgentTask.taskId` 是 runtime 投影的主键。它只有 `parentRunId`，没有产品 `Task.id`、执行 Run、attempt 或 revision 关联。同一个父 Run 可以启动多个 helper。RT-13、RT-15 和 RT-17 不能据此精确修订、重试或拒绝旧 revision 的结果。

修订要求：

- 在 contracts 和数据库前置任务中定义三种身份及持久关联。
- 定义一个父 Run 启动多个 helper 时的唯一性和查询方式。
- 让 amendment、retry、delivery 和 work projection 使用同一关联。
- 增加“一个父 Run 启动两个 helper，只修订其中一个”的测试。

### 3. 按 Bot、origin 和 revision 隔离 delivery 批次

Reviewer B 发现了这个问题。代码证据成立。

现有 `delivery-records.ts` 主要按 Thread 和时间窗合并记录。`result-delivery.ts` 使用第一条记录的 Bot 创建共用 delivery Run。多个 Bot 共用群 Thread 后，这会让一个 Bot 发布另一个 Bot 的结果。固定 pair 同时承接多个来源时也可能混合 origin。

修订要求：

- RT-15 明确修改 delivery 分批键。
- 分批至少包含执行 Bot、origin lineage 和有效 revision。
- 增加“同群不同 Bot 同时完成”和“同 pair 不同来源同时完成”的 PostgreSQL 测试。

### 4. 迁移所有覆盖 `Task.prompt` 的现有写路径

Reviewer B 发现了这个问题。代码证据成立。

RT-11 只定义了新的 amendment 写入。现有 `commitAnswerRunInput` 仍会用追问回答或选项覆盖 `Task.prompt`。executor 也直接读取 `task.prompt` 组装执行和重试输入。只增加 envelope 不能保证原始要求保留。

修订要求：

- RT-11 列出所有 prompt 写入者和执行输入消费者。
- 迁移追问回答、选项回答、retry 和 follow-up 的读取路径。
- 增加“原任务、追问回答、amendment、retry 或 follow-up”的完整历史测试。

### 5. 增加 origin-aware Intervention 的完整路径

Reviewer A 发现了这个问题。代码证据成立。

AC20 要求 pair Run 的审批和补充回到来源 Thread。当前审批提交会校验 `Intervention.threadId` 与请求 Thread 相同。只在来源 Thread 展示 pair Intervention 会提交失败。在 pair Thread 提交又违反人类只读规则。

修订要求：

- 增加独立任务，负责 origin-aware Intervention 的创建、投影、授权提交和恢复。
- 验证批准、拒绝和用户补充都从来源 Thread 完成。
- 保持 pair Thread 的所有人类写入禁令。
- 将该任务设为 private-pair feature gate 的启用前置条件。

### 6. 把 AgentScope 暂停原因改成可验证的解除 gate

Reviewer A 和 B 都发现了这个问题。

AgentScope 2.0.3 的公开 API 无法给声明式 helper 配置安全的 compaction 和 eviction。替代 factory 又会绕过 child session 派生。RT-14 只要求实现和 Maven 测试，不能证明生产 suspension 可以解除。

修订要求：

- 在 RT-14 前增加 SDK 能力验证任务。
- 先确定可用版本或安全适配方案。
- 用真实 child 触发压缩。
- 断言没有 native memory flush 或 offload，child session 派生正确，registration、delivery 和 cancel 都可恢复。
- 只有这些检查通过后才能解除 production suspension。

### 7. 给公开群委派增加明确的 Web 任务

Reviewer A 发现了这个问题。代码证据成立。

RT-05 只产出后端投递和聚合数据。RT-06 负责 private receipt，RT-07 负责 mention link。没有任务负责把 public collaboration block 渲染成自然的 `@` 委派消息，也没有任务负责连续调用的视觉合并。

修订要求：

- 增加 public collaboration Web 子任务。
- 消费结构化 destination、source Run 和服务端 seq。
- 群内公开委派不打开 pair 浮窗。
- UI 可以合并展示，但底层投递、重试和状态仍保持独立。

### 8. 统一依赖图、正文依赖和启用依赖

Reviewer A 发现了这个问题。证据成立。

当前图把 RT-17 和 RT-21 画成可早期启动的分支，但正文列出多个后置依赖。RT-10 和 RT-15 又需要排在后面的 RT-16 校验器。RT-13 使用后台取消和 delivery fence，却没有依赖 RT-14 和 RT-15。

修订要求：

- 用机器可读依赖生成拓扑顺序和图。
- 区分“代码可合入”与“feature gate 可启用”两种依赖。
- 消除向后依赖和隐含依赖。
- 对依赖图运行不存在节点和环检查。

### 9. 重写覆盖检查器，删除 RT-22 的假覆盖

Reviewer A 和 B 都发现了这个问题。

当前脚本对 ID 去重后只检查集合相等。RT-22 枚举了全部 ID，所以删除 RT-00 至 RT-21 的覆盖行仍会通过。受限正则还会静默忽略 AC40、U09、重复任务和 `RT-99` 依赖。

修订要求：

- RT-22 只承担集成验证，不作为实现 owner。
- 每条 AC 和场景必须有 RT-22 以外的主要实施任务。
- 解析完整任务块，保留重复信息。
- 拒绝未知 ID、重复任务、不存在的依赖和依赖环。
- 从 PRD 结构读取验收条目，不能把 39 写死。
- 为删除实施覆盖、重复任务、未知 ID、未知依赖和依赖环增加负例测试。

## Consider

没有。九项发现都会影响正确性、授权、可维护性或计划的可执行性。

## Noted

- Reviewer A 把后台身份和跨会话 origin 评为 critical。Reviewer B 把跨会话 origin 评为 warning。主审按阻塞项处理两者，因为当前计划无法实现精确取消和 revision fence。
- RT-16 和 RT-21 的范围较大，但 reviewer 没有证明它们无法单独合入。先修复依赖和身份模型，再判断是否继续拆分。

## Dismissed

没有。两位 reviewer 的发现都引用了具体代码路径。没有纯命名、格式或个人偏好意见。

## Agreement map

两位 reviewer 独立同意三项问题：

- 跨会话 steering 没有请求级 origin。
- AgentScope 的生产解禁条件不充分。
- 覆盖检查器会产生假阳性。

其余发现互不冲突。它们补充了同一问题。当前计划把“复用现有能力”写成了目标，但没有逐一检查现有能力的身份粒度、批处理键和 Thread 绑定。修订时应先补这些事实关系，再重新排任务，而不是在现有 23 个任务上添加更多说明文字。
