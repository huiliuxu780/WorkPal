# Task 18 scenario validation map

Every Task 18 scenario points at the real test that validates it, separated by
evidence tier. A unit test proves a pure decision; a PostgreSQL test proves the
durable contract against a real database; a Java test proves the runtime
boundary; a cross-language integration test proves the TypeScript→Java wire;
and a real-AgentScope Web E2E proves the whole production chain in a browser.
No tier substitutes for another, and nothing below is validated by mocks of
the layer it claims to prove.

## How to run each tier

- Unit / PostgreSQL (TypeScript): `pnpm test` runs the unit tier everywhere;
  the PostgreSQL tier activates only with `VERIFY_DATABASE=1` and a
  `DATABASE_URL` (otherwise those `describe` blocks skip by design).
  ```bash
  VERIFY_DATABASE=1 pnpm exec vitest run \
    packages/adapters/src/run-budget-enforcement.postgres.test.ts \
    packages/adapters/src/result-delivery.postgres.test.ts \
    packages/db/src/execution-contract.postgres.test.ts \
    packages/db/src/intervention.postgres.test.ts
  ```
- Java: `mvn -q -f services/agent-runtime/pom.xml test` (JDK 21).
- Cross-language TS→Java integration (needs the built jar, JDK 21 on `PATH`):
  ```bash
  pnpm exec vitest run \
    packages/adapters/src/agentscope-consumers.integration.test.ts \
    packages/adapters/src/turnpolicy-v2-agentscope.integration.test.ts
  ```
- Real-AgentScope Web E2E (real Java runtime, API, PostgreSQL, browser; the
  harness hosts the production job handlers **in-process** — this is not a
  separate Worker-process deployment test):
  ```bash
  pnpm test:e2e --runtime=agentscope \
    --spec="agentscope-product.spec.ts|intervention-region.spec.ts|task-center.spec.ts|budget-acceptance.spec.ts|capability-rules.spec.ts"
  ```
  `intervention-region.spec.ts` and `task-center.spec.ts` are runtime-agnostic
  and also run in the scripted E2E suite; the agentscope harness serializes
  spec files with `--workers=1` because it hosts one in-process backend.

## 18.1 Event envelope / wait reasons

| Scenario | Tier | Test |
| --- | --- | --- |
| Versioned envelope fields on lifecycle events | PostgreSQL | `packages/db/src/execution-contract.postgres.test.ts` |
| Wait kinds and stable expiry clock | PostgreSQL | `packages/db/src/wait-timeouts.postgres.test.ts` |
| Intervention lifecycle (pending/answered/expired, single settle) | PostgreSQL | `packages/db/src/intervention.postgres.test.ts` |

## 18.2 Background result delivery

| Scenario | Tier | Test |
| --- | --- | --- |
| Two results merge into one delivery Run, one message, idempotent settle | PostgreSQL | `result-delivery.postgres.test.ts` › "merges two terminal results into one delivery Run and marks one message sent" |
| Stale generation suppressed after Thread clear | PostgreSQL | `result-delivery.postgres.test.ts` › "suppresses a late result after Thread clear" |
| Five retries then activity-visible `delivery.failed` | PostgreSQL | `result-delivery.postgres.test.ts` › "emits an activity-visible failure after five retries" |
| 101-record window merges into exactly one Run/message; re-wake not re-merge; double settle inert | PostgreSQL | `result-delivery.postgres.test.ts` › "merges 101 same-window records into exactly one delivery Run and one message" |
| 205-record mixed window: one Run, bounded prompt, exact hidden counts, per-record `delivery.sent` | PostgreSQL | `result-delivery.postgres.test.ts` › "merges 205 mixed records into one Run with a bounded prompt and exact hidden counts" |
| Two Threads in one window never merge | PostgreSQL | `result-delivery.postgres.test.ts` › "never merges two Threads that finish inside the same window" |
| Two Thread generations never merge | PostgreSQL | `result-delivery.postgres.test.ts` › "never merges two Thread generations inside the same window" |
| Oversized-window prompt stays bounded and honest | unit | `result-delivery.test.ts` › "keeps an oversized window bounded and reports hidden items honestly" |
| Retry backoff schedule | PostgreSQL | `packages/db/src/delivery-records.test.ts` › "allows five retries after the first attempt, then stops" (+ gated claim cases) |
| Proactive Web delivery without a new user message (real Java) | E2E | `agentscope-product.spec.ts` › "Java background result reaches Web without another user message" |
| Outbox-owned native task not re-injected next turn | Java | `RuntimeIntegrationTest` (background lifecycle cases) |

## 18.3 Budgets, cancellation, retry

| Scenario | Tier | Test |
| --- | --- | --- |
| Interactive duration breach pauses with owner-only choices; raise persists doubled limit; no immediate re-pause | PostgreSQL | `run-budget-enforcement.postgres.test.ts` › "pauses an interactive duration breach and lets the owner raise its persisted limit" |
| Interactive cancel choice | PostgreSQL | `run-budget-enforcement.postgres.test.ts` › "cancels an interactive breach when the owner selects cancel" |
| Unattended (routine) breach fails with explicit reason and enqueues one delivery | PostgreSQL | `run-budget-enforcement.postgres.test.ts` › "fails an unattended duration breach with an explicit budget reason" |
| Token breach → owner raises budget → same Run finishes (real Java + Web; non-owner rejected; duplicate submission idempotent; fence advances; prompt unchanged) | E2E | `budget-acceptance.spec.ts` › "token budget breach lets the owner raise the budget and the same Run finishes" |
| Tool-call breach → narrow scope → unified cancellation of Run + background task, one guidance hint, no auto-replacement Run (real Java + Web) | E2E | `budget-acceptance.spec.ts` › "tool-call budget breach narrows scope through the unified cancellation path" |
| Routine breach → failed Run, no Intervention, `budget.exceeded → run.failed → delivery.created → delivery.sent`, one proactive summary (real Java + Web via `routines/testRun`) | E2E | `budget-acceptance.spec.ts` › "routine budget breach fails the Run and proactively delivers one summary" |
| Duration breach → Web waiting card → owner cancels (real Java + Web) | E2E | `agentscope-product.spec.ts` › "Java Run reaches a duration budget and Web cancels its waiting card" |
| Descendant cancellation across Threads; budget narrow/cancel keeps completed effects | PostgreSQL | `execution-contract.postgres.test.ts` (cancellation entries) |
| Lease-loss: expired lease with active Attempt → safe delayed retry or explicit unconfirmed-outcome failure | PostgreSQL | `packages/adapters/src/lease-loss-recovery.postgres.test.ts` |
| Retry gate: no retry after a tool call or live effect; 5s/30s schedule; idempotent | PostgreSQL / unit | `execution-contract.postgres.test.ts`; `packages/core/src/retry-policy.test.ts` |
| Wait expiry (input/approval/takeover) idempotent | PostgreSQL | `packages/db/src/wait-timeouts.postgres.test.ts` |

## 18.4 Capability rules

| Scenario | Tier | Test |
| --- | --- | --- |
| Rule precedence (deny > ask > allow), scope/specificity ties, helper read-only subset | unit | `packages/core/src/capability-rules.test.ts` |
| Executor re-reads policy; changed deny blocks an approved replay; malformed policy and archived Bot fail closed | unit | `packages/adapters/src/capability-permission.test.ts` |
| Deny blocks the tool at the real Web → API → Java → bridge → executor boundary: implementation never runs, no ExternalEffect, no approval Intervention, honest result; malformed policy fails closed the same way (real Java + Web) | E2E | `capability-rules.spec.ts` › "deny and malformed capability rules block the real tool boundary without approval" |
| `ask` routes through the existing approval card; a rule flipped to deny before replay still blocks the approved call (real Java + Web) | E2E | `capability-rules.spec.ts` › "an approved tool replay is still blocked when the rule changed to deny" |

## 18.5 TurnPolicy v2

| Scenario | Tier | Test |
| --- | --- | --- |
| Policy derivation per source; snapshot-first retries; malformed v2 fails closed; owner increase is the only budget change | unit | `packages/core/src/product-harness/turn-policy.test.ts` |
| Java parses v2 groups, binds native helpers, rejects malformed v2 with 422 | Java | `RunRequestPolicyTest`, `InterruptibleTaskRepositoryTest` |
| TS-generated v2 policy binds Java helper fan-out to the tightened `maxChildAgents` (background spawn refused at the hard count; wire carries no intent/action fields) | cross-language | `turnpolicy-v2-agentscope.integration.test.ts` › "binds Java helper fan-out to the TypeScript-tightened v2 budget" |
| Stored policy reused across attempts; only an approved `budgetOverride` changes the wire budget; decreases ignored | cross-language | `turnpolicy-v2-agentscope.integration.test.ts` › "reuses the stored policy across attempts; only an approved budgetOverride changes it" |
| Malformed v2 on the wire fails closed at the Java door — no model call, no planning/delegation recovery | cross-language | `turnpolicy-v2-agentscope.integration.test.ts` › "fails closed at the Java door when the v2 wire policy is malformed" |
| Corrupt stored v2 snapshot never restores planning or delegation (Java hides the native tools) | cross-language | `turnpolicy-v2-agentscope.integration.test.ts` › "never restores planning or delegation from a corrupt stored v2 snapshot" |
| Tightened effective `maxDepth=0` hides the whole native subagent surface; sync and background spawn attempts are refused; depth 1 keeps delegation | cross-language | `turnpolicy-v2-agentscope.integration.test.ts` › "hides the whole subagent surface and refuses spawns when the tightened depth is zero" |
| Depth gate math: tightened minimum of delegation/budget, explicit zero preserved, absent/negative fallback, zero disables delegation and background | Java | `RunRequestPolicyTest` (`effectiveDepthIsTheTightenedMinimumOfDelegationAndBudget`, `zeroEffectiveDepthDisablesTheWholeSubagentSurface`, `absentDepthFallsBackToOneAndKeepsDelegation`) |
| v2 policy carried end-to-end on real Web Runs (interactive budget chains above run on v2 chat policies) | E2E | `budget-acceptance.spec.ts` (all three) |

## Known uncovered capabilities

These remain deliberately unimplemented and therefore untested; nothing above
claims them:

- `maxCostUsd` — unsupported compatibility field: parsed and validated on the wire, never enforced, `costUsd` stays `null`, explicitly not a future product goal. Model usage is presented as token statistics only.
- Manual Retry — no production contract or UI entry.
- Trusted percentage progress — no trusted source; never rendered.
- Capability-rule editor UI — rules are a persisted Bot policy column only.
- Separate Worker-process deployment — the E2E harness hosts the production
  job handlers (delivery dispatch, budget sweep) in-process; an independently
  deployed Worker against the same database is not exercised by any tier.
- Strict one-message-per-window delivery beyond the bounded claim
  (`DELIVERY_WINDOW_CLAIM_MAX = 5000`): windows up to that bound merge exactly;
  overflow records are never dropped but are delivered by later batches, which
  can add a summary message for the same window. Guaranteeing exactly one
  message for unbounded counts requires a persisted window identity — a future
  design, not this slice.
- Intent/Complexity Router — out of scope by design; TurnPolicy carries no
  intent, action, or next-step classification fields (asserted on the wire).
