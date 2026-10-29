# HARNESS-01：修正 Agent 开发、验证和交付工作流

状态：`not-started`。

决策依据：[WorkPal AI 编码工作流评审与清理方案](../agent-workflow-harness-review-2026-10-25.md)。评审基线是 `origin/main @ ff2fd2a`，日期为 2026-10-25。实施者必须从开工时的最新 `origin/main` 重新核对事实。评审中的数量是时间点快照，不是永久常量。

## 交付结果

完成本任务后，仓库必须满足以下结果：

1. 开发者能运行明确分层的单测、PostgreSQL 测试、AgentScope 集成测试和 Web E2E。每个测试文件至少属于一个明确的 CI 执行入口；重复归属必须有依赖理由。
2. CI 对当前 PR head 给出可信的 `CI result`。Draft PR 可以跳过昂贵任务；非 Draft PR 的每次新提交必须重新产生所需结果。
3. Web E2E 失败时，CI 保留 HTML 报告、trace、截图、视频和 harness 报告。
4. 每日验证只有一个真实入口。该入口运行既定视觉检查并保留产物，不再每天产生确定性失败。
5. main 拒绝红色 `CI result` 和 force push。该设置不强制每个 PR 手工跟随 main；并发合并确有问题时再启用 merge queue。
6. 两个独立 worktree 可以同时运行本地 E2E 或 Compose，不共享端口、Compose 项目、卷、数据目录或显式外部测试数据库。
7. 一个失败 Run 可以通过 `runId`、`attemptId` 和 `traceId` 从 API、Worker、TS adapter 追到 Java runtime 的失败步骤。日志不得记录密钥、完整提示词、工具参数或用户内容。
8. 文档、验证命令和代码一致。过时的 Electron、mobile 和 `apps/www` 指引不再出现在当前开发说明中。
9. 已合并且确认无用的 worktree 和远程分支可以按审计清单清理。未合并提交、未提交改动和活动 PR 不得删除。

## 交付组织

这是一张总任务卡，不是一个巨型 PR。指定一名协调人负责最终结果，并按下列批次提交独立 PR。

| 批次 | 内容 | 依赖 | 交付方式 |
| --- | --- | --- | --- |
| H1 | 测试清单、测试命令和 CI 基础门禁 | 无 | 代码 PR |
| H2 | E2E 失败产物、flake 修复和每日视觉验证 | H1 的命令稳定 | 代码 PR |
| H3 | PR 门禁、模板、仓库检查和文档收敛 | H1、H2 | 代码 PR + 管理员操作记录 |
| H4 | 多 worktree 本地隔离 | H1 | 代码 PR |
| H5 | Run 级可观测性 | H1 | 代码 PR |
| H6 | worktree 和远程分支审计清理 | H3 | 审计报告 + 单独授权的维护操作 |

H2、H4 和 H5 可以并行，但必须使用不同 worktree。涉及 `.github/workflows/ci.yml`、`package.json`、`AGENTS.md`、`README.md` 或 `CONTRIBUTING.md` 的改动必须串行合并。后开工的批次先合入最新 main，不得解决冲突时丢弃已经合入的门禁。

每个代码 PR 只完成一个批次。不要把 H6 的删除操作混入代码 PR。

## 授权边界

实施者可以修改仓库中的测试、脚本、CI、开发文档和日志代码。以下操作需要停止并向负责人申请明确授权：

- 删除任何含未提交改动的 worktree。
- 删除任何未合入 main 的远程分支。
- 修改 GitHub ruleset、branch protection、merge queue 或自动删除分支设置。
- 修改生产部署、生产凭据、真实用户数据或私有 URL。
- 修改前端页面的视觉、布局、文案、交互、导航或响应式行为。

本任务不实现 Electron 或移动端，不恢复 Pi 或 Python runtime，不改变 AgentScope 作为唯一生产 Agent 执行器的约束，不部署生产环境。

如果修复 E2E 必须改变生产页面表现，立即停止该项。先制作可运行原型，引用具体原型文件和场景，取得用户确认后再创建独立 UI 任务。本任务没有授权实现者自行补设计。

`apps/grokbot-prototype/` 和 `docs/roundtable/` 的归属尚未确认。不要删除、移动、提交或加入 `.gitignore`。

## 所有批次共同遵守的规则

1. 从最新 `origin/main` 创建独立 worktree。不要在当前旧脏工作树上开发。
2. 开工前记录 `git rev-parse HEAD`、`git status --short` 和本批次会修改的文件。
3. 先复现问题，再修改生产代码或测试。未复现的历史失败只能标记为历史证据。
4. 不通过增加重试、延长 timeout、删除断言、跳过测试或吞掉错误来处理 flake。
5. 未实现能力必须失败或禁用，不能返回模拟成功。
6. 不提交 `.env`、密钥、真实用户数据、私有 URL、本机用户名或绝对路径。
7. 每个 PR 在正文中列出实际运行的命令、结果、未运行项和原因。
8. 提交前检查 `git status --short` 和完整 diff。只提交本批次文件。

## H1：让测试命令和 CI 覆盖真实范围

### 目标

建立一份机器可检查的测试清单，拆开无外部依赖的单测，并让 lint 和单测成为 CI 的真实门禁。

### 实施步骤

1. 枚举仓库中的 `*.test.ts`、`*.test.tsx`、`*.integration.test.ts` 和 `*.postgres.test.ts`。记录每个文件需要的运行环境：
   - 纯 Node 或 jsdom。
   - PostgreSQL。
   - Java AgentScope runtime。
   - Playwright Web。
   - 独立 Worker 或 Docker。
2. 把清单写成集中式代码或数据文件，并增加完整性检查。新增测试文件如果没有归入执行入口，CI 必须失败。
3. 新增 `vitest.unit.config.ts` 或等价配置。排除 PostgreSQL、integration、Playwright 和进程级测试。
4. 在根 `package.json` 增加 `test:unit`。该命令必须在没有数据库、JDK、Docker 和付费凭据的干净 checkout 中运行。
5. 不要假设全部 PostgreSQL 测试可以由一个裸 `vitest` 命令运行。评审基线记录了 42 个文件，实施时以自动枚举的实际数量为准。先按真实依赖分类。如果一个环境不能运行全部文件，提供多个明确入口，并用清单检查证明所有文件都有归属。
6. 保留现有 `test:integration`。不要新增不存在的 `select-checks.mjs --local`。如果需要本地 affected 模式，单独实现参数、帮助文本和定向测试。
7. 把 `pnpm lint`、`pnpm test:unit` 和测试清单完整性检查接入 CI。同步更新 `scripts/ci/select-checks.mjs` 和选择器测试。
8. 修完当前 Biome 错误。不要默认加入长期 allowlist。如果某条规则确实不能立即修，提交负责人、原因、精确文件范围和到期条件，并取得批准。
9. 更新 `README.md` 和 `docs/agent-verification.md`。只记录在干净 checkout 中实际运行通过的命令。

### 验收

- `pnpm lint` 通过。
- `pnpm test:unit` 通过，且不启动 PostgreSQL、Java、Docker 或浏览器。
- 测试清单检查通过，并证明每个测试文件至少属于一个执行入口。
- 随机把一个新 `*.postgres.test.ts` 文件放入未分类目录时，清单检查失败。
- `pnpm test:ci-select` 通过。
- CI 对包含 `vitest.unit.config.ts`、测试清单或选择器的改动运行完整验证。
- README 中的每条验证命令均实际运行通过。

## H2：保留失败证据并消除已确认的 E2E flake

### 目标

CI 失败后可以直接下载诊断证据。已确认的 `budget-acceptance` 和 `execution-card` flake 必须通过确定性同步或生产根因修复消除。

### 实施步骤

1. 在运行 Playwright 的 job 失败时上传以下路径：
   - `playwright-report/`
   - `apps/web/test-results/`
   - `test-report/`
2. artifact 名称包含 job、SHA 和 run attempt。没有产生文件时不掩盖原始失败。
3. 制造一个受控的 E2E 失败，在真实 GitHub PR run 中确认 HTML、trace、截图和视频可下载。
4. 分别复现 `budget-acceptance.spec.ts` 和 `execution-card.spec.ts` 的历史失败。记录等待对象、状态转换、事件顺序和失败时数据库状态。
5. 用明确的状态同步、事件确认或生产根因修复替换竞态。不要加入固定 sleep、通用 retry 或更宽的终态集合。
6. 保留预算用例当前的产品语义。测试既要覆盖排队边界，也要在对应生产链路中证明最终投递。不要把二者混成一个模糊断言。
7. 把 nightly 原本要求的视觉检查迁入一个真实可运行的每日入口。优先复用现有 `ci.yml` 的 schedule，避免维护两套不同的 full 命令。
8. 让每日视觉检查上传截图和报告。手动触发一次并成功后，才删除引用不存在 `playwright.yml` 的 workflow。
9. 更新 `docs/agent-verification.md`。准确写明每日入口运行什么、不运行什么，以及产物保留期限。

### 验收

- 受控失败的 GitHub run 包含可打开的 HTML 报告、trace、截图和视频。
- 两个目标 spec 各连续运行至少 10 次，结果全部通过。运行使用同一提交和相同环境，不用 retry 隐藏失败。
- 修复包含能在旧代码上失败的定向测试或受控复现。
- 每日视觉入口手动运行成功一次，并留下 run URL 和 artifact 名称。
- 删除旧 nightly 后，不再创建新的确定性失败运行。历史运行记录可以保留。
- 没有生产 UI 视觉或交互改动。

## H3：把交付规则变成仓库和 GitHub 门禁

### 目标

当前 PR head 没有通过所需验证时，main 不能合并。开发说明、PR 模板和 CI 检查使用同一套规则。

### 实施步骤

1. 保持固定名称的 `CI result`。验证 docs-only、选择性验证、full、失败、cancelled 和意外 skipped 的结果。
2. Draft PR 只运行快速检查时，明确显示昂贵任务尚未执行。PR 转为 ready 时运行该 diff 所需的完整任务。
3. 非 Draft PR 每次 `synchronize` 都为当前 head 重新运行所需任务。旧 SHA 的成功结果不得满足新 SHA。
4. 增加 `.github/pull_request_template.md`。字段至少包含任务卡、实际验证命令、风险、文档回写，以及 UI 原型或“不涉及 UI”的声明。
5. 增加仓库可见的 pre-commit 安装脚本和 hook。hook 检查 `.env`、受限目录和异常大文件。资产目录使用明确白名单，不用一个全局 1MB 阈值阻止正常字体、图片和测试夹具。
6. 在 CI 中实现同等检查。pre-commit 只能提醒，不能作为门禁。
7. 更新 `AGENTS.md`，链接 `docs/agent-verification.md` 和本任务交付的真实命令。保留前端原型铁律。
8. 更新 `CONTRIBUTING.md`。删除当前项目中不存在的 Electron、mobile 和 `apps/www` 开发指引。
9. 核对 `vitest.config.ts`、`biome.json` 和 `skills-lock.json`。只删除已确认不存在且没有生成用途的路径。让 Skill hash 有生成和校验入口，或删除没人消费的锁文件。
10. 准备 GitHub 设置变更单。变更单写出当前值、目标值、回滚方法和验证 PR。管理员批准后再执行：
    - 要求当前 head 的 `CI result`。
    - 禁止 force push。
    - 不要求分支始终与 main 同步。
    - 暂不启用 merge queue。只有并发合并证据表明需要时再启用。
11. 在 H3 完成前收口 H1F 的临时排除：五组已确认原型路径，以及 `biome.json` 中记录的 188 个 formatter/import-sort 历史文件。逐项选择修复并重跑原型验证、截图和哈希，或证明其为生成、冻结或历史设计资产并取得负责人永久排除批准；不得让排除无主。
12. 将集中 worktree、禁止嵌套、使用 Git 方式删除 worktree 等规则写入 `AGENTS.md` 和 `docs/agent-verification.md`，并在文档中给出可验证的检查入口。

### 验收

- H1F 的五组原型路径和 188 个 formatter/import-sort 临时排除已全部收口，或有负责人批准的永久排除记录。
- `AGENTS.md` 和 `docs/agent-verification.md` 包含集中 worktree、禁止嵌套和使用 Git 方式删除 worktree 的规则。
- docs-only、Web、backend 和 full 四种 PR 样例都出现同名 `CI result`。
- 故意让已选 job 失败时，`CI result` 失败且 PR 不能合并。
- 非 Draft PR 增加新提交后，旧 SHA 的结果不能满足新 head。
- 未安装 hook 的 clone 仍会被 CI 拦截 `.env`、受限目录和不允许的大文件。
- `rg 'apps/mobile|apps/desktop|apps/www' README.md CONTRIBUTING.md AGENTS.md docs/agent-verification.md` 只命中明确标注的历史说明，或没有命中。
- GitHub API 返回 `CI result` 为必需检查，并显示 force push 被禁止。把 API 输出中的仓库名和私有信息从公开文档中移除。

## H4：隔离多个 worktree 的本地运行资源

### 目标

两个 worktree 同时运行 E2E 或 Compose 时互不占用对方的端口、容器、卷、数据目录或测试数据库。

### 实施步骤

1. 先检查 `packages/testkit/src/cli/harness.ts`、`scripts/dev-workpal.mjs` 和 Compose 文件。复用现有参数，不再增加第二套配置来源。
2. 提供一个仓库命令，例如 `pnpm agent:doctor`。命令输出当前 worktree 的资源计划，并检查冲突。
3. 从规范化的 worktree 路径或显式 task slug 生成合法且稳定的资源前缀。不要把本机用户名或完整路径写入日志、配置或 Git。
4. 优先让测试进程向操作系统申请空闲端口。如果组件必须预先知道端口，使用带锁的本地租约文件完成分配，并在进程退出后释放。
5. Compose 使用唯一项目名和可配置宿主端口。每个项目使用独立卷。`compose down` 只能删除当前项目资源。
6. 默认 E2E 继续使用独立 Testcontainer。显式设置 `WORKPAL_E2E_DATABASE_URL` 时，doctor 验证数据库名以 `workpal_e2e_` 开头，且不被另一个活动租约使用。
7. integration 继续使用 Testcontainer 和每 suite 数据库克隆。不要向 integration 传入当前代码明确拒绝的外部数据库 URL。
8. 资源分配和清理必须幂等。进程异常退出后，doctor 能识别陈旧租约并给出安全恢复命令。

### 验收

- 在两个独立 worktree 中并行运行目标 E2E，两者都通过且端口不同。
- 在两个独立 worktree 中并行启动 Compose，两者的项目名、容器、卷和宿主端口不同。
- 停止其中一个 Compose 项目不会停止或删除另一个项目资源。
- 强制制造端口、项目名和外部数据库冲突时，doctor 在启动前失败并指出具体资源。
- 异常终止一次运行后，重新执行相同命令不会遗留错误的活动租约。

## H5：增加 Run 级可观测性

### 目标

一次失败不需要重跑 E2E，就能从 API 或 Worker 日志定位到 Java runtime 的具体执行步骤。

### 实施步骤

1. 定义跨 TS 和 Java 的相关字段：`traceId`、`runId`、`attemptId`、`sessionId`、`stepId` 和安全的错误类别。
2. 在系统边界生成或接收 `traceId`。把字段传过 API、队列、executor、AgentScope adapter 和 Java runtime。
3. 在以下状态边界写结构化日志：领取、开始模型请求、工具调用开始和结束、暂停、恢复、取消、预算终止、lease 丢失、Java 错误和最终状态。
4. 不记录密钥、Authorization header、完整提示词、完整工具参数、用户内容或模型原始响应。为日志字段增加脱敏测试。
5. Java 返回稳定的安全错误类别和 step 标识。客户端继续显示脱敏错误，不泄漏栈或内部路径。
6. 增加一个受控失败旅程。用同一 `traceId` 关联 API、Worker、adapter 和 Java 日志，并证明能定位失败步骤。
7. 记录字段定义、保留策略和查询示例。示例使用合成 ID 和合成内容。

### 验收

- 受控失败的四层日志共享同一 `traceId` 和 `runId`。
- 日志能区分模型失败、工具失败、预算终止、取消和 lease 丢失。
- 脱敏测试证明敏感 header、提示词和工具参数不会进入日志。
- Java Maven 测试、受影响 TS 包类型检查和定向测试通过。
- 文档中的查询示例可以从一次失败定位到具体 `stepId`。

## H6：审计并清理 worktree 和远程分支

### 目标

删除经过证明可以恢复或不再需要的开发资源。清理不能丢失代码，也不能影响打开的 PR。

### 实施步骤

1. 生成 worktree 清单。每项记录路径、分支、HEAD、工作树状态、是否合入 main、是否有打开 PR，以及目录大小。
2. 生成远程分支清单。每项记录 tip、是否合入 main、打开 PR 的 head 或 base 引用、关闭 PR、独有提交数和负责人。
3. 把清单提交为维护报告或附在内部工单中。不要提交本机绝对路径、用户名或私有仓库 URL。
4. 将候选项分为：
   - 可删除：干净、已合入 main、没有打开 PR 引用。
   - 需保留：有未提交改动、未合入提交、打开 PR 引用或负责人要求保留。
   - 待确认：无法证明归属或恢复路径。
5. 先让负责人批准精确候选列表。批准必须列出分支名或经过脱敏的 worktree 标识，不能只说“清理旧的”。
6. 使用 `git worktree remove <exact-path>` 删除已批准 worktree。不要用递归文件删除代替 Git 操作。
7. 分批删除已批准的远程分支。每批删除后重新抓取远端并核对打开 PR。
8. 未合并但 PR 已关闭的分支默认保留。只有负责人确认独有提交已归档或可以放弃时才删除。
9. 管理员批准后，可以启用合并后自动删除 head 分支。该设置不替代对现有分支的审计。

### 验收

- 每个删除项都有合入、PR 引用、独有提交和工作树状态证据。
- 打开的 PR 仍能找到 head 和 base 分支。
- 所有带未提交改动或未合入提交的项仍存在，除非负责人对精确项给出删除授权。
- `git worktree list` 不再包含已批准删除的路径。
- 远程只保留活动分支和有明确保留原因的分支。不使用目标数量代替逐项判断。
- 清理记录列出执行时间、执行者、删除项和恢复方式。

## 总体验收

协调人在所有批次完成后创建 `docs/harness-cleanup-delivery.md`。该文件只汇总已经发生的结果，并包含以下证据：

- 每个批次的 PR 和合并 SHA。
- `pnpm lint`、`pnpm test:unit`、测试清单检查、`pnpm test:ci-select` 和受影响包检查的结果。
- E2E 受控失败 artifact、目标 flake 重复运行和每日视觉 run 的 URL 或内部编号。
- branch protection 的生效状态和回滚方法。
- 两个 worktree 并行运行的端口、Compose 项目和数据库隔离证据。
- 一个合成失败 Run 的跨层日志关联证据。
- H6 的批准记录和清理结果。
- 未完成项、原因、负责人和下一次检查日期。

只有当上述证据齐全、所有代码 PR 已合入、外部设置已验证、清理得到明确授权时，才把本任务标记为 `done`。某个批次无法完成时，保持本任务 `in-progress`，不能用文档声明代替实现。

## 派发提示词

将下面文字和本任务卡一起交给协调人：

> 请完整交付 `docs/tasks/HARNESS-01.md`。先读 `AGENTS.md`、该任务卡和 `docs/agent-workflow-harness-review-2026-10-25.md`，从开工时最新 `origin/main` 建独立 worktree。你是总协调人，但不得把全部改动放进一个 PR。按 H1 到 H6 的依赖顺序提交独立 PR，H2、H4、H5 可以使用不同 worktree 并行；共享 CI、package 和文档文件必须串行合并。先复现再修复，不得用 retry、放宽 timeout、删断言或跳过测试制造绿色结果。不得修改前端视觉或交互；如果确实需要，暂停并先走原型确认。不得删除未审计 worktree、未合并分支、未提交改动或活动 PR 引用；GitHub 设置和任何删除操作都要先提交精确变更单并取得负责人授权。AgentScope 保持唯一生产执行器，不恢复 Pi 或 Python fallback，不部署生产，不接触真实凭据或用户数据。每个 PR 报告实际命令、结果和未运行项。完成全部批次后提交 `docs/harness-cleanup-delivery.md`，用真实 PR、CI、artifact、并行隔离、日志关联和清理记录证明结果。
