# Tasks 01–02 Execution Shell and status

The design files describe target presentation, not a working projection. This slice uses only persisted Run status, wait kind, the existing Activity projection, and the structured Plan/Step/Todo snapshots.

## Implemented

- `deriveExecutionStatus` computes a display status without storing a second Run state. Root terminal status wins over stale activity; approval/input/takeover waits win over planning or working. Queued and leased foreground Runs use non-running labels. A child background activity never confirms that the root Run moved to background.
- `ExecutionShell` shows one inline status Header and groups same-Run Plan, Steps, Todo and activity. The Header is keyboard focusable, tracks `aria-expanded`, hides and inerts folded detail, and keeps waiting detail open. It avoids a second “Working” label inside activity.
- The transcript places terminal and waiting shells before the associated bot message when that message is the available anchor. A source message still takes precedence. Active Runs without structured content receive a status Header at the live tail.
- Chinese labels are added to the existing Lingui catalog. Other locales currently fall back to the English source text for new strings.

## Verified

- Web TypeScript check and production build pass.
- Web suite: 65 files, 426 tests pass. Focused status tests cover terminal priority, wait kind, child background non-promotion and missing root Run; Shell tests cover waiting visibility and compact terminal presentation.
- PR #18, the parent Task 04 slice, has green CI.

## Remaining gates

- Root `foreground/background` identity and automatic transition have no trusted production field. The Background status is defined in the selector but not asserted by the current transcript.
- The backend does not expose a stable Assistant Turn ID or a historical Run row for every retained Plan/Step; such content shows “status unknown” rather than a guessed terminal state. Some older messages may be paged out, so the present message anchor may not exist in the loaded page.
- Ask and approval controls remain on their existing message cards. The Shell can keep its waiting detail visible but cannot move a verified action payload into an Intervention slot without a shared intervention contract. No independent Result summary is available.
- Real browser checks at multiple widths, 200% zoom, keyboard focus and reduced motion, plus live Java→Web status transitions, are still required for Task 12/14 acceptance. Static render tests and a production bundle build do not establish those behaviors.
