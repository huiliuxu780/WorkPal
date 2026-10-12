# Task 03 structured Plan progress

This slice implements the data source needed for a real Plan slot. The Java AgentScope native `plan_write` tool accepts Markdown content only; it cannot supply stable item identities or status. WorkPal therefore exposes a separate `publish_run_plan` tool only when the Run's planning policy allows it. A Run without a published structured Plan has no Plan slot.

## Contract

- `publish_run_plan` accepts an explicit goal and 1–20 items with stable IDs and six product statuses. The first call uses `expectedRevision: 0`; later calls supply the current revision and a change reason. Items removed from the active path remain in the revision as skipped or superseded.
- The backend locks the Run, checks its identity and running status, validates input, and atomically writes the current Plan, immutable revision and `plan.revised` event. `toolExecutionId` deduplicates retries; stale expected revisions fail without writing.
- Thread snapshots load current Plans in the current clear generation. Live events update only a newer revision, and clear removes the local Plan view. The Plan is attached to the source message when available, otherwise to a message from the same Run or the active transcript tail.
- The disclosure shows the goal, reported item statuses, current item and revision reason. Long Plans are abbreviated with a Show all control. There is no synthetic Plan from tools, Activity or Markdown.

## Acceptance and limits

- `pnpm check`: 18/18 packages passed.
- Focused API, reducer and executor tests: 214 passed. The Plan disclosure render test also passed.
- PostgreSQL migration and dedicated Plan transaction tests: 2 passed, including retry idempotency, stale revision rejection and clear-generation isolation.
- Full `pnpm test`: 4,768 passed; the same five pre-existing failures remain, plus the existing missing Playwright publication workflow fixture. No Plan-related failure was observed.
- Plan revision history is stored but has no on-demand UI route yet. Runs without a source message can be anchored to a bot message or live tail; a historical run with neither has no visible Plan slot. The model reports item completion; this is not independent evidence that an external effect succeeded. A real Java→Web browser test now verifies a two-revision Plan on one execution; broader visual and intervention acceptance remain.
