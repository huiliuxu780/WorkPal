# CHAT-CHROME-01 检查命令与退出码

日期：2026-10-30（Asia/Shanghai）

环境：`origin/main` @ `1d72923` 的独立 worktree；pnpm 锁定依赖；JDK 21（AgentScope）；一次性 PostgreSQL 库 `workpal_e2e_chat_chrome`（不记录连接凭据）。

| 检查 | 命令 | 退出码 | 日志 |
| --- | --- | --- | --- |
| 全仓类型检查 | `pnpm check` | 0 | `check.log` |
| 定向单元/集成测试 | `pnpm exec vitest run`（8 个文件，见 `unit.log`） | 0 | `unit.log` |
| PostgreSQL 投影/读取 | `VERIFY_DATABASE=1 pnpm exec vitest run apps/api/src/artifact-families.postgres.test.ts apps/api/src/thread-target.postgres.test.ts` | 0 | `postgres.log` |
| Web 构建 | `pnpm --filter @rakazo/web build` | 0 | `build.log` |
| 改动文件 lint | `pnpm exec biome check <changed files>` | 0（6 条既有 warning） | `lint.log` |
| scripted E2E + 回归 | `pnpm test:e2e --runtime=scripted --spec="chat-chrome-v1.spec.ts\|artifact-preview.spec.ts\|artifacts-tab.spec.ts\|group-chats.spec.ts"` | 0（7 passed） | `e2e-scripted.log` |
| Java AgentScope E2E | `JAVA_HOME=<JDK21> pnpm test:e2e --runtime=agentscope --spec="chat-chrome-v1.agentscope.spec.ts"` | 0（1 passed） | `e2e-agentscope.log` |

说明：

- scripted E2E 使用确定性 scripted runtime；Java AgentScope E2E 启动真实 `services/agent-runtime` JDK 21 进程，并用本地 OpenAI-compatible 模型夹具（`offline-fixture`）驱动工具调用。两者在报告中分别标注，不能互相冒充。
- 未运行真实第三方模型调用：本地环境没有配置模型凭据；真实 Java Runtime + 模型协议夹具已实际执行并保存 Thread/Run/Artifact 事实。
- 6 条 lint warning 是 `Shell.tsx` 既有未使用导入/变量，不由本次改动引入；未在本任务中做无关清理。
