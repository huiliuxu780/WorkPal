# FIX-STOP-01 受控真模型验收 v2（proof gate 生效）

日期 2026-10-28。分支 `codex/verify-lifecycle-concurrency`，head `9ed442b` 的工作树。

模型：**DashScope `qwen3.8-flash`，真实调用**（key 只经环境变量传入，未写入任何文件、提交或日志）。
Runtime：**本分支构建的真实 Java AgentScope runtime**。沙箱：**`SANDBOX_PROVIDER=fake`**。

> 范围声明：本文件证明的是 **Stop → `run_abort` revocation → RT-26 detach proof → admission 释放** 这条链路在真实模型与真实 runtime 下的行为。**不是**生产 Docker sandbox 链路的验证；Docker 下的 `computer home` 故障另记在 [../real-model-environment-blocker.txt](../real-model-environment-blocker.txt)，与本卡无关。

## 一次连续会话的完整事实

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | Stop 前处于真实生成状态 | 观察到 `running`；截图 `01-generating-header.png` |
| 2 | **runtime 已启动**（不是"从未启动"快速分支） | Run `cmvrpo564…` 的 admission `runtimeStartedAt = 06:06:06.239Z` |
| 3 | Stop 后 Run 为 `cancelled` | `06:06:06.124` 创建、`06:06:06.154` 开始、attempt `06:06:06.156 → 06:06:09.938`；截图 `02-after-stop-header.png` |
| 4 | 新消息**先排队** | `cmvrpo8ci…` `06:06:10.242` 创建即 `queued`（`sawQueued: true`），一直排到 proof 落定 |
| 5 | **只有 proof 被 ack 之后才放行** | checkpoint `proofKind=clean`、`status=recorded`、`ackedAt=06:06:17.772Z`；紧随其后 `06:06:17.801` 该 Run 才开始（attempt fence **2**，即释放后重建的执行） |
| 6 | 由真模型完成 | 同一 Run `06:06:18.631` `completed`；截图 `03/04` |
| 7 | admission 最终状态 | `available`，`ownerRunId` 是跟随 Run，`lastReleaseReason=completed`，无 `owned`/`recovering` 残留 |
| 8 | revocation | 该 Bot 名下 `run_abort` 行数 **0**（Stop 写入、abort 送达后删除） |

时间线（UTC）：

```
06:05:56.092  intro Run 创建 → 06:05:56.158 attempt 开始 → 06:06:05.931 completed
06:06:06.124  长文 Run 创建（生成中，runtime 已于 .239 启动）
06:06:06.154  started；用户点 Stop
06:06:09.938  attempt cancelled（Run = cancelled）
06:06:10.242  跟随 Run 创建 → queued        ← 从这里开始被 proof gate 挡住
06:06:17.772  checkpoint clean/recorded 被 ack ← RT-26 链产出并确认证明
06:06:17.801  跟随 Run started（fence 2）
06:06:18.631  跟随 Run completed（真模型回答）
```

排队时长约 **7.5 秒**，恰好等于"等 proof"的时间；不是超时触发的放行。

## 截图（1280×900，顶栏裁切）

| 文件 | 内容 |
| --- | --- |
| `01-generating-header.png` | 生成中的顶栏（Stop 前） |
| `02-after-stop-header.png` | Stop 之后的顶栏 |
| `03-after-followup-full.png` | 跟随消息完成后的完整页面 |
| `04-after-followup-header.png` | 跟随消息完成后的顶栏 |

## 机器可读事实

`facts.json` 含 runs / attempts / admissions / revocations / checkpoints 与逐事件时间线。凭据、请求头、DSN 与主机路径均未写入。

## 与 v1 证据的关系

`../real-model/` 与 `../chain.log` 对应**被撤回**的 v1 实现（"revocation 消失即释放"），**不能**作为本规则的证据；本文件与 `../proof-gated-rule.md` 才是。

## 未覆盖

- 生产 Docker sandbox 链路（见上）。
- 顶栏的自动化断言：本文件只有截图；`Shell.tsx` 的 `transcriptRunning`/`composerRunning` 目前没有稳定 `data-testid`，加属性属前端改动，另行处理。
- 极端情况下 runtime 拿不出 proof（runtime 不可达、旧 binding 无法重新认领、manifest 缺失、proof 冲突）时会停在 `recovering`，需要一个单独的人工/运维出口；本卡不提供时间兜底。
