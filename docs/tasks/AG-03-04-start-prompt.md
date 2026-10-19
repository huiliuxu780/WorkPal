# AG-03 → AG-04 连续开工提示词

你负责连续交付 WorkPal 的 AG-03 和 AG-04：先完成 S01–S14 的可执行场景契约，再把 P01–P14 固定提示词完整整理为独立文件。分别提交、分别开 PR，AG-03 推送后立即继续 AG-04，无需等待合并。

## 先读

1. AGENTS.md。
2. docs/tasks/AG-03.md、docs/tasks/AG-04.md。
3. docs/next-work-roadmap.md。
4. 原 Agent 升级计划的 §19.2/§19.3，以及 baseline 场景矩阵与提示词清单；位置见 AG-03 任务书。
5. 当前 executor、PromptComposer、四个辅助入口和既有真实模型 fixture/PG harness。

任务书是这批工作的具体实施契约。旧计划中独立段版本号、前缀识别注册表、判断器未隔离和 helper 可用等描述已被当前任务书取代。

## Phase 0：核对基线，立即推进

- 更新远端，记录最新 main SHA、CI 状态和工作区状态。制定任务时 main 为 dcc73c5，#61/#62/#63 均已合并；不要从旧 UX/Avatar 分支开工。
- main CI 若还在执行，可以进行代码核实、资料入库和本地基线测试；有实际失败则先判定是否影响本工作，不能把无关长链路等待变成整批空转。
- 从 main 创建 codex/ag03-scenario-contracts。如任务书 PR 尚未合入，只带入任务文档提交，不引入其他代码，交付时说明 ancestry。
- 跑相关基线测试，记录差异。首条进展报告应是“实际入口、当前可见工具和资料偏差”，不是重复任务书。

## Phase 1：完整 AG-03

- 按任务书更新并入库 docs/agent-scenario-matrix.md 与 docs/agent-prompt-inventory.md。
- S01–S14 全部建立可执行 case；S05 的触发逐项列出；helper 生产停用与 Java seam 分开。
- 最终 scope、提示词族和精确工具集合在真实 TS→Java→本地模型请求边界捕获；正常工具执行、审批恢复和权限变化通过生产 executor/PG 验证。
- 复用现有 harness 和 CI job，新增测试必须被 CI 实际收集；不要只交测试清单。
- 运行任务书门禁，写 docs/ag03-scenario-contracts.md，推送分支并开 base=main 的 PR。

## Phase 2：连续完成 AG-04

- AG-03 定向门禁通过、捕获接口稳定后，从精确 head 创建 codex/ag04-prompt-files，不等待上一 PR 合并。
- 任何搬移前先捕获并单独提交最终请求基线。
- 建 prompts/ 的职责目录与索引，将 P01–P14 的固定正文完整整理到独立 Markdown 文件，动态内容和有类型组装逻辑保留其原有来源。
- 保持所有场景最终请求的正文、消息位置和工具集合不变；正文不能 trim/normalize 后冒充零 diff。
- 稳定段 ID 用于代码与测试定位，Git 用于版本追踪；不做提示词前端、版本数据库、发布平台或 wire 字段扩展。
- 验证 TS 从非仓库工作目录、Java 从打包 jar 能读取文本；更新 Maven/Docker 必需资源配置并验证实际产物。
- 跑任务书门禁，写 docs/ag04-prompt-files.md，推送并开 base=codex/ag03-scenario-contracts 的 PR。AG-03 合入后 retarget main 并核对 diff。

## 协作与完成纪律

- MR-01 由另一条分支并行；不改它的 retry/schema/RPC/UI。与其交叉的 executor 提示文字通过独立 renderer/文件接入，最终集成按先合入的一方补对应定向测试。
- 遇到资料与代码不同，保留证据并纠正文档；不擅自缩成代表集，也不为了实现旧资料而恢复已停用能力。
- 只添加本任务所需实现、测试与打包改动，不附加备用执行器、通用规则引擎或与目标无关的加固。
- 红测试针对新增契约或真实缺口；已有正确行为先记录绿色基线即可。
- 不用 paid inference；缺真实模型质量评估写“未评估”，不要混同离线契约测试。
- 任务卡和 roadmap 使用 delivered, ready-to-merge；不得自行合并、部署或写 done。

最后一次性报告两个 PR，但分别列出：分支/base/head、场景与家族覆盖、实际修改、可复核测试证据、资料偏差、打包验证、剩余项、安全 diff 结果。结尾明确未合并、未部署。
