# CARD-01E evidence

Base: `8054caccb9cf347ad4cc7ca1630014814ccb016a`（`origin/main`，PR #153 后）
Branch: `codex/card-system-completion`

本目录保存 CARD-01E 的产品运行截图、测试摘要和红绿/变异证据。命令在从 base 新建的独立 worktree 执行；E2E 使用本机 colima Docker（将 `DOCKER_HOST` 指向 colima socket）启动一次性 PostgreSQL 与真实 API/Worker/Web。

## 截图索引

### Attention / 通知（N1–N4）

| 文件 | 场景 |
| --- | --- |
| `N1-queue-1440.png` | 真实 pending ask 进入队列、来源跳转 |
| `N1-queue-390.png` | 390px 队列 |
| `N1-queue-375.png` / `N1-queue-375-dark.png` / `N1-queue-390-dark.png` | 375/390、深色、面板不越界 |
| `N2-member-waiting-1440.png` | 群成员等待标记来自该群自己的队列项 |
| `N3-badges-1440.png` | 未读与待处理分开表达 |
| `N4-notification-1440.png` | 固定脱敏通知文案 |
| `N1-queue-denied-1440.png` | 浏览器通知被拒绝时队列仍可用 |

### DisplayBlock（D1–D7）

`display-blocks-desktop-1440.png`、`display-blocks-desktop-lower.png`、`display-blocks-390.png`、`display-blocks-390-top.png`、`display-blocks-375.png`、`display-blocks-390-dark.png`、`display-markdown-320-reflow.png`、`display-chart-detail-desktop.png`、`display-html-detail-desktop.png`。

九类展示（markdown/table/chart/collection/media/html/task_status/page/voice）、详情视图、390/375/深色/窄屏回流；同一页包含旧 `connect` 只读卡（见 `card-display-content.spec.ts` 断言）。

### 交互卡（A1/A7/A10）

- `card-ui-tool-approval.png`：真实工具审批替换 legacy ask，只有一张可操作卡。
- `card-ui-mcp-desktop-1440.png` / `card-ui-mcp-390.png` / `card-ui-mcp-375.png` / `card-ui-mcp-terminal-dark.png`：MCP assignment 的 `allowAllTools: true` 风险范围、窄屏、深色终态。
- `card-ui-outbound-r1-desktop.png`、`card-ui-outbound-r2-card-desktop.png`、`card-ui-outbound-r2-card-375.png`、`card-ui-outbound-r2-audit-desktop.png`、`card-ui-outbound-edit-desktop.png`、`card-ui-outbound-confirm-desktop.png`、`card-ui-outbound-confirm-390.png`、`card-ui-outbound-confirm-375.png`：A10 同卡编辑、不可变 revision、确认页与 fingerprint。

### 群成员审批（X-GROUP）

- `X-GROUP-APPROVE-1440.png` / `X-GROUP-APPROVE-430.png` / `X-GROUP-APPROVE-terminal-1440.png` / `X-GROUP-APPROVE-terminal-430.png`：批准分支与终态。
- `X-GROUP-FAIL-1440.png` / `X-GROUP-FAIL-430.png`：无成员管理权限只出现独立失败状态。
- `X-GROUP-source-1440.png` / `X-GROUP-source-390.png` / `X-GROUP-target-1440.png`：来源单聊请求卡与目标群消息。
- `X-RETURN-source-1440.png` / `X-RETURN-source-390.png`：message_group 执行完成后的来源回执（不是卡片，不进入 attention）。

### Gate-off legacy

`legacy-approval-input-request.png`、`legacy-approval-resumed.png`、`legacy-approval-resumed-after-reload.png`、`legacy-approval-stopped-run.png`：gate 关闭时 legacy InterventionRegion/AskCard 的真实运行；回答后同一 Run 完成，不再产生第二张 pending 卡。

## 测试摘要与红绿证据

`logs/` 中：

- `attention-postgres.txt`：`VERIFY_DATABASE=1 pnpm exec vitest run packages/db/src/attention.postgres.test.ts` → **16/16**。
- `attention-mutation-expiry.txt`：删掉 `expiresAt` 过滤后，过期即时退出用例转红。
- `attention-mutation-archived-bot.txt`：删掉 `source_bot."archivedAt"` 过滤后，群内发卡 Bot 归档用例转红。
- `approval-resume-branch-red.txt` / `approval-resume-base-red.txt`：同一过期断言在分支和干净 base `8054cac` 上都红（Expected 2 / Received 0）。
- `approval-resume-green.txt`：按 FIX-127 契约更新断言后 **1 passed**。
- `e2e-gate-on.txt`：任务书指定五个 gate-on spec **13 passed**。
- `unit-full.txt`：`pnpm test:unit` → 458/459 files，5541 passed；唯一失败为 `infra/sandboxes/supervisor/computer-loopback.test.ts` 的 4 条 401，`supervisor-baseline-red.txt` 在 base `8054cac` 上同样红。
- `postgres-full.txt`：最终无并发完整重跑 `pnpm test:postgres` → **51/51 files, 465/465 passed**；一次并发运行中出现过 `wakeup.postgres.test.ts` 的 3 条 500/600ms 窗口失败，单独重跑即绿。
- `checks.txt`：`pnpm lint` 0 error / 76 warning / 5 info；`pnpm check` 18/18；`pnpm --filter @rakazo/web build` 首次 16.33s、最终增量 3.12s；`check-docs` 169 个 markdown 链接正常。

## 尚未覆盖

- AgentScope 真模型链路（本机无模型 key）；E2E 使用仓库 deterministic scripted runtime，API/Worker/PostgreSQL/Web 为真实进程。
- 像素级视觉 diff；当前为实际截图与批准原型的人工并排检查。
- gate-on 的 takeover 卡片单独 E2E；takeover 生产入口由既有 gate-off `computer-needs-you-card.spec.ts` 与统一卡组件/单测覆盖，未在本轮重跑。
