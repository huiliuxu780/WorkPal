# SHARE-01 / SHARE-01b 证据报告

分支：`codex/share-01`
基线：`origin/main` @ `66ef4b6ab296f80ca99847f15079f88d012b9023`（REPORT-01 合入后）
代码 head：`893ab7a8`（本报告随后续 docs 提交；主体 head 见 PR #165 历史）
交付形式：**推 #165 可审；CI 绿；合入等徐哥点头**（01b §7）

## 1. 开工选定（任务书 §2.2 要求写进交付说明）

1. **Space 内 URL**：`/app/shared/{spaceId}/{artifactFamilyId}` + `share.openSpace`。第一版曾复用 `/app/artifacts/{familyId}`，但 artifacts 读取 RPC 按 `userId` 过滤，同 Space 的其他成员打不开，违背 sheet 的承诺（PR #165 复审 P2）；改为独立的成员授权只读路由：校验该用户属于链接所在 Space，再读最新已发布页面。artifacts 库本身仍保持 owner 维度，不扩大列表/下载权限。**SHARE-01b 已与负责人确认**：01b §1.5 的字面路径与上述只读/开最新/无下载删除语义冲突，选择保留 `/app/shared` 只读页（2026-11-02 确认）。
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
| `share.openSpace` | 登录 + 该 Space 成员 | Space 链只读：成员校验后返回最新已发布页面；不要求是产物 owner |
| `share.resolvePublic` | **匿名** | 服务端先判撤销/过期，再解析最新已发布页面；失效态不返回正文 |

## 4. 检查结果

| 检查 | 结果 | 日志 / 证据 |
|---|---|---|
| contracts / db / api / web 类型检查 | 0 | — |
| `pnpm --filter @rakazo/contracts test` | 16 files / 147 tests | `checks/contracts.log` |
| `pnpm --filter @rakazo/web test` | 103 files / 816 tests | `checks/unit.log` |
| `apps/api/src/shares.postgres.test.ts` | 10 passed | `checks/postgres-group.log` |
| `pnpm test:postgres`（db-postgres 全组） | 57 files / 497 tests | `checks/postgres-group.log` |
| `pnpm --filter @rakazo/web build` | ✓ built | `checks/build.log` |
| `pnpm test:inventory` | 576 files / 0 errors | `checks/inventory.log` |
| `share-page.spec.ts`（实页 + 匿名上下文 + 视频 + U1–U7） | 1 passed（51.8s） | `checks/e2e.log`、`flow/SH-main-flow.webm` |
| `chat-chrome-v1.spec.ts`（页面卡回归） | 3 passed | `checks/chat-chrome-regression.log` |

本单元是新增能力，无既有缺陷修复，因此**无先红后绿项**。首轮 E2E 两次失败均为测试侧问题（sheet 开启动画未结束时量底边、窄屏下 artifacts 详情标题被响应式隐藏），已改为轮询与桌面视口复测，不涉及产品缺陷。

## 5. AC 结果

| 编号 | 结果 | 证据 |
|---|---|---|
| AC-01 页面卡入口 / 非 page 无入口 | 通过 | `SH-F01-1440-light-entry.png`；卡与详情壳都有入口（E2E 先走详情入口）；分享入口只存在于页面卡、页面详情、`display.page` 三个 page 表面，其它块无挂载点 |
| AC-02 弹出 sheet / Esc 关闭 | 通过 | `SH-F02-sheet.png`；E2E 多次 `Escape` 后断言 sheet 隐藏并继续操作 |
| AC-03 Space 默认在前 / 无公开默认勾选 | 通过 | `SH-F03-space-default.png`；E2E 断言 sheet 内 checkbox 数为 0 |
| AC-04 复制 Space 链 / 同 Space 打开 | 通过 | 剪贴板读到 `/app/shared/{spaceId}/{familyId}`；owner 与**同 Space 第二成员**分别打开并看到只读页；匿名打开被送回登录；`SH-F04-same-space-member.png`、`flow/SH-main-flow.webm` |
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

## 6. 复审修复（PR #165）

| 发现 | 修复 | 回归证据 |
|---|---|---|
| Space 链只有产物 owner 能打开，同 Space 其他成员被 `artifacts.getById/listVersions` 的 `userId` 过滤挡住 | 新增 `share.openSpace` + `/app/shared/{spaceId}/{familyId}` 只读页：先校验请求者属于该 Space，再按 Space 读最新已发布页面；artifacts 库仍保持 owner 维度 | `shares.postgres.test.ts` 新增「成员可读 / 外部人拒绝 / 未发布或非 HTML 拒绝」；E2E 用第二个真实账号（加入同一 Space）打开 Space 链：`SH-F04-same-space-member.png`，匿名打开被送回登录 |

## 7. SHARE-01b · 五项落地 + 入口默认可见

| 项 | 落地 | 证据 |
|---|---|---|
| 3.1 Space 失败态 | `/app/shared/...` 不再重定向：未登录 → 「需要登录」页 + 去登录（`next` 回原链）+ 脱敏卡；已登录非本 Space → 「无法打开」页 + 返回；网络错误单独给重试 | `SH-U1-space-login.png`、`SH-U2-space-wrong.png` |
| 3.2 生成/撤销错态 | 选档步红框「公开链接生成失败，请重试。」+ 重试；已生成步「撤销失败，请重试。」+「链接仍然有效，可稍后再撤。」+ 重试；两套文案不混用 | `SH-U3-gen-fail.png`、`SH-U4-revoke-fail.png`（E2E 用 route abort 造失败再重试成功） |
| 3.3 访客高保真 | `/p/:token` 成功：顶栏「只读 · 有效期至」+ 徽章 + 沙箱只读内容 + 底栏「公开只读页面 · 不含审批或付款」；无效态用 I2 的中性图标与文案 | `SH-U5-visitor-ok.png`、`SH-U6-invalid.png`、`SH-F10/F11` |
| 3.4 更新中 = R1 | 仅 `available === false` 不挂分享（display.page）；页面卡无 unavailable 态。`superseded`（有新版本）映射为「更新中」：分享可点，sheet 对象区注「链指向当前已发布版本（开最新）。」；组件测试锁住 unavailable 无入口 / available 有入口 | `SH-U7-updating-sheet.png`；`DisplayBlockView.test.tsx`、`ArtifactPageCard.test.tsx` |
| 3.5 i18n | 本波新增/改动文案全部走 `t\`\``，逐条对齐 `I18N.md`（Space 失败、G/H、R1 note、访客 banner、关闭/加载）；未新增非 `t` 的中文串、未扩文案设计 | 代码 + `I18N.md` 对照 |
| 3.6 入口默认开 | 分享入口不挂 `cards_unified_v2`（也未改任何 gate 默认值）；页面卡/详情/`display.page` 在默认配置可见。share e2e 本身在 gate-off 批次运行，整条分享路径即默认配置证据 | `SH-F01-1440-light-entry.png`、`SH-U7-updating-sheet.png` |

**R1 状态映射说明**：产品当前没有独立的「更新中」字段；`ArtifactPageCard` 的 `superseded`（同一页面已有更新版本）就是用户能遇到的「更新中/已在下方更新」状态，分享链本就读最新已发布版本，因此在该卡上给出「开最新」注。`DisplayBlockView` 的 `available=false` 才隐藏分享。无其它 loading 策略，未发明 R2/R3。

## 8. SHARE-01b U 矩阵

| ID | 结果 | 证据 |
|---|---|---|
| AC-U1 未登录打开 Space 链 | 通过：需要登录页 + 去登录（href 带 `next=%2Fapp%2Fshared%2F...`）+ 返回 | `SH-U1-space-login.png` |
| AC-U2 他 Space 账号打开 | 通过：无法打开页 + 脱敏卡 + 返回 | `SH-U2-space-wrong.png` |
| AC-U3 生成失败 | 通过：route abort → 红框 + 重试；重试后生成成功；文案 ≠ 撤销 | `SH-U3-gen-fail.png`、`checks/e2e.log` |
| AC-U4 撤销失败 | 通过：route abort → 撤销失败 + 链接仍有效；重试后撤销成功 | `SH-U4-revoke-fail.png` |
| AC-U5 匿名有效 `/p/:token` | 通过：只读顶栏 + 有效期 + 内容 + 底栏；无写/审批/付款 | `SH-U5-visitor-ok.png`、`SH-F13-readonly.png` |
| AC-U6 无效 token | 通过：失效页 | `SH-U6-invalid.png` |
| AC-U7 页面 updating | 通过：superseded 卡仍可分享，sheet 有开最新注 | `SH-U7-updating-sheet.png` |
| AC-U8 `available=false` | 通过（组件测）：`display.page` 无分享入口 + 不可用提示 | `DisplayBlockView.test.tsx` |
| AC-U9 默认配置可见分享 | 通过：share e2e 在 gate-off 批次全流程（默认配置）；入口不挂 gate | `SH-F01`、`SH-U7`；报告 §7.3.6 |
| AC-U10 原 SHARE 回归 | 通过：确认步、档位 ≤90、一页一链、撤销/过期仍绿 | `checks/e2e.log`，原 F 系列截图 |

## 9. 明确未做

- 未默认开公开分享；未提供「永不过期」；未扩 display 其它块。
- 未给公开链写/审批/付款能力；未做第二任务中心 / Attention 入口。
- 未默认开启 `cards_unified_v2`，未改任何 gate 默认值。
- 未合 main、未部署（等徐哥点头）；已推 `codex/share-01` 并在 #165 可审。

## 10. 证据索引

```text
evidence/
  report.md
  baseline/README.md
  checks/{contracts,unit,postgres-group,build,inventory,e2e,chat-chrome-regression}.log
  screenshots/SH-F01…SH-U7（25 张实页截图，含 F1/F2、G/H 错态、访客壳、更新中）
  flow/SH-main-flow.webm（分享 → Space 复制 → 默认配置入口 → 公开确认 → 生成失败/重试 → 7 天生成 → 撤销失败/重试 → 失效/过期 → 同 Space 成员/非成员/未登录 → 更新中 → 390/375）
  runtime/share-links.txt（迁移记录 + 脱敏后的 share_links 状态）
```
