# CARD-01 卡片统一与拓展

状态：`not-started`

产品决策已于 2026-10-24 确认，见 [CARD-01 卡片统一决策](../cards/CARD-01-decision.md)。可运行原型已于同日批准并去敏入库，生产实现拆为 CARD-01A–E，尚未开始。总 feature gate 必须默认关闭，验收全绿后才由产品负责人决定是否开启。

原型批准不等于授权直接修改生产页面；任何实现都必须引用入库原型、保持现有视觉语言，并按任务边界交付。

## 目标

把有副作用或需要用户操作的消息卡收敛为统一 Action Card 协议，把无副作用展示收敛为有限的展示组件，并补齐详情视图、待处理提醒、状态、窄屏、深色和无障碍。产品输入声明的完整范围是 27 张卡、7 个详情视图、4 类提醒和 112 条验收。

这是一个产品范围，不是单个 PR。确认后可以按协议、后端投影、兼容迁移和 Web 呈现拆成可审查的提交，但同一个 feature gate 在完整验收通过前不得部分开放。

## 已批准输入

批准后的去敏原型位于 [`docs/cards/source/card-unification-v2`](../cards/source/card-unification-v2/README.md)。入口与关键证据以该目录为准；源文件完整性由 `SHA256SUMS` 校验。

- PRD：`card-requirements.md`
- 统一说明：`card-unification.md`
- 可运行页面：`mockup/cards-hifi-v4/index.html`、`cards.html`、`a-detail.html`、`b-alerts.html`、`c-states.html`
- 视觉规范：`mockup/cards-hifi-v4/STYLE-SPEC.md`
- 生产盘点：[CARD-01 实现盘点](../cards/CARD-01-implementation-inventory.md)，基线 `main @ 37bb38a`

任何实现任务都必须引用这些文件中的具体场景，并用对应截图或视觉回归验收。

## 已解决的产品决策

[CARD-01 卡片统一决策](../cards/CARD-01-decision.md) 已固定协议家族、三层状态所有权、九个开放问题、attention queue 边界、HTML 安全边界和完整交付方式。该决策取代旧 PRD 与 STYLE-SPEC 中冲突的段落。

## 生产实现拆分

1. [CARD-01A：严格协议、服务端投影与旧消息适配](./CARD-01A.md)
2. [CARD-01B：核心 Interaction 与 Card Shell](./CARD-01B.md)
3. [CARD-01C：DisplayBlock、详情视图与安全 HTML](./CARD-01C.md)
4. [CARD-01D：Attention queue 与 Web 通知](./CARD-01D.md)
5. [CARD-01E：无障碍、旧消息回放、视觉回归与总 Gate](./CARD-01E.md)

五项契约映射已于 2026-10-24 确认，详细规则在 [CARD-01A 的开工前冻结](./CARD-01A.md#开工前冻结)。实现者不得自行补设计；发现冲突必须停止并报告。

## 执行顺序

- CARD-01A 先完成契约、投影和默认关闭的 gate。
- CARD-01B 与 CARD-01C 可在 A 后并行。
- CARD-01D 依赖 A 和 B。
- CARD-01E 依赖 A–D，负责完整验收和 gate 开/关证据。
- 所有部分通过前不得部分开启总 gate；未实现 variant 必须明确失败或保持禁用。

## 不可妥协的边界

- 后端是状态、权限、幂等、Run 归属和审计的权威。Web 不从卡片字段猜权限或生命周期。
- consequential 动作只接受运行所属用户本人的决定。Bot 转述不能批准。
- 未实现 preset 必须拒绝或禁用，不能渲染模拟成功。
- HTML 展示必须使用现有沙箱边界，默认无同源、无网络、无表单提交、无父页面访问，也不能伪装 Action Card。
- 旧消息只读兼容必须有明确期限和回放测试。不能在页面散落协议分支。
- CARD-01 不吞并 EFFECT-01。卡片显示「执行中」或「结果未知」不能替代外部动作的数据库执行权栅栏。
