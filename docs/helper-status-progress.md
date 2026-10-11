# Task 11: helper status semantics

The existing subagent message block now labels running, completed, failed and cancelled states with translated user-facing text. A cancelled helper uses a neutral tone, a failed helper uses warning, and a running helper uses working text. The pulse animation was removed from this badge. These child states do not alter the parent Run Header.

The full Task 11 collaboration slot still needs a durable identity/routing read model, ordered handoff chain and requestor attribution. Message blocks alone do not provide those facts, so this slice does not synthesize them.
