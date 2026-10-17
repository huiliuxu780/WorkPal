# AV-04: live avatar integration

Status: **done**. Code, data migration and representative live page review are complete.

## What changed

- Current inventory has **20** `BotAvatar` JSX call sites in `apps/web/src`, rather than the older spec's estimate of 17. They all pass a Bot identity through the shared compatibility component. That component now renders `AgentAvatar` for non-uploaded Bots and preserves data-image uploads. The shared `GroupAvatar` uses the same route. No page contains an avatar protocol branch.
- The authenticated app reads `bots.avatarStates` from the authorized server projection every 2 seconds while visible and refreshes active/archived Bot identity. Polls are serialized: a tick while a request is still in flight is skipped, so sustained latency above the interval cannot starve every response out of the staleness guard. An older overlapping response cannot overwrite a newer one. Raw local status strings do not decide character avatar state.
- Collaboration activity rows resolve their avatar by Bot id. The display name is row text, never a catalog key; a name-keyed lookup misses the persisted Bot entry and degrades to an idle "Bot" fallback.
- The 1:1 narration bubble now has a 32px Bot avatar. Group messages continue to show the speaker name on every message, including when silhouettes match; the `+N` group avatar exposes the hidden names.
- Opening the focused failed Run details panel in a visible tab sends the per-Run failure acknowledgement after paint. Generic thread reads do not acknowledge it.
- Migration `20261017020000_convert_legacy_bot_avatars` converts existing non-image legacy Bots to deterministic characters and marks data-image rows as uploads. It preserves `bots.color` bytes for rollback. New writes no longer accept the retired encoded bloub format.
- The old bloub renderer, animation engine, tests, and third-party license were removed. Avatar Studio's current UI accepts one of four frozen characters or a validated image, retaining its two-column dialog layout; AV-05 will add undo, change history, and Bot-request handling.
- Uploaded images retain a server-owned status badge and a state-aware accessible label; the image itself cannot change expression. At 24px and above the badge adds a small state glyph. Avatars embedded in existing buttons inherit the button's keyboard focus, while standalone `AgentAvatar` remains focusable.

## Verification

- 15 workspace app/package type checks passed; production web build passed.
- Focused contract and UI tests: 42/42 before the last explicit mode regression; final workspace checks and AV-05 regression tests cover the combined tree. Isolated PostgreSQL migration test: 1/1, including idempotent rerun and original color preservation.
- Lingui catalogs were extracted and compiled after retiring the old Studio terms.
- Review regressions first failed for an uploaded approval avatar with no state cue and a character avatar creating a second focus stop inside a button. Both pass after the shared renderer fix; the focused UI suites pass 23/23.
- Second review round: a fake-timer regression first starved the state poll under sustained 2.5s latency (no response ever landed), and an activity-row regression first rendered `data-bot-id="Rex"` / "Bot · Idle" from a display-name identity. Both pass after serializing the polls and keying the row avatar by Bot id; the stale bootstrap-era `CollaborationMarker` markup test was updated to the server-owned-state contract. Combined `apps/web` + `packages/ui-web` suites: 605/605, workspace web type check green.
- Live Playwright review: [Studio light](./review/av04-studio-light.png), [Studio dark](./review/av04-studio-dark.png), [Studio narrow](./review/av04-studio-narrow.png), [group light](./review/av04-group-light.png), [group dark](./review/av04-group-dark.png), and [1:1 narrow bubble](./review/av04-one-to-one-narrow.png). The new focused group test confirms two member silhouettes and visible names; the updated reduced-motion and Studio silhouette tests also pass. The 1:1 bubble leaves room for the message at 390px.

## Acceptance interpretation and limit

The source spec's “17 call sites × four sizes × two themes” grid does not map literally to this UI: the inventory is 20 actual `<BotAvatar>` render calls, and each call has one fixed design size. All calls use the same `BotAvatar` adapter, which maps their supplied sizes into the four approved display slots. [The AV-02 static matrix](./review/av02-static-matrix.png) exercises every slot in light and dark themes; the six live captures above check the shared renderer in Studio, group and 1:1 contexts. This is equivalent shared-renderer coverage, not 160 individual page captures. AV-05 owns the separate durable change record and Undo behavior.
