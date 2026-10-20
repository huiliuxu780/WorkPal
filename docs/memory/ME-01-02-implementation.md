# ME-01 + ME-02 实施记录：记忆与长对话完整升级

状态：delivered（分支 `codex/memory-context-upgrade`，功能 PR [#79](https://github.com/huiliuxu780/WorkPal/pull/79) 待合并；合并后由下一正常变更回填 roadmap `done`）。
任务书：[ME-01-02.md](../tasks/ME-01-02.md)；设计输入：[P4 快照](./p4-design-input.md)（SHA-256 `1f027130c7b74619ea390c546357118fd1baae18299c69f1911da878f8581ccc`）、[Task21/22 摘录](./upgrade-task21-22-input.md)。
共同任务文档提交：`ee8db3c`（与 UX-02 线共享；本分支自该提交建立，`origin/main @ 12fea0e` 为其祖先，合流为包含关系，无冲突）。
不部署：本批未执行任何部署动作。

## 0. 交付形态

整批一个分支、一个功能 PR、一次最终收口。内部提交顺序（每步均有定向验证）：

1. `feat(db)` 三层模型 schema + migration + 事务仓储（15 项 PG 测试）
2. `feat(contracts)` 事实 DTO/RPC 契约；`feat(api)` 统一事实服务 + `memory.facts.*` 处理器（授权穷举 17/17）
3. `feat(adapters)` 四个记忆工具 + scripted 写路径改接事实服务（journeys 改断言后绿）
4. `feat(adapters)` 统一注入装配、汇总/提取/outbox 作业、压缩四模式与固定模型身份（217 项单测）
5. `feat(runtime)` Java 原生压缩 token 预算 + 有界信号 Hook + 新辅助 scope（92/92）
6. `feat(db,adapters,api)` Clear/Bot 删除治理、legacy 导入、回退开关
7. `feat(web)` Knowledge 事实界面 + zh-CN 翻译 + E2E（1/1，6.9s）+ 组件测试（3/3）
8. `fix(memory)` 读路径 canonicalKey 跨 scope 去重 + 指标日志

## 1. 验收矩阵 M-A01–18 逐条证据

| ID | 结论 | 证据（命令 → 结果） |
| --- | --- | --- |
| M-A01 | 通过 | E2E `apps/web/e2e/memory-facts.spec.ts`：Web 记住（可信 human_web 回合 → `user_direct` 单次激活）→ Clear 后同 Thread 新 generation 继续可用 → UI 查看来源（evidence 行含 `explicit_instruction`/accessible）→ 纠正（revision 2，同一身份）→ 删除（列表消失、`memory/facts/get` 非 200）→ UI 添加“已记下”回执仅在事务成功后出现。`WORKPAL_E2E_DATABASE_URL=…workpal_e2e_memory pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec=memory-facts.spec.ts` → 1 passed (6.9s)。注入一致性由装配单测 + 黄金样本零漂移共同钉住（见 M-A07）。 |
| M-A02 | 通过 | PG：`packages/db/src/memory-facts.postgres.test.ts`（模型候选禁止自激活、四 Thread 门槛以下候选不展示由 `listFactsForActor` 过滤、确认前无注入——候选不进 `listAuthorizedFacts` 读路径、拒绝后同证据不重复推荐 `findBlockingTombstone`）。提取 fixture：`packages/adapters/src/memory-extraction.test.ts`（10 项：policy 门、可信来源过滤、秘密/一次性码/逐字复制拒绝、幽灵证据引用拒绝、tombstone 拦截、配额、cursor CAS）。UI：`apps/web/src/pages/memory-facts.test.tsx`（候选确认 + “来自 4 个会话”门槛展示 + 冲突重载）。单次激活与推断门槛分离：`recordMemoryFromRun`（**评审轮 P1-1 收紧**：trusted && !ambiguous && 逐字 `source_quote` 在可信消息中核实命中 && 未命中拒绝模式 → active；缺引用/引用不实 → `authorization_unverified` 候选；消息明确拒绝保存 → `explicit_refusal` 候选，绝不激活）vs `runMemoryExtraction`（永远 candidate）。quote 门控 4 项服务级测试 + 评审复现测试红→绿。 |
| M-A03 | 通过 | 提取测试“never counts webhook, bot, system or foreign-author messages as user evidence”（webhook/bot/system/unknown/他人 authorUserId 全部不计数且不调模型）；秘密闸门覆盖**全部第一方写路径**——自动提取、汇总发布、remember/save_memory 工具与 UI 直接创建/纠正（`assertNotSecretLike`：凭据形状 + 一次性码中英文；工具返回可操作的“用凭据机制”指引，UI 返回 BAD_REQUEST；`facts.test.ts` 证明闸门先于任何数据库写入）。唯一例外是 legacy 文档逐条导入：文档正文本就经旧注入预算到达模型，拦截导入不减少暴露（代码注释与本文档如实记录）。最终请求注入体经 `escapePromptData` + `<durable_memory>` 数据围栏 + AG-06 typed provenance（untrusted-content 集成 6/6 保持，trust-rules 字节断言未动）。 |
| M-A04 | 通过 | PG 旅程：个人事实对另一用户不可见（list/get 双路径）、逐条 promote 后 Space 成员可见、promote 幂等 replay；权限改变后旧汇总不可读：`loadValidContextSummary` 对 sourceVersions 缺失分片（权限收缩）判 stale（测试 “a permission-scope change (missing shard) also refuses the summary”）。 |
| M-A05 | 通过 | CAS/Worker 集成：expectedRevision 冲突返回 `{status:"conflict",currentRevision}`（两页面并发纠正不静默覆盖）；分片行 `FOR UPDATE` 串行化同 scope 写入；提取 cursor 以 (generation, watermark) CAS，晚到/重复作业 `advanced=false` 丢弃；候选按 canonicalKey 部分唯一索引合并证据不重复建行（P2002 由部分唯一索引在 DB 层兜底，测试直接验证 active 重复插入被拒）。 |
| M-A06 | 通过 | 汇总仅当每个输入分片版本完全匹配才可注入（`publishContextSummary` 按 sourceVersionDigest 唯一 + `loadValidContextSummary` 全量核对）；任一分片版本变化→stale→不注入并惰性入队重建；provider 故障不阻断第一方读取（外部 recall 失败仅记日志，事实注入独立；outbox 投影失败可见重试）。 |
| M-A07 | 通过 | 纯函数：`packages/adapters/src/memory-injection.test.ts`（12 项）钉住 4000/2000/1200/800/10 预算、子预算不互借（超大事实不挤占 legacy 文档）、legacy 退役后 2000、小窗口按比例收缩（16k→scale 0.2）、10 条上限与省略计数、32KiB 仅作读取防护、legacy-only 输出与旧 `loadAgentMemoryContext` 逐字节一致。请求捕获：黄金样本 `prompt-files-baseline.integration.test.ts` **零漂移**通过（memory-injections fixture 字节一致，未重新生成任何样本）。 |
| M-A08 | 通过 | 删除后：读路径立即排除（`listAuthorizedFacts`/`getFactForActor` 默认拒绝 deleted，`memory/facts/get` 返回 NOT_FOUND——E2E 断言非 200）；正文清理（事实行 text=""、全部修订 text/literalValues 置 NULL，PG 测试逐项断言）；派生汇总经分片版本失配自动失效；外部索引清理入 outbox，失败可见（attempts/lastError）且重试（含 provider 无 forget 时 parked 24h 重试）；召回 tombstone 过滤（`filterStaleFactProjections`）保证清理未完成期间已删事实也不回流模型。旧文档迁移不重复注入：`listLegacyImportedDocumentIds` + 装配器跳过（单测 “never injects a legacy document already confirmed-migrated”）。**评审轮修正（P1-2）**：删除已导入事实**保持**文档屏蔽（“删除记忆”绝不复活旧文档正文）；仅显式 `memory.facts.revertImport`（state=reverted）让文档回到旧注入路径——PG 测试覆盖 delete-keeps-block / revert-unblocks / 非导入事实 invalid_state / CAS 冲突，评审复现测试钉住注入不含已删正文。 |
| M-A09 | 通过 | 真实 jar 同 session 多 Run：`MemoryCompactionPurgeIntegrationTest` 10/10 保持绿（三轮更新/删除、原生摘要失效**重建**、早期正常对话保留、legacy 无指纹会话保守失效、Clear generation 隔离）；ME-00 机制未改动，durable_memory 指纹覆盖新装配内容（格式变化 → 部署后每 session 一次保守重建，见 §5 已知影响）。 |
| M-A10 | 通过 | Clear：`clearThread` 事务内显式 `invalidateThreadMemoryEvidence`（accessible=false，不依赖 FK SET NULL）+ 仅本 Thread 证据的未确认候选删除（PG 测试）+ 已确认事实保留、来源引用标记不可访问（E2E 第 2 步实测 Clear 后事实仍在）；`threads.clear` 取消 `memory.extract` 作业，cursor generation 栅栏拒绝迟到回写（提取测试 “restarts from a cleared generation”）。Bot/Space 删除：FK 级联 + `destroyBot` 保留/归档语义镜像旧文档（保留时 bot-scope 事实转 user-scope，冲突命题记 superseded；删除时逐事实入 index_cleanup outbox，payload 携带 botId 供行级联后仍可清理）。 |
| M-A11 | 通过 | Worker+模型请求：`history.compact` payload 携带入队时固定的 `sourceRunId/modelProvider/modelId`（executor 在 finalize 处以刚完成的 Run 身份入队；backlog 重入队按新批次尾部 `findCompactionModelPin` 重新固定）；`compactHistory` 固定身份路径仅走 `resolvePinnedModel`（= `executor.resolveConnectedModel`，精确 provider/model 凭据），入队后改 Bot 模型不影响作业；凭据不可用 → `pinned_model_credential_unavailable` 永久失败日志、**不换模型、不推进游标**（测试 “passes the pinned model identity from the job payload” + 永久失败路径不触碰 CAS）。 |
| M-A12 | 通过 | 四模式：`compaction-mode.ts` + `ensureHistoryCompacted`（disabled 跳过 / nowait 入队即回 / wait_if_needed 有界等待同 generation 后 sync 补救 / sync 循环至 neededUpToSeq，全部受 generation 栅栏与 maxSyncRescues 约束）；预算触发 `decideCompactionTrigger`（token 预算命中 → reason=token_budget；窗口未知 → 诚实回落 message_threshold/window_unknown_message_threshold，不虚报精确 token）；超时/取消/重试沿用 graphile maxAttempts=4 + `recordHistoryCompactAttemptsExhausted`；start/persist 余量（绝对+比例）经 `validateCompactionMargins` 强制 persist 不早于 start；原始 PG 消息始终先提交（enqueue 位于 finalize 之后，注释钉住）。 |
| M-A13 | 通过 | 链式压缩：Java `CompactionTokenBudgetTest.tokenTriggerFiresFromTheRealWindowAndHookStaysBoundedMetadata`（同 session 两次真实压缩后续跑，无原生记忆文件）+ `CompactionBoundaryIntegrationTest.compactedSessionContinuesAcrossRunsWithSummaryAndRecentMessages`/`secondCompactionFiresAndSessionStillContinues`（7/7 保持）；应用游标与原生摘要独立（`nativeSummaryIsDistinctFromApplicationCompactionCursor` 保持 + `ThreadCompactionRevision` 链 PG 测试：previousRevisionId 链接、generation CAS、includesToolResults=false）。MR-01 同 operation 不重发：`manual-retry-reuse`/`executor-approval-replay` 套件保持绿（retryOperationId 路径未触碰，84 项 executor 单测通过）。 |
| M-A14 | 通过 | Java 集成：原生无 memory 文件/flush/offload/悬空指针（AG-02 全套 7 项 + 新 token 测试均断言 workspace 无 `memory/`、无 MEMORY.md）；token 保留语义与小/大窗口一致（`productionCompaction(8192)` → trigger 4096/keep 2000；`productionCompaction(200000)` → 180000/8000；null → 128000 默认——与 AgentScope 动态公式逐位一致，显式化后“30/10”仅是文档化的粗粒度兜底）；Hook 不写原始内容（stderr 捕获断言含 run/thread/generation 元数据、**不含**消息正文与 filler 文本）。 |
| M-A15 | 通过 | 空库迁移：`wp_me0102_check`/`wp_me0102_fresh`/`workpal_e2e_memory` 三个全新库 `prisma migrate deploy` 118/118 成功（含 partial unique、NULLS NOT DISTINCT 索引）；旧数据：迁移为 expand-only，不重写任何现有行、部署时零模型调用；旧 API `memory.list/update/exportMarkdown` 原样可用（router 84 项单测 + knowledge-panel 既有 E2E 断言路径不变）；中文可读：zh-CN 全部新词条翻译并编译（missing: []）；逐条 legacy 导入：`memory.facts.importLegacy` + Imported 标识 + 双向禁止（文档只写 `memory.update`，事实只写 facts API，无自动同步）；读路径回退：`WORKPAL_MEMORY_FACTS_ENABLED=false` 时 executor 走原 `loadAgentMemoryContext` 字节不变（legacy-only 逐字节一致单测即回退等价性证明）。回退演练：E2E/单测均在开关默认开启路径跑通，关闭路径由字节一致性测试钉住。 |
| M-A16 | 通过 | 暂停/定向启用：`SpaceMemoryPolicy.autoExtraction`（off 默认/on/paused），RPC `memory.policy.get/set`（space-owner 门），启用路径被真实执行（提取测试 policy=on 全流程、off/paused 拒绝且不触模型）；配额/并发/成本记账：`memoryJobsConfigFromEnv` 全部默认值+单位见 §3，`MemoryModelUsage` 按 (space,user,day,purpose) 记 calls+prompt/completion tokens（用量事件优先记 provider 实际 token，无用量事件时记估算并如实标注），日配额在模型调用**前**拦截（extraction/summary 各有测试）；并发=graphile worker 并发+outbox SKIP LOCKED claim。质量数据与工程 fixture 分开报告：本文所有“模型输出”证据均来自 loopback fixture/scripted runtime，未把固定回答当作真实模型记忆质量（见 §5）。 |
| M-A17 | 通过 | AG-01：auxiliary-isolation 集成扩到 6 scope（含 memory-extraction/memory-summary）全绿，零工具契约保持；AG-02：CompactionBoundary 7/7 + ToolResultEviction 4/4 + DelegationSuspension 3/3 保持（helper 未恢复、flush/offload 仍关）；AG-06：untrusted-content 6/6，trust-rules 字节断言原样；AG-07：provenance 集成保持，提取仅信 authorUserId+originKind；AG-03/04：scenario-contract 36/36（registry 增补为**有意变更**并注释：P15 家族、2 个新 scope、S12-C4/5/6；53+3=56 用例全有证据文件）+ scenario-contract.integration 20/20 真实 jar；AG-05/08：tool-visibility、permission-revoked 套件保持；MR-01：manual-retry 套件保持、retryOperationId 路径零改动。 |
| M-A18 | 通过 | 一次收口命令与结果见 §4（typecheck 全绿；单测/PG/jar/E2E 各层数字汇总；唯一失败项为基线既有的 journeys #54 group-chats，已在基线 commit `626142c` + 纯净库复现，与本批无关）。 |

## 2. 迁移与兼容决定

- **Expand-only 迁移**：`20261020100000_memory_facts_three_layer` 只建新表/索引，不重写旧行、不调用模型、可在空库与带旧文档库执行。active/candidate 去重用 partial unique index（superseded/deleted/rejected 保留 canonicalKey 作复活栅栏）；evidence 唯一索引 `NULLS NOT DISTINCT` 覆盖无消息证据。
- **旧 Markdown 单向规则**：`MemoryDocument` 仍是旧格式兼容写入口（`memory.update` 不变）；新事实是新结构入口（facts API + 工具）；**禁止双向自动同步**。逐条用户确认 → `legacy_import` 事实并记录 `sourceDocumentId`，装配器对已导入文档跳过（不双重注入）；**删除与撤销导入分离（评审轮 P1-2）**：删除导入事实 = 记忆删除且文档保持屏蔽；撤销导入（`revertImport`，state=reverted，正文清理）= 回到旧文档格式入口；拒绝 = 不导入（文档照旧）。旧文档不自动伪装成原子事实。
- **ME-00 保留**：原生摘要失效仍按指纹 + 可信历史**重建**（非 drop-only），resume 跳过、sidecar 后写；新装配内容改变指纹 → 每 session 一次性保守重建（预期行为，非缺陷）。应用侧摘要派生依赖用 `ContextSummary.sourceVersions` 版本机制表达：任何分片版本/权限失配即拒读。
- **P07 压缩指令有意扩展（M4 摘要内容要求）**：`prompts/auxiliary/history-compaction.md` 从“facts/decisions/unresolved work/preferences”扩展为显式要求**当前目标、已完成动作（点名已执行的外部操作以防重发）、决策、未完成事项与开放问题、续跑所需资源（标识符/路径/链接原样保留）、下一步**——对应用户结果 #4“知道哪些外部操作已完成，不重复发送”。首句（P07 registry marker）逐字保留；黄金样本**定向**再生成，diff 审查确认仅 `aux-history-compaction.json` 的指令文本变化，其余 24 个 fixture 字节不变（非整体刷新）。修订记录的 `promptVersion`（段文本 sha256 前 12 位）随内容自动更新。
- **压缩兼容**：`Thread.historyCompactedUpToSeq/Summary/Generation` 指针原样保留（前端与 Worker 兼容）；`ThreadCompactionRevision` 是新增审计链（`includesToolResults=false` 如实记录产品消息不覆盖完整工具结果）。`history.compact` 旧 payload（无固定身份）仍可执行（回落 resolveModel 链），新入队一律携带固定身份。
- **回退开关**：`WORKPAL_MEMORY_FACTS_ENABLED=false` → 注入回到旧 32KiB 文档路径（字节不变）、执行器不再入队 memory.extract；worker 两个 memory sweep 不启动。新表保留供修复，不覆盖旧文档。`WORKPAL_MEMORY_LEGACY_INJECTION_RETIRED=true` → 总预算收至 2000、legacy 层退出自动注入。`WORKPAL_HISTORY_COMPACTION_MODE=disabled` → 应用压缩整体关闭（实验/回滚）。
- **离线备份边界**：用户删除会清空事实行与全部修订正文（保留 id/actor/revision/动作），但**不宣称离线备份即时擦除**；按现有备份保留策略，恢复流程必须重放删除记录（`memory_fact_revisions` 的 deleted 行即删除日志）以防复活。DEP-01 主机备份改造不在本批。
- **“删除记忆”≠删除聊天**：原始消息不动；仍保留的聊天内容可能再次进入正常历史与提取输入（提取的 tombstone/证据栅栏阻止由**同一旧证据**自动重建已删记忆；新的明确用户指令可建立新版本）。UI/测试均区分两种操作；不声称真实模型已“忘记”。

## 3. 预算 / 模型 / 配额默认值（实际值与单位）

**注入预算（估算 token，`estimatePromptTokens`≈4 字符/token、CJK≈1 字符/token，从不冒充精确计数）**：

| 项 | 迁移期 | legacy 退役后 | 说明 |
| --- | --- | --- | --- |
| 总量 | 4,000 | 2,000 | 旧文档+新内容合计硬上限 |
| 旧 Markdown 文档 | 2,000 | 0 | 子预算不互借 |
| 新汇总 | 1,200 | 1,200 | 超限确定性截断 |
| 补充事实 | 800 且 ≤10 条 | 800 且 ≤10 条 | 选取=任务词重叠→最近确认 |
| 小窗口 | ×(window·0.05/4000) 比例收缩 | 同 | 不挤占最近消息与工具预算 |
| 读取防护 | 32 KiB（字节） | 同 | 仅防护，不是注入预算 |

**压缩余量（估算 token / 比例，env 可配）**：start=8,000 tokens 或 window×0.10 取大；persist=4,000 或 window×0.05 取大；输出预留 4,000；校验 persist 余量 ≤ start 余量（persist 不得早于 start 触发）。原生层：reserved 20,000；trigger=window−reserved（放不下时 window/2 兜底）；keep=clamp((window−reserved)×0.25, 2,000..8,000)；消息数 30/10 仅为粗粒度兜底。

**作业配额（服务端配置，env 覆盖，单位）**：提取扫描 200 条/作业；单次模型调用 ≤50 条可信消息、≤20,000 字符输入、≤5 个候选；汇总 ≤200 条事实、≤12,000 字符输入、输出 ≤1,200 估算 token；提取 50 calls/用户/UTC 日；汇总 100 calls/用户/UTC 日；记忆辅助合计 200,000 估算 token/用户/UTC 日（无计费数据，成本以 token+调用数记账，如实标注）；outbox 20 行/批、失败指数退避封顶 1h、10 次后 parked 24h（可见可重试）；汇总 fan-out ≤20 接收者/分片；辅助调用超时 120s；周期提取扫描间隔 `WORKPAL_MEMORY_SCAN_SWEEP_MS` 默认 300,000ms、每轮 ≤20 个滞后 Thread；outbox drain 间隔 `WORKPAL_MEMORY_OUTBOX_SWEEP_MS` 默认 30,000ms（频率同为服务端配置）。

**模型身份**：提取/汇总模型独立配置 `WORKPAL_MEMORY_EXTRACTION_MODEL`/`WORKPAL_MEMORY_SUMMARY_MODEL`（`provider/modelId`，复用该 provider 的部署密钥，不新增密钥材料）；未配置 → 部署默认模型；不可解析 → 作业显式跳过/失败，**绝不回落主聊天模型**。压缩摘要模型 = 入队时固定的会话 Run 身份（三者不混用）。每次调用记录实际 provider/model、prompt 版本（段文本 sha256 前 12 位）、实际 usage token（无 usage 事件时记估算）。

## 4. 测试命令与结果（最终收口）

```
# 类型检查：全工作区
pnpm check        # turbo check 18 tasks 全绿
node scripts/generate-prompt-texts.mjs && git diff --exit-code packages/core/src/prompt-texts.generated.ts   # 再生成 no-op（CI 门槛）

# 单元（vitest，仓库根）
pnpm exec vitest run packages/adapters/src --exclude "**/*.integration.test.ts" --exclude "**/*.postgres.test.ts"
# → 含新 memory-injection 12、memory-extraction 11（含模型调用期间 Clear 的整批丢弃用例）、
#   memory-summary 8、memory-outbox 6、memory-recall 4、compaction-mode 17、
#   memory/facts.test 9（去重优先级 + 秘密闸门先于数据库）、core/memory-content-safety 12
pnpm exec vitest run packages/db/src packages/core/src packages/memory/src packages/contracts/src apps/api/src --exclude "**/*.postgres.test.ts"
# → 合并全仓单测扫尾（adapters+db+core+memory+contracts+adapter-kit+api）：
#   288 files / 3,945 passed | 13 skipped；唯一失败 execution-rpc 1 项为基线既有（见 §5）
pnpm exec vitest run apps/web/src    # → 87 files / 677 passed

# PostgreSQL 集成（VERIFY_DATABASE=1 DATABASE_URL=…）
packages/db/src/memory-facts.postgres.test.ts          # 15/15
packages/testkit/src/authorization.test.ts             # 17/17（含新 RPC 穷举）
packages/testkit/src/journeys.test.ts                  # 40/41（#54 group-chats 为基线既有失败，见 §5）
packages/testkit/src/scenario-contract.postgres.test.ts（AGENTSCOPE_URL 指向已启动 jar）  # 10/10
packages/adapters/src/execution-contract.postgres.test.ts、packages/db/src/run-plans.postgres.test.ts 等  # 全绿

# Java（JDK 21）
mvn -B -f services/agent-runtime/pom.xml test    # 92/92（88 既有 + 4 新 CompactionTokenBudgetTest）

# jar 集成（AGENT_RUNTIME_SKIP_BUILD=1）
pnpm exec vitest run packages/adapters/src/agentscope-auxiliary-isolation.integration.test.ts packages/adapters/src/agentscope-untrusted-content.integration.test.ts packages/testkit/src/prompt-files-baseline.integration.test.ts packages/adapters/src/scenario-contract.integration.test.ts
# → 46/46；黄金样本零漂移（未重新生成任何 fixture）
packages/testkit/src/history-compaction-agentscope.test.ts   # 1/1（真实链空摘要契约，见该文件注释：
# AgentScope 2.0.3 对纯空白响应会再推理一轮，空白场景由 61 项受控单测钉住）

# Worker 链（真实 worker 进程 + graphile + Java runtime + 模型 emulator）
WORKPAL_E2E_DATABASE_URL=postgres://…:5433/workpal_e2e_worker_chain pnpm test:worker-chain
# → 4/4 通过（queued-claim、cancel-retry、Routine over-budget outbox、crash-recovery exactly-once；
#   本地 teardown 阶段进程组收到 SIGTERM 使 pnpm 退出码为 143，四个用例结果均为 ✓）

# E2E
WORKPAL_E2E_DATABASE_URL=postgres://…:5433/workpal_e2e_memory pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec=memory-facts.spec.ts   # 1/1 (6.9s)
pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec=knowledge-panel.spec.ts   # 1/1 (8.1s) legacy 面板回归
```

**顺手修复的上游测试缺口**：`packages/db/src/repos.test.ts` 的紧凑侧栏字段期望缺少 `avatarBodyColor`（main 上 b5bb870 更新映射时漏改测试，CI 的定向单测清单不跑该文件故一直潜伏）；本批补齐期望并注明原因。

**真实请求与 provider 次数**：本地全部验证使用 scripted runtime、loopback HTTP fixture 模型（Java 集成/E2E）与 PG 事务断言——**零付费真实模型调用**。fixture 模型的请求次数被测试逐一计数（如两次压缩 = 2 次 SUMMARY + N 次 NORMAL，flush 计数恒 0）。线上真实模型下的提取/汇总质量未测（见 §5）。

## 5. 已知限制（如实注明）

1. **真实模型质量未评估**：候选提取与汇总的线上真实质量（误记/漏记/重复/召回相关性）未测；本批全部“模型输出”证据来自固定 fixture，只证明协议、校验与状态机，不代表记忆质量。扩大自动推断范围前需按任务书先测质量。
2. **本地环境的基线既有失败（均已在基线代码上复现，与本批无关）**：journeys #54 group-chats（基线 commit `626142c` + 全新数据库复现；其余 40 项 journeys 全绿）；`apps/api/src/execution-rpc.test.ts` 1 项（基线复现，与既往记录一致）；`packages/testkit/src/executor-lifecycle.test.ts` 4 项（lease 回收/uncertain effect/approval pause/group member，基线同一组复现）；`packages/testkit/src/bot-secrets.test.ts`（基线复现，run 停留 running 超时）。CI 的定向清单不覆盖这些文件，属上游潜伏问题；本批未掩盖也未修复它们（repos.test.ts 的一行期望缺失除外，见 §4）。
3. **外部索引清理的 provider 差异**：Serenity 支持按 id forget（投影时以 `[wp-fact:<id>]` 标记关联）；Supermemory 无 forget → 清理行 parked（attempts/lastError 可见、24h 重试），召回 tombstone 过滤保证已删事实不回流模型。外部索引始终是可重建投影，非唯一副本。
4. **语义冲突的非哈希边界**：canonicalKey 只解决“同一命题”的精确去重；不同措辞的矛盾命题（不同 canonicalKey）不会自动互相取代——由用户纠正/删除、提取候选的冲突呈现与注入端确定性排序（bot>space>user、最近确认优先）兜底。模型推断永远不能覆盖用户确认。
5. **ME-00 指纹一次性重建**：durable_memory 装配格式变化 → 部署后每个既有 session 首次运行时发生一次保守重建（预期内、幂等、无数据丢失）。
6. **群聊 Thread 不参与提取**（`thread.botId=null` → skipped）：群聊记忆需另行设计归属，本批不扩大范围。
7. **成本记账无计费数据**：以调用数+token（实际 usage 优先、估算兜底并标注）为成本代理，不虚构美元数字。
8. **多副本部署前提不变**：AgentScope 本地 JSON state 的跨实例问题（P4 §9）不因本批改变。
9. **溢出防护语义**：`detectContextOverflow` 只在估算请求超过**原始窗口**时硬性失败——估算器对 CJK 偏保守（1 字符≈1 token），若再扣除余量会误杀可运行请求；余量只用于压缩触发决策。边缘尺寸由 provider 作最终裁决。
10. **语义工具面保持既有 gating**：`recall_memory/forget_memory` 仍仅在配置外部 provider 时暴露（AG-03 冻结工具面不动）；无 provider 的 Bot 由自动注入承担召回、由 Knowledge UI 承担逐条删除，`remember` 始终可用。messaging-channel Run 按既有冻结面继续不暴露四个记忆工具（BACKEND_MESSAGING_CHANNEL 集合原样）；messaging 入口的记忆形成走提取候选（human_messaging 属可信来源）与 Web UI 管理，入口一旦可达事实服务，行为与 actor 记录和普通对话完全一致。这是有意的兼容决定，非能力关闭。
11. **save_memory 的作用域**：一律写 bot-scope 事实；外部 provider 的 isolated/shared 语义只影响索引投影命名空间。space-scope 事实只能经人工 promote 或 UI 产生（模型不能把记忆直接写入共享范围）。
12. **压缩修订的“策略”字段**：以 `promptVersion`（指令段 sha256）+ `includesToolResults` + 固定模型身份共同表达；调度模式（四模式）是执行期属性，不入修订行。

## 5.1 评审轮 R1（2026-10-20，PR #79）：两项 P1 修复

评审复现测试移植入分支（`packages/adapters/src/memory-review-repro.test.ts`，先红后绿）：

**P1-1 人工来源 ≠ 记忆授权。** 原实现只要求来源消息可信且内容不歧义即 `user_direct` 激活，"总结网页，不要保存记忆"这类回合中模型仍可静默激活记忆。修复：`remember/save_memory` 工具新增 `source_quote` 字段——单步激活要求模型逐字引用用户消息中的授权原话，服务端在可信消息内规范化核实命中（`isVerifiedAuthorizationQuote`，纯确定性、无语义判断）；同时 `containsMemoryRefusal`（中英文显式拒绝模式，core 层 25 项扫描器测试）命中即降级。未验证/被拒绝一律进入候选确认流（`authorization_unverified` / `explicit_refusal`），绝不激活。工具描述同步更新（有意变更）：黄金样本定向再生成，diff 审查确认 18 个 fixture 的变化 100% 限于 remember/save_memory 两个工具定义（描述 + `source_quote` schema），无其他漂移。scripted 测试运行时的 `turn.memory` 以消息原文为引用，保持确定性测试的激活语义（journeys/E2E 实测通过）。

**P1-2 删除已导入事实复活旧文档。** 原实现把"撤销导入"与"删除"合并为删除事实→文档解除屏蔽，导致"删除记忆"反而让旧正文回到 `<durable_memory>`。修复：新增 `reverted` 状态与 `memory.facts.revertImport` RPC（仅 legacy_import，CAS，正文清理，active 时触发分片/汇总失效）；`listLegacyImportedDocumentIds` 只排除 `reverted`——删除的导入事实**永久保持**文档屏蔽；UI 对 legacy_import 事实提供两步"撤销导入"，旧文档"Imported"徽标集合包含 deleted 状态。`reverted` 与 `deleted` 同样被全部读路径拒绝；授权穷举清单已含新 RPC（17/17）。

修复后全量复验：turbo check 绿；单测 4,643/4,644（唯一失败为基线既有 execution-rpc）；jar 集成 47/47（含再生成黄金样本）；PG journeys+authorization 57/58（唯一失败为基线既有 #54）；memory-facts PG 15/15（含新 revert 语义）；E2E memory-facts + knowledge-panel 2/2。

## 6. 与 UX-02 的协调

共同文档提交 `ee8db3c` 随本功能 PR 一并进入 main（UX-02 线合入最新 main 后只保留其自身差异）。本批触碰的共享面及边界：`executor.ts`（记忆加载/装配、finalize 压缩入队、instructions 提升为 `composedInstructions` 常量——字节不变）、`adapter-kit` types（executionScope +2、BackgroundJobPayloads +3、history.compact payload 扩展——均为**追加**，不改既有字段语义）、`contracts/rpc.ts`（memory 家族内追加子命名空间）、case-registry（P15/新 scope/S12-C4..C6，注释标明有意变更）、prompts/（4 个新段，P06/P15 归属登记）。retryOperationId、AG-05 每请求工具刷新、TurnPolicy、plan/step/todo 工具面**零改动**；UX-02 计划审批线与本批无重叠修改块。UX-02 worktree 截至本批收口尚未建立，无并行冲突发生。
