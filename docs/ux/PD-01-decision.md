# PD-01 决策：纯进度型 cancelled Run 的消息级轻量重试入口

> **状态：决策已批准，实现未开始。** 产品负责人于 2026-10-21 在三方案比较中明确选择方案 3（消息级轻量重试入口）。本文档合并即决策生效；实现是门控在本文档之后的独立任务（单独 PR、单独验收），roadmap 不将实现记为 `done`。
> 关联证据：[MR-01](../mr01-manual-retry.md)（PR [#73](https://github.com/huiliuxu780/WorkPal/pull/73)，`12fea0e`）、[UX-01B 实现记录](./UX-01B-implementation.md)（PR #62，`fc2daa3`）、CAP-01（PR [#81](https://github.com/huiliuxu780/WorkPal/pull/81)，`457d27f`，roadmap 行 25）。
> 本文只记事实、决策、非目标与重评条件；实现期以最新 main 定位代码。

---

## 1. 事实（代码核实，2026-10-21 @ main `7fe9aff`）

- **执行卡表面 = 恰好四个信号**（UX-01B 已采纳规则，`apps/web/src/lib/execution-surface.ts:33-37`）：结构化 Plan、语义 Step、待处理 Intervention（含 waiting 态）、失败。`cancelled` 不是信号；Todo、工具 Activity、纯 running 态从不单独构成表面。
- **缺口是 Task Center 退役的已知副作用，不是新需求**：MR-01 交付时明文把「无 Execution shell 的 cancelled root」指给 Task Center Retry（`docs/mr01-manual-retry.md:13`：“Do not force a chat shell”）；CAP-01 退役 Task Center 后该入口消失，cancelled-retry E2E 改走 tracked-steps fixture（有卡路径）。
- **重试语义服务端已就绪，但入口所需的 Run↔消息关联投影不完整**：此类 Run 的 `threads/get executions` 摘要已携带 `manualRetry.allowed=true` 投影（`packages/db/src/execution-history.ts:381-386`）；`runs/retry` RPC、clientNonce 幂等（`@@unique([spaceId, clientNonce])`）、`retryOfRunId` successor 链、root/trigger/terminal/thread-busy 强制（`packages/db/src/manual-retry.ts:266-372`）全部适用于它们；Retry 按钮目前只渲染在执行卡上（`apps/web/src/components/ai/ExecutionCard.tsx:188-204`）。
- **群聊缺口（实现不是纯 UI 改动）**：群消息路由到多个 Bot 时，只有**首个** Run 写入触发消息的 `runId`（`apps/api/src/thread-target.ts:1371-1376`）；历史分页仅从消息 `runId` 收集执行摘要（`apps/api/src/thread-target.ts:871-880`）；`ExecutionSummary` 契约不含 `sourceMessageId`（该字段只在逐 Run 拉取的 detail snapshot 上，`packages/contracts/src/execution-snapshot.ts:159`，而分页恢复关联恰恰需要先有 message→runs 映射）。因此第二个及以后 Bot 的无卡 cancelled Run **无法关联到触发消息、也无法在分页后恢复**——PD-01 需要集中式后端投影/契约改动（例如在 summary 层暴露每个 Run 的 source message，或等价的 message→runs 投影）加群聊分页 E2E，不能按纯前端改动实现。单 Bot 线程的现有关联（消息 `runId` 唯一对应其 Run）不受此缺口影响。
- **占比无法从真实使用统计**：生产冻结在 2026-10-07 Python 部署（约 7 条消息），无度量基础。语义上此类 = 「用户在首个语义 Step 发布前 Stop」（误发/停错 Bot 等最常见取消路径；plan_rejected 与 wait_timeout 分别带 Plan/Intervention 表面、有卡，不在缺口内）。注意：工具动作不构成表面信号，「执行过工具但未发布 Step 即被取消」的 Run 也落此类——它恰恰最依赖 MR-01 的 `ExternalEffect.operationId` 复用（裸重发会重复外部副作用）。
- 剩余 Run 列表表面（侧栏 Activity 列表）包含 cancelled，但点击仅导航到会话，无重试动作。

## 2. 决策（方案 3）

为「无执行卡的 cancelled root Run」提供**消息级轻量重试入口**，决策约束如下（实现不得违反）：

| # | 约束 |
| --- | --- |
| D1 | 不改变 UX-01B 四信号执行卡规则；`cancelled` 不成为第五个执行卡信号 |
| D2 | 不恢复 Task Center |
| D3 | 入口挂在对应触发消息的现有消息操作区域（hover rail，已有 Reply/Quote 先例）或等价轻量区域 |
| D4 | 仅当服务端投影 `manualRetry.allowed=true` 时显示可执行入口；denied 时不得显示可执行入口，必要时可显示真实原因（沿用现有 reason 投影与文案） |
| D5 | 点击必须复用既有 `runs/retry` + `clientNonce` + `retryOfRunId` + `ExternalEffect.operationId` 语义；不允许通过重新发送消息模拟 retry |
| D6 | 历史分页加载后，入口必须能根据同一 Run 投影正确恢复 |
| D7 | 有执行卡的 cancelled Run 继续使用卡上既有 Retry，不得出现双入口 |
| D8 | 需要 取消→重试→successor 链 E2E；重试进行中防双击产生多个 successor |
| D9 | 实现范围包含**集中式后端投影/契约改动**：每条消息触发的全部 Run（含群聊第二个及以后 Bot 的 Run）必须能在历史分页后关联回触发消息；改动集中在后端投影/契约与前端 API 层，不在页面中散落协议分支（AGENTS.md 兼容规则） |
| D10 | E2E 必须覆盖**群聊分页**：多 Bot 群消息 → 取消第二个 Bot 的无卡 Run → 翻页/reload 后入口仍能从投影恢复 |

## 2.1 实施切片

2026-10-25 的 ROADMAP-CARD-CONVERGE 将实现拆成两个独立、可审查的切片：

- **PD-01P：集中投影。** 交付 D9 要求的后端投影/契约改动：每条触发消息能关联它的全部 Run（含群聊第二个及以后 Bot 的 Run），历史分页/reload 后仍可恢复。纯后端与契约，不改 Web 页面，不恢复 Task Center。
- **PD-01F：消息入口。** 消费 PD-01P 冻结的投影，在触发消息的现有消息操作区域提供轻量 Retry；复用既有 `runs/retry`、`clientNonce`、`retryOfRunId` 和 `ExternalEffect.operationId` 语义。它不是 InteractionView、DisplayBlock 或 Card Shell 成员，不成为 ExecutionCard 的第五个信号，也不与有卡 Run 的 Retry 形成双入口。

两个切片分别验收；PD-01F 依赖 PD-01P，并在 CARD-01B 之前与 RT-09 串行（roadmap 顺序：PD-01F → RT-09 → CARD-01B）。

## 3. 非目标

- 不为 cancelled 生成任何执行卡（含"最小卡"）。
- 不新增第二套 Run 状态模型、不新增后端重试系统。
- 不扩展到非 root Run、delivery/created/spawn trigger（现有 eligibility 投影原样生效）。

## 4. 重新评估条件

- 若入口与消息操作区既有动作产生可证实的混淆或误触，回收并重新决策。
- 若真实使用证据（部署恢复后）显示此类 Run 占比可忽略，可在后续决策中降级或移除入口。
- 任何将 `cancelled` 提升为执行卡信号的提议都是新决策，须重开 UX-01B 表面规则评审，不在本文档范围内。
