# RT-25 session admission lease

## Scope and verified runtime identity

RT-25 serializes independent chat Runs that target the same AgentScope chat state. It does not
implement checkpoint detach or resume. The production gate for `message_group` remains closed.

The Java runtime currently identifies a chat state with two SHA-256 slots:

```text
tenant = sha256(userId + NUL + spaceId)
session = sha256(botId + NUL + threadId + NUL + threadGeneration)
```

The persisted key is `agentscope:chat:v1:<tenant>:<session>`. It preserves the runtime's existing
state paths and includes user, Space, Bot, Thread, and generation identity. Run, Attempt, Worker,
and request IDs are deliberately absent. Non-chat execution scopes keep their existing Run-scoped
runtime identity and do not use this admission lease.

## Design choice

Two designs were considered.

1. Put owner fields and a FIFO timestamp on `runs`. This spreads one session invariant over many
   rows. A worker can observe only the Runs it knows about, and equal timestamps need an arbitrary
   tie-breaker.
2. Keep one resource row per AgentScope chat session and one durable request row per execution.
   The resource row owns the monotonic fence. A database-generated request position owns fairness.

The implementation uses the second design. It does not reuse `computer_execution_leases`.
Computer leases may be reclaimed after expiry; a chat session cannot be reclaimed until Runtime
proves the old shared state is clean or detached. RT-26 will add that proof.

## State machine

```text
                         acquire by FIFO head
             +--------------------------------------+
             |                                      v
        +-----------+                         +-----------+
        | available |                         |   owned   |
        +-----------+                         +-----------+
             ^                                |    |    |
             | clean completion /             |    |    | expiry, lost heartbeat,
             | pre-runtime release            |    |    | Runtime 409, uncertain exit
             |                                |    |    v
             +--------------------------------+    | +------------+
                 exact owner + fence               | | recovering |
                                                   | +------------+
                                                   |       |
                                                   |       | RT-26 only:
                                                   |       | persisted clean/detached proof
                                                   +-------+
```

`recovering` is intentionally absorbing in RT-25. A timeout is evidence that ownership is stale,
not evidence that AgentScope released shared state. The queue remains durable and blocked behind
that owner until RT-26 supplies a clean or detached proof.

Each request has `queued`, `owned`, `recovering`, or `released` state. PostgreSQL assigns its
monotonic `position`; worker restart and process scheduling cannot reorder it.
When a queued Run is reclaimed, its new execution identity replaces the identity on the existing
queued row without changing `position`. A released request is never moved forward or reused.

## Lock order

All admission operations use this order:

```text
transaction advisory lock(hashtextextended(sessionKey))
  -> create the resource row when absent
  -> agent_session_admissions row
  -> agent_session_admission_requests row(s), ordered by position
  -> runs row, when Run state must change
  -> attempts row, when Attempt state must change
  -> tasks row, when the Task projection must change
```

The advisory lock covers only the absent-row creation boundary, where PostgreSQL cannot take a
row lock and concurrent speculative inserts across two unique indexes can deadlock. Ownership and
fairness remain in the persisted rows; no process-local lock participates in correctness.

The computer execution lease is acquired before chat admission and is never locked in an
admission transaction. This keeps the two resources independent and avoids holding chat admission
while a Team Computer is queued. Existing Thread and group lock orders are unchanged.

## Fence rules

- Only the FIFO head can change `available` to `owned`.
- Every successful new ownership increments the session row's fence. Repeated acquire by the same
  execution returns the existing fence.
- Heartbeat, execution preparation, Runtime-start marking, completion, and release match session
  key, owner Run, execution identity, and fence.
- Release accepts `owned` only. `recovering` cannot be released by RT-25.
- A repeated release for the current released fence is idempotent. Once a new owner increments the
  fence, the old heartbeat, completion, and release all fail.
- Runtime execution identity and a random suspension key are persisted before the HTTP request.
  The runtime receives the same session key and execution fence.

## Crash matrix

| Crash point | Durable state | RT-25 recovery |
| --- | --- | --- |
| Before Run claim/admission request | Run is queued | a later dispatch enqueues/acquires normally |
| After queued request, before Run requeue | request is queued; Run claim is leased | claim expiry uses the exact request/execution/fence to return the Run to queued, never failed |
| After acquire, before Runtime | `owned`, Run/lease identity persisted | expiry changes it to `recovering`; no hand-off without proof |
| During Runtime | `owned`, Attempt, fence, suspension key, Runtime-start time persisted | expiry changes it to `recovering`; stale admission writes and run-claim-fenced writes fail |
| After Runtime 409 | Run is queued and admission is `recovering` | not a business failure; no automatic release |
| After clean completion, before release | terminal Run, admission remains `owned` | expiry changes it to `recovering`; RT-25 does not infer clean from timeout |
| After release, before next enqueue | `available`, next request still queued | Worker reconciliation re-enqueues the durable FIFO head |

## RT-26 boundary

RT-25 does not add `inspectAndDetach`, checkpoint storage, detached pending requests, or resume.
Consequently, a Run that pauses inside AgentScope keeps the chat admission. When its heartbeat
stops, the owner becomes `recovering` and blocks later Runs. This is less available than the final
design, but it prevents a new Run from inheriting or answering anonymous pending state. RT-26 must
persist a `clean | detached` proof before it can release that owner.

## Baseline correction

The requested baseline path `packages/adapters/src/lease-loss-recovery.ts` does not exist at
`4571a9eaf88a20e7ca37c4846d523389ba95c378`. The relevant production recovery logic is in
`packages/adapters/src/executor.ts`; the similarly named artifact is the PostgreSQL regression
test `packages/adapters/src/lease-loss-recovery.postgres.test.ts`. This implementation extends the
executor path and keeps that regression test in the verification set rather than introducing a
second recovery abstraction with overlapping semantics.

## Evidence

The implementation was made in the independent sibling worktree
`/Users/rivers/Documents/WorkPal-rt25` on `codex/rt-25-session-admission-lease`. The branch point is
the required `origin/main` commit `4571a9eaf88a20e7ca37c4846d523389ba95c378`.

| Verification | Result |
| --- | --- |
| `pnpm --filter @rakazo/db check` | passed |
| `pnpm --filter @rakazo/adapters check` | passed |
| `pnpm --filter @rakazo/worker check` | passed |
| `VERIFY_DATABASE=1 DATABASE_URL='<postgres-url>' node scripts/verify-rt25-session-admission.mjs` | 20/20 rounds passed; 11 PostgreSQL tests per round |
| `VERIFY_DATABASE=1 DATABASE_URL='<postgres-url>' pnpm exec vitest run packages/adapters/src/lease-loss-recovery.postgres.test.ts packages/adapters/src/execution-contract.postgres.test.ts packages/db/src/execution-contract.postgres.test.ts` | 3 files, 37 tests passed |
| `pnpm exec vitest run packages/core/src/node/session-admission.test.ts packages/adapters/src/agentscope-runtime.test.ts apps/worker/src/session-admission-reconciler.test.ts` | 3 files, 26 tests passed |
| `JAVA_HOME='<jdk-21>' pnpm test:agentscope` | 110 tests passed; 0 failures/errors |
| `pnpm test:worker-chain` with the local Docker socket and JDK 21 | 5/5 scenarios passed in 4.2 minutes |
| `pnpm check` | 18/18 tasks passed across the 16 packages in scope |
| `git diff --check` | passed |

The 20-round stress run initially found a PostgreSQL deadlock when two transactions created the
same previously absent session resource through different unique indexes. The final design adds a
transaction-scoped advisory lock only around absent-row creation; the repeated 20-round run then
passed with the production row-lock/CAS path unchanged.

The worker-chain run also exercised two otherwise easy-to-hide claim windows. A Worker stopped
after Runtime but before release leaves `owned` until durable expiry changes it to `recovering`.
A queued successor can briefly hold only the independent Run claim while persisting its admission
request, then returns to `queued` with no Runtime call. The final assertions wait for the durable
boundary (`queued`, no Run owner, one queued admission request) instead of mistaking either
transient claim state for chat admission.
