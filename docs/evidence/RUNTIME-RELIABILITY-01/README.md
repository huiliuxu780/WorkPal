# RUNTIME-RELIABILITY-01 — 本地验证证据

基线：`a29c711`（`origin/main`，含 FIX-STOP-01 的 #149 与第一批收尾 #153）。
分支：`codex/runtime-reliability`。
任务书：`docs/tasks/second-batch-20261028/RUNTIME-RELIABILITY-01.md`，已随本交付单元提交。
同批的 `CARD-01E.md` 与批次说明由 CARD-01E 分支整合，避免两个并行分支新增同一文件。
最终状态：`done`。PR #155 已以 `1eac68196e839ad988d4f21a41c1234c50f7862a` 合入 `main`；
随后 CARD-01E 合并该修复并在最终 head 完成完整 CI。

本机前提：Maven 默认走 Homebrew openjdk **27**，所有 `mvn` 命令前都设了
`JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`（`pom.xml` 要求 release 21，CI 用 temurin 21）。
用 27 编译或跑出来的结果不算数。

证据文件：

| 文件 | 内容 |
| --- | --- |
| `java-flake-red.txt` | 回退 main 源码、保留回归测试后的**红** |
| `java-flake-green.txt` | 修复后的**绿** + 连续多次全量套件 |
| `java-correlation-events.txt` | Java 侧结构化事件样本与事件统计 |
| `image-build-and-containers.txt` | 两个最终镜像的构建、内容审计、四容器启动与互通 |
| `correlation-journeys.txt` | 同一次 Run 的四层 trace（成功 + 模型失败）与脱敏证明 |
| `integration-baseline-comparison.txt` | 那条红的 integration 旅程的基线对照 |

## 1. Java 生命周期不稳定

**根因（已证实，非推测）**：同一条 WorkPal 任务记录被写到**两个物理文件**。
委派仓库用 `new WorkspaceManager(workspace)` 构造，临时投递仓库用 `agent.getWorkspaceManager()`；
后者的 AgentScope 默认 USER 隔离命名空间**只作用于写**，读回退到未命名空间路径。
于是 `markDelivered` 在带命名空间的副本上打标，spawn 侧文件仍是未投递。
`taskRecords()` 遍历工作区建 map 时谁覆盖谁取决于 `Files.walk` 的目录遍历顺序 —— 这就是
`registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession:253` 的非确定性来源，
也解释了为什么纯文档 head 同样会中。

**先红后绿**：见 `java-flake-red.txt` / `java-flake-green.txt`。
新增回归测试 `deliveryMarkLandsInTheOwningSessionsSingleNativeTaskRecord` 断言"同一 owning session
的原生任务记录只存在一份"。把 main 源文件回退到 `a29c711`、只保留该测试时**稳定失败**：

```
expected: <1> but was: <2>
  .../<session>/agents/<agent>/tasks/<task>.json
  .../<session>/<namespace>/agents/<agent>/tasks/<task>.json   ← 多出一层命名空间
```

修复后同一断言通过。**没有**用重跑、加 timeout、串行化整个套件、放宽断言或标记 flaky 取得绿灯。

**稳定性**：修复前 38 次复现尝试（单方法 20、整类 8、全量 10）**一次都没失败**，
所以本任务走任务书允许的第二条路：证明竞态，并用一个确定性回归测试固定它。
修复后完整 Java 套件连续 5 次全绿（128 tests / 0 failures），
加入关联日志后再 2 次全绿，撤回下述 lifecycle 改动后再 2 次全绿，最终门禁再 1 次。

**顺带修掉的同模块缺陷**：`PlanBridgeTool` 每次 plan 工具调用都用单参 `WorkspaceManager` 构造，
开一个从不关闭的 SQLite `WorkspaceIndex` 连接；改为与任务记录一致的 plain manager，物理路径不变。

**撤回的两处改动（重要，均为主动撤回而非漏做）**：

1. `RuntimeServer` 把进程内准入槽释放提前到响应体结束之前（修 `409 Session already has an active run`）。
   撤回理由：① 配套测试在**未修复代码上同样是绿的**（150 轮 × 2 请求 + 按核数起自旋线程抢占），
   证明不了缺陷；② 任务书点名的 flake 测试全程直接调 `engine.execute()`，**不经过 HTTP**，
   `activeSessions` 根本不参与；③ 该 409 确有其事，但记录在 `docs/ag07-message-provenance.md:58`，
   发生在 TS 侧 consumer concurrency 集成测试的并行运行中、从未复现 —— 任务书把两个症状混在了一起；
   ④ 提前释放会让同 session 的下一个 Run 在上一个响应仍 flush 时开始写同一工作区，有引入新竞态的风险。
2. `TaskRepositoryLifecycle`（给委派仓库加"Run 结束且所有后台子任务终态后才 shutdown"的有界生命周期）。
   泄漏本身是真的 —— `javap` 确认 `WorkspaceTaskRepository` 持有
   `ExecutorService executor` 与 `ScheduledExecutorService maintenanceScheduler`，
   并有 `SWEEP_INTERVAL_MINUTES` / `ORPHAN_TIMEOUT_MINUTES` / `HEARTBEAT_INTERVAL_SECONDS`。
   但撤回，因为：① 没有独立的先红后绿证据；② **生产根本走不到这条路径** ——
   `RuntimeServer` 用 3 参构造器 → `this(..., null, true)` → `delegationSuspended=true` →
   `allowSubagents = !delegationSuspended && ...` 恒为 false → `InterruptibleTaskRepository`
   在生产中永不构造，所以它不可能改善生产可靠性，只影响测试；
   ③ 它改变了后台 helper 合法存活期内的仓库关闭时序，是有行为风险而无证据的改动。
   建议单独立卡（测试卫生 / 资源泄漏），不要夹带在本单元。

## 2. 生产镜像内容隔离

`infra/compose/Dockerfile` 原来是单阶段 `COPY --chmod=755 . .`，整个仓库进 `/app`。
改为两阶段：build 阶段照旧持有整个仓库（install / prisma generate / web build 都需要），
最终阶段只接收 `infra/compose/collect-runtime-tree.mjs` 用**显式白名单**装配的树。
默认拒绝：新增的顶层路径不加入白名单就不会进生产镜像。没有用镜像末尾一长串 `rm`。

白名单依据（都经过核实）：

- 生产命令是 `tsx src/index.ts`，**直接跑 TS 源码**，所以 apps/packages 源码必须保留。
- 一个镜像服务 api / worker / web / supervisor 四个进程，`pnpm --filter` 需要
  `package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`。
- `pnpm-lock.yaml` 的 importers 是权威清单（17 项，含根）。`infra/updater` 被 workspace glob
  声明但**目录不存在也没有 importer**，所以不收集。
- `packages/testkit` 没有任何 package.json 依赖它，只通过根测试脚本以 CLI 调用；
  只保留 manifest，让工作区图继续匹配 lockfile importers，harness 源码不进镜像。
- 测试源码按 `*.test.ts` / `*.spec.ts` / `__fixtures__` / `__tests__` / `e2e` 排除（638 个文件）。
- `prompts/` **运行时不从磁盘读**（提示词内联在 TS 里，`.md` 只是 testkit 基线测试的对照源；
  Java 镜像另行把 `prompts/` 打包成 jar classpath 资源）。保留它是因为任务书点名"必要 prompts 可用"，
  且它只有 312K、不属于控制文档。
- `services/`（Java，独立镜像）、`docs/`、`scripts/`、`biome.json`、`turbo.json`、
  `vitest*.config.ts` 都不在白名单内。compose 里没有任何服务命令引用 `scripts/` 或 turbo。

**多阶段拆分暴露出两个真实缺陷，都已修**（详见 `image-build-and-containers.txt`）：

1. `corepack enable` 只装 shim，不加 prepare 的话第一次 `pnpm` 调用会在**运行时**下载包管理器
   （`! Corepack is about to download .../pnpm-9.15.0.tgz`），API 因此起不来。
   原单阶段镜像因为装和跑在同一层而掩盖了这点。
2. 加了 `corepack prepare` 之后**仍然无效**：prepare 把缓存放在调用者的 home 下，
   build 阶段是 root，`/root` 是 `0700`，`USER node`（uid 1000）连遍历都不行。
   这一层是靠"构建最终镜像并直接启动"才发现的 —— 用等价命令在同一个容器里先 prepare 再用，
   会当场下载从而**假装通过**，我第一版验证就踩了这个坑。
   修法：`ENV COREPACK_HOME=/opt/corepack` + prepare + `chmod -R a+rX`，版本从
   `package.json` 的 `packageManager` 派生，不会与 lockfile 漂移。
   证明方式（最终镜像、无网络、无 prepare 步骤）：
   `docker run --rm --network=none --entrypoint pnpm workpal-rr01:app3 --version` → `9.15.0`。

**最终镜像构建**：两个都成功。
`docker build -f infra/compose/Dockerfile .` → exit 0（11:45:28–11:53:24，3.53GB）；
`docker build -f services/agent-runtime/Dockerfile .` → exit 0（11:38:15–11:48:44，594MB）。
Java 镜像的 Dockerfile **未修改**（本来就是多阶段、最终层只 `COPY` 一个 jar），
其 `/app` 下**只有 1 个文件** `runtime.jar`（61,150,262 字节），无 AGENTS.md / docs / src / prompts / pom.xml。

**app 镜像内容审计（在最终镜像上，不是中间产物）**：`/app` 顶层只剩
`apps infra node_modules package.json packages pnpm-lock.yaml pnpm-workspace.yaml prompts tsconfig.base.json`；
`AGENTS.md`、`CLAUDE.md`、`README.md`、`CONTRIBUTING.md`、`SECURITY.md`、`SETUP_PROMPT.md`、
`VISION.md`、`CHANGELOG.md`、`docs/`、`services/`、`scripts/`、`biome.json`、`turbo.json`、
`vitest*.config.ts`、`.qoder`、`.env`、`.github`、`.git` **全部不在**；
深层扫描 `*.test.ts` / `*.spec.ts` 命中 **0**，`e2e` / `__fixtures__` / `__tests__` 目录 **0**；
`packages/db/prisma/{schema.prisma,migrations}`、`apps/web/dist`、`prompts/`、
`node_modules/.pnpm`、`infra/sandboxes/supervisor/package.json` 都在。

**真容器启动（四个容器，全部由这两个最终镜像启动，没有任何 corepack 前缀）**：

| 容器 | 生产命令 | 结果 |
| --- | --- | --- |
| api | `prisma migrate deploy && pnpm --filter @rakazo/api start` | `running`，`/health` → `200 {"ok":true}`，8 个 node/tsx 进程，131 个迁移已应用 |
| worker | `pnpm --filter @rakazo/worker start` | `running`，持续输出 `rakazo-worker` 结构化 `job.completed`（带 trace.id / job.id / run.id） |
| web | `pnpm --filter @rakazo/web preview --host 0.0.0.0 --port 5173` | `running`，`GET /` → 200 |
| agentscope | `java -jar /app/runtime.jar`（网络别名 `agentscope`） | `running`，compose 健康检查命令 rc=0 |

**两个最终镜像互通**：`api → http://agentscope:8090/health` → `200 {"ok":true,"service":"workpal-agent-runtime","version":"0.1.0","agentscope":"2.0.3"}`；
`worker → 同一地址` → 200。

启动过程中被应用**自己的生产 guard** 拒了三次，每次都恰好证明裁剪树是完整的：
`packages/core/src/secrets-guard.ts` 要 `BETTER_AUTH_SECRET`/`ENCRYPTION_KEY`、要
`SCREEN_PROXY_SECRET` 是独立凭据，`apps/api/src/env.ts` 要 `AGENTSCOPE_URL` 必须是 loopback
或私有 Compose 服务名。三次都是我给的 env 不合规，**不是镜像内容缺陷**；
能执行到这些校验本身就说明 core 与 api 的源码、依赖解析和 Prisma 产物都在。
（Web 也走同一个 guard：`vite.config.ts:338` 的 `rakazo-novnc-proxy` 插件在
`configurePreviewServer` 里调 `screenProxySecret()`。）

## 3. 跨进程 Run 关联与安全错误

复用 `packages/logging`，**没有**新增第二套 logger 或第二套 trace id。

**关联字段契约**（全部是系统里已经存在的标识，没有为日志虚构任何 step）：
`trace.id`、`span.id`、`parent.span.id`、`request.id`、`run.id`、`attempt.id`、
`session.key`、`thread.id`、`bot.id`。`stepId` **不记录** —— 系统没有稳定的 step identity。

**各层职责**（每层只记自己的状态变化，不四层重复同一异常文本）：

- API：已有的 `establishRequestCorrelation` + hono 中间件（`http.request.completed`）。
- Job 入队 / Worker claim：已有的 `wrapJobPayload` / `runCorrelatedJob`（`job.completed`）。
  **未**给 `PAYLOAD_IDS` 加 `attemptId` —— `runContinueJob(runId)` 的 payload 只有 runId，
  attempt 是 Worker claim 之后才产生的，加了就是用不上的投机映射。
- executor → adapter：在 `deps.runtime.run(...)` 这道接缝上 `enrichLogContext` 绑定
  `run.id` / `attempt.id` / `session.key`；下游都在同一 async context 里，一处绑定覆盖整个 attempt。
- adapter → Java：`/v1/runs` POST、取消用的 DELETE、`/v1/sessions/inspect-and-detach` 都带上
  `outgoingCorrelationHeaders()`。**这是原来缺的那一跳** —— 之前 TS→Java 完全不带关联头，
  `agentscope-runtime.ts` 连 `@rakazo/logging` 都没导入。
  adapter 自己记两个事件：`agentscope.run.requested`（发给 runtime 之前）与
  `agentscope.run.failed`（收到 runtime 的失败类别时）。前者补的是一个真实缺口：
  Worker 派发了但 runtime 从未接受时，两侧原本都不会有记录。
- Java Runtime：见第 4 节。

**四层证据（`correlation-journeys.txt`，来自一次真实的 `pnpm test:worker-chain`，6 passed / 3.9m）**：
两条旅程都取自**同一次 Run**，同一个 `trace.id` 贯穿四层。

| 旅程 | trace.id | api | worker | adapter | java | Java 事件序列 |
| --- | --- | --- | --- | --- | --- | --- |
| 模型失败 | `e600a479e096378d30c45d2b0d7da5f1` | 1 | 4 | 2 | 4 | `run.accepted → stream.started → stream.failed → run.failed` |
| 成功 | `33f1c3eb48c2da2e096c286103bc30f5` | 1 | 4 | 1 | 3 | `run.accepted → stream.started → run.completed` |

Java 行还带 `parent.span.id` 指回 TS 侧的 span，说明是真正的父子 span 链接，
而不是把同一个 trace id 复制过去。

**模型失败旅程是怎么造出来的**：新增 worker-chain 场景
`a provider failure is recorded without its own text and the Run is stopped, not left running`，
用仓库既有的 `startModelEmulator` 失败回复（`{ type: "error", status: 500, message }`）
经真实 AgentScope HTTP/SSE 传输打进去。Java 侧记录到的类型是
`io.agentscope.extensions.model.openai.exception.OpenAIException`（以及 SDK reactor 包装的
`RetryExhaustedException`）—— 是真实的 provider 层异常，不是模拟结果。

该场景**只验证一次真实 provider 失败**：轮询到该 thread 上出现任一持久化错误即成立，
不断言 Attempt 数量、不断言由哪条恢复路径落库、不调用 `assertComplete`
（那会把重试预算写成契约）。断言完成后走产品自己的路径
`rpc(page, "threads/stop", { botId })` 显式停止，轮询到该 thread 的所有 Run 都进入终态，
再等 10 秒确认**模型 fixture 没有再被调用**，`finally` 里再兜一次 stop。
所以测试既不把下面第 5 条那个重驱动缺陷固化成契约，也不留后台 Run。

**安全错误类别**（`FailureCategory`，每个类别都对应真实存在的 throwable 类型或抛出点）：
`cancelled`（`InterruptedException` / 线程被中断）、`session_conflict`
（`SessionCheckpointStore.Conflict`）、`tool_bridge`（栈帧源自 `ToolBridgeClient`）、
`resume_limit`（与 `RuntimeEngine.RESUME_LIMIT_EXCEEDED` 共享常量，不靠字面量匹配）、
`request_rejected`、`internal`。

**故意没有 `model_failure` 类别**：模型调用在 AgentScope SDK 内部，Java 侧无法可靠判别，
编一个探测不到的类别就是假信号。模型失败改由 `runtime.stream.failed` + `error.type` 定位
（`agent.streamEvents(...)` 的 `streamError` 就是本进程的模型调用边界）——
上面的模型失败旅程正是靠 `error.type` 的 `OpenAIException` 定位到模型层的。

用户可见错误继续脱敏：`safeError()` 仍返回固定文案，类别只进日志和 wire 事件的 `category` 字段；
adapter 收到后记 `agentscope.run.failed`，**不改重试语义**（类别只作归因，不是新控制信号）。

**日志内容纪律**：只记标识符和固定 token。异常只记类名，不记 message
（provider/connector 的 message 可能带凭据 URL）；工具只记调用数量，不记参数；
不记提示词、用户正文、模型原始响应。

**脱敏**：`redactSensitiveText` 原来覆盖 email / Bearer / 密钥赋值 / JSON 密钥字段 / 裸密钥，
但任务书禁止的 **DSN、私有 URL、本机路径**三类没覆盖。已补：DSN（带凭据的 authority）、
私有 URL（loopback / RFC1918 / link-local / `.local`/`.internal`/`.lan`）、
本机路径（`/Users/`、`/home/`、`/var/folders/`、`C:\Users\`）。保留 scheme 和 path，
让失败仍可归因到具体集成和端点。容器内路径 `/app` 不算本机身份，不动。
测试用**合成**敏感值证明规则，没有把真实凭据写进测试。

**端到端脱敏证明**：模型 fixture 的 500 响应体里故意放了合成凭据
`ZZSYNTHETICPROVIDERSECRETZZ` 和合成主机 `zzsynthetic-provider-host.invalid`
（故意不写成脱敏器会自动改写的形状，这样"查不到"才是强证据）。
一次完整 worker-chain 运行后，跨 harness 输出与全部 worker 日志检索：
凭据 **0 次**、主机 **0 次**。测试同时断言它们不出现在持久化的 `run.error` 和任何 `attempt.error` 里。

## 4. 清除 Java 的原始输出通道

改前 Java 侧**完全没有日志设施**，只有 5 处 `System.err.println`，其中两处直接拼异常对象
（`"Plan projection failed ...: " + error`，`error.toString()` 含 message，可能带工作区路径或私有 URL），
`RuntimeServer` 还会打印异常类名加 4 行堆栈。

现在 `RuntimeLog` 是**唯一**输出通道：NDJSON，信封与字段名和 `@rakazo/logging` 一致
（`timestamp` / `level` / `message` / `service.name`），`service.name=rakazo-agent-runtime`
（TS 侧是 `rakazo-api` / `rakazo-worker`），info 走 stdout、warn/error 走 stderr，与 TS console sink 一致。
trace 从 `traceparent` 头解析；没有可用 traceparent 时本地生成，保证不会产出不归属的运行。

事件：`runtime.run.accepted` / `runtime.run.rejected`（带 `reject.reason`：
`missing_session_admission`、`bot_state_purged`、`run_already_active`、`session_already_active`、
`invalid_argument`、`unparseable_request`）/ `runtime.stream.started` / `runtime.stream.failed` /
`runtime.tools.resumed` / `runtime.run.paused` / `runtime.run.cancelled` / `runtime.run.completed` /
`runtime.run.failed` / `runtime.tool_bridge.rejected` / `runtime.plan.projection_failed` /
`runtime.background.terminal_delivery_failed` / `agentscope.signal`。

原来 5 处 `System.err.println` 全部替换，**没有一处保留原始异常文本**：
`PlanBridgeTool` 两处（只记 `projection.site` + 异常类名）、`ToolBridgeClient`（只记 HTTP 状态码）、
`RuntimeEngine` 后台终态投递（只记 `task.id` + 类名，且三次有界重试只在最后一次记一行）、
`WorkPalMemorySignalHook`（原本已是元数据 only，改成结构化后额外获得 run/attempt/session 关联）。

PR #155 复审补齐后台 watcher 的线程边界：`RuntimeLog` 使用普通 `ThreadLocal`，虚拟线程不会继承
HTTP handler 上的 trace。`registerBackground` 现在在启动 watcher 前捕获关联绑定，并在虚拟线程的
完整生命周期内安装、最终恢复；因此后台工具桥拒绝和终态投递重试耗尽仍携带原始 `trace.id`、
`parent.span.id` 与 `request.id`。`RuntimeLogTest` 用真实虚拟线程固定这一约束。

验证：完整 Java 套件跑完后检索输出，匹配旧格式
（`agentscope.signal `、`Plan projection`、`PLAN.md projection`、`Tool bridge returned`、
`Background task event`、`Agent runtime failure`、`  at `）的行数为 **0**；
worker-chain 全量日志里同样为 **0**。

## 本地命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm db:generate` | 通过（Prisma Client 7.10.0）。**必须跑**：不跑则 `@rakazo/adapters check` 会因 `@rakazo/db` 缺 `MemoryFact` 导出而失败，那是环境未就绪不是代码缺陷 |
| `pnpm lint` | 通过（exit 0）。改动文件的 4 个 warning 在基线 `a29c711` 上逐条相同，属既有问题，未顺手修 |
| `pnpm check` | 通过（exit 0）：18/18 tasks successful |
| `pnpm test:unit` | 通过（exit 0）：459 文件 / 5549 passed / 2 skipped |
| `pnpm test:ci-select` / `test:docs` / `test:inventory` | 三项均通过（exit 0） |
| `pnpm test:postgres` | 通过（exit 0）：**52 文件 / 470 tests 全绿**，跑在一次性 PG16（宿主端口 5499）上，`prisma migrate deploy` exit 0。并见下面"假绿陷阱" |
| `pnpm test:agentscope`（= `mvn test`） | 原最终门禁 128 tests / 0 failures；PR #155 后台 trace 修复后 129 tests / 0 failures |
| `pnpm test:integration` | **1 failed / 40 passed（41）**，`journeys.test.ts:2063` journey 54。已证明是**既有基线红**，见 `integration-baseline-comparison.txt` |
| `pnpm test:worker-chain` | **6 passed（3.9m）**，exit 0，含本任务新增的模型失败场景 |
| `docker build -f infra/compose/Dockerfile .` | 通过（exit 0），内容审计与容器启动见第 2 节 |
| `docker build -f services/agent-runtime/Dockerfile .` | 通过（exit 0），`/app` 只有 `runtime.jar` |
| 真容器启动 api / worker / web / agentscope | 四个全部 `running`，健康检查全通过，两镜像互通 |

**两个假绿陷阱（重要，复审时别踩）**：

1. `pnpm test:postgres` 的测试门卫是 `process.env.VERIFY_DATABASE && process.env.DATABASE_URL`，
   而 `test:postgres` 这个 group runner 两个都不设 —— 直接跑会得到 `2 passed / 463 skipped`
   且 **exit 0**。必须自己起一次性 PG16（宿主端口 5499；**5433 已被本机占用**）、
   `prisma migrate deploy`、再带 `VERIFY_DATABASE=1` 跑，才是真跑。
2. `pnpm exec vitest run packages/testkit/src/journeys.test.ts` 单独跑会报 `41 skipped` 且 exit 0
   （harness 才会设测试所依赖的 env）。只能用 `pnpm test:integration`。

**journey 54 的基线对照**：把本 diff 中唯一可能影响该 TS 旅程的四个文件
（`agentscope-runtime.ts`、`executor.ts`、`redaction.ts`、`redaction.test.ts`）
`git checkout a29c711 --` 回退后重跑 `pnpm test:integration`，结果**逐字相同**：
同一条 journey 54、同一断言行、`1 failed | 40 passed (41)`；之后 `git checkout HEAD --` 还原，
工作树干净。根因是过期预期：断言期待双 mention 后两个 Bot 都产生 Run，而
`packages/core/src/product-harness/response-owner.ts` 的 `resolveExplicitTurnOwner` 规定
多个显式 mention 且无 separate-answers 标记时**只由第一个 mention 作为唯一 owner**。
此规则自 RT-22（#111）起即如此。**本任务未修它** —— 属群聊产品语义，不在本交付单元范围。

## 门禁汇总（最终 diff，一次性跑完）

```
pnpm lint            exit 0
pnpm check           exit 0   18/18 tasks successful
pnpm test:unit       exit 0   459 files / 5549 passed / 2 skipped
pnpm test:ci-select  exit 0
pnpm test:docs       exit 0
pnpm test:inventory  exit 0
pnpm test:postgres   exit 0   52 files / 470 passed   (real PG16, migrate deploy exit 0)
pnpm test:integration exit 1  1 failed / 40 passed (41)  <- journey 54, proven baseline red
pnpm test:worker-chain exit 0  6 passed (3.9m)   <- incl. the provider-failure scenario
mvn test             exit 0   Tests run: 129, Failures: 0, Errors: 0, Skipped: 0  BUILD SUCCESS
docker build (compose)  exit 0   workpal-rr01:app3
docker build (java)     exit 0   workpal-rr01:java
containers             api / worker / web / agentscope all running, all health checks pass
```

唯一的红是 `pnpm test:integration` 的 journey 54，已用基线对照证明与本 diff 无关（见下）。

## 已知限制与新发现

1. **Java 基础镜像来自第三方镜像源（供应链披露）**。整个会话期间 Docker Hub 不可达
   （`registry-1.docker.io` 三次超时，DNS 被解析到 `162.125.80.3`、`116.89.243.8`、
   `69.63.184.142` 等非 Docker 地址，是本机 fake-IP 代理 DNS 故障）。
   `node:22-bookworm` 由 BuildKit 本地内容存储按 digest 离线解析，未走网络；
   但 `maven:3.9.11-eclipse-temurin-21` 与 `eclipse-temurin:21-jre` 无缓存，
   改从 `docker.m.daocloud.io` 拉取后 retag 成 Dockerfile 使用的名字。
   摘要：maven `sha256:6fdc855a6ed81d288ca7ca37ac6ff5e9308b612485c0801d70b25a858c83d237`、
   temurin `sha256:f37956012e0cb88400e5b3689aeae2d2d735364c1922ae2225536163b5a99f56`。
   **这只用于本地验证**：镜像未推送、未部署，CI 的生产构建仍从 Docker Hub 拉取。
   复审若要求官方来源，需在 Hub 可达的环境重建 Java 镜像。
2. **`runtime.tools.resumed` 未被任何本地入口触发**。129 个 Java 测试与 worker-chain 都没有
   驱动外部工具 resume（`RequireExternalExecutionEvent`），所以工具桥的**成功**路径只有代码审查依据
   （失败路径有：`runtime.tool_bridge.rejected`）。已确认它不引入新失败模式：
   紧随其后的 `resumeTools` 本来就 for-each 遍历同一个 list，`getToolCalls()` 若为 null 原代码同样 NPE。
3. **`409 Session already has an active run` 未修**，理由见第 1 节撤回说明。建议单独立卡。
4. **`TaskRepositoryLifecycle` 已撤回**，泄漏本身真实存在（javap 证据见第 1 节），
   但生产走不到该路径且无独立红绿证据。建议单独立卡。
5. **新发现（建议立卡）：模型持续失败时，同一个 Run 被驱动的次数远超自动重试预算。**
   `RUN_RETRY_DELAYS_MS = [5_000, 30_000]`，即自动重试预算只有 2 次；
   但在一次观测中，一个模型持续返回 500 的 Run 在约 3 分钟内产生了 **7 次模型调用**
   （7 个 `runtime.stream.failed`，同一个 `run.id`，attempt.id 各不相同），
   且 180 秒内始终停在 `queued` 而非进入终态。
   说明除 `scheduleAutomaticRunRetry` 外还有别的路径（最可能是租约过期后 reconciler 重新入队）
   在反复驱动同一个 Run。这属于 Run/Attempt 业务语义，**任务书明确禁止本单元修改**，
   因此未动。新增的 worker-chain 场景刻意**不依赖**这个行为：它只要求出现一次持久化的
   provider 失败，然后走产品 Stop 路径把 Run 收干净（见第 3 节），
   所以将来修好重驱动不会打破这个测试，测试也不会在 Run 仍活跃时结束。
6. **`pnpm test:integration` 有一条既有基线红**（journey 54），已用基线对照证明与本 diff 无关。
   建议单独立卡，否则每个后续 PR 的 integration 门禁都会带着它。
7. 未部署，未推远程，未提 PR，未合并。未改 GitHub 设置。

## 边界确认

- 未修改：卡片产品协议、卡片 API、Web 页面、AgentScope 生产执行器地位、RT-15 gate 与 SDK 版本、
  Run/Attempt/ExternalEffect/session admission 的业务状态语义、GitHub branch protection、用户可见文案。
- 未修改共享冲突文件：`apps/api/src/router.ts`、`packages/contracts/src/rpc.ts`、`package.json`、
  `pnpm-lock.yaml`、`.github/workflows/ci.yml`、`scripts/ci/`、`AGENTS.md`。
  `@rakazo/logging` 已是 `packages/adapters` 的既有 workspace 依赖，所以关联改动不需要动 manifest。
- 关联字段全部走已存在的 `AgentRunRequest.sessionAdmission`（`attemptId` / `sessionKey` 本来就在里面）
  和 HTTP 头，**没有经过共享 API 契约**。
- 本单元新增/修改的文件：`packages/logging`（脱敏 + 测试）、`packages/adapters`
  （`agentscope-runtime.ts`、`executor.ts`）、`services/agent-runtime`（Java 主源与测试）、
  `infra/compose`（Dockerfile + 收集脚本）、`apps/web/e2e/worker-chain.spec.ts`（新增场景）、
  `docs/evidence/RUNTIME-RELIABILITY-01/`。
- 最终 diff 中无密钥、无真实用户数据、无私有 URL、无本机路径；证据文件经过同样的泄漏扫描
  （唯一命中的是脱敏测试里的**合成**输入，以及镜像 sha256 摘要）。
