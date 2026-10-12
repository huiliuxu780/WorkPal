# Task 18.3: expired execution lease recovery

When a running Run's lease expires and its active Attempt exists, `continueRun` now stops the old runtime request and uses the existing automatic retry transaction. That transaction requires the lease still to be expired, checks all prior tool calls and intended or later external effects, and schedules the next Attempt after 5 or 30 seconds only when replay is safe. It writes `run.retried` and keeps the same Run and Task. A renewed lease blocks recovery.

If the retry gate refuses replay, the expired Attempt and Run become failed with an explicit unconfirmed-outcome reason. Finalization also requires the lease still to be expired, so a heartbeat racing the recovery cannot be overwritten. A Run marked running before its Attempt row was created is refused automatic replay; repairing that anomalous state is still required.

PostgreSQL tests verify expiry gating, delayed retry, and refusal to finalize a renewed lease. Executor integration tests verify that a safe expired Attempt queues one retry and that an intended email effect fails the Run without replay. Targeted type checks and tests pass. This is a control-plane safety check, not proof that an external effect did or did not happen.
