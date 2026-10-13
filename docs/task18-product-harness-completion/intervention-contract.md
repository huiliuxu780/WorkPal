# Intervention contract

Approval, text, choice, and secret input share one server-minted Intervention. Run, Attempt, Ask Block, and ExternalEffect stay the existing execution records.

## Authority

`interventions` is the addressable record. The Ask Block is the redacted preview and carries the same `interventionId`. Thread snapshots project every pending row of the Thread plus terminal rows inside a bounded window: the snapshot's recent terminal Runs (at most 50) and the current message page. The projection never loads the whole Thread history.

Each Intervention persists a strict-whitelist `presentation` snapshot: the question text, the detail preview, the input mode/purpose/options (already columns), and the public credential display fields (handle, origin, auth type). Approval scope, reason, and risk ride on the persisted question and detail; the safe actions ride on the action whitelist. The snapshot never contains answer plaintext, a secret, a credential username, or ExternalEffect request/result bodies.

`InterventionView` renders independently of any Message row, so a card keeps its question and safe preview after a refresh even when its source message has left the current page.

Reads never backfill. A still-pending legacy ask with no row yet is synthesized as a virtual view from the Ask Block on the current page. `legacy_<messageId>` is persisted the first time a still-pending legacy ask is answered, expires, or is cancelled, and that insert is where the sanitized `presentation` snapshot is stored. A row that was created before the presentation column existed gets its snapshot written on its first terminalization. Already answered or expired history is left alone.

There is no production replacement path, so `superseded` is not written.

## Transactions

Create, answer, timeout, and cancel take locks in this order:

1. Thread row, one Thread per id in ascending order when several are touched.
2. Run row, in run-id order when several runs are cancelled together.
3. Intervention row.
4. Conditional ExternalEffect update (`intended` only).
5. Message update.
6. Product events.

Terminalization helpers acquire these locks themselves: `cancelPendingInterventions`, `expirePendingIntervention`, and `settleAnsweredIntervention` lock the affected Threads (sorted) and Runs before any Intervention or Event write, and `intervention.resolved` appends inside the held Thread lock. A caller that already holds the locks pays nothing; a caller that forgot them is still ordered. The wait-timeout path settles the Intervention before it expires the ExternalEffect, so no entry writes an Effect ahead of the Run/Intervention locks; its single `intervention.resolved` projection is emitted after the Effect transition, so an expired Approval card carries the post-transition `effectStatus` instead of `intended`.

Creating an Intervention updates the Run to `waiting_input` only after the thread lock, and inserts the Intervention, Ask Block, and `intervention.created` event in that same transaction. A second pending row for the Run, or an Approval without its ExternalEffect, rolls the transaction back.

An answer, timeout, and cancel can each move a pending row once. The loser sees the committed status. A repeated cancel or timeout matches zero pending rows and does not append another terminal event.

`clientSubmissionId` is an opaque retry key. It is stored only after the transition commits. The same key returns the first `accepted` result. A different key on a terminal row returns `already_handled`.

The Run returns to `queued` only when the answer did not cancel it and that Run has no remaining pending Intervention. The continue job is enqueued after commit.

## Events

`intervention.created` and `intervention.resolved` are written beside the existing `approval.requested` and `approval.resolved` events. Payloads carry ids, revision, kind, status, the public actor, and the same strict-whitelist `presentation` snapshot as the row. They do not carry answer text, secrets, or ExternalEffect request/result bodies.

`approval.*` stays until the activity projector consumes intervention events and old clients are gone. The transcript renders one card from the Intervention projection, not a second card from `approval.requested`.

## API

`threads.resolveIntervention` loads the Thread, Run, Message, and Effect from `interventionId`. `resolvedByUserId` comes from the signed-in actor. `threads.answer` remains a compatibility adapter and is deprecated.

Composer, inbound, and voice text answer a Run only when the considered waiting Runs have exactly one ordinary text input. Approval, secret, and choice are never submitted from free text. More than one text input is a conflict — during the upgrade window, table-backed rows and legacy row-less asks are merged into one candidate set first, so a new text Intervention next to a still-waiting legacy ask refuses rather than silently picking the row.

## Rollback

The `20261013100000_interventions` migration adds `interventions` and `intervention_submissions` only. The `20261013110000_intervention_presentation` migration adds one nullable `presentation` JSONB column. Neither rewrites messages, events, runs, or effects. Rolling back the application before dropping the tables leaves those new rows unread; rows without a snapshot fall back to Ask-Block synthesis while their message is on the current page. Dropping the tables removes the new audit rows and submissions; historical messages and effects remain.
