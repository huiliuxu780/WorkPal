# ME-00: closing the native compaction summary memory-deletion gap (PR #45 review P1)

Branch: `codex/me00-compaction-memory-purge`, base `main` @ `0df02fb` (WK-01 merge). Task card:
[ME-00.md](./tasks/ME-00.md). Runtime changes are Java-only (`services/agent-runtime`); the wire
protocol and all TS packages are untouched.

## The gap, confirmed at code level

AG-06 (round 2) moved durable bot/user memory out of the system message into a replaceable
run-scoped application-context message (`packages/adapters/src/memory-context.ts` preamble, Java
`DURABLE_MEMORY` prefix), and `RuntimeEngine.refreshApplicationContext` replaces the persisted copy
on every restored session — or removes it when the current run brings no application context
(round 3). But AgentScope's native compaction (`ConversationCompactor`, token-gated under the AG-02
production config: `contextWindow 8192 → triggerTokens 4096 / keepTokens 2000` in fixtures) folds the
whole compacted prefix — memory message included — into a persisted summary `Msg`:

- role `USER`, `name = "__compaction_summary__"` (library constant `ConversationCompactor.SUMMARY_MSG_NAME`),
- text is model-generated and matches **none** of the three application-context prefixes,
- `Msg.name` survives the JSON state round-trip (`@JsonCreator` with `@JsonProperty("name")`),
- `CompactionMiddleware.applyToContext` replaces the context list with `[summary] + retained tail`;
  the `AgentState.summary` field is not used by the compaction path (bytecode: zero `setSummary` calls),
- AG-02 deliberately pinned the summary as surviving application-context refresh (task 4d).

So once a session compacted, later memory **updates and deletions** could not reach the summary: the
stale memory body kept entering every subsequent model request through it. This is the P1 the PR #45
review recorded and the roadmap parked at ME-01; per the task card it is fixed here as its own slice,
ahead of the next Java production deployment and AG-07. Production exposure today is nil — the ECS
instance still runs the 2026-10-07 Python stack and this Java path has never been deployed (verified
remotely 2026-10-16; see the ME-00 card §已核实的基线). The risk boundary is the catch-up deployment.

## Red baseline on the unmodified engine

`MemoryCompactionPurgeIntegrationTest` drives the real `RuntimeEngine` (production `CompactionConfig`)
against a local OpenAI-compatible fixture whose SUMMARY handler **echoes back exactly the memory
markers it received** in the compacted prefix — a marker can only reach a later model request if it
genuinely traveled prompt → summarizer call → persisted `__compaction_summary__` → restored context.
Each run-1 also asserts the fold happened for real: a SUMMARY call fired, that call's request
contained the memory marker, and the persisted `agent_state.json` holds a `name="__compaction_summary__"`
message carrying it.

Unmodified engine: **8 tests — 6 red, 2 green**, and the two green are precisely the controls that
must hold before and after the fix (unchanged memory keeps the summary; Thread Clear generation is
unreachable). The six reds are the gap itself:

| Test (red on unmodified engine) | Proven stale path |
| --- | --- |
| `updatedDurableMemoryNoLongerReachesModelThroughNativeSummary` | pre-update marker `USERA_MEM_R1` reaches the model after the memory was updated to R2, with **zero** re-compaction on the follow-up (so the disappearance post-fix can only be the purge) |
| `deletedDurableMemoryNoLongerReachesModelThroughNativeSummary` | marker + memory preamble survive an empty-non-null history (deletion) run |
| `purgeSurvivesRuntimeRestart` | stale marker survives a fresh `RuntimeEngine` over the same state roots |
| `legacySessionWithoutFingerprintStateIsInvalidatedConservatively` | session without fingerprint sidecar keeps an unproven summary |
| `scopeChangeInvalidatesEveryAffectedSessionIndependently` | both bot sessions of the updated user replay the stale marker |
| `applicationLayerSummarySurvivesMemoryPurge` | stale marker co-exists with the re-injected application-layer summary |

## The fix

**Chosen approach: per-session durable-memory fingerprint sidecar + name-based conservative summary
invalidation** (task card 修复约束 1, first option — safe invalidation of the affected native working
state). No text search, no replacement markers, no "ask the model to forget".

1. `durableMemoryFingerprint(request)` — SHA-256 over the concatenated durable-memory
   application-context message contents of the current request (`id==null`, `role=user`, `DURABLE_MEMORY`
   prefix), `"none"` when verifiably absent, `null` when `history == null` (auxiliary/recovery runs
   carry no history information; the mechanism skips instead of recording a false guarantee). The
   backend assembles that body per (user, bot) with `scope: path (revision N)` headings, so any
   update or deletion changes the fingerprint, and a user-scope change changes it independently in
   every affected bot/thread session on next use — no global sweep, no reuse of the Thread Clear
   generation.
2. `MemoryContextState(fingerprint)` — a record implementing the marker interface `State`, persisted
   as `memory_context_state` through the same `JsonFileAgentStateStore` as `agent_state` (survives
   Java restarts; removed by `purgeBot`'s tree delete). Semantics: *the memory fingerprint under
   which this session's current native summary (if any) is known to be clean.*
3. Invalidation, inside the existing non-resume refresh guard:
   - restored session, fingerprint differs from the sidecar → remove every context message with
     `name == ConversationCompactor.SUMMARY_MSG_NAME` (library constant, never a text match), then
     save `agent_state`, then save the sidecar. Crash between the two saves leaves the sidecar stale,
     so the next run re-evaluates and re-purges idempotently;
   - restored session, **no sidecar** (persisted before ME-00) → one-time conservative invalidation
     of an existing summary, then record;
   - fingerprint equal → nothing is touched (repeat runs of one memory version never reset — pinned
     by `unchangedMemoryKeepsNativeSummaryAcrossRuns`);
   - fresh session → sidecar recorded up front (the run's compaction, if any, is built under this
     fingerprint; without this, every session's second run would purge spuriously);
   - resume attempts (pending tool calls / confirmation) skip the purge together with the AG-06
     application-context refresh — see boundaries.

**Rejected alternatives** (task card required proving 2.0.3 API feasibility first):

- *Keep replaceable application context out of native compaction* — AgentScope 2.0.3 exposes no
  compaction-exclusion hook (`CompactionConfig` has trigger/keep/flush/offload/prune/truncate knobs
  only; the memory message sits at context index 0 and is always inside the compacted prefix). Same
  upstream-constraint family as the AG-02 leaf-helper compaction config. Recorded for ME-02/upstream.
- *Search/replace or redact the summary text* — forbidden by the card: content matching cannot prove
  deletion (paraphrase survives), and it would rewrite library-owned model output.
- *Invalidate the whole session state* — destroys the retained recent tail and pending-free
  continuity for no additional safety; the summary is the only unproven carrier.
- *Re-summarize to rebuild* — extra model call per memory change with cost/authorization/audit
  consequences; a later run re-compacts naturally when the context grows again.

## Boundaries and honest limits (card 修复约束 4 / 验收 3–4)

- **The purge drops the entire native summary.** The session loses its summarized early-conversation
  prefix on the first run after a memory change. What survives (pinned by tests): the retained
  recent tail (`NEEDLE_RETAINED`) and the application-layer `history.compact` summary (PostgreSQL
  cursor untouched — it is re-injected by the backend like any application context). A later run
  re-compacts and rebuilds a native summary from the then-current context. Accurate user impact:
  one degraded-context run per memory change per session, no data loss in PostgreSQL.
- **Paused runs:** a memory change while a run is paused for approval/tool-resume takes effect on
  the next **non-resume** run — resume attempts deliberately skip the application-context refresh
  (AG-06) and the purge with it, so pending tool-call continuity is never rewritten. In-flight model
  calls at deletion time are not retracted; the guarantee is "next non-resume model request", not
  "instant recall".
- **Independent records are not erased:** if the same fact was restated by a real person in a thread
  message, or written by the model into an ordinary assistant message, those are separate records
  and survive memory deletion — as does anything already inside the retained tail. Stronger
  product-level deletion semantics belong to ME-01's fact store.
- **Fixtures prove request/state behavior, not model cognition** — a real model that already saw the
  old memory in an earlier turn may still reproduce it from its own prior output; that is outside
  any state-side fix.
- Model-call accounting (验收 4): the fix adds **zero** model calls (pure persisted-state surgery).
  Tests pin `FLUSH == 0`, exactly one `SUMMARY` (run 1 only), no re-compaction on short follow-ups,
  no native `memory/` files, no `MEMORY.md`, no `large_tool_results/`, no offload pointer. AG-02
  `productionCompaction()` (trigger 30 / keep 10 / flush false / offload false) is byte-identical.

## Verification matrix

| Gate | Result |
| --- | --- |
| Red baseline, unmodified engine | 6 red / 2 control green (`MemoryCompactionPurgeIntegrationTest`) |
| Post-fix | 8/8 green |
| Sabotage (`staleMemory = false`) | exactly the same 6 red again — the regression tests depend on the invalidation mechanism |
| JDK 21 `mvn package` (full agent-runtime suite) | **76/76**, BUILD SUCCESS — incl. AG-02 `CompactionBoundaryIntegrationTest` 7/7, AG-06 memory-refresh journeys in `RuntimeIntegrationTest` 20/20 (incl. paused/resume flow), `UntrustedContentBoundaryTest` 2/2, `DelegationSuspensionTest` 3/3 |
| Jar-booting TS integrations (vitest, real jar spawn) | adapters `agentscope-untrusted-content` + `agentscope-auxiliary-isolation` + `turnpolicy-v2-agentscope` **24/24**; api `team-chat-judge.integration` **1/1** |
| TS typecheck | not affected — zero TS files changed (`git status`: one modified Java file + one new Java test + docs) |
| Wire schema | unchanged; one new per-session persisted state file (`memory_context_state.json`), safe to delete (absence only triggers the one-time conservative invalidation) |
| Known pre-existing failure | `history-compaction-agentscope.test.ts` fails identically on the unmodified baseline (recorded in AG-06, not on a CI line) — untouched here |

## Handover

Per the card's §与部署任务的交接: this closes the code-path P1 only. The production catch-up remains
a separate deployment task (verified 2026-10-16: ECS frozen at the 2026-10-07 Python-runtime deploy,
19 migrations behind, `deploy-workpal.sh` never exercised, rollback path untested). ME-01 keeps the
fact-store design and must preserve this guarantee when it rebuilds memory storage.
