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
| Lifecycle rail fill | loaded detail `steps[].status` | done = full; failed = up to the failed step; otherwise completed/total. Null (base rail only) when steps are missing or truncated. |
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
- The card's `outcome` excerpt yields while the expanded detail renders the
  Result section; the Result section itself renders only when the result
  message bubble is not loaded (paged-out history) — the adjacent bubble
  remains the canonical full result.

### Omitted fields (no trusted production source)

- Root background identity: `deriveExecutionStatus` supports
  `confirmedRootBackground` and the card renders the background presentation
  (no tint, faint rail), but no production caller can confirm it yet
  (`execution-shell-progress.md` remaining gate). Trigger/entry were not
  promoted to a background signal.
- Percentage progress and `processed / total` counters: the prototype's
  background-task batch counters have no production contract; the card never
  renders a percentage, a progress track, or a guessed remainder.
- Model pricing / `maxCostUsd`: unchanged, awaiting a trusted price source.
- Task Center: not implemented; the card is built for reuse by it later.

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
ExternalEffect payloads, or AgentScope URLs. The pre-existing
`data-run-id` test hook stays on the shell `<section>` (machine-readable,
used by E2E); the card `<article>` itself carries no ids. Secrets never
enter browser storage; the expansion record keeps its four whitelisted
fields.

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
