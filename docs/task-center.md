# Task Center (后台任务)

The Task Center is the cross-conversation **second entry** to existing Runs. It
is an index and navigation surface — it creates no Task, no Run, no lifecycle
state and no status table of its own, and it duplicates no Execution Card
state derivation. Everything it shows is an existing root Run's
`ExecutionSummary` (HISTORY-001) plus a server-authorized navigation target.

```text
Task Center item
    └── existing Run
          ├── existing ExecutionSummary   (the only status-summary source)
          ├── existing ExecutionSnapshot   (pre-navigation authority check + chat detail)
          ├── existing Intervention        (focused after 「去处理」 in the chat)
          └── original Thread / Message anchor (?m= deep link)
```

Design lineage: `WorkPal-design/task15.1-execution-card-refinement/task-center-v2.html`
(restrained list + sidebar entry). The prototype's percentage counters were
**not** carried into production (see ## Percentage).

## Surface

- Route `/app/tasks`, rendered by the Shell in `tasksMode`: the existing
  sidebar stays (with its existing mobile collapse) and the chat main area
  yields to the list. Precedes `/app/:botId` in the route table.
- Sidebar entry `TaskCenterNavEntry`: existing row idiom (lucide icon,
  foreground-contrast text, `bg-sidebar-accent` selection), `aria-current="page"`
  on the Task Center route, count badge = server `activeCount` with tabular
  numerals; `0` or unknown renders **no badge** (never an empty pill, never a
  guess).
- Page: `后台任务` title, subtitle `N 个正在后台` / `没有正在后台的任务`,
  one semantic `<section>` + `<ul>` list of compact Execution Cards, the
  honest empty state, and cursor pagination (`Load more tasks`). No
  dashboard, data table, filters, statistics, KPI or batch operations.

## Inclusion boundary

Only **root Runs** of the actor's current Space that the actor is authorized
to reach:

- Active/waiting: every `queued`, `leased`, `running`, `waiting_input` and
  `waiting_takeover` root Run. (`waiting_takeover` is included because it is
  an active wait needing the user, matching the shared status derivation's
  attention semantics; it sorts in the waiting group.)
- Recent terminal: the 50 most recently updated `completed` / `failed` /
  `cancelled` root Runs **of the current generation**
  (`TASK_CENTER_TERMINAL_WINDOW`, mirroring the HISTORY-001 thread window).

Never included:

- Collaboration sub-Runs. The root-Run authority is the stored orchestration
  lineage: `NULLIF(orchestration->'collaboration'->>'parentRunId','') IS NULL`.
  Card titles, trigger text and the presence of subtasks are never used to
  infer root identity. (Peer/handoff Runs written by the current harness
  always carry the lineage, so they are excluded by construction.)
- AgentScope native background-task projections and `BackgroundAgentTask`
  subtasks — these are not Run rows and cannot enter the list; a parent Run's
  `counts.agents` still reports them honestly on its card.
- Runs fenced out by Thread Clear (see below), Runs of archived/deleted bots
  or groups, groups below the member minimum, foreign Spaces, and
  external-conversation Threads (they resolve to neither a bot nor a group
  target).

All authorization is one server-side SQL predicate over the Thread's owning
chat (bot: `spaceId + userId + archivedAt IS NULL`; group: same ownership plus
≥ `GROUP_MEMBER_MIN` unarchived member bots). Unauthorized items never reach
the browser to be hidden there.

## "Background" semantics

The Task Center page itself is the trusted cross-conversation background
entry, and eligible root Runs may use the Execution Card's existing
background presentation there. In this release no caller asserts
`confirmedRootBackground` (still no trusted production field), so cards render
the standard state visuals. No `background=true` column was added for copy, a
parent Run is never marked background because it owns `BackgroundAgentTask`
rows, `trigger` alone never implies background identity, and the original
chat's Execution Card behavior is unchanged.

## Query contract

`runs.taskCenter({ cursor?, limit? })` (oRPC, authed; `limit` default 30, max
100) returns:

```ts
{
  items: Array<{ summary: ExecutionSummary; target:
      { kind: "bot"; botId: string } | { kind: "group"; groupId: string } }>,
  nextCursor: string | null,
  activeCount: number
}
```

- `ExecutionSummary` remains the single summary source — no second DTO copies
  its fields. The anchor rides on `summary.anchorMessageId` (an item-level
  duplicate was deliberately not added).
- Summaries are built by the **shared** HISTORY-001 projection
  (`buildExecutionSummariesForRuns`), generalized to span Threads with one
  grouped batch per fact source (generation buckets ride in a VALUES join) —
  no per-Run and no per-Thread fan-out, asserted by a query-count test.
- `activeCount` comes from the same authorized selection as the list (same
  space/root/status rules), not a separate counter.
- The whole read runs in one transaction (read-committed). It takes no
  `FOR SHARE` fence: the Task Center is an index surface, the per-Run detail
  read keeps the strong fence, and the client merge rules below absorb any
  drift.

### Ordering

Deterministic total order, groups first:

1. waiting for the user (`waiting_input`, `waiting_takeover`)
2. `running` / `leased`
3. `queued`
4. `failed`
5. `completed`
6. `cancelled`

Within a group: `runs.updatedAt` descending (the indexed server sort key),
then `runId` descending as the stable tie breaker. The tie breaker is a sort
fact only — it never renders to the DOM.

### Cursor

Opaque base64url JSON `{v:1, sp(spaceId), us(userId), p(priority), t(updatedAt
ms), r(runId)}`, strictly decoded (exact key set, exact version) and bound to
the issuing actor and Space: a cursor from another user, another Space or
another layout version is rejected (`BAD_REQUEST`), never reinterpreted. The
Web stores and replays it verbatim and never parses it. The cursor marks the
last delivered position; items that moved to an earlier group meanwhile are
skipped server-side and deduped client-side.

### Client merge and concurrency

`apps/web/src/lib/task-center.ts` (pure, unit-tested):

- Refresh (first page) replaces the list — items the authoritative window no
  longer carries drop out (cleared/archived Runs disappear) — but for a Run on
  both sides the higher `rev` wins.
- Load-more appends with runId dedupe, higher `rev` winning in place; a Run
  never appears twice on screen.
- Every response carries a monotonic request id: a late out-of-order or
  duplicate response is discarded whole and can never regress the list, the
  count or the subtitle. An append whose epoch moved on (a refresh landed in
  flight) is discarded, so a stale page cannot re-add a cleared Run.
- Refresh triggers (the project's existing lightweight pattern — no new
  WebSocket, bus or global store): page entry, window focus,
  `visibilitychange`, returning from a conversation (route remount), and
  pagination. The sidebar badge refreshes on mount, route change, focus and a
  15s visible-only poll, epoch-guarded.

## Thread Clear generations

The Task Center reuses the HISTORY-001 generation rules exactly: a terminal
Run is listed only while a Run-lifecycle event survives (every event except
the thread-maintenance `thread.artifact` rows — enforced by an `EXISTS`
predicate in the terminal selection itself, so fenced Runs never even enter
the window). Cleared Runs never reappear, deleting a stale Run's artifact
afterwards never revives it, and new-generation Runs appear normally.
Archived or deleted bots/groups vanish from both the list and `activeCount`;
restoring them restores their items.

## Returning to the conversation

Card primary actions (all navigate back; no approval or answer input happens
on the Task Center page):

| Display state | Verb |
| --- | --- |
| approval / need_input / blocked / takeover | `去处理` (Handle now) |
| done | `查看结果` (View result) |
| failed | `查看执行` (View execution) |
| everything else | `回到对话` (Back to conversation) |

The verb is a presentation mapping over the **shared** `deriveExecutionStatus`
view — no Task Center status matrix. Click flow:

1. **Authority check**: `runs.executionSnapshot` for the target + Run. A
   cleared/archived/unauthorized Run fails closed (`NOT_FOUND`/…) and the item
   shows the stable 「该任务已不可用。」 feedback in place — no navigation, no
   raw id, no internal error text. Transient failures show a retryable notice
   and never mark the Run lost.
2. **Handoff**: an in-memory navigation intent `{threadId, runId, rev,
   attention}` (module memory only — no new browser-storage key, no URL
   param, nothing rendered) plus the existing `?m=<anchorMessageId>` deep
   link when the summary has an anchor.
3. **Locate**: the Shell's existing `?m=` jump loads the around-page
   server-side (works with the anchor arbitrarily deep in history — no
   first-page scanning). `jumpToMessage` now merges the around-page's
   `executions` into the snapshot (`mergeExecutionsByRun`), so a Run outside
   the recent window still arrives server-driven. Without an anchor (failed
   before any bot message) the card's existing transcript-tail fallback
   applies.
4. **Open + focus**: when the Run's summary is present, the Transcript
   consumes the intent once: `forceOpenExpansion` (rev-pinned, closes every
   other open detail of the Thread — the single-open contract holds), the
   detail snapshot lazy-loads, and focus lands on the first enabled
   Intervention control for waiting states (mirroring the card's attention
   action, region sorted approvals-first) or on the card's status line
   (`preventScroll`) otherwise.

## Redaction boundary

Unchanged from HISTORY-001 plus the card's DOM rules, asserted by E2E on both
the list and the returned conversation:

- No Run/Thread/Bot/Attempt raw ids in visible text, DOM attributes or
  dynamic test ids. React keys may hold the runId in memory only. The
  pre-existing whitelisted `rk:execution-expansion` sessionStorage record
  (four fields) is unchanged; the Task Center adds **no** storage key.
- No raw errors/stacks, tool arguments/results, ExternalEffect payloads,
  credentials, secrets, tokens, AgentScope URLs, fences or lease owners, no
  unredacted Intervention answers. Cards show only the server-whitelisted
  `outcome`/`failure`/`presentation` projections.
- The cursor is opaque to the Web (never parsed, replayed verbatim); it binds
  to the issuing actor and Space server-side.

## Percentage

The Task Center renders **no percentage, no progress track and no guessed
remainder**: production has no trusted server-owned `processed / total`
contract, so the value does not exist and is omitted entirely (never `0%`,
never `--`). Step counts on a card are semantic-step facts, never a business
progress percentage. A percentage may return only when a trusted
server-owned total/processed source ships.

## Accessibility & responsive

- Semantic `<section aria-label>` + `<ul>` list; each card is the existing
  `<article>` with its status+title accessible name; state never rides on
  color alone (the status sentence names it).
- Keyboard-only: the sidebar entry, the list and the return-to-conversation
  flow are all reachable by Tab/Enter; focus lands on the target card or the
  Intervention control after navigation.
- 390/768/1440 covered; no horizontal overflow; the sidebar keeps its
  existing mobile collapse (off-canvas until the existing swipe opens it).
  Light/dark follow the token layer; `prefers-reduced-motion` disables the
  card breath/rail transitions as in chat.
- Count badge uses tabular numerals; all text ≥4.5:1 via token colors
  (`--foreground` / `--muted-foreground`).

## Known limitations

- The list does not live-poll while simply watched; it refreshes on the §
  Update triggers above (deliberate first-version restraint).
- The terminal window is the 50 most recently updated terminal root Runs of
  the whole Space (per-Thread windows stay a per-Thread concern); older
  terminal Runs are reachable through their conversation's history.
- The intent handoff is in-memory: a full page reload between the click and
  the chat mount degrades to the plain `?m=` anchor jump without forced
  expansion (the card is still located and manually expandable).
- Root identity reads the stored orchestration lineage; Runs predating the
  Product Harness that carry no orchestration are treated as roots (their
  lineage was never recorded).
- `activeCount` includes waiting states (they are active Runs needing the
  user), consistent with `ACTIVE_RUN_STATUSES`.
- Legacy root Runs whose lifecycle events predate the event table report
  `rev: 0` with `incompleteSections` — valid HISTORY-001 answers, unchanged.
