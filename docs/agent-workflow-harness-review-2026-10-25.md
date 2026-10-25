# WorkPal AI 编码工作流 Harness 评审与清理方案（修订版）

- 日期：2026-10-25
- 代码基线：`origin/main` `ff2fd2a`
- 当前工作树：`codex/mr01-manual-retry`，HEAD `626142c`，落后 main 314 个提交、领先 0 个
- 分析方式：Better Harness 项目轨 + Agent 配置轨；`origin/main` 近 90 天 561 个提交、124 个 PR、659 次 CI 运行；抽样失败 job 日志
- 约束：没有读其他项目、用户全局 Memory 或历史会话；没有运行全量测试/lint/e2e
- 版本说明：本文是第二版。第一版中的备份方式、测试脚本、E2E 产物路径、分支保护条件、nightly 删除条件、昂贵 CI 触发条件、pre-commit 门禁、多 agent 数据库判断、分支删除条件均已按评审意见修正

> 说明：本文所有“main:行号”均指 `origin/main` 版本。当前工作树落后 314 个提交，直接打开本地文件看到的行号可能不同。

---

## 1. 结论摘要

WorkPal 的 Harness 不缺“机制”：任务卡、验证分层、选择性 CI、worker-chain、证据文化都已存在。当前最大的风险不是“没有规范”，而是**规范、工作树和 CI 三者不一致**：

1. 当前工作树是一个**过期的混合态**：有些本地改动其实 main 已有，有些文件又缺 main 的新代码。
2. CI 只跑显式选中的测试文件，**全量 `pnpm test` 和 `pnpm lint` 都不在 CI**；默认测试命令还把需要数据库的集成测试混在一起。
3. E2E 失败时 CI **不保留 trace/截图/报告**，每次排查都要本地重跑。
4. main **没有分支保护**，红 CI 也能合并。
5. nightly 引用了不存在的 `playwright.yml`，**23 次运行 23 次失败**；但它原本承担的“每日截图/视觉回归”意图需要先迁移，不能直接删。
6. 文档状态与代码矛盾：CI-01 文档说“未合并”，实际早已合入；验证文档说 nightly 会跑，实际它一直坏着。
7. 多 agent 同机开发缺少隔离约定：E2E 固定 3110/5180，Compose 固定项目名和 3100/5173；多个 agent 同时跑会抢端口。数据库默认是隔离的，只有共享 `WORKPAL_E2E_DATABASE_URL` 或共享 Compose 项目时才会踩同一个库。
8. 本机已积累 **95 个 Git worktree、120 个远程分支**；其中 `.qoder` 里有 7 个干净且已合并的 worktree，占 9.9GB。

**正确的执行顺序：**

1. 从最新 `origin/main` 建一个干净 docs worktree，只复制并提交这份文档。
2. 在这份干净副本上修正文档错误；旧脏工作树保持不动。
3. 迁移或修复 nightly 的视觉检查，并上传真实的 Playwright 产物。
4. 用测试 PR 验证 `CI result`，再把它设为必需检查；暂不要求分支始终同步 main。
5. 重新设计测试分类：先建立完整测试清单，再加 `test:unit` 和数据库测试命令。
6. worktree 和远程分支的清理作为独立维护任务，最后单独审计、分批执行。
7. 昂贵 CI 使用“Draft 快速、非 Draft 每个 head 完整验证”，不要只依赖一次性的 `ready_for_review`。

---

## 2. 全机工作区与分支现状

### 2.1 当前工作树

| 项目 | 现状 |
| --- | --- |
| 当前分支 | `codex/mr01-manual-retry` |
| HEAD | `626142c`（2026-10-19） |
| 与 main 的关系 | 落后 314、领先 0 |
| 未提交改动 | 7 个已跟踪文件 + 5 个未跟踪路径 |
| 未跟踪大目录 | `.qoder/`、`apps/grokbot-prototype/`、`docs/roundtable/` |

关键异常：

- 本地未跟踪的 `packages/core/src/roundtable-feature-gates.ts` 及其测试，与 `origin/main` **逐字节一致**（`diff` 0 行）。
- `apps/api/src/env.ts`、`apps/api/src/index.ts` 也与 main 一致。
- 但 `apps/worker/src/index.ts` 本地 568 行、main 635 行，缺少 `memoryOutboxJob`、compaction、`session-admission-reconciler` 等 main 已有代码。
- `packages/core/src/index.ts` 本地 76 行、main 84 行，缺少多个导出。

结论：这不是“干净但旧”的分支，而是“旧 main + 部分新 main”的混合态。在这个树上跑测试或继续开发，结果不可信。

**这份文档当前是旧工作树里的未跟踪文件。** 在清理旧工作树之前，必须先把文档复制到从最新 `origin/main` 创建的干净 worktree。不要先清理旧工作树再建 docs 分支。

### 2.2 `.qoder` 里面是什么

`.qoder` 只有两个子目录：

| 路径 | 大小 | 内容 |
| --- | --- | --- |
| `.qoder/worktrees/` | 9.9GB | 7 个完整仓库副本，每个带一套 `node_modules` |
| `.qoder/repowiki/` | 4.6MB | Qoder 生成的项目知识库，447 个文件 |

7 个 worktree：

- `agent-general-purpose-1e07a423` → `codex/fix-msg-a`
- `agent-general-purpose-3c09e081` → `codex/rt-26-runtime-checkpoint`
- `agent-general-purpose-a3797ad4` → `codex/proto-failure-copy`
- `agent-general-purpose-b79484f0` → `codex/rt-05-private-pair-delivery`
- `fix-127` → `codex/fix-127-answer-resume-parity`
- `rt-05f` → `codex/rt-05f-followup`
- `rt-26f` → `codex/rt-26f-recovery-consistency`

核对结果：7 个 worktree 的 `git status --short` 均为 0 个改动；对应分支都已合入 `origin/main`。因此它们是可以清理的“任务空壳”，但清理应作为独立维护任务，不与本文档的提交耦合。

### 2.3 但全机不止 7 个 worktree

`git worktree list` 显示 **95 个** worktree。除了 `.qoder` 里的 7 个，其余分布在：

- `~/.codex/worktrees/`
- `~/Documents/WorkPal-*`

这些目录里可能有未合并分支或未保存改动，**不能批量删除**。清理前必须逐个检查：

```bash
git worktree list
git -C <path> status --short
git -C <path> branch --show-current
git merge-base --is-ancestor <branch> origin/main
```

### 2.4 远程分支现状

| 项目 | 数量 |
| --- | --- |
| 远程分支（不含 main/HEAD） | 120 |
| 已合入 main | 106 |
| 未合入 main | 14 |
| 当前打开的 PR | 6 |

打开中的 PR 分支（必须保留）：

- `#134 codex/effect01-execution-fence`
- `#100 codex/pd01-message-retry-entry`
- `#48 codex/dep01-deploy-rehearsal`
- `#44 codex/full-suite-zero-failure-closure`
- `#8 docs/harness-v1-complete`
- `#1 workpal-independence-specs`

当前 6 个打开 PR 的 base 都是 `main`（已核对）。但未来如果有 stacked PR，删除已合并分支前还要确认没有打开 PR 把它当 base。

未合并且没有打开 PR 的分支：

- 有已关闭 PR：`ci01-proof-docs`、`ci01-proof-fail`、`ci01-proof-runtime`、`ci01-proof-web`、`ci01-proof-worker`、`codex/ci01-task-card`、`codex/rt-08-public-delegation-ui`
- 没有 PR：`codex/cap01-editor-task`
- 名称异常：`origin`

**这 8 个未合并分支不能因为 PR 已关闭就直接删。** 它们可能含有未保存在其他引用中的提交；删除前要先看 `git log origin/main..origin/<branch>`，必要时打 tag 或归档。

为什么分支不会自动清：仓库设置里 `delete_branch_on_merge = false`。GitHub 支持“合并后自动删除 head 分支”，当前是关闭的。

---

## 3. 核心问题清单

### A. 工作区与多 agent

#### A1｜当前工作树是过期混合态

**严重度：高**

证据：

- `git rev-list --left-right --count origin/main...HEAD` → `314 0`
- 本地 `roundtable-feature-gates.ts` 与 main 逐字节一致
- `apps/worker/src/index.ts` 本地 568 行 vs main 635 行，缺失 main 新代码
- `packages/core/src/index.ts` 本地 76 行 vs main 84 行

影响：

- 测试结果不可信
- 从这里开 PR 会冲突或重复已合并工作
- 容易把“main 已有功能”当成新功能再做一遍

#### A2｜95 个 worktree 没有生命周期管理

**严重度：高**

证据：

- `git worktree list` → 95 个
- `.qoder/worktrees` 7 个，每个 1.6-1.7GB，合计 9.9GB
- 7 个都干净且已合入 main

原因：

- Git 只登记 worktree，不负责删除目录
- Agent 工具默认不自动删，避免丢失未提交改动
- 未发现 Codex/Qoder 的自动清理配置

处理原则：清理是独立维护任务；不要把它当作提交本文档或修复 CI 的前置条件。

#### A3｜多 agent 共享固定端口；数据库默认其实是隔离的

**严重度：高（端口）/ 中（数据库）**

证据：

- E2E harness 默认 `API_PORT=3110`、`WEB_PORT=5180`（main `packages/testkit/src/cli/harness.ts:69-70`）
- Compose 项目名固定 `workpal`（`infra/compose/docker-compose.yml:1`）
- Compose 默认宿主端口 3100/5173（`docker-compose.yml:116-117`、`177-178`）
- 默认 E2E 会为每次运行启动独立 PostgreSQL Testcontainer（`harness.ts:62-64`）
- integration 会为每个 suite 克隆独立数据库（`harness.ts:155-170`）
- integration 模式明确拒绝外部 `WORKPAL_E2E_DATABASE_URL`（`harness.ts:57-59`）

修正后的判断：

- **端口冲突是真的**：两个 agent 同时跑 E2E/Compose 会抢 3110/5180 或 3100/5173。
- **数据库默认不是共享的**：只有显式共享 `WORKPAL_E2E_DATABASE_URL`（E2E 模式）或共享 Compose 项目时，才会踩同一个库。
- 不要用 `export API_PORT=3110+<n>` 这种写法；shell 会把它当字符串，不是算术。应由脚本分配。

#### A4｜没有 Hook 护栏

**严重度：高**

证据：

- `git config core.hooksPath` 是默认 `.git/hooks`
- 仓库没有 `.husky`/`.githooks`，main 上也没有 hook
- `AGENTS.md`（main:10）要求提交前检查 `git status`，但这是纯人工

影响：

- `.env`、大目录、未跟踪原型都靠人记得
- 多 agent 并行时，任何一个 agent 都可能误提交

注意：`core.hooksPath` 是每个 clone 的本地配置；提交 `.githooks` 不会自动启用。Hook 只能提醒，不能作为门禁；同样的检查必须放进 CI。

---

### B. 验证与 CI

#### B1｜全量测试和 lint 不在 CI

**严重度：高**

证据：

- `vitest.config.ts`（main:36-48）include 所有 `*.test.ts`，没有排除 `.integration`/`.postgres`
- 仓库有 42 个 `.postgres.test.ts`，分布在 `apps/api`（2）、`packages/adapters`（15）、`packages/db`（19）、`packages/memory`（1）、`packages/testkit`（5）
- 还有多个 `.integration.test.ts`
- CI 只跑显式文件清单：`ci.yml`（main:110、138、215、218、225）
- CI 中没有任何 `pnpm test`，也没有 Biome/lint 步骤
- `package.json`（main:17、22）定义了 `lint` 和 `test`，但 CI 不用

影响：

- CI 绿只代表“选中的那一小部分”绿
- 大量测试文件没有 CI 线路（具体数量需要先建立完整清单，不要用“约 300”当精确值）
- lint 回归可以静默进入 main

#### B2｜默认测试命令混入数据库测试

**严重度：中**

证据：

- 42 个 Postgres 测试与普通单测共用同一套 include
- `README.md`（main:52-60）推荐的 `pnpm exec vitest run packages/adapters/src apps/api/src apps/web/src` 会带上它们
- `docs/clean-baseline.md`（main:19-20）记录 2026-10-12 全量 `pnpm test` 不绿：7 个断言失败 + 1 个文件无法加载

注意：这是 2026-10-12 的 baseline，**不能证明今天仍然红**。确定的是“全量测试不在 CI”，不确定的是“今天红不红”。

#### B3｜E2E 失败没有可下载证据

**严重度：高**

证据：

- `apps/web/playwright.config.ts`（main:8-12、22-27）生成 HTML report、trace、screenshot、video
- HTML 输出目录是仓库根目录的 `playwright-report/`（`outputFolder: "../../playwright-report"`，相对 `apps/web`）
- trace/截图/视频默认在 `apps/web/test-results/`（Playwright 默认 `test-results` 相对配置文件目录）
- `ci.yml` 只有两处 `upload-artifact`：选择结果 JSON（main:70-74）和 jar（main:189-193）
- 没有上传 `playwright-report/`、`apps/web/test-results/`、`test-report/`

影响：

- 每次 e2e 红都要本地重跑
- flake 判定和修复周期被拉长

#### B4｜失败诊断缺少运行级线索

**严重度：中**

证据：

- `packages/adapters/src/executor.ts`、`apps/api/src/router.ts`、`packages/adapters/src/agentscope-runtime.ts` 中 `logger` 出现次数为 0
- Java 失败只打异常类名和 4 帧；回给客户端固定 “Agent execution failed”（`RuntimeServer.java` main:181-198）

影响：

- 一次失败的 agent run 很难从日志反查到具体模型/工具步骤

---

### C. E2E 稳定性

#### C1｜预算用例是高频 flake

**严重度：高**

证据：

- `budget-acceptance.spec.ts` 的 “routine budget breach” 失败 10 次
- 覆盖 7 个功能分支 + main 两次（2026-10-14 至 10-24）
- 失败断言是等待 delivery Run 进入某个终态；同一测试在其他运行可以通过

处理注意：

- `2fd7569` 已把测试改名为 “queues one delivery behind recovering admission”，并改为断言 `queued`。这是有意的行为调整（RT-25/RT-26 边界），不是单纯弱化断言。
- 但这条 e2e 不再证明“预算超限后摘要实际送达”；该能力目前主要由 `worker-chain` 覆盖。

#### C2｜Execution Card 翻页用例有强 flake 证据

**严重度：高**

证据：

- `execution-card.spec.ts:504` 失败 5 次、`:280` 失败 2 次
- 同一个 PR、同一个 head SHA 的两次 `pull_request` 运行，`web` job 一红一绿（run `39563776713` 失败、`39561488368` 成功）

#### C3｜部分失败是真回归，不是随机抖动

**严重度：中**

证据：

- `golden` 3 次集中在 `codex/ux03-bot-panel`
- `group-chats` 5 次集中在 `codex/rt-22-group-capsule-panel`
- `manual-retry` 5 次集中在 `codex/pd01-message-retry-entry` 等分支
- 这些失败与特定 UI 改动同分支出现，后续提交才修复

#### C4｜worker-chain 不是“经常超时”

**严重度：低（纠正前提）**

证据：

- 659 次 CI 的失败 job 列表中没有 `worker-chain`
- PR #124 上它跑了 13 次，每次 5-6 分钟，全部成功

结论：worker-chain 的问题是“当路径命中时每个提交都跑一遍”，不是“经常失败”。

---

### D. 交付门禁与审查流程

#### D1｜main 没有分支保护

**严重度：高**

证据：

- `gh api repos/<owner>/<repo>/branches/main/protection` → `404 Branch not protected`
- `gh api repos/<owner>/<repo>/rulesets` → `[]`
- 没有 `CODEOWNERS`
- `CI result` 在 `ci.yml`（main:279-310）定义，但不是必需检查

影响：红 CI 可以直接合入 main。

#### D2｜nightly 确定性坏掉，且与每日 CI schedule 重复

**严重度：高**

证据：

- `.github/workflows/nightly-verification.yml`（main:18）`uses: ./.github/workflows/playwright.yml`
- 该文件在 main 不存在
- 23 次定时运行 23 次失败
- `ci.yml`（main:17-18）已有每日 `17 3 * * *` 的 full schedule；最近 5 次 4 成功 1 失败

影响：

- nightly 原本承担的“每日截图/视觉回归”从未执行
- 每天多一条失败告警，真实缺陷和噪音混在一起
- 文档仍声称 nightly 会跑

注意：`ci.yml` 的每日 full 不等于已经覆盖发布截图报告的行为。不能因为 nightly 坏了就直接删，要先确认并迁移它的视觉检查。

#### D3｜审查/CI 的成本在提交轮次，不在 Codex 延迟

**严重度：中**

证据：

- 分析窗口内 124 个 PR：111 合并、8 关闭、5 打开；复核时新增 #134，打开 6 个
- 197 次 review：Codex 覆盖 58 个 PR，人类 32 个；57/111 个已合并 PR 没有 review
- 高轮次 PR：#124 13 个提交 / 29 次 review / 213 job-min；#126 11 / 17 / 98；#131 15 / 11 / 113
- Codex review 样本延迟约 3-12 分钟
- 最后提交到合并只有 9-16 分钟

影响：

- 慢在 13-15 次“提交→CI→review→再提交”的循环
- 每个提交会重跑约 5-6 分钟的 `agentscope` + 5-6 分钟的 `worker-chain`
- 合并尾巴本身不慢

#### D4｜打开的 PR 里有僵尸/卡住状态

**严重度：中**

证据：

- #100 所有检查绿，但 `mergeStateStatus: DIRTY`（有冲突），自 2026-10-21 未合
- #44 是全量测试收口草稿（10-14），没有正文
- #48 是 DEP-01 草稿（10-16），正文写明两个 release blocker
- #8、#1 是 10-07/10-09 的 docs PR，两周以上未动

#### D5｜“done”不等于“已交付”

**严重度：中（项目自述）**

证据：

- `docs/next-work-roadmap.md`（main:3）写明 DEP-01 被产品负责人显式暂停、没有授权生产部署
- 30 行中 25 行 done，但生产基线仍是旧的

这不是 AI 工作流缺陷，但会让人误把 main 绿当成线上可用。

---

### E. 文档与 Agent 规范

#### E1｜文档状态与代码矛盾

**严重度：高**

证据：

- `docs/ci01-selective-checks.md`（main:3）写着 “`in-progress` … **Not merged**. Not deployed.”，但选择性 CI 已在 main：`ci.yml`（main:5-18）就是 CI-01 的实现，提交 `7a6b5c6`（2026-10-19）已合入
- `docs/agent-verification.md`（main:17-21）说 nightly 会跑 web tests，实际 nightly 23/23 失败
- `CONTRIBUTING.md`（main:31-43）仍在教 `apps/mobile`、Electron、`apps/www`；`AGENTS.md`（main:4）明确 Web-only，main 的 `apps/` 只有 api/web/worker
- `vitest.config.ts`（main:41-47）与 `biome.json`（main:21-28）仍引用不存在的 app 目录

#### E2｜AGENTS.md 没有路由到验证入口

**严重度：中**

证据：

- main 的 `AGENTS.md` 只有 12 行
- 没有链接 `docs/agent-verification.md`
- 没有给出任何具体命令
- `CLAUDE.md` 只是 `@AGENTS.md` 转发

影响：Agent 能找到“原则”，找不到“怎么跑”。

#### E3｜原型铁律未入库

**严重度：高**

证据：

- “前端与原型铁律”只在当前工作树的 `AGENTS.md:14-17`
- `origin/main` 的 `AGENTS.md` 只有 12 行
- `.qoder/worktrees` 下 7 份 AGENTS.md 都是 12 行

影响：从 worktree 或干净 clone 启动的 agent 不知道要先做原型、先确认再改生产页面。

#### E4｜任务卡与 PR 没有强制关联

**严重度：中**

证据：

- `docs/tasks` 有 32 张任务卡
- `.github` 下没有 `pull_request_template.md`
- 124 个 PR 的正文是自由格式
- 57/111 个已合并 PR 没有 review

#### E5｜Skill 资产有漂移且没有验证者

**严重度：低**

证据：

- 项目内只有 2 个 Skill：`composio`、`pr-watch`
- `skills-lock.json`（main:8）记录的 `computedHash` 是 `7a41fb…`，实际 `SKILL.md` 的 sha256 是 `48d1fa…`
- `scripts/ci/select-checks.mjs`（main:68）只是把 `skills-lock.json` 当全局路径触发 full，没有校验 hash
- `pr-watch` 没有被 AGENTS.md 或 docs 提及

#### E6｜文档回写是高频手工动作

**严重度：中**

证据：

- 637 个 `docs/` 文件、768 个非测试 TS/TSX 源文件、534 个测试文件
- 近 90 天 105 个纯 docs 提交、19 个纯 docs PR
- `docs/next-work-roadmap.md` 被改 74 次（61 个提交）
- `docs/task-implementation-audit.md` 30 次、`docs/implementation-status.md` 27 次
- 2026-W43 一周内 roadmap 改了 39 次

影响：同一个交付状态至少三处在写，已经出现 CI-01 和 nightly 两处矛盾。

---

## 4. 五个已知痛点的验证结论

### 4.1 Stacked PR、CI、Codex 审查太慢

**结论：前提部分过时。**

- Stacked PR 只占 7/124；117/124 的 base 是 main
- CI-01（`7a6b5c6`）已消除 feature-branch push 的重复运行
- 当前 PR p50 7.9 分钟、p90 16.1 分钟；合并尾巴 9-16 分钟
- 真正慢的是少数复杂 PR 的 13-15 次提交循环，以及每个提交重跑 `agentscope` + `worker-chain`

**可以省掉/合并的：**

- nightly（先迁移视觉检查，再删除）
- 每个提交的昂贵 job（改为 Draft 快速、非 Draft 每个 head 完整验证）
- 逐条修复的 review 轮次（批量修复）
- 不建议省掉 Codex 本身

### 4.2 nightly 连续失败

**结论：确认，且是确定性缺陷。**

- 引用的 `playwright.yml` 在 main 不存在
- 23/23 失败
- `ci.yml` 已有每日 full schedule，但不等于覆盖截图报告

**处理：** 先确认 nightly 原本要保留的视觉检查，迁移到可运行 workflow 并成功跑通一次，再删除坏 workflow；同步 `docs/agent-verification.md`。

### 4.3 Web E2E 不稳定

**结论：确认，但要分开看。**

- 强 flake：`budget-acceptance`、`execution-card`
- 真回归：`golden`、`group-chats`、`manual-retry` 集中在特定分支
- worker-chain：0 失败，只是每个命中提交都跑
- 同 SHA 的 push/PR 结论不同不能单独作为 flake 证据；只有同一个 PR 的两次运行是硬证据

### 4.4 AGENTS.md、规则和 Skills 能不能让 Agent 找到规范、入口和验证命令

**结论：只能找到“规范”，找不到“入口”。**

- AGENTS.md 没有命令、没有链接验证文档
- 原型铁律未提交
- Skill 锁不校验
- `pr-watch` 未被路由

### 4.5 反复需要人工提醒的步骤

**结论：确认。**

- `@codex review` 在 #124/#126/#131 分别被手动触发 13/7/6 次
- 提交前看 `git status`
- 原型确认
- roadmap 回写
- stacked PR 的 base retarget

---

## 5. 处理方案

### P0｜先做，直接影响正确性

#### P0-1 先把文档迁到干净 worktree；清理工作树是独立任务

**目标：** 不丢失文档，也不把旧脏工作树当作清理前置条件。

**步骤：**

1. 从最新 `origin/main` 建一个干净 worktree：
   ```bash
   git worktree add -b docs/harness-review-2026-10-25 \
     ~/Documents/WorkPal-docs-harness-review origin/main
   ```
2. 只复制这份文档：
   ```bash
   cp <old-worktree>/docs/agent-workflow-harness-review-2026-10-25.md \
      ~/Documents/WorkPal-docs-harness-review/docs/
   ```
3. 在干净 worktree 里修正本文档并提交：
   ```bash
   git -C ~/Documents/WorkPal-docs-harness-review add \
     docs/agent-workflow-harness-review-2026-10-25.md
   git -C ~/Documents/WorkPal-docs-harness-review commit \
     -m "docs: add agent workflow harness review"
   ```
4. 旧脏工作树保持不动，直到单独安排清理。
5. 如果确实需要备份旧工作树：
   - 不要只用 `git diff > patch`：它不包含未跟踪文件，也可能漏掉已暂存改动。
   - 复制整个工作树到仓库外（排除 `node_modules`/`.git`），或创建一个临时 archive 分支并提交要保留的文件。
   - 备份前先列出 `git status --short`、`git diff --cached`、`git ls-files --others --exclude-standard`。

**不要做：**

- 不要先把 `apps/grokbot-prototype/` 加进 `.gitignore`。它可能是原型铁律要求保留的确认依据，归属未确认前，忽略它会让重要产物长期游离在版本控制外。
- 不要为了提交文档而先清理 95 个 worktree。清理是独立维护任务。
- 不要 `rm -rf`，用 `git worktree remove`。

**验收：**

- 干净 worktree 中只有这份文档的提交
- 提交基于最新 `origin/main`
- 旧工作树中原有的 tracked 改动没有被迁移过程触碰；只同步更新了未跟踪的文档副本
- 没有删除任何 worktree 或分支

#### P0-2 先建立测试清单，再拆测试命令

**目标：** Agent 能用一条命令跑“该跑的那一层”，不再被数据库依赖拖死。

**先修正事实：**

- `test:integration` 在 `origin/main` 的 `package.json` 中已经存在（main:25），不是待新增命令。
- `scripts/ci/select-checks.mjs` 支持 `--github`、`--format`、`--base`、`--head` 和 `--files`（main:746-750），但**没有 `--local`**。不要写 `node scripts/ci/select-checks.mjs --local`，会直接报 unknown flag。
- Postgres 测试不只在 `packages/db`：42 个文件分布在 `apps/api`（2）、`packages/adapters`（15）、`packages/db`（19）、`packages/memory`（1）、`packages/testkit`（5）。只跑 `packages/db` 会制造“数据库测试已覆盖”的假象。

**步骤：**

1. 先生成完整清单：
   ```bash
   git ls-files '*.postgres.test.ts'
   git ls-files '*.integration.test.ts'
   ```
2. 新增 `vitest.unit.config.ts`，排除：
   - `**/*.integration.test.ts`
   - `**/*.postgres.test.ts`
3. 在 `package.json` 增加：
   ```json
   {
     "scripts": {
       "test:unit": "vitest run --config vitest.unit.config.ts",
       "test:postgres": "node scripts/run-postgres-tests.mjs"
     }
   }
   ```
   `run-postgres-tests.mjs` 用 `git ls-files '*.postgres.test.ts'` 生成完整文件列表，再调用 Vitest；不要只写 `packages/db`。
4. **把 `pnpm test:unit` 接进 CI。** 这是第一版遗漏的逻辑缺口：只说“全量单测不在 CI”，却只加了 lint。
5. 在 CI 增加 `pnpm lint`。如果当前 37 个 Biome 错误无法一次清完，先加 allowlist，再逐步收敛。
6. `verify:affected` 先不要做。如果要做，必须给 `select-checks.mjs` 增加真实的本地模式（含单测），不能把不存在的 `--local` 写进文档。
7. 全量 `pnpm test` 在 baseline 未绿之前不要设为必需检查；可以先放进每日 full job，作为非阻塞报告。

**验收：**

- `pnpm test:unit` 在无数据库、无 JDK 的干净 checkout 上通过
- CI 明确执行 `pnpm test:unit`
- `pnpm test:postgres` 覆盖全部 42 个文件，而不是只有 `packages/db`
- `pnpm lint` 通过或有公开的允许清单
- README 的每条命令都能跑通

#### P0-3 上传 E2E 失败证据

**目标：** 失败不再需要本地重跑才能看 trace。

**步骤：**

在 `ci.yml` 的 `web`、`agentscope`、`worker-chain` job 增加失败时上传：

```yaml
- uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: playwright-${{ github.job }}-${{ github.sha }}
    path: |
      playwright-report/
      apps/web/test-results/
      test-report/
    retention-days: 7
```

路径说明：

- `playwright-report/`：HTML 报告，在仓库根目录。
- `apps/web/test-results/`：trace、截图、视频的默认输出目录。
- `test-report/`：testkit harness 的报告目录。

**验收：**

- 故意让一个 spec 失败，CI 产出可下载的 trace/screenshot
- 能从 `apps/web/test-results/` 拿到失败截图和 trace
- PR 里能看到 artifact 链接

#### P0-4 把 `CI result` 变成必需检查

**目标：** 红 CI 不能合入 main，同时不制造反复 rebase。

**步骤：**

- 要求当前 head SHA 的 `CI result`
- 禁止 force push
- **暂不要求“分支必须与 main 同步”**：这会在 main 更新后触发重复 CI，和降低等待时间的目标冲突
- 如果并发合并经常造成问题，再启用 merge queue，而不是要求所有 PR 手工反复 rebase

**验收：**

- `gh api repos/<owner>/<repo>/branches/main/protection` 显示 required check
- 一个红 `CI result` 的测试 PR 无法合并
- 不要求手工 rebase 才能合并

#### P0-5 迁移 nightly 的视觉检查，再删除坏 workflow

**目标：** 去掉每天一条的无效失败告警，同时不丢掉原本要保留的视觉检查。

**步骤：**

1. 先确认 nightly 原本承担的检查：`playwright.yml` 的 `publish_report: true` 意图是每日截图/发布报告。
2. 在可运行的 workflow 中实现等价检查：
   - 跑 Web 截图/视觉回归
   - 上传 `playwright-report/` 和 `apps/web/test-results/`
   - 至少成功跑通一次，并产出 artifact
3. 替代 workflow 成功后再删除 `nightly-verification.yml`。
4. 如果短期无法实现，先用 `gh workflow disable nightly-verification.yml` 停止噪音；不要直接删掉意图。
5. 更新 `docs/agent-verification.md` 和 `CONTRIBUTING.md`。

**验收：**

- 替代 workflow 至少有一次成功运行，并能下载截图/报告
- 删除/禁用 nightly 后，没有丢失视觉检查
- 不要用 `gh run list` 为空作为验收条件；GitHub 会保留历史运行记录

### P1｜随后做，直接降低周期时间

#### P1-1 降低审查/CI 轮次，但保证每个 head 都被验证

**步骤：**

- Draft 阶段只跑快速检查。
- `ready_for_review` 时跑完整检查。
- PR 已经不是 Draft 后，每次 `synchronize` 都继续跑完整检查。
- 必需检查必须对应当前 head SHA。
- 一次 review 的发现批量修在一个提交里；`@codex review` 每轮只触发一次。
- 纯 docs 回写合并进功能 PR，或每周批量一次。

**为什么不能只在 `ready_for_review` 跑：** PR 转 ready 后再提交新代码，`ready_for_review` 事件不会再次发生；新 head 可能没有 `agentscope` 或 `worker-chain` 结果。

**验收：**

- 每个非 Draft 的 head SHA 都有完整的必需检查
- 中位提交数从 3.9 降到 <2.5
- 高轮次 PR 的 review 次数 <8
- 每个已合并 PR 的 runner-min 下降 30%
- 用“合并后 24h 内同文件修复提交”监控，不能高于当前 141/155 的基线

#### P1-2 pre-commit 只做提醒，CI 才做门禁

**步骤：**

- `.github/pull_request_template.md` 固定字段：
  - 任务卡链接
  - 实际运行的验证命令
  - UI 原型链接/截图
  - roadmap 回写目标
- `.githooks/pre-commit` 检查：
  - `.env`
  - 超过阈值的大文件
  - `.qoder/`、worktree 路径
- `core.hooksPath` 是每个 clone 的本地配置；提交 `.githooks` 不会自动启用。不要在文档里假设它已生效。
- 同样的 `.env`、大文件、禁入路径检查必须放进 CI。
- 1MB 阈值需要资产白名单：正常图片、字体、测试夹具不能被误挡。可以按扩展名/目录设置不同阈值。

**验收：**

- CI 能拦住 `.env` 和大文件
- 正常图片/字体/夹具通过
- 本地 hook 是可选提醒，不是唯一防线

#### P1-3 收敛文档到单一事实源

**步骤：**

- `docs/ci01-selective-checks.md`：状态改为 `done, merged as 7a6b5c6`
- `docs/agent-verification.md`：修正 nightly 表述
- `CONTRIBUTING.md`：删除/归档 mobile/Electron/`apps/www` 段落
- `README.md`：验证命令与真实脚本对齐
- `vitest.config.ts`、`biome.json`：移除不存在的 app 路径
- `skills-lock.json`：重新生成 hash 或删除；加校验消费者
- 给状态文档加 `Status`/`Last verified` 字段

**验收：**

- `rg 'apps/mobile|apps/desktop|apps/www'` 只命中历史归档
- `docs/ci01` 状态与 main 一致
- `skills-lock` hash 匹配
- docs CI 链接检查通过

### P2｜结构性改善

#### P2-1 给失败 run 加运行级可观测性

**步骤：**

- 在 executor 的工具调用、预算、暂停/恢复、失败边界写结构化日志，带 `runId`/`traceId`
- Java 侧保留异常类别和安全的 step 标识，回给客户端的错误仍脱敏

**验收：** 任取一个失败 run，能从 API 日志定位到 Java 的具体 step，不需要重跑 e2e。

#### P2-2 多 agent 隔离：用脚本分配，不靠手工算

**目标：** 多个 agent 同机开发不互相踩。

**先修正判断：**

- 端口冲突是真的：E2E 3110/5180，Compose 3100/5173。
- 数据库默认是隔离的：E2E 每次起 Testcontainer；integration 每个 suite 克隆独立库；integration 拒绝外部 `WORKPAL_E2E_DATABASE_URL`。
- 只有共享 `WORKPAL_E2E_DATABASE_URL`（E2E 模式）或共享 Compose 项目时，才会踩同一个库。
- `export API_PORT=3110+<n>` 不是合法算术；应由脚本分配。

**建议：**

新增 `scripts/agent-env.mjs` 或 `pnpm agent:doctor`，根据任务 slug 自动生成：

```text
COMPOSE_PROJECT_NAME=workpal-<slug>
API_HOST_PORT=<free-port>
WEB_HOST_PORT=<free-port>
API_PORT=<free-port>
WEB_PORT=<free-port>
WORKPAL_E2E_DATABASE_URL=postgresql://.../workpal_e2e_<slug>
```

并检查：

- 端口是否被占用
- Compose 项目名/卷是否冲突
- 数据库名是否唯一
- `git worktree list` 是否有同名分支

**验收：** 两个 worktree 同时跑 e2e 不抢端口；共享数据库时脚本明确报错；冲突时 doctor 给出可执行提示。

#### P2-3 分支清理：先审计，再分批

**步骤：**

1. 打开 GitHub 的 `delete_branch_on_merge`：
   - 仓库 Settings → General → Pull Requests → Automatically delete head branches
2. 删除已合并分支前，确认没有打开 PR 把它当 base（当前 6 个打开 PR 的 base 都是 main，但未来 stacked PR 可能不同）。
3. 未合并但 PR 已关闭的 8 个分支，不要仅凭“PR 已关闭”就删：
   - 先看 `git log origin/main..origin/<branch>` 是否有独有提交
   - 必要时打 tag 或归档
   - 确认无用后再删
4. 保留 6 个打开 PR 的分支。
5. 人工查看 `codex/cap01-editor-task` 和名称异常的 `origin`。

**验收：**

- `delete_branch_on_merge = true`
- 每个保留分支都有负责人、打开的 PR 或明确保留原因
- 不要用“远程分支降到个位数”作为验收目标
- 删除前每个分支都有合并/PR/独有提交的核对记录

---

## 6. 删 / 改 / 留清单

### 删（需逐项确认）

- 106 个已合并、无打开 PR 作为 base 的远程分支（先核对 base）
- 7 个 `.qoder/worktrees` 中干净且已合并的 worktree（独立维护任务）
- `.qoder/repowiki` 可按需删除（可重新生成）
- `apps/grokbot-prototype`：**归属确认前不删、不忽略**

### 改

- `README.md`：验证命令
- `AGENTS.md`：提交 17 行版本，加验证入口链接
- `CONTRIBUTING.md`：删除/归档 mobile/Electron
- `docs/ci01-selective-checks.md`：状态改为已合并
- `docs/agent-verification.md`：修正 nightly 表述
- `vitest.config.ts`、`biome.json`：移除不存在的 app 路径
- `skills-lock.json`：重新生成或删除
- `.gitignore`：增加 `.qoder/`（不要加 `apps/grokbot-prototype/`，直到归属确认）
- `.github/workflows/ci.yml`：加 lint、`test:unit`、失败产物上传
- `.github/workflows/nightly-verification.yml`：迁移视觉检查后再删除/禁用

### 留（暂不动）

- `main`
- 6 个打开 PR 的分支
- 根目录唯一的 `AGENTS.md`
- `CLAUDE.md`
- `docs/tasks` 任务卡
- `apps/grokbot-prototype`：归属确认前保留
- `docs/roundtable`：归属确认前保留
- 另外 88 个未审计的 worktree
- 8 个未合并但 PR 已关闭的分支：审计前保留

---

## 7. 证据附录

### 7.1 工作树与分支

```text
$ git rev-list --left-right --count origin/main...HEAD
314     0

$ du -sh .qoder
9.9G    .qoder

$ git worktree list | wc -l
95

$ git for-each-ref refs/remotes/origin ... # 统计
远程分支（不含 main/HEAD）: 120
已合入 main: 106
未合入 main: 14

$ gh api repos/<owner>/<repo> --jq '.delete_branch_on_merge'
false
```

### 7.2 CI

```text
CI runs: 659
success: 553
failure: 62
cancelled: 44

nightly runs: 23
nightly failures: 23

失败 job 频率（62 次失败运行）:
agentscope 34
web 24
CI result 39（汇总结果）
web-and-backend 3
agent-runtime-image 3
docs 2
backend 2
runtime-jar 1
```

### 7.3 E2E 高频失败

```text
10  budget-acceptance.spec.ts  routine budget breach
 5  execution-card.spec.ts:504  paged-out historical Run
 3  budget-acceptance.spec.ts:114  token budget breach
 3  manual-retry.spec.ts:240  group message secondary-bot cancelled Run
 3  golden.spec.ts:52  takeover, routine, plugins, export
 2  execution-card.spec.ts:280  pending input ask
 5  group-chats.spec.ts:20  create group from +
```

### 7.4 PR 审查轮次

```text
分析窗口内 PR: 124
merged: 111
closed: 8
open: 5（复核时新增 #134，共 6）

reviews: 197
Codex 覆盖 PR: 58
人类覆盖 PR: 32
merged 且 0 review: 57/111

#124: 13 commits / 29 reviews / 213 job-min
#126: 11 commits / 17 reviews / 98 job-min
#131: 15 commits / 11 reviews / 113 job-min
```

### 7.5 关键文件与行号

| 文件 | 行号（main） | 内容 |
| --- | --- | --- |
| `.github/workflows/nightly-verification.yml` | 18 | `uses: ./.github/workflows/playwright.yml`（文件不存在） |
| `.github/workflows/ci.yml` | 5-18 | push 仅 main；每日 schedule |
| `.github/workflows/ci.yml` | 70-74、189-193 | 只上传选择结果和 jar |
| `.github/workflows/ci.yml` | 279-310 | `CI result` 汇总门 |
| `vitest.config.ts` | 36-48 | include 未排除 integration/postgres |
| `package.json` | 17、22、25 | `lint`、`test`、已存在的 `test:integration` |
| `scripts/ci/select-checks.mjs` | 746-750 | 支持 `--github`/`--format`/`--base`/`--head`/`--files`，无 `--local` |
| `apps/web/playwright.config.ts` | 8-12、22-27 | 生成 report/trace/screenshot/video |
| `docs/ci01-selective-checks.md` | 3 | 仍写 “Not merged” |
| `docs/agent-verification.md` | 17-21 | 声称 nightly 覆盖 |
| `CONTRIBUTING.md` | 31-43 | mobile/Electron 指引 |
| `README.md` | 52-60 | 验证命令 |
| `infra/compose/docker-compose.yml` | 1、116-117、177-178 | 固定项目名/端口 |
| `packages/testkit/src/cli/harness.ts` | 57-59、62-64、69-70、155-170 | 外部 DB 限制、Testcontainer、端口、suite 克隆 |
| `skills-lock.json` | 8 | hash 不匹配 |
| `docs/next-work-roadmap.md` | 3 | DEP-01 暂停、未授权部署 |

### 7.6 提交

- `7a6b5c6`：CI-01 选择性 CI（2026-10-19）
- `2fd7569`：budget 测试语义调整（2026-10-24）
- `626142c`：当前工作树 HEAD（2026-10-19）

---

## 8. 修正记录

### 8.1 第一版内部修正

1. **worktree 数量**：初版只说 `.qoder` 里 7 个；实际全机 95 个。`.qoder` 只是其中 7 个。
2. **全量测试状态**：初版容易让人以为“今天全量测试是红的”。确定的是“全量测试不在 CI”；今天是否红未实测，只有 2026-10-12 的 baseline 记录。
3. **同 SHA 的 push/PR 差异**：不能都算 flake；PR 跑的是合并树。只有同一个 PR 的两次运行是硬证据。
4. **worker-chain**：659 次 CI 中 0 次失败；PR #124 上每次 5-6 分钟。问题是“命中路径时每个提交都跑”，不是“经常超时”。
5. **“约 300 个测试没 CI”**：估算，不是逐文件精确值。确定的是覆盖不完整。
6. **“9.9G 会被提交”**：说重了。`node_modules` 多数被忽略，真正的风险是遍历慢、嵌套 worktree 被误加。

### 8.2 评审后修正

1. **P0-1 备份方式不完整**：`git diff > patch` 不包含未跟踪文件，也可能漏掉已暂存改动。更安全的办法是保持当前脏工作树不动，另建干净 worktree，只复制这份文档。清理 95 个 worktree 是独立维护任务，不是后续修复的前置条件。
2. **不应先把 `apps/grokbot-prototype/` 加进 `.gitignore`**：它可能是原型铁律要求保留的确认依据，归属未确认前忽略它会让重要产物长期游离在版本控制外。
3. **`test:integration` 已存在**：`package.json`（main:25）已有，不是待新增命令。
4. **`select-checks.mjs` 没有 `--local`**：文档里的 `verify:affected` 会直接报 unknown flag。已删除该建议；如果要做本地模式，必须单独实现并加测试。
5. **`test:postgres` 只跑 `packages/db` 会漏测**：Postgres 测试还分布在 `apps/api`、`packages/adapters`、`packages/memory`、`packages/testkit`；共 42 个文件。已改为先生成完整清单，再写脚本。
6. **全量单测不在 CI，但方案只加了 lint**：已明确把 `pnpm test:unit` 接进 CI。
7. **E2E 产物路径不完整**：HTML 在根目录 `playwright-report/`，trace/截图/视频在 `apps/web/test-results/`；已修正上传路径。
8. **分支保护不应要求始终同步 main**：会制造反复 rebase 和重复 CI。默认只要求当前 head 的 `CI result`、禁止 force push；并发问题再上 merge queue。
9. **不能因为 nightly 坏了就直接删**：先迁移“每日截图/视觉回归”的意图，替代 workflow 成功跑通一次并产出 artifact，再删除坏 workflow。`gh run list` 为空不是有效验收条件。
10. **只在 `ready_for_review` 跑昂贵任务不安全**：PR 转 ready 后再提交，`ready_for_review` 不会再次触发。已改为 Draft 快速、ready 完整、非 Draft 的每次 `synchronize` 继续完整验证，且必需检查对应当前 head SHA。
11. **pre-commit 不能作为门禁**：`core.hooksPath` 是本地配置，提交 `.githooks` 不会自动启用；同样的检查必须放进 CI。1MB 阈值需要资产白名单。
12. **多 agent 数据库判断过宽**：默认 E2E 用 Testcontainer，integration 每个 suite 克隆独立库，integration 拒绝外部 DB URL；只有共享 `WORKPAL_E2E_DATABASE_URL` 或共享 Compose 项目才会踩同一个库。端口冲突是真的。`export API_PORT=3110+<n>` 不是合法算术，应写脚本。
13. **分支删除条件太激进**：已合并分支还要确认没有打开 PR 把它当 base；未合并但 PR 已关闭的 8 个分支不能仅凭 PR 状态删除，可能含独有提交。验收目标不是“远程分支降到个位数”，而是每个保留分支都有负责人/PR/保留原因。

---

## 9. 仍未覆盖/证据不足

- 没有 Session 证据，无法判断某条规则/Skill 是否被实际使用
- 没有运行全量测试/lint/e2e；今天的状态未知
- CI 日志只抽样；nightly 日志不可用
- E2E flake 的根因未复现
- 生产部署未核验
- branch protection 的仓库外约束不可见
- CodeRabbit 配置未评估
- `apps/grokbot-prototype`、`docs/roundtable` 的归属未确认
- PR 审查质量未逐条评价

---

## 10. 待你决定的事项

1. 干净 docs worktree 放在哪里、是否推送/合并 `docs/harness-review-2026-10-25`？
2. `apps/grokbot-prototype`：提交、移到受控目录，还是删除？
3. `docs/roundtable`：保留本地 59 个文件，还是以 main 的 144 个文件为准？
4. 当前未提交改动：保留、打包成 archive 分支，还是丢弃？
5. nightly：先禁用再迁移，还是直接实现替代 workflow？
6. 是否开启 branch protection，并只要求当前 head 的 `CI result`？
7. 是否先做测试清单和 `test:unit`，再动数据库测试命令？
8. 是否接受“Draft 快速、非 Draft 每个 head 完整验证”的 CI 策略？
9. 95 个 worktree 和 120 个远程分支的审计，什么时候单独安排？
