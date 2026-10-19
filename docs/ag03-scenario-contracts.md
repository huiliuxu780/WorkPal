# AG-03 delivery note: S01–S14 executable scenario contracts

Branch `codex/ag03-scenario-contracts`, base `main @ c2dfea4` (CI run 39188374800 green). Status: **delivered, ready-to-merge** ([PR #74](https://github.com/huiliuxu780/WorkPal/pull/74)) — not merged, not deployed. Task card: [AG-03](./tasks/AG-03.md); matrix: [agent-scenario-matrix.md](./agent-scenario-matrix.md); inventory: [agent-prompt-inventory.md](./agent-prompt-inventory.md).

**Ancestry note**: the task-card commit (`docs: define AG-03 AG-04 and manual retry delivery tasks`) is content-identical to `ad4ef00` on the unmerged PR #64 branch; it was re-applied on `main @ c2dfea4` as `6231d06` because PR #64 had not merged at branch time. Work was performed in a dedicated git worktree (`WorkPal-ag03`) because the primary checkout was concurrently occupied by the parallel MR-01 branch; nothing from MR-01's uncommitted work entered this branch, and no MR-01 module (retry/schema/RPC/UI) was touched.

## What was built

| Layer | File | Runs | Proves |
| --- | --- | --- | --- |
| Case registry | [`packages/adapters/src/__fixtures__/scenarios/case-registry.ts`](../packages/adapters/src/__fixtures__/scenarios/case-registry.ts) | data | 41 stable case IDs over S01–S14, trigger classification for all 14 `RunTrigger` values, P01–P14 family markers, frozen tool-set literals |
| Offline unit | [`packages/adapters/src/scenario-contract.test.ts`](../packages/adapters/src/scenario-contract.test.ts) | 33 tests | Registry integrity (evidence files exist), declared-only trigger source scan, per-trigger TurnPolicy mapping, frozen literals vs `selectBuiltinToolsForRun`, family markers vs production composers, webhook unattended approval, silent-reply/guidance/notification contracts |
| Real boundary | [`packages/adapters/src/scenario-contract.integration.test.ts`](../packages/adapters/src/scenario-contract.integration.test.ts) | 20 tests | Final model requests through TS adapter → real Java jar → local OpenAI-compatible fixture: execution scope, system-prompt section order, prompt-family include/exclude with assembly position, exact model-visible tool sets (backend + Java natives, sorted) |
| Production chain | [`packages/testkit/src/scenario-contract.postgres.test.ts`](../packages/testkit/src/scenario-contract.postgres.test.ts) | 9 tests | Full app + production executor + PostgreSQL + real jar: lawful tool execution, created-intro zero-backend-tool fact, routine result/NO_RESPONSE branches, approval allow/deny same-Run resume with trigger preserved, reaction message-only entry, revoked-connector findings A/B, clean-thread connector invisibility |
| Judge family | [`apps/api/src/team-chat-judge.integration.test.ts`](../apps/api/src/team-chat-judge.integration.test.ts) (extended) | +1 test | S14-C1: P13 family at the real boundary — untrusted-data framing, aux turn-policy text, scope declaration, no history/collaboration/personal memory |

No paid inference anywhere; every suite runs offline (local jar + loopback model fixture). Real-model task quality for these scenarios is **not evaluated** and not claimed.

## Capture boundary

"Final scope, prompt family and exact tool set" are captured where the request actually reaches the model:

- **integration/postgres layers**: the loopback model fixture records the OpenAI-protocol request emitted by the Java runtime (system prompt = `PromptComposer.compose` output; `tools` = post-Java-filter visible set). Assertions read those captures.
- **Requests are built by production composers** (`selectBuiltinToolsForRun`, `userTurnInstructions`, `turnPolicyFromRun`/`resolveTurnPolicy`, `buildAutoReviewPrompt`, `buildGroupRouterPrompt`, `buildCompactionSummarizerPrompt`, `buildDeliveryPrompt`, `formatSkillRunPrompt`, messaging prompt builders), so a composer change fails the contract instead of drifting silently.
- **Permission/execution outcomes** run through the production executor and PostgreSQL (no return-value mocks): sandbox `act` spy, `externalEffect` rows, `composio.executions`, run/message rows.

## Captured facts and findings (recorded, not masked)

1. **Skill-loader gating**: `load_skill_through_path` is registered only when the request carries skills. Production chat runs (including the created intro) carry the default skill set, so it is visible there; delivery (`skills: []`) sees **zero** model-visible tools.
2. **`run_subagent`** stays in the TS selection but Java never registers it (AG-02); it appears in no model-visible set, and no `agent_*`/`task_*` native is ever offered through the production entrypoint regardless of policy (S07-C1).
3. **Finding A — revoked-resource replay fails the Run**: connector revoked between approval record and resume → the Java bridge allow-list rejects the session-pending replay ("Tool is not allowed for this run"), the Run ends `failed`, the effect stays `approved`, and zero provider executions occur. The denial never surfaces to the model as a tool-error result. Repro: `S09-C3 permission change before resume`. Impact: safe (zero side effects) but the user sees a failed run instead of an explained denial. Attribution: `RuntimeEngine.resumeTools` × executor resume request carrying the post-revoke tool list. Product-gap candidate for a follow-up task; AG-03 pins current behavior.
4. **Finding B — session poisoning after Finding A**: the dangling pending tool call persists in the Java session; the next chat Run on the same thread re-enters `resumeTools`, hits the same refusal and fails **without any model call** (thread wedged until a generation change/clear). Pinned in the same test with a provided model step so a future fix fails the pin loudly.
5. **Declared-only triggers**: `reaction` (message-only entry, `reactToThreadMessage`) and `resume` (recovery keeps the original trigger) have no production creation site; pinned by a source scan over `apps/api`, `apps/worker`, `packages/*` with a single allow-listed read-path query filter. `handoff` is a collaboration source/role, not a trigger.
6. Baseline-document deviations (7) are itemized in the [matrix](./agent-scenario-matrix.md#corrections-against-the-external-baseline-2026-10-19).

## Production changes (observability seams only)

Behavior-identical extractions/exports so contracts assert production sources instead of copies — no logic, ordering or byte changes to any request:

- `history-compaction.ts`: `buildCompactionSummarizerPrompt` + `HISTORY_COMPACTION_INSTRUCTIONS`
- `auto-review.ts`: `AUTO_REVIEW_INSTRUCTIONS`
- `product-harness/group-router.ts`: `GROUP_ROUTER_INSTRUCTIONS`
- `executor.ts`: `voiceTurnInstruction` (the `voiceCall && !callEndRun` rule)
- `team-chat-judge.ts`: `TEAM_CHAT_JUDGE_INSTRUCTIONS`
- `router.ts`: `export` on `BOT_INTRO_PROMPT`, `HANG_UP_PROMPT`
- `result-delivery.ts`: type-only `export` of `DeliveryRow`

Prompt text movement is deliberately left to AG-04.

## CI collection

- `web-and-backend` job: `scenario-contract.test.ts` added to the explicit vitest list.
- `agentscope` job: `scenario-contract.integration.test.ts` added to the integration list; new step `pnpm test:integration --spec=scenario-contract.postgres.test.ts`; suite also added to the harness `suites` array for full local/CI integration runs.
- Collection proof: this delivery note records local runs (below); the PR head CI run executes the same files inside the existing jobs — no new pipeline was created.

## Verification log (local, 2026-10-19, macOS arm64, JDK 21, node 24, pnpm 9)

| Command | Result |
| --- | --- |
| `pnpm vitest run` — 16 targeted files (3 new suites + judge extension + executor/compaction/auto-review/group-router/turn-policy/messaging-prompts/judge-unit/agentscope-runtime + the 5 AG-01/02/06/07 integration baselines) | **295 passed / 0 failed** (4.0s) |
| `VERIFY_DATABASE=1 … pnpm vitest run packages/testkit/src/scenario-contract.postgres.test.ts` (colima PG 5433 `workpal_ag03_scenario`, jar on :8097) | **9 passed / 0 failed** (4.7s) |
| `pnpm --filter @rakazo/adapters/@rakazo/api/@rakazo/testkit check` (tsc) | clean |
| `mvn -B -f services/agent-runtime/pom.xml package -DskipTests` (JDK 21) | jar built; no Java source changes in this delivery |
| Sabotage verify A (tool-set): disabled the routine `schedule_create` filter in `schedule-tools.ts` | unit shape test went red; restored → green |
| Sabotage verify B (scenario role): altered the `handoff_owner` collaboration text in `PromptComposer.java`, rebuilt jar | integration S06-C2 went red; restored + rebuilt → green |

Existing AG-01/02/06/07 and ME-00 suites were run in the same gate (no regression). Java unit tests were not re-run because no Java file changed in the delivered diff (the sabotage file was restored byte-identical; `git status` clean for `services/`).

## Remaining items / boundaries

- **AG-05** owns per-model-call tool re-trimming; this delivery records the current per-Run assembly as fact only.
- **Findings A/B** are pinned, not fixed — they need a product decision (tool-error feedback vs run failure; session cleanup path). Suggested as a follow-up card.
- Pre-existing CI-collection gaps recorded as-is (not fixed here to avoid scope creep): `result-delivery.postgres.test.ts`, `execution-contract.postgres.test.ts`, `lease-loss-recovery.postgres.test.ts`, `run-budget-enforcement.postgres.test.ts` are not in the harness suites array; `group-chats.spec.ts` is not in the CI e2e spec list.
- Real-model quality/injection resistance: **未评估 (not evaluated)** — offline contract tests only.
- MR-01 intersection: none of its modules were touched; the only executor change is the `voiceTurnInstruction` extraction. Whoever merges second adds a targeted test around the prompt-assembly line if MR-01's retry framing lands there.
- AG-04 continues from this exact head per the continuous-delivery plan.
