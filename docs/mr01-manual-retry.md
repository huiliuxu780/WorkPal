# MR-01 Manual retry — delivery note

Status: `in-progress`, **ready-to-merge** after MR-01-R3. PR [#73](https://github.com/huiliuxu780/WorkPal/pull/73). Branch `codex/mr01-manual-retry`. Base `main` = `a39b25d` (AG-05 next-batch merge). Automatic same-Run Attempt retry (`packages/db/src/retry-runs.ts` `scheduleAutomaticRunRetry`, event `run.retried`) is a different operation and is not reused here. Not merged, not deployed.

This note is the implementation map and the 14-row evidence matrix. It is not a wait-for-approval spec.

## Product status table

| Clicked Run | UI entry | Server decision |
| --- | --- | --- |
| `failed` root, eligible trigger, current generation, actor owns the Thread | Execution Card **Retry** + Task Center **Retry** | Create a new Run on the same Task/Thread, `retryOfRunId` = latest hop, enqueue `runContinueJob` |
| `cancelled` root with Plan/Steps/Intervention/failure (UX-01 surface) | Execution Card **Retry** + Task Center **Retry** | Same |
| `cancelled` root with no Execution shell | Task Center **Retry** only | Same. Do not force a chat shell |
| Latest hop in the chain is `queued`/`leased`/`running`/`waiting_*` | No Retry; **View retry** on ancestors | Return the existing successor (`replayed: true`) |
| Latest hop `completed` | No Retry | `BAD_REQUEST` `completed` |
| `queued`/`running`/`waiting_*` (the clicked row itself) | No Retry | `not_terminal` |
| Helper / support (`orchestration.collaboration.parentRunId` set) | No Retry | `not_root` |
| `trigger` `delivery` / `created` / `spawn` | No Retry | `ineligible_trigger` |
| Thread Clear (no surviving lifecycle event) | No Retry | `thread_cleared` |
| Bot archived / missing, or actor lost bot/group ownership | No Retry | `bot_unavailable` / `forbidden` |
| Another active Run already occupies the Thread+Bot | Retry denied | `CONFLICT` `thread_busy` (do not steer) |
| Same `clientNonce` replay for this source / retry chain | Same button, still submitting | Return the Run that holds that nonce after task, chain, and Thread access checks |
| `clientNonce` already bound to another Task or retry chain in the Space | Retry denied | `CONFLICT` `nonce_conflict` |
| Concurrent retries of the same latest hop | One successor | Unique `retryOfRunId`; loser reads the winner |

Routine retries reuse `routineId` and `trigger: "routine"` on the same Task. Schedule rows are not written. Group and external ownership follow the existing Thread authorization predicate (bot owner or group owner; external Threads are refused).

## Input rebuild path

| Input | Source | Retry behavior |
| --- | --- | --- |
| Task prompt, attachments, skill references | `Task.prompt` (unchanged) + original `sourceMessageId` | Copied. Display snippets and model-generated retry advice are never written back into `Task.prompt` |
| Trigger, routine, source message | Predecessor Run | Copied (`trigger`, `routineId`, `sourceMessageId`) |
| Entry identity | Predecessor `orchestration.routing` / `ownership` / `collaboration` / `responseMode` | Copied so group/handoff/support identity stays |
| Execution policy, budget | Current `turnExecutionForSource(turnPolicySourceForTrigger(trigger))` | Rebuilt. `budgetOverride`, `modelProvider`, `modelId`, usage, lease, checkpoint, error are not copied |
| Model, connectors, memory, permissions | Loaded at execute time from current Bot/User/Space rows | Current configuration. Old approvals do not authorize new operations |
| Model-visible retry framing | `prompts/retry/manual-retry-context.md` via AG-04 `renderPromptSegment` / `renderManualRetryPrompt`, wrapped onto the outgoing `AgentRunRequest.prompt` | Task.prompt stays the original user task. Provenance union is not extended (`manual_retry` is not a `contextKind`). The wrap lists backend `retryOperationId` values; the reserved live arg is stripped before persist/send |

`userTurnMessageForRun` still keys off `trigger === "user"` and `sourceMessageId`, so the current-turn message is the original user message.

## Effect matching rules

Identity is a backend-assigned `ExternalEffect.operationId` (cuid, persisted, indexed, **not unique**). Several effect rows in one retry lineage may share one id. It is distinct from Run id, Attempt id, model `toolCallId`, transport `clientNonce`, and the intra-run occurrence used only for live `toolEffectIdempotencyKey`.

| Stage | Who assigns | Stable across | Unique? |
| --- | --- | --- | --- |
| First send of a new independent operation | Prisma `@default(cuid())` on insert when the live call omitted `retryOperationId` | Later hops of this lineage | No — later hops insert new rows with the same id |
| Continue a listed operation | Live reserved arg `retryOperationId` (stripped before persist/send/hash). Executor writes that id onto the new row | The whole `retryOfRunId` chain | Same id, new row |
| Intra-run identical-args replay | 0-based occurrence inside **this** Run only | One Attempt / one Run | Combined into the idempotency key with the new Run id |
| Transport replay | `runs.retry({ runId, clientNonce })` + `@@unique([spaceId, clientNonce])` | One click / one successor | Yes per Space |
| Model tool-call id | AgentScope ephemeral | Never | Unrelated |

`canonicalize` still unwraps production connector envelopes before comparing identity: catalog `[marker, executeTool, args, route?]` and bound-direct `[marker, "direct", { route, args }]`. Naked JSON requests stay as-is. Resource (`connectorId` / `resourceId` / `toolName` / `resourceRevision`) and canonical args must match the bound id; otherwise `bind_mismatch`. An id that is not in this chain is `unknown_operation` (no leak of the foreign row). Omitting the id always starts a new independent operation — two same-args sends stay two operations.

Walk predecessors via `retryOfRunId` (nearest first). The nearest row of that `operationId` wins.

| Recorded status | Decision |
| --- | --- |
| `completed` with a recoverable `result`, and `reviewDecision` is not `manual_retry_authorized` / `manual_retry_cancelled` | Reuse the stored result. Emit `effect.reconciled` on the new Run with `{ executionId, kind, sourceEffectId, reuse: "manual_retry" }`. Do not insert a forged completed effect and do not call the provider |
| `intended` / `denied` / `cancelled` / `approved` (not executed) | Execute again under current permission and approval policy, **keeping the same operationId** |
| `reviewDecision = manual_retry_authorized` | Execute again (user confirmed the previous attempt did not land), same operationId |
| `reviewDecision = manual_retry_cancelled` | Skip; return a skipped observation to the model |
| `reviewDecision = manual_retry_confirmed` with no recoverable result | Skip confirmation; do not forge a completed effect |
| `executing` / `uncertain` / `failed` / `ambiguous` / `completed` with null result | Re-read the row. If it is now completed+recoverable, reuse. Otherwise pause this Run with a choice Intervention (`confirm_completed` / `authorize_retry` / `cancel`) naming that operation |
| Omit `retryOperationId` | New independent operation |
| Id + different tool / resource / canonical args | `bind_mismatch` |
| Id not in this chain | `unknown_operation` |

Read-only tools are not matched; they read current state. Matching never inspects Runs outside this `retryOfRunId` chain. Legacy rows backfilled `operationId = id`.

## Key call sites (verified on this branch)

- Automatic retry: `packages/db/src/retry-runs.ts` `scheduleAutomaticRunRetry` (same Run, new Attempt, `run.retried`). Untouched.
- Manual retry write: `packages/db/src/manual-retry.ts` `createManualRetryRun` (thread `FOR UPDATE`, unique successor + nonce, event on the **new** Run). Nonce hits on the happy path and P2002 recovery must belong to this source Task / `retryOfRunId` chain and pass Thread authorization; a foreign nonce is `nonce_conflict`.
- RPC: `runs.retry` in `packages/contracts/src/rpc.ts` / `apps/api/src/router.ts`. Enqueue `runContinueJob` outside the transaction, same pattern as routine `testRun`.
- Effect key (live Run): `packages/core/src/approval-effect-key.ts` `toolEffectIdempotencyKey`. Chain match: `packages/core/src/node/manual-retry-match.ts` (`canonicalizeManualRetryRequest` + `decideManualRetryEffect`). Executor wiring: `packages/adapters/src/executor.ts` passes live `effectRequest`.
- Worker lease / continue: existing `continueRun` + `runContinueJob`. New Runs start `queued` with no lease.
- Thread generation fence: surviving lifecycle event (same predicate as Task Center / HISTORY-001). `clearThread` deletes events, so a cleared Run cannot be retried.
- Prompt wrap: executor prompt assembly after `basePrompt` join; AG-04 segment `retry/manual-retry-context` via `renderPromptSegment` (single-pass `{{key}}`). The second loader `packages/core/src/node/prompt-file.ts` is deleted.

## 14-row acceptance evidence

| # | Acceptance | Evidence |
| --- | --- | --- |
| 1 | failed/cancelled root Retry on the correct entry; other statuses and delivery/helper have no Retry | `projectManualRetryEligibility` unit tests (`packages/core/src/manual-retry.test.ts`). Task Center + Execution Card only render Retry when `manualRetry.allowed`. PG `refuses helpers, delivery, completed, busy, cleared, and foreign actors`. Chat E2E retries a failed card; Task Center E2E retries a cancelled no-shell row. |
| 2 | New Run, same Task, same Thread, lineage, old history intact | PG `creates a successor on the same Task and Thread and keeps the failed original`. Chat E2E asserts a new `runId`, same `taskId`, original stays `failed`. Worker-chain retry: successor `retryOfRunId` = original, original stays `cancelled`, same `taskId`/`threadId`. |
| 3 | Original task input restored; real model request sees original target and retry wrap | Successor copies `Task.prompt`, `sourceMessageId`, trigger, routine, ownership. Prompt wrap `prompts/retry/manual-retry-context.md` via `renderManualRetryPrompt` / `manualRetryPromptPrefix`. Worker-chain last model request contains `WORKER_CHAIN_RETRY_FIXTURE` and `"manual retry"`. Reuse tests assert the wrap and listed `retryOperationId` on the production executor request. |
| 4 | Worker down → queued, zero model calls; start → claim the same new Run | `apps/web/e2e/worker-chain.spec.ts` “retried while the Worker is down”: 16 polls of `queued` + `leaseOwner=null` + unchanged fixture count; after `startWorker` the lease pid is the Worker process, Run completes, transcript shows `WORKER_CHAIN_RETRY_REPLY`. 1/1 in 15.8s. Automatic same-Run Attempt retry (`retry-runs.ts`) is untouched. |
| 5 | Nonce replay and concurrent sources produce one direct successor | PG `replays the same nonce and collapses concurrent successor inserts`. PG `walks to the latest hop so a second retry continues the chain`. PG `refuses a nonce already used by another task of the same user` and `refuses a nonce already used by another user in the same space` (happy path + P2002 recovery). Task Center unit: nonce kept until success; same nonce reused after a business error. |
| 6 | Completed same external operation is not sent again | Production executor + local HTTP fixture: completed bound-direct and catalog `hook_write` with `retryOperationId` → HTTP count stays 0, `effect.reconciled` `{ reuse: "manual_retry" }`. Same-args skip-first continues the second (uncertain) id without reusing the first. Three-hop nearest-row reuse HTTP=0. |
| 7 | Different args / target / independent ops are new; skip/reorder still bind | Core identity tests: omit id = new op; reverse different ops by id; bind_mismatch / unknown_operation without leak. Reuse test: different-args `scratchpad_add` executes; omit-id same-args POSTs once; foreign id error has no result payload. |
| 8 | Uncertain results pause for a real user choice; old approvals do not authorize new ops | Reuse test pauses with `confirm_completed` / `authorize_retry` / `cancel`. PG group journey persists `reviewDecision` on the **old** effect via `checkpoint.manualRetryEffectId`. Denied / intended / `manual_retry_authorized` rows execute as new ops under current policy. |
| 9 | Group owner and routine occurrence retry; routine schedule unchanged | PG `retries a routine occurrence without writing a schedule row` (`nextRunAt` and `crons` unchanged). PG `retries a group-owned root`. External/messaging Runs on a bot-owned Thread keep `trigger`/`sourceMessageId`. |
| 10 | Clear / missing bot / foreign actor / busy Thread return business reasons, no extra Run | PG denials: `thread_cleared`, `not_found` (cross-space), `forbidden`, `thread_busy`, `bot_unavailable`, `nonce_conflict`. UI maps those reasons through `manualRetryErrorMessage`. |
| 11 | Budget and current configuration | New Run rebuilds `execution` via `turnExecutionForSource` (zero copied usage, no `budgetOverride`/`modelProvider`). Interactive budget pause is `waiting_input` → retry denied `not_terminal`; owner `increase_budget` continues the **same** Run (existing enforcement test); owner `cancel_run` then Retry queues a successor with a clean ledger. Unattended `budget_exceeded` Retry queues; successor usage is 0 so the rebuilt default is not immediately exceeded. Space `UsageRecord` is observational — there is no space spend cap; a space with large usage still queues (`queued` is honest). |
| 12 | Chat card + Task Center; cancelled without shell retries from Task Center; old record + successor nav | `apps/web/e2e/manual-retry.spec.ts` 2/2 (7.5s). Ancestor with a successor shows **Already retried** + **View retry**; Retry only when `manualRetry.allowed` and no successor. UX-01 surface rules unchanged. |
| 13 | API/txn, effect reuse, Worker, Web tests; real DB and production executor | See test inventory below. Reuse path is `createRunExecutor` (AgentScope), not `scripted`. Worker-chain uses a standalone `apps/worker` process. |
| 14 | Typecheck, directed tests, migration drill, E2E in the existing CI jobs | Migration `20261019090000_manual_retry_lineage` is the 115th Prisma migration (applied on `workpal_e2e_mr01` and `workpal_e2e_mr01_wc`). `manual-retry.spec.ts` joins the regular Web E2E job; the Worker case is in `pnpm test:worker-chain` (CI `agentscope` job). `--grep=` on the worker-chain CLI avoids the 5-minute lease-loss case. |

### Test inventory (this delivery)

| Suite | Command | Result |
| --- | --- | --- |
| Core eligibility + operation identity + prompt | `pnpm --filter @rakazo/core exec vitest run --root ../.. packages/core/src/manual-retry.test.ts packages/core/src/manual-retry-prompt.test.ts packages/core/src/execution-snapshot.test.ts` | 36/36 (19 identity/eligibility + 3 prompt + 14 snapshot) |
| Contracts | `pnpm --filter @rakazo/contracts exec vitest run --root ../.. packages/contracts/src/manual-retry.test.ts packages/contracts/src/events.test.ts` | 6/6 |
| Isolated PG journeys | `VERIFY_DATABASE=1 pnpm --filter @rakazo/db exec vitest run --root ../.. packages/db/src/manual-retry.postgres.test.ts` | 13/13 |
| Production executor reuse + identity HTTP fixture | `pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/manual-retry-reuse.test.ts` | 11/11 |
| Chain load + identity match (PG) | `VERIFY_DATABASE=1 pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/manual-retry-effects.postgres.test.ts` | 1/1 |
| Run budget fail → adjust → retry (PG) | `VERIFY_DATABASE=1 pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/run-budget-enforcement.postgres.test.ts` | 5/5 |
| AG-04 family ownership + scenario unit | `pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/scenario-contract.test.ts` | 36/36; 72 segments owned |
| Web unit (card, Task Center, error copy) | `pnpm --filter @rakazo/web exec vitest run --root ../.. apps/web/src/lib/manual-retry.test.ts apps/web/src/lib/execution-card.test.ts apps/web/src/components/ai/TaskCenterView.test.tsx` | 63/63 |
| Typecheck | `tsc --noEmit` on core, contracts, db, adapters, api, worker, web | pass |
| Biome | owned R3 files | pass. Pre-existing `executor.ts` optional-chain warnings left untouched |
| Chat + Task Center E2E | unchanged UI/RPC this round; prior `manual-retry.spec.ts` 2/2 | not re-run |
| Worker stop → queued → claim | wrap still contains `manual retry`; prior worker-chain 1/1 | not re-run |

### Migration

`packages/db/prisma/migrations/20261019090000_manual_retry_lineage/migration.sql`

- `runs.retryOfRunId TEXT` unique self-FK, `ON DELETE RESTRICT`
- Existing Task/Run rows remain readable; column is nullable

`packages/db/prisma/migrations/20261019150000_manual_retry_operation_identity/migration.sql`

- `external_effects.operationId TEXT NOT NULL` with index; existing rows backfilled `operationId = id`
- Several rows may share one id across a retry chain; the column is not unique

## Completed vs unknown effects

- **Completed + recoverable result** for the bound `operationId` in this `retryOfRunId` chain: return the stored result, emit `effect.reconciled`, do not POST the provider. Read-only agent tools and connector tools with `declaredReadOnly === true` are not matched; they re-read.
- **Intended / denied / cancelled / approved-unexecuted / `manual_retry_authorized`**: execute again under current permission and approval policy, persisting the same `operationId`.
- **Executing / uncertain / failed / ambiguous / completed-with-null-result**: re-read the row; if it is now completed+recoverable, reuse; otherwise pause with a choice Intervention naming that operation. The user's choice writes `reviewDecision` on the **old** effect (`manual_retry_confirmed` / `manual_retry_authorized` / `manual_retry_cancelled`).
- There is no extra vendor-specific GET when the connector has no idempotent read.

## AG-04 intersection

- Retry copy lives in `prompts/retry/manual-retry-context.md` (P04 family segment `retry/manual-retry-context`).
- Renderer is the unified single-pass `renderPromptSegment`. Inserted `{{originalTask}}` / `{{operationSection}}` values that contain template tokens stay inert. The previous `packages/core/src/node/prompt-file.ts` loader and `packages/core/src/prompts/` copy are deleted.
- Renderer `renderManualRetryPrompt` is tested against a real outgoing `AgentRunRequest.prompt` (reuse tests + worker-chain). Provenance union is not extended. Ordinary P04 scenario goldens are unchanged: the wrap is assembled only when `retryOfRunId` is set.

## Known limits

- Java Agent Runtime is unchanged. Retry framing is a user-prompt wrap, not a new `contextKind`.
- `cancelled` Runs without Plan/Steps/Intervention/failure have no chat Execution shell (UX-01). Retry is from Task Center.
- Threads with neither `botId` nor `groupId` are refused (`forbidden`). Messaging/external tasks that live on a bot-owned or group-owned Thread retry with the copied trigger and `sourceMessageId`.
- Space usage is observational. There is no space spend cap, so a space with large `UsageRecord` totals still enqueues a retry (`queued`). Per-run usage and `budgetOverride` are not inherited.
- Local Web E2E used a disposable Postgres named `workpal_e2e_*` because this machine has no `/var/run/docker.sock` for testcontainers. CI still uses the existing harness.
- Not merged, not deployed.

## MR-01-R3 follow-up — 2026-10-19

Occurrence matching was reproduced first: same-args completed-first + uncertain-second, live occurrence 0 reused the completed first. R3 replaces that ordinal with `ExternalEffect.operationId`. Migration `20261019150000_manual_retry_operation_identity` adds the column, backfills `operationId = id`, and indexes it. Bound/catalog envelopes, nonce ownership, legacy `effect.reconciled`, original `Task.prompt`, two UI entries, and the standalone Worker path are unchanged.

Review round after `55ca71f`: the same `retryOperationId` repeated inside one retry Run no longer POSTs again — matching consults this Run's completed/executing rows, and omit-id is still a new independent operation. Direct and catalog model-visible schemas declare `retryOperationId` so `additionalProperties: false` connectors can pass it. Chat E2E locates ancestor vs successor by Run identity (`failed.runId` / `retrySuccessorRunId`) plus already-retried vs live shell, without a raw Run id attribute.

Confluence with AG-05 live refresh: Java re-registers `currentTools()` schemas before the first and every later model HTTP, so wrapping only the initial `request.tools` dropped the field. `toolsForRetryRun` now wraps the initial list, `currentTools()` success path, and its fallback. Ordinary Runs stay unwrapped. Real-jar capture keeps the field on every retry round for direct and catalog schemas; repeated operations still HTTP=1. No deployment occurred.
