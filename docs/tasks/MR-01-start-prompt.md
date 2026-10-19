# MR-01 开工提示词

你负责交付 WorkPal 的 MR-01 手动重试功能。目标是用户在任务中心或失败执行卡点击“重试”，在原 Task、原 Thread 中创建新 Run，由真实 Worker 执行并显示结果；旧记录可回看，已完成的相同外部操作复用真实结果。

按 docs/tasks/MR-01.md 完整交付，不止写方案、API 或 UI。可与另一条 AG-03→AG-04 分支并行，不需等待其完成。

## 必读与预检

1. AGENTS.md、docs/tasks/MR-01.md、docs/next-work-roadmap.md。
2. packages/db/src/retry-runs.ts：明确自动同 Run Attempt retry 与本任务的区别。
3. runs RPC/router、Task/Run/ExternalEffect schema、Run 创建与入队、executor effect key/replay、Worker lease、Thread generation。
4. UX-01 决策及当前 ExecutionCard/TaskCenterView，沿用其进度和 surface 规则。

更新 main 并记录 SHA。制定任务时 #61/#62/#63 已合并，main=dcc73c5。创建 codex/mr01-manual-retry；任务文档若未合入，只带入相应 docs 提交并记录 ancestry。

## 实施顺序

1. 先核实真实代码，在 docs/mr01-manual-retry.md 建产品状态表、输入重建路径与 effect 匹配规则；随后直接实施，不把预检变成等待审批的独立阶段。
2. 完成 lineage、nonce/唯一后继、Run 创建事务、事件、RPC 与真实 jobs 入队。
3. 完成原任务输入恢复、当前配置加载、已完成操作复用和未知结果处理。不能把存在 effect 的任务全部拒绝，也不能新 Run 换 key 后无条件重发旧操作。
4. 接入对话失败卡和 Task Center 两个 UI 入口，包含提交中、业务原因、旧记录/后继导航和真实进度结果。
5. 补 PostgreSQL 旅程及本地可计数外部 fixture，证明原操作不重发；补两个 UI 入口 E2E 和 Worker 停止→queued→启动领取。
6. 运行任务书全部相关门禁，交付 14 条验收证据矩阵、迁移记录和测试命令/结果。

## 必须实现的产品语义

- failed/cancelled root Run；同 Task、新 Run、同 Thread；旧记录保留。
- routine 只重试本次任务，schedule 不变；群聊/外部任务保持入口和所有权语义。
- 重发请求返回相同 Run；同一来源的并发请求只产生一个直接后继。
- 已确认完成的同一操作复用；参数/目标/occurrence 不同走新操作；未知结果走实际核实或针对该操作的用户处理。
- 当前权限、预算和配置用于本次执行，旧批准不等于新操作批准。
- Thread 已清空或失去访问权时不复活旧工作；运行中/等待中继续使用现有交互。
- cancelled 且本来无 Execution shell 的任务通过 Task Center 重试，不改变 UX-01 surface 规则。

## 并行接线与交付

- 自持 manual-retry 模块、contract、DB、RPC 和 UI；executor 只做必要接线，便于 AG-04 提取提示文字。
- 新增重试提示以独立 renderer/文本文件提供并测试实际模型请求；与 AG-04 最终合用一个提示词加载方式，不各造加载器。
- 按真实影响运行 check/测试。不要反复跑无关的长租约场景；涉及执行语义和外部效果的关键测试必须经过真实 DB/executor。
- 新文案走 Lingui；PR 描述写清最终产品行为、迁移、验证与实际限制。
- 推送并创建 base=main 的独立 PR，更新任务卡/roadmap 为 delivered, ready-to-merge。未经用户批准不合并、不部署。
- 提交前检查 status 和完整 diff，显式 add 文件；不提交 .env、凭据、真实用户数据、私有 URL 或本机身份。

遇到确实无法实现的具体规则，报告具体复现、技术证据、影响和可实施选择，继续推进不依赖该问题的部分；不得悄悄删验收、返回模拟成功或以整套框架重建代替本需求。

最终报告：分支/base/head/PR、14 条验收证据、已完成/未知效果处理、迁移、单测/PG/Worker/E2E 数量与结果、AG-04 交叉点、剩余项，明确未合并、未部署。
