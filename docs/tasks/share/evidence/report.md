# SHARE-01 证据报告

分支：`codex/share-01`
基线：`origin/main` @ `66ef4b6ab296f80ca99847f15079f88d012b9023`（REPORT-01 合入后）
代码 head：`62dbde85`（证据与报告随后续 docs 提交）
交付形式：**本地交付，待最终 CI 与审核**（任务书 §8）

## 1. 开工选定（任务书 §2.2 要求写进交付说明）

1. **Space 内 URL**：复用登录态 `/app/artifacts/{artifactFamilyId}`。打开动作仍走既有 artifacts RPC，天然要求登录 + 本 Space + 该产物属主；分享 RPC 另外校验 owner/space/scope。不新造 `/s/...` 短链，避免第二套权限面。
2. **公开 URL / 路由**：`/p/{token}`，token 为 32 字节随机数的 base64url（43 字符），不可枚举；`App.tsx` 新增匿名可访问路由。
3. **DB**：新增 `ShareLink`（`share_links`）：token、spaceId、userId、artifactFamilyId、artifactName（仅标题）、botId/groupId、expiresAt、revokedAt。**不**拷贝页面正文；无外键，页面族或 Bot 删除后 token 仍落到失效态而不是报错。
4. **过期档位**：服务端只接受 `24h / 7d / 30d / custom(1–90)`；`custom` 必须给天数，`>90`/`<1` 服务端拒绝。契约里**不存在**「永不过期」或客户端自定义 `expiresAt` 的入口。
5. **一页一链**：同一页面族再次生成时先撤销旧链再建新链（advisory lock 串行化），保证「已有公开链 · 管理」所指明确。
6. **Gate**：**不挂** `cards_unified_v2`。分享入口挂在既有页面卡与详情壳上（Chat Chrome 已在 main），服务端能力独立；挂到卡片 gate 会让整个能力在默认配置下不可见，属发布决策，不在本单元擅自打开或绑定。**未改任何 gate 默认值**。

## 2. 迁移与回退

- 迁移：`packages/db/prisma/migrations/20261101160000_share_links/migration.sql`
  - `share_links(token UNIQUE, spaceId, userId, artifactFamilyId, artifactName, botId, groupId, expiresAt, revokedAt, createdAt)` + 两个索引。
- 回退：删除该表并移除迁移记录即可（无数据回填、无既有表变更）。应用代码需随分支一并回退：
  `DROP TABLE "share_links"; DELETE FROM "_prisma_migrations" WHERE migration_name = '20261101160000_share_links';`
- 实库验证：E2E 数据库迁移记录见 `runtime/share-links.txt`。

## 3. 合约 / RPC 清单

`packages/contracts/src/share.ts` + `rpc.ts`:

| RPC | 权限 | 行为 |
|---|---|---|
| `share.get` | 登录 + owner/space/scope | 返回 `{ familyId, publicLink }`；publicLink 只含未撤销且未过期的链 |
| `share.createPublic` | 登录 + owner/space/scope | 校验页面为最新已发布 `text/html`；撤销旧链后生成新链；到期时间由服务端计算 |
| `share.revoke` | 登录 + owner/space | 幂等撤销该页面族当前公开链；不依赖页面仍可读 |
| `share.resolvePublic` | **匿名** | 服务端先判撤销/过期，再解析最新已发布页面；失效态不返回正文 |

## 4. 检查结果

| 检查 | 结果 | 日志 / 证据 |
|---|---|---|
| contracts / db / api / web 类型检查 | 0 | — |
| `pnpm --filter @rakazo/contracts test` | 16 files / 147 tests | `checks/contracts.log` |
| `pnpm --filter @rakazo/web test` | 101 files / 812 tests | `checks/unit.log` |
| `apps/api/src/shares.postgres.test.ts` | 8 passed | `checks/postgres-group.log` |
| `pnpm test:postgres`（db-postgres 全组） | 57 files / 495 tests | `checks/postgres-group.log` |
| `pnpm --filter @rakazo/web build` | ✓ built | `checks/build.log` |
| `pnpm test:inventory` | 0 errors | `checks/inventory.log` |
| `share-page.spec.ts`（实页 + 匿名上下文 + 视频） | 1 passed（24.5s） | `checks/e2e.log`、`flow/SH-main-flow.webm` |
| `chat-chrome-v1.spec.ts`（页面卡回归） | 3 passed | `checks/chat-chrome-regression.log` |

本单元是新增能力，无既有缺陷修复，因此**无先红后绿项**。首轮 E2E 两次失败均为测试侧问题（sheet 开启动画未结束时量底边、窄屏下 artifacts 详情标题被响应式隐藏），已改为轮询与桌面视口复测，不涉及产品缺陷。

## 5. AC 结果

| 编号 | 结果 | 证据 |
|---|---|---|
| AC-01 页面卡入口 / 非 page 无入口 | 通过 | `SH-F01-1440-light-entry.png`；卡与详情壳都有入口（E2E 先走详情入口）；分享入口只存在于页面卡、页面详情、`display.page` 三个 page 表面，其它块无挂载点 |
| AC-02 弹出 sheet / Esc 关闭 | 通过 | `SH-F02-sheet.png`；E2E 多次 `Escape` 后断言 sheet 隐藏并继续操作 |
| AC-03 Space 默认在前 / 无公开默认勾选 | 通过 | `SH-F03-space-default.png`；E2E 断言 sheet 内 checkbox 数为 0 |
| AC-04 复制 Space 链 / 同 Space 打开 | 通过 | 剪贴板读到 `/app/artifacts/...`；结尾在同一账号打开该链并断言页面标题；`flow/SH-main-flow.webm` |
| AC-05 公开入口进独立确认 | 通过 | `SH-F05-to-confirm.png` |
| AC-06 取消回 Space / 确认无 checkbox | 通过 | `SH-F06-confirm.png`；E2E 取消后断言回到「分享页面」 |
| AC-07 仅四档 / 无永不过期选项 | 通过 | `SH-F07-chips.png`；断言四颗芯片可见、无「永不过期」按钮 |
| AC-08 自定义 120 拦截 / 14 可生成 | 通过 | `SH-F08-custom-cap.png`；生成按钮 disabled→enabled；`flow/SH-main-flow.webm` |
| AC-09 选 7 天生成并复制 | 通过 | `SH-F09-generated.png`；剪贴板内容等于公开 URL |
| AC-10 撤销后匿名打开失效 | 通过 | `SH-F10-revoked.png`；匿名上下文拿到 `data-state=revoked`，无正文 |
| AC-11 已过期 token 打开 | 通过 | `SH-F11-expired.png`；服务端判过期，无正文 |
| AC-12 生成后回 Space 步见已有链 | 通过 | `SH-F12-manage.png`；点「管理」回到已生成步并可撤销 |
| AC-13 匿名只读成功 | 通过 | `SH-F13-readonly.png`；顶栏「只读」，正文在既有沙箱 iframe 内，无写/审批/付款控件 |
| AC-14 脱敏 | 通过 | `SH-F14-desense.png`；E2E 断言 sheet 不含页面正文标记与金额；失效卡只显示标题 +「页面 · 只读 · 已撤销/已过期」 |
| AC-15 其它 display 块无分享 | 通过（代码边界） | 分享入口仅挂在 page 卡 / page 详情 / `display.page`；table/chart/html/media/task_status 无挂载点。E2E 未单独造这些块（scripted runtime 无对应 fixture） |
| AC-16 390 / 375 贴底、无横溢 | 通过 | `SH-F16-390.png`、`SH-F16-375.png`；断言 `scrollWidth-clientWidth ≤ 1`、sheet 底边贴视口 |
| AC-17 深色可读 | 通过 | `SH-F17-dark-space.png`（data-theme=dark） |
| AC-18 非任务中心 | 通过 | `SH-F18-no-task-center.png`；全程无 `attention-queue`，未跳 Attention |

## 6. 待 UI 五项（未发明正式视觉）

1. Space 打开失败（未登录/非本 Space）：服务端拒绝；前端只有通用加载失败提示。
2. 生成/撤销/网络失败的 sheet 内错态：最小诚实文案 + 可重试，未做美化稿。
3. 公开访客成功壳：复用现有 `SandboxedHtmlViewer` + 顶栏「只读」，未另造访客设计语言。
4. 页面「更新中/不可用」时分享按钮策略：`available=false` 的 page 表面不渲染分享入口；其它 loading 策略未做。
5. i18n 终稿键表：本波按可点稿用中文源串占位，未扩文案设计。

## 7. 明确未做

- 未默认开公开分享；未提供「永不过期」；未扩 display 其它块。
- 未给公开链写/审批/付款能力；未做第二任务中心 / Attention 入口。
- 未默认开启 `cards_unified_v2`，未改任何 gate 默认值。
- 未推远程、未提 PR、未合 main、未部署（等授权）。

## 8. 证据索引

```text
evidence/
  report.md
  baseline/README.md
  checks/{contracts,unit,postgres-group,build,inventory,e2e,chat-chrome-regression}.log
  screenshots/SH-F01…SH-F18（17 张实页截图，1440/390/375，含深色）
  flow/SH-main-flow.webm（分享 → Space 复制 → 公开确认 → 7 天生成 → 复制 → 撤销失效 → 过期 → 390/375）
  runtime/share-links.txt（迁移记录 + 脱敏后的 share_links 状态）
```
