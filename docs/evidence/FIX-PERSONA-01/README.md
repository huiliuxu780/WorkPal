# FIX-PERSONA-01 证据索引

单元：FIX-PERSONA-01（运行时不再把启动目录的 AGENTS.md 注入模型）。
分支 `codex/fix-persona-agents-context`，基线 `main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`。
任务卡：[docs/tasks/FIX-PERSONA-01.md](../../tasks/FIX-PERSONA-01.md)。

| 项 | 值 |
| --- | --- |
| baseline SHA（红） | `dc7d0723daacca43c321b7d3a32d6b99c78f09c6`（= `a409140` + 只加测试，不含修复） |
| fix SHA（绿） | `ff8666de1d1960b47fb70bd014ecbfd79efecfdd` |
| 回归用例 | `RuntimeProjectIsolationTest.startupDirectoryAgentsMdNeverReachesTheModel` |
| 环境 | macOS arm64；JDK 用 Homebrew openjdk 21.0.12.1，只设 `JAVA_HOME`，未装系统 Java、未改系统配置；Maven 3.10.0 |
| 真实模型 / 夹具 / scripted | 红绿两轮都不用真模型：测试用记录型 fixture model（127.0.0.1 随机端口）驱动 `RuntimeEngine.execute`，断言实际发出的请求体。真模型复测见下文"真模型复测" |

## 文件

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| [red.log](./red.log) | 修复前，`mvn -B -f services/agent-runtime/pom.xml test -Dtest=RuntimeProjectIsolationTest` | exit 1，`Tests run: 1, Failures: 1`，失败消息里印出发给模型的原文 `<agents_context># AGENTS.md PERSONA_LEAK_CANARY_7f3a …</agents_context>` |
| [green.log](./green.log) | 修复后，**同一条命令、同一个用例** | exit 0，`Tests run: 1, Failures: 0`，BUILD SUCCESS |
| [java-suite.txt](./java-suite.txt) | 修复后完整 Java 套件 | `Tests run: 127, Failures: 0, Errors: 0`，BUILD SUCCESS（分支前是 126，多的 1 个就是新用例） |
| [golden-baseline.txt](./golden-baseline.txt) | 修复后 AG-04 final-request golden 基线（真实 TS→Java 链路） | 1 passed，**不需要重生成基线** |
| `chain.log` | `pnpm test:worker-chain` 与 `pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` | **两条都通过**：worker-chain exit 0、5 passed（4.1m）；agentscope product E2E exit 0、6 passed（1.1m）。都跑在本分支构建的 jar 上 |

## 红为什么是目标缺陷

- 断言直接打印模型收到的内容，canary `PERSONA_LEAK_CANARY_7f3a` 原样出现在 `<loaded_context><agents_context>` 里，与负责人抓包看到的结构一致。
- 复现方式是"临时目录 + `System.setProperty("user.dir", …)`"，等价于 `pnpm dev:app` 在仓库根启动 JVM；不依赖真模型、代理或网络。
- 同一环境下 `RuntimeIntegrationTest` 等 126 个既有 Java 测试全绿，所以不是环境问题。
- 测试同时断言 backend 传入的人设（`Reply concisely.`）仍然到达模型，因此"把 system prompt 整个清空"这种假修复过不了。

## 一个被否决的修法，以及否决它的证据

先试过 `.disableWorkspaceContext()`：它确实去掉了泄漏，但同时删掉了整个 `## AgentStateStore Context` 段，而**已提交的 AG-04 golden 基线里含有这一段**——基线在 byte 7718 处漂移，`## Available Skills` 顶替了它。这超出了缺陷需要的改动面（模型可见文本被多删了一块），所以否决。

改用 `.filesystem(new LocalFilesystemSpec().project(harnessProject).projectWritable(false))` 后：

- `<agents_context>` 变成空块，泄漏消失；
- golden 基线**逐字节不变、无需重生成**（fixture 里本来就是空的 `<agents_context>`，这也解释了为什么该基线在 main 上是绿的却没能发现生产泄漏）；
- `## AgentStateStore Context` 保留。

`javap` 核对 harness 2.0.3 的 `HarnessAgent$Builder` 后确认：builder 没有 `project(Path)`，但有 `filesystem(LocalFilesystemSpec)`，而 `LocalFilesystemSpec` 有 `project(Path)` 与 `projectWritable(boolean)`。没有 fork harness。

## 断言的一处修正（如实记录）

初版测试的第三条断言要求 `agents_context` 标签**不存在**，那是针对被否决修法写的过度约束。改为要求该块**不携带内容**（空块可以，任何内容都失败）——这才是安全性质本身。canary、启动目录路径、人设保留三条断言在红绿之间**未改动**，其中 canary 那条就是 baseline 上失败的断言。

## 未完成项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `chain.log`：`pnpm test:worker-chain` | **已完成，通过** | exit 0，5 passed（4.1m）。本机前提：`JAVA_HOME` 指 Homebrew JDK21、`DOCKER_HOST` 指 colima socket、`TESTCONTAINERS_RYUK_DISABLED=true`（colima 挂不了 socket 路径给 Ryuk），jar 由本分支 `mvn package -DskipTests` 构建后配 `AGENT_RUNTIME_SKIP_BUILD=1` |
| `chain.log`：`pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` | **已完成，通过** | exit 0，6 passed（1.1m），同一 jar、真实 Java runtime |
| 真模型复测（仓库根 `pnpm dev:app`，问"你是谁"，截图 + 抓包） | **已完成，通过** | 见下方"真模型复测"；DashScope `qwen3.8-flash`，两次请求均 200 |
| 生产镜像影响核对（`WORKDIR /app` 下是否已有 AGENTS.md / `knowledge/` / MEMORY.md） | **已完成** | 见下方"生产镜像核对"；AGENTS.md **存在**（独立打包缺陷），MEMORY.md / knowledge 不存在 |

按 [AGENTS.md](../../../AGENTS.md) 第 6 条，缺项在本分支补齐，不另拆"补验收"任务；补齐前本卡不判定完成、不建议合并。

## 没有做的事

- 没有改仓库的 `AGENTS.md`（任务卡明确要求保持原样）。
- 没有改启动目录、没有在启动脚本里 `cd`、没有删除任何文件来藏症状。
- 没有改 `PromptComposer` 的段落，没有改 bot 人设来源。
- 没有 fork harness，没有升级 harness 版本。
- 没有重生成 AG-04 golden 基线（不需要）。

## 真模型复测（2026-10-28）

- 版本：分支 `codex/fix-persona-agents-context` @ `2126838`。Runtime 由本分支 `mvn package -DskipTests` 构建的 `services/agent-runtime/target/agent-runtime-0.1.0.jar` 启动（`AGENT_RUNTIME_HOST=127.0.0.1`、端口 7311、`AGENT_RUNTIME_DATA_DIR=/tmp/workpal-persona/runtime`），Web/API/Worker 用仓库根 `pnpm dev:app` 启动，DB 用一次性 PostgreSQL 16 容器（`127.0.0.1:55432`，本 worktree 独占），`SANDBOX_PROVIDER=fake`。
- 模型：DashScope `qwen3.8-flash`（真模型，不是 fixture）。因为内置 `dashscope` provider 不接受自定义 base URL，模型连接用仓库自带的 `openai-compatible` provider 指向本机记录代理 `127.0.0.1:7411`，代理把 `/v1/*` 原样转发到 `https://dashscope.aliyuncs.com/compatible-mode/v1/*`。代理只落请求体与响应状态，`Authorization` 头从不记录，本目录所有文件不含 key。
- 问句：`你是谁？你的工作原则是什么？`，通过真实 RPC `threads/send` 作为该 Bot 的第一条 Run 发出，Run 正常 `completed`。

结果（[real-model-request.txt](./real-model-request.txt)、[real-model-answer.txt](./real-model-answer.txt)、[real-model-screenshot.png](./real-model-screenshot.png)）：

| 断言 | 结果 |
| --- | --- |
| 请求里没有仓库 AGENTS.md 内容 | 通过：`不能从代码可靠推断`、`错误前提`、`独立 Web-only 项目`、`前端与原型铁律`、`任务交付与审核铁律`、`PERSONA_LEAK_CANARY` 全部 absent |
| `<agents_context>` 消失或为空 | 两次请求均为空块（inner length 0）；`<domain_knowledge_context>` 只有 harness 的静态说明，无仓库文件内容 |
| project 已钉到空目录 | 系统提示里 `Project (the user's source tree you're assisting with): /tmp/workpal-persona/runtime/state/harness-project`——正是修复 pin 的 `stateRoot/harness-project` |
| backend 传入的 bot/persona 指令仍存在 | 通过：该 Bot 的 `instructions`（"先说明你是谁，再列出你的工作原则"）原样出现在系统提示中 |
| 回答不再自称遵循开发仓库 AGENTS.md | 通过：回答以"我是人设探针（Persona Probe）"开头，列出的 9 条原则来自产品侧指令，不含仓库条款 |

说明：系统提示里仍会出现 `AGENTS.md` 这个词，但只出现在 harness 对 workspace-context 机制的**静态说明**（"AGENTS.md defines persona and local conventions…"）里，不是仓库文件内容；同一段说明把 project 指向空目录。Bot 的 title/description 本来就不进系统提示（与修复前一致），`instructions` 才是人设来源，这也是 Java 回归断言的同一个属性。

## 生产镜像核对（2026-10-28）

`docker build -f infra/compose/Dockerfile -t workpal-persona-verify:2126838 .`（本分支 worktree），随后 `docker run --rm … ls /app`（[image-app-listing.txt](./image-app-listing.txt)、[image-build.txt](./image-build.txt)）。

- `/app` 里 **有** `AGENTS.md`（还有 `CLAUDE.md`、`docs/`、`prompts/`、`scripts/`、`skills-lock.json` 等已跟踪文件）；`MEMORY.md`、`knowledge/` 当前不存在。
- 原因：`infra/compose/Dockerfile` 用 `COPY --chmod=755 . .` 把整个构建上下文放进 `/app`，`.dockerignore` 只排除了 `.git`、`.env*`、`node_modules`、`dist` 等。**这是独立的打包缺陷（生产镜像携带仓库文档与开发规则），按任务书不在本卡修 Docker 范围**，只记录事实。
- 该缺陷的影响面正是本卡修复要消除的：镜像里有没有这些文件都不再影响 system prompt——真模型请求已证明 project 被钉到空目录。
- 注：本次构建上下文来自本 worktree，因此清单里还有本地未跟踪产物（如 `test-report/`，不在 `.dockerignore` 中）；CI 构建不会带这些，但上面列出的已跟踪文件在 CI 镜像里同样存在。
