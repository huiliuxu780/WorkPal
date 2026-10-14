# Execution Card (production wiring)

The Execution Card is the default presentation of an execution record in the
chat transcript. It replaces the former one-line `ExecutionShell` header and
forms one continuous object with the expanded detail (Intervention, Plan,
Steps, Todos, Activity, Result). It is a pure presentation layer over the
HISTORY-001 read model — no second lifecycle state machine, no new RPC, and no
execution-semantics change.

Design lineage: Task 15 / 15.1 frozen prototypes
(`WorkPal-design/task15-execution-presentation`, `task15.1-execution-card-refinement`).
The prototype scripts/CSS were re-implemented against `@rakazo/ui-tokens`
variables, not copied.

## Layering

- `apps/web/src/lib/execution-card.ts` — pure mapping
  (`buildExecutionCardModel`): `ExecutionSummary` + the shared
  `deriveExecutionStatus` view + pending Interventions + loaded detail steps →
  card view model. No global state, no RPC, no JSX, no raw runtime errors.
- `apps/web/src/components/ai/ExecutionCard.tsx` — presentation: lifecycle
  rail, status head, title, one auxiliary line, metadata, primary action,
  Intervention slot, collapsible detail. Styles in `execution-card.css`
  (token variables only).
- `apps/web/src/components/ai/ExecutionShell.tsx` — composes both, owns
  `deriveExecutionStatus` (one derivation for head and detail), legacy vs
  server-driven expansion, and the attention-focus action.
- `apps/web/src/pages/Shell.tsx` (`renderExecutions`) — passes the durable
  summary, pending Intervention views, loaded steps and result presence into
  the shell. All rev/expansion/paging guards remain in
  `apps/web/src/lib/execution-history.ts` and are unchanged.

## Data mapping

| Card element | Production source | Rule |
| --- | --- | --- |
| Status sentence | `deriveExecutionStatus(run, activity, {pendingInterventionKinds})` | The only status matrix; head and detail share one derivation. |
| Title | `ExecutionSummary.title` | Omitted when no summary (legacy server). Never generated. |
| Auxiliary line | Priority: pending Intervention `presentation.text` → `status.detail` (latest safe activity / waiting line) → `summary.outcome` (done) → `Step N · <title> · summary.failure` (failed, step only when the untruncated detail is loaded) → omitted | Cancelled shows no result sentence. The safe `failure` projection is the only failure text; raw errors/stacks never render. |
| Artifacts line | `summary.artifacts[].name` | "Generated …"; content never enters the snapshot. |
| Metadata | `summary.counts.{steps,actions,agents,artifacts}`, `summary.durationMs` | Only present, non-zero values; unknown is omitted — never `0`, `--`, or a guess. |
| Head time | `summary.completedAt ?? summary.updatedAt` (terminal only) | Relative-time label. |
| Lifecycle rail fill | loaded detail `steps[].status` | done = full; failed = up to the failed step; otherwise completed/total. Null (base rail only) when steps are missing, truncated, or a failed Run carries no failed step — an unknown failure position is never drawn as complete. |
| Primary action | state matrix below | Real `<button>` with `aria-expanded`/`aria-controls`. |

### Action matrix

| Display state | Verb | Behavior |
| --- | --- | --- |
| approval / need_input / blocked / takeover | `Needs your attention` | Focuses the first enabled control in the Intervention Region (approvals sort first); no collapse — a waiting Run is always expanded. Without an Intervention control (takeover) focus lands on the status sentence. |
| done (collapsed) | `View result` | Expands the detail. |
| queued / working / planning / failed / cancelled / background (collapsed) | `View execution` | Expands the detail. |
| any (expanded) | `Collapse` | Collapses (server-driven expansion stays rev-pinned, one open Run per Thread). |

There is deliberately **no Retry action**: production has no manual-retry
contract (same-Run new Attempt vs new Run, ExternalEffect replay, and
re-approval are all undecided). Failed cards offer `View execution` only.

### Duplication rules

- One status sentence per object: the card head owns it; the expanded detail
  renders no second status header.
- The card's auxiliary line owns the current-activity/waiting sentence; when
  the expanded detail's `ExecutionActivity` primary line would repeat that
  exact text, the detail yields it (context `ExecutionCardContext`).
- The result sentence appears exactly once per screen. While the Run's result
  message bubble is loaded on the current page it is the canonical result
  surface and the card renders **no** outcome line (`resultOnPage`). When the
  bubble is paged out, the card carries the durable `outcome` excerpt while
  collapsed, and the expanded detail renders the snapshot Result section
  instead (the card excerpt then yields). The Result section never renders
  next to its own bubble.
- One open detail per Thread at any moment — initial render, refresh, rev
  moves and waiting states included. `planExpansionDefaults`
  (lib/execution-history.ts) resolves stored rev-matching entries first and
  grants the default-open slot (active, then failed Runs) only while nothing
  else in the Thread is open; stored collapses are kept as-is and, should
  several well-formed entries claim open, only the first in priority order
  keeps the slot (the rest normalize to closed), so the at-most-one contract
  holds unconditionally. With server-driven expansion present, that
  decision is the single authority and `needsAttention` no longer forces a
  detail open. Pending Interventions stay actionable regardless: their region
  renders outside the collapsible detail and the attention action focuses the
  authoritative control without needing the detail open.

### Omitted fields (no trusted production source)

- Root background identity: `deriveExecutionStatus` supports
  `confirmedRootBackground` and the card renders the background presentation
  (no tint, faint rail). The Task Center surface — itself the trusted
  cross-conversation background entry — asserts the flag for its eligible
  root Runs (see `docs/task-center.md`); chat callers still cannot confirm it
  (`execution-shell-progress.md` remaining gate). Trigger/entry were not
  promoted to a background signal and no database field was added.
- Percentage progress and `processed / total` counters: the prototype's
  background-task batch counters have no production contract; the card never
  renders a percentage, a progress track, or a guessed remainder.
- Model pricing / `maxCostUsd`: unsupported compatibility field — parsed and validated on the wire but never enforced, and not a product goal. Usage surfaces show token counts only.
- Task Center: shipped as the card's second entry (see below); the card
  needed no visual change for it.

## Task Center reuse

The Task Center (`/app/tasks`, `docs/task-center.md`) renders the SAME card
stack over `runs.taskCenter` summaries: `deriveExecutionStatus` (empty
activity — unknown detail lines are omitted, never invented),
`buildExecutionCardModel` and the `ExecutionCard` presentation. The only
additions are presentation-level and shared with the chat card:

- `ExecutionCardAction.act` gained `navigate`, and `buildExecutionCardModel`
  accepts an optional `actionOverride` — the Task Center's verb mapping
  (去处理 / 查看结果 / 查看执行 / 回到对话) over the one derived display
  status. Without an override the chat action matrix is untouched.
- `ExecutionCard` takes an optional `onNavigate`; the compact list card
  renders no detail body (`hasDetail=false`, no Execution Shell in the list).

The status matrix, safe texts, state colors, i18n strings and reduced-motion
behavior all remain the single shared implementation.

## Anchoring additions (presentation only)

Two presentation-layer fixes were required so every visible Run owns exactly
one card (no rev/window/anchor semantics changed):

1. A terminal Run whose summary has **no server anchor message** (it failed
   before committing any bot message) previously rendered no shell at all; it
   now falls back to the transcript tail. Paged-out anchors keep waiting for
   their page (no tail jump).
2. A message rendered invisible (activity-only live progress placeholder, or
   a steps-only message with tool-activity display off) previously dropped
   its anchored shell; the invisible-message branch now renders
   `renderExecutions(message.id)` as well as the `before:` anchor.

## Redaction boundary

Unchanged from HISTORY-001: the card shows no Run/Thread/Bot/Attempt ids,
fences, tool arguments/results, raw exceptions, credentials, secrets, tokens,
ExternalEffect payloads, or AgentScope URLs. The shell `<section>` and card
`<article>` carry **no** raw Run id in the DOM (the former `data-run-id` hook
and the per-Run dynamic load-more test id were removed with the card wiring);
E2E locates shells by card title, semantic status and structure instead. The
sessionStorage expansion record still keys on runId plus its three other
whitelisted fields — storage coordination state, never rendered. Secrets
never enter browser storage.

## Accessibility

- Card is an `<article>` with `aria-label` = status sentence + title; glyph
  and rail are `aria-hidden` (state is never color-only — the sentence names
  it).
- The primary action is a real button with an accessible verb,
  `aria-expanded`, and `aria-controls`; ≥32px target (≥40px on coarse
  pointers), visible focus ring.
- Status/aux/meta text meets 4.5:1 against both theme backgrounds using
  token colors (`--foreground`, `--muted-foreground`, `--destructive`).
- `prefers-reduced-motion: reduce` disables the working-glyph breath, rail
  transition, and press transform; no information depends on animation.
- `already_handled` keeps the existing Intervention Region behavior: focus
  the authoritative status line without forcing a scroll.

## i18n

New Lingui source strings (extracted to all catalogs, zh-CN translated):
`View execution`, `View result`, `Collapse`, `Needs your attention`,
`Generated {0}`, `Step {0}`, `1 step`/`{n} steps`, `1 action`/`{n} actions`,
`1 collaborator`/`{n} collaborators`, `1 artifact`/`{n} artifacts`, `Result`,
`Result preview truncated`. Other locales fall back to the English source
until translated, matching existing practice.
