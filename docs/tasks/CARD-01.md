# CARD-01 卡片统一与拓展

状态：`blocked`

产品决策已于 2026-10-24 确认，见 [CARD-01 卡片统一决策](../cards/CARD-01-decision.md)。剩余阻塞只有原型更新、入库和产品确认。不得使用旧 v4 截图启动生产实现。

当前可派发的下一步是 [CARD-01P：对齐并验证 v4 可运行原型](./CARD-01P.md)。CARD-01P 只修改外部原型包，不修改生产页面。

## 目标

把有副作用或需要用户操作的消息卡收敛为统一 Action Card 协议，把无副作用展示收敛为有限的展示组件，并补齐详情视图、待处理提醒、状态、窄屏、深色和无障碍。产品输入声明的完整范围是 27 张卡、7 个详情视图、4 类提醒和 112 条验收。

这是一个产品范围，不是单个 PR。确认后可以按协议、后端投影、兼容迁移和 Web 呈现拆成可审查的提交，但同一个 feature gate 在完整验收通过前不得部分开放。

## 当前输入

外部输入目录为 `WorkPal-cards-delivery`。本任务只记录版本，不把本机绝对路径写进仓库。

| 文件 | SHA-256 |
| --- | --- |
| `card-requirements.md` | `2ed90642b1543d7487ae83b58add5645dbafeb2ac80167a577a2ea89b3ec2e48` |
| `card-unification.md` | `5a962f2930f4bc8d645493a7d05f4ffcdb94422991f49682517f0923a5863e2b` |
| `card-unification.html` | `2edfc517301116b69a17170cbb7a51601c3f06c5060e009f24eaf75640d82f75` |
| `mockup/cards-hifi-v4/STYLE-SPEC.md` | `40da4e925d67b21d36d01e0bd767390ac2f3e4da74e8dd855be244b110c33024` |

可运行原型场景是 `mockup/cards-hifi-v4/index.html`、`cards.html`、`a-detail.html`、`b-alerts.html` 和 `c-states.html`。任何实现任务都必须引用入库后的对应文件和具体场景，并用截图或视觉回归验收。

## 已解决的产品决策

[CARD-01 卡片统一决策](../cards/CARD-01-decision.md) 已固定协议家族、三层状态所有权、九个开放问题、attention queue 边界、HTML 安全边界和完整交付方式。该决策取代外部 PRD 与 STYLE-SPEC 中冲突的段落。

## 剩余阻塞项

外部输入还不能授权生产页面修改：

1. v4 PRD、STYLE-SPEC 和截图尚未按已确认决策更新。旧版本仍保留已被否决的万能 `action`、失败重试、状态合并和 Task Center 式待处理入口。
2. 原型使用独立 sand 色值。生产实现必须映射到 `@rakazo/ui-tokens`、`@rakazo/ui-web`、`@rakazo/chat-ui` 和 `apps/web/src/components/ai/`，不能复制一套平行 token。
3. 外部目录尚未以去除本机信息、私有 URL、真实用户数据和密钥的形式入库。任务提示无法稳定引用已确认原型。

## 解除阻塞

1. 完成 [CARD-01P](./CARD-01P.md)，按 [决策记录](../cards/CARD-01-decision.md) 更新 PRD、STYLE-SPEC、可运行 HTML 和四组截图。
2. 产品负责人确认更新后的原型。
3. 将批准后的 PRD、STYLE-SPEC、HTML、CSS、必要脚本和关键截图复制到 `docs/cards/source/card-unification-v2/`。入库版本必须可本地运行，并记录源文件 hash。
4. 对照当前 `main` 重做协议和组件盘点。外部 `card-unification.md` 基于旧快照，不能直接作为代码事实。
5. 完成以上四项后再拆实现任务。每个任务提示必须引用入库原型的场景、视觉约束、允许范围、禁止改动和截图验收方式。

## 不可妥协的边界

- 后端是状态、权限、幂等、Run 归属和审计的权威。Web 不从卡片字段猜权限或生命周期。
- consequential 动作只接受运行所属用户本人的决定。Bot 转述不能批准。
- 未实现 preset 必须拒绝或禁用，不能渲染模拟成功。
- HTML 展示必须使用现有沙箱边界，默认无同源、无网络、无表单提交、无父页面访问，也不能伪装 Action Card。
- 旧消息只读兼容必须有明确期限和回放测试。不能在页面散落协议分支。
- CARD-01 不吞并 EFFECT-01。卡片显示「执行中」或「结果未知」不能替代外部动作的数据库执行权栅栏。
