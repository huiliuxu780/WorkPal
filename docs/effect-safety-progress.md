# Task 06 effect safety slice

The existing Run details endpoint serialized `ExternalEffect.request` and `result` verbatim. Those JSON fields can contain credentials or private content and have no display whitelist. The Actions design also identifies `uncertain` as a real ledger state, while the old view rendered it as raw text with a muted tone.

## Implemented

- The public Run effect row now contains ID, kind, status and creation time only. Prisma selects only these columns; raw request/result remain in the backend ledger for the executor and reconciliation path. The browser no longer receives them through this endpoint.
- The Effect status enum includes all current executor values plus legacy values. The detail view renders human-readable action names and cautious status labels. `executing` means an execution claim, not proof that a request was sent. `uncertain`/legacy `ambiguous` explicitly warn that external acceptance or execution cannot be confirmed and provide no blind retry action. Even `completed` is labeled as a recorded call outcome, not an independently verified external receipt.
- Chinese translations and targeted tests cover the public boundary and status semantics.
- The Agently mail adapter distinguishes a timed-out, aborted or unexpectedly killed CLI send from a definite local failure. After a claimed send is interrupted, the executor settles its Effect as `uncertain` and returns the existing non-replay result. A later identical call sees that ledger state and cannot blindly send a duplicate.

## Remaining gates

- The previous raw JSON disclosure is intentionally unavailable until the backend provides a server-side display whitelist, authorization and safe evidence references. This is a behavior restriction to prevent leaking stored request/result content, not a claim that full Action Detail is implemented.
- The complete Actions Slot still needs stable call identities, general paused/timeout semantics, Attempt links, side-effect-safe grouping, terminal history and authorized Evidence. A live SMTP acceptance/timeout trace is still needed; the unit test covers the adapter's timeout signal and the existing uncertain-ledger transition separately.
- No live Java→Web Action/Evidence acceptance has been run for this slice.
