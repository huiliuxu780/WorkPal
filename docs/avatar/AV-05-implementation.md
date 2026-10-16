# AV-05: avatar changes, provenance and undo

Status: **done in [PR #55](https://github.com/huiliuxu780/WorkPal/pull/55)**, stacked on AV-04. CI and review remain the merge gate.

## Product behavior

- Avatar Studio retains the two-column dialog and offers the four frozen characters or a local PNG/JPEG/WebP. It decodes and center-crops the image to 256×256 WebP before writing. The settings view updates optimistically, rolls back on failure, shows a five-second Undo notice on success, and offers the five most recent changes in a compact history list.
- A Bot may call `change_avatar` for its own character or the single image attached to the current authenticated user message. The executor checks the stored source message ID, thread, role, `human_web` origin, author ID and a single-purpose request before writing. A requested character must equal the tool argument; image requests require exactly one image block. Other Bots, web/tool content, routines and messages with extra instructions do not grant permission. The accepted direct phrases are intentionally narrow (e.g. “请把头像换成波浪” or “Change your avatar to wave!”); a broader natural-language command requires a reviewed authorization design.
- A successful Bot change writes the avatar row, change record and in-thread `avatar_change` card in one database transaction. The card exposes Undo when the change is still latest. The previous `update_bot` avatar fields are removed from its model-facing schema and reject old tool arguments; profile fields remain available. `bots.update` still accepts its existing API contract, but its avatar fields now pass through the same transactional change/audit boundary.

## Persistence and permissions

- `bot_avatar_changes` records Bot/user source, Run ID for Bot changes, before/after mode and character, timestamps and optional tool operation key. Reads and undo require the same user and Space as the Bot. `SELECT ... FOR UPDATE` serializes writes per Bot; only the latest matching current avatar can be undone, and repeating Undo fails closed. Operation keys deduplicate tool retries.
- The history API exposes the latest 50 records per Bot. Older user changes are pruned, while Bot operation-key rows remain as metadata-only tombstones so a delayed tool retry cannot reapply a stale avatar. These tombstones cascade away with Bot deletion and can grow with the number of Bot-initiated changes; they retain no image bytes. Only the latest, still undoable record retains exact color/image bytes. Older rows clear both color columns; a successful Undo clears those bytes as well. This bounds duplicate upload retention in the change table to one record per Bot. `bots.color` deliberately remains unchanged when switching to a character, as AV-00 requires for legacy rollback. It can therefore retain an older upload even while the character is displayed; deletion of the Bot removes it. A stricter image-erasure policy would require changing that earlier contract.
- The user-facing history API returns metadata only. It never returns saved image bytes.
- The new direct RPC upload path decodes and normalizes PNG/JPEG/WebP on the server; malformed data is rejected without writing a change. The older `bots.update` contract continues to accept its legacy GIF data-URL path for compatibility.
- Direct Studio changes and Undo append `bot.updated` in the same transaction as the avatar write, then notify the Bot thread. A second-tab E2E confirms both directions update without an unrelated refresh. Legacy `bots.update` can still set `avatarMode: "legacy"` while retaining an existing uploaded image value.

## Verification

- Isolated PostgreSQL test covers exact image restoration, unauthorized user rejection, idempotent retries after 50 later changes, stale Undo, 50-item visible history, legacy mode-only compatibility, image-byte clearing and Bot deletion cascade.
- Parser and provenance tests cover direct Chinese/English commands and reject injected context, multiline/markup, ambiguous attachments, extra blocks, wrong source, author, role, thread and trigger.
- Scripted-runtime Web E2E exercises the production executor, message/event transaction, rejected injection fixture and RPC Undo path; this verifies wiring and permissions, not real-model willingness to obey the instruction.
- Final gate: `pnpm check` 18/18; Web production build passed; 10 focused Vitest files 181/181; isolated PostgreSQL change tests 6/6; focused Playwright tests 8/8 (Bot change, Studio 2 including second-tab event delivery, group avatar, character silhouettes, reduced motion, Bot CRUD and peer messages). Lingui extraction/compilation passed. The older, broad `group-chats.spec.ts` still fails beyond its avatar check: its scripted transcript expects both mentioned Bots to answer, while the current fixture answered only one. It also has obsolete selectors in the baseline. The focused avatar group test passes; no claim is made that the broad group suite is green.

## Boundary and review

AV-04's representative-page visual review is in [its implementation note](./AV-04-implementation.md). The Bot request grammar is deliberately constrained; requests that do not match a supported direct form return a clear tool error and can be completed in Studio. The five-second Undo notice is a UI window; the newest unmodified change can still be undone from its in-thread card when applicable. Historical rows intentionally expose no image bytes or multi-step rollback.
