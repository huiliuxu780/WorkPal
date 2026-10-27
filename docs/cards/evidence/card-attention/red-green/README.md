# CARD-01D review round: red-first fixes for the three P2 findings

Branch `codex/card-attention`, PR #147. All three fixes were proven red on the
**final** regression cases before the fix was applied: the two source files were
restored to `7e46357` with `git stash push -- packages/db/src/attention.ts
apps/web/src/pages/AttentionQueue.tsx`, the tests were run (red), then
`git stash pop` restored the fix (green). Test files were byte-identical across
the red and green runs; `fix-diff.patch` in this directory is the exact source
delta between the two.

Common versions: node v22.23.3, pnpm 9.15.0, vitest 4.1.11, git HEAD
`7e463570f5f86ee9e792a65b509ee41fe4a8c13e`.

## Finding 1 — comment 4390254749 (`packages/db/src/attention.ts`)

A settled `mcp_approval` block excluded its pending sibling **in the same
message**, because the SQL filter negated at message granularity
(`NOT array_contains [{kind: mcp_approval, status: connected}]`).

- Regression case: `packages/db/src/attention.postgres.test.ts` →
  `keeps a pending MCP approval whose sibling in the same message settled`
  (one bot message with a `connected` and a `pending` MCP block; the same case
  also pins that a pre-upgrade block with no `status` still reaches the queue).
- Red: [`RED-p2-1-p2-3-postgres.txt`](./RED-p2-1-p2-3-postgres.txt) —
  `page.items.find(presentation.text === "Still pending")` was `undefined`.
- Fix: add the positive per-status branch
  `array_contains [{kind: "mcp_approval", status: "pending"}]`; the remaining
  negative branch now only admits pre-upgrade blocks that cannot be matched
  positively. Whether a block is pending is decided per block by the projection.
- Green: [`GREEN-p2-1-p2-3-postgres.txt`](./GREEN-p2-1-p2-3-postgres.txt) — whole
  file, 8/8 (the 6 pre-existing cases are the regression cover).

## Finding 2 — comment 4390254763 (`apps/web/src/pages/AttentionQueue.tsx`)

Out-of-order responses resurrected settled requests: poll, focus, refresh and
load-more all call one `load`, and a slow response landing after a newer one
overwrote the queue and re-notified an item the user had just settled.

- Regression case: `apps/web/src/pages/AttentionQueue.test.tsx` →
  `drops a superseded response so a settled request cannot resurrect`
  (two deferred `attention.list` calls; the newer one resolves first with an
  empty page, the superseded one resolves afterwards with the old pending item).
- Red: [`RED-p2-2-web-race.txt`](./RED-p2-2-web-race.txt) — 1 notification fired
  and the settled row was back in the queue.
- Fix: a monotonic `requestSeq` ref; a response whose sequence is no longer the
  newest is discarded before it may write state or an error.
- Green: [`GREEN-p2-2-web-race.txt`](./GREEN-p2-2-web-race.txt) — whole file, 8/8.

## Finding 3 — comment 4390254772 (`packages/db/src/attention.ts`)

Archived destinations entered the queue, and their source could not be opened.

- Regression cases: `packages/db/src/attention.postgres.test.ts` →
  `drops requests whose group was archived` (standard group + pending
  intervention + pending `app_connect` block, then `chatGroup.archivedAt` set) and
  `drops requests whose direct chat bot was archived` (same shape for a DM whose
  Bot is archived: `repos.getBot()` rejects an archived Bot exactly like
  `getGroupTarget()` rejects an archived group, so neither source can open).
- Red: same log as finding 1 — both rows were still returned.
- Fix: the thread scope now requires `bot: { archivedAt: null }` or
  `group: { kind: "standard", archivedAt: null }`, matching how the rest of the
  API decides what is navigable (for example `apps/api/src/search.ts`).
- Green: same log as finding 1.

Red totals: 3 failed / 6 skipped. Green totals: 9 passed (whole file).

## Commands

```sh
# PostgreSQL cases (red and green)
export $(grep -E '^DATABASE_URL=' /Users/rivers/Documents/WorkPal/.env | xargs)
export VERIFY_DATABASE=1
pnpm exec vitest run packages/db/src/attention.postgres.test.ts                        # green: whole file
pnpm exec vitest run packages/db/src/attention.postgres.test.ts -t "sibling|archived|retired"  # red capture

# Web race case (red and green)
pnpm exec vitest run apps/web/src/pages/AttentionQueue.test.tsx            # green: whole file
pnpm exec vitest run apps/web/src/pages/AttentionQueue.test.tsx -t "superseded"        # red capture
```
