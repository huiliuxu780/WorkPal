# Task 18.2 background result delivery

## Ownership and path

AgentScope Java remains the only production executor. Its native task repository runs background helpers and keeps their working state. The application backend owns the durable `BackgroundAgentTask` projection, the PostgreSQL `DeliveryRecord` outbox, a `delivery` Task/Run, the final Thread message, and audit events.

Terminal background callbacks and the Worker's missed-heartbeat/expired-credential sweep write the task terminal state, `subagent.*` and `thread.subagent` events, a unique outbox row, and `delivery.created` in one transaction. Registration also writes its task row and start events in one transaction. The Thread row lock serializes these writes with `clearThread`.

Java sends a task-scoped heartbeat every 30 seconds while a child is running. The Worker only treats a task as lost after two minutes without a heartbeat or after its one-hour credential expiry. This prevents an ordinary long model call from being mistaken for a stopped Worker.

The Worker schedules `delivery.dispatch` every ten seconds. A PostgreSQL `FOR UPDATE SKIP LOCKED` claim selects a due Thread window after 30 seconds and groups rows created within 30 seconds of its first row. One `delivery` Run is created for the group. The Run's prompt orders items by background completion time and puts failures in a separate section. It has no tools, skills, Plan, delegation, or conversational history. The Bot writes one summary message. After the Run commits, the Worker marks every source record `sent` and appends `delivery.sent`. A repeated settle sees no claimed rows, so it cannot emit a second sent event.

The Routine path already creates a Task/Run and writes its result directly to the target Thread. Enqueuing that same result here would duplicate it, so Routine delivery is left on its existing path. `run_result` is reserved in the outbox kind for a later producer. This slice addresses the missing proactive background-result path.

## Clear and retry

`threadGeneration` is the latest retained `thread.cleared` event sequence. The migration backfills existing background tasks only when they started after that clear. Registration saves the generation under the Thread lock. Dispatch and settle take the same lock and compare the current generation. A stale result becomes `sent` with `lastError=stale_generation`; it does not write a new message or event into the cleared conversation. Its source task row remains available for audit, while the cleared Thread's activity projection intentionally excludes old generations.

The outbox lease is two minutes. A crashed worker can reclaim a claimed record without consuming a new delivery attempt and can resume or settle an existing delivery Run. `FOR UPDATE SKIP LOCKED` and a window-first-row predicate prevent competing workers from splitting one 30-second window. Failed delivery Runs release rows with five retry delays: 10 seconds, 30 seconds, 2 minutes, 10 minutes, 30 minutes. After the sixth failed attempt (initial attempt plus five retries), the row becomes `failed` and `delivery.failed` projects into Thread activity. Unique `idempotencyKey` prevents duplicate source enqueue.

## Native pull transition

The existing Java next-turn reminder path remains for native results that have no active outbox ownership. The backend passes outbox task IDs in `RunRequest.excludeDeliveredTaskIds`; Java filters them before injecting a reminder. It excludes `pending`, `claimed`, and `sent` rows, including the 30-second merge window. This is stricter than the draft's “claimed only” wording: a next turn could start before the Worker claims a pending row and otherwise expose the same result twice. A delivery Run suppresses native reminders entirely because its prompt already carries the grouped results.

## Verification and remaining gate

The migration ran on a fresh disposable PostgreSQL database. Database tests cover duplicate enqueue, the 30-second delay, locked-row skip, and the retry schedule. A PostgreSQL integration test covers two background results producing one delivery Run, one final message, two `delivery.sent` events, idempotent settle, and stale generation suppression. The Java integration test verifies that an outbox-owned native task is not injected on the next main turn. Type checks and Java tests pass.

An environment-backed Web → API → Java → background callback → durable outbox → delivery Run → Web acceptance run now passes without a new user message. The E2E harness schedules the same `delivery.dispatch` job handler that the production Worker schedules, using its in-process memory job host. The browser confirms one completed delivery Run and unchanged user-message count; a database probe confirmed one `delivery.sent` event. This is not a separate-process Worker deployment test. One-hour credential enforcement for a parent Run and unified `run.failed` reason belong to Task 18.3.

The dispatch query bounds one claim to 100 rows. If more than 100 background results land in the same Thread within 30 seconds, they are delivered in additional summary Runs. This is an outstanding high-fanout edge case against the design's strict one-message window rule; no result row is dropped.
