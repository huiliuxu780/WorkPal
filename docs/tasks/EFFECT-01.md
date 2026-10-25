# EFFECT-01 外部动作执行权栅栏

状态：`done`

## 目标

在任何不可撤回的外部动作开始前，原子确认发起动作的 Run 仍为 `running`，当前 Worker 仍持有未过期的 Run lease，并且 `leaseFence` 未变化。这个边界同时处理两条尚未实机复现的风险：lease 回收后旧 Worker 重复执行，以及用户停止 Run 后旧 Worker 仍执行一次。

这两条风险来自形式化模型，不是已经复现的生产事故。输入报告为外部 `myagent/docs/WorkPal-formal/SCAN-REPORT.md`，SHA-256 `004950fcdef44df66703112b052e0c70581f3d0b0e07ad82b6e6d95babe97458`。报告基于 `main @ 4571a9e`。2026-10-24 在 `origin/main @ 5a1e551` 复核后，`claimApprovedEffect` 和 `claimIntendedEffect` 仍只检查 ExternalEffect 自身状态，风险前提尚未消失。

## 实施边界

- 先在当前 `main` 上写可控并发测试。测试必须让旧 Worker 在 lease 失效或 Run 取消后到达 effect claim，不能只断言本地 `AbortSignal`。
- 将 ExternalEffect 的状态领取与 Run 所有权检查放进同一数据库原子操作。检查至少包含 `runId`、`status = running`、`leaseOwner`、`leaseFence` 和未过期的 `leaseExpiresAt`。
- effect claim 接口必须接收当前执行身份。禁止继续暴露只收 `effectId` 的生产调用路径。
- `agent.tool.called` 和任何表示「动作已经开始」的持久事件使用同一 execution fence。旧 Worker 不能在丢失执行权后写入可被重试策略信任的工具调用事实。
- 外部供应商调用只能发生在原子领取成功之后。领取失败返回明确的 stale-owner 或 cancelled 结果，不得再次调用供应商。
- 保留现有 `operationId` 和 ExternalEffect 去重语义。这个任务不把参数相似度当作幂等保证，也不扩大凭据或资源权限。
- 不修改前端视觉或交互。

## 验收

1. Worker 1 的 lease 过期，Worker 2 接管并开始新 Attempt 后，Worker 1 的 effect claim 失败。可计数 fixture 只收到一次外部调用。
2. 用户停止 Run 后，即使 post-commit runtime abort 失败，旧 Worker 的 effect claim 仍失败。可计数 fixture 收到零次外部调用。
3. 在 claim 与取消、lease 回收、lease 续期并发时，数据库只允许仍持有执行权的一方推进 effect 到 `executing`。
4. stale Worker 不能写 `agent.tool.called`，也不能让 retry policy 误判「这个 Attempt 已经安全执行过或从未执行过」。
5. 正常 approved 与 intended 两条路径各执行一次；重复 claim 返回已有结果或现有 uncertain 语义，不重复调用。
6. PostgreSQL 并发测试、executor 定向测试、受影响包类型检查和 Worker 链路测试通过。

## 与现有计划的关系

EFFECT-01 是 [RT-19](../roundtable/roundtable-implementation-plan.md#rt-19-收紧取消成员和资源边界) 的前置安全修复，也是 RT-30 的故障验收项。不要等 Roundtable 全部完成后才处理。

## 交付记录（2026-10-25）

已合并：PR [#134](https://github.com/huiliuxu780/WorkPal/pull/134)，merge commit `4705171`，post-merge main CI [run 40172733328](https://github.com/huiliuxu780/WorkPal/actions/runs/40172733328) 全绿。

- 统一入口 `claimExternalEffectForExecution`：Run 行 `FOR UPDATE` → 按数据库当前时间校验 `status`/`leaseOwner`/`leaseFence`/`leaseExpiresAt` → ExternalEffect 行 `FOR UPDATE` → 再次按 `clock_timestamp()` 校验 → 同事务更新 `executing`。Run 行锁是线性化点；取消、回收、续期与 claim 共享该锁序。
- `approved` 与 `intended` 共用上述入口；plan record 工具与 `request_secret` 在 review/secret 暂停期间保持 `intended`，恢复时读取持久化决定。`agent.tool.called` 通过同一执行身份栅栏。
- 验收 1–5 由 22 个真实 PostgreSQL 并发测试覆盖：17 个 claim（含过期 lease、接管后旧 Worker 拒绝、取消、owner/fence 不匹配、effect 归属、双并发恰好一个成功、cancel/reclaim/renew 与 claim 并发、锁等待跨过过期）与 5 个 fenced event 写入；executor 定向测试计数的 provider 调用为：正常 approved 1 次、正常 intended 1 次、stale/过期/取消/接管 0 次、双并发 1 次。
- 验收 6：CI db-postgres 21 files / 228 tests、backend 189 tests、worker-chain、AgentScope（含 plan approval/resume E2E 11/11）与类型检查全绿。
- 边界：未修改前端、权限、feature gate 或生产配置；未部署。
