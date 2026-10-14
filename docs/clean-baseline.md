# WorkPal implementation baseline (2026-10-12)

This baseline is the starting point for implementing the Execution designs. It records what is in code, what has only been designed, and which checks are still red. A passing prototype or UI screenshot is not proof of production behavior.

## Source and scope

- `origin/main` at `c91c749`: AgentScope Java Harness, background task lifecycle, and Product Harness Phases 1–4.
- PR #9 head `5f2b215`: bloub avatars and default style, Run details panel, centered creation dialogs, model picker, approval-gated `send_email`, and deployment changes. The older local `b101d70` branch is not the base: it predates the Java and Product Harness merges.
- PR #8's Product Harness v1 completion note is included. The Java runtime now refreshes the backend's compacted history summary and recalled memory on a restored chat session; a regression test checks that a newer summary replaces the previous copy while the previous assistant reply remains available.
- The production runtime stays Java AgentScope. The removed Python runtime and Pi are not production fallbacks. Existing Bot, Thread, Task, Run, Routine, authorization, event, and UI contracts remain the base for future changes.

## Verification

- `pnpm check`: 18/18 tasks passed.
- `pnpm test:agentscope`: 36 Java tests passed; no failures or skips.
- AgentScope adapter and Java consumer integration: 17 tests passed with JDK 21 configured.
- Avatar, mail, and i18n targeted tests: 55 passed.
- `git diff --check` passed. Changed TypeScript files have no new Biome errors; the vendored bloub engine is excluded from Biome formatting so its upstream source remains stable.
- The repository-wide `pnpm test` is **not green** on this macOS checkout: 4,732 passed, 193 skipped, 7 assertion failures, plus one test file that could not load because the referenced Playwright publication workflow is absent. Failures are in three stale executor prompt assertions, the server update command assertion, a Linux desktop lifecycle assertion, the old Pi computer replay, and the Compose smoke on this host. The initial all-repository invocation lacked an explicit JDK 21 path; the AgentScope consumer integration was then rerun separately and passed.
- Repository-wide Biome still reports 37 errors in inherited files. Do not present the whole repository as lint-clean.

## Design handoff boundaries

- Task 01–03 source files are in the Execution Shell visualization set; Task 04–17 source files are in the WorkPal design set. Task 18 has a separate v1.4 development brief. These are design inputs, not shipped React/DB/runtime implementations.
- The Execution Card (Tasks 15/15.1) is now implemented in the production Web app as a projection of the HISTORY-001 read model; see [execution-card.md](./execution-card.md). The structured, revisioned Plan (`PLAN-001`) persists revisions and feeds the inline Plan disclosure, but its revision history is still not exposed in UI. Render only data that has a reliable source; do not turn prototype fixtures or Activity labels into fake Plan state.
- Task 17 defines a product Task as one goal with one or more Runs; each Routine trigger creates a fresh Task and Run. Task 18 can leave the existing Task table unchanged, but its wording that omits Task from the conceptual model must not erase Task 17's goal/Run distinction.
- Task 18 proposes event envelopes, proactive result delivery, Run reliability, capability rules, and TurnPolicy v2. These require separate implementation and real execution tests. In particular, the brief's claim that Execution UX is already complete describes its prototypes, not this baseline's product UI.

## Next implementation gate

Before claiming Tasks 01–18 complete, map each frozen UI state to a real persisted event/API source, then validate the Task 18 control changes against normal, failed, cancelled, resumed, and duplicate-delivery paths. The Execution Card is delivered; the Task Center, a manual-retry contract, a trusted percentage-progress source, and a trusted model-price source for `maxCostUsd` remain open. Keep the Task 17 Task/Run relationship and the backend's permission boundary throughout.

## Update (2026-10-14)

The gate above has been partially closed since this baseline was written, and this paragraph supersedes the stale parts of it:

- The **Task Center is implemented** (PR #41, merged to `main` on 2026-10-14): `/app/tasks` over the shared HISTORY-001 projection with the reused Execution Card, authoritative active-count badge and return-to-conversation flow; see [task-center.md](./task-center.md). It must no longer be described as unimplemented anywhere.
- **HISTORY-001** (PR #39), the **Execution Card** (PR #40) and the **unified Intervention region** (PR #38) are implemented in production; the audit table rows that list them as remaining describe the pre-PR state.
- The Task 18 control-plane acceptance closure (branch `codex/task18-production-acceptance-closure`) closed the delivery-window merge gap (>100 records per 30-second Thread window now form exactly one delivery Run and one message), and added real Java→Web acceptance chains for token→increase, tool-call→narrow, routine→delivery, capability deny/malformed/ask-replay, plus a TypeScript→Java TurnPolicy v2 wire acceptance; see [task18-product-harness-completion/scenario-validation.md](./task18-product-harness-completion/scenario-validation.md).
- Still open by design: a manual-retry contract, a trusted percentage-progress source, a trusted model-price source for `maxCostUsd`, a capability-rule editor, and a separately deployed Worker-process acceptance test (the E2E harness hosts the production job handlers in-process).
