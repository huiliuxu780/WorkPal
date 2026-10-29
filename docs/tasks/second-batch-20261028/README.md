# 第二批交付说明

状态：`done`（RUNTIME-RELIABILITY-01 / PR #155 与 CARD-01E / PR #154 均已合入 `main`）

本批只包含两个交付单元：

1. [CARD-01E：卡片系统产品闭环](./CARD-01E.md)
2. [RUNTIME-RELIABILITY-01：Runtime 生产可靠性](./RUNTIME-RELIABILITY-01.md)

每个交付单元由一个 Coding Agent 负责，一个交付单元使用一个分支和一个 PR。测试、运行证据、CI 修复和 review 修复都留在所属交付单元中，不另建任务。

本目录取代 `NEXT-BATCH-20261027.md` 的派工顺序。旧文件仍保留当时的项目盘点，不再作为第二批 Coding Agent 的执行提示词。

## 交付顺序

两个单元并行开发。原计划先合 CARD-01E，再将 Runtime 同步到最新 `main`。CARD-01E 的最终 CI 连续命中本批 Runtime 单元已经定位并修复的 Java task-record flake；继续重跑会掩盖真实缺陷，把 Java 修复塞进卡片 PR 又会破坏模块边界。因此最终合并顺序调整为：

1. Runtime 在自己的 PR 中完成根因修复、CI 和复审后先合入 `main`。
2. CARD-01E 合并最新 `main`，在同一最终 head 上重新运行卡片门禁与完整 CI。
3. 两个单元都进入 `main` 后，第二批结束。该条件现已满足。

这个调整没有增加第三个交付单元，也没有把 Runtime 代码夹带进卡片 PR。

## 模块边界

| 交付单元 | 主要所有权 |
| --- | --- |
| CARD-01E | 卡片契约与投影、卡片和 Attention 查询、卡片 API、Web 卡片与通知、卡片 E2E、卡片文档 |
| RUNTIME-RELIABILITY-01 | `packages/logging`、Worker 执行链、AgentScope adapter、Java Runtime、生产镜像、Runtime 集成测试和运行文档 |

## 本批不做

本批不实现 `@我`，不恢复 Task Center，不启动新的 RT-15 探针，不解除 RT-16、RT-17 或 RT-18 的暂停，不实现 PD-01F，也不部署生产环境。
