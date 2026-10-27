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
| 真实模型 / 夹具 / scripted | 红绿两轮都不用真模型：测试用记录型 fixture model（127.0.0.1 随机端口）驱动 `RuntimeEngine.execute`，断言实际发出的请求体。真模型复测另列在"未完成项" |

## 文件

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| [red.log](./red.log) | 修复前，`mvn -B -f services/agent-runtime/pom.xml test -Dtest=RuntimeProjectIsolationTest` | exit 1，`Tests run: 1, Failures: 1`，失败消息里印出发给模型的原文 `<agents_context># AGENTS.md PERSONA_LEAK_CANARY_7f3a …</agents_context>` |
| [green.log](./green.log) | 修复后，**同一条命令、同一个用例** | exit 0，`Tests run: 1, Failures: 0`，BUILD SUCCESS |
| [java-suite.txt](./java-suite.txt) | 修复后完整 Java 套件 | `Tests run: 127, Failures: 0, Errors: 0`，BUILD SUCCESS（分支前是 126，多的 1 个就是新用例） |
| [golden-baseline.txt](./golden-baseline.txt) | 修复后 AG-04 final-request golden 基线（真实 TS→Java 链路） | 1 passed，**不需要重生成基线** |
| `chain.log` | `pnpm test:worker-chain` 与 `pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` | 见下方状态 |

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
| `chain.log`：`pnpm test:worker-chain` | 运行中 | 本机可跑：`JAVA_HOME` 指 Homebrew JDK21、`DOCKER_HOST` 指 colima socket、`TESTCONTAINERS_RYUK_DISABLED=true`（colima 挂不了 socket 路径给 Ryuk）。结果与退出码跑完后补入本目录 |
| `chain.log`：`pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` | 运行中 | 同上，接在 worker-chain 之后跑 |
| 真模型复测（仓库根 `pnpm dev:app`，问"你是谁"，截图 + 抓包里 `<agents_context>` 为空的片段） | **未执行** | 需要真模型凭据、抓包代理与浏览器操作。**不用** fixture model 的绿冒充真模型复测；负责人的 `persona-capture/` 抓包不在本仓库，也不当作已核对证据引用 |
| 生产镜像影响核对（`WORKDIR /app` 下是否已有 AGENTS.md / `knowledge/` / MEMORY.md） | 未执行 | 修复后无论镜像里放什么都不会被注入，但"当前镜像里有没有"这一事实未核对 |

按 [AGENTS.md](../../../AGENTS.md) 第 6 条，缺项在本分支补齐，不另拆"补验收"任务；补齐前本卡不判定完成、不建议合并。

## 没有做的事

- 没有改仓库的 `AGENTS.md`（任务卡明确要求保持原样）。
- 没有改启动目录、没有在启动脚本里 `cd`、没有删除任何文件来藏症状。
- 没有改 `PromptComposer` 的段落，没有改 bot 人设来源。
- 没有 fork harness，没有升级 harness 版本。
- 没有重生成 AG-04 golden 基线（不需要）。
