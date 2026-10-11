# Task 10: background cancellation feedback

This slice keeps the existing `BackgroundAgentTask` card and Java cancellation endpoint. A card disables repeated cancellation while its request is in flight, shows an accepted request until the durable terminal state arrives, and gives a retryable error if the RPC fails. The parent Run Header is unaffected. The thread identity used for the request is captured before awaiting the RPC, so switching conversations cannot refresh another thread.

An accepted cancellation is distinct from a completed cancellation. Failure to refresh after an accepted RPC does not turn the accepted request into a failed cancellation; the next snapshot can still settle the card. Server authorization and the durable task status remain authoritative.

The Task 10 prototype's 10,000-item ledger, per-item retry, confirmed root background mode and completion toast have no production data contract yet. Those values are intentionally not projected from child task status or model prose.
