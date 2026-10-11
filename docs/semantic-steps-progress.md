# Task 04 semantic Steps and Run Todos

This slice adds product-level execution units without reclassifying tool calls. `MessageBlock.kind="steps"` continues to mean aggregated tool activity.

## Implemented

- `publish_run_step` creates or revises a semantic Step using a stable ID and expected revision. The backend checks the owning running Run, current Attempt, optional parent Step and Plan item, and evidence IDs against the same Run. A completed Step cannot cite an incomplete external effect or failed tool event. Retry and terminal transitions are constrained.
- `publish_run_todo` creates or revises an explicit Run Todo. A Todo can link to a Step in the same Run; the web view suppresses that Todo row only when the linked Step is present. Bot Scratchpad items remain separate long-lived objects.
- PostgreSQL stores current Step/Todo rows and immutable mutation records while emitting lifecycle events in the same transaction. Tool execution IDs deduplicate retries; stale expected revisions do not write. Thread snapshots and live reducers use the same stable IDs and revisions.
- The web transcript shows Step and Todo sections at the source message or same-Run bot message. If a Run ends while a Step remains pending, queued, running, retrying or blocked, its read projection becomes `unknown`; the root Run outcome is unchanged.
- Model-supplied `processed/total` batch counts are rejected. The display contract keeps a batch field for future trusted telemetry, but this slice never publishes synthetic counts or percentages.

## Verified and remaining

- `pnpm check`: 18/18 packages passed.
- PostgreSQL migration and targeted Run Step/Todo tests passed, including idempotency, stale writes, invalid evidence, terminal transitions and clear-generation isolation.
- API snapshot, web reducer, UI render and executor tests passed.
- Full `pnpm test`: 4,773 passed; the same five pre-existing failures and missing Playwright publication workflow fixture remain. No Step/Todo failure was observed.
- A full Attempt history/details API, trusted batch telemetry, Step evidence navigation, a complete Execution Shell and live Todo acceptance remain. A real Java→Web browser test now verifies a revised Step linked to its Plan item on one execution. Status and result summaries are Agent reports; external effects require separate confirmed evidence.
