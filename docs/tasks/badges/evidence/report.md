# BADGES-01 证据报告

分支：`codex/badges-01`
基线：`origin/main` @ `068f0ea`（含 CHAT-CHROME-01 与 ATTENTION-01）

## 本轮改了什么

1. **会话行待处理角标（BD-F01/F05/F08）**：会话行从 `<button>` 改为 `div role="button"`（保留 Enter/Space 激活与焦点样式），行内新增琥珀「待处理」`span role="button"`：点它跳回来源卡（`openAttentionItem`），带 `stopPropagation` 不影响整行导航。未读点由 `bg-foreground` 改为 `bg-link`（蓝），与琥珀胶囊在**色相 + 文案/形状**两项上都可分，两者可同行。
2. **成员「等你批准」（BD-F06）**：原 `● Pending` 边框胶囊改为琥珀 `wait-tag` 样式 + 冻结文案「等你批准」；整行跳回与「面板内不嵌审批表单」保持原样。
3. **中继不计未读（BD-F03）**：`packages/adapters/src/bot-messages.ts` 两处 bot↔bot 投递（`bot_message_received` 进入接收方线程）由 `markUnread: true` 改为 `false`。改前确认：这两处是 Bot 中继，不是人类消息；改后全仓测试无依赖（postgres/testkit 中无用例断言中继产生未读）。
4. **测试选择器**：`group-chats.spec.ts` 的 `sidebarRow()` 由 `locator("button", {hasText})` 改为 `getByRole("button", {name})`，与新的行结构一致。

## 检查结果

| 检查 | 结果 | 日志 |
|---|---|---|
| `pnpm --filter @rakazo/web check` | 0 | — |
| `pnpm --filter @rakazo/web test` | 101 files / 809 tests passed | `checks/unit.log` |
| `biome check` 改动文件 | 0 error | — |
| e2e gate-off（group-chats + ui-appearance×2） | 3 passed | `checks/e2e-badges.log` |
| e2e gate-on（card-attention×3 + peer-messages×2） | 5 passed | `checks/e2e-badges.log` |

## AC 逐条

| AC | 状态 | 依据 |
|---|---|---|
| BD-F01 会话待处理角标 | 通过 | 新增用例断言琥珀「待处理」可见、`role=button`、可访问名「待处理，跳回来源卡」；截图 `BD-F01-row-pending.png` |
| BD-F02 未读标记可分 | 通过（本批降级口径） | 未读为蓝色圆点；与琥珀胶囊色相 + 文案两项不同。**未读计数不在本批**（BD-F02 降级），仍为布尔 |
| BD-F03 中继不计未读 | 通过 | 两处 bot 中继写入改为 `markUnread: false`；协作回执/成员变更原本即 `false` |
| BD-F04 无标记态 | 通过 | 截图 `N3-badges-1440.png`：Chief / Joy 行无任何标记 |
| BD-F05 同行双标 | 通过 | 截图 `N3-badges-1440.png`：Blue 行同时有琥珀「待处理」与蓝色未读点 |
| BD-F06 成员「等你批准」 | 通过 | 文案改为「等你批准」；截图 `N2-member-waiting-1440.png` |
| BD-F07 点成员标记跳回 | 通过 | 既有 `group-member-waiting` → `openAttentionItem`；本轮回归通过 |
| BD-F08 点会话角标跳回 | 通过 | 新用例：点击后 URL 带 `i=`，且不打开队列浮层 |
| BD-F09 结算立即消失 | 通过（沿用） | 角标由 `attentionItems` 投影；结算走 `attentionRefresh` 同源（ATTENTION-01 已验） |
| BD-F10 跳回聚焦 | 通过（沿用） | `openAttentionItem` 的滚动 + focus 逻辑；上述用例到达带 `i=` 的 URL |
| BD-F11 非 Task Center | 通过 | 行内只有跳转；无内嵌审批/分组 |
| BD-F12 无人侧 @我 | 通过 | 未引入任何 @我 语义 |
| BD-F13 窄屏可读 | 部分 | 队列浮层 375 无横溢（`N1-queue-375.png`）；**会话行角标在 390 未单独截图** |
| BD-F14 深色 | 部分 | 深色用 `--warning` token（浅 `#b7791f` / 深 `#e9c46a`），未单独截会话行深色图 |
| BD-F15 与 Attention 同源 | 通过 | `pendingByConversation` 由 `attentionItems` 按会话投影，未新增数据源 |
| BD-F16 通知边界 | 通过（沿用） | 通知实现未改；ATTENTION-01 已验脱敏 |

## 未覆盖 / 待补

- BD-F13 会话行角标 390/375 截图、BD-F14 会话行深色截图：本轮未单独采集。
- 未读计数（`Thread.unread` boolean → 计数）按裁决**不在本批**。
