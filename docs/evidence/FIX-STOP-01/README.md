# FIX-STOP-01 v2 证据索引

单元：FIX-STOP-01（Stop 后释放会话执行权）。日期：2026-10-28。分支：`codex/verify-lifecycle-concurrency`。

现行规则是 **proof-gated v2**：`runtimeStartedAt` 为空时，`cancelled` 终态可直接释放；runtime 已启动时，`run_abort` revocation 消失只证明 DELETE 被 runtime 接收，必须再取得并 ack RT-26 `clean`/`detached` checkpoint proof，才能释放 admission。完整规则与代码事实见 [proof-gated-rule.md](./proof-gated-rule.md)。

## 当前验收入口

| 证据 | 覆盖范围 | 当前结果 |
| --- | --- | --- |
| [v2-red.log](./v2-red.log) / [v2-green.log](./v2-green.log) | 同一 PostgreSQL 回归用例在撤回实现与 v2 上的红绿 | `c53bea1` 两个源文件 + 当前测试：6 红；v2：7/7 绿 |
| [rotation-red-green.txt](./rotation-red-green.txt) | 复审 P2：受限批次中的无 proof owner 不得饿死后续 session | 修复前 1 红/7 绿；修复后 8/8 绿 |
| [guards.txt](./guards.txt) | PG 七个 proof 分支、候选轮转与邻接护栏：stop release、session admission、checkpoint recovery、cancel terminal、effect fence、wait timeout | 6 文件 / 63 测试，exit 0 |
| [postgres-group.txt](./postgres-group.txt) | 当前 v2 的完整 PostgreSQL 组 | 51 文件 / 457 测试，exit 0 |
| [chain.log](./chain.log) | 确定性三栅 worker-chain + AgentScope 产品 E2E | worker-chain 5/5；agentscope-product 6/6，均 exit 0 |
| [checks.txt](./checks.txt) | DB/Worker 类型检查、lint、inventory、CI selector、docs 与链接 | 全部 exit 0 |
| [real-model-v2/README.md](./real-model-v2/README.md) | `SANDBOX_PROVIDER=fake` + 真模型 + 真 Java runtime 的 Stop→proof→后继执行 | proof ack 先于后继 started；4 张截图与脱敏 facts 齐全 |

`worker-chain.spec.ts` 的 gate 3 还记录 worker 日志偏移，并断言 proof 已 ack 后的日志**不含** `could not be proven`；该断言包含在 [chain.log](./chain.log) 的 5/5 结果里。

## 当前证明链

1. Worker 运行时先确认 owner 的 `runtimeStartedAt` 非空，排除“从未进入 runtime”的快速分支。
2. 停 Worker 后调用 Stop：`run_abort` revocation 存在，后继仍 queued，模型夹具未被调用。
3. 通过生产 `deliverRunAborts` 送达 abort：revocation 消失，但 admission 仍 `recovering`、后继仍 queued。
4. 启动 Worker：reconciler 只做分类与重投，现有 `continueRun → recoverSessionOwner → inspectAndDetach → recordCheckpointProof → acknowledgeSessionCheckpoint → releaseRecoveredSessionAdmission` 链产出并 ack proof。
5. proof ack 后后继才执行并进入转录，终态 owner 不再持有 admission；没有手工插入 proof，也没有复制 checkpoint id、watermark、intervention 或 ack 逻辑。
6. 每次选中的 proof recovery owner 会推进 `updatedAt` attempt cursor；拿不到 proof 的最老批次会轮到队尾，不会永久占住 `LIMIT` 并饿死后续可恢复 session。轮转只决定尝试顺序，不降低 proof 门槛。

## 历史资料（不得作为 v2 验收）

以下文件只保留决策与溯源价值，描述的是已经撤回的 v1“revocation 消失即放行”实现，**不得**用来证明当前规则：

- [red.log](./red.log)、[green.log](./green.log)：v1 的 4 红/6 绿。
- [chain-conflict.txt](./chain-conflict.txt)：旧实现与既有进程级契约冲突的调查记录。
- [real-model/README.md](./real-model/README.md)：v1 的真实模型观察。
- [baseline-provenance.txt](./baseline-provenance.txt)：旧 baseline 取证说明。

## 已知边界

- runtime 不可达、旧 binding 无法重新认领、manifest 缺失或 proof 冲突时，会话会继续停在 `recovering`；本卡不以时间或租约过期放行，人工/运维出口另案。
- [real-model-v2](./real-model-v2/README.md) 使用 fake sandbox，证明真模型与真 runtime 的 Stop/proof/admission 链，不证明生产 Docker sandbox；本机 `computer home` 环境故障另见 [real-model-environment-blocker.txt](./real-model-environment-blocker.txt)。
- PR 尚未合入或部署；任务状态是 `ready-to-merge`，不是 `done`。
