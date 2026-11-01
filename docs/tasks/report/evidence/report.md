# REPORT-01 证据报告

分支：`codex/report-01`
基线：`origin/main` @ `6dcc620`（BADGES-01b 合入后）

## 开工选定（任务书 §2.2 要求写进交付说明）

1. **结果消息形态**：**不新增 `MessageBlock` kind**。投递结果是模型写的普通 bot 消息，消息在 settle 前就已写入；新增块类型只能回写消息或再写一条，会把产品文案塞进模型输出。改为在 `ThreadMessage` 上增加可选 `report` 描述子，**读路径投影**产出。
2. **信封来源边界**：`DeliveryRecord` 只增加一个指针 `resultMessageId`（指向可见消息），信封字段仍不落库，由 `DeliveryRecord → Run → Task → Thread → Bot/User` 在读取时拼装；解析不到就整条省略，不假造。导出/复制消息不带信封，已与负责人确认可接受。
3. **迟到信号**：**持久系统条**，复用既有 `meta` 块（居中系统行），文案「迟到结果 · 已不收」，无正文、不标未读、不进卡族。
4. **失败可见**：重试用尽时在来源会话写一条可见消息，正文为固定安全句「这次工作没有完成。」，技术原因只留在服务端；记录回填同一指针，信封 `state = failed`。

## 检查结果

| 检查 | 结果 | 日志 |
|---|---|---|
| contracts / db / adapters / api / web 类型检查 | 0 | — |
| `pnpm --filter @rakazo/web test` | 101 files / 810 tests | `checks/unit.log` |
| `result-delivery.postgres.test.ts` | 7 passed | `checks/postgres.log` |
| `report-envelope.postgres.test.ts` | 3 passed | `checks/postgres.log` |
| `report-delivery.spec.ts`（实页） | 1 passed | `checks/e2e-report.log` |

截图（实页，1440）：
`RP-01-tag-envelope.png`、`RP-02-failure-visible.png`、`RP-03-late-row.png`。

## 行为覆盖

| 项 | 依据 |
|---|---|
| 成功结果落原会话 + 流内标签「回应 · 交来的结果」+ 来源信封（来自 / 会话 / 工作 / 结果回给） | 实页截图 RP-01；postgres envelope 用例断言字段 |
| 失败可见「回应 · 失败可见」+ 正文 + 信封 state=failed | 实页截图 RP-02；delivery 用例断言消息与指针 |
| 叫停/取消/顶掉后迟到：不写结果正文，只留「迟到结果 · 已不收」系统条 | 实页截图 RP-03；delivery 用例断言只写 meta 行、无结果正文 |
| 与提醒分家、无分享入口、无汇总条、不双投私聊、不新增卡族 | 未引入任何对应代码路径；`GroupDestinationReceipt` / `HtmlDisplay` 未改动 |

## 未覆盖 / 待补

- **失败正文**目前是固定句，未展示具体失败原因（避免内部错误外泄）；若产品要更具体的用户文案需另行定稿。
- **派活方解析**：当前规则为「有 origin Run 且触发为 bot_message → 派活 Bot；否则该 Run 的所属用户」。群内 `@Bot` 派活的更细语义未单独建模。
- 信封在**读路径**投影，导出/复制消息不带信封（已确认可接受）。
- 迟到系统条目前每个 stale 批次一条；未做跨批次合并展示。
