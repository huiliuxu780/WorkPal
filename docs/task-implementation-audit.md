# Task 1–18 implementation audit

Baseline: `codex/clean-baseline` (`f9992e8`), based on PR #9 and the Java AgentScope Harness. This is a code audit, not an acceptance claim for the HTML prototypes. A design scene is evidence of the intended presentation, not evidence that WorkPal can produce its data.

| Design | Current production evidence | Remaining implementation gate |
| --- | --- | --- |
| 01 Execution Shell | An inline `ExecutionShell` groups same-Run Plan, Steps, Todo and activity under a single status Header. Waiting detail stays visible; terminal detail folds. | Unified intervention payload/action placement, independent Result summary, exact Assistant Turn identity and full historical attachment remain. |
| 02 Execution status | A shared Web selector derives nine display states from root `Run`, `waitKind` and same-Run Activity with terminal and attention priority. It never promotes a child background task to root background. | Trusted root background mode/automatic transition and cross-surface status reuse are absent; some historical Runs lack a status row. |
| 03 Plan | The `publish_run_plan` tool now writes structured Plan revisions transactionally; snapshot/live transport and an inline Plan disclosure consume them. Native Markdown Plan Mode remains Activity only. | Revision history is stored but not yet exposed in UI; real Java→Web acceptance and Assistant Turn anchoring for runs without a source message remain. Item completion is Agent-reported, not independently verified evidence. |
| 04 Todo / Steps | Explicit Run Step and Todo tools now persist stable identities, revisions and live events. Step links to Plan items; Todo links to Steps only when declared. `MessageBlock.steps` remains a tool-call aggregate. | Full Step Attempt history, trusted batch telemetry, evidence detail UI and live Java→Web acceptance remain. |
| 05 Live Activity | The Phase 4 reducer supports replay and live activity. | Current activity selection and visual stability need integration with the execution shell. |
| 06 Tool actions | Tool events and `ToolActivityDisclosure` exist. | The design's evidence, effect status, grouping and retry presentation require a production mapping. |
| 07 Approval | Backend approval/effect path and ask cards exist. | APPROVAL-001 scope and decision-owner checks, unified intervention presentation and recovery need verification. |
| 08 User input | `threads.answer` and persisted ask blocks exist. | Unified intervention state, server-acknowledged submission and draft recovery need integration. |
| 09 State consistency | The Shell uses a shared display selector; a follow-up aligns foreground queue, lease, takeover, trusted blocking and wait activity with the Task 09 matrix. | Other surfaces still use their own short Run labels; intervention counts, resume-pending and root background facts are not yet available as one cross-surface projection. |
| 10 Background | Java native tasks, `BackgroundAgentTask`, a Web card and the Task18.2 delivery outbox exist. | Live Java→Web delivery acceptance and a cross-surface same-Run view remain. |
| 11 Collaboration | Harness Phases 1 and 3 provide routing, support and handoff; Phase 4 projects events. | The single owner header with bounded collaborator details is not integrated. |
| 12 Final shell | Existing UI tokens and chat components are available. | The frozen integrated shell, accessibility and responsive acceptance have not been reproduced in production. |
| 13 History | PostgreSQL stores the full transcript and events; AgentScope keeps separate working context. | HISTORY-001 execution snapshot, pagination and historical disclosure are absent. |
| 14 Final acceptance | Java consumer integration and Web E2E cover parts of the path. | The five designed end-to-end flows have not all been demonstrated on the production UI. |
| 15 / 15.1 Card | `RunDetailsPanel` exists as a separate surface. | Inline Execution Card, same-Run expansion and Task Center view are absent. |
| 16 Scenario validation | Design lab uses fixtures; Java tests and E2E cover narrower real flows. | Six scenarios need real normal/failure traces, including Routine and delivery. |
| 17 Object model | `Thread`, `Task`, `Run`, `Routine`, `Artifact` exist; `Run.taskId` is required. | Product Task→Run retry, intervention identity and cross-surface links need alignment. |
| 18 Control plane | Stacked PRs #11–#16 cover event envelope, wait reason, background delivery, reliability, budget bounds, capability rules and TurnPolicy v2. | Trusted USD cost enforcement, lease-loss retry scheduling and live Java→Web acceptance remain. |

## Contract conflict to preserve

Task 17 defines Routine trigger → new Task → Run and permits multiple Runs under one Task. Task 18 says not to add or modify the existing Task entity and omits Task from its short conceptual diagram. Implementation keeps the existing `Task` table and Task 17 product relationship; Task 18 is an additive control-plane scope, not permission to erase Task semantics.

## Delivery order

1. Establish event and wait contracts without altering existing screens (18.1).
2. Make structured Plan and semantic Steps replayable, then attach the real execution shell and card (01–06, 09, 12, 15).
3. Complete approval/input, background delivery, collaboration and history across the same Run (07–11, 13, 17, 18.2–18.5).
4. Run the designed acceptance flows against production-backed paths (14, 16), record any remaining gaps, then merge in reviewable slices.

No percentage, completion summary, Plan item, semantic Step or external effect should be rendered without a trusted source.

## Implementation slices after the baseline audit

- Task 18.1 adds versioned event envelope fields, typed delivery/approval events and `Run.waitKind` in PR #11.
- Task 18.2 adds a durable background-result outbox and proactive Bot summary Run in the next stacked branch. The Routine path still writes its own result once. The remaining acceptance gate is the full Web scenario with a live Java runtime; see [delivery-design.md](./task18-product-harness-completion/delivery-design.md).
- Task 18.3 now has a reliability slice (wait expiry, child cancellation, conservative retry) and a budget slice (token, active-duration and tool-call limits, interactive choices, routine failure delivery). USD cost needs a trusted model-price source, and the full Java/Web budget acceptance flow is still unverified; see [reliability-progress.md](./task18-product-harness-completion/reliability-progress.md) and [budget-progress.md](./task18-product-harness-completion/budget-progress.md).
- Task 18.4 adds Bot-local capability rules, deny/ask/allow resolution, defaults and an executor-boundary check in the next stacked slice. The production-data default requires an identified production resource; see [capability-permission.md](./task18-product-harness-completion/capability-permission.md).
- Task 18.5 adds version-two policy constraints, preserves v1 snapshots, and carries the contract to Java in the next stacked slice. These are execution bounds, not an intent/action router; see [turnpolicy-evolution.md](./task18-product-harness-completion/turnpolicy-evolution.md).
- Task 03 adds a separate structured Plan tool, immutable revisions, current snapshot/live projection and inline disclosure. It does not parse AgentScope `plan_write` Markdown into product data. See [structured-plan-progress.md](./structured-plan-progress.md).
- Task 04 adds explicit Run-level Steps and Todos, revision and evidence validation, snapshot/live replay and separate inline disclosures. Model-supplied batch numbers are rejected until a trusted telemetry source exists. See [semantic-steps-progress.md](./semantic-steps-progress.md).
- Tasks 01–02 add the root Run display selector and inline Execution Shell around the existing structured content. They do not infer root background mode or invent an intervention action. See [execution-shell-progress.md](./execution-shell-progress.md).
- Task 09 refines the selector for the later state matrix without inventing a new runtime enum. See [state-consistency-progress.md](./state-consistency-progress.md).
