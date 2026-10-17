# AV-01 avatar identity and assignment

Status: implemented on `codex/av01-avatar-storage` ([PR #51](https://github.com/huiliuxu780/WorkPal/pull/51)), 2026-10-17. Based on the [AV-00 decisions](./AV-00-decision.md). This is the first of five avatar delivery stages; visible character rendering begins in AV-02.

## Contract and migration

- `Bot` now has `avatarMode` (`legacy | character | upload`) and nullable `avatarCharacter` (`dot | treble | wave | bounce`). The pair is returned by Bot and SpaceBot APIs. The SQL migration adds columns and a consistency constraint without rewriting `color` or existing rows. Existing Bots stay in `legacy`, including image uploads; their bytes remain available for rollback.
- New Bots without an explicit avatar get `character`. Assignment counts the user's character Bots across all Spaces, including archived Bots, while holding a user-scoped PostgreSQL transaction lock. A preallocated Bot ID supplies a stable hash tie-break. Four initial assignments therefore use four distinct characters even when creation runs concurrently in separate Spaces.
- An explicit image becomes `upload`; a legacy color stays `legacy`. Duplicate copies the source mode, character, and color. The update RPC accepts an explicit character choice and emits the existing `bot.updated` event. Agent-initiated color changes also set the matching mode so the later renderer cannot ignore them.
- Invalid character values from historical or corrupted rows resolve to the safe default `dot`; the raw row is not silently changed. The database constraint prevents new invalid pairs.

## Verification

- Contracts, DB, API, adapter, web, worker and related package type checks passed.
- Focused unit suites: 106/106. They cover first-four assignment, tie stability, invalid fallback, input validation, Bot mapping and update-event behavior.
- Isolated PostgreSQL integration: 3/3 with the new migration applied. It covers cross-Space concurrent creation, user isolation, legacy row preservation, upload and explicit character persistence, clone preservation, and archived-Bot accounting.

## Scope boundary

AV-01 persists identity and preserves old rendering. AV-02 will render compact/full SVG and map trusted activity; AV-04 will migrate legacy non-image Bots before old renderers are removed. No deployment is part of this stage.
