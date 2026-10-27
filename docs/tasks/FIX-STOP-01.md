# FIX-STOP-01 Stop 后释放会话执行权

状态：`not-started`

- 类型：bug
- 高风险：是（涉及 cancel、session admission 和 `recovering` 证明）
- 原型：不涉及 UI 改动，不需要原型
- 回归测试：[VERIFY-01](./VERIFY-01.md) 覆盖范围里的 S1–S4（测试写好后在本行填上实际测试名与文件路径，不用拟议名代替）
- 关联：RT-25 session admission lease、RT-26 `recovering` 证明、[CANCEL-01](./CANCEL-01.md) / PR [#139](https://github.com/huiliuxu780/WorkPal/pull/139)
- 分支：与 VERIFY-01 同一模块分支可以，但必须分开 commit；不与验证记录混在一个提交里

## 事实（2026-10-27 QA，真模型）

- 产品经理 bot 写 800 字文章，6 秒后点 Stop，Run 变成 `cancelled`。
- 再发「1+1 等于几」，一直停在 Queued，超过 5 分钟也没有恢复。
- 截图：`real/10-before-stop.png`、`real/11-after-stop.png`、`real/12-after-stop-new.png`。

这是已观察到的生产现象，不是模型推演。但归因仍需在修复前用 S1–S4 的红灯确认：同一「停在 Queued」的表象也可能来自工具桥接 401（P0-2），判别规则见 VERIFY-01 覆盖范围最后一项。

## 复现步骤

1. `pnpm dev:app`，配置 DashScope 真模型。
2. 新建私聊，让 bot 写一篇长文章。
3. 生成过程中点 Stop，确认 Run 变成 `cancelled`。
4. 同一会话发一条短问题。
5. 观察：新 Run 一直是 `queued`。查 admission 表，看是否还被已经 `cancelled` 的 Run 占着。

## 影响

用户只要点过一次 Stop，这个会话就永久不能用了，只能新开会话。Stop 是最常用的操作之一，所以定 P0。

## 修复边界

- 只改 cancel 路径和终态释放路径，不动 RT-25 的 lease 模型和 RT-26 对 `suspended` 状态的证明语义。
- owner 已是终态 `cancelled` 本身就是可以释放的证明。不能用「超时了」当证明，这和 RT-26 的「elapsed time is never a proof」原则一致。
- 不靠缩短 lease、加重试或加 sleep 来掩盖问题。

## 完成标准

证据放在 `docs/evidence/FIX-STOP-01/`：

- `red.log`：修复前跑 S1–S4，至少 S1 是红的，带运行命令。红色必须由目标缺陷引起，环境错误不算。
- `green.log`：修复后跑同一组测试，全绿，带运行命令。同一用例、同样有效的断言，不 skip、不放宽、不加 retry。
- `chain.log`：`pnpm test:worker-chain` 和 `pnpm test:e2e --runtime=agentscope --spec=agentscope-product.spec.ts` 都通过。
- 真模型手测截图：Stop 之后发新消息，正常收到回复。
- 回写 RT-25、RT-26 以及 CANCEL-01 / #139 对应的 AC。
- 和 VERIFY-01 的其它范围分开交付：可以在同一个模块分支里，但要分开 commit。

`red.log` 与 `green.log` 必须记录 baseline SHA 与 fix SHA。若红灯实际来自 P0-2（工具桥接 401）而不是本卡的释放缺陷，停止本卡并把事实转给对应归属，不在本卡里修 401。
