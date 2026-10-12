# Task 18.3 Run reliability progress

This slice implements durable wait expiry, cancellation propagation, and a conservative automatic retry. It does not complete the budget portion of Task 18.3.

## Wait expiry

The Worker checks waiting Runs every minute. Approval and input waits expire after 24 hours, and computer takeover after 30 minutes. A Thread row lock serializes expiry with an answer. The Run and Task become `cancelled` with `error=wait_timeout`, waiting Attempts become cancelled, and the pending ask block becomes `expired` so Web and voice clients cannot submit it. An intended approval effect becomes `expired`, with `approval.resolved{decision:"expired"}` and `run.cancelled` in the same transaction. Repeated scans are idempotent. A cancelled waiting Run's background task projection becomes `cancelling` for native revocation.

The timeout clock now uses `Run.waitStartedAt`, stamped on entry to input, approval, or takeover waits. The migration copies `updatedAt` for waits already in progress, preserving their previous expiry clock. Later unrelated Run updates cannot extend the deadline. Re-entry into a wait stamps a new clock.

## Cancellation propagation

All backend paths using `cancelRunsInTransaction`, plus Thread Stop, mark running child task projections `cancelling`. The Worker sends AgentScope's native `DELETE /v1/background-tasks/{id}` and retries transport failures from the durable projection. A 404 means the native task is already absent. A late background tool callback checks both the task projection and parent Run status.

Child Runs in another Thread are found from the immutable `orchestration.collaboration.parentRunId` lineage. Thread Stop and Clear now traverse all descendant Runs before returning, cancel them durably, expire their computer execution leases, request runtime abort and native background-task cancellation, and emit `run.cancelled{reason:"parent_cancelled"}`. Clear deletes the thread history, so that path does not emit `run.cancelled`. The Worker still scans every ten seconds for cancellations from other paths and for failed native revocation attempts. The history writer rejects child messages and events as soon as the run or its parent is cancelled.

## Automatic retry

AgentScope transport network failures, service 5xx, and model timeout/5xx error events are typed. A Run with no prior tool call and no intended, approved, executing, or completed `ExternalEffect` can retry twice, after 5 and 30 seconds. This conservative gate avoids replaying any possibly irreversible tool. The same Run gets a new Attempt; `run.retried` is durable. `Run.retryAt` persists the due time, and both direct claims and the Worker reconciler skip it until due. A failed job enqueue is recovered by the reconciler.

The implementation queues the Run directly from a failed Attempt without first publishing a terminal `run.failed`; that avoids a false failure message before retry. An expired running lease with a persisted active Attempt now passes through the same no-tool/no-effect gate and 5/30-second schedule. A run that cannot safely retry is finalized as failed with an unconfirmed-outcome reason; renewal of the old lease prevents both retry and failure. If the process crashed between marking the Run running and creating its Attempt, recovery fails that Run under an expired-lease and absent-Attempt guard, preserving the empty Attempt ledger instead of replaying it. Errors from non-AgentScope runtimes and arbitrary application/tool failures are not automatically retried. AgentScope cannot resume an interrupted model stream, so retry starts a fresh execution attempt using the persisted Run context.

## Verification and remaining work

PostgreSQL tests cover approval expiry, ask invalidation, takeover timeout, child cancellation across Threads, late child history rejection, retry delays, idempotence, and refusal after a completed `send_email` effect. Unit tests cover the retry policy; AgentScope loopback tests classify HTTP 503 and model timeout. The affected package type checks and targeted tests pass.

Still required for Task 18.3: USD budget enforcement with an actual model-price source, and a broader Java/Web budget acceptance flow. Token, tool-call and duration bounds, with interactive increase/narrow/cancel, are implemented in the budget slice. USD cost cannot be inferred from the current `UsageRecord` token counts without model pricing, so no dollar budget is claimed as enforced.

## Execution contract closure

This pass makes Run start and cancellation agree on one contract. It does not complete Task 18.3, and it does not add a Run status, a Task type, or another executor.

### Run and Attempt start

The computer execution lease is acquired first. `promoteLeasedRunWithAttempt` then takes one PostgreSQL transaction: lock the Run, require the current lease owner, fence, and unexpired lease, move `leased` to `running`, and create `Attempt(status="running")` for that fence. A committed `running` Run without that Attempt is not a state this path can write. Computer busy, lease failure, and cancellation before promotion leave the Run queued or cancelled and create no Attempt. A crash while the Run is still `leased`, before this transaction, still has no Attempt; the next claim uses a new fence. Recovery of a `running` Run whose lease expired before any Attempt existed still fails that Run and does not invent an Attempt.

`Attempt` has `@@unique([runId, fence])` in migration `20261013070000_attempt_fence_uniqueness`. The unique index is created before `attempts_runId_idx` is dropped. If two historical rows share a fence, the migration fails with PostgreSQL `23505` and does not delete or merge them.

Checked against PostgreSQL:

- `workpal_exec_empty2` applied 102 finished migrations, including this file. The stored checksum matches the committed SQL. `attempts` has `attempts_pkey` and `attempts_runId_fence_key`.
- `workpal_exec_clean` upgraded a database that already had one Attempt. Run `dup-run`, Attempt `dup-attempt-a`, and Event `dup-event` remained. The unique index replaced `attempts_runId_idx`.
- `workpal_exec_dup` has two Attempts for the same run and fence. The migration did not finish, both Attempt rows plus the Run and Event remained, and `attempts_runId_idx` remained.

### Cancellation entries

`cancelRunsInTransaction` is the only production writer that turns an active Run into `cancelled`. It sets `completedAt`, clears `waitKind`, `waitStartedAt`, `retryAt`, `leaseOwner`, and `leaseExpiresAt`, and keeps `leaseFence`. It cancels Attempts in `running`, `waiting_input`, or `waiting_takeover` and writes `finishedAt`. Finished Attempts stay as they are. Running `BackgroundAgentTask` rows become `cancelling`. The Task status follows the Run that actually transitioned. A second cancel of a terminal Run changes nothing and does not append another event.

`cancelChildrenOfCancelledRuns` then walks `orchestration.collaboration.parentRunId`, including children whose parent row is already gone, and cancels grandchildren across Threads. Each newly cancelled descendant gets one `run.cancelled` with `reason:"parent_cancelled"` where its Thread history is kept. Descendant computer execution leases are expired in that transaction.

Entries that use this pair:

- Thread Stop. The API aborts, cancels jobs, and deletes native background tasks before it returns. PostgreSQL coverage of the descendant walk is the shared helper; the Stop handler itself is covered by unit tests, not by a new PostgreSQL fixture.
- Thread Clear. Same descendant and native revoke path. History is deleted, so no `run.cancelled` event is stored.
- Wait timeout. The worker expires the waiting Run, cancels descendants, aborts, cancels jobs, notifies both Threads, and asks AgentScope to delete background tasks in that same turn.
- Budget `narrow_scope` and `cancel_run`. PostgreSQL tests cancel the parent, child, and grandchild and keep a completed `ExternalEffect`.
- Group member removal and group archive. A rename that removes no member does not cancel. PostgreSQL tests cover both. Removal collects `running` or `cancelling` background tasks by the group thread and the removed bot ids. Archive collects them by the group thread. The parent Run may already be `completed`. Those projections become `cancelling` in the same transaction and are revoked after commit. Their parent ids are not treated as cancelled Runs. A failed DELETE stays `cancelling` for the worker.
- Group delete. Cross-thread descendants are cancelled. The group Thread, its Runs, and its background projections are cascade-deleted. Background tasks are selected by the group thread, including when the parent Run is already `completed`. Before that delete commits, run-abort rows for the active Runs and background-task revocation rows are written to `execution_revocations`, which has no foreign key to those entities.
- Bot archive and bot delete, including child-bot tools and account deletion. PostgreSQL tests archive and delete a bot and cancel a cross-thread child. Archive collects that bot's `running` or `cancelling` background tasks by `botId`, marks them `cancelling`, and revokes them after commit. Deleting a bot that dissolves a group collects the dissolved threads' background tasks and writes their tombstones before `chatGroup.deleteMany`.
- Teaching start emits `run.cancelled` with `reason:"teaching_started"`. Teaching stop does not cancel Runs.
- A newer send cancels superseded queued Runs with `reason:"superseded"`.
- Team-chat routine wake cancels the fallback Run with `reason:"routine_wake"`.
- The worker child sweep repeats the descendant walk every ten seconds for any parent that was cancelled elsewhere.

After the database transaction commits, the caller aborts the runtime, cancels the run job, and `DELETE`s AgentScope background tasks. Network calls are not inside the transaction. A transport error leaves `BackgroundAgentTask.status="cancelling"` when that projection still exists, and the worker sweep retries. HTTP 404 is treated as already gone and the projection becomes `cancelled`. A PostgreSQL test covers a thrown DELETE followed by a 404.

Migration `20261013080000_execution_revocation_outbox` adds `execution_revocations`. That table is the retry record that survives bot, group, thread, and account deletes. `cancelRunsInTransaction` inserts `kind="run_abort"` for every run it actually cancels. Group delete and a dissolved group on bot delete insert `kind="background_task"` for every `running` or `cancelling` background task on those threads, including tasks whose parent Run is already `completed`, and they do that before the cascade delete. Bot delete also writes the bot's own background rows before `bot.delete`. The local runtime controller is aborted before the remote `DELETE /v1/runs/{runId}`. A network error or a non-404 HTTP status throws, leaves the row, increments `attempts`, and stores `lastError`. HTTP 404 and a successful DELETE delete the row. The worker sweep retries pending rows every ten seconds. Archive, and group member removal, still use the `cancelling` projection because those rows are not cascade-deleted. The caller revokes them immediately after commit.

A unique `(runId, fence)` conflict no longer requeues the Run. The promote transaction rolls back, so the Run stays leased. `reconcileAttemptFenceConflict` then locks that Run. When this worker still owns the unexpired lease and the Attempt for the fence is active, the same transaction marks the Run running, reuses that Attempt, and fails every other active Attempt. When the conflicting Attempt is already finished, the Run and its Task become `failed` and no new fence is opened. A lease this worker does not own is left alone. The result is never two active Attempts for one Run.

Computer stop deletes that bot's computer execution leases and stops the sandbox. It does not cancel Runs.

Late `agent.tool.called` events and thread messages after the parent or child is cancelled throw `Run cannot write thread history`. External effects in `intended`, `approved`, `executing`, `completed`, or `uncertain` are not deleted or rewritten by cancellation. The schema name for a finished effect is `completed`.

### Retry and fence

The retry policy is unchanged: the same Run gets a new Attempt, at most two automatic retries, after 5 seconds and then 30 seconds. Only AgentScope network errors, HTTP 503, and model timeout or 5xx enter that schedule. A tool call, or an external effect in `intended`, `approved`, `executing`, `completed`, or `uncertain`, blocks automatic retry. Retry starts a new model turn. PostgreSQL tests show an old fence cannot finalize, pause, take over, or renew; cancel racing retry leaves one cancelled Run; a cancelled Run is not claimed from `retryAt` or the reconciler; a repeated job does not insert a second Attempt for the same fence.

### Evidence for this pass

`VERIFY_DATABASE=1` with the admin connection pointed at the local `rakazo` database, which is not migrated: 5 files, 36 tests passed, 0 skipped (`wait-timeouts`, `lease-loss-recovery`, `run-budget-enforcement`, and the two `execution-contract` files). Each file clones a private database from a template whose name is a hash of the migration files. Those five files passed three consecutive times under Vitest's default file parallelism, with no `--no-file-parallelism`. The cases cover a run abort that fails once and succeeds on the next retry, background DELETE retries after bot and group cascade, an Attempt fence conflict that leaves a single active Attempt or an explicitly failed Run, and a parent Run that is already `completed` while its background task is still `running`. That last case covers member removal, group archive, group delete, bot archive, and a group dissolved by bot delete. No `it.skip` was added.

This follow-up did not re-run the full `pnpm test`. The previous acceptance run, Node 24 and JDK 21, was 396 files passed, 38 skipped, and 4813 tests passed, 235 skipped. The PostgreSQL files stay behind the `VERIFY_DATABASE` gate. The gated run is the 36-test run above.

`pnpm --filter @rakazo/db check`, `@rakazo/adapters`, `@rakazo/api`, and `@rakazo/worker` passed. `mvn -q -f services/agent-runtime/pom.xml test` with JDK 21.0.12.1 passed. The only Maven log noise is the existing SLF4J no-provider warning.

### Still open

- USD model prices and a real `maxCostUsd` charge. Unknown prices stay `costUsd=null`.
- Approval and input request ids, and a unified Intervention model.
- Execution Card, Task Center, and HISTORY-001.
- Computer stop does not cancel Runs.
- Teaching stop does not cancel Runs.
- A group update that does not remove a member does not cancel the members who remain.
- `infra/sandboxes/supervisor/src/computer-spec.test.ts` can report `slow failure looked successful` when a first-run temporary `rakazo-browser` is slower than the 2.4s browser poll. It failed one full-suite run, then passed in isolation and on the next two full runs. `docs/fork-baseline.md` already records that timing signal. This pass does not change supervisor argv.
