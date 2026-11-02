# H3-05 排除审计：H1F 临时排除的实际枚举与处置

单元：H3（`codex/harness-delivery-gates`）。基线：`main @ a409140d5b62fd1bba2c1cd4aa242520a3e1b759`。日期：2026-10-28。
机器可读的逐项结果：[exclusion-audit.json](./exclusion-audit.json)（188 项逐文件的 format / assist / lint 计数，以及与 PR #147 重叠标记）。

原卡（[HARNESS-01 H3 步骤 11](../../../tasks/HARNESS-01.md)）记录的"五组原型路径 + 188 个 formatter/import-sort 历史文件"是 2026-10-25 的快照。本次在 `a409140` 重新枚举，结果如下；数字巧合地与快照一致，但每一项都重新验证过，不是沿用旧结论。

## 枚举方法（可重复）

```bash
# 1. 实际排除项
node -e 'const c=require("./biome.json");const o=c.overrides.find(x=>x.formatter&&x.formatter.enabled===false);console.log(o.includes.length)'
# → 188（14 个 docs/ 条目 + 174 个 source 条目）

# 2. 解除 formatter/assist override 后的真实诊断（临时改 biome.json，测完还原）
pnpm exec biome check . --max-diagnostics=5000 --reporter=json

# 3. 再解除 files.includes 里的五组原型路径
pnpm exec biome check . --max-diagnostics=5000 --reporter=json
```

注意：`biome` 默认只显示 20 条诊断。不加 `--max-diagnostics` 会把"188 项里只有 20 项有问题"当成事实——本次审计第一轮就踩到这个坑，结论已按完整输出重算。

## 实测结果

| 事实 | 数值 |
| --- | --- |
| `biome.json` formatter/assist override 条目 | 188（docs 14、source 174） |
| 解除 override 后仍触发诊断的文件 | **188 / 188**（没有失效条目） |
| 这些文件的诊断总数 | 283 |
| 仅 format | 122 |
| 仅 assist（import 排序） | 10 |
| format + assist | 36 |
| 含真实 lint 规则（非格式化） | 20 |
| 再解除五组原型路径后新增文件 | 27 |
| 再解除五组原型路径后新增诊断 | 约 380（283 → 663） |

真实 lint 规则分布（188 项内）：`style/noDescendingSpecificity` 12、`complexity/useOptionalChain` 8、`correctness/noUnusedImports` 7、`style/useImportType` 5、`correctness/noUnusedVariables` 4、`complexity/noBannedTypes` 3、`complexity/noImportantStyles` 3、`correctness/noUnusedFunctionParameters` 2、`style/useTemplate` 1、`suspicious/noTemplateCurlyInString` 1、`suspicious/noPrototypeBuiltins` 1。

结论：**没有一条排除是空转的**。因此收口不能靠"删掉过期条目"，只能靠逐项修复或取得永久排除批准。

## 分组处置

### G-A 五组已确认原型与冻结设计资产（`files.includes`）— 建议永久排除，待批准

| 排除路径 | 解除后触发 | 保留依据 |
| --- | --- | --- |
| `docs/roundtable/prototype/index.html` | 1 文件，含 `a11y/useButtonType` 24、`style/noDescendingSpecificity` 13、`suspicious/useIterableCallbackReturn` 12、`a11y/useAriaPropsSupportedByRole` 9、`a11y/useAltText` 4 | 用户已确认的可运行原型；X-GROUP-APPROVE 等分支是 CARD/RT 任务的验收依据 |
| `docs/cards/source/card-unification-v2/mockup/cards-hifi-v4/**` | 6 文件（`cards.html`、`b-alerts.html`、`a-detail.html`、`c-states.html`、`index.html`、`style.css`），含 `a11y/useSemanticElements` 54、`style/noDescendingSpecificity` 24、`complexity/noImportantStyles` 4 | CARD-01B/01C/01D 的已批准原型；`b-alerts.html` N1–N4 就是 #147 的视觉依据 |
| `docs/avatar/source/final/demo/**` | 3 文件，含 `suspicious/noDoubleEquals` 65、`correctness/noUnusedVariables` 6 | 冻结的 avatar 设计演示 |
| `docs/avatar/source/final/work/**` | 2 文件 + 2 个 JSON | 冻结的 avatar 中间设计产物 |
| `docs/avatar/review/compact-v0.7.html` | 1 文件，`a11y/useHtmlLang` 1 | 冻结的评审快照 |

这些是设计证据，不是生产代码。按 [AGENTS.md 前端与原型铁律](../../../../AGENTS.md) 和原卡"冻结/生成原型不能为了 lint 机械改写"，机械修复会使已确认原型的截图、哈希和验收记录失效。**处置：建议由负责人批准为永久排除，并在 `biome.json` 旁注明依据。** 本审计不声称已获批准。

### G-B docs 内的生成/冻结证据 JSON（12 项）— 建议永久排除，待批准

`docs/avatar/source/final/assets/{anchors,eyes,palette}.json`、`docs/roundtable/audits/ui-prototype-conformance.json`、`docs/roundtable/prototype/evidence/{library-capsule,library-capsule-final,ui-restore-1,ui-restore-2,ui-restore-before,ui-restore-file,ui-restore-tabs,ui-restore-task-detail}/report.json`。

全部只有 `format` 一条诊断。它们是工具写出的证据/资产文件，重新格式化会破坏与生成时刻的可对照性。**处置：永久排除，待批准。**

### G-C 仅格式化 / import 排序的 source 文件（168 项）— 建议在 #147 合入后单独一批处理

包含 G-B 之外的 2 个 docs 脚本（`docs/roundtable/verify-implementation-plan.mjs`、`verify-implementation-plan.test.mjs`）和 166 个 source 文件。这批可用 `pnpm exec biome check --write <files>` 机械修复，但本次**没有执行**，原因具体：

1. 其中 3 个文件正在被 PR #147 修改：`apps/web/src/pages/Shell.tsx`、`apps/web/src/pages/shell/use-execution-transcript.tsx`、`packages/testkit/src/cli/harness.ts`。第一批 README（`docs/tasks/first-batch-20261027/README.md`，派发输入，尚未纳入 git）规定这些共享文件由 CARD 原 owner 先完成，消费分支合入后再改。
2. 168 个文件的一次性格式化就是原卡明令避免的"全仓格式重写"，会把 H3 的门禁交付和一次纯格式化混在同一个 PR 里，无法独立回退。
3. 格式化会改变 `apps/web/e2e/*.spec.ts` 等 18 个 E2E spec 的字节内容，需要重跑对应 E2E 才有真实证据；这不属于 H3 的验收场景。

**处置：完整清单已在 [exclusion-audit.json](./exclusion-audit.json)（`format`/`assist` 计数非零且 `lint` 为空的条目）。建议作为一个独立的、可回退的格式化交付单元，在 #147 合入 `main` 后执行，命令与验证范围随单元任务书给出。H3 不代为执行，也不把它记为已完成。**

### G-D 含真实 lint 规则的 20 个文件 — 需要代码决定，不是格式化

| 文件 | 规则 | 建议 |
| --- | --- | --- |
| `apps/web/src/pages/Shell.tsx` | `noUnusedImports` 3、`noUnusedVariables` 2 | 与 #147 同文件，合入后处理 |
| `apps/web/src/pages/shell/use-execution-transcript.tsx` | `noUnusedImports` 1 | 与 #147 同文件，合入后处理 |
| `packages/adapters/src/executor.ts` | `useOptionalChain` 3、`noUnusedImports` 1 | 独立小修 |
| `packages/adapters/src/message-group.ts` | `useOptionalChain` 2、`noUnusedFunctionParameters` 1 | 独立小修 |
| `packages/adapters/src/scenario-contract.test.ts` | `noTemplateCurlyInString` 1、`noPrototypeBuiltins` 1 | 需逐条判断是否为故意的夹具写法 |
| `packages/adapters/src/turnpolicy-v2-agentscope.integration.test.ts` | `noBannedTypes` 3 | 需判断是否放宽该规则或改类型 |
| `packages/ui-web/src/agent-avatar/agent-avatar.css` | `noDescendingSpecificity` 12、`noImportantStyles` 3 | UI 视觉面，改动需视觉回归；建议单独单元或永久排除，待负责人决定 |
| 其余 13 个（`thread-target.ts`、`capability-rules.spec.ts`、`ApprovalRulesSettings.test.tsx`、`avatar-runtime.tsx`、`history-compaction.{ts,test.ts}`、`lease-loss-recovery.postgres.test.ts`、`memory-extraction.ts`、`memory-injection.test.ts`、`memory-outbox.ts`、`execution-contract.postgres.test.ts`、`wait-timeouts.postgres.test.ts`、`scenario-contract.postgres.test.ts`） | 各 1–2 条 `noUnusedImports` / `noUnusedVariables` / `useImportType` / `useTemplate` / `useOptionalChain` | 可与 G-C 同批处理，但每条是真实代码改动，需要跑受影响包的 `check` 与定向测试 |

**处置：不在 H3 内修改。H3 交付的是逐项归属和分类；实际修复需要一个明确边界的单元，且 `agent-avatar.css` 与两个 #147 重叠文件有前置依赖。**

## 未处理项与风险

- 该 override 同时关闭 `formatter` 和 `assist`，所以这 188 个文件里**新增**的代码也永远不会被格式化，排除面只会变大。建议 G-C/G-D 落地后按批删除条目，而不是长期保留整块 override。
- 本审计只覆盖 `biome.json`。`skills-lock.json` 是否有生成与校验入口（原卡 H3 步骤 9）不在第一批 H3 范围内，未核查，留作后续。
- 永久排除批准尚未取得。在批准前，这些条目仍是"临时排除"，本文件是它们的归属记录，不是批准记录。
