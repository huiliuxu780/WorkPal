# CARD-01P 对齐并验证 v4 可运行原型

状态：`done`

父任务：[CARD-01 卡片统一与拓展](./CARD-01.md)

## 交付结果

更新 `WorkPal-cards-delivery` 原型包，使产品说明、交互规范、生成脚本、可运行页面和截图全部符合 [CARD-01 卡片统一决策](../cards/CARD-01-decision.md)。把更新后的原型交给产品负责人评审。

本任务不修改 WorkPal 生产代码，也不解除 CARD-01 的实现阻塞。产品负责人确认原型后，才能清理并存入仓库，再拆生产实现任务。

## 先读这些内容

按以下优先级处理冲突：

1. [CARD-01 卡片统一决策](../cards/CARD-01-decision.md)
2. 本任务卡
3. WorkPal 当前设计系统和现有聊天交互
4. 原型包中的旧 PRD、STYLE-SPEC 和页面

原型包根目录名是 `WorkPal-cards-delivery`。不要把本机绝对路径写入文档、页面或交付记录。

开始前计算以下文件的 SHA-256。如果 hash 不一致，停止修改并报告输入已经变化。

| 文件 | 基线 SHA-256 |
| --- | --- |
| `card-requirements.md` | `2ed90642b1543d7487ae83b58add5645dbafeb2ac80167a577a2ea89b3ec2e48` |
| `card-unification.md` | `5a962f2930f4bc8d645493a7d05f4ffcdb94422991f49682517f0923a5863e2b` |
| `card-unification.html` | `2edfc517301116b69a17170cbb7a51601c3f06c5060e009f24eaf75640d82f75` |
| `mockup/cards-hifi-v4/STYLE-SPEC.md` | `40da4e925d67b21d36d01e0bd767390ac2f3e4da74e8dd855be244b110c33024` |

## 修改范围

只修改原型包中的以下内容：

- `card-requirements.md`
- `card-unification.md`
- `card-unification.html` 及其导出图片
- `mockup/cards-hifi-v4/STYLE-SPEC.md`
- `mockup/cards-hifi-v4/` 下的 Python 生成脚本、HTML、CSS、原型所需静态资源和截图

不要修改以下内容：

- WorkPal 的 `apps/`、`packages/`、`services/` 或数据库迁移
- 现有生产页面、路由、协议或测试
- 与卡片无关的导航、聊天布局、头像系统或视觉语言
- CARD-01 决策记录。如果发现决策无法落地，写成阻塞项，不要自行改写决策

## 重新整理协议说明

不要再把所有交互塞入一个带大量可选字段的 `kind: "action"`。用以下四组概念重写 PRD、统一说明和 STYLE-SPEC：

```text
requestInput(question | choice | form | secret | saved_item)
requestApproval(tool | payment | outbound | routine | install | connect)
requestSessionControl(takeover | return)
showContent(markdown | table | chart | collection | media | html | task_status | page | voice)
```

文档可以使用示意类型名，但不能伪造已存在的生产 API。明确标注哪些是 CARD-01 的目标协议，哪些是当前兼容输入。

保留原输入中的 27 个产品场景、7 个详情场景和 4 类提醒场景。不要继续称它们为 27 张动作卡。表情回应属于消息操作，消息内跳转属于 inline reference。语音和 Page 属于展示类型。

## 修正状态和权威来源

所有说明和画面必须同时满足以下规则：

1. Intervention、Run 和 ExternalEffect 分别拥有状态。原型可以合成用户文案，但不能画成一条持久状态机。
2. Run 结束不自动作废所有 Interaction。每个请求按 Intervention 或 ExternalEffect 的生命周期结束。
3. Run 已停止且外部结果不确定时，显示“运行已停止，发送结果未确认”或等价文案。不要显示“已作废”，也不要提供重试。
4. 外部动作结果以 ExternalEffect 或业务事务为准。`agent.tool.completed` 只表示执行活动，不能单独证明付款、发信、安装或 Routine 已完成。
5. 问题和选择必须显示可寻址来源。群聊回复要绑定 Bot，以及 Task 或明确的回复目标。不要依赖孤立的“可以”或“A”。
6. A12 只选择已保存的卡或地址，不直接付款。选择完成后，展示独立的付款审批。
7. A10 在同一卡片中编辑。每次保存形成不可变 revision。发送决定绑定内容 fingerprint。旧 revision 保留审计记录并显示 superseded，但待处理入口只显示最新 pending revision。
8. 安装和授权是两个后端动作。原型可以在同一个 stepper 中展示，但每一步必须有独立状态、失败和审计含义。

## 修正产品和视觉规则

更新所有相关场景，不要只改规范文字：

- 每张互动卡最多显示两个按钮和一个文字入口。详情中的 consequential 动作仍要本人确认。
- 失败、过期和结果未知状态不提供“重试”或“重新发起”。只有读取服务端状态失败时可以显示“重新加载”。“重新加载”不能重新执行动作。
- 终态正文保持可读。删除 `.rej .body`、`.void .body`、`.exp .body`、`.done .body` 等整块 40% opacity 表达。用文字、图标或形状和颜色共同表达状态。
- 窄屏主画面使用 390px。额外验证 375px 时没有横向溢出、按钮截断或遮挡。
- N1 改为轻量 attention queue。它只列当前用户必须处理的 pending Interaction。不要恢复 Task Center、运行历史或完成列表。
- `table` 使用结构化展示场景。Markdown 表格只用于简单静态内容。
- HTML 只用于复杂只读报告。原型文案要明确无同源、无网络、无表单提交、无父页面访问和无顶层跳转。HTML 中不能放副作用控件。
- 分享默认要求登录并限制在 Space 内。公开分享必须单独展示 expiry 和撤销能力。
- 不承诺固定提前 5 分钟提醒。只有可信 `expiresAt` 存在时，提醒策略才可以引用过期时间。
- 通知只画 Web Notification 或仓库已有的 Web Push。不要画原生手机应用。
- 保留现有 WorkPal 视觉语言。不要引入第二套品牌、导航或聊天布局。原型色值要附一份到 `@rakazo/ui-tokens`、`@rakazo/ui-web`、`@rakazo/chat-ui` 和 `apps/web/src/components/ai/` 的语义映射说明，不要声称原型色值就是生产 token。

## 更新可运行原型

以 Python 源文件和 `style.css` 为生成源。不要只手工改生成后的 HTML。

至少更新并重新生成以下页面：

- `index.html`
- `cards.html`
- `a-detail.html`
- `b-alerts.html`
- `c-states.html`

以下核心路径必须能操作，不能只画静态按钮：

1. 从总索引进入四组场景并返回。
2. 打开和关闭详情、面板或弹窗。关闭不等于拒绝或取消。
3. 在 A10 中进入编辑、保存 revision、查看最新 pending revision，并在最终发送前看到准确内容。
4. 从 attention queue 跳回来源 Interaction。处理后，该条目从 queue 消失。
5. 在安装完成后进入独立授权步骤。安装失败和授权失败显示各自状态。
6. 在读取失败场景执行“重新加载”。该操作只刷新展示状态。
7. 使用键盘 Tab 浏览控件，使用 Esc 关闭最上层。不要把 Enter 设为全局 consequential 动作快捷键。

如果原型技术结构无法低成本模拟后端状态，把状态切换实现为本地、确定性的演示控制。不要展示虚假的网络成功提示。

## 生成截图并检查差异

从 `mockup/cards-hifi-v4/` 运行生成脚本。保持生成过程可重复。至少重新生成以下四张验收图：

- `shot-cards.png`
- `shot-a-detail.png`
- `shot-b-alerts.png`
- `shot-c-states.png`

同时更新 `shot-index.png`。截图前先重新生成 HTML。重复运行生成流程后，HTML 和截图之外的源文件不应变化。

使用相同 viewport 把旧图和新图并排检查。记录有意变化和意外变化。修正裁切、错位、错误间距、字体层级、边框、圆角、暗色对比度和窄屏溢出。

## 验收

完成任务前逐项验证：

- 四份说明中不再把万能 `action` 当成最终协议。
- 所有旧开放问题都已被决策替换，没有“待定”“问开发助手”或互相冲突的结论。
- 原型没有把 Run 结束等同于所有 Interaction 作废。
- 原型没有把 `agent.tool.completed` 写成外部动作成功的唯一来源。
- A12 和付款审批是两个连续场景。
- 安装和授权有独立状态。
- A10 的编辑、revision 和最终发送内容一致。
- 失败、过期和结果未知场景没有重试按钮。读取失败只提供重新加载。
- 终态内容可读，整张卡没有 40% opacity。
- 每张互动卡不超过两个按钮和一个文字入口。
- attention queue 不包含运行历史、完成历史或普通后台工作。
- 390px 画面完整。375px 的 `document.documentElement.scrollWidth` 不大于 viewport 宽度。
- 深色模式、键盘焦点和状态表达不只依赖颜色。
- 页面导航和本任务列出的七条核心路径可操作。
- 生成脚本可以从干净的原型包重新产出页面和截图。
- 原型包中没有密钥、真实用户数据、私有 URL 或本机绝对路径。

## 回交内容

交付时提供以下内容：

1. 更新后的完整 `WorkPal-cards-delivery` 原型包。不要只交截图。
2. 一页变更说明，按“决策、改动场景、文件”对应。
3. 旧图和新图的四组并排对比。
4. 生成命令、浏览器和 viewport，以及验收结果。
5. 更新后关键文件的 SHA-256。
6. 尚未解决的问题。不要把缺口写成已经完成。

任务完成的标准是“产品负责人可以检查并批准更新后的原型”。任务完成不代表 CARD-01 可以开始生产实现。

## 完成记录

2026-10-24 完成并通过两轮产品验收。A13 已修正为独立 `PlanReviewView`（`plan_review`），不进入工具授权链；`verify.py` 增至 14 项，其中两项直接检查 A13 的渲染语义和文档兼容映射，独立定向变异可将该断言转红。

批准后的去敏源已入库到 [`docs/cards/source/card-unification-v2`](../cards/source/card-unification-v2/README.md)。入库副本从仓库内重新生成后 HTML 哈希稳定，真实浏览器验收 14/14，390px 与 375px 无横向溢出。已知非阻断项：原接手人的完整 13/14 变异日志未随交付保存，评审侧已用独立定向变异补证。

2026-10-24 后续协议修订：A8 改为 `requestApproval(skill_save)`（TaughtSkill 业务事务），A7 拆分为 `connect.app_authorization` 与 `connect.mcp_assignment`；新增 A7/A8 语义断言并复跑 14/14，定向变异可将 A8 断言转红。原型仍为已批准设计基线。
