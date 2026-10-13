# Execution History Snapshot

HISTORY-001: the per-Run `ExecutionSnapshot` read model. It gives one execution a
single server-owned projection that survives refresh, message pagination, long
Activity, device switches, and Thread Clear — without becoming a second source
of execution truth.

## Authority

`ExecutionSnapshot` and `ExecutionSummary` are API projections (`packages/contracts/src/execution-snapshot.ts`), assembled by `packages/db/src/execution-history.ts` inside one transaction under the existing `threads … FOR SHARE` fence. Nothing is stored per snapshot: there is no snapshot table, no writer that maintains a snapshot document, and no snapshot-specific lock order.

| Snapshot section | Authoritative durable source |
|---|---|
| `summary.status / waitKind / trigger` | `runs` row |
| `summary.title` | `tasks.prompt` (peer runs: the source `bot_message` blocks) |
| `summary.outcome` / `result` | the Run's latest committed bot `messages` row, via the existing block serialization + redaction path |
| `summary.failure` | `runs.error` through `runFailureError` (bounded, display-safe) |
| `summary.rev` | `MAX(events.seq)` where `events.runId = run`, composed with `runs.snapshotRev` (see ## rev) |
| `summary.updatedAt` | the Run's newest product event (`MAX(events.createdAt)`); the Run's creation time when no event survives. Never `runs.updatedAt`: invisible row writes (lease renewal, budget overrides) move the row timestamp without moving `rev`, and one `rev` must identify exactly one summary content |
| `plan` | `run_plans.current` (validated `thread_generation`) |
| `steps` / `todos` | `run_steps` / `run_todos` `current` (validated `thread_generation`) |
| `timeline` / `activityPage` | `events` (the shared `ACTIVITY_EVENT_TYPES` vocabulary) folded through the one `projectActivity` reducer |
| `interventions` | `interventions` rows + the PR #38 presentation/window rules |
| `artifacts` + `summary.artifacts` | `artifacts` rows filtered by `runId` + `spaceId` |
| `counts.agents` | `background_agent_tasks` (current generation) |

`ExternalEffect` contributes only its existing safe metadata (id/kind/status via `InterventionView.approval`); raw `request`/`result` never enter a snapshot.

## rev

`rev(run) = MAX(events.seq WHERE runId = run) + runs.snapshotRev` — the sum of
two durable monotonic counters, each covering what the other cannot:

1. **Event ceiling.** Every event-driven content change appends a product
   Event carrying the Run's `runId` (`run.*`, `thread.progress`,
   `agent.tool.*`, `subagent.*`, `plan.revised`, `step.*`, `todo.*`,
   `intervention.*`, `thread.message.*`, `thread.artifact`).
2. **`runs.snapshotRev`** — a row-level counter maintained by the
   `runs_snapshot_rev` BEFORE UPDATE trigger, which increments only when a
   snapshot-visible column actually changes (`status`, `waitKind`, `startedAt`,
   `completedAt`, `error`). It exists because the worker hot paths — claim
   (`queued→leased`), promote (`leased→running` + `startedAt`), fence
   reconciliation, computer requeue — deliberately write the Run row with
   standalone CAS updates: no Thread lock and no product event. Appending
   events there would drag the Thread lock into the lock-free claim path and
   risk Run→Thread acquisition, so those visible transitions cannot be derived
   from the event log. The trigger keeps the counter convention-free: every
   current and future write path is covered by construction, atomically with
   the transition it counts, and it takes no new locks (the row is already
   locked by the UPDATE), so the Thread → Run order is untouched.

Properties: monotonic within a Thread generation (each component only grows;
`thread.progress` deletions always happen under a higher-seq terminal event);
re-reading a committed state returns the identical value (no random, no
timestamp, no content hash); isolated per Run (other Runs' events and ordinary
chat never move it); lease renewals, budget overrides, model switches and
mirror timestamps change no visible column and therefore never invalidate UI
state.

Write-path inventory (visible ⇒ rev moves):

| Path | Signal |
|---|---|
| send/create (queued) | baseline; trigger does not fire on INSERT |
| claim → leased (executor CAS) | trigger |
| promote → running + startedAt (`promoteLeasedRunWithAttempt`) | trigger (+ later `run.started` event) |
| fence reconcile → running/failed | trigger |
| computer requeue → queued | trigger |
| retry (`retry-runs`) | `run.retried` event (+ trigger) |
| pause/resume/answer | `run.waiting_input` / `intervention.*` / message events (+ trigger) |
| finalize / cancel / timeout / clear | `run.completed|failed|cancelled` events (+ trigger) |
| plan/step/todo/intervention/result/artifact writes | their events |
| lease renewal, budgetOverride, model switch, mirror timestamps | **no bump** (invisible) |

Artifact membership has no natural event, so Artifact attach and detach append
a strict `thread.artifact` Event `{artifactId, action, name, mimeType, size?}`.
Attach does it in the same transaction as the row insert; delete removes the
row and appends the event in ONE transaction (the blob is removed after that
commit — an event failure rolls the deletion back and surfaces to the caller).
The event is a Thread-maintenance fact: it links to a Run but does not require
the Run to be writable, so a terminal Run's Artifact removal still moves its
`rev`.

A Run with no surviving events and no transitions (pre-table legacy rows)
reports `rev: 0`; detail reads mark the missing parts in `incompleteSections`.
Across a Thread Clear the event component resets with the deleted log; cleared
Runs are fenced out of every window, so the reset is never observed as a
regression of a live card.

## Thread windows

`ThreadSnapshot.executions` (optional; older servers omit it) covers the
bounded window: every active Run, every Run with a pending Intervention, and
the 50 most recently updated terminal Runs **of the current generation**. The
generation fence keys off the Run's own **lifecycle** footprint: a Thread
Clear deletes every pre-clear event, so a stale terminal Run has no surviving
lifecycle event (`MAX(seq)` excluding the thread-maintenance `thread.artifact`
rows) and drops out of the window, while audit rows (Run/Attempt/Intervention)
stay untouched. The `thread.artifact` exclusion matters: deleting a stale
Run's artifact later is legal thread maintenance and lands a fresh event
naming that Run, which must not drag it back into the cleared generation —
the same lifecycle ceiling also drives the detail read's staleness marking.
`rev` still counts every event, so artifact membership changes keep moving
the version of any Run that is visible. No time comparison is used to guess a
generation, and no seq-boundary arithmetic is needed (presence, not
`seq > generation`, keeps the seq-0 boundary exact).

`ThreadMessagePage.executions` carries the summaries of the Runs the page's
messages belong to. Loading an older page therefore restores that page's
executions in the same payload — independent of the recent-Run window. Web
merges both sources by `runId` (freshest snapshot value wins) in
`mergeExecutionsByRun`.

## Activity pagination

`runs.executionActivityPage({botId|groupId, runId, cursor?, limit?})` walks one
Run's Activity events newest-first (`limit` default 50, max 100) and returns
items oldest-last inside the page.

- The cursor is opaque base64url JSON bound to `{version, runId,
  threadGeneration, first-read upper bound, next-page exclusive upper bound}`.
  A cursor for another Run or issued in another generation is rejected
  (`stale_cursor` / `invalid_cursor`), never reinterpreted.
- The walk keeps its upper bound fixed, so events appended while paging can
  neither duplicate nor skip an already delivered item.
- `olderCursor: null` means there is no older data. `truncated` mirrors it.
  Total is omitted, not guessed.
- Items are the shared safe `ActivityItem` projection. A `called`/`completed`
  pair split across a page boundary is reconciled at read time: the page that
  contains the `completed` also fetches that execution's `called` parent (one
  bounded lookup on the Run's event index) so the newer page already carries
  the completed status. The same id can appear on an older page as still
  running; the client prepends older pages and dedupes by id, keeping the
  newer status — never a contradictory duplicate.
- On the client, the fetched detail snapshot, its first-page cursor and the
  older pages loaded against it are ONE rev-versioned unit
  (`installExecutionDetail` / `appendExecutionActivityPage` in
  `apps/web/src/lib/execution-history.ts`): a newer rev replaces all three
  together, a late out-of-order response whose rev does not exceed the cached
  one is dropped whole, and a load-more page is discarded when the entry moved
  on in flight — paging state can never mix versions.

## Truncation and aggregate semantics

Every section has a hard bound and an honest signal: plan (1 current revision),
steps/todos 200 each (`truncated` + section in `incompleteSections`), timeline
24 items over a 400-event scan (older parts come from the cursor walk),
`summary.artifacts` 20 names with `counts.artifacts` as the true total.
Untrusted counts are omitted entirely — a Run with no step rows gets no
`counts.steps`, and a completed Run without a result message gets no `outcome`.

## Result and Artifact mapping

`result` is the Run's latest committed bot message, with Ask blocks stripped —
an Approval/Input card is never a result. Absent means no result exists yet;
`completed` never fabricates one. Routine delivery Runs and peer Runs stay
separated because every query filters by `runId` (plus `threadId`/`spaceId`
from the authorized target), backed by the new `messages(runId, seq)` and
`artifacts(runId, createdAt)` indexes. Artifacts expose id/name/mimeType only;
content never enters a snapshot.

## Redaction boundary

Secrets stay out by construction, not by filtering: messages come from the
existing redaction path, Intervention views carry only the #38 whitelist
presentation, Effect `request`/`result` are never read, tool payloads are only
the label vocabulary the Activity projector already exposes, and the RPC/HTTP
loggers keep their existing redactions. E2E and PostgreSQL tests assert the
secret is absent from snapshots, events, results, the DOM, and web storage.

## Legacy and compatibility

- Servers without `executions`: Web keeps its existing derivation unchanged
  (`summariesByRun` returns null and every branch falls back).
- Runs predating Interventions/Artifacts simply have fewer events; `rev: 0`
  with `incompleteSections` is a valid answer.
- Thread Clear: the old generation disappears from windows and detail reads;
  Run/Attempt/Intervention audit rows are untouched, never re-attached.

## Known limitations

- The generation fence reads "no surviving Run-lifecycle event" (every event
  except `thread.artifact`) as "belongs to an older generation". That is a
  write-path invariant, not a structural guarantee: background-task and
  delivery events can reach completed/failed Runs before Clear, while those
  writers validate the Thread generation. `assertRunCanWriteHistory` itself
  only blocks cancelled Runs. After Clear, no lifecycle event may be appended
  for a Run from the old generation; every new terminal-Run event path must
  uphold that rule, or a stale Run could re-enter the window.
- `rev` is a composed counter (event-seq ceiling + visible-transition
  counter), not a content hash: events that do not change the projection
  still advance it (harmless for expansion invalidation).
- Steered user messages are attributed to the steered Run, so a steering
  message advances that Run's `rev` even though the ExecutionSnapshot does not
  list steering (steering is visible in the Run's live transcript position).
- `summary.entry` mapping (`bot_message`/collaboration lineage →
  `collaboration`; routine/delivery/webhook/messaging/call_end/cloud_agent/
  spawn → `result`; everything user-initiated → `execution`) is a fixed table,
  not derived from state.
- The detail read is per Run; the summaries window stays bounded at ~50+active
  Runs and one grouped batch per fact source (no per-Run query fan-out).
