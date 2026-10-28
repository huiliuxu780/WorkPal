# CARD-01D attention queue evidence

Captured from the production Web app against the real API and PostgreSQL
(`pnpm test:e2e --runtime=scripted --spec="card-attention.spec.ts"`), with the
`cards_unified_v2` gate on. Not component fixtures. The run in this directory
is the review-round capture: 2 passed (1.5m), PostgreSQL 16 testcontainers,
`--runtime=scripted`, sandbox `fake` — the same combination as the CI `web` job.

| File | Scenario |
| --- | --- |
| `N1-queue-1440.png` | N1: the sidebar Attention entry with its count and the floating queue over a real pending input; the row shows the Bot, the direct chat, and a safe summary. |
| `N1-queue-375.png` | N1 at 375px; the panel fits without horizontal overflow. |
| `N1-queue-375-dark.png` | N1 at 375px in dark mode, after the appearance listener resolved the dark tokens. |
| `N1-queue-390-dark.png` | N1 at 390px in dark mode. |
| `N1-queue-denied-1440.png` | Browser notifications denied: the queue still lists the request and the count. |
| `N2-member-waiting-1440.png` | N2: the group member panel marks the Bot whose own pending item is in that group. |
| `N3-badges-1440.png` | N3: the numeric pending pill on the Attention entry and the shape-only unread dots on roster rows, captured together. |
| `N4-notification-1440.png` | Page state when the fake Web Notification fired for a new request in another thread (the notification itself is asserted through the browser API test double). |

Keyboard evidence is in the E2E: Escape closes the panel and returns focus to
the entry, and opening a row focuses the source Interaction card
(`data-interaction-id`). The notification assertions cover content (Bot + fixed
copy only), dedupe by `interactionId:revision`, foreground suppression, the
terminal stop, and click-through to the source.

## Review round: notification redaction

Review found that the notification body was the Bot-authored
`presentation.text` (truncated), so a file name, recipient or clause from the
agent's own wording could reach the OS notification, and the E2E "sensitive
scan" regex only really tested `@` (the `\\$`/`\\d{4}-\\d{4}` alternatives match
literal backslashes).

Fixed in this branch, matching the updated N4 section of
`docs/cards/source/card-unification-v2/mockup/cards-hifi-v4/b-alerts.html`:

- `AttentionQueue.notificationBody` is now one fixed sentence per kind
  (approval / plan review / desktop handoff / question). No Bot text, task
  title, argument or file name is concatenated.
- The E2E asserts the exact fixed sentence, that the Bot question is absent,
  and that the body contains no `@`, digit or slash.
- With `cards_unified_v2` on, the legacy per-bot notifier is disabled entirely
  (`shouldNotifyLegacyBrowser`), so ordinary messages, progress and terminal
  events no longer notify behind the attention queue. Unit-covered in
  `browser-notifications.test.ts` and red-green'd below.

Red-green (same test, same environment, pre-fix code restored with
`git checkout HEAD -- apps/web/src/pages/AttentionQueue.tsx`):

- red: `expected 'Ship the release? Open WorkPal to rev…' to be 'A question is waiting for your answer…'` (`red-green/RED-p2-5-notification-copy.txt`)
- green: 8/8 in `AttentionQueue.test.tsx` (`red-green/GREEN-p2-5-notification-copy.txt`)

## N3 and the `@我` gap

N3 in the prototype asks for three distinct markers: unread, pending, `@我`.
This build has unread (shape-only dot + "(unread)" text) and pending (numeric
pill on the Attention entry); `N3-badges-1440.png` shows both at once, and the
E2E asserts the pill carries digits while the unread dot is `aria-hidden`.

`@我` has no product concept in this repository: no data model, no RPC field
and no UI surface exist for "mentioned me", so it is neither implemented nor
asserted here. Treating it as done would be a false claim; if the marker is
required, it needs its own product scope and prototype.

## Expired rows

The read model deliberately keeps a still-`pending` row whose `expiresAt` has
passed; expiry is settled by the wait-timeout job, not hidden by the query
(comment in `packages/db/src/attention.ts`, test renamed to
"keeps a still-pending row past its expiresAt until the timeout job expires
it"). Terminal `answered`/`cancelled`/`superseded` rows never enter. If the
card's "expired 排除" is meant to include past-`expiresAt`-but-pending rows,
that is a product decision, not a test fix.

## Other review findings left untouched

- `SOURCE_LIMIT = 500` per source silently truncates and undercounts `total`
  beyond that; not exercised.
- Group-origin rows do not re-check `bot.archivedAt` (direct rows do); archive
  cancels active runs, so the window is narrow, but it is unverified.
