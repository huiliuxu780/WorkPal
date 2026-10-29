# FIX-STOP-01 受控真模型验收（fake sandbox + 真模型 + 真 Java runtime）

日期：2026-10-28。分支 `codex/verify-lifecycle-concurrency`，head `1c7ae77` 的工作树。
模型：**DashScope `qwen3.8-flash`，真实调用**（key 由负责人提供，只经环境变量传入，未写入任何文件、提交或日志）。
Runtime：**本分支构建的真实 Java AgentScope runtime**。
沙箱：**`SANDBOX_PROVIDER=fake`**。

> 证据范围声明：本文件证明的是 **Stop → `run_abort` revocation → admission 释放**这条链路在真实模型与真实 Java runtime 下的行为。**它不是完整生产沙箱链路的验证**——生产走 Docker sandbox，本次用 fake provider 绕开了 dev 栈的 `computer home` 故障（该故障单独记录在 [../real-model-environment-blocker.txt](../real-model-environment-blocker.txt)，不在本卡修复）。目标缺陷位于 Stop/abort/admission，不依赖 sandbox 实现，因此这个组合对本卡是有效受控验收；但不得据此声称生产 sandbox 链路通过。

## 场景与结果（一次连续会话）

| # | 事实 | 结果 | 来源 |
| --- | --- | --- | --- |
| 1 | Stop 前处于真实生成状态 | ✅ 观察到 `running`，截图 `02-generating-header.png` / `01-generating-full.png` | 脚本轮询 `threads/get` + 数据库 |
| 2 | Stop 后 Run 为 `cancelled` | ✅ `threads/stop` → `{"ok":true}`；`cmvrkz28p00103fx0ne6ndoxr` → `cancelled`（03:54:37.465 创建、03:54:37.496 开始、03:54:41.28 attempt 结束） | 数据库 |
| 3 | `run_abort` revocation 生命周期 | ⚠️ 见下方"未直接观察到的转换"：本次运行中 abort 在第一次采样前已送达，剩余行数为 **0** | 数据库 + 日志 |
| 4 | 新消息先排队、满足后被放行并由真模型完成 | ✅ 新 Run `cmvrkz5e600163fx0rlx0n4q5`：03:54:41.55 创建 → 41.581 开始 → **completed**（attempt 41.584→42.324）；回答由真模型生成 | 数据库 + 截图 `06/07` |
| 5 | Run/Attempt/admission/revocation 对应记录 | ✅ 见下方四张表 | 数据库 |
| 6 | Stop 后与新消息执行后的顶栏截图 | ✅ `05-after-stop-header.png`、`07-after-new-message-header.png`（另有 full 版） | 截图 |
| 7 | `could not be proven` 负分支 | ✅ 本次 episode 的 worker 日志中该串出现 **0 次**（`grep -ac` = 0），`Agent runtime failure` 也是 0 | `/tmp/dev-stack2.log`（摘要见下） |
| 8 | 脱敏 | ✅ 无 key、无请求头、无连接凭据；DSN/主机路径未写入 | 本目录全部文件 |

## Run 记录（`runs`，按 createdAt）

| id | trigger | status | createdAt | startedAt |
| --- | --- | --- | --- | --- |
| cmvrkyvz1000v3fx0gf5a4fru | created | completed | 03:54:29.341 | 03:54:29.366 |
| cmvrkz28p00103fx0ne6ndoxr | user | **cancelled** | 03:54:37.465 | 03:54:37.496 |
| cmvrkz5e600163fx0rlx0n4q5 | user | **completed** | 03:54:41.550 | 03:54:41.581 |

## Attempt 记录（`attempts`，按 startedAt）

| runId | status | fence | startedAt | finishedAt |
| --- | --- | --- | --- | --- |
| cmvrkyvz1000v3fx0gf5a4fru | completed | 1 | 03:54:29.368 | 03:54:36.730 |
| cmvrkz28p00103fx0ne6ndoxr | **cancelled** | 1 | 03:54:37.499 | 03:54:41.280 |
| cmvrkz5e600163fx0rlx0n4q5 | **completed** | 1 | 03:54:41.584 | 03:54:42.324 |

## Admission（`agent_session_admissions`，该 Bot 一行）

| state | ownerRunId | lastReleaseReason | updatedAt |
| --- | --- | --- | --- |
| **available** | cmvrkz5e600163fx0rlx0n4q5（跟随 Run） | completed | 03:54:42.352 |

没有 `owned`/`recovering` 残留；owner 已被跟随 Run 正常完成并释放。被 Stop 的 Run 不再持有会话。

## Revocation（`execution_revocations`）

本 episode 结束时该 Bot 名下 `run_abort` 行数 = **0**，即 Stop 写入的那一行已被 `deliverRunAborts` 在 `runtime.abort()` 返回后删除。

### 未直接观察到的转换，以及它在哪里被确定性地证明

手测中 abort 在第一次采样前就已完成（fake sandbox + 本机 runtime，Stop 到删除小于一个采样间隔），所以这里只看到"已删除"，**没有**看到"存在 → 删除"的瞬时转换。按负责人要求不靠人工抢时间，这个转换由受控结构证明，而不是手测运气：

- `apps/web/e2e/worker-chain.spec.ts:402` 分支 A：Worker 处于停止状态，断言 `execution_revocations` 中 `run_abort` 行**存在**，且重试保持 `queued`、模型不被调用。
- 同用例分支 B：Worker 启动、其 sweep 删除该行后，断言 admission 被释放、重试离开 `queued`、回复进入转录。
- 持久层同样两分支：`packages/db/src/stop-session-release.postgres.test.ts` 中每个取消场景都先断言"行在 → 仍 park"，再断言"行删 → 同一 tick 放行"。

## 时间线（本次 episode）

```
03:54:29.341  intro Run 创建            → 03:54:29.366 started → 03:54:36.730 completed
03:54:37.465  长文 Run 创建（生成中）
03:54:37.496  started；用户点 Stop
03:54:37.499  attempt 开始（fence 1）
03:54:41.280  attempt 结束 cancelled   ← Run 状态 cancelled
03:54:41.550  跟随 Run 创建（1+1 等于几）
03:54:41.581  started（admission 已放行，无排队等待）
03:54:41.584  attempt 开始
03:54:42.324  attempt completed
03:54:42.352  admission 释放（lastReleaseReason=completed，state=available）
```

从 Stop 到新 Run 取得执行约 4 秒，未出现 5 分钟 lease 等待，也没有 `recovering` 残留。

## 截图

| 文件 | 内容 |
| --- | --- |
| `01-generating-full.png` | 长文生成中的完整页面（1280×900） |
| `02-generating-header.png` | 生成中的顶栏（前 120px） |
| `03-before-stop-header.png` | 点 Stop 前的顶栏 |
| `04-after-stop-full.png` | Stop 后的完整页面 |
| `05-after-stop-header.png` | Stop 后的顶栏 |
| `06-after-new-message-full.png` | 新消息得到回答后的完整页面 |
| `07-after-new-message-header.png` | 新消息执行后的顶栏 |

## 日志断言

本次 `pnpm dev` 日志（`/tmp/dev-stack2.log`，未入库，含本机路径）在该 episode 内：

- `could not be proven`：**0** 次
- `Agent runtime failure`：**0** 次

说明：单次运行的"0 次"是观察，不是"该分支永不出现"的证明；负分支的确定性覆盖见 `worker-chain.spec.ts:402` 分支 A（会话保持 park）与持久层用例。

## 未覆盖

- **生产 Docker sandbox 链路**：本文件用 fake provider，不能替代。真实 Docker 下的 `computer home` 故障记录在 [../real-model-environment-blocker.txt](../real-model-environment-blocker.txt)。
- 顶栏的**自动化断言**（本文件只有截图）：`Shell.tsx` 的 `transcriptRunning`/`composerRunning` 目前没有稳定 `data-testid`，加属性属前端改动，另行处理。
