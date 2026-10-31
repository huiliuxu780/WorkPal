# 聊天交互验收对照图（挂在 chat-chrome-v1-acceptance.md）

截图目录：本任务目录下的 `refs/`
源：宽度原型 v3 shots + cards-hifi-v3/v4

## 链路一眼看完

| 步 | 图 |
|---|---|
| 整条流（用户气泡 → 页卡 → 更新） | `v3-1440-pages-update.png` / `v3-full-pages-update.png` |
| 旧卡「已在下方更新」 | `v3-1440-stale-card.png` |
| 满屏详情（无版本侧栏） | `v3-fix-page-no-versions.png` / `v3-1440-modal.png` |

## 按验收项

### A. 消息
| # | 图 |
|---|---|
| A1 右对齐 | `v3-fix-user-align.png` |
| A2 主题色底白字 | `v3-fix-user-white.png` |
| A3 接合圆角 | `v3-1440-bot-group.png`、`v3-1440-user-group.png` |
| A4 hover 快捷栏 | `v3-full-hoverbar-bot.png`、`v3-full-hoverbar-user.png` |

### B. 出卡
| # | 图 |
|---|---|
| B1 卡在气泡外 | `v3-fix-page-card.png` |
| B2 列宽 704 | `v3-1440.png`（内容列） |
| B3 卡宽三档 | 宽度原型定档；卡面样式参考 `hifi-v3-overview.png`。**已冻：页面卡 704** |
| B4 整卡 hover 阴影 | `v3-full-card-hover.png` |
| B5 无版本号 | `v3-fix-page-card.png` |
| B6 引用 chip | 宽度原型 `v3-1440-chip.png`（未拷入 refs 时可回 `wp-width-proto/shots/`） |

### C. 更新生命周期
| # | 图 |
|---|---|
| C1 旧卡「已在下方更新」 | `v3-1440-stale-card.png` |
| C2 下方新卡 | `v3-full-pages-update.png` |
| C3 点旧卡开最新 | 与 C1 同卡 + D 满屏；**已冻：开最新** |
| C4 卡面无版本号 | 同 B5 |

### D. 满屏详情
| # | 图 |
|---|---|
| D1 满屏弹层 | `v3-1440-modal.png` / `v3-full-modal-v1.png` |
| D2 无版本侧栏 | `v3-fix-page-no-versions.png`（对；旧「有版本侧栏」反例在 `wp-width-proto/shots/v3-full-modal-versions.png`） |
| D3 关闭回聊天 | 交互项，截静态图不示意；hifi 侧栏关闭参考 `hifi-v4-detail.png` |

### E. 字色
| # | 图 |
|---|---|
| E1 加深档 | `v3-fix-text-darker.png` |

## 卡面补充（非本链路 gate，供对照）
- 各类动作/展示卡：`hifi-v3-overview.png`
- 详情/弹窗/面板：`hifi-v4-detail.png`
