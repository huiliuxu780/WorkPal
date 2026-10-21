# UX-03 决策：Bot 管理面收敛（三 tab 面板 + 悬浮头像）

> **状态：决策已由用户于 2026-10-20 批准（含四个开放点答复）。UX-03 主体已在 stacked Draft PR #83 实现；代码复核要求先收敛 #81，再将 #83 rebase/retarget，并移除继承的错误 capabilityPolicy 接线。**
> 原型：`WorkPal-design/ux03-bot-panel-tabs/`（index.html 冻结版 + design-notes.md + shots/）。
> 本文只记决策与映射；实现期以最新 main 定位代码。

---

## 0. 三条核心规则（写死，任何实现都不能违反）

1. **聊天头部不再承载管理功能。** 模型切换器、Agent 电脑按钮、名称行从头部移除；头部位置不保留替代表头。管理项的唯一入口是侧设置面板。
2. **悬浮头像是身份与状态的唯一常驻表达。** 水平居中贴顶浮于对话栏；头像、名称和状态是同一个按钮，单击开侧面板、再单击收起；运行中/待审批状态以环色+文案表达在这个按钮内，不再保留独立 `run-panel-trigger`。Run 详情从原对话执行卡进入。它不遮挡输入、不随转录滚动消失。
3. **面板功能不丢一项。** 三 tab（详情/资料库/电脑）必须容纳现有 BotSettings 与 computer panel 的全部 Bot 管理能力；例行任务列表进详情 tab，完整编辑仍钻入 RoutineEditor。现有 Connect Apps 大弹窗和 Settings 中的 Auto-review 规则明确不进入 Bot 面板，也不因 UX-03 改造。

---

## 1. 决策表

| # | 决策 | 来源 |
| --- | --- | --- |
| U1 | 头部整条移除（模型切换器、Agent 电脑、名称行） | 用户 2026-10-20 |
| U2 | 面板 = 居中头像 hero + 名称 + 头衔 + 三 tab：详情 / 资料库 / 电脑 | 用户参考截图 |
| U3 | 模型选择（+思考深度）进详情 tab；电脑模式 + 实时屏幕 + 维护进电脑 tab | 用户 |
| U4 | 单 Bot 悬浮头像：对话栏水平居中贴顶；= 身份 + 微型状态；单击开/再单击收 | 用户 |
| U5 | 群聊悬浮为成员头像簇，点击进群设置 | 用户 |
| Q1 | 悬浮位 = 水平居中贴顶（原型现状） | 用户拍板 |
| Q2 | 群设置维持现状（group-settings 不同构三 tab） | 用户拍板 |
| Q3 | 面板 hero 头像保留点击换装（AvatarStudio popover） | 用户拍板 |
| Q4 | run 状态 pill 与悬浮头像合并为单一悬浮件 | 用户拍板 |

## 2. 面板内容映射

- **详情**：例行任务（列表+开关）、名称/头衔/描述、通知、模型+思考、其余既有 Bot 高级项（记忆范围/朗读/音色）、导出/清空。不得放 Connect Apps、Auto-review、自定义规则或内部 capability policy。
- **资料库**：技能（KnowledgeSection）+ 草稿板（ScratchpadSection）。
- **电脑**：ComputerModePicker + 实时屏幕 + 维护动作 + 打开完整窗口；`ComputerModePicker` 不得留在详情 tab；原来的 settings↔computer 切换由三 tab 取代。
- 面板头部仅保留导出/关闭两圆钮（参考截图）。

全局 `SettingsOverlay` 与 `PluginsOverlay` 继续是现有大弹窗；本侧面板只承载当前 Bot 的上下文和管理能力。

## 3. 头部元素去向

| 原头部元素 | 去向 |
| --- | --- |
| 头像+名称 trigger | 悬浮头像（U4）；名称在悬浮件与面板 hero |
| 模型切换器 | 详情 tab；`bots.update` 语义不变 |
| Agent 电脑按钮 | 电脑 tab |
| run 状态 pill | 合并进悬浮头像（Q4） |
| 移动端导航 | 左上悬浮按钮 |

## 4. 合流方式

- CAP-01 与 UX-03 保留为两个完整功能 PR，不再压进同一个分支：#81 负责现有 Auto-review 用户化与 Task Center UI 退场；#83 负责悬浮身份件与三 tab Bot 面板。
- 合并顺序固定为 **#81 → #83**。#83 当前 stacked 在 #81 的旧 head 上，必须先移除 inherited capabilityPolicy 接线与专用 CAS timeout，再 rebase/retarget 到收敛后的 #81 或其 merge commit。
- 悬浮球体视觉与 `roster-avatar-redesign` round 01 待挑方向合流；未挑定前实现用现有球体资产。
- 覆盖 UX-01/Task-15 已验收头部构图，以本文为准。
- **roadmap 行**：UX-03 作为第 26 行独立保留需求身份，由 #83 关闭；CAP-01 由 #81 关闭。不得因 stacked 合流而删除任一项的决策、验收或历史。

## 5. 风险与对策

- 悬浮件遮挡首屏消息：贴顶 + 转录 `padding-top` 预留；窄屏（<md）收为纯球隐藏名称。
- 状态可读性：环色之外保留文案（运行中 · N 项动作 / 待审批 · 事由），不只靠颜色。
- 群簇成员过多：露前 3 球 + 计数，其余进群设置。
