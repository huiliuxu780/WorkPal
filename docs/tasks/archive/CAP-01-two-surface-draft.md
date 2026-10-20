# CAP-01 v2（不完整草案）— 操作确认与已保存选择

本草案把产品错误收缩成“确认卡 + 已保存选择”两个界面，没有完整覆盖用户查看 Bot 能力、事前表达偏好和事后追溯的任务，已被后续完整 CAP-01 取代。仅作设计迭代记录，不再是实施依据。当前任务见 [CAP-01.md](../CAP-01.md)。

原状态：`in-progress`。Draft PR [#81](https://github.com/huiliuxu780/WorkPal/pull/81) 必须按本任务重做；旧的低层规则编辑器、catalog、preview 与整份 policy 草稿不再是产品方向。旧任务完整保存在 [CAP-01-low-level-editor.md](./CAP-01-low-level-editor.md)，仅作历史与取证。基线 `main @ 472f0b1`，未部署。

## 1. 设计北极星

**用户在 Bot 真要执行一个有后果的动作时，看懂它将做什么并当场决定；只有用户主动选择“始终允许”时，系统才记住这类选择。**

用户不需要预先维护权限表，也不需要理解工具、连接器、scope、glob、优先级、环境、规则版本或内部安全检查。

这项功能的用户任务是：

> 当 Bot 准备替我对外发送、修改、删除、发布或执行其他会产生实际影响的动作时，让我看清对象和影响，决定这一次是否执行；如果我信任这个 Bot 以后做同类动作，可以直接记住我的选择。

“发邮件、付款、操作文档”只是帮助理解的例子，不是产品预设的三类权限，也不要求本任务创造仓库里不存在的支付或文档能力。界面内容必须来自实际到达执行边界的动作。

## 2. 参考产品与采用原则

参考 Grok Bot 的两层交互：

1. 动作发生时，对话里展示操作及关键输入，提供 `Allow once / Always allow / Deny`。
2. 设置里只管理已经保存的选择，不把底层执行规则变成普通用户的配置表。

来源：

- [Grok Bot approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)：审批卡展示操作和输入；一次允许、始终允许、拒绝。
- [Grok Bot settings](https://cursor.com/docs/grok-bot/settings)：审批偏好在设置中管理；Bot 自身设置保持精简。

借鉴的是“在动作发生处决策、设置页负责管理已保存选择”的产品结构。WorkPal 不照抄 Grok 的企业管理页面，也不向普通用户展示内部规则语言。

## 3. 产品结构

CAP-01 只有两个用户界面：

### 3.1 对话中的操作确认卡

卡片必须回答三个问题：

- Bot 要做什么？
- 会影响谁或什么？
- 执行后会发生什么？

卡片结构：

1. 标题：`<Bot 名称> 想要 <动作>`，动作使用业务语言。
2. 关键内容：用 2–4 行展示用户判断所需的对象和值。长正文提供折叠的“查看完整内容”。
3. 操作使用当前动作的动词，不显示抽象权限词：
   - 主按钮，例如 `发送这封邮件`：只批准当前持久化 effect，语义是仅这一次。
   - 长期按钮，例如 `以后直接发送`：仅在后端能够生成稳定、可解释的同类动作范围时出现；其辅助文字必须说清记住的范围，例如“以后 Alice 使用 Gmail 发送邮件时不再询问”。点击后立即批准当前动作并保存该选择，不再弹第二个配置表单。
   - 拒绝按钮，例如 `不发送`：拒绝当前动作，不保存长期选择。
4. 结果：分别显示“已允许一次”“已允许并记住”“已拒绝”“已过期”以及 effect 的真实执行结果。批准不等于执行完成。

卡片不能出现原始工具名、JSON、资源表达式、策略来源、规则优先级或模型判断过程。必要的技术明细只能放在已有工程日志和审计记录里。

当后端无法可靠描述“始终允许”的范围时，卡片只提供 `仅这一次 / 拒绝`。这不是错误状态，也不需要用户补填任何字段。

### 3.2 设置中的「已保存的操作」

入口放在现有账户设置的「操作确认」位置，不在每个 Bot 详情里新增权限编辑器。

页面只展示用户曾在确认卡上选择“始终允许”的项目，按 Bot 分组：

- Bot 头像和名称；
- 人类可读的动作标题；
- 可选的应用或账户说明；
- 保存时间；
- `移除`。

移除后，下次命中该动作时恢复为正常审批流程。没有“新增规则”“编辑表达式”“测试规则”“高级模式”“内置默认”或总开关。

空状态：`你还没有让任何 Bot 跳过确认。以后在操作确认中选择“以后直接执行”，它会出现在这里。`

旧的账户级选择若已存在，继续生效并显示在“以前保存的选择”分组中；用户可以移除。不得把旧的 Space 范围静默改成某个 Bot 的范围。

## 4. 明确不做

- 不做能力目录、权限矩阵、三态表格、规则编辑器或策略试算器。
- 不让用户新增或编辑 capability/resource/scope/glob/环境前缀。
- 不展示内置安全规则、Auto Review 模型、checker 可用性或规则冲突解释。
- 不建设 policyRev/CAS 差异工作台、跨 Bot 草稿守卫或整份策略保存流程。
- 不把示例动作冻结成固定分类，不靠工具名正则假装覆盖一个业务动作。
- 不创造支付、邮件、文档或浏览器能力；只呈现产品实际执行的动作。
- 不改变 `Bot.capabilityRules` 的内部强制边界，也不允许用户选择绕过服务端鉴权、资源权限或强制审批。

## 5. 前端任务

### F1. 重做审批卡表达

在现有 `AskCard` / `InterventionRegion` 链路上扩展，不新建第二套审批组件：

- 使用服务端持久化的展示快照渲染标题、关键字段、完整内容和长期选择文案。
- `always` 的按钮文案从“Always allow this tool”改成用户能理解的范围；没有长期选择提案时不渲染该按钮。
- 三个动作在 pending、提交中、accepted、already_handled、expired 下保持一致；重复点击不得产生第二次执行。
- 继续让审批卡位于执行卡折叠体外，Task Center 回焦行为不变。

### F2. 重做设置页

改造现有 `ApprovalRulesSettings`：

- 删除“发邮件”“付款”等预置按钮和 `Flag unexpected actions` 开关。
- 展示后端返回的已保存选择，按 Bot 分组；只提供移除。
- 加载失败可重试；移除失败保留该行并显示就地错误；成功后该行退出，刷新后结果一致。
- 沿用 `@rakazo/ui-tokens`、`@rakazo/ui-web`、`@rakazo/chat-ui` 与现有账户设置布局。

### F3. 删除旧 #81 界面

从 Draft #81 移除：

- `BotPermissionsSection` 及 capability 编辑表单；
- catalog/advanced input/preview/冲突差异/整份草稿保存；
- Shell 级未保存草稿与切 Bot 守卫；
- 为旧界面新增的翻译、E2E 与专用状态工具。

恢复 roster 跨 Space 导航原有 `openSpaceChat` 路径。不能为了已撤销的草稿守卫继续截获所有 Bot 点击。

## 6. 后端任务

### B1. 一个权威审批系统

继续使用现有 `ActionApprovalRule`、`ExternalEffect`、Intervention 与 executor 审批链路。不要保留 #81 的 `bots.capabilityPolicy.get/update/preview` 作为另一套用户设置 API，也不要新增并行的“简单权限”表。

`ActionApprovalRule` 仍是唯一已保存选择来源。为新卡片补齐下列内部数据：

- 可空 `botId`：新保存的选择默认绑定当前 Bot；旧记录保持 `null`，继续表示原账户/Space 范围。
- 稳定的 `actionKey`：由受信任的工具/连接器适配层给出，用于匹配同类动作；不是模型生成的文字。
- 持久化的人类可读展示快照：动作标题、应用/账户说明和范围说明。不得保存凭据、完整正文、附件内容或其他动作参数作为设置页标题。
- 可选来源 effect ID，用于审计“这条选择从哪次确认产生”。

可以演进现有表和唯一约束；不要新建第二个用户偏好表。现有 `matchKind/matchValue` 的兼容读取在迁移期保留，执行器最终必须只有一条解析路径。

### B2. 动作展示与长期选择提案

在工具进入审批边界前，由受信任的适配器生成一个严格的展示对象：

```ts
type ApprovalActionPresentation = {
  title: string;
  fields: Array<{ label: string; value: string }>;
  detail?: string;
  remember?: {
    actionKey: string;
    title: string;
    scopeLabel: string;
  };
};
```

约束：

- `title/fields/detail` 是当前动作的审阅内容，随 Intervention 展示快照持久化。
- `remember` 只由工具注册信息和已验证的连接器身份生成。模型不能自行提供 `actionKey` 或扩大范围。
- 没有 `remember` 时仍可正常一次批准/拒绝。
- catalog 包装工具必须先解析到真实执行身份，再生成 actionKey；不能把 `__catalog_execute` 当成用户选择的动作。
- connector 和直接工具若最终执行的是同一个注册动作，使用同一 actionKey；不同资源、账户或具有不同实际效果的操作不得误合并。

首批实现只覆盖仓库中能够通过真实执行链验证的动作。新增动作以后通过工具注册元数据接入，不修改设置页结构。

### B3. API

保留 `threads.resolveIntervention` 作为批准入口。前端仍只提交 intervention、幂等 submission ID 与用户选择；长期规则内容从服务器端已持久化的 `remember` 提案生成，客户端不能伪造 actionKey 或 scope。

设置页 API 收敛为：

```ts
actionPreferences.list(): {
  bots: Array<{
    bot: { id: string; name: string; avatar: ... };
    items: Array<{
      id: string;
      title: string;
      scopeLabel?: string;
      createdAt: string;
    }>;
  }>;
  legacy: Array<{
    id: string;
    title: string;
    createdAt: string;
  }>;
}

actionPreferences.remove({ id: string }): { ok: true }
```

- list/remove 均按当前用户和 Space 授权；Bot 分组只返回用户可见 Bot。
- remove 必须验证记录归属，幂等删除可返回成功。
- 不提供 create/update/preview/catalog API。新增长期选择只从一次真实审批产生。

### B4. 执行与审计

- 每次工具执行前按当前 user/space/bot/actionKey 读取偏好；命中后可跳过普通审批，但服务端强制 deny、资源权限、凭据状态、Plan 审批及其他强制边界仍先执行。
- `仅这一次` 只批准当前 effect；`始终允许` 原子地批准当前 effect并保存选择；`拒绝` 不保存。
- 同一 intervention 的重复提交保持幂等，不能重复写规则或执行 effect。
- 记录已保存选择的创建/移除审计事件，包含 actor、space、bot、actionKey、来源 effect 和时间；不记录敏感参数。
- 旧规则保持原作用范围与解析语义，直到用户移除；迁移不能把它们扩大到其他 Space 或 Bot。

## 7. #81 改造要求

继续使用 PR #81，不另开新的 CAP PR，也不为任务文档单独跑一轮 CI。

改造顺序：

1. 先删除旧编辑器与其 API/schema/migration，恢复跨 Space 导航。
2. 在现有审批卡链路上实现展示对象与 `始终允许`。
3. 把现有 ApprovalRulesSettings 改成“已保存的操作”列表。
4. 用真实生产 executor 支持的一条动作完成端到端闭环，再接第二种不同来源的动作，证明结构不是为某个示例硬编码。
5. 回写本任务、roadmap 与一份新的实现说明；旧 #81 交付说明明确标注 superseded，不伪装成最终实现。

可以保留 #81 中与最终方案仍有直接用途的通用修复；不得为了减少删码而保留无用户价值的接口、表或状态机。

## 8. 验收标准

1. 用户从真实聊天中的确认卡能看懂当前动作、对象和影响，不出现工具名、JSON 或规则字段。
2. `仅这一次` 只执行当前 effect 一次；刷新与重复提交不产生第二次外部动作。
3. `始终允许` 只在服务器有稳定提案时出现；点击后当前动作执行一次，后续相同 Bot 的同 actionKey 不再询问。
4. 不同 Bot、不同 Space、不同 actionKey 或提案规定需要区分的资源/账户不会误命中。
5. `拒绝` 不执行且不保存；过期卡不执行。
6. 设置页只显示由真实审批保存的选择，按 Bot 分组；移除后刷新一致，下一次相同动作重新询问。
7. 旧账户/Space 规则继续按原范围生效，并以可移除的历史选择展示；没有静默扩权或丢失。
8. 未注册长期范围的动作只有一次允许/拒绝，流程仍完整，不要求用户填写配置。
9. catalog 包装与直接调用解析到同一真实动作身份；不得保存 `__catalog_execute` 之类包装名。
10. 服务端 deny、资源权限、撤权、Plan 审批和强制审批不被“始终允许”绕过。
11. roster 跨 Space 导航恢复；Task Center 回焦、approval resume、MR-01 retry 与 AG-08 撤权恢复不回归。
12. 删除 #81 的 capabilityPolicy API、policyRev/audit migration、编辑器、preview、catalog 和草稿守卫；仓库中没有两个用户权限入口。
13. 至少两条来自不同执行来源的真实动作完成 PG/executor/E2E 验证；测试断言实际 effect/HTTP/文件结果，不能只断言中文标签。
14. 前端受影响包 check、后端定向单测、PG 审批旅程和聚焦 E2E 通过；不为本次改造重复运行无关全量套件。
15. 交付说明列出最终保留/删除的 #81 文件、数据迁移、旧规则兼容和真实支持的动作；未支持内容如实写明。未部署。

## 9. 设计交付物

- 新交互原型：`/Users/rivers/Documents/WorkPal-design/cap01-action-approvals-v2/index.html`
- 设计说明：`/Users/rivers/Documents/WorkPal-design/cap01-action-approvals-v2/design-notes.md`
- 旧原型：`/Users/rivers/Documents/WorkPal-design/cap01-permission-editor/`，状态为 superseded，保留作历史，不再作为实现依据。
