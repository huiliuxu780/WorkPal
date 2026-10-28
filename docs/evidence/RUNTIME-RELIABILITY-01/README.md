# RUNTIME-RELIABILITY-01 — 本地验证证据

基线：`a29c711`（`origin/main`，含 FIX-STOP-01 的 #149 与第一批收尾 #153）。
分支：`codex/runtime-reliability`。任务书：`docs/tasks/second-batch-20261028/RUNTIME-RELIABILITY-01.md`（该目录尚未提交进 git）。

本机前提：Maven 默认走 Homebrew openjdk 27，所有 `mvn` 命令前都设了
`JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`（`pom.xml` 要求 release 21，CI 用 temurin 21）。

## 1. Java 生命周期不稳定

**根因（已证实，非推测）**：同一条 WorkPal 任务记录被写到**两个物理文件**。
委派仓库用 `new WorkspaceManager(workspace)` 构造，而临时投递仓库用
`agent.getWorkspaceManager()`；后者的 AgentScope 默认 USER 隔离命名空间只作用于**写**，
读回退到未命名空间路径。于是 `markDelivered` 在带命名空间的副本上打标，spawn 侧文件仍是未投递。
`taskRecords()` 遍历工作区建 map 时谁覆盖谁取决于 `Files.walk` 的目录遍历顺序 —— 这就是
`registrationTerminalAndDeliveryStayBoundToTheOwningChildAndSession:253` 的非确定性来源，
也解释了为什么纯文档 head 同样会中。

**先红后绿**：见 `java-flake-red.txt` / `java-flake-green.txt`。
新增回归测试 `deliveryMarkLandsInTheOwningSessionsSingleNativeTaskRecord` 断言"同一 owning session
的原生任务记录只存在一份"。把三个 main 源文件回退到 `a29c711`、只保留该测试时**稳定失败**：

```
expected: <1> but was: <2>
  .../<session>/agents/<agent>/tasks/<task>.json
  .../<session>/<namespace>/agents/<agent>/tasks/<task>.json   ← 多出一层命名空间
```

修复后同一断言通过。**没有**用重跑、加 timeout、串行化整个套件、放宽断言或标记 flaky 取得绿灯。

**稳定性**：修复后完整 Java 套件连续 5 次全绿（128 tests / 0 failures，每次 BUILD SUCCESS），
加入关联日志后再跑一次同样全绿。修复前的 38 次复现尝试（单方法 20 次、整类 8 次、全量 10 次）
**一次都没失败** —— 所以本任务走的是任务书允许的第二条路：证明竞态，并用一个确定性回归测试固定它。

**顺带修掉的同模块缺陷**：
- `PlanBridgeTool` 每次 plan 工具调用都用单参 `WorkspaceManager` 构造，开一个从不关闭的 SQLite
  `WorkspaceIndex` 连接；改为与任务记录一致的 plain manager，物理路径不变。
- 委派仓库的维护调度器与工作线程会活过所属 Run。新增 `TaskRepositoryLifecycle`：
  只有"Run 已结束**且**每个已注册的后台子任务都到达终态"才 shutdown。子任务计数在 watcher 启动
  **之前**加，避免出现负余额。

**撤销的一处改动（重要）**：上一轮实现里还有一个 `RuntimeServer` 改动，把进程内准入槽的释放
提前到响应体结束之前，配套测试 `sessionSlotIsReleasedBeforeTheRunResponseCompletes`。
撤销理由：

1. 该测试在**未修复代码上同样是绿的**（150 轮 × 2 请求 + 按 CPU 核数起自旋线程抢占），
   证明不了任何缺陷，不满足"修复前必须因目标缺陷失败"。
2. 任务书点名的 flake 测试全程直接调 `engine.execute()`，**不经过 HTTP**，
   `activeSessions` 根本不参与，所以 409 不可能是它的成因。
3. `409 Session already has an active run` 确有其事，但记录在
   `docs/ag07-message-provenance.md:58`：发生在 TS 侧 consumer concurrency 集成测试的并行运行中，
   从未复现。任务书把两个症状混在了一起。
4. 提前释放槽位会让同 session 的下一个 Run 在上一个响应仍在 flush 时就开始写同一份工作区，
   有引入新竞态的风险。

结论：该 409 是一个真实但**无法复现**的症状，候选根因已定位（槽位释放晚于响应完成），
但没有可证的修复，因此不夹带。建议单独立卡。

## 2. 生产镜像内容隔离

`infra/compose/Dockerfile` 原来是单阶段 `COPY --chmod=755 . .`，整个仓库进 `/app`。
改为两阶段：build 阶段照旧持有整个仓库（install / prisma generate / web build 都需要），
最终阶段只接收 `infra/compose/collect-runtime-tree.mjs` 用**显式白名单**装配出的树。
默认拒绝：新增的顶层路径不加入白名单就不会进生产镜像。没有用镜像末尾一长串 `rm`。

白名单依据（都经过核实，不是猜的）：
- 生产命令是 `tsx src/index.ts`，**直接跑 TS 源码**，所以 apps/packages 源码必须保留。
- 一个镜像服务 api / worker / web / supervisor 四个进程，`pnpm --filter` 需要
  `package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`。
- `pnpm-lock.yaml` 的 importers 是权威清单（17 项，含根）。`infra/updater` 被 workspace glob
  声明但**目录不存在也没有 importer**，所以不收集。
- `packages/testkit` 没有任何 package.json 依赖它，只通过根测试脚本以 CLI 调用；
  只保留 manifest，让工作区图继续匹配 lockfile importers，harness 源码不进镜像。
- 测试源码按 `*.test.ts` / `*.spec.ts` / `__fixtures__` / `__tests__` / `e2e` 排除。
- `prompts/` **运行时不从磁盘读**（提示词内联在 TS 里，`.md` 只是 testkit 基线测试的对照源；
  Java 镜像另行把 `prompts/` 打包成 jar classpath 资源）。保留它是因为任务书点名"必要 prompts 可用"，
  且它只有 312K、不属于控制文档。
- `services/`（Java，独立镜像）、`docs/`、`scripts/`、`biome.json`、`turbo.json`、
  `vitest*.config.ts` 都不在白名单内。compose 里没有任何服务命令引用 `scripts/` 或 turbo。

**构建过程中发现并修掉的一个真实缺陷**：多阶段拆分后 runtime 阶段只跑了 `corepack enable`，
而它只装 shim。真启动容器时 corepack 在**运行时**去下载 pnpm
（`! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.15.0.tgz`），
API 因此根本没起来。原单阶段镜像因为装和跑在同一层而掩盖了这点。生产网络通常没有出站权限，
这是必须修的。修法是在 runtime 阶段 `corepack prepare "$(node -p "...packageManager")" --activate`，
版本从 `package.json` 派生，不会与 lockfile 漂移。

**镜像内容审计**（`image-content.txt`）：`/app` 顶层只剩 9 项运行时条目；
`AGENTS.md`、`CLAUDE.md`、`README.md`、`CONTRIBUTING.md`、`SECURITY.md`、`SETUP_PROMPT.md`、
`VISION.md`、`CHANGELOG.md`、`docs/`、`services/`、`scripts/`、`biome.json`、`turbo.json`、
`vitest*.config.ts`、`.qoder`、`.env` 全部不在；深层扫描 `*.test.ts` / `*.spec.ts` 命中 **0**，
`e2e` / `__fixtures__` 目录 **0**；`packages/db/prisma/{schema.prisma,migrations}`、
`apps/web/dist`、`prompts/`、`node_modules/.pnpm` 都在。镜像 3.46GB（原 3.82GB）。

**真容器启动验证**（`image-content.txt` 末段）：从裁剪后的镜像起真实容器，
`prisma migrate deploy` 找到并应用 131 个迁移（DB 里 `_prisma_migrations` 确认 131 行），
`tsx src/index.ts` 正常启动，容器 `running`、`/health` 返回 `HTTP 200 {"ok":true}`，
7 个 node/tsx 进程在跑，启动日志和一次被服务的请求都是结构化且带
`request.id`/`trace.id`/`span.id` 的。roundtable gates 全为 false，与"gate 默认关闭"一致。
**Worker 和 Web 的生产命令同样验证通过**：`pnpm --filter @rakazo/worker start` 的容器 `running`
并持续完成 job（`job.completed`，`service.name=rakazo-worker`），
`pnpm --filter @rakazo/web preview --host 0.0.0.0 --port 5173` 的容器 `running`
且 `GET /` 返回 200（2578 字节，`apps/web/dist` 52 个文件）。
Web 需要 `SCREEN_PROXY_SECRET`：`vite.config.ts:338` 的 `rakazo-novnc-proxy` 插件在
`configurePreviewServer` 里调 `screenProxySecret()`，跨裁剪树解析到
`packages/core/src/secrets-guard.ts` —— 缺值时是 guard 生效，不是文件缺失。

启动过程中被应用**自己的生产 guard** 连续拒了三次，每次都恰好证明裁剪树是完整的：
`packages/core/src/secrets-guard.ts` 要 `BETTER_AUTH_SECRET`/`ENCRYPTION_KEY`、
要 `SCREEN_PROXY_SECRET` 是独立凭据，`apps/api/src/env.ts` 要 `AGENTSCOPE_URL`
必须是 loopback 或私有 Compose 服务名。三次都是我给的 env 不合规，**不是镜像内容缺陷**；
能执行到这些校验本身就说明 core 和 api 的源码、依赖解析和 Prisma 产物都在。

Java Runtime 镜像的 Dockerfile **未修改**：它本来就是多阶段、最终层只 `COPY` 一个 jar，
`prompts/` 只在 build 阶段作为 jar 资源打包。

## 3. 跨进程 Run 关联与安全错误

复用 `packages/logging`，**没有**新增第二套 logger 或第二套 trace id。

**关联字段契约**（全部是系统里已经存在的标识，没有为日志虚构任何 step）：
`trace.id`、`span.id`、`parent.span.id`、`request.id`、`run.id`、`attempt.id`、
`session.key`、`thread.id`、`bot.id`。`stepId` **不记录** —— 系统没有稳定的 step identity。

**各层职责**（每层只记自己的状态变化，不四层重复同一异常文本）：
- API：已有的 `establishRequestCorrelation` + hono 中间件（`http.request.completed`）。
- Job 入队 / Worker claim：已有的 `wrapJobPayload` / `runCorrelatedJob`（`job.completed`）。
  未给 `PAYLOAD_IDS` 加 `attemptId` —— `runContinueJob(runId)` 的 payload 只有 runId，
  attempt 是 Worker claim 之后才产生的，加了就是用不上的投机映射。
- executor → adapter：在 `deps.runtime.run(...)` 这道接缝上 `enrichLogContext` 绑定
  `run.id` / `attempt.id` / `session.key`，下游（adapter、工具桥回调、终态持久化）都在同一
  async context 里，一处绑定覆盖整个 attempt。
- adapter → Java：`/v1/runs` POST、取消用的 DELETE、`/v1/sessions/inspect-and-detach`
  都带上 `outgoingCorrelationHeaders()`。**这是原来缺的那一跳** —— 之前 TS→Java 完全不带关联头。
- Java Runtime：新增 `RuntimeLog`（NDJSON，信封与字段名和 `@rakazo/logging` 一致，
  `service.name=rakazo-agent-runtime`）。事件：`runtime.run.accepted` / `runtime.run.rejected` /
  `runtime.stream.started` / `runtime.stream.failed` / `runtime.tools.resumed` /
  `runtime.run.paused` / `runtime.run.cancelled` / `runtime.run.completed` / `runtime.run.failed`。
  trace 从 `traceparent` 头解析；没有可用 traceparent 时本地生成，保证不会产出不归属的运行。
  原来 Java 侧**完全没有日志设施**，只有 `System.err.println` 打原始异常文本和堆栈，现已替换。

**安全错误类别**（`FailureCategory`，每个类别都对应真实存在的 throwable 类型或抛出点）：
`cancelled`（`InterruptedException` / 线程被中断）、`session_conflict`
（`SessionCheckpointStore.Conflict`）、`tool_bridge`（栈帧源自 `ToolBridgeClient`）、
`resume_limit`（与 `RuntimeEngine.RESUME_LIMIT_EXCEEDED` 共享常量，不靠字面量匹配）、
`request_rejected`、`internal`。
**故意没有 `model_failure` 类别**：模型调用在 AgentScope SDK 内部，Java 侧无法可靠判别，
编一个探测不到的类别就是假信号。模型失败改由 `runtime.stream.failed` + `error.type` 定位
（`agent.streamEvents(...)` 的 `streamError` 就是本进程的模型调用边界）。
用户可见错误继续脱敏：`safeError()` 仍返回固定文案，类别只进日志和 wire 事件的 `category` 字段；
adapter 收到后记 `agentscope.run.failed`，**不改重试语义**（类别只作归因，不是新控制信号）。

**日志内容纪律**：只记标识符和固定 token。异常只记类名，不记 message（provider/connector 的
message 可能带凭据 URL）；工具只记调用数量，不记参数；不记提示词、用户正文、模型原始响应。

**脱敏**：`redactSensitiveText` 原来覆盖 email / Bearer / 密钥赋值 / JSON 密钥字段 / 裸密钥，
但任务书禁止的 **DSN、私有 URL、本机路径**三类没覆盖。已补：DSN（带凭据的 authority）、
私有 URL（loopback / RFC1918 / link-local / `.local`/`.internal`/`.lan`）、
本机路径（`/Users/`、`/home/`、`/var/folders/`、`C:\Users\`）。保留 scheme 和 path，
让失败仍可归因到具体集成和端点。容器内路径 `/app` 不算本机身份，不动。
测试用**合成**敏感值证明规则，没有把真实凭据写进测试。

**跨进程证据**（`correlation-journeys.txt`，来自一次真实的 `pnpm test:worker-chain`，5 passed / 4.2m）：

- 成功旅程：同一个 `trace.id=277ce8f9…` 同时出现在 `rakazo-api` 的 `http.request.completed`
  和 `rakazo-agent-runtime` 的 `runtime.run.accepted` → `runtime.stream.started` →
  `runtime.run.completed`，Java 侧还带 `parent.span.id` 指回 TS 的 span（不是单纯复制 trace id）。
- 受控失败旅程："Worker killed mid-Run" 场景下的真实 `runtime.run.failed`，
  `trace.id=729b66e8…`，带 `run.id` / `attempt.id` / `session.key` / `request.id` /
  `parent.span.id` 和 `error:{category:"internal",type:"java.lang.IllegalStateException"}`。
- 该次运行的 Java 事件统计：12 accepted、12 stream.started、8 completed、
  **3 cancelled**、**1 failed** —— 取消和失败都能在真实跨进程旅程里定位。

**Worker 层另有直接证据**（不依赖上面的 harness）：从裁剪后的镜像起的真 Worker 容器持续输出
带关联字段的 job 事件，`service.name` 正是 `rakazo-worker`：

```
{"message":"job.completed","service.name":"rakazo-worker","job.id":"9e72a414-…",
 "job.type":"delivery.dispatch","trace.id":"b6b4b4697c4aad938ae784c8671d7222",
 "span.id":"2be321c760e8d7ff","job.duration_ms":3,"job.outcome":…}
```

这说明 Job 入队/claim 这一层的 `trace.id`、`job.id`、`job.type` 都在，
且与 API、Java 用的是同一套字段名和信封。

## 本地命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm db:generate` | 通过（Prisma Client 7.10.0）。**必须跑**：不跑则 `@rakazo/adapters check` 会因 `@rakazo/db` 缺 `MemoryFact` 导出而失败，那是环境未就绪不是代码缺陷 |
| `pnpm lint` | 通过（exit 0，75 warnings）。改动文件的 4 个 warning 在基线 `a29c711` 上逐条相同，属既有问题，未顺手修 |
| `pnpm check` | 通过：18/18 tasks successful |
| `pnpm test:unit` | 通过：459 文件 / 5549 passed / 2 skipped |
| `pnpm test:ci-select` | 通过（exit 0） |
| `pnpm test:docs` | 通过（exit 0） |
| `pnpm test:inventory` | 通过（exit 0） |
| `pnpm test:agentscope`（= `mvn test`） | 通过：128 tests / 0 failures，连续 5 次 + 加日志后 1 次 |
| `pnpm test:worker-chain` | 通过：5 passed（4.2m） |
| `@rakazo/logging check` / `@rakazo/adapters check` | 通过 |
| `packages/logging` + `packages/adapters` 定向 vitest | 通过（logging 37；adapters 116） |
| `docker build -f infra/compose/Dockerfile .` | 通过一次（内容审计见上）；加入 corepack 修复后的重建见"已知限制" |
| `docker build -f services/agent-runtime/Dockerfile .` | 见"已知限制" |
| `pnpm test:postgres` | 通过：**52 文件 / 470 tests 全绿**，exit 0。**注意**：这些测试的门卫是 `process.env.VERIFY_DATABASE && process.env.DATABASE_URL`，而 `test:postgres` 这个 group runner 两个都不设——直接跑会得到 `2 passed / 463 skipped` 且 **exit 0**，那是假绿。本次用一次性 PG16 容器（宿主端口 5499，`prisma migrate deploy` exit 0）加 `VERIFY_DATABASE=1` 真跑 |
| `pnpm test:integration` | **1 failed / 40 passed（41）**，失败项 `journeys.test.ts:2063` journey 54。已证明是**既有基线红**，见 `integration-baseline-comparison.txt` |
| 真容器启动：api / worker / web 三条生产命令 | 三个容器全部 `running`：api `/health` → 200 `{"ok":true}`、worker 持续 `job.completed`、web `GET /` → 200（2578 字节） |

**journey 54 的基线对照**（`integration-baseline-comparison.txt`）：把本 diff 中唯一可能影响该 TS 旅程的
四个文件（`agentscope-runtime.ts`、`executor.ts`、`redaction.ts`、`redaction.test.ts`）
`git checkout a29c711 --` 回退后重跑 `pnpm test:integration`，结果**逐字相同**：
同一条 journey 54、同一断言行、`1 failed | 40 passed (41)`。之后 `git checkout HEAD --` 还原，
工作树干净，HEAD 仍是 `b3c235a`。
根因是过期预期：该断言期待双 mention 后两个 Bot 都产生 Run，而
`packages/core/src/product-harness/response-owner.ts` 的 `resolveExplicitTurnOwner` 规定
多个显式 mention 且无 separate-answers 标记时**只由第一个 mention 作为唯一 owner**，
所以 botB 永远不会有 Run。此规则自 RT-22（#111）起即如此，同一条规则也已让
`apps/web/e2e/group-chats.spec.ts` 的等价断言失效。**本任务未修它** —— 它属于群聊产品语义，
不在本交付单元范围内，且任务书禁止顺手扩大范围。

另需注意：`pnpm exec vitest run packages/testkit/src/journeys.test.ts` 单独跑会报
`41 skipped` 且 exit 0（harness 才会设测试所依赖的 env），**不能当成通过**。

未跑：无。任务书列出的本地入口已全部执行，结果如上。

## 已知限制

1. **两次镜像重建都被本机网络吞吐打断，但不是被本任务的改动打断**。
   - 多阶段改造后的第一次重建**成功**（23:52→00:05，`workpal-rr01:app`，3.46GB）；
     第 2 节的全部内容审计、以及"启动真实容器"暴露出 corepack 缺陷，都是在这个镜像上做的。
   - 加上 corepack 那一行后的第二次重建**失败**，但失败点是既有的、本任务未修改的
     `RUN pnpm --filter @rakazo/db generate`：
     `request to https://binaries.prisma.sh/all_commits/0edf323e.../linux-arm64-openssl-3.0.x/schema-engine.sha256 failed,
     reason: Client network socket disconnected before secure TLS connection was established`。
     同一次构建里 `pnpm install` 花了 13m3s 才完成（第一次约 7 分钟）。
     构建根本没走到 runtime 阶段，所以 corepack 那一行本身没有被构建验证。
   - Java 镜像构建下载 `maven:3.9.11-eclipse-temurin-21` 基础层时约 30KB/s，20 分钟只到 40/41MB，
     已中止以免继续抢占带宽。该 Dockerfile 未修改。
   - 环境事实：DNS 解析到 `198.18.0.187`（fake-IP 代理段），`registry-1.docker.io` 直连返回 401
     （未鉴权的正常响应），说明是代理吞吐/稳定性问题而非不可达。
   - **corepack 修复改用等价方式在真实镜像里验证**：在已构建的 `workpal-rr01:app` 内执行
     Dockerfile 里那条一模一样的命令，`node -p "require('/app/package.json').packageManager"`
     派生出 `pnpm@9.15.0`，`corepack prepare ... --activate` 后 `pnpm --version` 输出 `9.15.0`
     且**不再有下载提示**；`pnpm --filter @rakazo/api exec node -e ...` 也能在裁剪后的树里正确解析
     工作区包（证明 testkit 只剩 manifest、`infra/updater` 缺席都不破坏工作区图）。
     仍缺的只是"把 corepack 那一行烤进镜像的完整重建"；容器启动验证已完成，见下。
2. **`runtime.tools.resumed` 未被任何本地入口触发**。128 个 Java 测试和 worker-chain 都没有
   驱动外部工具 resume（`RequireExternalExecutionEvent`），所以工具桥边界这一条只有代码审查依据。
   已确认它不引入新的失败模式：紧随其后的 `resumeTools` 本来就 for-each 遍历同一个 list，
   `getToolCalls()` 若为 null 原代码同样 NPE。
3. **`TaskRepositoryLifecycle`（线程/仓库泄漏修复）没有独立的先红后绿证据**。
   它是按代码事实修的（每个委派 Run 泄漏守护线程，越过 Run 生命周期继续写工作区），
   不是本次 flake 的已证根因；已证根因是任务记录 split-brain。若要严格要求，可考虑撤销这一项单独立卡。
4. **worker-chain 的日志文件里看不到 `rakazo-worker` 行**，因为 harness 用
   `stdio: ["ignore","pipe","pipe"]` 起 Worker 子进程，输出进诊断 buffer 而不转发。
   这是 harness 的可观测性限制，不是关联接线的缺口：第 3 节已用真 Worker 容器直接证明
   `rakazo-worker` 的 job 事件带 `trace.id`；而 Java 侧能拿到 API 的 `trace.id` 和
   `parent.span.id`，也正说明 Worker 的 job 关联把 trace 放进了 payload 并由 adapter 转发。
   因此"API → Job/Worker → executor/adapter → Java"四层里，**唯一没有单份日志同时呈现四层的**
   是 Worker 那一跳 —— 它由两份独立证据拼合（worker-chain 的 api+java 同 trace，
   加真容器的 worker job 事件），不是一次运行里的四行连续日志。
5. **`409 Session already has an active run` 未修**，理由见第 1 节"撤销的一处改动"。建议单独立卡。
6. **`pnpm test:integration` 有一条红**：journey 54（双 mention 期待两个 Bot 都回复）。
   已用基线对照证明与本 diff 无关（见上），根因是过期预期与 `resolveExplicitTurnOwner`
   的单一 owner 规则冲突。**未修**：属群聊产品语义，不在本交付单元范围。建议单独立卡，
   否则每个后续 PR 的 integration 门禁都会带着这条红。
7. 未部署，未推远程，未提 PR，未合并。未改 GitHub 设置。

## 边界确认

- 未修改：卡片产品协议、卡片 API、Web 页面、AgentScope 生产执行器地位、RT-15 gate 与 SDK 版本、
  Run/Attempt/ExternalEffect/session admission 的业务状态语义、GitHub branch protection、用户可见文案。
- 未修改共享冲突文件：`apps/api/src/router.ts`、`packages/contracts/src/rpc.ts`、`package.json`、
  `pnpm-lock.yaml`、`.github/workflows/ci.yml`、`scripts/ci/`、`AGENTS.md`。
  `@rakazo/logging` 已是 `packages/adapters` 的既有 workspace 依赖，所以关联改动不需要动 manifest。
- 关联字段全部走已存在的 `AgentRunRequest.sessionAdmission`（`attemptId` / `sessionKey` 本来就在里面）
  和 HTTP 头，**没有经过共享 API 契约**。
- 最终 diff 中无密钥、无真实用户数据、无私有 URL、无本机路径；证据文件经过同样的泄漏扫描。
