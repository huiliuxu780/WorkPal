# UX-01 Execution Progress Unification — decision record

Status: decisions adopted by RiversXu on 2026-10-18. UX-01 stays `in-progress` in the roadmap: no implementation branch exists yet, and implementation may not start before PR #55 is merged into `main`. This is the sole decision record for UX-01 (same pattern as [AV-00-decision.md](../avatar/AV-00-decision.md)). Sources: `myagent/docs/plan-todo/REQ-plan-todo-steps.md` v1 (13 pending items, divergences D1–D8), the product-side review `gpt-advice-review-product.md` (conflicts C1–C7, freeze candidates F1–F8, open items X1–X11), the dev-side verification `gpt-advice2-review-dev.md`, and RiversXu's adoption of the compressed 16-item list on 2026-10-18.

## The two independent judgments (the core convergence)

1. **Does this Run need an Execution surface?** Yes when ANY of: a structured Plan exists; any semantic Step exists; an intervention (approval or input) is pending; the Run failed. None of the four → ordinary request, no card.
2. **Does the surface show progress numbers / a progress bar?** Only when a structured Plan exists: `a/b` from Plan valid items (skipped and superseded excluded). No Plan → no numbers, no bar.

These must stay independent because the intervention region and the failure notice are attached to the Execution Shell: "no Plan ⇒ no card" would have removed the approval entry point for automation and bot-message Runs, which can never have a Plan under the TurnPolicy (product review §2(2)).

## Adopted decisions

| # | Decision | Source | Acceptance effect |
| --- | --- | --- | --- |
| 1 | Unfreeze the Task 15/15.1 execution-card design. | REQ #1, D7 (gate) | Snapshots and e2e that pin the old three-block layout are expected to be updated in bulk; UX-01C owns that sweep. |
| 2 | This phase is display convergence only: the 3 tools, 6 Prisma models, events and the ExecutionSnapshot contract stay unchanged; no new migrations. | REQ #2, F1 | Acceptance 13 of the REQ stays the range proof (zero schema/contract diff). |
| 3 | Summary-only downgrade: cards whose only data is `ExecutionSummary` (older Runs, Task Center lists) show no `a/b`; do not extend contracts/db to compute one this phase. | C6 / X2 | `ExecutionSummary.counts` has no Plan count; layer 0 renders title + current item without numbers for those cards. Revisit only with usage evidence. |
| 4 | Sidebar shows no numbers and no status words — badge only; the accessible (aria) copy must remain. | C2/C3 / X3, "状态不要名字" | REQ §3 C and acceptance 5/8 wording is replaced: the Bot avatar gains a "waiting for you" badge; entering the thread lands focus on the approval card. UX docs that wrote sidebar text are superseded. |
| 5 | Layer 0 strong-progress form: with a Plan, title + `a/b` + progress bar + current item ("Current: … · N min"); without a Plan, neither numbers nor bar. | C1 / X4 | Supersedes the REQ/prototype "empty base bar" allowance: an empty bar with a live shimmer reads as fake progress. Running-ness is shown by the run icon + current-item line. |
| 6 | Execution surface gate = has content (Plan / Step / pending intervention / failed). The Steps-count threshold ("Steps ≥ 2") is removed. | C5 / X5 | Automation and bot-message Runs keep their evidence and failure visibility; a single Step already produces a (numberless) card. |
| 7 | Ordinary requests may show one light-gray status line while running; it disappears once the final reply lands. | D1 (prototype d06 B) | No numbers, no "plan" wording in that line; failure and pending-decision still produce the full surface. |
| 8 | Plan generation stays model-on-demand; no server-side complexity router. | REQ #7, F3 | Consistent with WorkPal's no-intent-routing direction; the front end only reads "does this Run have a Plan". |
| 9 | Plan Review card moves to UX-02; pending decisions this phase reuse the existing unified approval/input card. | REQ #3, F2, D4 | No new intervention type this phase; UX-02 owns the review card (own waiting reason, v2 re-review, rejection semantics, no "always allow"). |
| 10 | Todo is hidden from every default view; legacy data falls back Steps-first, then — only when expanded — an "item list" fallback that is not labeled Todo and shows no numbers. | C4 / X6, D5 | A limited, recorded exception to the "Todo does not occupy the chat surface" principle. |
| 11 | Unresolved Plan items count in the denominator; a Run ending with unresolved items appends "N items incomplete"; after a Plan revision `a/b` may regress (3/4 → 3/6) with a brief "plan updated" hint. | C7 / X7 | The regression is explained, not hidden; the hint is transient and never rewrites history. |
| 12 | Progress is Agent self-report; the UI never implies externally confirmed effects; layer-2 evidence stays inspectable. | REQ #9, F5, D3 | Acceptance 15 of the REQ stands; wording audits in UX-01C. |
| 13 | Implementation order: UX-01A Shell extraction (zero behavior change; add a Shell smoke baseline first; folds into front-end split step 2) → UX-01B progress convergence → UX-01C compatibility + E2E. `.po` changes ship as their own commit; biome's dependency check is off, so effect deps get manual review. | REQ #12 as revised 2026-10-18 | UX-01A may only open after #55 is in `main` (the stack touched `Shell.tsx`/`MessageView`, the exact regions UX-01A moves). |
| 14 | This record is written now; UX-01 remains `in-progress` until all three phases are merged and accepted. | adoption rule | The roadmap row reflects this; a written decision never flips a row to `done`. |
| 15 | *(deleted — PR #56 merged 2026-10-18 01:21 as `4448400`; the question is moot.)* | — | — |
| 16 | `refactor/shell-split-01` is abandoned wholesale; its four valuable small modules are redone from the latest `main` inside UX-01A. | X8 | The branch (118 commits behind, uncommitted changes) is not a base for anything. |
| 17 | Native Plan Mode unification, the Todo tool's long-term role, and Plan Review card details all move to UX-02. | REQ #10/#11/#13 | Out of UX-01 scope; UX-02 seeds recorded in the roadmap row 21. |

## Acceptance carry-overs and open verifications

- REQ acceptance 16 (linked-Todo duplicate display): the fix still ships (both read paths go through `unlinkedRunTodos`), but the assertion moves to the data-function level — under the new default views the UI reproduction is nearly invisible (product review C4).
- Open verifications to settle during UX-01B/C, recorded here so they are not lost: (a) whether `ExecutionSnapshot.steps` exposes `planItemId` — if not, layer-2 grouping under Plan items is not a pure-Web change and Steps list flat this phase; (b) when a plain chat Run currently gets a card or status Header; (c) whether the Task Center renders from summary only; (d) how the native `plan_exit` approval currently presents in the UI.
- The REQ's 16 acceptance rules remain the acceptance list, with the wording replacements named in decisions 4, 5 and the carry-over above.

## Boundaries and gates

- No implementation branch before PR #55 merges into `main` (decision 13); the avatar stack and UX-01A would otherwise rebase each other in `Shell.tsx` and the sidebar.
- This phase adds no migrations. Production deployment stays gated by DEP-01: after the avatar stack merges, production's pending migrations grow from 19 to 25, including an `events` index build with write-lock risk and a Bot data migration — rehearse on a production snapshot before any cutover (dev review §4.5).
