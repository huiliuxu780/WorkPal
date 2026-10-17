# WorkPal Agent 头像 — 实现规格（交 Codex 执行）

> 整理：Buzz，2026-10-15（UTC+8）；10:07 按专家裁决更新（冲突 #1–#4、#6、#7 已定）；11:01 同步任务书 10:04 第5条澄清（#5 已定）；新增 final/assets/ 素材与 MOTION-SPEC 勘误 §S。**本文件是汇编件，不替代源文档**；源文档冲突时以 MOTION-SPEC v0.6 FINAL 为准（MOTION-SPEC 冻结节原文：“演示页和规范不一致时，以本规范为准”）。
> **开工状态：文档已具备开工条件，但开工须 RiversXu 下令**（任务书决定记录 13:39 / 14:40）。
> 标注约定：每节注明【来源】；`推测` = Buzz 推断，源文档未写；`待核实` = 代码位置/行号未在当前分支核对。

## 0. 源文档清单（路径相对于外部设计库的 avatar 目录（`myagent/docs/avatar/`）；仍以 `/workspace/` 开头的条目只在共享电脑 box 上，未复制）

| 文档 | 路径（相对 avatar/） | 负责人 | 状态 |
|---|---|---|---|
| 动作规范 MOTION-SPEC v0.6 FINAL | `WorkPal-avatar-visual/final/MOTION-SPEC.md` | UI设计专家 | 冻结 2026-10-13 |
| 任务书 v1.3 + 决定记录（至 10-15 第5条澄清） | `WorkPal-avatar-task.md` | WorkPal产品专家 | 有效（技术结论部分被 v2.0 取代） |
| 开发任务书 v2.0 | `WorkPal-avatar-task-dev-v2.0.md` | WorkPal产品专家 | 有效 |
| 任务书 v1.3 存档 | `/workspace/WorkPal-avatar-task-v1.3-archive.md` | — | 仅存档 |
| UX 方案（v0.1 正文 + §12–§14 更新） | `WorkPal-agent-avatar-ux.md` | UX专家 | 有效；旧的 bloub/CSS 实现描述作废（§13） |
| 视觉规范 v1 | `WorkPal-avatar-visual/SPEC.md` | UI设计专家 | 部分被 MOTION-SPEC 取代（见 §5 冲突说明） |
| 引擎评估 v2（结论 SVG+JS） | `WorkPal-avatar-engine-eval-v2.md` | 开发助手 | 已采纳（13:39） |
| 引擎评估 v1 | `/workspace/WorkPal-avatar-engine-eval.md` | 开发助手 | 被 v2 取代 |
| 冻结素材与演示页 | `WorkPal-avatar-visual/final/` | UI设计专家 | 冻结 |

**任何源文档都不得修改**；本 spec 有误时回到源文档，由负责人改。

---

## 1. 目标与范围
【来源】任务书 §2/§4；开发任务书 v2.0 §2

**目标**：让用户在侧边栏、对话、群聊、活动等所有地方一眼认出是哪个 Bot、在和谁说话，并看到它当前的运行状态。

**P0 范围**
1. 唯一形象：RiversXu 原创 4 个纯黑角色（圆点 dot / 高音谱号 treble / 波浪 wave / 弹跳 bounce），透明底，无底板，身体不变色。深色模式身体加 1.5px 白描边，道具不描边。
2. 默认分配：创建 Bot 时选**当前用户 Bot 中用得最少**的角色，平局按 `hash(botId)`；写入 Bot 记录后不再变化。“重新生成”= 在 4 个角色间切换并写回。前 4 个 Bot 互不重复。
3. 四档尺寸 16 / 24 / 32 / 64 px。16px 用单独的 `*-16.svg`（无头顶符号）+ 状态点，不画道具和叉眼。
4. 5 套动作（待机 / 工作中 / 等审批 / 等你回答 / 出错），13 种 ActivityKind 映射到 5 套；24px+ 用动作与道具表达状态，不画状态点。
5. 17 处 `<BotAvatar>` 调用统一替换；1:1 私聊气泡新增头像。
6. 上传：裁切预览；非图片报错；保存失败回滚；加载失败退回默认头像；加载中同尺寸占位。
7. 资料卡点头像即可修改。
8. Bot 只在用户明确要求时改头像，对话留记录卡，支持一键撤销。
9. 无障碍：悬停 tooltip、aria-label 含 Bot 名与状态；头像单独出现（群组合成头像、谁在输入、+N 折叠）时也要给出名字。

**P1（本 spec 不实现）**：13 张 3D 状态插画（详情页/空状态）；主 Bot 标识（左上 12px 星形徽标）。

## 2. 不做（Non-goals）
【来源】任务书 §5、§6.7；UX §4
- 真人形象、3D 小头像、头像市场、底板或身体变色、Bot 主动/周期性改头像。
- AI 生成头像（UX §4 E：v1 不做，仍在待确认 12）。
- 照抄 Grok Bot 的文案、配色、布局的排查替换——另开 PR。
- 不引入 Rive、不复用 bloub 引擎（引擎评估 v2 结论）。
- 不修改冻结 SVG 的任何路径（验收：diff 为零）。

---

## 3. 动作规范（忠实转录 MOTION-SPEC v0.6 FINAL）
【来源】`WorkPal-avatar-visual/final/MOTION-SPEC.md`。下文按“最终生效值”合并 v0.3 正文与 v0.4/v0.5/v0.6/冻结节的覆盖（原文：“v0.4 更新（覆盖上文相同条目）”）。**合并是 Buzz 做的，遇到疑问以原文为准**；被覆盖的旧值在括号里注明。

### 3.0 坐标、图层、缓动（§0）
- 画布 100×100。`R = 31.25`；身体中心 `(50, 57.8)`。位移以 R 为单位，**向上为负**。
- 图层叠放从下到上：`feet`、`body`、`eyewhite`、`pupilL`、`pupilR`、`symbol`、`prop`。`prop` 是新增道具层（黄牌、问号、笔记本、叉眼由引擎绘制；不在静态文件里）。
- **整体组** = `body` + `eyewhite` + 两瞳孔 + `symbol`；`feet` 单独留在地面。
- **挤压**：只作用整体组，锚点 = 身体底部中点（即身体与脚交界，v0.5 L）；`sx, sy ∈ [0.90, 1.10]`，`sx×sy ≈ 1`（硬夹紧，v0.4 A）。
- **旋转**（v0.4 A + v0.5 L）：整体组以身体底部中点为轴，最多 ±5°。黑脚不在旋转组里，始终贴地，不转不缩，跳起时也留在原地。
- **头顶符号单独运动**（v0.4 A）：只平移+旋转，平移 ≤0.35R，旋转 ≤±15°。旋转轴：谱号 = 竖杆与身体接点 `(−0.38R, −0.78R)`；波浪 = 符号底部中点；圆点的球、弹跳的球加短线 = 自身中心。
- **眼睛整体等比放大**：仅出错“吓一跳”时，最多 1.12（v0.4 A）。
- 缓动：`out = cubic-bezier(0.2, 0.8, 0.3, 1)`；`inOut = cubic-bezier(0.45, 0, 0.55, 1)`；`linear`。

### 3.1 绝对不能变（每一帧都检查，§1）
- `body`、`feet`、`symbol`、`eyewhite` 路径不变形，只允许平移、旋转和上述有限挤压。
- 黑脚永远黑色并贴地；弹跳角色抬起的左脚属于 `feet`，保持原姿态（§6）。
- 不加背景板、不改颜色。只有道具层有颜色：黄牌 `#F5C84B`，问号 浅 `#3F8FDF` / 深 `#7CB8F2`，笔记本屏幕光 `#4ADE80`，叉眼黑色。
- 眼睛允许：瞳孔在眼白内平移并留 1px 边；眨眼眼白 y 缩放最小 0.1；叉眼时瞳孔替换为 X。
- **瞳孔位移夹紧（勘误 §S，2026-10-15）**：所有瞳孔位移先按规范原值算，再夹紧到眼白内——两瞳孔一起移动，各留 1px（按 64px 折算 = 0.05R）；x、y 同时有位移时按同一比例缩短。上限参考：**+x ≤ 0.10R**；−x 和 ±y 按 `WorkPal-avatar-visual/final/assets/eye-bounds.md` 各角色安全值。受影响：工作中看屏幕、待机向右张望 0.14R、等你回答快看另一侧 0.18R、旧静帧 +0.12R。眼神方向不变，只是幅度变小；**演示页数值不再作为依据**。

### 3.2 道具层（§2、v0.6 N/Q）
- 锚点 **身体右下方 (+1.30R, +0.50R)**，道具高 0.6R；必须完整在 100×100 画布内，右、下边距 ≥1 单位。
- 24px 下道具高度 ≥6px；不够时道具单独放大，锚点向左上收。16px 不画道具。
- 深色模式：道具不加白描边；叉眼画在眼白内，也不加。
- 黄牌：圆角矩形，宽 0.46R、高 0.60R，倾斜 −6°。
- 问号：粗体字形 + 0.04R 描边，浅色 `#3F8FDF`、深色 `#7CB8F2`，高 0.6R。
- 笔记本（v0.6 N）：黑白简线条，白屏 + 黑描边 0.07R + 黑色键盘底座；屏内微亮 `#4ADE80`；光标黑色竖条；约 0.66R × 0.51R（底座最宽处）；同一锚点。
- **只有笔记本可以压住身体右下边缘**（在身体前面）；黄牌、问号不得碰身体（v0.6 Q）。三种道具分属不同状态，不会同时出现。
- 道具与 4 个头顶符号间距：**下限 0.4R**（§6；§2 的 0.5R 是实测值，不作为要求。专家裁决 #6）。

### 3.3 五套动作
| 状态 | 循环方式 | 道具 |
|---|---|---|
| idle 待机 | 一直循环 | 无 |
| working 工作中 | 开场 → 循环 | 笔记本 |
| approval 等审批 | 出场 → 循环 | 黄牌 |
| waiting 等你回答 | 出场 → 循环 | 问号 |
| failed 出错 | 只播一次后停住 | 叉眼 |

#### idle（v0.4 B 重写；v0.5 R 冻结：所有位置都用完整版）
- 呼吸：周期 **3.6s**，`inOut`，sy 最大 **1.035**，sx 最小 **0.965**（覆盖 v0.3 的 4.0s / 1.02 / 0.98）。
- 眨眼：间隔 2.5–6.0s 均匀随机；每次 160ms：眼白 sy 80ms 内 1→0.1，80ms 回到 1，瞳孔一起缩放；约 15% 概率连眨两次，间隔 120ms。
- 符号轻晃：一直在动，旋转 ±4°（周期 2.6s），上下浮 0.02R（周期 1.8s），每个头像起始相位随机。
- 左右张望：每 3–7s 随机一次，共 1.4s：瞳孔移到一侧 0.14R，身体同侧歪 2°，停 0.9s 后回来。
- 原地小蹦：每 6–14s 随机一次，跳 0.08R，用工作中那套 420ms 弹跳。
- 招牌动作：每 9–18s 随机一次；进行时暂停张望和小蹦。
- 静态帧：睁眼，sy=1。

#### 招牌动作（v0.4 C，只用平移和旋转）
| 角色 | 动作 | 时长 |
|---|---|---|
| 圆点 dot | 头顶球往上颠两下，每下 650ms，最高 0.32R；眼睛跟着往上看；每次球落下身体轻挤一下 | 1.3s |
| 谱号 treble | 谱号绕接点左右摆 ±12° 打拍子；身体摆 ±2.5° 并横移 ±0.03R；每拍 0.03R 轻点 | 1.6s |
| 波浪 wave | 波浪上飘 0.10R，左右摇 ±10°、横移 ±0.05R；身体反向轻摆 ±2° | 1.8s |
| 弹跳 bounce | 连蹦两次，0.22R 和 0.30R；头顶球比身体晚 80ms | 1.1s |
- 出现在待机；工作中循环里偶尔出现，间隔 15–25s；等审批、等你回答、出错里不出现；`working.pulse` 进行时不出现。

#### working（§3.2 + v0.4 D + v0.6 O/P）
- 开场：弹跳 3 次，每次 420ms：
  - 0–60ms：挤压 sx 1.08、sy 0.92，`out`；
  - 60–230ms：整体组上升 0.18R，sx 0.96、sy 1.04，`out`；
  - 230–400ms：落回原位；
  - 400–420ms：触地挤压 sx 1.06、sy 0.94，然后回到 1。
  - 黑脚不离地；身体与脚之间空隙最大 0.18R 允许。
- 笔记本出场：0 → 1.12 → 1（320ms），与进入时的小跳同步（v0.6 O）。
- 循环：
  - 点头（敲键盘）：每 600ms 一次，下压 0.03R、sy 0.97，用时 180ms；头顶符号晚 80ms 跟着点，下移 0.025R、转 3°。
  - 每次点头，屏幕绿光不透明度 0.25 → 0.60 → 回落；光标每秒闪一次。
  - 眼睛：瞳孔**固定看向屏幕 (+0.09R, +0.07R)**（v0.6 O，取代 v0.3 的扫眼）；pulse 与招牌动作播放时照常进行，结束后回到看屏幕。
  - 叠加待机呼吸，不叠加眨眼（§3.2 原文）。
- 长任务收敛（v0.6 P）：进入工作中 30s 后，点头放慢到每 **1.2s** 一次，绿光只到 0.25–0.40，光标照常 1s 闪。每次“新进展”恢复 600ms 快节奏，再过 30s 无新进展重新放慢。**演示页未实现恢复，按规范实现。**
- `working.pulse`（新进展）：额外弹跳一次（同 420ms 弹跳）；两次 pulse 间隔 ≥2s，间隔内到达的直接丢弃，不排队；弹跳时眼睛动作暂停，落地后继续。
- 离开：笔记本 160ms 缩到 0。
- 静态帧（专家裁决 #7，按 v0.6）：笔记本显示，瞳孔看屏幕 (+0.09R, +0.07R)（经 §S 夹紧），屏幕绿光固定 0.4，光标常亮。v0.3 的“瞳孔偏右 +0.12R”作废。

#### approval（§3.3 + v0.4 E + v0.5 K）
- 出场：黄牌从锚点缩放 0 → 1.12 → 1.0，共 320ms，`out`；瞳孔 200ms 内移到 (+0.10R, +0.04R)。
- 循环：黄牌上下浮动 ±0.05R，周期 1.6s，`inOut`；身体保持待机呼吸和眨眼；符号轻晃幅度为待机的 0.6 倍。
- 招手提醒：进入 3s 后一次，之后每 30s 一次（不能短于 30s），每次 900ms：黄牌左右挥 3 下 ±14°、放大到 1.1；身体朝黄牌侧歪 3° 并小跳 0.08R；眼睛前 450ms 看你（瞳孔居中），后 450ms 回看黄牌。
- 上限：同一审批最多提醒 3 次，之后只保留浮动；窗口不在前台不提醒、计时暂停，回到前台不补发。
- 多头像：按出现顺序错开 ≥2s（v0.5 M：演示页未实现，开发按 v0.4 E 实现）。
- 静态帧：黄牌完全显示，瞳孔看黄牌。

#### waiting（§3.4 + v0.4 F）
- 出场：问号同黄牌方式弹出 320ms；瞳孔 200ms 内移到 (0, −0.08R)。
- 歪头等待：每 4s 换一边歪头 ±4°，切换 500ms；问号同侧倾斜 8°；瞳孔同侧偏 0.05R。
- 张望：每次歪头期间的 2.6–3.2s 之间，瞳孔快速往另一侧看一眼，最远 0.18R 后回来。
- v0.3 的“每 3s 小跳”取消。眨眼照常。
- 静态帧：问号完全显示，瞳孔往上看。

#### failed（v0.4 G 重写，只播一次）
- 0–180ms 吓一跳：整体组上弹 0.14R，sy 1.08、sx 0.93，眼睛等比放大到 1.12，头顶符号上甩 0.06R。
- 180–330ms：落回原位，形状恢复。
- 330–780ms 摇晃：水平位移 +0.08R、−0.08R、+0.05R、−0.03R、0（`linear`），同时旋转 +3°、−3°、+2°、−1°、0。
- 780ms：瞳孔透明度 0，两眼各出现黑色 X，线宽 0.07R，大小 = 眼白宽度 × 0.55，120ms 内 0→1 缩放。
- 900–1300ms 泄气：下沉 0.06R，sy 0.95、sx 1.03；头顶符号耷拉 0.04R、转 8°。
- 然后停住：不呼吸、不眨眼、无循环。
- 重复进入：叉眼保持，从“吓一跳”重播。
- 静态帧：最后一帧（叉眼、下沉 0.06R、sy 0.95、符号耷拉）。

### 3.4 状态切换（§4）
- 通用：旧道具 160ms 缩到 0（`out`），同时瞳孔 200ms 移到新位置；然后播新状态出场。总时长 ≤520ms，**中间不回默认帧**。
- 弹跳中切换：先落完当前一跳（最多等 420ms）。
- 进入出错：可打断任何状态，不等落地；道具缩回与动作同时开始。
- 离开出错：叉眼 120ms 缩回，瞳孔重新显示，下沉复原，再进新状态。
- 重复进入同一状态（如又来新审批）：出场只播一次作为提示，不叠加。
- 等审批 ↔ 等你回答：道具交叉淡变 200ms，眼神跟着移动。
- 名额变化：拿到名额的直接从循环段开始播，不重播出场；失去名额的播完当前一轮循环再停在静态帧。出错静止后不占名额。

### 3.5 同屏名额（v0.5 J + 冻结 R）
- 同屏最多 3 个头像在动；优先级：等审批 > 等你回答 > 工作中 > 出错（只播一次）> 待机。
- 拿不到名额 → 静态帧；有空位按优先级补上。
- “当前对话的 Bot 优先”只在同一状态优先级内生效（任务书 10-15 第5条澄清，原汇编冲突 #5 已定）：先按状态分档（等审批 > 等你回答 > 工作中 > 出错 > 待机）占槽；同档内要动画的 Bot 超过剩余名额时，当前对话的 Bot 优先；仍平手按 Bot id 哈希（与分配形象同一套哈希）。当前对话的 Bot 不因“是当前对话”而越过更高优先级状态插队。
- 侧边栏也用完整待机（冻结 R，v0.5 I 降级版作废、不需实现）。
- 页面不可见时暂停（任务书、开发任务书 §2）。

### 3.6 静态帧表（§5 + v0.4 H）
以下情况一律静态帧：开了“减少动态效果”、超出同屏名额、尺寸 16px。招牌动作、张望、轻晃全不播。

| 状态 | 24px 及以上 | 16px（`*-16.svg`） |
|---|---|---|
| 待机 | 睁眼 | 睁眼，无状态点 |
| 工作中 | 笔记本 + 看屏幕 (+0.09R,+0.07R，经 §S 夹紧)，绿光 0.4、光标常亮 | 绿点 `#4ADE80` |
| 等审批 | 黄牌 + 眼神 | 黄点 `#F5C84B` |
| 等你回答 | 问号 + 眼神 | 蓝点 `#7CB8F2` |
| 出错 | 叉眼 + 下沉 0.06R、sy 0.95、符号耷拉 | 橙点 `#F28B6B` 带 “!” |
16px 不画道具，也不画叉眼。

### 3.7 角色适配（§6）
- 头顶符号属于整体组；弹跳角色挤压锚点用身体底部中点，不用两脚中点（避免把歪身拉正）。
- 弹跳角色瞳孔已拆分，叉眼能画两个 X。

---

## 4. UX 状态与流程
【来源】`WorkPal-agent-avatar-ux.md`（§3、§6、§7、§8、§9、§12–§14）；任务书 §4

### 4.1 用户场景（UX §3，按 v1.3 修订解读）
S1 新建 Bot 自动得到不重复角色；S2 资料卡/设置点头像打开 Studio 切换角色；S3 上传图片带裁切预览与错误提示；S4 对话中按明确指令改头像并出现“头像已更新 · 撤销”记录卡；S5 侧边栏/群聊一眼分辨是谁及状态；S6 恢复默认 / 撤销上一次。
> UX §3–§6 原文仍提到 bloub 与“形状/颜色”，按 UX §12/§13 已作废，以“4 角色切换 + 上传”为准。

### 4.2 Studio 修改流程（UX §6.1，去掉作废项）
点击头像（Bot 设置 / 资料卡）→ Studio（64px 预览 + 状态动作）→ 选来源：切换角色 / 上传 / 恢复默认 → 上传须校验类型、大小、可解码，失败内联错误；通过则裁切预览 → 乐观更新 → `enqueueSave` → 成功：写变更记录、Toast 可撤销（建议 5s）；失败：回滚旧头像 + 错误 Toast 重试。

### 4.3 Bot 在对话中修改（UX §6.2）
仅明确指令时调用 `bots.update`（来源=bot，关联 runId）→ 对话内记录卡“旧→新 · 撤销”→ 撤销恢复旧值。变更记录字段：旧值、新值、来源（user/bot）、时间、runId；存放位置待定。

### 4.4 ActivityKind → 5 套 / 16px 状态点（UX §7；任务书 §4）
| 动作套 | ActivityKind | 16px 点 |
|---|---|---|
| working | working, planning, tool, research, delegation, handoff, background | 绿 `#4ADE80` |
| approval | approval | 黄 `#F5C84B` |
| waiting | waiting_input, waiting_takeover | 蓝 `#7CB8F2` |
| failed | failed | 红/橙 `#F28B6B` 带 “!” |
| idle | idle, completed, cancelled | 不显示 |
- 多 Run 并行取一个：出错 > 等审批 > 等你回答 > 工作中。出错只在用户看过之前显示，看过后按优先级切换（任务书 §4）。
- 状态组件只读 Activity Projection，不直接读 runtime（任务书 §6.6）。
- 16px 点：**直径 6px，描边 1.5px，描边色 = 当前背景色**；浅色、深色模式都要测（专家裁决 #2，UX 验收 7 已更新）。绿点呼吸动画 1.6s ease-in-out，opacity 1→0.45，reduced-motion 时静止（视觉 SPEC §4）。

### 4.5 空 / 加载 / 出错（UX §8）
| 情况 | 表现 |
|---|---|
| 无值/非法值 | 回退默认角色，不出现空白圆 |
| 列表首屏 | 同尺寸圆形骨架；矢量头像同步渲染 |
| 图片解码失败 | 回退默认角色（再不行首字母色块兜底） |
| 上传非图片 | 内联错误“仅支持 PNG / JPEG / WebP / GIF”（现状是静默 return，须修） |
| 处理后超 200000 字符 | “图片过大，请换一张” |
| 保存失败 | 回滚 + Toast“头像保存失败 · 重试” |

### 4.6 无障碍（UX §9、§12）
- `aria-label="{Bot 名} · {状态}"`；旁边已有名字时头像 `aria-hidden`，状态由名字元素读出。
- 悬停/键盘 focus 出 tooltip；不只靠颜色。
- `aria-live="polite"` 只播报 approval / waiting / failed。
- `prefers-reduced-motion`：关闭动画，显示静态帧（含 16px 静态点）。
- Studio：焦点陷阱、Esc 关闭、方向键选择、`aria-pressed`。
- 状态点对比度 ≥3:1。
- 同一群聊两个 Bot 形象相同时，消息旁名字不省略，连续消息也显示（UX 验收 14）。

---

## 5. 视觉 token 与尺寸
【来源】`WorkPal-avatar-visual/SPEC.md` §1–§4、§7；MOTION-SPEC

```css
--wp-avatar-16:16px; --wp-avatar-24:24px; --wp-avatar-32:32px; --wp-avatar-64:64px;
--wp-status-run:#4ADE80; --wp-status-approval:#F5C84B;
--wp-status-wait:#7CB8F2; --wp-status-fail:#F28B6B;
--wp-avatar-body:#111111; --wp-avatar-eye:#FFFFFF;
```
补充（来自 MOTION-SPEC，建议新增 token 名为 `推测`）：
`--wp-avatar-prop-card:#F5C84B; --wp-avatar-prop-q-light:#3F8FDF; --wp-avatar-prop-q-dark:#7CB8F2; --wp-avatar-prop-screen:#4ADE80;` 深色模式身体描边 1.5px 白色。

**尺寸分档（专家裁决 #3：场景↔尺寸以 UX §7 为准）**
| 档 | 场景（UX §7） | 内容 |
|---|---|---|
| 16 | @提及、协作标记、Activity 行、产物页小图 | `*-16.svg`（身体+眼+脚，无头顶符号）+ 状态点 |
| 24 | 侧边栏、群聊发言人、对话顶栏、Bot 选择器、归档、Computer 顶栏、通话卡片、Peer 浮层 | 完整角色，**显示头顶符号和道具** |
| 32 | 消息气泡（1:1 新增）、群成员面板、命令面板 | 完整 |
| 64 | 资料卡、Bot 设置、Studio 预览 | 完整 |
- 24px 显示头顶符号和道具（专家裁决 #1：MOTION-SPEC 优先于旧视觉 SPEC §3）。
- 16px 保留脚（专家裁决 #4：以冻结的 `*-16.svg` 为准）。
- 视觉 SPEC 写“透明底不裁切”，任务书写“统一圆形裁切”：角色头像透明底不裁切，上传图片圆形裁切 256px（`推测`调和，未经专家确认）。
- 视觉 SPEC §1 提到的分层源 `/workspace/avatar-system/assets` 已被 `final/` 取代（任务书 09:34 决定），**不要用它**。

---

## 6. 现有设计素材清单
【来源】box 实际文件列表（2026-10-15 盘点）；任务书决定记录 09:34/09:36

### 6.1 冻结主素材 `WorkPal-avatar-visual/final/`
| 文件 | 内容 | 图层 id | 覆盖 |
|---|---|---|---|
| `1-dot.svg` | 圆点角色 | feet body eyewhite pupilL pupilR symbol | 24/32/64，所有状态底图 |
| `2-treble.svg` | 高音谱号（B 版，S 弯已上移） | 同上 | 同上 |
| `3-wave.svg` | 波浪 | 同上 | 同上 |
| `4-bounce.svg` | 弹跳（歪身、左脚抬起） | 同上 | 同上 |
| `1-dot-16.svg` … `4-bounce-16.svg` | 16px 版，无 symbol | feet body eyewhite pupilL pupilR | 16px 所有状态（+状态点） |
| `MOTION-SPEC.md` | 动作规范 v0.6 FINAL + 勘误 §S（2026-10-15，瞳孔夹紧） | — | — |
| `demo/index.html`（198 行）+ `demo/frame.js`（113 行）+ `demo/layers.json` | SVG+JS 演示页，`?t=3000` 定帧，`&dark=1` 深色 | — | 5 套动作、招牌动作、减少动态、深色；动作参考（瞳孔数值以勘误 §S 为准，不以演示页为准） |
| `demo/light.png` `dark.png` `v6.png` `v6d.png` `v6-crop.png` `v6d-crop.png` `z24.png` `lite.png` | 演示截图（v0.6 浅/深、24px、lite=降级待机） | — | 评审参考，非交付 |
| `review-1-compare.png` … `review-7-frozen.png`（缺 6） | 静态冻结评审图：对比、24px 剪影、尺寸、深色、谱号 A/B、冻结图 | — | 评审参考 |
| `assets/props/card.svg` | 黄牌 `#F5C84B` | 100×100 同坐标系 | approval |
| `assets/props/question.svg` / `question-dark.svg` | 问号 浅 `#3F8FDF` / 深 `#7CB8F2`。**已转为路径（2026-10-15，字形取自 Noto Sans 最粗字重，与评审版一致），无字体依赖** | 同上 | waiting |
| `assets/props/laptop.svg` | 笔记本（白屏黑描边、黑底座、绿屏光、光标） | 同上 | working |
| `assets/props/xeyes-{1-dot,2-treble,3-wave,4-bounce}.svg` | 每角色一套叉眼 X | 同上 | failed |
| `assets/props/check.png` / `check.svg` | 道具与角色叠放的自检图 | — | 评审参考 |
| `assets/compare.gif` | 对照动画 4 角色 × 5 状态，6s。**待机那一行有跳帧，以演示页为准** | — | 全部状态 |
| `assets/eye-bounds.md`（+ `eyes.json`） | 各角色眼白/瞳孔边界表与安全行程 | — | 瞳孔夹紧 §S |
| `assets/*.py` | 生成/校验脚本（props、eyes、check） | — | 不进产品 |
| `work/` | 拆层中间产物（`.pbm` 位图层、`seg*.png`、`layers.py` `build.py` `seg.py` `fit.json` 等） | — | 生成管线，**不进产品** |

### 6.2 其它（历史/参考，不作为实现依据）
- `/workspace/WorkPal-avatar-visual/{1-dot,2-treble,3-wave,4-bounce}.svg`：冻结前版本。
- `/workspace/WorkPal-avatar-visual/showcase/`（`motion.html`、`motion.gif/mp4`、`avatars.js` 等）：v1.1 早期 CSS 动画参考，已被 MOTION-SPEC 取代。
- `/workspace/WorkPal-avatar-visual/treble-v2/`：谱号 A/B/C 选稿与剪影测试。
- `/workspace/avatar-system/`：早期分层素材与 token（`design-tokens.css`），已被 final/ 取代。

### 6.3 缺失素材（需 UI设计专家 补或开发按规范绘制）
（道具 SVG（问号已转路径）、对照 GIF、眼白边界表已于 2026-10-15 交付，见 6.1 `assets/`。）
1. **深色 1.5px 白描边**的实现方式与 24px 截图确认（paint-order 或描边副本层，引擎评估 v2 §7）。
2. **静态帧参考图**（5 状态 × 4 角色 × 24/64）：未见成套文件。
3. P1：13 张 3D 状态插画（仅 working 定稿，文件位置未找到）、主 Bot 星形徽标。

---

## 7. 引擎架构（SVG + JS）
【来源】`WorkPal-avatar-engine-eval-v2.md` §6、§7；决定记录 13:39

- **渲染**：内联冻结 SVG（构建时导入，不运行时 fetch），按图层包 `<g>`；分两组：`feet`（静止）与整体组（body/eyewhite/pupilL/pupilR/symbol）；`symbol` 再嵌一层用于独立平移/旋转；末尾追加 `<g id="prop">`。锚点 = 身体底部中点 `(50, 57.8 + R) = (50, 89.05)`。
- **瞳孔夹紧**：`geometry.ts` 内置每角色眼白安全行程表（来自 `final/assets/eye-bounds.md` / `eyes.json`），所有瞳孔位移出口统一经 `clampPupil`（勘误 §S）。
- **采样函数**：`sample(state, tSinceEnter, rng, ctx) → { [layer]: {tx, ty, sx, sy, rot, opacity} }`，纯函数；支持 `?t=` 定帧、静态帧（`t = static`）、单测、录屏对照。挤压硬夹紧到 [0.90, 1.10] 且面积守恒。
- **AvatarDirector（全局单例）**：
  - 单个共享 `requestAnimationFrame` 时钟 + watchdog（借鉴 bloub `ticker.ts` 思路，自写）。
  - `visibilitychange` 暂停；`matchMedia('(prefers-reduced-motion: reduce)')` 切静态。
  - 3 名额按优先级分配；得/失名额规则（§3.4）。
  - 审批提醒：每审批计数 ≤3、≥30s 间隔、多头像错开 ≥2s、后台暂停不补发。
  - `working.pulse` 节流（≥2s，丢弃）；30s 慢节奏计时。
  - 随机调度（眨眼、张望、小蹦、招牌），每实例随机相位。
- **过渡器**：从“当前采样值”出发插值到新状态出场，≤520ms，处理“等落地”与出错打断 —— **最大风险点**，重点测试。
- **16px**：`*-16.svg` 静态 + CSS 状态点，不进 Director。
- **体积预算**：≈8–15 KB gz（估算，未构建验证）；零新依赖。
- **移除 bloub**：删除 `packages/ui-web/src/bloub/`、`bloub-avatar.tsx` 及测试、第三方 LICENSE。

建议文件布局（`推测`，Codex 可调整）：
```
packages/ui-web/src/agent-avatar/
  assets/{dot,treble,wave,bounce}{,-16}.svg   # 从 final/ 原样复制，不改
  geometry.ts        # R、锚点、眼白边界表、clampPupil（勘误 §S）
  assets/props/*.svg # 从 final/assets/props/ 原样复制
  easing.ts
  motion/{idle,working,approval,waiting,failed,signature,transition}.ts
  director.ts        # rAF、名额、提醒、可见性
  props.tsx          # 黄牌/问号/笔记本/叉眼
  agent-avatar.tsx   # React 组件 <AgentAvatar botId character size activityKind name />
  status-dot.tsx     # 16px
  activity-map.ts    # 13 ActivityKind → 5 套 + 优先级
packages/contracts/src/bot-avatar.ts  # 分配逻辑
```

---

## 8. WorkPal 集成点（全部 `待核实`）
【来源】UX §1（基线 main c91c749 + PR #9）、任务书 §6、开发任务书 §3。box 上 `/workspace/WorkPal` 当前在 `c91c749`（无 bloub）；`/workspace/pr37` 含 bloub 文件。行号来自 UX 文档盘点，**动手前逐一核对当前分支**。

- **基线分支**：开发任务书 v2.0 写“在 PR #9 上实现”；PR #9 当前状态 `待核实`（可能已合并或被其它 PR 取代，pr37 目录存在 bloub 代码）。
- 数据：`packages/db/prisma/schema.prisma` `model Bot { color }`（头像复用 color）；`packages/contracts/src/bot-avatar.ts`（值格式、`BOT_AVATAR_VALUE_MAX_LENGTH = 200_000`）；`packages/contracts/src/domain.ts` `BotSchema` / `CreateBotInput` / `UpdateBotInput`。
- 角色存储格式：`待确认`（UX 待确认 2：扩展 color 取值 vs 新增列）。建议新增可解析值如 `character::dot`（`推测`）。
- 默认分配：`packages/db/src/repos.ts`（创建 Bot 默认值）+ contracts 分配函数。
- 迁移：`20261012000000`（avatarStyle 默认 'bloub' → 新角色名；PR 未合并时直接改原迁移，`待核实`）。
- API：`apps/api/src/router.ts`（复制 bot ~1360、update ~1511、输出 ~5696 行）。
- 组件替换：`packages/ui-web/src/bot-avatar.tsx`、`avatar-style.tsx`、`group-avatar.tsx`；测试 `avatar-motion-sync.test.ts`、`bot-avatar.test.tsx`。
- 入口：`apps/web/src/pages/shell/bot-panel.tsx`（~405）、`avatar-studio-popover.tsx`、`apps/web/src/pages/AccountSettingsOverlay.tsx`（~159）、资料卡（位置 `待核实`）。
- 17 处调用点（UX §1.3）：Shell.tsx 3551/3659/3920/4992/6580/6615/6838；GroupPanel.tsx:56；group-avatar.tsx:55,94；bot-picker.tsx:85；command-palette.tsx:125；ActivityRows.tsx:58；CollaborationMarker.tsx:27；CallCard.tsx:37；PeerMessagesOverlay.tsx:84-85；Artifacts.tsx:605/680/740；bot-panel.tsx:405 + avatar-studio-popover.tsx:120,150。1:1 私聊气泡：新增（位置 `待核实`）。
- 状态来源：Activity Projection；ActivityKind 定义 `packages/core/src/product-harness/activity/types.ts`、`contracts/domain.ts` `ActivityKindSchema`。“新进展”事件（触发 `working.pulse`）的来源 `待核实`（`推测`：Activity Projection 新增条目）。
- e2e：`apps/web/e2e/avatar-studio.spec.ts`、`avatar-style.spec.ts`。

---

## 9. 分阶段任务（每阶段一个 PR，`推测`拆分）

### 阶段 A：契约与分配
- 文件：`packages/contracts/src/bot-avatar.ts`、`domain.ts`、`packages/db/src/repos.ts`、迁移 20261012000000。
- 步骤：定义角色枚举 `dot|treble|wave|bounce` 与存储格式；`pickCharacter(existingBots, botId)` = 最少使用 + 平局 hash；创建时写入；“切换角色”写回；存量 Bot 迁移策略按待确认 3 的结论。
- 验收：单测——前 4 个 Bot 互不重复；平局按 hash 稳定；同 id 多次结果一致；非法值回退默认；UpdateBotInput 校验通过。

### 阶段 B：静态组件 + 16px 状态点 + 映射
- 文件：`agent-avatar/assets/*`（原样复制）、`agent-avatar.tsx`、`status-dot.tsx`、`activity-map.ts`。
- 步骤：内联 SVG 分组；四档尺寸；深色白描边；16px 状态点；13 ActivityKind 映射与多 Run 优先级；aria/tooltip。
- 验收：复制的 SVG 与 final/ 字节一致（diff 为零）；UX 验收 5、6、7（16px 点 6px、描边 1.5px=背景色，浅/深各测）、9、13；size<24 无 symbol 节点；24px+ 无状态点节点；映射/优先级单测全覆盖 13 种。

### 阶段 C：动作引擎
- 文件：`geometry.ts`、`easing.ts`、`motion/*`、`props.tsx`、`director.ts`。
- 步骤：移植 demo（final/demo）为 TS 采样函数；补齐规范而 demo 未实现部分（30s 慢节奏恢复、提醒错开 2s、过渡器、名额得失规则）；道具直接用 `final/assets/props/*.svg`（问号已是路径，原样使用），按 §3.2 放置；瞳孔偏移统一经 `clampPupil(character, dx, dy)`（按 eye-bounds.md 生成常量表，+x ≤0.10R、留 1px、x/y 等比缩短）。
- 验收：
  - 采样单测：抽关键时间点断言数值（如 working 开场 t=60ms sx=1.08/sy=0.92；failed t=1300 后停住；idle 呼吸 sy≤1.035）；全时间轴扫描断言瞳孔始终在眼白内并留 1px（4 角色 × 5 状态 × 招牌动作，+x ≤0.10R）、sx,sy∈[0.90,1.10]、旋转≤5°、symbol 平移≤0.35R/旋转≤15°、feet 无变换、道具在画布内。
  - Director 单测（假时钟）：3 名额优先级；审批提醒 3s/30s/最多 3 次/后台不补发/多头像错开≥2s；pulse ≥2s 丢弃；30s 放慢、新进展恢复；切换 ≤520ms、等落地 ≤420ms、出错可打断。
  - UX 验收 15–20；reduced-motion 显示静态帧（验收 8、19）。
  - 与 demo 及 `final/assets/compare.gif` 并排录屏 5 动作 × 4 角色（差异以规范为准；compare.gif 待机行跳帧，以演示页为准；瞳孔幅度以 §S 为准）。
  - UX 验收 21：所有状态及静帧中瞳孔不超出眼白，向右最多 0.10R，对照 `final/assets/eye-bounds.md` 逐帧测试。
  - UX 验收 22：问号使用 `question.svg` / `question-dark.svg` 的路径数据，无字体依赖、任何系统形状一致；道具 SVG 中无 `<text>` 节点。

### 阶段 D：替换调用点 + 移除 bloub
- 步骤：17 处替换并归到四档；1:1 气泡加 32px 头像；群组合成/输入中/+N 折叠加名字；删除 bloub 目录、组件、测试、LICENSE。
- 验收：UX 验收 5（扫描 size∈{16,24,32,64}）、13、14；仓库无 bloub 代码与第三方 LICENSE；17 处 × 4 档 × 浅/深截图一致。

### 阶段 E：Studio / 上传 / Bot 改头像
- 步骤：资料卡入口；Studio 角色切换 + 上传裁切预览 + 错误态 + 回滚 + 撤销 Toast；Bot 明确指令改头像 + 记录卡 + 撤销；变更记录。
- 验收：UX 验收 2、3、4、10、11、12。

### 全局验收（任务书 §7、开发任务书 §4）
- `pnpm check` 通过；不新增失败测试（main 已有 5 个已知失败）。
- 冻结 SVG 外形无改动（diff）。

---

## 10. 已解决的开工前冲突（2026-10-13 14:37 落盘，14:40 产品专家与 UX专家核对通过）
【来源】任务书决定记录 13:39 / 14:40；UX §14；引擎评估 v2 §7
1. **状态点 vs 道具**：UX 旧 §2“状态一律用右下角状态点” vs MOTION-SPEC“24px+ 用道具”。→ **决定**：24px+ 用角色动作与道具，不画状态点；16px 用状态点。UX §2/§7/验收 7 已改。
2. **验收第 7/8 条**：第 7 条只对 16px 测状态点，24px+ 断言无状态点并出现道具/静态姿态；第 8 条“没有 animation”= **显示 MOTION-SPEC 静态帧**（含 16px 静态点），不是空白。
3. **演示页“新进展”节奏**：演示页不恢复 30s 快节奏 → **以 MOTION-SPEC P 节和 UX 验收 18 为准**，开发勿跟演示。
- 附：UX 待确认第 7 条（32/64 状态点尺寸）作废。
- 流程备注：14:37 改动由 Buzz 越权直接落盘，产品专家与 UX专家已核对保留；此后文档仅由各负责人修改。

## 11. 待确认问题
来自源文档（UX §11，未作废项）+ Buzz 汇编时发现的不一致：
1. 角色存储格式：扩展 `bots.color` 取值还是新增列？（UX 11-2）
2. 存量 Bot 迁移：保留旧色/形状，还是统一按“最少使用”重新分配？（UX 11-3）
3. 账户级 `avatarStyle` 是否保留，与 Bot 级的优先级？（UX 11-4）
4. 1:1 气泡 32px 头像（任务书已列 P0，视为已定；UX 11-5 未勾）。
5. 侧边栏 38→24 的密度变化是否接受？（UX 11-6）
6. ActivityKind 来源（Execution Projection 最新项 vs run 状态推导）；“新进展”事件来源。（UX 11-8）
7. Studio “选中即保存+撤销” vs “预览+Done”（UX 11-9）。
8. 变更记录存哪里、保留多久、撤销几步（UX 11-10）。
9. Bot 改头像的权限级别（建议“仅明确指令”，UX 11-11）。
10. 上传图片继续 base64 存 color 还是走附件 URL（UX 11-13）。
11. 群组合成头像是否用四档、是否显示状态点（UX 11-14）。
12. AI 生成头像是否进 v1（UX 11-12；本 spec 视为不做）。
13. 基线分支：PR #9 现状（是否已合并/被 pr37 取代）。

> 开工前请 RiversXu 下令。

### 已裁决（2026-10-15 10:07 / 11:01，专家确认）
| # | 问题 | 结论 |
|---|---|---|
| 1 | 24px 是否显示头顶符号 | 显示符号和道具（MOTION-SPEC 优先于旧视觉 SPEC） |
| 2 | 16px 状态点 | 直径 6px，描边 1.5px，描边色 = 当前背景色；浅/深模式都测（UX 验收 7 已更新） |
| 3 | 场景↔尺寸 | 以 UX §7 为准 |
| 4 | 16px 是否有脚 | 保留脚（以冻结文件为准） |
| 5 | “当前对话的 Bot 优先”名额次序 | 只在同状态优先级内生效；先按状态分档占槽，同档超额再当前对话优先，仍平手按 Bot id 哈希；不得越级插队（任务书 10-15） |
| 6 | 道具↔头顶符号最小间距 | 下限 0.4R（0.5R 为实测值） |
| 7 | working 静态帧 | 按 v0.6：笔记本显示，瞳孔看屏幕 (+0.09R,+0.07R)，绿光 0.4，光标常亮 |
