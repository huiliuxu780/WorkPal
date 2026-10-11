# Task 18.3 Run reliability progress

This slice implements durable wait expiry, cancellation propagation, and a conservative automatic retry. It does not complete the budget portion of Task 18.3.

## Wait expiry

The Worker checks waiting Runs every minute. Approval and input waits expire after 24 hours, and computer takeover after 30 minutes. A Thread row lock serializes expiry with an answer. The Run and Task become `cancelled` with `error=wait_timeout`, waiting Attempts become cancelled, and the pending ask block becomes `expired` so Web and voice clients cannot submit it. An intended approval effect becomes `expired`, with `approval.resolved{decision:"expired"}` and `run.cancelled` in the same transaction. Repeated scans are idempotent. A cancelled waiting Run's background task projection becomes `cancelling` for native revocation.

The timeout clock now uses `Run.waitStartedAt`, stamped on entry to input, approval, or takeover waits. The migration copies `updatedAt` for waits already in progress, preserving their previous expiry clock. Later unrelated Run updates cannot extend the deadline. Re-entry into a wait stamps a new clock.

## Cancellation propagation

All backend paths using `cancelRunsInTransaction`, plus Thread Stop, mark running child task projections `cancelling`. The Worker sends AgentScope's native `DELETE /v1/background-tasks/{id}` and retries transport failures from the durable projection. A 404 means the native task is already absent. A late background tool callback checks both the task projection and parent Run status.

Child Runs in another Thread are found from the immutable `orchestration.collaboration.parentRunId` lineage. Thread Stop and Clear now traverse all descendant Runs before returning, cancel them durably, expire their computer execution leases, request runtime abort and native background-task cancellation, and emit `run.cancelled{reason:"parent_cancelled"}`. The Worker still scans every ten seconds for cancellations from other paths and for failed native revocation attempts. The history writer rejects child messages/events as soon as the parent is cancelled. Direct revocation for wait expiry and non-Thread cancellation entry points remains an acceptance hardening item.

## Automatic retry

AgentScope transport network failures, service 5xx, and model timeout/5xx error events are typed. A Run with no prior tool call and no intended, approved, executing, or completed `ExternalEffect` can retry twice, after 5 and 30 seconds. This conservative gate avoids replaying any possibly irreversible tool. The same Run gets a new Attempt; `run.retried` is durable. `Run.retryAt` persists the due time, and both direct claims and the Worker reconciler skip it until due. A failed job enqueue is recovered by the reconciler.

The implementation queues the Run directly from a failed Attempt without first publishing a terminal `run.failed`; that avoids a false failure message before retry. An expired running lease with a persisted active Attempt now passes through the same no-tool/no-effect gate and 5/30-second schedule. A run that cannot safely retry is finalized as failed with an unconfirmed-outcome reason; renewal of the old lease prevents both retry and failure. If the process crashed between marking the Run running and creating its Attempt, recovery fails that Run under an expired-lease and absent-Attempt guard, preserving the empty Attempt ledger instead of replaying it. Errors from non-AgentScope runtimes and arbitrary application/tool failures are not automatically retried. AgentScope cannot resume an interrupted model stream, so retry starts a fresh execution attempt using the persisted Run context.

## Verification and remaining work

PostgreSQL tests cover approval expiry, ask invalidation, takeover timeout, child cancellation across Threads, late child history rejection, retry delays, idempotence, and refusal after a completed `send_email` effect. Unit tests cover the retry policy; AgentScope loopback tests classify HTTP 503 and model timeout. The affected package type checks and targeted tests pass.

Still required for Task 18.3: USD budget enforcement with an actual model-price source; direct child revocation from remaining cancellation entry points; and a broader Java/Web budget acceptance flow. Token, tool-call and duration bounds, with interactive increase/narrow/cancel, are implemented in the budget slice. USD cost cannot be inferred from the current `UsageRecord` token counts without model pricing, so no dollar budget is claimed as enforced.
