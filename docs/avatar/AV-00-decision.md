# AV-00 avatar contract decisions

Status: **open**, 2026-10-15. This is the sole WorkPal record for decisions that must be settled before AV-01–AV-05. The external avatar spec and frozen SVG/MOTION-SPEC remain unchanged. Record a decision, owner, date and acceptance effect for each row; do not infer agreement from a chat summary or an implementation shortcut.

| Question | Verified current fact / conflict | Decision | Owner and date | Acceptance effect |
| --- | --- | --- | --- | --- |
| Size contract | The current request names 16px and 24px; the avatar spec defines 16/24/32/64 display slots. Current Web call sites also use intermediate sizes. Two SVG source modes (compact 16 and full 24+) could support four display sizes, but that interpretation is not yet confirmed. | **Pending** | — | Define exact allowed display sizes and mapping of existing surfaces. |
| Bot-level state | Most `BotAvatar` callers receive `bot.status`, while Activity Projection is scoped to execution/thread facts. A Bot can have multiple Runs and background work. | **Pending** | — | Name the authoritative Bot-level read model, precedence, freshness and fallback; test replay/live parity. |
| Failure seen | The avatar spec says failed remains visible until the user has seen it; no trusted read receipt has been identified for that rule. | **Pending** | — | Define the durable or session-scoped seen signal and when failed yields to another state. |
| 16px contrast | On white, the frozen status colors have contrast ratios of 1.74 (green), 1.59 (yellow), 2.10 (blue) and 2.42 (orange), below the UX requirement of 3:1. A stroke matching the white background does not raise that contrast. | **Pending** | — | Approve light-theme colors/outline treatment and measure ≥3:1 in both themes without using color as the only signal. |
| Character storage and old avatars | Current `Bot.color` stores legacy color/shape/bloub encodings or image data; account `avatarStyle` still defaults to `bloub`. Existing saved values must remain readable while the new character choice is introduced. | **Pending** | — | Define new value/column, precedence, backfill and rollback; preserve uploads and old Bot appearance until migration is verified. |
| Animation tie-breaker | The motion spec caps the page at three moving instances and orders different states; “current conversation Bot first” within one priority is unresolved in the source spec. | **Pending** | — | Define stable ordering for equal-priority instances and test mount/unmount and visibility changes. |

## Close-out rule

AV-00 moves to `done` in [the planning index](../next-work-roadmap.md) only after all rows have explicit decisions and acceptance effects, the final source assets/spec version is pinned for implementation, and the approved contract is reviewed against current `main`. Any later change is added here as a dated revision rather than silently changing an earlier decision.
