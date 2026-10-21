# PD-02 决策：明确拒绝通用 trusted percentage progress

> **状态：决策已批准（拒绝该能力）。** 产品负责人于 2026-10-21 明确拒绝建设通用可信百分比进度；本文档合并即决策生效，无实现任务。
> 关联证据：[UX-01 决策记录](./UX-01-decision.md)（数字+进度条仅随 Plan）、`apps/web/src/lib/execution-card.ts`（planProgress：a/b 与 fraction 的唯一来源）、`docs/semantic-steps-progress.md:11`（拒绝模型自报 processed/total）、`apps/web/e2e/execution-card.spec.ts:639-663`（"cards never render invented percentages" 守卫）。
> 本文只记事实、决策、非目标与重评条件。

---

## 1. 事实（代码核实，2026-10-21 @ main `7fe9aff`）

- **全仓唯一接线的可信分母 = Plan 有效条目数**，且已按 a/b 计数 + 比例条渲染（仅当存在结构化 Plan；`planProgress`：completed/effective，fraction=completed/total）。UX-01 决策已明文：数字与条只来自 Plan，「也不能用 Steps 或 Todo 凑一个出来」，且「进度是 Agent 自己报的状态，不代表外部事实已经确认」。
- **该分母中途可变**：修订可增条目（不可删 id，移除的工作标 superseded/skipped 并触发重审）；a/b 回退（3/4→3/6）已被采纳为诚实行为。百分比只是同一数据的再包装，会放大虚假精确度（"57%" 暗示并不存在的精度）。
- **其他执行类型均无预知总数**：Steps/attempts/agents/actions 全为事后计数（`counts.*` 是 post-hoc totals）；Routine 无 N 动作清单（一次触发一个 Run）；delivery run 的合并批量数只数结果消息、不数工作量；background agent 数随派生增长。
- **`RunStepBatch.total` 是保留槽位而非能力**：contracts 保留 `processed/total?/unit` 形状「for future trusted telemetry」，且**明文拒绝模型自报值**；`PublishRunStepInput` 无 batch 字段，DB 侧只携带、从不写入。
- **真实百分比只存在于桌面基建**（更新器下载字节、Docker layerBytes），与 Run 执行进度无关。
- **回放一致性负担**：任何快照新字段必须服从 rev-stamped 单元纪律（one rev ⇒ one summary content；未知必须省略、绝不报 0、绝不猜测——多处文档与 E2E 守卫已 pin）。

## 2. 决策

| # | 决策 |
| --- | --- |
| D1 | **拒绝**建设通用 trusted percentage progress；当前进度数字仅保留可信 Plan a/b |
| D2 | 不把 a/b 转换为百分比显示 |
| D3 | 不从 token、耗时、文本、Step 事后数量、工具次数或模型自报值推测百分比 |
| D4 | `RunStepBatch.total` 保留为未来窄契约槽位，不是当前能力，不得被实现"顺手"启用 |
| D5 | 未知值必须省略；不显示 0%、`--` 或任何猜测值（沿用既有诚实规则） |

## 3. 非目标

- 不为任何现有执行类型（chat/routine/delivery/background/computer）新增百分比 UI。
- 不修改 Plan a/b 的既有语义与渲染。
- 不先做 UI 再补数据契约。

## 4. 重新评估条件

仅当某类执行出现**机器可知、版本化、可回放**的真实 denominator（如可信外部系统进度、受控批量作业总数）时，才可另立决策重新评估，且新契约必须满足：明确数据来源与更新时机、rev-stamped 回放一致性、未知省略规则、以及对应执行类型的 E2E 守卫。届时百分比只对该执行类型窄化启用，不成为通用能力。
