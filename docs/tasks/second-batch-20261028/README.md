# 第二批交付说明

本批只包含两个交付单元：

1. [CARD-01E：卡片系统产品闭环](./CARD-01E.md)
2. [RUNTIME-RELIABILITY-01：Runtime 生产可靠性](./RUNTIME-RELIABILITY-01.md)

每个交付单元由一个 Coding Agent 负责。一个交付单元使用一个分支和一个 PR。测试、运行证据、CI 修复和 review 修复都留在所属交付单元中，不另建任务。

本目录取代 `NEXT-BATCH-20261027.md` 的派工顺序。旧文件仍保留当时的项目盘点，不再作为第二批 Coding Agent 的执行提示词。

## 开始条件

先把第一批已完成的 PR 合入 `main`。至少满足以下条件后再创建第二批 worktree：

- CARD-01E 等待 CARD-01A、CARD-01B、CARD-01C、CARD-01D 和 RT-12 全部进入 `main`。
- RUNTIME-RELIABILITY-01 等待 FIX-STOP-01 和 FIX-PERSONA-01 进入 `main`。
- 两个 Agent 都从同一个最新 `origin/main` 创建干净 worktree，并在任务回交中记录基线 SHA。

合并第一批和修改 GitHub 设置仍需要负责人授权。没有授权时可以阅读任务书，但不要从尚未合入的 PR 复制代码到第二批分支。

## 开发和交付顺序

两个 Agent 可以并行编码。按以下边界分工：

| 交付单元 | 主要所有权 |
| --- | --- |
| CARD-01E | 卡片契约与投影、卡片和 Attention 查询、卡片 API、Web 卡片与通知、卡片 E2E、卡片文档 |
| RUNTIME-RELIABILITY-01 | `packages/logging`、Worker 执行链、AgentScope adapter、Java Runtime、生产镜像、Runtime 集成测试和运行文档 |

以下文件容易产生冲突：

- `apps/api/src/router.ts`
- `packages/contracts/src/rpc.ts`
- `package.json`
- `pnpm-lock.yaml`
- `.github/workflows/ci.yml`
- `scripts/ci/`
- `AGENTS.md`

CARD-01E 拥有前两个文件中与卡片有关的修改。RUNTIME-RELIABILITY-01 应在日志中间件、Job 元数据和 Runtime 边界完成关联信息传递，不要顺手重写卡片路由。第二批不计划修改 `AGENTS.md`。任何 Agent 必须修改其他共享文件时，先把文件、原因和预计改动发给整合者；两个 Agent不能并发修改同一文件。

开发可以并行，两个 Coding Agent 都先停在“本地全绿并提交 commit”的交接点，不自行开 PR：

1. CARD-01E Agent 完成代码和本地测试，提交 commit，确认工作树干净，然后把分支、commit 和结果交给 Reviewer。
2. Runtime Agent 同时完成代码和本地测试，提交 commit，确认工作树干净，然后把分支、commit 和结果交给 Reviewer。
3. Reviewer 先复审 CARD-01E，再为它提 PR、等待 CI 并完成合并决策。
4. CARD-01E 合入后，Runtime Agent 把分支 rebase 到最新 `main`，重新运行本地门禁，再次交给 Reviewer。
5. Reviewer 复审 Runtime，再为它提 PR、等待 CI 并完成合并决策。

如果只有一个 Coding Agent，按同一顺序串行开发。

## Coding Agent 的工作方式

Coding Agent 负责完整模块，不只负责写代码。

1. 在本地完成任务书中的产品结果。
2. 修复开发过程中发现的同模块缺陷。不要把这些缺陷拆成新任务。
3. 在提 PR 前运行任务书要求的本地检查和真实流程。
4. 只有本地检查全部通过后才提交最终 commit，并把结果交给 Reviewer。
5. 除非负责人另行授权，Coding Agent 不推送远程分支、不提 PR、不合并，也不修改 GitHub 设置。

Reviewer 检查产品行为、代码和关键运行事实。Reviewer 不机械重复全部测试。PR CI 在最终 head 上运行仓库门禁。review 或 CI 发现的问题继续在原分支修复。

## 本批不做

本批不实现 `@我`，不恢复 Task Center，不启动 RT-15 新探针，不解除 RT-16、RT-17 或 RT-18 的暂停，不实现 PD-01F，也不部署生产环境。
