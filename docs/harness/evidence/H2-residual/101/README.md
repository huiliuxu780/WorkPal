# H2-101：visual spec 在 ESM 下无法收集

单元：H2-101 ESM 收集修复。分支 `codex/h2-101-esm-visual-collection`，独立 worktree，基线 `origin/main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`（本地 `main` 落后于远端，未用作基线）。
修复提交：`fc7191e`（`fix: resolve the visual spec output dir as ESM under Playwright`）。本目录随其后一个提交纳入。
执行日期：2026-10-28。

环境：macOS arm64；Node v22.23.3（`package.json` engines 允许 `^22.22.2`）；仓库锁定 pnpm；工作树内 `pnpm install --frozen-lockfile` 与 `pnpm --filter @rakazo/db generate` 完成后执行下列命令。E2E 统一走 `pnpm test:e2e` 的 in-process harness：testcontainers PostgreSQL 16（colima）、`--runtime=scripted`、sandbox `fake`，与 CI `web` job 的组合相同。容器 runtime 需要：

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

## 1. 目标缺陷与修复

`apps/web` 是 ESM（`apps/web/package.json` 的 `"type": "module"`）。`execution-card-visuals.spec.ts` 在模块顶层用 `__dirname` 计算截图目录，模块求值在 `test.skip()` 之前完成，于是 Playwright 收集阶段直接抛 `ReferenceError: __dirname is not defined in ES module scope`，整份 spec 收集为 0 个测试。

修复：`dirname(fileURLToPath(import.meta.url))` 得到同一目录，`WORKPAL_CARD_SHOTS` / `WORKPAL_CARD_SHOTS_DIR` 语义未变，默认输出仍是仓库根 `.zcode/tmp/execution-card-shots`。没有硬编码绝对路径，没有移动 `test.skip()`，没有把 spec 排除出匹配集合，没有改页面。

## 2. 先红后绿（同一收集命令）

| 阶段 | 命令 | 退出码 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| red（基线 `a409140`） | `pnpm --filter @rakazo/web exec playwright test execution-card-visuals.spec.ts --list` | 1 | `ReferenceError: __dirname is not defined in ES module scope`，`Total: 0 tests in 0 files` | [red.txt](./red.txt)、[collection-before.txt](./collection-before.txt) |
| green（修复 `fc7191e`） | 同上 | 0 | `Total: 1 test in 1 file` | [collection-after.txt](./collection-after.txt) |
| 模糊匹配（修复后） | `pnpm --filter @rakazo/web exec playwright test execution-card --list` | 0 | `Total: 17 tests in 2 files`（`execution-card.spec.ts` 16 + visual 1），不再出现 0 tests | [collection-fuzzy.txt](./collection-fuzzy.txt) |

红色由目标缺陷引起（ESM 下 `__dirname` 未定义），不是依赖缺失或环境错误：同一 worktree、同一依赖状态，只改了路径来源即转绿。

## 3. gate 语义

| 场景 | 命令（harness） | 退出码 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| gate 关闭（`WORKPAL_CARD_SHOTS` 未设置） | `pnpm test:e2e --runtime=scripted --spec=execution-card-visuals.spec.ts` | 0 | 模块正常加载，`1 skipped`（设计内 skip） | [gate-off.txt](./gate-off.txt) |
| gate 开启 | `WORKPAL_CARD_SHOTS=1 WORKPAL_CARD_SHOTS_DIR=<本目录>/shots pnpm test:e2e --runtime=scripted --spec=execution-card-visuals.spec.ts` | 0 | `1 passed (17.0s)`，生成 33 张 PNG | [gate-on.txt](./gate-on.txt)、[shots/](./shots/) |
| 普通卡片 spec 回归 | `pnpm test:e2e --runtime=scripted --spec=execution-card.spec.ts` | 0 | `16 passed (1.2m)` | [execution-card-16.txt](./execution-card-16.txt) |

截图核对（实际打开检查，不是按文件名推断）：

- `card-completed-390-light.png`：折叠态，“Execution completed / run 2 tracked steps / 4 actions · 237ms / View result”，与 spec 断言的折叠优先顺序一致。
- `card-expanded-1440-dark.png`：深色展开态，含 “Execution progress / Tracked step 0 / Tracked step 1 / Details” 与 “Collapse”，证明深色 token 与展开内容真实渲染。
- `card-waiting-approval-1440-light.png`：审批区含 “Needs your attention / View progress” 与 Allow once / Always allow this tool / Deny。
- 命名覆盖 390/768/1440 × light/dark 的 completed、failed（含 collapsed）、expanded、running、waiting-approval 五类状态，共 33 个文件。

## 4. 观察记录（不属于本单元结论）

- 本机另可用 `WORKPAL_E2E_DATABASE_URL` 指向本地 PostgreSQL 17.11 的一次性库。该路径下 scripted Run 会停在首个工具调用之前（Run 保持 `running`，`run_steps` 为空），`execution-card.spec.ts` 首个用例如出一辙；换成 CI 同款 PostgreSQL 16 容器后全部通过。这是本地环境差异的观察，不是产品缺陷结论，也未用作 red 证据。
- `card-waiting-approval-390-light.png` 中，顶部 “Waiting for approval / write this to the destination crm as a note” 被一个 “Chief · Needs input” 悬浮胶囊压住；1440 同状态无重叠。该现象与本单元改动无关（只改了截图目录解析），需要独立复现和原型对齐后再决定是否属于缺陷，本单元不修改页面。

## 5. 未执行项

- 最终 head 的 CI 结果在推送本分支后产出，链接记录在 PR 与本单元交付说明中；本文件不预写结论。
