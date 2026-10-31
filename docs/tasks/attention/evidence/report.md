# ATTENTION-01 证据报告

分支：`codex/attention-01`（本地交付）
基线：`e3b22db`，其 tree 与 `origin/main` @ `4767b3c` 完全相同（`8bfa4c9`）；网络恢复后可做一次 fetch 校验，PR 的 merge-base 也是该提交。

## 本轮改了什么

`765c31a`：

- 文案：入口/浮层标题 → 待处理；副标 → 仅本人待处理；空态 → 没有需要你处理的事项；aria-label 同步。
- 图标：Lucide `Bell` → Phosphor 警示三角（与原型 `#attBtnTop` 的 path 一致）；chevron → Phosphor `CaretRight`；行内改为按 kind 的 Phosphor 图标。
- 行内井：去掉 `bg-muted` 托盘（对齐原型 `.ic = rgba(0,0,0,0)`）。
- **AT-F13**：新增窄屏顶栏「待处理」入口与角标；`md` 以上侧栏、`md` 以下顶栏，同一时刻只有一个实例轮询与通知。

## 检查结果

| 检查 | 结果 | 日志 |
|---|---|---|
| `pnpm --filter @rakazo/web check` | 0 | — |
| `pnpm --filter @rakazo/web test` | 101 files / 808 tests passed | — |
| `biome check` 改动文件 | 0 error | — |
| `card-attention.spec.ts`（gate 开） | 2 passed（1.6m） | `checks/e2e-attention.log` |

截图：`screenshots/`（1440x900、375、390）。

## AC 逐条

| AC | 状态 | 依据 |
|---|---|---|
| AT-F01 侧栏顶入口 | 通过 | 既有入口 + 本轮文案；e2e 可见 |
| AT-F02 角标 0 隐藏 / 99+ | 通过 | 代码 `total > 99 ? "99+"`；e2e 断言计数 1 → 结算后消失 |
| AT-F03 浮层非整页 / 宽 360 | 通过 | `w-[min(360px,calc(100vw-24px))]`；e2e 1440 与 375 截图 |
| AT-F04 成员范围 | 通过 | 既有 e2e 断言行内不含 `Intervention`；投影只列 pending Interaction |
| AT-F05 排序 expiresAt 优先 | 未专项实跑 | 合约 `compareAttentionItems` 已冻结并有用例；本轮未造带 expiresAt + 无过期的混合队列 |
| AT-F06 去重 interactionId+revision | 通过 | `attentionKey`；合约 `attentionDedupeKey` |
| AT-F07 点行跳回原卡 | 通过 | e2e：URL 带 `i=`，焦点落在 `data-interaction-id` |
| AT-F08 结算后消失 | 通过 | e2e：源卡提交后角标归零 |
| AT-F09 空态 | 通过 | 单测断言新文案；不保留完成历史 |
| AT-F10 过期/失权移除 | 未专项实跑 | 服务端 expiry + 轮询；本轮未造过期条目 |
| AT-F11 加载/错误/重试 | 通过 | 单测覆盖 loading / error + Retry |
| AT-F12 通知脱敏 / 前台不推 | 通过 | e2e：固定正文、不含问句原文/`@`/数字/路径；权限拒绝用例 |
| AT-F13 窄屏顶栏入口 | 通过 | 本轮新增；e2e 断言 `data-variant="topbar"` 且浮层 375 无横溢 |
| AT-F14 gate 关无入口 | 通过 | `enabled=false` → 组件返回 null（单测） |
| AT-F15 成员面板跳回同源 | 代码核实，未实跑 | `waitingMembers` 由 `attentionItems` 按群 + botId 投影，面板走 `onOpenAttentionItem` |
| AT-F16 列表只跳回 | 通过 | 行内无输入/审批控件，仅有跳转 |

## 已知取舍

窄屏按断点换实例：**浮层打开时跨过 768 断点会随触发器关闭**。本批接受；共享 hook 的双触发器方案另开任务。
