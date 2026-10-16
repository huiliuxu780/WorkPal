# AV-04: live avatar integration

Status: **in progress**. Code and data migration are implemented; live page visual review remains before final acceptance.

## What changed

- Current inventory has **20** `BotAvatar` JSX call sites in `apps/web/src`, rather than the older spec's estimate of 17. They all pass a Bot identity through the shared compatibility component. That component now renders `AgentAvatar` for non-uploaded Bots and preserves data-image uploads. The shared `GroupAvatar` uses the same route. No page contains an avatar protocol branch.
- The authenticated app reads `bots.avatarStates` from the authorized server projection every 2 seconds while visible and refreshes active/archived Bot identity. An older overlapping response cannot overwrite a newer one. Raw local status strings do not decide character avatar state.
- The 1:1 narration bubble now has a 32px Bot avatar. Group messages continue to show the speaker name on every message, including when silhouettes match; the `+N` group avatar exposes the hidden names.
- Opening the focused failed Run details panel in a visible tab sends the per-Run failure acknowledgement after paint. Generic thread reads do not acknowledge it.
- Migration `20261017020000_convert_legacy_bot_avatars` converts existing non-image legacy Bots to deterministic characters and marks data-image rows as uploads. It preserves `bots.color` bytes for rollback. New writes no longer accept the retired encoded bloub format.
- The old bloub renderer, animation engine, tests, and third-party license were removed. Avatar Studio's current UI accepts one of four frozen characters or a validated image, retaining its two-column dialog layout; AV-05 will add undo, change history, and Bot-request handling.

## Verification

- 15 workspace app/package type checks passed; production web build passed.
- Focused contract and UI tests: 42/42 before the last explicit mode regression, then rerun at final gate. Isolated PostgreSQL migration test: 1/1, including idempotent rerun and original color preservation.
- Lingui catalogs were extracted and compiled after retiring the old Studio terms.

## Open acceptance

Complete real page light/dark visual review of the 20 call sites and confirm the 1:1 bubble does not crowd narrow widths. AV-05 must add a durable change record and one-step undo before this feature sequence can be called complete.
