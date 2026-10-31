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
| UI 分页（110 条 filler） | `pnpm test:e2e --runtime=scripted --spec="chat-chrome-v1.pagination.spec.ts"` | 0（1 passed） | `e2e-pagination.log` |
| Java AgentScope + 模型夹具 | `JAVA_HOME=<JDK21> pnpm test:e2e --runtime=agentscope --spec="chat-chrome-v1.agentscope.spec.ts"` | 0（1 passed） | `e2e-agentscope.log` |
| 真实 DashScope 模型 | `REAL_MODEL_API_KEY=<运行时提供> JAVA_HOME=<JDK21> pnpm test:e2e --runtime=agentscope --spec="chat-chrome-v1.real-model.spec.ts"` | 0（2 passed：qwen3.8-flash / qwen3.8-max） | `e2e-real-model.log` |

说明：

- scripted E2E 使用确定性 scripted runtime；Java AgentScope E2E 启动真实 `services/agent-runtime` JDK 21 进程，并用本地 OpenAI-compatible 模型夹具（`offline-fixture`）驱动工具调用。真实 Qwen 运行与夹具运行在报告中分别标注，不能互相冒充。
- 真实模型运行使用用户提供的 DashScope key，仅在运行时环境变量中使用；未写入仓库、日志或证据。
- 检查日志中的本机绝对工作区路径已统一替换为 `<worktree>` 或 `<other-worktree>`；命令、退出码和测试输出保持不变。
- 6 条 lint warning 是 `Shell.tsx` 既有未使用导入/变量，不由本次改动引入；未在本任务中做无关清理。
- 2026-10-31：上表是**本地定向**检查，不是全量。首轮 CI 暴露了三处定向覆盖不到的问题，已在后续提交修复：(1) 全量 web 单测里 `shell-execution-transcript.test.tsx` 的直接子节点断言撞上新的 704 `chat-column` 包装层——该文件不在本地 8 个定向文件内，故本地从未跑到；(2) 新增的 `apps/api/src/artifact-families.postgres.test.ts` 未登记进 `scripts/testing/test-inventory.mjs`，postgres 分组直接拒绝运行；(3) 归档的两个冻结原型 HTML 被 biome 扫到 21 个 error。最终 head 的结论以 CI 为准，不以本表为准。
