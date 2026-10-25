# VERIFY-01 补齐取消、排队和群路由验证

状态：`not-started`

## 目标

补齐 2026-10-24 形式化扫描明确没有覆盖的边界。未覆盖不等于存在 bug。本任务先验证，再根据反例创建独立修复任务；没有反例时提交可重复的通过证据。

输入报告为外部 `myagent/docs/WorkPal-formal/SCAN-REPORT.md`，SHA-256 `004950fcdef44df66703112b052e0c70581f3d0b0e07ad82b6e6d95babe97458`。

## 覆盖范围

- 子 Run 树的级联取消，包括 `cancelDescendantsNow`、跨会话 child 和迟到结果。
- `waiting_takeover` 的停止、超时、lease 丢失、steering 和 session admission。
- 一条消息派给多个 Bot 的 multi-dispatch，包括部分失败和去重。
- messaging 与 app steering 分批，以及两条以上追加消息。
- 第一轮扫描留下的「同一 Bot 同一 session 同时跑两轮」疑点。RT-25 已在 `main` 引入 session admission lease，所以必须从当前实现重查，不能照抄旧结论。
- 真实时钟边界：1 秒事件检查、60 秒心跳和 5 分钟 lease 回收。用可控时钟与进程级故障测试补足无时间模型的限制。

## 插话策略

当前产品契约是方案 A：用户先点名 X，X 排队时再点名 Y，X 和 Y 都可以回复。RT-24 已写明「点名新 Agent 不取消当前说话者或后台任务」。这不是 bug。

本任务为方案 A 增加明确测试。除非产品负责人另行批准方案 B，否则不得把第二条消息解释为对 X 的隐式取消。若未来选择 B，必须先补原型中的取消提示与恢复路径，再修改路由代码。

## 验收

1. 每个范围都有模型性质、对应的生产代码路径和至少一个真实 PostgreSQL 或进程级测试。
2. 变异检查证明测试能发现缺失的 fence、错误的级联范围、steering 丢失和重复 dispatch。
3. 方案 A 的测试证明 X 与 Y 的归属独立，且每条消息只有一个负责 Bot。
4. 任一新反例单独记录事实、复现条件、影响和修复边界；不得把「模型可达」写成「生产已发生」。
5. 验证结果回写 RT-19、RT-24、RT-27 和 RT-30 的对应 AC 与场景，不新建第二套状态表。
