# CONNECTIONS-01 证据报告

分支：`codex/connections-01`
基线：`origin/main` @ `7457961b4018e18248732f8df2bb577ce5cb3b23`（SHARE 合入后）
代码 head：`29dd743a`（本报告随后续 docs 提交）
交付形式：**推 PR / CI；不自行 merge，等徐哥点头**（任务书 §8）

## 1. 开工决策

1. **`description?`**：`ConnectionCatalogItemSchema` 增加可选 `description`；adapter 类型复用该合约。当前 Composio `toolkits()` 与 Pipedream app 目录都**不下发** description，因此目录瓦片一律名称-only、描述槽不渲染，**无占位假文案**（AC-CN06）。不做 provider 侧编造。
2. **信息架构**：已连接（active = connected 或 pending；0 则整段隐藏）→ 推荐（featured 去掉 active，含 featured 缺目录项）→ MCP 通栏卡 → 全部应用（非 featured 且非 active，`CONNECTION_CATALOG_PAGE_SIZE=60` 分页）→ Advanced 折叠。
3. **Chip**：`全部应用`（目录总数）与 `已连接`（active 数）；与搜索可组合。chip 激活时展示平铺结果，不显示分段；0 已连接时「已连接」chip 可点并给空提示。**无**品类 chip。
4. **EmptyHero**：仅 `!loading && !loadError && catalog.length === 0`。四层：三枚字母瓦片 + 标题/价值陈述 + McpEntryCard + 兜底句。加载态只有加载行；加载失败是 `destructive` 错误 + 重试，**不闪 EmptyHero**。
5. **McpEntryCard**：替代旧孤立按钮；副行二选一（新手价值句 / `{n} tool sources configured`，无假「上次连接时间」）；打开既有 `IntegrationSetup`，busy 整卡禁点。
6. **Detail**：状态 pill（圆点 + 文字）、AccountRow（字母头像 + 改名 + 单账户移除）、ToolList 两列（`humanizeToolName` + description 最多两行，缺失只留名）、卸载保持**无确认**；内容最大宽 720。
7. **i18n**：现有空 msgstr（Browse MCP servers / Accounts / Tools / Uninstall / Added / Add another / Loading tools… / No tools available. / Search by domain）补齐；新文案全部走 `t``/`Trans`，并以 lingui 字面量补入 zh-CN 与 en 目录。
8. **不改**：侧栏仍「集成」；`McpServersOverlay` / `IntegrationSetup` 只保入口；OAuth popup 模型、PAGE_SIZE、Advanced 结构不变；无产品 gate。
9. **e2e testid 保留**：`featured-connectors`、`connection-tile-{slug}`（仍仅已连接）、`integrations-advanced`、`integrations-advanced-add`、`connection-detail` / `connection-accounts` / `connection-tools`。新增 `integrations-chips` / `integrations-filter-all` / `integrations-filter-connected` / `integrations-empty-hero` / `integrations-mcp-entry` / `integrations-connected-section` / `integrations-all-apps` / `integrations-load-error` / `connection-tile-description`。

## 2. 检查结果

| 检查 | 结果 | 日志 |
|---|---|---|
| contracts / core / adapters / api / web 类型检查 | 0 | `checks/typecheck.log` |
| `@rakazo/contracts test` | 16 files / 147 tests | `checks/contracts.log` |
| `@rakazo/core test`（含新 helpers） | 80 files / 986 passed / 5 skipped | `checks/core.log` |
| `@rakazo/web test` | 103 files / 816 tests | `checks/unit.log` |
| `pnpm --filter @rakazo/web build` | ✓ built | `checks/build.log` |
| `pnpm test:inventory` | 578 files / 0 errors | `checks/inventory.log` |
| e2e 回归：golden + graphql-integrations + mcp-oauth | 6 passed | `checks/regression-e2e.log` |
| e2e：connections-ui | 1 passed（9.3s，含视频） | `checks/connections-e2e.log`、`flow/CN-flow.webm` |

本单元无既有缺陷修复，无先红后绿项；新逻辑的纯函数（featured 判定 / 搜索匹配）有单测。

## 3. AC 结果

| 编号 | 结果 | 证据 |
|---|---|---|
| AC-CN01 壳与入口 | 通过：Dialog 1080×760、标题集成、Esc 返回 | `CN-01-shell-open.png` |
| AC-CN02 EmptyHero | 通过：四层 + MCP 卡 + 兜底；不闪空态 | `CN-02-empty-hero.png` |
| AC-CN03 IA 分段 | 通过：已连接 → 推荐（去掉已连）→ MCP 卡 → 全部应用；已连胶囊含账户数 | `CN-03-ia-segments.png` |
| AC-CN04 chip + 搜索 | 通过：已连接 chip 只见已连；搜索无命中提示 | `CN-04-chips-search.png` |
| AC-CN05 添加连接 | 通过：推荐添加 → 已连接；`connection-tile-*` 可定位 | `flow/CN-flow.webm`、`checks/regression-e2e.log` |
| AC-CN06 无描述 | 通过：目录无 description → 不渲染描述槽、无假文案 | `CN-06-no-desc.png`；`connection-tile-description` 计数 0 |
| AC-CN07 MCP 入口卡 | 通过：点击打开既有 IntegrationSetup | `CN-07-mcp-entry.png` |
| AC-CN08 详情 | 通过：状态 pill、账户行改名、工具两列+描述、卸载；无确认框 | `CN-08-detail.png` |
| AC-CN09 移除账户 / 卸载 | 通过：单账户 vs 整应用；无 alertdialog | `flow/CN-flow.webm` |
| AC-CN10 Advanced → MCP 管理 | 通过：折叠在、McpServersOverlay 打开 | `CN-10-advanced-mcp.png` |
| AC-CN11 zh-CN | 通过：账户 / 工具 / 卸载 / 浏览 MCP 服务器 / 推荐 等中文 | `CN-11-i18n-zh.png` |
| AC-CN12 回归 | 通过：golden 4 + graphql + mcp-oauth | `checks/regression-e2e.log` |
| AC-CN13 加载失败 | 通过：加载失败错误 + 重试；不出现 EmptyHero | `CN-13-load-error.png` |
| AC-CN14 0 已连接 | 通过：已连接段隐藏；chip 可点并给空提示 | `CN-14-zero-connected.png` |

## 4. 复审修复（PR #166）

| 发现 | 修复 |
|---|---|
| 搜索分支一次挂载全部命中项，绕过 `CONNECTION_CATALOG_PAGE_SIZE`（宽搜索/按 connectorId 可命中数千项） | 搜索与「已连接」chip 结果同样按 `visibleCount` 分页并提供 Show more；与「全部应用」段共用同一个按钮，切换 chip/搜索时重置页数 |
| en 目录的 `{toolCount} tools` 占位符仍写 `{0}`，英文界面显示不出真实数量 | en msgstr 改为 `{toolCount} tools`；zh 保持 `{toolCount} 个工具` |

## 5. 已知边界（如实说明）

- **没有 provider 下发 description**：Composio toolkit list 与 Pipedream app 类型都没有该字段；所以当前实际目录全部 name-only。合约/UI 路径已通，等 provider 有货即可显示，未写假描述。
- **failed 状态**：ConnectionStatus 支持 failed（tile / account row），但连接 RPC 不返回失败原因，因此未做 DS 的「查看原因」链接；不发明原因文案。
- **chip 组合**：chip 是目录过滤；「已连接」chip 下为平铺结果，无分段；搜索在两种 chip 下都生效。已在 e2e 覆盖。
- 目录空/失败的截图在 zh 语境（同一套产品页）；英文默认语境的截图见 CN-01/03/04/06/08。

## 6. 明确未做

- 未重做 `McpServersOverlay` / `IntegrationSetup` 视觉；未改 OAuth popup 协议；未加卸载确认；未改 PAGE_SIZE；未改侧栏「集成」文案。
- 未发明分类 taxonomy / 第三方 Logo / 连接专用色盘；未混入 SHARE / REPORT / BRAND。
- 未自行 merge。

## 7. 证据索引

```text
evidence/
  report.md
  baseline/README.md
  checks/{typecheck,contracts,core,unit,build,inventory,regression-e2e,connections-e2e}.log
  screenshots/CN-01,02,03,04,06,07,08,10,11,13,14
  flow/CN-flow.webm（打开 → 分段 → chip → 添加 → 详情改名 → 移除/卸载 → MCP 卡 → Advanced MCP → zh → 空态/错误 → 0 已连接）
```
