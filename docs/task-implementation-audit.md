# Task 1–18 implementation audit

Baseline: `codex/clean-baseline` (`f9992e8`), based on PR #9 and the Java AgentScope Harness. This is a code audit, not an acceptance claim for the HTML prototypes. A design scene is evidence of the intended presentation, not evidence that WorkPal can produce its data.

| Design | Current production evidence | Remaining implementation gate |
| --- | --- | --- |
| 01 Execution Shell | `RunActivityDisclosure` renders an inline activity strip. | The full shell and its Assistant Turn attachment are absent. |
| 02 Execution status | `Run` states and Phase 4 activity projection exist. | One user-facing status derivation across live, wait, background, and history is absent. |
| 03 Plan | AgentScope Plan Mode and a `planning` activity kind exist. | PLAN-001: durable Plan, revision and item identities, trusted item states, replay. |
| 04 Todo / Steps | `MessageBlock.steps` aggregates tool calls. | STEP-001 semantic steps and their Plan relationship are absent. Tool calls must not be relabeled as steps. |
| 05 Live Activity | The Phase 4 reducer supports replay and live activity. | Current activity selection and visual stability need integration with the execution shell. |
| 06 Tool actions | Tool events and `ToolActivityDisclosure` exist. | The design's evidence, effect status, grouping and retry presentation require a production mapping. |
| 07 Approval | Backend approval/effect path and ask cards exist. | APPROVAL-001 scope and decision-owner checks, unified intervention presentation and recovery need verification. |
| 08 User input | `threads.answer` and persisted ask blocks exist. | Unified intervention state, server-acknowledged submission and draft recovery need integration. |
| 09 State consistency | `RunStatus` and Activity projection are available. | The frozen user-facing status matrix is not a shared production selector. |
| 10 Background | Java native tasks, `BackgroundAgentTask`, and a Web card exist. | Results are injected on the next main Run; active delivery and a cross-surface same-Run view are absent. |
| 11 Collaboration | Harness Phases 1 and 3 provide routing, support and handoff; Phase 4 projects events. | The single owner header with bounded collaborator details is not integrated. |
| 12 Final shell | Existing UI tokens and chat components are available. | The frozen integrated shell, accessibility and responsive acceptance have not been reproduced in production. |
| 13 History | PostgreSQL stores the full transcript and events; AgentScope keeps separate working context. | HISTORY-001 execution snapshot, pagination and historical disclosure are absent. |
| 14 Final acceptance | Java consumer integration and Web E2E cover parts of the path. | The five designed end-to-end flows have not all been demonstrated on the production UI. |
| 15 / 15.1 Card | `RunDetailsPanel` exists as a separate surface. | Inline Execution Card, same-Run expansion and Task Center view are absent. |
| 16 Scenario validation | Design lab uses fixtures; Java tests and E2E cover narrower real flows. | Six scenarios need real normal/failure traces, including Routine and delivery. |
| 17 Object model | `Thread`, `Task`, `Run`, `Routine`, `Artifact` exist; `Run.taskId` is required. | Product Task→Run retry, intervention identity and cross-surface links need alignment. |
| 18 Control plane | Work is in progress on event envelope and wait reason. | Delivery, reliability, capability permissions and TurnPolicy v2 remain. |

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
