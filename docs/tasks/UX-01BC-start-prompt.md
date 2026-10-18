# UX-01B + UX-01C 连续开工提示词

你负责连续交付 WorkPal 的 UX-01B 和 UX-01C。两项连续开发，但必须保留独立分支、提交、PR diff 和验收证据；不得自行合并或部署。

## 必读

按顺序完整阅读：

1. `AGENTS.md`
2. `docs/ux/UX-01-decision.md`
3. `docs/tasks/UX-01B.md`
4. `docs/tasks/UX-01C.md`
5. `docs/ux/UX-01A-implementation.md`
6. `docs/next-work-roadmap.md`

任务卡中的边界裁决是本次实施契约，尤其注意：

- B 必须完成所有生产可见的数字/进度收敛，不能把它推给 C；
- Todo 单独不能触发执行区；事项清单只是在合法执行区中的旧数据兜底；
- Plan item 没有独立时间字段，elapsed 只能来自匹配 `planItemId` 的可信 semantic Step；
- summary-only、原生 `plan_write`、工具 Activity、Markdown 和消息 steps block 都不能生成 Plan 进度；
- 不改 contracts、DB、Prisma、API、Worker、Java Runtime、工具 schema、事件或迁移。

## Phase 0：基线与预检

1. 确认 `main` 包含 merge commit `1ba9895`，且该提交的 main CI 最终为 green；若 main 已前进，记录新 SHA，并重新核实两张任务卡列出的代码事实。
2. 从最新 green main 创建 `codex/ux01b-progress-convergence`；不要复用旧 UX/Avatar 分支。
3. 用任务卡中的 `rg` 命令重新定位关键符号，保存输出摘要到 UX-01B 交付说明。
4. 在任何产品修改前运行 UX-01B 定向测试和 Web typecheck，记录基线数量与结果。
5. 发现契约与代码事实冲突时，先给出证据、影响和最小解决方案；不要凭猜测扩大协议或后端范围。

## Phase 1：UX-01B

严格按 `docs/tasks/UX-01B.md` 实施验收 1–13：

- 四项 execution-surface 条件；
- 第 0/1/2 层；
- Plan-only 唯一进度；
- 默认收起、Intervention 折叠体外、failed 两种查看原因路径；
- revision 更新提示；
- 普通请求轻量状态；
- 侧栏只保留头像状态、aria 与 waiting/approval 回焦。

要求：

1. 先补纯函数/组件红色测试，再改实现；现有测试只允许因批准的产品规则而更新，必须逐条记录。
2. 新文案执行 Lingui extract/compile，`.po` 单独提交。
3. 跑 UX-01B 任务卡的全部门禁，以及现有 `execution-card.spec.ts`、`task-center.spec.ts`。
4. 写 `docs/ux/UX-01B-implementation.md`，包含验收 1–13 证据、代码事实偏差、测试数量和风险。
5. 更新 `docs/tasks/UX-01B.md` 与 roadmap 为 `delivered, ready-to-merge`，不要写 done。
6. 推送 `codex/ux01b-progress-convergence`，创建 base=`main` 的 PR；不要合并。

## Phase 2：立即连续做 UX-01C

B 的定向门禁全绿、接口稳定、提交已推送后，不等待 B 评审结束：

1. 从 B 的精确 head 创建 `codex/ux01c-compatibility-e2e`。
2. 严格按 `docs/tasks/UX-01C.md` 实施验收 14–20：detail error/retry、summary-only、固定降级顺序、detail/legacy Todo 去重一致、原生 Plan Mode 隔离和 A/B/C E2E。
3. 先用测试证明当前 detail error 被吞和两条 Todo 路径不一致，再修复。
4. 写 `docs/ux/UX-01C-implementation.md`，提供完整 20 条证据矩阵。
5. 跑 C 定向门禁，然后只在 C 收口时跑一次 apps/web 全量 Vitest、Web build 和三份 focused E2E。
6. 推送 C，创建 base=`codex/ux01b-progress-convergence` 的 stacked PR；不要合并。B 合入后再把 C base 改为 `main`，证明 diff 只剩 C。

## 测试纪律

- 使用仓库锁定的 `corepack pnpm`。
- 禁止 skip、放宽 selector、扩大 timeout、删除失败断言或用静态 mock 代替本应经过的产品路径。
- E2E 使用独立测试数据库，不得接触生产或个人数据。
- 不为 Web-only 改动本地重复运行完整 AgentScope/worker-chain；GitHub CI 负责该仓库级门禁。若它失败，先区分本次回归与已知 flake。
- 完成前检查 `git status` 和完整 diff；不得提交 `.env`、密钥、真实用户数据、私有 URL、本机路径或身份信息。

## 最终回报格式

一次性报告 B 和 C，但分开列出：

1. 分支、base/head、提交列表、PR 链接和 stacked ancestry；
2. 每项实际修改；
3. UX-01 20 条验收证据矩阵；
4. 定向测试、全量 Web 测试和三份 E2E 的命令、数量、耗时与结果；
5. 修改过的旧断言及其产品理由；
6. 代码事实偏差、剩余风险和未做事项；
7. 安全 diff 检查结果；
8. 明确写出“未合并、未部署，等待 RiversXu 审查”。

