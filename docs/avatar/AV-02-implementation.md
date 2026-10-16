# AV-02 static avatar and trusted state

Status: implemented on `codex/av02-static-avatar`, 2026-10-17. Stacked on AV-01.

## Visual contract

- The four full-size SVGs and four AV-00 compact-v0.7 SVGs are copied without byte changes. Eight runtime prop SVGs are also exact copies. The supplied `check.svg` is a review sheet containing `<text>` and is intentionally absent from runtime assets; its original remains in `docs/avatar/source/final/assets/props/`.
- A deterministic generator converts only the checked-in SVG files into React SVG nodes. The component uses no runtime fetch, HTML parser, or injected HTML. At 16px it uses the compact silhouettes and a 6px point with a 1.5px surface-colored border; at 24/32/64px it uses the full silhouettes and state props with no point. The 24px card and question get a separate 1.34× prop scale to exceed the 6px minimum. Failed state replaces pupils with the character's frozen X-eye asset.
- Light-theme point colors are the AV-00 approved darker tokens; dark-theme points retain the frozen colors. The point test calculates contrast against the actual five `@rakazo/ui-tokens` surface colors in both themes and requires at least 3:1. Dark mode supplies a white silhouette outline. Name and state are in the accessible label and focus tooltip; only approval, waiting and failed changes use polite announcements. Reduced motion keeps the static frame.
- [Static matrix](./review/av02-static-matrix.png) records four characters × five states × four slots × two themes from the exact asset/CSS set.

## Durable state and acknowledgement

- A new authorized `bots.avatarStates` read model returns one typed state, source Run ID, revision and update time per visible Bot in the current Space. It derives from persisted Run, pending Intervention and active background-task rows. An orphaned wait is idle; queued and terminal background work do not pretend to be active. Unacknowledged failures outrank pending approval, then waiting, then work; stable Run ID resolves ties.
- `avatar_failure_receipts` stores a per-user, per-Run focused-detail acknowledgement. The migration marks existing failed Runs seen, preventing an old backlog from appearing new. `bots.acknowledgeAvatarFailure` enforces owner, Space, Bot and failed-Run checks; thread `unread=false` does not acknowledge. The read model ignores failures from a cleared thread generation. A receipt excludes its Run directly in the database query, so old failures do not grow the result set.
- The 13 ActivityKind values map exhaustively to five states in the shared contract. State selection reads durable product facts; it does not infer state from transient AgentScope internals. AV-04 will subscribe/refetch and call the acknowledgement endpoint only when focused failure detail is actually visible.

## Verification and scope

- 19/19 unit tests across the component, mapping and avatar contract; exact runtime SVG byte checks and no runtime `<text>`; contrast against real light/dark surfaces; four slot render assertions and accessible labels.
- 2/2 isolated PostgreSQL tests with the new migration: concurrent Runs and priority, generic read versus explicit acknowledgement, cross-user/Space denial, Thread Clear, and a background task outliving its parent Run.
- All 15 affected workspace application/package type checks passed. Playwright rendered the 160-state static matrix for visual inspection.
- This stage does not switch current BotAvatar call sites and does not animate. AV-03 supplies motion and a global three-instance clock; AV-04 replaces call sites and wires state updates.
