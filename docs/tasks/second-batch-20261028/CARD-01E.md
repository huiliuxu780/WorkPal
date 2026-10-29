# CARD-01E：卡片系统产品闭环

状态：`in-progress`

建议分支：`codex/card-system-completion`

交付方式：一个 Coding Agent、一个分支、一个 PR。本文可以直接作为 Coding Agent 的任务提示词。

## 开始条件

从 CARD-01A、CARD-01B、CARD-01C、CARD-01D 和 RT-12 全部合入后的最新 `origin/main` 开始。不要从 CARD-01D 的 PR 分支继续堆提交，也不要在当前旧工作树开发。

开始前记录基线 SHA，并确认工作树干净。阅读以下现行输入：

- `docs/tasks/CARD-01E.md`
- `docs/cards/CARD-01-decision.md`
- `docs/cards/source/card-unification-v2/`
- `docs/cards/CARD-01-implementation-inventory.md`
- CARD-01A 至 CARD-01D 的交付记录和证据索引

批准原型是视觉和交互边界。不要重新设计页面。

## 交付结果

交付一套可以真实使用的卡片系统。

真实业务请求必须生成严格的卡片投影。用户可以在聊天中查看并处理请求。Attention 和 Web 通知反映同一业务状态。用户刷新页面、加载旧消息或返回来源后，看到的状态仍然一致。不可用的能力必须明确禁用，不能用 fixture 或模拟成功代替生产能力。

本任务不是一次只读验收。Coding Agent 要修完在完整产品流程中发现的 CARD-01 缺陷，并把卡片系统作为一个模块交付。

## 产品范围

完成以下完整流程：

- 已批准的 Input、Action Approval、Plan Review 和 Session Control 从真实生产入口产生，并使用统一 Card Shell 展示。
- DisplayBlock、详情视图和安全 HTML 正常展示只读结果。HTML 不能获得网络、表单提交、父页面访问或顶层跳转能力。
- 用户处理卡片后，权威业务事务、消息卡片、Attention、通知和历史状态一致。刷新和重连不能让已处理请求重新出现。
- Attention 只显示当前用户仍需处理的请求。普通 Run、完成历史、后台工作、receipt、private pair receipt、`task_status` 和 PD-01 Retry 不进入 Attention。
- Web 通知只覆盖需要本人处理的新请求。通知使用固定脱敏文案，终态停止，点击后只导航到来源。
- 旧消息和缺字段快照安全回放。旧 `card` 和 `connect` 保持只读兼容，不再产生新的旧格式数据。
- 桌面、390px、375px、深色模式和键盘操作保持批准原型的结构与视觉语言。
- `cards_unified_v2` 关闭时保留旧生产行为。开启时使用完整新路径。默认值保持 `false`。

## 完成真实生产入口

先运行当前产品，再对照批准场景检查真实 producer、严格投影、业务事务和 Web renderer。把检查结果当作开发导航，不要把盘点报告当成交付物。

如果批准场景已有生产业务和权限语义，接通真实 producer 并完成整条链路。重点核对连接授权、MCP assignment、技能保存、计划审阅、群成员审批、输入请求和 session control。

如果场景没有批准的业务入口或权限语义，保留明确的不可用状态。不要为了让场景矩阵全绿而新增虚构 producer。把该限制写入最终任务回交，但继续完成同模块的其他场景。

保留以下产品边界：

- Plan Review 不是工具授权。
- `group_membership` 使用已确认的 Roundtable approve 和 fail 分支，不退化为通用工具卡。
- `collaboration_receipt` 仍是 MessageBlock。
- private pair receipt 仍是消息 affordance。
- `task_status` 仍是 DisplayBlock。
- PD-01 Retry 仍是消息操作。
- Run 完成不能自动作废仍待用户处理的 Interaction。
- ExternalEffect 结果未知时不能显示成功。

## 修正 Attention 的规模边界

CARD-01D 已经暴露两个不能同时忽略的要求：分页结果不能在 500 条后静默截断，读取请求也不能把所有 pending 候选无限加载到进程内存。

在本任务中完成产品级查询方案。方案必须满足以下结果：

- 分页稳定，游标前后的条目不重复、不丢失。
- `total` 的语义明确，不能在超过内部上限后静默少算。
- 查询成本有可说明的上限，或使用持久化 Attention 投影避免每次重新扫描全部派生来源。
- 权限、归档和结算变化能让条目及时退出。
- 不读取普通 Run 历史来计算 Attention。

Coding Agent 可以选择数据库级多来源分页、持久化读模型或等价设计。不要用事务 timeout 代替数据规模边界，也不要恢复固定 500 条静默截断。

## 修改边界

可以修改以下区域：

- CARD-01 的 contracts、投影、数据库查询和 API
- CARD-01 使用的 Web renderer、Attention、通知和 feature gate
- 已批准生产入口的 producer 接线
- 旧消息适配器
- 卡片单测、PostgreSQL 测试、Playwright E2E 和运行证据
- CARD-01 任务状态、场景说明和证据索引

不要修改以下区域：

- ExternalEffect 的执行权和幂等规则
- Run、Attempt、lease、fence 或 session admission 状态机
- AgentScope Runtime
- 未批准的页面、导航和移动端功能
- `@我` 功能
- Task Center
- feature gate 的生产配置

如果真实缺陷来自上述底层状态机，记录可复现事实并通知整合者。继续完成不依赖该缺陷的卡片工作，不要在本 PR 中重写底层执行模型。

## 本地完成标准

Coding Agent 必须在本地完成整个模块后再提 PR。

至少完成以下工作：

1. 启动真实 Web、API、PostgreSQL 和 Worker，走完有输入、审批、计划、群成员审批、Attention 和通知的产品流程。需要 AgentScope 的 producer 使用真实 Java Runtime；确定性 UI 场景可以使用仓库的 scripted runtime。
2. 运行最终 diff 对应的所有本地 CI 选择项。运行 CARD contracts、数据库、API、Web 和 E2E 的完整相关套件。
3. 运行 gate 关闭和 gate 开启两种模式。完整 E2E 必须实际收集并执行卡片 spec，不能在 gate-off 批次中被跳过。
4. 运行生产 Web build，检查桌面、390px、375px、深色和键盘流程。
5. 对本任务修复的缺陷保留同一个回归用例的修复前失败和修复后通过结果。

使用仓库当前 `package.json` 和 CI 选择器确定命令。开工时不要照抄旧分支的测试数量。最终至少应覆盖这些仓库入口：

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint
pnpm check
pnpm test:unit
pnpm test:postgres
pnpm test:inventory
pnpm test:ci-select
pnpm test:docs
pnpm --filter @rakazo/web build
pnpm test:e2e --runtime=scripted --spec="card-ui-interactions.spec.ts|card-display-content.spec.ts|card-attention.spec.ts|group-membership.spec.ts|message-group.spec.ts"
```

如果最终 diff 让 CI 选择 `agentscope`、`worker-chain`、`backend` 或其他 job，也在本地运行对应入口。环境失败不算产品通过。

## 回交内容

Coding Agent 回交以下内容：

- 分支名和最终 commit
- 用户现在可以完成的完整卡片流程
- 关键架构选择，特别是 Attention 的查询方案
- 本地运行命令和结果
- 实际页面截图与真实请求、数据库或 Runtime 事实
- 未实现能力及其明确禁用方式
- 最终 diff 中没有密钥、真实用户数据、私有 URL 或本机路径的确认

不要在本地全绿前提 PR。PR 建立后，CI 和 review 发现的问题继续在本分支修复。Reviewer 确认最终 head 后才能建议合并。生产 gate 是否开启不属于本任务。

