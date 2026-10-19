# Historical Task21 / Task22 input

This is the source-plan excerpt. The current delivery grouping and acceptance are defined by `../tasks/ME-01-02.md`; no separate PR is required for these historical stages.

### Task21 —— 记忆来源、纠错与删除（P4 阶段 A/B）

**目标**：单条明确记忆可查看、纠正、删除；为三层记忆打地基。

**涉及文件**：`schema.prisma`（新 `MemoryFact`、`MemoryEvidence`）、`packages/memory/src/index.ts`、`packages/adapters/src/memory-context.ts`、`memory-tools`（`remember/save_memory/recall_memory/forget_memory`）、API 层新增 `memory.facts.*`、Knowledge 页（复用现有 UI 包）

**步骤**

1. `MemoryFact`（`spaceId, ownerUserId, botId?, scopeKind, scopeKey, canonicalKey, text, literalValues, state, revision, source…`），唯一约束仅对 active 行生效；`scopeKey` 只由校验过的实体 ID 构造。
2. `MemoryEvidence`（`factId, threadId, messageId, messageSeq, threadGeneration, authorUserId, originKind, evidenceType, sourceDigest(HMAC), capturedAt`）；来源删除后引用失效。
3. 用户直接编辑或明确“记住 X” → `user_direct`，单次即可激活；有歧义先出候选。
4. API：`memory.facts.list/get/confirm/correct/delete/promote`、`memory.factEvidence.list`（审计）；写操作带 expected revision（CAS）。
5. 纠正优先于旧事实，旧条标 `superseded`；模型判断不能覆盖用户直接编辑。
6. 清空 Thread：取消待提取作业，以 generation 拒绝迟到结果；未确认且仅此 Thread 证据的候选清除；已确认事实默认不删，来源引用标不可访问。
7. 旧 `MemoryDocument` 保留兼容；旧 API `memory.list/update/exportMarkdown` 可用；用户逐条确认才迁为 `legacy_import`。

**验收**：P4 阶段 B 门槛——明确记忆可查看/纠正/删除；webhook 不被误认；跨用户读取被拒；删除后全文与外部索引不可见。

**风险**：与旧 Markdown 双写冲突 → 选定单向写入规则。

### Task22 —— 三层记忆、证据规则与压缩增强（P4 后续阶段）

**目标**：`MemoryFact → MemoryShard → ContextSummary`，蒸馏与压缩按 P4 文档落地。

**要点（逐条照 P4 文档实现）**

- **分片 `MemoryShard`**：`(spaceId, scopeKind, scopeKey)` 唯一，`version` 单调；`profileMarkdown` 是可重建投影，`profileVersion==version` 才可读。
- **汇总 `ContextSummary`**：`sourceVersions` 覆盖全部输入分片，任一版本不匹配即过期不注入；生成模型与主聊天模型分开配置；只归纳 active 事实；结构校验 + 敏感扫描 + 来源覆盖检查后 CAS 发布。


- **证据规则**：自动推断须**4 个不同 Thread 的独立用户证据**（跨天优先；同 Thread 复制、Bot 复述、外部内容不计数）→ **只产生待确认候选**；候选 ≠ 激活，需用户确认。候选不进读路径。
- **事实正文**：归纳措辞，禁止整句搬运；命令/路径/称呼等字面值存 `literalValues`，注入时转义。
- **注入预算**：迁移期旧 Markdown + 新三层合计硬上限 **4,000 估算 token**（旧 ≤2,000；新汇总+补充事实 ≤2,000，汇总 ≤1,200，事实 ≤10 条），子预算不能互借；旧路径退出后总上限降到 **2,000**；窗口更小按比例缩；同一装配函数统一裁剪；32 KiB 只作读取防护；记录选中/省略的事实 ID 数。截取优先级：系统/任务 > 最近原文 > 已确认新事实 > 旧文档 > 已确认低置信事实。
- **压缩模型**：固定使用覆盖该批消息的最近已完成主对话 Run 实际的 `modelProvider/modelId`；入队时固定 `sourceRunId` 与模型身份（当前 `historyCompactJob` 只传 `threadId`、`resolveModel(scope)` 会重选，需改）。**凭据失效时不静默换模型、不推进游标**。
- **四种调度模式** `CompactionMode = disabled | background_nowait | background_wait_if_needed | sync`：普通交互默认 `background_nowait`；下一轮预计超预算用 `background_wait_if_needed`（有界等待同 generation 作业，不足再同步补救）；必须在裁剪 Agent 工作上下文或交接执行态前拿到摘要的内部路径用 `sync`；其余细则以 P4 §4.1 为准。
- **触发**：从固定 100 条改为“可用历史预算”（窗口 − 系统提示 − 工具 schema − 当前输入 − 输出预留 − 余量），计数不可信时沿用保守消息阈值；压缩后仍超限返回明确错误与新 Thread 建议。
- Java `CompactionConfig` 摘要只留在 AgentScope state，不当 Thread 权威摘要。
- `WorkPalMemorySignalHook` 只输出有界元数据，不写记忆、不阻塞。
- 蒸馏作业用现有 Worker/Job，默认关闭自动推断，先测试 Space 开启；扫描量、频率、token、单用户每日费用、并发做服务端配置。

**验收**：P4 §8 验收矩阵全部条目（含：入队后改 Bot 模型压缩仍用固定模型；凭据撤销不换模型且游标不动；四种模式与双注入总预算；长会话跨两次压缩续跑；清空与并发无游标漂移）。

**风险**：成本 → 上线看板（P4 §8）监控；预算数值是起点，不是能力事实。
