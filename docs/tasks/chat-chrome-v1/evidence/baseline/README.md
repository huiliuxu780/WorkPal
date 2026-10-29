# 基线记录

| 项 | 值 |
| --- | --- |
| 基线分支 | `origin/main` |
| 基线 SHA | `1d72923`（Merge PR #158，2026-10-29） |
| 本地 `main` | `37bb38a`（2026-10-23），落后 `origin/main` 361 个提交；未使用 |
| 实现分支 | `codex/chat-chrome-v1` |
| 工作区 | 独立 worktree，未带入 `test` 分支的未提交内容 |

## 为什么没有 `red.log`

这是新链路交付，不是既有 bug 修复。基线 `origin/main` 上缺少：

- 页面交付物卡（HTML `file` 块仍走紧凑文件卡）
- 交付物族 `latestVersion` 投影与 `artifacts.getLatest`
- 704 内容列、Bot 首/中/尾接合圆角
- 近满屏详情按稳定族读最新、详情期间不跟随新消息

因此没有“同一回归用例先红后绿”的适用项；功能验收由 `report.md` 的 AC 结果、Java AgentScope E2E、scripted E2E 和 PostgreSQL 投影测试提供。原型缺口（暗色、加载/失败态、弹层焦点）在 `prototype-confirmation.md` 记录并由契约实现补齐，不是既有产品 bug。

## 原型基线（2026-10-30 实测）

- 原型：`index-v3-standalone.html`，SHA-256 `0fca21aa3cc3fdb767acb07289852fe07c9cc77cbd26fec23653b3192d6ec243`
- 1440/1280：内容列 752（含 24px gutter），有效页面卡 704，旧卡 528
- 390：内容列 390，有效/旧卡 358，无横向溢出
- 旧卡、旧卡文案、气泡 chip 均打开同一份最新内容；Esc 可关；聊天滚动保持
- 缺口：无暗色、无加载/失败态、弹层无焦点陷阱且关闭不回触发卡

用户确认：旧卡桌面宽度按任务书 **704**，不采用原型/refs 的 528；其余旧卡卡壳样式沿用原型。详见 `../prototype-confirmation.md`。
