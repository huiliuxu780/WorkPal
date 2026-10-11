# Task 08 input draft and submission feedback slice

The existing `threads.answer` RPC commits the answer transaction and queues the Run; the Web client then refreshes the thread. A typed answer that was not submitted disappeared on refresh, and a disabled submit button could lose keyboard focus without a stable feedback target.

- A normal single-field text Ask stores its unsent value in `sessionStorage` under the Run and message IDs. It restores the value on reload, shows a restore note and clears it after a server-accepted answer or an answered/expired snapshot.
- Secret Ask answers never read or write browser storage. Tests exercise this boundary and Run/message isolation.
- The card exposes a focusable status line while submitting, after RPC acceptance while the snapshot catches up, and on error. It focuses the feedback after a local submission. Approval decisions use the same feedback behavior without a stored draft.
- On a server conflict, the client refreshes the authoritative Ask card before showing the error. A successful answer remains accepted even if the subsequent refresh fails; the thread subscription can reconcile it later.

This slice retains the existing message-card placement. INPUT-001 still needs independent request IDs, structured field validation, idempotent submission IDs and conflict details, file/multi-field inputs, and a shared Intervention region. A server RPC success confirms the answer, not that execution has resumed; the Header follows later Run events.
