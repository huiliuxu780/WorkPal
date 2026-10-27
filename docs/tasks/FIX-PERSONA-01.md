# FIX-PERSONA-01 运行时不再把启动目录的 AGENTS.md 注入模型

状态：`in-progress`（2026-10-28 在 `codex/fix-persona-agents-context` 上完成修复与 Java 侧红绿；TS→Java 链路与真模型复测见"完成标准"）

- 类型：bug
- 高风险：否（只动 prompt 组装，不涉及工具桥接、session admission 和取消）。但改动必须跑真实的 TS→Java 链路测试，原因是 system prompt 会变。
- 原型：不涉及 UI，不需要原型
- 回归测试：`services/agent-runtime/src/test/java/com/workpal/runtime/RuntimeProjectIsolationTest.java` → `startupDirectoryAgentsMdNeverReachesTheModel`
- 分支：`codex/fix-persona-agents-context`，基线 `main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`

## 事实（2026-10-28 抓包，真模型 qwen-plus）

- 在仓库根启动 agent-runtime，发出的 system prompt 里出现了 `<agents_context># AGENTS.md - 先检查问题有没有错误前提…`，仓库 AGENTS.md 的 10 条规则原样都在。模型回答时自称要遵守「AGENTS.md 约束」。
- 对照实验：其它条件不变，只把启动目录换成空目录 `/tmp/pcap-cwd`，`<agents_context>` 就变成空的。
- 同一个 prompt 里还有 harness 写的一句：`Project (the user's source tree you're assisting with): /workspace/wp-qa-main`。也就是说，模型被告知仓库就是「用户的源码」。
- 负责人抓包证据：`persona-capture/req-1.json`、`req-2.json`、`resp-1.txt`、`REPORT.md`（已脱敏，不含 key）。**这些文件不在本仓库里**，位于负责人的 QA 环境；本卡的仓库内证据是自己复现的 Java 回归与日志，不引用未入库的抓包当作已核对证据。

## 根因（已在 `a409140` 逐处核对）

1. `services/agent-runtime/src/main/java/com/workpal/runtime/RuntimeEngine.java:556-585` 构建 `HarnessAgent` 时只调用了 `.workspace(会话目录)`，没有设置 project 或 filesystem。
2. agentscope-harness 2.0.3 在 project 未设置时默认使用 `System.getProperty("user.dir")`。
3. `WorkspaceContextMiddleware.readAgentsMd` 调用 `WorkspaceManager.readWithOverride(ctx, "AGENTS.md")`，走 overlay 文件系统：会话工作区里没有这个文件时，回退到 project 目录去读。
4. `pnpm dev:app` 和 `pnpm dev:agentscope` 都在仓库根启动 Java，所以 `user.dir` 就是仓库根。

仓库内复现证据（不依赖抓包）：新建的隔离测试在**未修改的 main** 上就是红的，断言失败消息里直接印出发给模型的原文——

```
<loaded_context>
  <agents_context>
  # AGENTS.md

  PERSONA_LEAK_CANARY_7f3a

  - 先检查问题有没有错误前提、逻辑跳跃和信息缺失。
  </agents_context>
  <domain_knowledge_context></domain_knowledge_context>
</loaded_context>
```

## 复现步骤

1. 在仓库根执行 `pnpm dev:app`，或者直接 `java -jar services/agent-runtime/target/agent-runtime-0.1.0.jar`。
2. 把模型的 baseUrl 指向一个抓包代理。
3. 发一条消息「你是谁？你的工作原则是什么？」。
4. 在抓到的请求里 `grep 错误前提`，能搜到就说明复现成功。

仓库内的等价复现（无需真模型、无需代理）：

```bash
export JAVA_HOME=<jdk21>
mvn -B -f services/agent-runtime/pom.xml test -Dtest=RuntimeProjectIsolationTest
```

## 影响

本地开发和 QA 环境里，每个 bot 都带着开发者规则当人设，回答风格和内容都会跑偏。昨天 QA 里看到的「先检查错误前提」就是这么来的。

生产环境（Docker 的 `WORKDIR /app`）目前多半没有 AGENTS.md，人设一般不会泄露。但模型仍然会被告知 `/app` 是「用户的源码树」。以后镜像里只要放进 AGENTS.md、`knowledge/` 或 MEMORY.md，就会被直接注入。这同时是信息泄露和 prompt 注入的入口。

## 修复边界

- 在 RuntimeEngine 里显式处理 project/filesystem，不再依赖 `user.dir`。具体 API 以 harness 2.0.3 的实际签名为准（已用 `javap` 查过 builder）。
- 如果 2.0.3 没有公开 API 能关掉回退，就在 WorkPal 这一层兜住；不要 fork harness。
- 不得用这些办法绕过：改启动目录、删掉仓库的 AGENTS.md、在启动脚本里 `cd`。这些只能把症状藏起来。
- 可选：去掉或改写 harness 注入的「user's source tree」那段说法，只有不需要动 harness 时才做。
- 不改 PromptComposer 的现有段落，不改 bot 人设的来源。

## 已实施修复

`javap` 核对 `io.agentscope.harness.agent.HarnessAgent$Builder`（harness 2.0.3）后确认：builder **没有** `project(Path)` 方法，但有公开的 `disableWorkspaceContext()`，以及 `filesystem(LocalFilesystemSpec|SandboxFilesystemSpec|RemoteFilesystemSpec)`、`abstractFilesystem(...)`、`additionalContextFile(String)`。

选择 `.disableWorkspaceContext()`，理由是可核对的事实而不是偏好：

1. 它从源头去掉整个 `<loaded_context>` 块，因此不管启动目录里放的是 AGENTS.md、`knowledge/` 还是 MEMORY.md 都不会被注入；把 project 指到一个空目录只能挡住当前这一个文件名。
2. 它同时去掉了「user's source tree」那段说法（本卡的可选项目标），且完全不需要动 harness。
3. WorkPal 侧没有任何消费者：`grep -rn 'agents_context|loaded_context|domain_knowledge_context|additionalContextFile|WorkspaceContext' services/agent-runtime/src/` 除新测试外零命中，`src/test/resources` 的 golden 基线也零命中；而 builder 上本来就已经调用 `disableFilesystemTools()`、`disableMemoryTools()`、`disableMemoryHooks()`、`disableDefaultWorkspaceSkills()`，bot 人设完全来自 `PromptComposer.compose(request)`。
4. 不改 PromptComposer，不改人设来源，不改启动目录，不删仓库 AGENTS.md，不 fork harness。

新测试同时断言"人设没被一起删掉"（发给模型的请求里仍必须含 backend 传入的 `Reply concisely.`），所以把 system prompt 整体清空的"假修复"过不了这条。

## 完成标准

证据放在 `docs/evidence/FIX-PERSONA-01/`：

- `red.log` 和 `green.log`：同一个测试、同一条命令，修复前红、修复后绿，两份都带运行命令与 baseline/fix SHA。
- `chain.log`：`pnpm test:worker-chain` 通过，`pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` 也通过。
- 真模型复测：在仓库根执行 `pnpm dev:app`，问「你是谁」，回答里不再出现 AGENTS.md 的内容。附截图，再附抓包里 `<agents_context>` 为空的片段。
- 仓库的 AGENTS.md 保持原样，不需要为这个问题修改它。
