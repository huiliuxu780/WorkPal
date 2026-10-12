# Task 09 state consistency refinement

The Task 09 contract resolves details that Task 02 left ambiguous. This slice follows the later matrix where production facts exist.

- Foreground `queued` displays “正在排队” with the unknown/neutral status mark. It does not say “正在执行” or treat a child background task as root background mode.
- `leased` displays “正在执行 · 正在启动”. `waiting_takeover` has its own “等待接管” presentation and is not generalized to Blocked.
- `waiting_input` uses the persisted `waitKind` to distinguish approval and input. Missing wait kind gives “状态未知”; a stale running Activity title is never copied into a waiting Header.
- A real caller-supplied `blockedReason` may produce Blocked; no idle timer, Step failure or disconnected state does so. The transcript currently has no such root fact to pass.
- Failed Shells open while child sections fold; completed Shells default compact. Plan and Step disclosures fold on waits and terminal states.

The current backend does not expose `resumePending`, a trusted root background mode, unified intervention counts, or a full cross-surface display view. The Shell selector cannot prove those Task 09 rows. The existing Run panel and background task card still use their narrower status labels. Full Task 09 acceptance therefore remains open, including live browser flow checks and the Task 07/08 intervention contract.
