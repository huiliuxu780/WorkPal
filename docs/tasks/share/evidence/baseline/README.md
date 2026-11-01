# SHARE-01 基线

- 分支：`codex/share-01`
- 基线：`origin/main` @ `66ef4b6ab296f80ca99847f15079f88d012b9023`
  （REPORT-01 合入后的 main，2026-11-01）
- 开工重核（相对基线）：
  - `DisplayBlockSchema` 有 `kind:"page"`，**无** share 字段；
  - `Artifact` 表**无** token / expiresAt / revoked；
  - RPC **无** `share.*`；`App.tsx` **无** `/p/:token`；
  - `PageDisplay` 只有 `Open page` 链接；`ArtifactPageCard`（Chat Chrome 页面卡）只有打开/下载；
  - `SandboxedHtmlViewer` 的 CSP + sandbox 可直接复用于公开访客页。
- 迁移：`20261101160000_share_links`（新增 `share_links` 表）。
- gate：**未**挂 `cards_unified_v2`，也未改任何 gate 默认值（决定与理由见 `report.md`）。
