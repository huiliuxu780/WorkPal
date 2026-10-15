# AG-02: AgentScope native compaction boundary

Status: delivered on branch `codex/ag02-compaction-boundary` (base `codex/ag01-judge-auxiliary-isolation` e5e5061, which is itself base `main` d563f28), 2026-10-15. Round 1 = commit `1f858cc` (main-agent compaction flush/offload). Round 2 (this revision) addresses review findings P1-1/P1-2/P2 — see [Review follow-up](#review-follow-up-round-2-2026-10-15). Roadmap status: `in-progress` (main-agent compaction + eviction and helper eviction closed; helper compaction blocked on an upstream AgentScope API).
Task card: [tasks/AG-02.md](./tasks/AG-02.md); roadmap row: [next-work-roadmap.md](./next-work-roadmap.md).

## Summary

AgentScope 2.0.3 defaults both `flushBeforeCompact` and `offloadBeforeCompact` to `true` (verified
in the locked `agentscope-harness-2.0.3.jar` via `javap -p -c` on `CompactionConfig$Builder`). Real
runs through the actual `RuntimeEngine` against a local OpenAI-compatible fixture prove these
defaults were live in WorkPal despite `disableMemoryHooks()`, `disableMemoryTools()` and
`disableFilesystemTools()`: those gates cover the ReAct-loop memory middleware and the callable
tool surface, but **not** the compaction-triggered flush/offload inside `ConversationCompactor`,
which `CompactionMiddleware` always wires when a compaction config is present. The fix keeps the
native 30-message trigger and working-context summary and explicitly turns both pre-compaction side
effects off. No native long-term memory is written, no unauthorized memory-extraction model call is
made, and the model-visible summary stays inline instead of becoming an unreadable file pointer.

## What changed

- `services/agent-runtime/.../RuntimeEngine.java`:
  - The production `CompactionConfig` is now built by `productionCompaction()`, which keeps
    `.triggerMessages(30).keepMessages(10)` and adds `.flushBeforeCompact(false)` and
    `.offloadBeforeCompact(false)`. This is the only production behavior change.
  - A package-private constructor seam `RuntimeEngine(json, stateRoot, workspaceRoot, CompactionConfig)`
    lets an integration test drive the real engine under AgentScope's stock defaults so the pre-fix
    gap stays reproducible. The public constructor used by every production caller delegates to
    `productionCompaction()`. No new production knob is exposed outside the package.
- `services/agent-runtime/.../CompactionBoundaryIntegrationTest.java` (new, 7 tests): drives the real
  `RuntimeEngine` → local model fixture with isolated `@TempDir` state/workspace. Covers the pre-fix
  baseline (via the seam + stock defaults), the post-fix production behavior, offload read-back,
  cross-Run continuation, a second compaction, tenant/bot/thread isolation, and the separation of the
  native summary cursor from the PostgreSQL application-layer `history.compact` cursor.
- CI: the `agentscope` job already runs `mvn -B -f services/agent-runtime/pom.xml package`, which
  executes every `*Test` in the module via surefire 3.5.4 (no excludes). The new test file is on that
  resident path with no workflow change required.

## Evidence: model calls, files, and offload before vs after

All evidence is from real runs that trigger native compaction (asserted by a compaction-summary model
call **and** a physical shrink of the persisted `AgentState` context), never from inspecting a builder
value in isolation. Fixture model `contextWindow=8192`; a 40-message seeded chat conversation whose
prefix exceeds the derived keep-token budget.

### Model-call kinds and counts (one compaction-triggering run)

| Call purpose (fixture classification) | Before fix (stock defaults) | After fix (production) |
| --- | --- | --- |
| Normal reply (`NORMAL`) | 1 | 1 |
| Compaction working summary (`Context Extraction Assistant`) — necessary, allowed | 1 | 1 |
| Pre-compaction memory flush (`memory extraction assistant`) — unauthorized extra call | **1** | **0** |
| Total model calls for the run | 3 | 2 |

Normal replies and the necessary compaction summary are counted separately from the forbidden
pre-compaction flush call; only the flush call is removed.

Baseline (pre-fix) observed tally on the unmodified `RuntimeEngine`: `RUN1 kinds={SUMMARY=1, FLUSH=1,
NORMAL=1}`, persisted context shrank `42 → 8`. Post-fix production tally: `[SUMMARY, NORMAL]`.

### Workspace file inventory

| Path (under the per-session workspace) | Before fix | After fix |
| --- | --- | --- |
| `memory/YYYY-MM-DD.md` (native long-term memory, e.g. `memory/2026-10-15.md`) | **present** | **absent** |
| `agents/assistant/sessions/<session>.jsonl` / `.log.jsonl` / `sessions.json` | present | present |
| `default/assistant/<agent>/events/<range>.jsonl` | present | present |

The session transcripts and event logs are ordinary AgentScope session persistence — they are written
even when no compaction occurs, so they are not offload artifacts. The **only** file the flush path
adds is `memory/YYYY-MM-DD.md`. Its observed pre-fix content was:

```
## Memory Flush — 2026-10-15T03:58:48.334402Z
- prefers concise. FLUSH_MEM
```

i.e. the model's memory-extraction output appended verbatim to a native daily ledger, with no
WorkPal authorization, persistence, or audit. `MEMORY.md` was not produced in these runs (it is the
read-only curated ledger that a separate consolidation step — `MemoryMaintenanceMiddleware`, already
disabled by `disableMemoryHooks()` — would merge into); the daily-ledger write alone is the proven
unauthorized side effect. After the fix no `memory/` directory and no `MEMORY.md` appear.

### Offload read-back

Offload does not create a distinct file; `offloadMessages` appends the compacted prefix to the
existing session transcript and `resolveOffloadPath` returns that path, which `buildSummaryMessage`
then embeds into the model-visible summary. Before fix, the summary message the model received was:

```
You are in the middle of a conversation that has been summarized.

The full conversation history has been saved to <hash>/agents/assistant/sessions/<session>.jsonl
should you need to refer back to it for details.

A condensed summary follows:

<summary>
WORKING_SUMMARY_MARKER ...
</summary>
```

That `<hash>/…/<session>.jsonl` is a workspace-relative pointer. Because `disableFilesystemTools()`
removes every file-read tool and no backend tool reads arbitrary workspace files, the model has **no
controlled path to read it back** — a dangling pointer. It also suppresses the clean inline summary
(the "has been saved to" variant replaces the "Here is a summary of the conversation to date"
variant). After the fix the model receives the clean inline summary and no pointer:

```
Here is a summary of the conversation to date:

<summary>
WORKING_SUMMARY_MARKER ...
</summary>
```

The `productionCompactionLeavesNoDanglingPointerForTheNextModelTurn` test continues one more model
turn after compaction and asserts that turn receives no "has been saved to" pointer while still
carrying the readable working summary and a retained recent message — so continuation does not
depend on the model "guessing" offloaded content.

### Cross-Run continuation (30/10 semantics)

- `compactedSessionContinuesAcrossRunsWithSummaryAndRecentMessages`: after run 1 compacts, a NEW run
  in the SAME session (whose prompt does not echo any marker) still receives the native working
  summary (`WORKING_SUMMARY_MARKER`) and a unique marker planted in the most-recent retained message
  (`NEEDLE_RETAINED_AG02`). Both can only come from the persisted post-compaction context, proving a
  follow-up carrying a unique marker is answerable from the working summary + retained recent
  messages. A short follow-up turn does not spuriously re-trigger compaction.
- `secondCompactionFiresAndSessionStillContinues`: a second, token-gated compaction fires on a later
  overflowing turn (a second `Context Extraction Assistant` call), the context stays bounded, and
  neither compaction writes native memory files.
- `compactedSessionStateDoesNotLeakAcrossTenantBotThread`: after compacting a session carrying a
  secret marker, four different user/space/bot/thread boundaries reach the model with none of that
  marker and none of the first session's native summary.
- `nativeSummaryIsDistinctFromApplicationCompactionCursor`: the native summary text never contains
  the application-layer phrase "owned compacted context through message sequence", and when the
  backend supplies its own `WorkPal-owned compacted context …` application summary on a later run,
  `refreshApplicationContext` refreshes only that application-context message while the native
  `__compaction_summary__` survives intact — the two compaction cursors coexist and the native
  summary neither writes nor advances the PostgreSQL `historyCompactionSummary/historyCompactedUpToSeq`.

## Deviations from the task-card assumptions

1. **"Native 30/10 compaction" is not purely message-count-gated.** WorkPal sets only
   `triggerMessages(30)` and `keepMessages(10)`, leaving `triggerTokens=0` and `keepTokens=-1` at
   their defaults. `CompactionMiddleware.resolveEffectiveConfig()` treats those defaults as "dynamic"
   and recomputes token thresholds from the model's reported context window: effective
   `triggerTokens = max(1, contextWindow - reserved)` (clamped to `contextWindow/2` when
   `reserved=20000` exceeds a small window) and effective `keepTokens` from
   `keepTokensMin/Max/Ratio`. `ConversationCompactor.determineCutoffIndex` then uses
   `findTokenBasedCutoff(keepTokens)` and **ignores `keepMessages=10`** whenever `keepTokens > 0`
   (which the dynamic path always produces). Practical consequence observed in the fixture
   (`contextWindow=8192` → effective `triggerTokens=4096`, `keepTokens=2000`): a conversation of 52
   **short** messages (~600 tokens) never compacted, because `shouldCompact` passed on message count
   but the safe cutoff was 0 (the whole tail fit inside `keepTokens`). Compaction only fired once the
   prefix exceeded the derived keep-token budget. The tests therefore trigger compaction with
   sufficiently large messages, and the "keep ~10 recent messages" wording in the card is really
   "keep the last `keepTokens` tokens" under the current configuration. The 30/10 builder values are
   preserved unchanged, per the task's "keep the existing 30/10 trigger and retention semantics";
   making retention truly message-count-based would require setting `keepTokens`/`triggerTokens`
   explicitly, which is out of AG-02 scope and recorded here as a design note for ME-02.
2. **`MEMORY.md` was not written in these runs**, only the daily ledger `memory/YYYY-MM-DD.md`. The
   card listed both as possible native memory writes; the daily ledger is the one the compaction flush
   actually produces. `MEMORY.md` is the curated ledger maintained by `MemoryMaintenanceMiddleware`,
   which `disableMemoryHooks()` already suppresses. The fix and its regression test assert on the
   whole `memory/` directory plus `MEMORY.md`, so either write would be caught.
3. **Offload leaves no separate file** to inspect; its only observable effect is the model-visible
   pointer string plus appended transcript bytes. The card's "check the file inventory for offload"
   is therefore answered by the pointer assertion, not by a new file.
4. **(round 2) A second offload path exists beyond compaction.** The card framed the boundary as
   compaction flush/offload only. In fact `ToolResultEvictionMiddleware` independently offloads >80k-char
   tool results to an unreadable `large_tool_results/` pointer, governed by neither `offloadBeforeCompact`
   nor `disableFilesystemTools`. Fixed for the main agent (`disableToolResultEviction()`) and for both
   main and helper via a `resultBlock` text bound — see [Review follow-up](#review-follow-up-round-2-2026-10-15).
5. **(round 2) The declared helper cannot be given the safe config through the public API.** The card
   assumed the fix could "make the helper use safe config". AgentScope 2.0.3's `SubagentDeclaration`
   exposes no compaction/eviction hook, `asLeafSubagent()` is package-private, and the custom
   `subagentFactory` path bypasses `deriveChildSessionId` (which background delegation relies on). So
   helper eviction is fixed at the shared `resultBlock` boundary, but helper compaction (flush/offload)
   remains an upstream-blocked gap rather than a WorkPal-side fix — a deviation from the card's assumption.

No deviation expanded scope: native compaction stays enabled, no file/shell/memory tool was added,
and no alternative executor was introduced.

## Tests and checks

JDK 21 (openjdk 21.0.12.1), repo-locked Maven module `services/agent-runtime`:

- `mvn -B -f services/agent-runtime/pom.xml package`: **BUILD SUCCESS**, `Tests run: 55, Failures: 0,
  Errors: 0, Skipped: 0` — CompactionBoundaryIntegrationTest 7/7 (new), RuntimeIntegrationTest 18/18
  (unchanged, confirming the constructor seam did not regress existing behavior), RunRequestPolicyTest
  16/16, PromptComposerTest 11/11, InterruptibleTaskRepositoryTest 3/3.
- Sabotage check: temporarily reverting `productionCompaction()` to the stock defaults (dropping the
  two `false` flags) makes `productionCompactionSummarizesWithoutNativeMemoryFlushOrOffload` **fail**
  (BUILD FAILURE), confirming the regression tests are sensitive to the fix and not vacuous. The
  correct configuration was restored afterward and re-verified green.
- No TypeScript changed: `CompactionConfig`, `flushBeforeCompact` and `offloadBeforeCompact` have no
  references under `packages/` or `apps/` (verified by grep), so no `pnpm` typecheck/test is
  implicated. The application-layer `history.compact` cursor remains backend-owned and untouched.

## Boundary notes and remaining limitations

- The fix is exactly two booleans on the existing compaction config; the 30-message trigger and the
  native working summary are preserved. Compaction still summarizes and still continues across Runs.
- The pre-fix baseline is kept reproducible in-suite via the package-private seam + stock defaults
  (`legacyAgentScopeDefaultsFlushNativeMemoryAndDangleOffloadPointer`), so a future AgentScope bump
  that re-enables either side effect by default would fail CI rather than silently regress.
- The fixture reports `contextWindow=8192`; production models report larger windows, which raise the
  derived `triggerTokens`/`keepTokens` but do not change the flush/offload behavior proven here (the
  side effects are gated only by the two booleans, not by the window). Deviation #1 above is the
  window-dependent nuance worth carrying into ME-02.
- This task does not implement application-layer `history.compact` policy, fact/shard/summary
  long-term memory, or a memory-extraction hook; those remain ME-01/ME-02. It only closes the
  unauthorized native write/pointer path and proves the native 30/10 working context still resumes.

## Review follow-up (round 2, 2026-10-15)

Review of round 1 (`1f858cc`) found two more AgentScope default paths plus two test/wording issues.
All were verified by real runs before fixing, per the task's "fix only proven gaps" rule.

### P1-2 — native tool-result eviction (a second, independent offload path) — FIXED

`HarnessAgent.Builder` registers `ToolResultEvictionMiddleware` unless `disableToolResultEviction()`
is called (builder default `false`); WorkPal did not call it. `ToolResultEvictionConfig.defaults()`
= `maxResultChars=80000`, `previewChars=2000`, `evictionPath="large_tool_results"`,
`excludedToolNames={read_file, write_file, edit_file, list_files, memory_search, memory_get,
session_search}`. For any tool result whose name is NOT excluded and whose combined `TextBlock`
text exceeds 80,000 chars, the middleware writes the full text to
`large_tool_results/<agent>/<callId-hash>` in the Java workspace and replaces the model-visible
content with `Tool output was too large (N chars) and has been saved to '<path>'. To read the full
output, use 'read_file' with path '<path>'.` plus a 2,000-char preview. `offloadBeforeCompact(false)`
does not govern this middleware.

Empirical baseline (real `RuntimeEngine`, backend tool returning 100k chars, pre-fix): the workspace
gained `large_tool_results/assistant/call-1-…` (100,018 bytes) and the next model request carried the
"has been saved to … read_file" pointer while the offered tools were `[big_tool, plan_write,
plan_enter, plan_exit]` — no `read_file`, so dangling (native filesystem tools disabled; the backend
`read_file` reads the Bot computer, not the Java workspace). A backend sweep confirmed foreground
tool results are not size-capped end to end, and `shell` (unbounded), `graphql`/connectors (≤1M) and
custom tools can exceed 80k chars into Java (`read_file` ≤250k is on the exclusion list).

Fix (reviewer's "disable native offload and constrain model-visible output", no new file tool):
- Main agent: `.disableToolResultEviction()`.
- All agents (main and declared helpers share `resultBlock`): bound the combined `TextBlock` text of
  any non-excluded tool result to `TOOL_RESULT_TEXT_CAP = 60000` chars (below the 80000 threshold)
  with an honest inline truncation marker. Excluded tools (`read_file`) are left uncapped to preserve
  the backend's own sizing — they are never evicted anyway.

Evidence (`ToolResultEvictionBoundaryTest`, production-like 200k window): main-agent and declared-helper
large non-excluded results → no `large_tool_results` file, no "Tool output was too large" placeholder,
cap marker present, full 100k run absent; `read_file` large result → uncapped, full content inline, no
eviction. Sabotage-verified: stubbing out the cap fails the main and helper eviction tests.

### P1-1 — declared helper does not inherit the safe config — eviction FIXED, compaction BLOCKED upstream

Bytecode: `HarnessAgentBuilderSupport.buildDeclaredFactory` (the path behind
`builder.subagent(SubagentDeclaration)`) captures the parent's model/toolkit/disable-flags but NOT its
`compactionConfig`, `toolResultEvictionConfig`, `disableCompaction` or `disableToolResultEviction`.
The child built in `lambda$buildDeclaredFactory$3` calls `.disableFilesystemTools/.disableShellTool/
.disableMemoryTools/.disableMemoryHooks/.disableSessionPersistence` but never `.compaction(...)` or
`.disableToolResultEviction()`. So the declared helper gets AgentScope default compaction
(triggerMessages 50, flush/offload TRUE) and default eviction ON. (The built-in general-purpose
factory does take CompactionConfig + ToolResultEvictionConfig params, but WorkPal uses a declared
helper, not general-purpose.)

- Helper eviction: FIXED by the shared `resultBlock` cap above (60000 < 80000) — it applies to the
  helper's `BackendSchemaTool` results too. Empirically the helper no longer evicts.
- Helper compaction (flush/offload): NOT safely fixable through AgentScope 2.0.3's public API:
  - `SubagentDeclaration.Builder` exposes only name/description/inlineAgentsBody/maxIters/tools/
    workspaceMode/workspace/persistSession — no compaction or eviction hook.
  - The only alternative, `builder.subagentFactory(name, desc, Function<String,Agent>)`, would have
    WorkPal build the child itself, but (a) `asLeafSubagent()` is package-private (uncallable from
    `com.workpal.runtime`) and gates build() wiring, and (b) `deriveChildSessionId` is invoked only
    inside the declared-factory path — the custom factory's `Function` receives just the subagent NAME
    and bypasses that derivation, so a hand-built child would key session/workspace differently from
    what background-task delivery (`registerBackground` + `InterruptibleTaskRepository` + outbox)
    relies on. Shipping that risks regressing shipped background delegation for a narrow gap.
  - Empirical proof the gap is real (real `RuntimeEngine`, declared helper, small-window 8192 fixture
    so the capped ~60k-char result exceeds the derived `triggerTokens`): the helper's own compaction
    fired with default flush/offload — it wrote 1 native `memory/YYYY-MM-DD.md` and emitted a
    "full conversation history has been saved to" offload pointer, while eviction was prevented
    (0 `large_tool_results`) by the cap.
  - Production reachability: the helper's compaction token trigger is `contextWindow - 20000`; one
    capped result (~15k tokens) is far below any production model window (≥128k → ≥108k trigger), and
    a leaf helper is bounded to ~10 steps, so typical helpers never compact. It stays reachable only
    for a tool-heavy helper accumulating many capped large results, or a small-window model. Recorded
    as an upstream dependency (AgentScope must expose compaction/eviction config on
    `SubagentDeclaration`, or a public leaf-subagent builder). See Deviations.

### P2 — exact model-call counts (tightened)

`productionCompactionSummarizesWithoutNativeMemoryFlushOrOffload` asserted only SUMMARY≥1 / NORMAL≥1
/ FLUSH=0, which an extra NORMAL-classified call would still satisfy. It now pins exact counts for the
deterministic single-compaction run: SUMMARY=1, NORMAL=1, FLUSH=0, total 2. The legacy baseline test
likewise pins FLUSH=1 / SUMMARY=1 / NORMAL=1.

### Wording — "context visible", not "answered"

The cross-Run continuation test proves the native working summary and a retained recent message's
unique marker are VISIBLE in the follow-up Run's model request. The fixture returns a fixed reply, so
it does not prove a real model answered correctly. The note and test comments now state context
availability, not answer correctness.

### Round-2 tests and status

`mvn -B -f services/agent-runtime/pom.xml package` (JDK 21): BUILD SUCCESS, **58 tests / 0 failures** —
CompactionBoundaryIntegrationTest 7, ToolResultEvictionBoundaryTest 3 (new), RuntimeIntegrationTest 18
(including the 4 subagent/background delegation tests, confirming the cap + `disableToolResultEviction`
did not regress delegation), RunRequestPolicyTest 16, PromptComposerTest 11, InterruptibleTaskRepositoryTest 3.
No TypeScript changed. Roadmap AG-02 → `in-progress`: main-agent compaction + eviction and helper
eviction are closed and test-pinned; helper compaction (flush/offload) remains open, blocked on an
upstream AgentScope API for declared subagents.
