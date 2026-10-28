# CARD-01E：无障碍、旧消息回放、视觉回归与总 Gate

状态：`in-progress`（复审发现 Attention 的 total 与严格投影资格不一致：不可投影 pending 行会抬高角标；正在本分支修复并重跑门禁。第二批扩展范围与交付记录见 [CARD-01E delivery](../cards/CARD-01E-delivery.md)）

父任务：[CARD-01 卡片统一与拓展](./CARD-01.md)

依赖：[CARD-01A](./CARD-01A.md)、[CARD-01B](./CARD-01B.md)、[CARD-01C](./CARD-01C.md)、[CARD-01D](./CARD-01D.md)。

## 用户结果

CARD-01 的完整链路通过真实栈验收，旧消息可安全回放，桌面/窄屏/深色/键盘/通知语义一致。只有全部验收通过后，总 feature gate 才可按配置开启；代码默认仍关闭。

## 输入

- [CARD-01 决策](../cards/CARD-01-decision.md)
- [CARD-01P 已完成原型](./CARD-01P.md)
- 已批准原型：[PRD](../cards/source/card-unification-v2/card-requirements.md)、[统一说明](../cards/source/card-unification-v2/card-unification.md)、[STYLE-SPEC](../cards/source/card-unification-v2/mockup/cards-hifi-v4/STYLE-SPEC.md)、[README](../cards/source/card-unification-v2/README.md)
- `group_membership` 视觉基线（Roundtable 已确认原型，不新增 CARD A14）：
  - `docs/roundtable/prototype/index.html?branch=X-GROUP-APPROVE`
  - `docs/roundtable/prototype/index.html?branch=X-GROUP-FAIL`
  - `docs/roundtable/audits/evidence/prototype/branch-X-GROUP-APPROVE.png`
  - `docs/roundtable/audits/evidence/prototype/branch-X-GROUP-FAIL.png`
  - `docs/roundtable/audits/evidence/prototype/narrow-branch-X-GROUP-APPROVE.png`
  - `docs/roundtable/audits/evidence/prototype/narrow-branch-X-GROUP-FAIL.png`
- 全部页面：`index.html`、`cards.html`、`a-detail.html`、`b-alerts.html`、`c-states.html`
- 验收截图：`shot-index.png`、`shot-cards.png`、`shot-a-detail.png`、`shot-b-alerts.png`、`shot-c-states.png`、`shot-mobile-390.png`、`shot-mobile-375.png`、`shot-a13-390.png`、`shot-a13-375.png`

## 范围

- 按批准 PRD 运行全量场景与验收，不以“四个页面能打开”代替语义验收。
- 为 A1–A13、D1–D7、B1–B7 建立功能映射矩阵，标出生产实现对应位置和测试证据。
- 旧消息回放：legacy `ask`、`legacy_<messageId>`、settled 归还气泡、缺失 interventions/executions 的旧快照、旧 `card` 和孤儿 `connect` 的安全降级。
- 检查失败、过期、结果未知状态没有重试；读取失败只有“重新加载”，且动作执行次数为 0。
- 检查 Run 结束不作废 Interaction；`agent.tool.completed` 不被当作外部动作成功的唯一来源；A13 计划审阅始终独立。
- 390px 主验收和 375px 回归：无文档横向溢出、按钮截断、遮挡；深色模式正文可读。
- 键盘：Tab 顺序、焦点可见、Esc 关闭最上层、焦点恢复；Enter 不是全局 consequential 动作。
- 状态不只依赖颜色；终态正文不整卡降透明度。
- 视觉回归：以入库原型的对应场景和截图为基准；记录有意变化与意外变化，修正裁切、错位、间距、字体层级、边框、圆角、暗色对比度。
- 通知：只 Web Notification/Web Push，内容脱敏，终态停止，expiresAt 缺失不承诺提前量；receipt 和 private receipt 不触发通知。
- `collaboration_receipt` 保持业务 MessageBlock；private pair receipt 保持消息 affordance；`task_status` 保持 DisplayBlock；PD-01 Retry 保持消息操作。四者都不得被改造成 InteractionView、Card Shell 成员或 attention 条目。
- `group_membership` 使用 Roundtable X-GROUP-APPROVE / X-GROUP-FAIL 作为最终视觉验收输入；有权限和无权限是互斥分支，不出现第三种视觉，也不退化为通用工具审批。
- CARD-01B 与 CARD-01C 的共享 Shell 区域有唯一 owner 证据：B 的集成 commit 或 C 基于 B 合入后的 main rebase；不存在两个分支并行改同一 block。
- 总 gate：gate 关闭时现有生产路径不变；开启时新路径完整可用。默认配置保持 `false`，是否在生产开启由产品负责人另行决定。

## 允许修改

- 测试、fixture、Playwright e2e、视觉证据脚本和验收记录
- 为修复验收缺陷而修改 CARD-01A–D 已划定的生产文件
- 总 feature gate 的配置接线与测试；不得改默认值来绕过验收
- 文档中的场景映射和证据索引

## 禁止

- 新增未批准的产品行为、卡片类型、导航或移动端实现
- 修改 ExternalEffect 执行权栅栏、权限模型或 Run 状态机
- 删除旧消息兼容或提前移除 `legacy_` 路径
- 用放宽断言、跳过测试或重跑一次绿灯替代失败取证
- 在验收未全绿时开启总 gate

## 验收

- PRD 的 27 个产品场景、7 个详情场景、4 类提醒和全部验收条目有通过证据；未实现项明确失败或禁用，不能模拟成功。
- A10 revision/fingerprint、A12 两步付款、B3 安装/授权、N1 来源与移除、A13 独立计划审阅、只读重新加载均通过。
- `group_membership` 的 X-GROUP-APPROVE / X-GROUP-FAIL 视觉和状态在 390px/375px 下通过；无权限路径没有审批卡。
- `collaboration_receipt`、private pair receipt、`task_status` 和 PD-01 Retry 的归属在最终回归中保持：不进入 attention queue，不使用 Card Shell（private receipt），不改变 ExecutionCard 四信号。
- 旧消息回放、跨线程来源和权限边界通过；无重复可操作卡。
- 390px、375px、深色、键盘和状态非颜色表达通过。
- 生产构建、受影响包类型检查和定向测试通过；e2e 使用真实 Worker/PG 的路径按仓库既有方式运行。
- gate 关闭与开启两种模式都有测试证据；默认保持关闭。
- 生成或采集的截图与原型基准并排检查，证据路径写入任务回交。
- 未解决项和证据限制明确列出，不把缺口写成完成。

## 交付

场景映射矩阵、测试与 e2e 结果、视觉对比、gate 开/关证据、剩余风险和是否满足开启条件。是否开启生产配置由产品负责人决定。
