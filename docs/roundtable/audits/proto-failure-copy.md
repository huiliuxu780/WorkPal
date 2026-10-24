# PROTO-FAILURE-COPY · 失败与恢复文案审计

- 日期：2026-10-24
- 范围：仅 `docs/roundtable/prototype/index.html`、`DESIGN.md`、原型截图与验证器；生产代码未修改。
- 起点：`5a1e55193b05cc83c895e8e62fd1d40addcc3a05`（#122 合入后的 main）。
- 约束：原型用户可见文案不得出现 AgentScope、Run、Attempt、recovering、lease、fence、steering；不新增布局、交互或生产错误文案。

## 1. 逐场景文案

### branch-F-OFFLINE（同时覆盖 CF-08 连接失败）

| 位置 | 旧文案 | 新文案 | 理由 |
| --- | --- | --- | --- |
| 系统行 | 未能派给小紫：该 Agent 已被停用，没有开始这项工作。 | 未能派给小紫：暂时连接不上，这项复核没有开始。 | CF-08 的生产文案是「AgentScope service connection failed」。原型改为用户可理解、可行动的说法：谁、什么没做成、是否开始；不出现执行器名称。 |
| Joy 回复 | 小紫当前不可用。我先保留复核缺口，不会把它显示成已接收；可以改派小蓝或等小紫恢复。 | 小紫现在暂时联系不上，这不是小紫拒绝了任务。我先保留复核缺口，不会把它显示成已接收；你可以改派小蓝，或等连接恢复后我再继续。 | 区分「连接失败」与「拒绝/停用」，明确不会伪造已接收，并给出改派或等待两个动作。 |
| 活动胶囊 | 委派失败 · 等待改派 | 没能派给小紫 · 等你决定 | 去掉内部「委派」口径，直接说明对象和用户动作。 |
| 工作根节点 | 失败透明可见 | 小紫暂时联系不上 | 删除设计说明，改成用户事实。 |
| 工作节点 | 未创建 / Agent disabled | 未开始 / 暂时联系不上 | 「未创建」是内部状态，`Agent disabled` 是英文内部状态；改为用户可判断的状态。 |
| 源注释 | message_bot 明确失败；群里不伪造“收到”…… | 目标 Agent 暂时连接不上时，明确告知没有开始…… | 源注释不渲染，但同步清理内部术语，保证整份原型文件通过禁词扫描。 |

### branch-F-RETRY

| 位置 | 旧文案 | 新文案 | 理由 |
| --- | --- | --- | --- |
| 小蓝回复 | 第一轮 trace 因浏览器进程退出失败。我已在相同任务下开始第 2 次尝试，已完成的数据不会重复发布。 | 第一轮分析因为运行环境中途退出，没有拿到完整结果。我已经在同一项工作里开始第 2 次尝试，前一轮拿到的数据不会重复发布。如果第 3 次仍失败，我会保留已有结果，并告诉你哪一步没完成。 | 用用户语言说明原因；强调同一项工作、不重复发布；补足次数用尽后的预期，避免「重试中」无限期。 |
| 消息内状态 | 重试中 · 第 2 / 3 次尝试 | 正在重试 · 第 2 / 3 次 | 只保留客观次数，符合 D1「第 2 / 3 次尝试」口径。 |
| 活动胶囊 | 性能基线重试中 · 2 / 3 | 性能基线正在重试 · 第 2 / 3 次 | 补全「第…次」，避免裸计数。 |
| 工作根节点描述 | 保留每一次尝试 | 同一项工作保留每次尝试 | 明确重试不新建重复工作。 |
| 源注释 | 重试是同一任务的 attempt…… | 同一项工作自动重试，不新建重复工作…… | 去掉 attempt；保留产品语义。 |

### branch-F-PARTIAL

| 位置 | 旧文案 | 新文案 | 理由 |
| --- | --- | --- | --- |
| 系统行 | 小紫的第三方证据复核超时，未产生结果。 | 不变 | 已是用户语言，保留失败事实。 |
| Joy 回复 | 现在只能做有条件收尾：性能证据支持周五灰度，但第三方复核缺失。我建议先灰度 10%，并把复核列为上线前阻塞项。 | 现在只能做有条件收尾：性能证据支持周五灰度，但第三方复核缺失。我可以只补做小紫缺失的复核，不需要重跑性能。建议先灰度 10%，并把复核列为上线前阻塞项。 | 明确「有条件」而不是全部完成；补上只补失败部分的可行动路径，不重跑已成功工作。 |
| 工作根节点 | 主持人基于部分结果收尾 | 已有结果可用，复核缺失 | 去掉设计说明，直接描述结果与缺口。 |
| 状态 / 节点 | 部分完成 / 已完成 / 已超时 | 不变 | 成功与失败分支并列保留，符合「部分完成」边界。 |
| 源注释 | 已有成功结果可以用于有条件结论，不能伪装为全量完成。 | 成功结果可以用于有条件结论，但必须标明缺口，不能显示为全部完成。 | 补充「标明缺口」的明确要求。 |

### branch-X-GROUP-FAIL

| 位置 | 旧文案 | 新文案 | 理由 |
| --- | --- | --- | --- |
| Joy 回复 | ……加入后我会继续刚才的任务，不需要你再说一遍。 | ……加入后我会继续刚才的任务，不需要你再说一遍。如果你没有成员管理权限，可以请群主或管理员处理。 | 原原型只覆盖「有权限」的情况；没有权限时用户需要知道下一步找谁。这是纯文案补充。 |
| 工作节点 meta | 成员审批 | 等你决定 | 去掉流程术语，直接说明当前阻塞在用户。 |
| 审批卡 / 胶囊 | 把 Joy 加入「新版发布圆桌」？/ 暂不加入 / 加入并继续 / 等你决定是否让 Joy 入席 | 不变 | 已是用户语言，覆盖批准、拒绝和继续三个动作。 |
| 源注释 | 只有你具备群成员管理权时，才会出现可执行的加入审批。 | 增加「没有权限时明确说明需要管理员处理」。 | 记录无权限分支的预期。 |

### main-stage-7（审批阶段）

复核结论：无需改文案。审批卡「允许小橙发布到预览环境？」、按钮「拒绝 / 允许一次」、后续「审批只暂停发布；我仍然可以继续讨论」均为用户语言，没有执行器名称或内部状态。本次仅重拍 1440px 与窄屏证据，确认视觉与滚动位置。

### CF-08

生产现状是 `packages/adapters/src/agentscope-runtime.ts:909` 写入「AgentScope service connection failed」，由 ExecutionCard 原样展示。本 PR 不修改生产代码；原型把该失败映射为 branch-F-OFFLINE 的「暂时连接不上，这项复核没有开始」，作为 FIX-APPROVE-E 的文案方向。底层原因只进日志/审计。

## 2. 原型源注释清理

原型中所有 `AgentScope / Run / Attempt / recovering / lease / fence / steering` 已清除。除上述失败场景外，源注释（不渲染）同步改写于：U-ACTIVE、U-MULTI、A-ACTIVE、A-BACKGROUND、A-COMPLETED、Q-ORIGINS、C-MULTI、C-DUAL、C-ROOTS、C-LATE、P-SCOPED、F-DEDUPE。可见页面布局与交互未改变。

新增 `verify-prototype-copy.mjs` 对整份原型做禁词扫描，并校验失败、重试、部分完成、连接失败和审批文案的关键锚点。

## 3. 证据

截图目录：`docs/roundtable/audits/evidence/prototype/`

| 场景 | 1440×900 | 430×900 | 工作页签（1440） |
| --- | --- | --- | --- |
| branch-F-OFFLINE / CF-08 | `branch-F-OFFLINE.png` | `narrow-branch-F-OFFLINE.png` | `branch-F-OFFLINE-work.png` |
| branch-F-RETRY | `branch-F-RETRY.png` | `narrow-branch-F-RETRY.png` | `branch-F-RETRY-work.png` |
| branch-F-PARTIAL | `branch-F-PARTIAL.png` | `narrow-branch-F-PARTIAL.png` | `branch-F-PARTIAL-work.png` |
| branch-X-GROUP-FAIL | `branch-X-GROUP-FAIL.png` | `narrow-branch-X-GROUP-FAIL.png` | `branch-X-GROUP-FAIL-work.png` |
| main-stage-7 | `main-stage-7.png` | `narrow-main-stage-7.png` | — |

复现命令（Playwright 1.63.0，与本地缓存 chromium-1243 匹配）：

```bash
npx --yes playwright@1.63.0 screenshot --viewport-size="1440,900" \
  "file:///<repo>/docs/roundtable/prototype/index.html?branch=F-OFFLINE" out.png
npx --yes playwright@1.63.0 screenshot --viewport-size="430,900" \
  "file:///<repo>/docs/roundtable/prototype/index.html?branch=F-OFFLINE" out.png
# main-stage-7 使用 ?step=6（7 / 8 审批阶段）
# 工作页签追加 &panel=1
```

## 4. 验证

```text
$ node docs/roundtable/verify-ui-conformance.mjs
roundtable UI conformance verified: 31 tasks (backend-only 13, direct-ui 5, ui-projection-contract 13), 12 conflicts, 7 remediation tasks, 55 evidence refs

$ node docs/roundtable/verify-prototype-copy.mjs
roundtable prototype copy verified: 0/7 forbidden terms, 9 required anchors present
```

## 5. 需要用户确认的原型缺口

1. **无权限的跨会话加入**：X-GROUP-FAIL 只在文案里说明「找群主或管理员」，没有渲染无权限/审批被拒的卡片。是否需要独立状态？
2. **重试次数用尽**：文案和 DESIGN 已说明第 3 次失败后如何收尾，但没有「重试已用尽 → 失败」的独立可见状态。是否需要补状态？
3. **部分完成后的补做动作**：目前只有 Joy 的口头建议「只补做失败部分」，没有按钮或菜单。新增操作属于交互变更，需确认。
4. **停用与连接失败**：F-OFFLINE 现在演示连接失败；「Agent 已停用导致新任务失败」只在 Q-UNAVAILABLE 的历史只读场景中出现。是否需要单独的停用失败状态？
5. **审批范围**：main-stage-7 的审批卡通过标题和「允许一次」表达范围，没有额外的授权范围说明行。若需要显式范围文案，属于卡片布局调整，需确认后再做。

生产实现（FIX-APPROVE-E）与生产错误文案修改均待用户确认后启动。
