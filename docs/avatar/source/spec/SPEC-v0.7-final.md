# WorkPal Agent 头像视觉规范 v2（配套 MOTION-SPEC v0.7 FINAL，2026-10-18）

> 取代上一版 `SPEC.md`（v1，2026-10-15 更新）。动作、图层、道具以 `MOTION-SPEC.md` 为准；界面里头像放在哪、多大，以 UX 方案为准。
> v1 → v2 的主要变化：去掉黑色小脚；身体从纯黑改为每个 Bot 一种颜色（配色 C）；尺寸表加 18px、35px、58px；渲染改为按头像框 1.25 倍、不裁切；状态点和侧边栏徽标合并为一套语义色（§4，2026-10-19 徐哥确认）。

## 1. 形象
- 唯一形象：RiversXu 原创角色（圆身体、白色大眼、同色系深色瞳孔），**没有脚**。4 种头顶符号：圆点 dot、谱号 treble、波浪 wave、弹跳 bounce。
- 头像本体是 2D 矢量；3D 只用于 ≥120px 的状态插画和空状态。
- 分层：`body` / `eyewhite` / `pupilL` / `pupilR` / `symbol`，眼白恒为 `#FFFFFF`，瞳孔和符号用身体色的同色系深色（MOTION-SPEC §7.2）。
- 源文件：本目录 `<角色>-<颜色>[-s|-xs|-16].svg`，共 4 角色 × 6 色 × 4 档 = 96 个。

## 2. 默认头像分配
- 不用底板，透明底。
- 创建 Bot 时：从四个角色里挑当前用户用得最少的一个；**颜色同样从 6 色里挑用得最少的一个**（平局时都按 `hash(botId)` 取），存进 Bot 表，此后不变。原来就是黑色的 Bot（如 Buzz）固定用墨 ink。
- 前 4 个 Bot 角色互不重复，前 6 个颜色互不重复；之后重复时靠名字区分。
- 头像单独出现（群组合成头像、谁在输入、+N 折叠）时，悬停和读屏都要给出 Bot 名字；同一群里有撞形象的 Bot 时，消息旁的名字不省略。
- 深色模式不反色，身体外加 1.5px 白描边。
- 「重新生成」改为在角色和颜色之间切换，写回 Bot 表。

## 3. 尺寸

| 尺寸 | 场景 | 内容 | 文件 |
|---|---|---|---|
| 16px | 行内提及、活动记录密集列表 | 身体 + 眼，无符号、无道具；状态用 6px 点 | `*-16.svg` |
| 18px | 群聊头像簇的成员 | 身体 + 眼 + 符号，只显示静帧 | `*-xs.svg` |
| 24px | 名字胶囊、对话里的小头像 | 完整（符号、动作） | `*-s.svg` |
| 32 / 35px | 对话气泡、侧边栏列表、收起列（收起列 34.5） | 完整 | `*-s.svg` |
| 58px | 侧边栏网格 | 完整；一次性动作 sy ≤1.12，格子上边距 8px | `*.svg` |
| 64px | 资料卡、信息面板、设置、头像编辑器 | 完整，含道具 | `*.svg` |

- **绘制方式**：SVG 按头像框的 1.25 倍绘制、居中（四边各 −12.5%），容器 `overflow: visible`，不裁切。可见外框在 viewBox 里居中、最长边 92%。
- 侧边栏（右下角有状态徽标的地方）不画道具，状态由徽标表达（MOTION-SPEC §2.4）。
- 上传头像仍是圆形裁切，裁切框 1:1，导出 256px（不套用角色绘制规则）。

## 4. 状态表达（UX 2026-10-18 定稿，见 `WorkPal-agent-avatar-ux.md` §16、验收第 23 条；2026-10-19 徐哥确认）

### 4.1 一套语义色（16px 状态点和侧边栏徽标共用）
| 状态 | 浅色主题 | 深色主题 | 形状 / 符号 | 覆盖的运行态 |
|---|---|---|---|---|
| 运行中 | `#22a356` | `#4ADE80` | 实心点，呼吸 1.6s（opacity 1→0.45；reduced-motion 静止） | working planning tool research delegation handoff background |
| 等审批 | `#d97706` | `#F5C84B` | 实心点；徽标可带待办数字 | approval |
| 等你回答 | `#3F8FDF` | `#7CB8F2` | 实心点 | waiting_input waiting_takeover |
| 失败 | `#e5484d` | `#e5484d` | 点内白色「!」 | failed |
| 完成（短暂显示） | `#22a356` | `#4ADE80` | 点内「✓」 | completed（短暂显示后消失） |
| 无 | — | — | 不显示 | cancelled |

- 运行中和完成同一个绿色，靠 ✓ 区分；失败靠「!」区分。不能只靠颜色区分状态：完成靠 ✓、失败靠「!」、等审批靠数字。**侧边栏任何位置（网格、列表、收起列）都不显示状态文字**，状态只由徽标表达；具体状态名只放在 hover tooltip 和 `aria-label` 里（§4.3）。
- 运行中不用蓝 `#4184f4`：它就是 blue Bot 的身体色，放在蓝 Bot 上看不出来。
- 深色主题的失败色 UX 文档定为和浅色同一个值 `#e5484d`（在 `#1a1a1a` 上对比度 4.45）。
- **符号颜色**（2026-10-19 徐哥确认）：浅色主题符号 / 数字用白色；深色主题除失败外用 `#1a1a1a`（深色主题的点都是浅色，白字对比度只有 1.2–1.7），失败仍用白色。
- 对比度（WCAG 非文本 3:1）：浅色值在白底上 3.19–3.91，深色值在 `#1a1a1a` 上 4.45–10.98，均达标。

### 4.2 尺寸和位置
- **16px 状态点**：直径 6px，右下角，圆心在头像外接圆的 45° 线上；外描边 1.5px（同色相时 2px，见下），颜色 = 当前背景色。24px 及以上的头像本身用动作和道具表达状态（侧边栏除外）。
- **侧边栏徽标**：直径 12–15px（网格 15、列表 13、收起列 12，以 UX 方案为准），右下角，2px 背景色描边（同色相时 2.5px，见下）；等审批带数字时变为胶囊（高 18–19px）。
- **同色相加粗描边**（2026-10-19 徐哥确认）：徽标 / 点的颜色和 Bot 身体色 ΔE（CIE76）< 25，或属于同一色相族（色相角差 < 30°；ink 饱和度低，不算），描边加粗：**徽标 2px → 2.5px，16px 点 1.5px → 2px**。直径和位置不变（描边向外长）。按这条规则，当前 6 色里要加粗的组合（浅色、深色主题相同）：

  | 状态 | 加粗的 Bot 颜色 | 浅色主题 ΔE | 深色主题 ΔE |
  |---|---|---|---|
  | 等审批 | orange、brown | 15.4 / 41.6（色相差 0° / 2°） | 24.0 / 48.4 |
  | 等你回答 | blue | 20.6（色相差 8°） | 37.9 |
  | 失败 | pink | 41.2（色相差 28°） | 41.2 |

  运行中 / 完成的绿色在 6 色上都不加粗。新增 Bot 颜色时按同一规则重算。原因：等你回答 `#3F8FDF` 在蓝 Bot 上、等审批 `#d97706` 在橙 Bot 上，填充色和身体几乎一样（对比度 1.06 / 1.36），只能靠背景色描边分开。描边不能省，也不能改成和身体同色。见 `review-status-colors.png`。

### 4.3 hover 和读屏
- tooltip 写具体状态名（如「正在调用工具」），`aria-label` 同步。

## 5. 主 Bot 标识（P1）
- 左上角 12px 星形徽标，用该 Bot 的大档深色填充 + 2px 背景色描边；16px 不显示。

## 6. 状态插画（P1）
- 13 张 3D 插画一一对应 ActivityKind，只出现在任务详情和空状态。
- 规则：无手指、无眉毛、**无脚**、身体用该 Bot 的颜色、单一强调色（取状态色），1:1 导出 512 / 1024px。
- 已定稿的 working（笔记本）插画需要按无脚 + 配色 C 重出。

## 7. Token
```css
/* 尺寸 */
--wp-avatar-16:16px; --wp-avatar-18:18px; --wp-avatar-24:24px; --wp-avatar-32:32px;
--wp-avatar-35:35px; --wp-avatar-58:58px; --wp-avatar-64:64px;
--wp-avatar-draw-scale:1.25;            /* SVG 绘制尺寸 = 头像框 × 1.25，居中，不裁切 */
/* 身体色 */
--wp-avatar-orange:#e8983a; --wp-avatar-blue:#4184f4; --wp-avatar-purple:#885cf1;
--wp-avatar-brown:#996e42;  --wp-avatar-pink:#e54896; --wp-avatar-ink:#343946;
--wp-avatar-eye:#FFFFFF;
/* 深色（大档 ≥58px；小档、极小档见 MOTION-SPEC §7.2 / assets/palette.json） */
--wp-avatar-orange-dark:#92550e; --wp-avatar-blue-dark:#0641a4; --wp-avatar-purple-dark:#3a0bad;
--wp-avatar-brown-dark:#553d23;  --wp-avatar-pink-dark:#941152; --wp-avatar-ink-dark:#191b22;
/* 道具 */
--wp-prop-card:#F5C84B; --wp-prop-question:#3F8FDF; --wp-prop-question-dark:#7CB8F2; --wp-prop-glow:#4ADE80;
--wp-avatar-shadow:rgba(0,0,0,.10); --wp-avatar-shadow-dark:rgba(0,0,0,.25);
/* 状态语义色（16px 状态点和侧边栏徽标共用；2026-10-19 确认） */
--wp-status-run:#22a356;      --wp-status-run-dark:#4ADE80;
--wp-status-approval:#d97706; --wp-status-approval-dark:#F5C84B;
--wp-status-wait:#3F8FDF;     --wp-status-wait-dark:#7CB8F2;      /* 等你回答 */
--wp-status-fail:#e5484d;     --wp-status-fail-dark:#e5484d;
--wp-status-done:var(--wp-status-run); --wp-status-done-dark:var(--wp-status-run-dark);  /* 加 ✓ */
--wp-status-glyph:#fff;       --wp-status-glyph-dark:#1a1a1a;     /* 失败在深色主题也用 #fff */
/* 侧边栏徽标：只是上面的别名，不再单独取色 */
--wp-badge-run:var(--wp-status-run); --wp-badge-wait:var(--wp-status-approval);
--wp-badge-answer:var(--wp-status-wait); --wp-badge-fail:var(--wp-status-fail); --wp-badge-done:var(--wp-status-done);
/* 描边（颜色 = 当前背景色）；同色相组合用 -strong（§4.2） */
--wp-status-dot-ring:1.5px;   --wp-status-dot-ring-strong:2px;
--wp-badge-ring:2px;          --wp-badge-ring-strong:2.5px;
```
v1 的 `--wp-avatar-body:#111111` 删除。v1 的旧状态色 `#4ADE80`（浅色）、`#F5C84B`（浅色）、`#7CB8F2`（浅色）、`#F28B6B` 和徽标的 `#4184f4`、`#e8983a` 作废：前四个在白底上对比度只有 1.6–2.4，后两个和蓝、橙 Bot 的身体色相同。深色主题下的变量名带 `-dark`。
