# Task 07 approval ownership and audit slice

The existing `threads.answer` transaction already moves a waiting Run to queued and settles its associated Effect. Before this slice, a different member of the workspace could choose `allow` or `deny` on the Run owner's approval card; only `always` checked the Run owner.

- `commitAnswerRunInput` now rejects all approval decisions unless `answeredByUserId` equals the persisted Run owner. The check occurs before the Effect is looked up or mutated. Ordinary non-approval answers retain their existing authorization behavior.
- New `approval.resolved` events carry `decidedByUserId`. The durable Event row has the decision timestamp; the schema keeps the actor optional so historical events still parse. The Effect ID remains the current request reference and the approval decision remains separate from later Effect execution status.
- Tests cover all three approval choices from another workspace member, owner approval, and the actor in the persisted event payload.

APPROVAL-001 remains open. There is no independent ApprovalRequest entity, explicit parameter-bound request version, expiry/supersede flow, multi-request concurrency, requesting subagent identity, decision history UI, or unified intervention projection. Existing Ask cards remain the actionable surface. The Task 06 safe Effect projection prevents raw request/result from reaching the Run detail endpoint, but approval preview still needs its own server whitelist and access test.
