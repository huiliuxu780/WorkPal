# CARD-01D attention queue evidence

Captured from the production Web app against the real API and PostgreSQL
(`pnpm test:e2e --runtime=scripted --spec="card-attention.spec.ts"`), with the
`cards_unified_v2` gate on. Not component fixtures.

| File | Scenario |
| --- | --- |
| `N1-queue-1440.png` | N1: the sidebar Attention entry with its count and the floating queue over a real pending input; the row shows the Bot, the direct chat, and a safe summary. |
| `N1-queue-375.png` | N1 at 375px; the panel fits without horizontal overflow. |
| `N1-queue-375-dark.png` | N1 at 375px in dark mode, after the appearance listener resolved the dark tokens. |
| `N1-queue-390-dark.png` | N1 at 390px in dark mode. |
| `N1-queue-denied-1440.png` | Browser notifications denied: the queue still lists the request and the count. |
| `N2-member-waiting-1440.png` | N2: the group member panel marks the Bot whose own pending item is in that group. |
| `N4-notification-1440.png` | Page state when the fake Web Notification fired for a new request in another thread (the notification itself is asserted through the browser API test double). |

Keyboard evidence is in the E2E: Escape closes the panel and returns focus to
the entry, and opening a row focuses the source Interaction card
(`data-interaction-id`). The notification assertions cover content
(Bot + safe summary only), dedupe by `interactionId:revision`, foreground
suppression, the terminal stop, and click-through to the source.
