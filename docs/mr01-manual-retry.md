# MR-01 Manual retry — delivery note

Status: `in-progress`, **ready-to-merge**. PR [#73](https://github.com/huiliuxu780/WorkPal/pull/73). Branch `codex/mr01-manual-retry`. Base `main` = `c2dfea4` (PR #65; task-card baseline `dcc73c5` is an ancestor). Task docs brought from `origin/codex/ag03-ag04-mr01-task-cards` @ `ad4ef00` (merge-base with main = `c2dfea4`). Automatic same-Run Attempt retry (`packages/db/src/retry-runs.ts` `scheduleAutomaticRunRetry`, event `run.retried`) is a different operation and is not reused here. Not merged, not deployed.

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
| Model-visible retry framing | `packages/core/src/prompts/manual-retry-context.md` rendered by `renderManualRetryPrompt`, wrapped onto the outgoing `AgentRunRequest.prompt` | Task.prompt stays the original user task. Provenance union is not extended (`manual_retry` is not a `contextKind`) |

`userTurnMessageForRun` still keys off `trigger === "user"` and `sourceMessageId`, so the current-turn message is the original user message.

## Effect matching rules

Identity (retry-chain only, never Space/Task-wide cache):

`tool + sha256(stableJsonValue(canonicalize(request))) + occurrence`

`canonicalize` unwraps production connector envelopes before hashing: catalog `[marker, executeTool, args, route?]` and bound-direct `[marker, "direct", { route, args }]`. Naked JSON requests stay as-is. Resource (`connectorId` / `resourceId` / `toolName` / `resourceRevision`), parameters, and occurrence stay distinct. The executor matches the live `effectRequest` (the same payload it persists), not resolved inner args alone.

Occurrence is the 0-based index of same-tool + same-normalized-request rows on that predecessor Run (`createdAt`, `id`). The live Run still records effects under `toolEffectIdempotencyKey(newRunId, …)` so a new Run id cannot silently collide with an old key.

Walk predecessors via `retryOfRunId` (nearest first). First matching row wins.

| Recorded status | Decision |
| --- | --- |
| `completed` with a recoverable `result`, and `reviewDecision` is not `manual_retry_authorized` / `manual_retry_cancelled` | Reuse the stored result. Emit `effect.reconciled` on the new Run with `{ executionId, kind, sourceEffectId, reuse: "manual_retry" }`. Do not insert a forged completed effect and do not call the provider |
| `intended` / `denied` / `cancelled` / `approved` (not executed) | New operation under current permission and approval policy |
| `reviewDecision = manual_retry_authorized` | New operation (user confirmed the previous attempt did not land) |
| `reviewDecision = manual_retry_cancelled` | Skip; return a skipped observation to the model |
| `reviewDecision = manual_retry_confirmed` with no recoverable result | Skip confirmation; do not forge a completed effect |
| `executing` / `uncertain` / `failed` / `ambiguous` / `completed` with null result | Re-read the row. If it is now completed+recoverable, reuse. Otherwise pause this Run with a choice Intervention (`confirm_completed` / `authorize_retry` / `cancel`) naming that operation |
| Different tool, connector resource, normalized args, or occurrence | New operation |

Read-only tools are not matched; they read current state. Matching never inspects Runs outside this `retryOfRunId` chain.

## Key call sites (verified on this branch)

- Automatic retry: `packages/db/src/retry-runs.ts` `scheduleAutomaticRunRetry` (same Run, new Attempt, `run.retried`). Untouched.
- Manual retry write: `packages/db/src/manual-retry.ts` `createManualRetryRun` (thread `FOR UPDATE`, unique successor + nonce, event on the **new** Run). Nonce hits on the happy path and P2002 recovery must belong to this source Task / `retryOfRunId` chain and pass Thread authorization; a foreign nonce is `nonce_conflict`.
- RPC: `runs.retry` in `packages/contracts/src/rpc.ts` / `apps/api/src/router.ts`. Enqueue `runContinueJob` outside the transaction, same pattern as routine `testRun`.
- Effect key (live Run): `packages/core/src/approval-effect-key.ts` `toolEffectIdempotencyKey`. Chain match: `packages/core/src/node/manual-retry-match.ts` (`canonicalizeManualRetryRequest` + `decideManualRetryEffect`). Executor wiring: `packages/adapters/src/executor.ts` passes live `effectRequest`.
- Worker lease / continue: existing `continueRun` + `runContinueJob`. New Runs start `queued` with no lease.
- Thread generation fence: surviving lifecycle event (same predicate as Task Center / HISTORY-001). `clearThread` deletes events, so a cleared Run cannot be retried.
- Prompt wrap: executor prompt assembly after `basePrompt` join; loader `packages/core/src/node/prompt-file.ts` (AG-04 will later point this at repo-root `prompts/`).

## 14-row acceptance evidence

| # | Acceptance | Evidence |
| --- | --- | --- |
| 1 | failed/cancelled root Retry on the correct entry; other statuses and delivery/helper have no Retry | `projectManualRetryEligibility` unit tests (`packages/core/src/manual-retry.test.ts`). Task Center + Execution Card only render Retry when `manualRetry.allowed`. PG `refuses helpers, delivery, completed, busy, cleared, and foreign actors`. Chat E2E retries a failed card; Task Center E2E retries a cancelled no-shell row. |
| 2 | New Run, same Task, same Thread, lineage, old history intact | PG `creates a successor on the same Task and Thread and keeps the failed original`. Chat E2E asserts a new `runId`, same `taskId`, original stays `failed`. Worker-chain retry: successor `retryOfRunId` = original, original stays `cancelled`, same `taskId`/`threadId`. |
| 3 | Original task input restored; real model request sees original target and retry wrap | Successor copies `Task.prompt`, `sourceMessageId`, trigger, routine, ownership. Prompt wrap `packages/core/src/prompts/manual-retry-context.md` via `renderManualRetryPrompt` / `manualRetryPromptPrefix`. Worker-chain last model request contains `WORKER_CHAIN_RETRY_FIXTURE` and `"manual retry"`. Reuse tests assert the wrap on the production executor request. |
| 4 | Worker down → queued, zero model calls; start → claim the same new Run | `apps/web/e2e/worker-chain.spec.ts` “retried while the Worker is down”: 16 polls of `queued` + `leaseOwner=null` + unchanged fixture count; after `startWorker` the lease pid is the Worker process, Run completes, transcript shows `WORKER_CHAIN_RETRY_REPLY`. 1/1 in 15.8s. Automatic same-Run Attempt retry (`retry-runs.ts`) is untouched. |
| 5 | Nonce replay and concurrent sources produce one direct successor | PG `replays the same nonce and collapses concurrent successor inserts`. PG `walks to the latest hop so a second retry continues the chain`. PG `refuses a nonce already used by another task of the same user` and `refuses a nonce already used by another user in the same space` (happy path + P2002 recovery). Task Center unit: nonce kept until success; same nonce reused after a business error. |
| 6 | Completed same external operation is not sent again | Production executor + local HTTP fixture (`manual-retry-reuse.test.ts`): completed bound-direct and catalog `hook_write` reuse → HTTP count stays 0, `effect.reconciled` `{ reuse: "manual_retry" }`. |
| 7 | Different args / target / occurrence are new operations | Core `decideManualRetryEffect` unit tests, including catalog / bound-direct envelopes and a different `resourceId`. Reuse test: different-args `scratchpad_add` executes. Chain match never inspects Runs outside `retryOfRunId`. |
| 8 | Uncertain results pause for a real user choice; old approvals do not authorize new ops | Reuse test pauses with `confirm_completed` / `authorize_retry` / `cancel`. PG group journey persists `reviewDecision` on the **old** effect via `checkpoint.manualRetryEffectId`. Denied / intended / `manual_retry_authorized` rows execute as new ops under current policy. |
| 9 | Group owner and routine occurrence retry; routine schedule unchanged | PG `retries a routine occurrence without writing a schedule row` (`nextRunAt` and `crons` unchanged). PG `retries a group-owned root`. External/messaging Runs on a bot-owned Thread keep `trigger`/`sourceMessageId`. |
| 10 | Clear / missing bot / foreign actor / busy Thread return business reasons, no extra Run | PG denials: `thread_cleared`, `not_found` (cross-space), `forbidden`, `thread_busy`, `bot_unavailable`, `nonce_conflict`. UI maps those reasons through `manualRetryErrorMessage`. |
| 11 | Budget and current configuration | New Run rebuilds `execution` via `turnExecutionForSource` (zero copied usage, no `budgetOverride`/`modelProvider`). Model, connectors, memory, permissions load at execute time from current Bot/User/Space rows. Existing usage settings remain the adjust surface. Space-level remaining budget is whatever is current; there is no extra preflight that blocks enqueue when the space is already exhausted. |
| 12 | Chat card + Task Center; cancelled without shell retries from Task Center; old record + successor nav | `apps/web/e2e/manual-retry.spec.ts` 2/2 (7.5s). Ancestor with a successor shows **Already retried** + **View retry**; Retry only when `manualRetry.allowed` and no successor. UX-01 surface rules unchanged. |
| 13 | API/txn, effect reuse, Worker, Web tests; real DB and production executor | See test inventory below. Reuse path is `createRunExecutor` (AgentScope), not `scripted`. Worker-chain uses a standalone `apps/worker` process. |
| 14 | Typecheck, directed tests, migration drill, E2E in the existing CI jobs | Migration `20261019090000_manual_retry_lineage` is the 115th Prisma migration (applied on `workpal_e2e_mr01` and `workpal_e2e_mr01_wc`). `manual-retry.spec.ts` joins the regular Web E2E job; the Worker case is in `pnpm test:worker-chain` (CI `agentscope` job). `--grep=` on the worker-chain CLI avoids the 5-minute lease-loss case. |

### Test inventory (this delivery)

| Suite | Command | Result |
| --- | --- | --- |
| Core eligibility + effect match + prompt | `pnpm --filter @rakazo/core exec vitest run --root ../.. packages/core/src/manual-retry.test.ts packages/core/src/manual-retry-prompt.test.ts packages/core/src/execution-snapshot.test.ts` | 28/28 |
| Contracts | `pnpm --filter @rakazo/contracts exec vitest run --root ../.. packages/contracts/src/manual-retry.test.ts packages/contracts/src/events.test.ts` | 5/5 |
| Isolated PG journeys | `VERIFY_DATABASE=1 pnpm --filter @rakazo/db exec vitest run --root ../.. packages/db/src/manual-retry.postgres.test.ts` | 8/8 |
| Production executor reuse + uncertain pause | `VERIFY_DATABASE=1 pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/manual-retry-reuse.test.ts packages/adapters/src/manual-retry-effects.postgres.test.ts` | 5/5 |
| Web unit (card, Task Center, error copy) | `pnpm --filter @rakazo/web exec vitest run --root ../.. apps/web/src/lib/manual-retry.test.ts apps/web/src/lib/execution-card.test.ts apps/web/src/components/ai/TaskCenterView.test.tsx` | 63/63 |
| Chat + Task Center E2E | `apps/web/e2e/manual-retry.spec.ts` on local `workpal_e2e_mr01` (testcontainers unavailable: no `/var/run/docker.sock`) | 2/2 in 7.5s |
| Worker stop → queued → claim | `pnpm test:worker-chain -- --grep="retried while the Worker is down"` | 1/1 in 15.8s |
| Typecheck | `tsc --noEmit` on core, contracts, db, adapters, api, worker, web | pass |
| Biome | owned MR-01 files | pass. Pre-existing `executor.ts` optional-chain warnings left untouched |
| Lingui | extract + zh-CN fill for Retry / Already retried / View retry / Retrying… / business errors | 8 new msgids |

### Migration

`packages/db/prisma/migrations/20261019090000_manual_retry_lineage/migration.sql`

- `runs.retryOfRunId TEXT` unique self-FK, `ON DELETE RESTRICT`
- Existing Task/Run rows remain readable; column is nullable
- Deployed locally via `prisma migrate deploy` on disposable `workpal_e2e_*` databases (115 migrations including this one)

## Completed vs unknown effects

- **Completed + recoverable result** on the same tool / canonical request (unwrapped catalog or bound-direct envelope, including resource route) / occurrence in this `retryOfRunId` chain: return the stored result, emit `effect.reconciled`, do not POST the provider. Read-only agent tools and connector tools with `declaredReadOnly === true` are not matched; they re-read.
- **Intended / denied / cancelled / approved-unexecuted / `manual_retry_authorized`**: new operation under current permission and approval policy.
- **Executing / uncertain / failed / ambiguous / completed-with-null-result**: re-read the row; if it is now completed+recoverable, reuse; otherwise pause with a choice Intervention naming that operation. The user's choice writes `reviewDecision` on the **old** effect (`manual_retry_confirmed` / `manual_retry_authorized` / `manual_retry_cancelled`).
- There is no extra vendor-specific GET when the connector has no idempotent read.

## AG-04 intersection

- Retry copy lives in `packages/core/src/prompts/manual-retry-context.md`.
- Loader is `packages/core/src/node/prompt-file.ts` (`loadPromptFile`), default dir `packages/core/src/prompts`. AG-04 can pass repo-root `prompts/` as `baseDir`. One loader, not two.
- Renderer `renderManualRetryPrompt` is tested against a real outgoing `AgentRunRequest.prompt` (reuse tests + worker-chain). Provenance union is not extended.

## Known limits

- Java Agent Runtime is unchanged. Retry framing is a user-prompt wrap, not a new `contextKind`.
- `cancelled` Runs without Plan/Steps/Intervention/failure have no chat Execution shell (UX-01). Retry is from Task Center.
- Threads with neither `botId` nor `groupId` are refused (`forbidden`). Messaging/external tasks that live on a bot-owned or group-owned Thread retry with the copied trigger and `sourceMessageId`.
- Space-level remaining budget is current; a space that is already exhausted can still enqueue a retry that fails again. Per-run usage is not inherited.
- Local Web E2E used a disposable Postgres named `workpal_e2e_*` because this machine has no `/var/run/docker.sock` for testcontainers. CI still uses the existing harness.
- Not merged, not deployed.

## Merge review follow-up — 2026-10-19

The wrapped connector and foreign-nonce fixes at `626142c` were reviewed. Two further regressions were reproduced and fixed at `35aa7ee`: normal/legacy `effect.reconciled` payloads remain accepted, while manual-retry payloads still require their source effect; resolving all three uncertain-operation choices preserves the shared original Task.prompt. Contract regression failed before the schema fix; three PostgreSQL choices failed before the prompt fix. Final focused checks: contracts/DB/adapters type checks, 19 contract/core/executor tests and 10 PostgreSQL tests passed. A follow-up only removes unrelated formatting from the DB diff.

**Not approved for merge yet:** the current per-execution occurrence index is not a stable cross-Run operation identity. Skipping/reordering completed identical-argument operations can associate a retry with the wrong prior effect. This is a remaining acceptance 6/7 issue; the original delivery's ready-to-merge claim does not cover it. Complete `docs/tasks/MR-01-R3.md` before merging #73. Also prove the existing budget-adjustment journey and unify the retry prompt loader with merged AG-04. No deployment occurred.
