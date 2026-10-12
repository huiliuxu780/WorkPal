# Intervention contract

Approval, text, choice, and secret input share one server-minted Intervention. Run, Attempt, Ask Block, and ExternalEffect stay the existing execution records.

## Authority

`interventions` is the addressable record. The Ask Block is the redacted preview and carries the same `interventionId`. Thread snapshots project pending rows, and synthesize a virtual pending view for a legacy ask that has no row yet. A read does not insert that row.

`legacy_<messageId>` is persisted the first time a still-pending legacy ask is answered, expires, or is cancelled. That insert emits `intervention.resolved` only. Already answered or expired history is left alone.

There is no production replacement path, so `superseded` is not written.

## Transactions

Create, answer, timeout, and cancel take locks in this order:

1. Thread row.
2. Run row, in run-id order when several runs are cancelled together.
3. Intervention row.
4. Conditional ExternalEffect update (`intended` only).
5. Message update.
6. Product events.

Creating an Intervention updates the Run to `waiting_input` only after the thread lock, and inserts the Intervention, Ask Block, and `intervention.created` event in that same transaction. A second pending row for the Run, or an Approval without its ExternalEffect, rolls the transaction back.

An answer, timeout, and cancel can each move a pending row once. The loser sees the committed status. A repeated cancel or timeout matches zero pending rows and does not append another terminal event.

`clientSubmissionId` is an opaque retry key. It is stored only after the transition commits. The same key returns the first `accepted` result. A different key on a terminal row returns `already_handled`.

The Run returns to `queued` only when the answer did not cancel it and that Run has no remaining pending Intervention. The continue job is enqueued after commit.

## Events

`intervention.created` and `intervention.resolved` are written beside the existing `approval.requested` and `approval.resolved` events. Payloads carry ids, revision, kind, status, and the public actor. They do not carry answer text, secrets, or ExternalEffect request/result bodies.

`approval.*` stays until the activity projector consumes intervention events and old clients are gone. The transcript renders one card from the Intervention projection, not a second card from `approval.requested`.

## API

`threads.resolveIntervention` loads the Thread, Run, Message, and Effect from `interventionId`. `resolvedByUserId` comes from the signed-in actor. `threads.answer` remains a compatibility adapter and is deprecated.

Composer, inbound, and voice text answer a Run only when the considered waiting Runs have exactly one ordinary text input. Approval, secret, and choice are never submitted from free text. More than one text input is a conflict.

## Rollback

The migration adds `interventions` and `intervention_submissions` only. It does not rewrite messages, events, runs, or effects. Rolling back the application before dropping the tables leaves those new rows unread. Dropping the tables removes the new audit rows and submissions; historical messages and effects remain.
