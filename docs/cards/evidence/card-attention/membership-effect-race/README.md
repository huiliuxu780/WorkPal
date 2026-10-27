# `group-membership.spec.ts:129` read-once race (2026-10-27)

## Symptom

Both local A/B runs of the CI spec union failed the same assertion, on identical
application code:

```
1) [chromium] › e2e/group-membership.spec.ts:26:3 › joins once, delivers once, and returns the result
   Error: expect(received).toBe(expected) // Object.is equality
   Expected: "completed"
   Received: "intended"
   > 129 |       ).toBe("completed");
```

Run A: `../gate-batches/A-mixed-batch-red.txt`. Run B: `../gate-batches/B-split-batches.txt`.

## Cause (from the run-B database, not inferred)

The assertion read the effect row **once**, immediately after the UI showed the
return summary. [`run-b-external-effects.txt`](./run-b-external-effects.txt) is
`external_effects` for `kind='message_group'` in that run's disposable database:

| id | status | createdAt | updatedAt |
| --- | --- | --- | --- |
| cmvquvgfk001vs0x0xmqhnj65 | completed | 15:43:59.216 | 15:44:01.203 |
| cmvqux8n400ads0x05679c44m | completed | 15:45:22.432 | **15:45:40.573** |
| cmvquxqn700cls0x0nm683jkf | completed | 15:45:45.763 | 15:45:46.933 |
| cmvquxvm600e0s0x0wwl9sv0u | completed | 15:45:52.206 | 15:45:53.313 |

Row 2 is this test's own effect. The failing read ran at ~15:45:38.7 (the last
timestamped API log line before the annotation is 15:45:38.712); the row reached
`completed` at 15:45:40.573 — **1.9 s after the read**. Every row ends
`completed`, so the product behaviour was never wrong: the resumed call does
record its tool result, just after the summary message is already visible.

Two fragilities compounded:

1. a single non-polling read of an eventually-consistent row, in a file where
   every other asynchronous fact is polled; and
2. an unscoped `findFirstOrThrow({ where: { kind: "message_group" }, orderBy: {
   createdAt: "desc" } })`, which in a shared batch database resolves to
   "newest such effect anywhere", not "this test's effect".

CI did not hit it (this spec passed on the RT-12 heads, on merged main `a409140`,
and in the gate-on batch of run 40526573873 at `7e46357`); the local runner is
slower and was carrying two E2E runs, which widened the gap.

## Fix

`apps/web/e2e/group-membership.spec.ts` now polls the **same row id** captured
while the card was still pending, bounded at 60 s:

```ts
await expect
  .poll(
    async () =>
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
    { timeout: 60_000, intervals: [500, 1_000, 2_000] },
  )
  .toBe("completed");
```

The assertion still proves "the resumed `message_group` call completed its
effect"; it no longer depends on winning a 2-second race, and it can no longer
read another spec's row.

## Verification

Run C — same spec union, post-split harness, hardened spec, fresh disposable
database `workpal_e2e_gateab_c`: see `../gate-batches/C-split-batches-green.txt`.

## Same class of race: the 375px overflow read in `card-attention.spec.ts`

On 2026-10-28 a local run of `card-attention.spec.ts` (head `d15cc7e` plus the
nested-origin fix) failed `attention queue (N1-N4) › queues pending requests…`
at `card-attention.spec.ts:84`:

```
expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
Expected: true  Received: false
```

The read ran immediately after `page.setViewportSize({ width: 375 })`, while the
popover clamps itself on the frame *after* the resize. The post-failure
screenshot (`apps/web/test-results/card-attention-attention-q-f915f-…/test-failed-1.png`)
shows the panel already clamped inside the viewport (right edge ≈355px of 375),
and the page snapshot shows the expected single queue row — so neither the queue
content nor the layout was wrong at rest; the single read caught the pre-clamp
position (the panel laid out for 1440px overhangs 375px by construction).

The spec now polls the same measurement (10 s bound, 100/250/500 ms intervals),
which keeps the acceptance — the panel must fit at 375px — without racing the
relayout. Verified by a clean focused run of the spec afterwards.
