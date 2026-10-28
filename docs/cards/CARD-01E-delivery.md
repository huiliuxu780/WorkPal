# CARD-01E delivery record

状态：`in-progress`（复审发现的 Attention total 资格问题已修复；本地门禁在 head `54d90ad` 全绿，等待负责人复审；PR 未创建，生产 gate 仍关闭）

- 任务书：`docs/tasks/second-batch-20261028/CARD-01E.md`（第二批；该目录在主工作区未跟踪，本分支不新增）+ [旧 CARD-01E](../tasks/CARD-01E.md) 的无障碍/旧消息/视觉验收项
- 分支：`codex/card-system-completion`
- 基线：`a29c71123d50929faa05d2df588f487169eaad79`（最新本地 `origin/main`，PR #149 后；分支已 rebase 到该点。原始红基线 A/B 使用 `8054cac`）
- 门禁 head：`54d90ad`（本文件与截图/日志在随后的 docs/evidence 提交中定稿；代码自该 head 后未变）

## 用户现在能完成的流程

- 在真实聊天里收到并处理 Input（question / choice / secret）、Action Approval（tool / outbound / connect.app_authorization / connect.mcp_assignment / skill_save / group_membership）、Plan Review 和 Session Control（takeover / return）。生产入口、严格投影、Transaction、消息卡片、Attention、通知和历史刷新使用同一份权威事实。
- 在 Web 的 Attention 入口看到只属于当前用户、仍可打开的 pending 请求，点击只回到来源卡片；处理后条目与计数在下一轮读取中消失，通知只覆盖新请求且使用固定脱敏文案。
- 在聊天中查看 Markdown、结构化表格、图表（含数据表替代）、集合、媒体、沙箱 HTML、文档 Page、task_status 和语音展示；旧 `card` 与旧 `connect` 记录只读回放，不产生新动作。
- 390px / 375px / 深色 / 键盘：Attention 面板有 Escape 关闭与焦点恢复断言，展示卡和交互卡有 390/375 无横向溢出与深色截图。
- `cards_unified_v2` 默认仍是 `false`：关闭时旧页面与旧 API 行为不变；开启时走统一投影。Attention RPC 在 gate 关闭时明确返回 403，而不是伪装成空队列。

## 本次实现

### 1. Attention 的持久化读模型与规模边界

- 新迁移 `packages/db/prisma/migrations/20261028210000_attention_intervention_projection/`：`attention_interventions` 窄表 + `interventions_attention_projection` 数据库触发器 + 现有 pending Intervention 回填。触发器从所属 Run 派生 `userId`，覆盖当前和后续写入路径（含 `createMany` / `deleteMany`）；Intervention 离开 `pending` 的同一事务删除投影行。
- `packages/db/src/attention.ts` 改为：
  - 持久 pending Intervention 走投影表的 keyset 分页（`expiresAt ASC NULLS LAST → attentionAt ASC → interactionId ASC`），`total` 是同一过滤条件下的精确 `COUNT(*)`；只加载当前页的 Intervention 行、effect 状态和 RT-12 membership facts。
  - 可见线程、Bot 归档（含群内发卡 Bot）、目标群管理权限和 `expiresAt` 都在 SQL 内过滤；过期条目在 timeout job 结算前就退出队列。
  - Session Control（含委托接管）仍由当前活跃 Run / origin 链派生，深度上限 8；消息内业务审批仍走 `messages_blocks_gin`，只匹配 pending 审批块，不扫描历史消息。
  - 非法游标回退第一页，不让坏输入进入 SQL 参数绑定。
- 决策与残余记录补充在 [attention query bounds](./attention-query-bounds.md#6-card-01e-落地2026-10-28)。

### 2. 一致性修复

- **Attention RPC 受总 gate 约束**：`apps/api/src/router.ts` 的 `attention.list` 在 `cards_unified_v2` 关闭/未配置时返回 `FORBIDDEN`；新增 `apps/api/src/attention-rpc.test.ts`（2/2）。
- **旧 `connect` 只读回放**：`apps/web/src/pages/Shell.tsx` 渲染存量的连接状态卡（名称、首字母、Connected/Not connected），没有按钮或链接；E2E fixture 与 `card-display-content.spec.ts` 断言零可操作元素。
- **过期/归档/失权即时退出**：`attention.postgres.test.ts` 新增过期即时移除、群内发卡 Bot 归档、目标群失去管理权限三个用例；总数在三种情况下都精确回落。
- **FIX-127 后的过期 E2E 断言**：`apps/web/e2e/approval-resume.spec.ts` 仍期待“回答后再次提问”的旧脚本行为，自 `b08c6e1`（FIX-127）起与持久化 Runtime 契约相反。已在 base `8054cac` 上复现同一红，再按“回答后同一 Run 完成、不再产生第二张 pending 卡”更新断言；更新后通过。
- **choice 答案 label**：真模型验证暴露 selected choice 恢复时把 `choice-N` wire id 交给模型（用户选 Berlin，`qwen3.8-max` 回复 Seoul）。`resumeAnswerFromAsk` 现在只把 choice 的 id 解析成 label；free-text、approval/plan/budget action id 保持原样。单测 4/4，max 复跑回复 Berlin。
- **Attention total 与严格投影同资格**：复审复现 `items=0,total=1`——SQL 先数投影行、严格投影随后丢弃不可渲染行。现在 `durableFilters` 把结构性不可渲染条件放进 count 和分页共用的 SQL；plan review / 成员审批的嵌套 payload 在同一快照内批量严格校验并从 total 扣除。历史回填的坏行既不显示也不计数。PostgreSQL 回归：旧实现 total 比基线多 4，新实现持平；attention 套件 17/17。

### 3. Gate 与兼容

- 总 gate 解析、服务端投影、Web capability 和默认关闭行为沿用 CARD-01A–D；本卡没有改默认值，也没有改 roundtable gates。
- 旧 `card` / `connect` 没有新增生产者；旧消息仍由 legacy renderer 只读回放。`collaboration_receipt`、private pair receipt、`task_status` 和 PD-01 Retry 的归属未改变。

## 场景映射

| 场景 | 生产实现 | 测试 / 证据 |
| --- | --- | --- |
| A1 工具审批 | `packages/adapters/src/executor.ts` 的审批暂停 → `packages/db/src/events.ts` pauseRunForInput → `ToolApprovalCard` | `card-ui-interactions.spec.ts`（真实 scripted Run + gate-on 卡）, `approval-resume.spec.ts`（gate-off），`InteractionCards.test.tsx` |
| A2/A3 密钥与登录 | `request_secret` 工具 → `InputRequestCard` secret 分支 | `builtin-tools.ts` schema，`InputRequestCard` 单测，`InteractionCards.test.tsx` |
| A4 提问 | scripted/AgentScope ask → `InputRequestCard` question | `card-attention.spec.ts` 真实 ask + 队列跳转，`InteractionCards.test.tsx` |
| A5 选择 | `ask_user` 选项 → choice 分支 | `InteractionCards.test.tsx`，contracts 严格 payload 用例 |
| A6 建空间 | `create_space` 工具走同一工具审批/外部效果路径 | 工具 schema + `InteractionCards.test.tsx` |
| A7 连接授权 / MCP assignment | `onboarding.ts` app_connect；`executor.ts` add_mcp_server；`ActionApprovalCard` 两个严格 payload | `card-ui-interactions.spec.ts`（MCP 真实入口、390/375/深色），`mcp-approval-card.spec.ts`（gate-off 存量状态），`InteractionCards.test.tsx` |
| A8 技能保存 | `teaching-session.ts` 写 skill_draft；`taught-skills.ts` 的 TaughtSkill 事务翻转 block | `CARD-01B-delivery.md` 的 A8 持久化用例，`InteractionCards.test.tsx` |
| A9 接管电脑 | `request_takeover` → `SessionControlView` → `SessionControlCard` | `InteractionCards.test.tsx` takeover/return；生产入口由既有 gate-off `computer-needs-you-card.spec.ts` 覆盖（本轮未重跑） |
| A10 外发草稿 | `outbound-drafts.ts` 不可变 revision + fingerprint；`OutboundApprovalCard` | `card-ui-interactions.spec.ts` 同卡编辑/确认 + 桌面/390/375/深色截图；`CARD-01B-delivery.md` 的 binding/冲突/字节上限用例 |
| A11 表单 | **不可用**：没有生产 producer，DB `inputMode` 也不能持久化 form | 契约/组件测试只验证严格视觉，不接入生产数据 |
| A12 saved item / payment | **不可用**：没有 saved_item 或 payment producer/业务事务 | 同上；不得用 fixture 冒充生产执行 |
| A13 计划审阅 | `pauseForPlanReview` → 独立 `plan_review` Intervention；`PlanReviewInteractionCard` | `plan-review.spec.ts` 4/4（真实计划版本、request changes、reject、幂等），`InteractionCards.test.tsx` |
| D1–D7 展示 | `packages/db/src/card-interactions.ts` 投影；`DisplayBlockView.tsx` | `card-display-content.spec.ts` 4/4（九类、详情、390/375/深色），`DisplayBlockView.test.tsx` |
| B1 交还桌面 | `SessionControlCard` return + `computer.release` | `InteractionCards.test.tsx` |
| B2 Routine | **不可用**：没有 routine 审批 producer | 组件只验证契约视觉 |
| B3 安装 | **不可用**：没有 install producer；授权部分由 A7 覆盖 | 组件只验证契约视觉 |
| B4 Page / B5 语音 | DisplayBlock page / voice | `card-display-content.spec.ts` |
| B6 表情回应 / B7 消息内跳转 | 既有消息 affordance / inline reference，不是卡片 | 既有 Web 单测与群聊 E2E |
| N1–N4 Attention / 通知 | `AttentionQueue.tsx` + 新读模型 + 固定脱敏通知 | `card-attention.spec.ts` 2/2（队列、来源跳转、375/390/深色、Escape 焦点、通知脱敏、拒绝权限），`AttentionQueue.test.tsx`，`attention.postgres.test.ts` 16/16 |

## 本地运行命令与结果

在最新 `origin/main`（`a29c711`）的独立 worktree 执行；E2E 使用 colima Docker 启动一次性 PostgreSQL，API/Worker/Web 为真实进程，runtime 为仓库 scripted runtime。

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm db:generate` | exit 0 |
| `pnpm lint` | 0 error（76 warning / 5 info，均为既有） |
| `pnpm check` | 18/18 tasks successful |
| `pnpm test:unit` | 460/461 files；**5550 passed / 2 skipped / 4 failed**（最终 head `54d90ad`）。4 条失败全部是 `infra/sandboxes/supervisor/src/computer-loopback.test.ts` 的 401；在 base `8054cac` 上同红（`logs/supervisor-baseline-red.txt`），与本 diff 无关 |
| `pnpm test:postgres` | 最终 head `54d90ad` 无并发完整重跑：**52/52 files, 474/474 passed**（`logs/postgres-full.txt`）。`attention.postgres.test.ts` **17/17**，含 total/严格投影资格回归（旧实现红、新实现绿） |
| `pnpm test:inventory` | 0 errors |
| `pnpm test:ci-select` | pass |
| `pnpm test:docs` | pass |
| `pnpm --filter @rakazo/web build` | 最终 head `✓ built in 4.74s`（首次 16.33s） |
| gate-on E2E（任务书指定 5 个 spec） | 最终 head **13/13 passed**（2.8m）；`logs/e2e-gate-on.txt` |
| 真模型 E2E（AgentScope Java Runtime + DashScope） | `qwen3.8-flash` 修复后 **1/1 passed**（36.3s）；`qwen3.8-max` 修复前 **1/1 passed**（30.8s）、choice label 修复后 **1/1 passed**（29.8s）；最终 head 复跑 **1/1 passed**（25.0s）：真实模型调用 `ask_user` → 统一 Input 卡 → Attention 行 → 选择答案 → Run 恢复并终态；`logs/real-model-e2e*.txt`、`logs/executor-resume-answer.txt` |
| gate-off legacy E2E（intervention-region / plan-review / mcp-approval-card / approval-resume） | 最终 head **9/9 passed**（47.2s）；`approval-resume` 的过期断言曾按 FIX-127 契约修正，红基线见 `logs/approval-resume-base-red.txt` |

Attention 变异验证（`logs/attention-mutation-*.txt`）：

- 删除 `expiresAt` 过滤 → 过期即时退出用例转红。
- 删除 `source_bot."archivedAt"` 过滤 → 群内发卡 Bot 归档用例转红。

## 页面与运行证据

截图、命令摘要与红绿/变异记录在 [docs/cards/evidence/card-01e](./evidence/card-01e/README.md)。关键截图：

- Attention：`N1-queue-1440.png`、`N1-queue-390-dark.png`、`N2-member-waiting-1440.png`、`N3-badges-1440.png`、`N4-notification-1440.png`。
- 展示卡：`display-blocks-desktop-1440.png`、`display-blocks-390.png`、`display-blocks-375.png`、`display-blocks-390-dark.png`、`display-chart-detail-desktop.png`、`display-html-detail-desktop.png`。
- 交互卡：`card-ui-tool-approval.png`、`card-ui-mcp-desktop-1440.png`、`card-ui-mcp-390.png`、`card-ui-mcp-375.png`、`card-ui-mcp-terminal-dark.png`、A10 `card-ui-outbound-*` 系列。
- 群成员：`X-GROUP-APPROVE-1440.png`、`X-GROUP-APPROVE-terminal-1440.png`、`X-GROUP-FAIL-1440.png`、`X-GROUP-source-390.png`、`X-GROUP-target-1440.png`、`X-RETURN-source-390.png`。
- 真模型：`real-model-ask-card-1440.png`、`real-model-attention-1440.png`、`real-model-answered-1440.png`（flash）；`real-model-max-ask-card-1440.png`、`real-model-max-attention-1440.png`、`real-model-max-answered-1440.png`（max，修复后）；`real-model-max-answered-before-label-fix.png`（max，修复前误答 Seoul 的对照）。
- gate-off：`legacy-approval-input-request.png`、`legacy-approval-resumed.png`、`legacy-approval-stopped-run.png`。

以上截图均来自真实页面与服务端投影；已与 `docs/cards/source/card-unification-v2/mockup/cards-hifi-v4/` 的 A1/N1 及 Roundtable X-GROUP 原型并排检查，结构与视觉语言一致（文字因 E2E 语言为英文）。

## 未实现能力与明确禁用方式

- `requestInput(form | saved_item)`、`requestApproval(payment | routine | install)` 没有批准的生产入口、权限语义或业务事务，因此本卡不新增 producer。生产投影不会产生这些视图；不存在“点了按钮返回模拟成功”的路径。组件层的视觉测试只证明契约渲染，不作为生产能力证据。
- `connect.app_authorization` 与 `connect.mcp_assignment` 是两条独立严格 payload；MCP 卡显示 `allowAllTools: true` 风险范围。
- HTML 展示沿用 `SandboxedHtmlViewer`：无同源、无网络、无表单提交、无父页面访问、无顶层跳转。

## 已知限制

- Attention 的 `total` 与分页共用同一资格规则；成本 ∝ 当前 pending 投影行数（即用户待处理队列本身），plan review/成员审批的嵌套严格校验只物化这两类行，不是 O(1)。消息内审批仍按 pending 块集合读取（GIN 命中，不随历史消息量增长）。详见 [attention query bounds](./attention-query-bounds.md#6-card-01e-落地2026-10-28)。
- 本机真模型补充验证：AgentScope Java Runtime + DashScope `qwen3.8-flash` 与 `qwen3.8-max`，`card-real-model.spec.ts` 1/1 通过；该 spec 需要 `REAL_MODEL_API_KEY` 才执行，CI/无 key 环境跳过。其余 E2E 使用仓库 deterministic scripted runtime，API/Worker/PostgreSQL/Web 都是真实进程。
- 视觉证据是实际页面截图与批准原型的人工并排检查，仓库当前没有 `toHaveScreenshot` 像素基线，因此不是像素级 diff。
- 生产 gate 是否开启由产品负责人决定；本分支保持 `false`。

## 敏感信息

提交前检查 `git status`、`git diff` 与新增截图：没有 `.env`、密钥、真实用户数据、私有 URL 或本机身份信息；E2E 账号和 `.test` 域名均为测试数据。真模型 key 只从 `REAL_MODEL_API_KEY` 环境变量传入并写入一次性测试库，未进入仓库、日志、截图或文档。
