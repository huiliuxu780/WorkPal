# CHAT-CHROME-01 本地交付报告

测试代码 SHA：`13d139d`（`feat(web): render chat chrome page cards and grouped bubbles` 之后的代码 head）
最终本地 head：见交付说明；本报告所在提交只追加 `docs/` 与证据，不改产品代码。
状态：**本地交付，待最终 CI 与审核**（不推远程、不提 PR、不合并、不部署）。

## 1. 基线、原型与确认

| 项 | 记录 |
| --- | --- |
| 基线 | `origin/main` @ `1d72923`（2026-10-29） |
| 实现分支 | `codex/chat-chrome-v1`（独立 worktree） |
| 本地 `main` | `37bb38a`，落后 `origin/main` 361 个提交，未使用 |
| 原型 | `../index-v3-standalone.html`，SHA-256 `0fca21a…` |
| 对照图 | `../refs/`（17 张）；`../chat-chrome-v1-refs.md` |
| 用户确认 | 2026-10-30：原型 + 2026-10-29 签收有效；旧卡桌面宽度按任务书 **704**；暗色走 token，加载/失败按 §3.3/AC-09，焦点/滚动按 §3.3 |

详细记录：`../prototype-confirmation.md`、`baseline/README.md`。

## 2. 实现摘要

- **契约/投影**：`file` 块新增可选 `rootArtifactId`、`version`、`latestVersion`。服务端只把“已有消息关联”的版本计为已发布；`artifacts.getLatest` 用稳定族 ID 解析最新已发布内容，权限范围与原读取一致。
- **读取边界**：快照、历史分页、旧消息统一在 API 侧补齐族/版本字段；前端不以到达顺序、当前已加载集合或请求时间判断最新。
- **消息壳**：内容列 `max-width: 704px` 居中；用户气泡 `chat-user` 实色底 + 白字；连续 Bot 文本首/中/尾接合圆角，卡片、用户消息、其他发送者中断分组；卡片消息独占满列框架。
- **页面卡**：仅私聊 Bot 的 `text/html` `file` 块渲染为满列页面卡；副标“页面”/旧卡“已在下方更新”；整卡 button，hover 阴影、键盘可开；不显示版本/大小。
- **详情**：复用 `Dialog` 近满屏，按稳定族读取最新；加载/失败/主动重试；HTML 保持现有沙箱（`sandbox="allow-scripts"`）；关闭/Esc 回触发卡，聊天滚动位置恢复；详情期间不跟随新消息；下载使用当前展示的最新字节。
- **未做**：批次 5（hover 快捷栏/引用 chip/全局字色）、`cards_unified_v2` 开闸、群聊新设计、其他卡种视觉、数据库迁移、新版本存储。

## 3. 验收结果

| AC | 结果 | 证据与说明 |
| --- | --- | --- |
| AC-01 | 通过 | 1440 长/短用户气泡右对齐、accent 底白字、无横向溢出：`screenshots/batch1-AC01-1440-light-user-bubble.png`、`screenshots/batch1-AC01-1440-light-short-message.png`；390 窄屏 `screenshots/batch4-AC10-390-light-cards.png`；E2E 断言 `rgb(74,102,240)` / `rgb(255,255,255)` 与右边缘对齐 |
| AC-02 | 通过 | scripted 夹具产生 3 条连续 Bot 文本：`screenshots/batch1-AC02-1440-light-bot-group.png`；E2E 计算 `18px/2px` 首/中/尾圆角；`message-bubble-shape.test.ts` 覆盖卡片/用户/其他发送者中断 |
| AC-03 | 通过 | scripted：`screenshots/batch2-AC03-1440-light-first-card.png`；Java AgentScope：`screenshots/agentscope-AC03-first-card.png`；卡片 704、副标“页面”、无版本 UI、hover 阴影、键盘 Enter 打开、卡不在气泡内 |
| AC-04 | 通过 | scripted A/B/C：`screenshots/batch3-AC04-1440-light-updated-cards.png`；Java AgentScope A/B：`screenshots/agentscope-AC04-updated-cards.png`；旧卡固定文案、最新卡唯一有效；族事实见 `runtime/agentscope-thread.json` |
| AC-05 | 通过 | 点旧卡读取 C/D：`screenshots/batch4-AC05-AC06-1440-light-latest-detail.png`、`screenshots/agentscope-AC05-latest-detail.png`；iframe 内实际 `Report C`/`Report B` 断言；`getLatest` 单元/真实 PG 测试 |
| AC-06 | 通过 | 近满屏、无版本 UI、Esc/关闭、焦点回触发卡、滚动位置恢复均在 E2E 断言；截图同上 |
| AC-07 | 通过 | 失败更新保持 A 有效且不出新卡：`screenshots/batch3-AC07-1440-light-failed-update.png`；生成中状态由“无消息的版本不参与 latest”的 `artifact-families.postgres.test.ts` 覆盖 |
| AC-08 | 通过 | 历史页只含旧卡的投影测试：`apps/api/src/artifact-families.postgres.test.ts`（`loadMessagePage` + 旧页 + latestVersion=2）；刷新后旧卡仍打开最新：E2E reload；重复事件/同 id 去重：`packages/core/src/message-pages.test.ts` |
| AC-09 | 通过 | 详情请求失败显示 alert、可关闭、可主动重试恢复：`screenshots/batch4-AC09-1440-light-detail-error.png`；不回落旧内容 |
| AC-10 | 通过 | 1440/1280/390 × 浅/深：`batch4-AC10-1440/1280/390-{light,dark}-cards.png`、`batch4-AC10-390-{light,dark}-detail.png`、`batch4-AC10-1440-dark-detail.png`；列宽 704/704/358，无横向溢出 |
| AC-11 | 通过 | 详情打开期间发布 D：弹层仍显示 C，不跟随；关闭不跳底部；重开旧卡得到 D：`screenshots/batch4-AC11-1440-light-detail-stays-on-C.png` |
| AC-12 | 通过 | `artifact-preview.spec.ts`、`artifacts-tab.spec.ts`、`group-chats.spec.ts` 全绿；页面卡条件限定私聊 Bot HTML，群聊/用户附件/其他文件类型仍走原卡；沙箱属性断言 |

## 4. 运行证据

### 4.1 真实 Java AgentScope + 模型夹具

`apps/web/e2e/chat-chrome-v1.agentscope.spec.ts` 启动真实 `services/agent-runtime`（JDK 21），通过本地 OpenAI-compatible 模型夹具驱动：

- 模型：`openai-compatible` / `offline-fixture`（确定性夹具，不是第三方真实模型）
- 提示词：`Publish report A as report.html and attach it.` / `Update report B in the same report.html and attach it.`
- 工具链：`write_file` → `attach_file` → 最终 `text`；Java Runtime、API、Worker、PostgreSQL、Web 均真实运行
- 事实：`runtime/agentscope-thread.json`（Thread/Run/消息/族版本/每块 `rootArtifactId`/`version`）
- 截图：`screenshots/agentscope-AC03-first-card.png`、`agentscope-AC04-updated-cards.png`、`agentscope-AC05-latest-detail.png`

### 4.2 检查命令与退出码

见 `checks/commands.md`、`checks/green.log`：

- `pnpm check`：18/18 成功
- 定向单元/集成：8 文件 71 测试通过
- PostgreSQL：2 文件 16 测试通过
- Web 构建：通过
- 改动文件 biome：0 error（6 条既有 warning）
- scripted E2E + 回归：7 passed
- Java AgentScope E2E：1 passed

## 5. 已知限制与说明

1. **旧卡宽度**：按用户拍板执行任务书 704；原型/refs 的 528 旧卡不再作为该项依据。
2. **卡面摘要/目录**：原型中的示例 summary/TOC 未复制。当前 `file` 块/交付物契约没有真实摘要或目录字段；卡面只显示真实可得的标题、类型与固定更新文案，正文读取只在详情发生。若必须与原型卡面逐像素一致，需要先补契约或明确摘要来源。
3. **真实第三方模型**：本地没有模型凭据，未调用第三方真实模型；已运行真实 Java AgentScope + 确定性模型夹具。真实模型调用本身不在本次已执行证据内。
4. **AC-08 分页 UI**：历史页投影由真实 PostgreSQL 测试覆盖（`loadMessagePage` + 旧页），未跑 100 条消息的完整 UI 滚动分页；分页读取与快照共用同一 enrichment 函数。
5. **已知名称规则**：现有族规则按 space/user/bot/group + 不区分大小写同名归并，不绑定 Thread。同一名称在不同 Thread 的发布会被视为同族；这是现有后端限制，本期未改。前端只消费后端族关系。
6. **范围**：批次 5 未做；`cards_unified_v2` 未开启；无数据库迁移；不推远程、不提 PR、不合并、不部署。
7. **测试调整**：`group-chats.spec.ts` 的 speaker 定位从宽泛 `div` 收窄到具体 `message-bot-bubble`，原因是新增 704 列包裹层让旧定位同时匹配整列；产品行为未变。

## 6. 证据索引

- 截图：`screenshots/`（20 张，含 scripted 与 AgentScope）
- 主链路连续步骤：`flow/`（scripted 01–07，AgentScope 01–03）
- 运行事实：`runtime/agentscope-thread.json`
- 检查日志：`checks/`
- 基线/原型：`baseline/README.md`、`../prototype-confirmation.md`
