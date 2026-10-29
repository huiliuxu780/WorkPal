# RUNTIME-RELIABILITY-01：Runtime 生产可靠性

状态：`done`（PR #155 已合入 `main`）

建议分支：`codex/runtime-reliability`

交付方式：一个 Coding Agent、一个分支、一个 PR。本文可以直接作为 Coding Agent 的任务提示词。

## 开始条件

从 FIX-STOP-01 和 FIX-PERSONA-01 合入后的最新 `origin/main` 开始。不要从 #149 或 #150 的 PR 分支继续开发。

开始前记录基线 SHA，并确认工作树干净。阅读以下输入：

- `docs/tasks/HARNESS-01.md` 的 H5
- FIX-STOP-01 与 FIX-PERSONA-01 的任务记录和证据
- `packages/logging/`
- `packages/adapters/src/agentscope-runtime.ts`
- Worker 的 Run 执行入口
- `services/agent-runtime/`
- `infra/compose/Dockerfile`
- `services/agent-runtime/Dockerfile`

RT-15 已经完成。RT-16、RT-17 和 RT-18 继续暂停。本任务不重新验证 AgentScope 后台 helper，也不升级 SDK 来尝试解除暂停。

## 交付结果

交付一个稳定、隔离正确、能定位失败的生产 Runtime。

同一业务 Run 从 API 进入队列、由 Worker 执行、经过 TypeScript AgentScope adapter 到 Java Runtime 时，日志保留同一组安全关联字段。模型失败、工具失败、取消、预算终止和 lease 丢失可以从一次运行中定位。生产镜像不再把仓库控制文档放进应用工作目录。已知 Java background probe 不再随机失败。

这三个问题共享 Runtime 的构建、进程边界和交付链，因此作为一个模块修复。不要拆成 flake PR、镜像 PR和日志 PR。

## 修复 Java 生命周期不稳定

复现并修复 `AgentScopeBackgroundProbeTest.registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession` 的非确定性失败。现有失败表现为 session 已有 active run，但纯文档或无 Java 改动的 head 也可能命中。

找出共享生命周期、清理顺序或测试隔离中的根因。修复必须落在错误产生的位置。不要通过重跑、增加 timeout、串行整个 Java 套件、放宽断言或把测试标成 flaky 来获得绿灯。

保留该测试保护的业务语义：registration、terminal 和 delivery 必须绑定 owning child 与 owning session，不能串到 sibling 或下一次 Run。

## 收紧生产镜像内容

`infra/compose/Dockerfile` 当前使用 `COPY . .`。FIX-PERSONA-01 的镜像检查证明 `/app` 中包含 `AGENTS.md`、`CLAUDE.md` 和仓库文档。Java prompt 修复可以阻止一次已知注入路径，但它不能代替镜像隔离。

改为明确的构建输入和运行时内容。最终生产镜像只保留启动 API、Worker、Web 和必要运行资源所需的文件。构建需要的仓库文件可以存在于 build stage，但不应无条件进入最终 runtime stage。

镜像必须继续满足以下要求：

- API、Worker 和 Web 按现有生产命令启动。
- Prisma client、migrations、Web build 和必要 prompts 可用。
- `/app` 中不存在 `AGENTS.md`、`CLAUDE.md`、开发任务文档、证据目录、测试源码和本机配置。
- 不通过删除真正的运行资源来让目录检查通过。
- Java Runtime 镜像继续只包含 jar 和它需要的资源。

可以使用多阶段构建、明确 COPY 清单、pnpm deploy 或等价的可维护方案。不要只在镜像末尾执行一长串 `rm` 来掩盖过宽的构建输入。

## 打通 Run 级关联和安全错误

复用 `packages/logging`。不要新增第二套 logger 或第二套 trace ID。

定义并传递实际存在的关联字段。至少覆盖 `traceId`、`runId`、`attemptId`、session identity 和当前执行事件。只有系统已经拥有稳定 step identity 时才记录 `stepId`；不要为了日志虚构 step。

关联信息必须跨过以下边界：

- API 创建或继续 Run
- Job 入队和 Worker claim
- executor 与 AgentScope adapter
- Java Runtime 请求、模型调用、工具桥、取消和返回
- Worker 持久化最终状态

每一层记录自己负责的状态变化。不要在四层重复记录同一个异常文本。Java 和 adapter 返回稳定的安全错误类别，用户可见错误继续脱敏。

日志禁止包含 Authorization、模型密钥、完整提示词、用户正文、完整工具参数、模型原始响应、DSN、私有 URL 和本机路径。使用合成敏感值证明脱敏规则，而不是把真实凭据写入测试。

完成一个受控失败旅程。一次运行中的模型失败或工具失败必须能通过关联字段从 API 或 Worker 日志追到 Java 的失败位置，不需要重新跑 E2E 才知道失败在哪一层。

## 修改边界

可以修改以下区域：

- `packages/logging/`
- Worker 的 Job 上下文、executor 和恢复路径
- AgentScope adapter 和 Runtime 请求契约
- `services/agent-runtime/`
- `infra/compose/Dockerfile`、`services/agent-runtime/Dockerfile` 和必要的构建脚本
- Runtime、integration、worker-chain、镜像和日志测试
- H5 与 Runtime 运行文档

不要修改以下区域：

- 卡片产品协议、卡片 API 和 Web 页面
- AgentScope 生产执行器地位
- RT-15 后台 helper gate 和 SDK 版本
- Run、Attempt、ExternalEffect 或 session admission 的业务状态语义
- GitHub branch protection、ruleset 或部署配置
- 用户可见页面和文案

如果关联字段需要经过共享 API 契约，先通知整合者。CARD-01E 拥有同期的卡片 RPC 修改。不要并发重写 `apps/api/src/router.ts` 或 `packages/contracts/src/rpc.ts`。

## 本地完成标准

Coding Agent 必须在本地完成整个模块后再提 PR。

至少完成以下工作：

1. 在修复前稳定复现 Java flake 或证明导致失败的生命周期竞态。用同一业务断言证明修复后重复运行不再失败。
2. 构建生产 Compose 镜像和 Java Runtime 镜像。启动真实容器，检查健康状态、核心进程和最终文件清单。
3. 启动 API、独立 Worker 和 Java Runtime，运行一个成功旅程和一个受控失败旅程。证明关联字段贯穿四层，且日志没有合成敏感内容。
4. 运行最终 diff 对应的所有本地 CI 选择项。完整运行 Java、AgentScope integration 和 worker-chain，不靠同 SHA 重跑取得本地通过。
5. 对本任务修复的缺陷保留同一个回归用例的修复前失败和修复后通过结果。

使用仓库当前 `package.json`、`pom.xml` 和 CI 选择器确定命令。最终至少应覆盖这些仓库入口：

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint
pnpm check
pnpm test:unit
pnpm test:postgres
pnpm test:inventory
pnpm test:ci-select
pnpm test:docs
pnpm test:agentscope
pnpm test:integration
pnpm test:worker-chain
docker build -f services/agent-runtime/Dockerfile .
docker build -f infra/compose/Dockerfile .
```

如果完整 `pnpm test:integration` 需要仓库已定义的分组或环境，使用当前正式入口运行全部被最终 diff 选中的 integration 分组，并在回交中写明命令。环境失败不算模块通过。

## 回交内容

Coding Agent 回交以下内容：

- 分支名和最终 commit
- Java flake 的根因和修复方式
- 生产镜像的构建方式、启动结果和最终文件清单
- 关联字段契约和一条成功、一条失败的跨进程日志
- 脱敏测试结果
- 本地运行命令和结果
- 已知限制
- 最终 diff 中没有密钥、真实用户数据、私有 URL 或本机路径的确认

不要在本地全绿前提 PR。PR 建立后，CI 和 review 发现的问题继续在本分支修复。Reviewer 确认最终 head 后才能建议合并。本任务不授权部署。
