# FOUR-SHELLS-01 证据报告

分支：`codex/four-shells-01`（本地交付，未推远程）
基线：`origin/main` @ `f95130d`（含已合入的 CHAT-CHROME-01 / PR #159）
实现 head：见 `git log --oneline codex/four-shells-01`

## 本轮做了什么

| 批次 | 提交 | 内容 |
|---|---|---|
| 1 壳视觉 | `11f9de0` | 去 360/520 上限随列、图标井透明无底色、图标换 Phosphor、superseded 用「已在下方更新」、卡面去版本号 |
| 2 私聊问询 | `e091de5` | secret 结算后 `••••` 掩码；新增提交绑定守卫测试 |
| 3 审批 + 群聊 | `bbefa18` | 群聊不出可寻址输入（只引导私聊）、群聊工具审批去掉 always |
| 4 计划与桌面 | `ca85164` | `session_control` 冻结文案：标题与主按钮「打开桌面」、交还「交还桌面」 |
| 5 display 与排序 | 未改代码 | 排序契约、九成员只读、html 沙箱均核验已满足 |
| 视觉证据 | 本轮 | 新增 `apps/web/e2e/four-shells-visual.spec.ts` + 登记进 `E2E_GATE_SPECS` |

## 检查结果

| 检查 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 类型检查 | `pnpm --filter @rakazo/web check` | 0 | — |
| 全量 web 单测 | `pnpm --filter @rakazo/web test` | 101 files / 808 tests passed | — |
| 定向 lint | `pnpm exec biome check apps/web/src/components/ai/interactions` | 0 error | — |
| gate-off e2e | `pnpm test:e2e --runtime=scripted --spec="choice-card|plan-review|computer-needs-you-card"` | 7 passed | `checks/e2e-gate-off.log` |
| gate-on e2e | 同上再加 `card-ui-interactions|card-display-content` | 7 passed | `checks/e2e-gate-on.log` |
| 视觉 e2e | `--spec="four-shells-visual.spec.ts"` | 1 passed | `checks/e2e-visual.log` |

截图：`screenshots/`。1440 与 390/375 为真实视口尺寸（`sips` 核过：1440x900、390x844、375x844）。

## AC 逐条

| AC | 状态 | 依据 |
|---|---|---|
| AC-01 共用壳 / display 无决策按钮 | 通过 | 单测 44；`card-display-content` 九成员 e2e；壳组件单一入口 |
| AC-02 1440 卡宽 / 390 无横滚 | **部分** | 内容列 `chat-column` 实测 **704** ✓；390/375 无横滚 ✓；但挂在 Run 内的卡实测 **662**（嵌在 execution-card `padding:12px 16px` + 1px 边框内，外层 execution-shell 另有 `px-1`）。独立卡（如授权卡）接近列宽。见「偏差」 |
| AC-03 Phosphor / 透明井 / 深色 | 通过 | 视觉 spec 断言图标 `svg` 存在且井 `backgroundColor=rgba(0,0,0,0)`（浅色与深色各一次）；截图 `FS-F03-*` |
| AC-04 底右 / ≤2 按钮 + ≤1 文字入口 | 通过 | 视觉 spec 断言 `justify-content: flex-end`；plan_review 决定态为 2 按钮 + 1 文字入口（单测）；其余卡各分支至多 2 按钮 |
| AC-05 五类 input 可提交 | **部分** | question/choice/form/secret 有实现与单测；choice 有 e2e；**saved_item 无 producer**（见阻塞） |
| AC-06 secret 无明文 | **部分** | 单测：`type="password"`、提交后清空、DOM 文本无明文、不进草稿、结算后只显示 `••••`；真实事件/日志出口未采样 |
| AC-07 断绑定 / 孤立回复 | 通过 | 提交只走 `resolveIntervention`，必带 `interventionId + Bot/Group target + clientSubmissionId`（新增单测）；仓库无自由文本「可以」解析路径 |
| AC-08 审批成员字段 | 通过 | `card-ui-interactions` 覆盖 MCP assignment / outbound / 工具审批；字段严格来自合约 |
| AC-09 非本人不能执行 | **未执行** | 需第二账号与群/私聊权限上下文，本轮未跑 |
| AC-10 付款两步 | **阻塞** | `saved_item` / `payment` 在 adapters/db **零 producer**（CARD-01E 交付记录明确未做）。不做假按钮、不做假成功 |
| AC-11 过期 / 结果未知 | **部分** | 交互卡无任何重试入口（代码核对）；诚实文案态属 `[待 UI]`，未实现新视觉 |
| AC-12 连接器仍四壳 | 通过 | 无「供应商卡族」代码；MCP / 应用授权都落在统一壳（截图可见 Plug 图标统一卡） |
| AC-13 plan_review | 通过 | `plan-review` e2e 4/4：批准继续、要求修改、拒绝终止、重复/竞态幂等 |
| AC-14 takeover / return | **部分** | `computer-needs-you-card` e2e 2/2（打开桌面）；交还未实跑，租约失效错态属 `[待 UI]` |
| AC-15 display 只读 | 通过 | `card-display-content` 九成员 e2e；`DisplayBlockView` 内零决策控件 |
| AC-16 updating / 投影失败重载 | **阻塞** | `DisplayBlockSchema` 九个成员均无状态字段；Shell 无快照级错误态。均为 `[待 UI]`，不发明 |
| AC-17 pending 排序 | 通过 | `compareInteractionViewsForDisplay`：pending 先于 terminal、`plan_review→action_approval→input_request`、`createdAt→interactionId`、session_control 抛错不混排；有单测 |
| AC-18 群聊文字反问 | **部分** | 前端降级已做（群内不出输入框、只引导私聊）+ 单测；群内实跑未做（生产者拒绝码另开） |
| AC-19 群聊审批本人/非本人 | **部分** | 群内去掉 always + 单测；本人/非本人后端校验未跑 |
| AC-20 外发详情编辑 / Esc | **部分** | `card-ui-interactions` 覆盖同卡编辑草稿并确认；Esc 关闭与滚动位置未断言 |
| AC-21 详情失败 / 主动重试 | **部分** | `ArtifactPageCard` 已有 loading / error / 「Try again」 / 关闭；未实跑断网场景 |
| AC-22 390 / 375 / 深色 | 通过 | 视觉 spec：390/375 无横滚 + 深色 1440/390 截图；深色下井仍透明 |

## 偏差（需产品确认，未擅自改布局）

**Run 内交互卡 662 vs 内容列 704。** 实测父子链：

```
interaction-card 662 → 交互行 662 → intervention-region 662 → execution-interventions 662
→ execution-card 696（padding:12px 16px，+1px 边框各边）
→ execution-shell 704（px-1）→ chat-column 704
```

B3 冻结的是「内容列 704、卡随列收」，现状是：**列就是 704**，但挂在 Run 内的卡被 Execution 卡的内边距再削 34px；独立卡（如三张授权卡）接近列宽。

把 Run 内卡做成 704 需要让它冲出 Execution 卡的 16px 内边距，属于 UX-01A 既有布局改动，冻结原型未覆盖该场景，本轮未改。需要产品裁决：接受 662，还是让交互卡破格到列宽。

## 阻塞项（未有生产者/载体，不算通过）

1. `saved_item` / `payment`：无 producer，付款两步无法落地（含 AC-05 saved_item、AC-10）。
2. display `updating`：合约无状态字段。
3. 投影失败「重新加载」：Shell 无快照错误态。
4. 群聊生产者拒绝码：本轮只做前端降级，后端拒绝另开任务书。

## 未执行

- AC-09 非本人不可执行（需第二账号）
- AC-18/19 群聊实跑（需群 + 两名成员上下文）
- AC-20 Esc 关闭与滚动位置
- AC-21 断网/无权限详情失败

以上未执行项不写成通过。
