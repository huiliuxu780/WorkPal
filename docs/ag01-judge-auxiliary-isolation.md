# AG-01: team-chat judge auxiliary execution isolation

Status: delivered on branch `codex/ag01-judge-auxiliary-isolation` (base `main` d563f28), 2026-10-15.
Task card: [tasks/AG-01.md](./tasks/AG-01.md); roadmap row: [next-work-roadmap.md](./next-work-roadmap.md).

## What changed

- `apps/api/src/team-chat-judge.ts`: the judge now sends `executionScope: "team-chat-judge"` on its
  run request (previously omitted, which the adapter serialized as the `chat` default).
- `packages/adapter-kit/src/types.ts`: `AgentRunRequest.executionScope` union adds `team-chat-judge`.
- `services/agent-runtime/.../RunRequest.java`:
  - `team-chat-judge` joins the allowed execution scopes.
  - New trusted-boundary enforcement: any non-chat (auxiliary) scope carrying backend `tools` or
    `skills` is **refused** with
    `IllegalArgumentException("Auxiliary execution scope must not carry backend tools or skills")`,
    surfaced as HTTP 422 before any model call. The chosen behavior is explicit refusal, not a
    silent strip; tests on both the Java and TypeScript sides pin this choice.
- `services/agent-runtime/.../RuntimeEngine.java`: `load_skill_through_path` is added to the
  model-visible allow-list for chat scope only (previously unconditional). Native plan and subagent
  tools were already chat-only via `planningAllowed()`/`delegationAllowed()`.
- `.github/workflows/ci.yml`: the `agentscope` job now runs the two new integration files; the
  `web-and-backend` smoke list adds the judge unit tests.

## Evidence: model-visible tools before vs after

Captured with real-boundary tests (API judge → TS adapter → Java runtime jar → local
OpenAI-compatible protocol fixture; no paid model). The fixture records every model request body,
so assertions read the `tools` array the model actually receives — not the caller-side
`AgentRunRequest.tools=[]`.

| Execution | Before fix | After fix |
| --- | --- | --- |
| Judge via `ModelTeamChatEngagementJudge.decide()` | wire scope `chat`; model-visible tools `["plan_write","plan_enter","plan_exit"]` | wire scope `team-chat-judge`; model-visible tools `[]` (strictly empty; assertion covers backend and native Plan/Skill/subagent/background tools) |
| `auto-review` / `history-compaction` / `turn-routing` with empty payloads | already `[]` (see deviations) | `[]`, also when a permissive v1 auto plan/delegation policy is attached |
| Any auxiliary scope mistakenly carrying backend tools or skills | **accepted and reached the model** (backend `shell` registered and visible; skill repository attached) | refused at `RunRequest.validate()` with HTTP 422 before any model call; the refused run produces zero model requests |
| Chat control with authorized `shell` tool + skills | model-visible tools include `shell`, `plan_enter`, `plan_write`, `load_skill_through_path` | unchanged — the same control test passes before and after |

Recorded pre-fix failures (baseline run on the unfixed implementation, 2026-10-15):

- Judge: `AssertionError: judge model-visible tools were ["plan_write","plan_enter","plan_exit"]`
  and `expected 'chat' to be 'team-chat-judge'`.
- Auxiliary carries-tools/carries-skills: `promise resolved … instead of rejecting` (6 cases across
  the three pre-existing auxiliary scopes).
- `team-chat-judge` scope before it existed in Java: `422 {"error":"Unsupported execution scope"}`.

## Deviations from the task-card assumptions

1. The card expected `load_skill_through_path` to be model-visible for auxiliary executions.
   Empirically the allow-list entry alone never reached the model request: with no skill repository
   attached (`disableDefaultWorkspaceSkills()` plus empty `skills`), AgentScope does not register or
   send the tool. The judge's real leak was the native **plan tools**, because the judge ran under
   the chat-default scope where `enablePlanMode()` registers `plan_enter`/`plan_write`/`plan_exit`.
   The chat-only gate on `load_skill_through_path` is kept as the minimal defensive change so future
   AgentScope defaults cannot expose it on auxiliary scopes.
2. Auxiliary scopes with empty payloads already had a strictly empty model tool set pre-fix. The
   genuinely missing defenses were (a) the judge defaulting into the chat scope and (b) auxiliary
   requests carrying tools/skills being accepted without any check. Both are now closed and
   test-pinned.
3. Judge business behavior (JSON decision parsing, usage recording, silence on failure) already
   worked through the real chain pre-fix and continues to work post-fix; the timeout path is now
   covered by a dedicated unit test as well.

## Tests and checks

Targeted runs on this checkout (repo-locked pnpm 9.15.0 via corepack; JDK 21 — openjdk 21.0.12.1):

- `mvn -B -f services/agent-runtime/pom.xml package`: BUILD SUCCESS.
  RunRequestPolicyTest 16/16 (new: judge scope accepted and capability-free; unknown scope
  rejected; all four auxiliary scopes refuse tools and skills, including a fully-bridged tools
  variant proving the refusal is scope-based; chat keeps tools+skills accepted),
  RuntimeIntegrationTest 18/18 (new: auxiliary run reaches the fixture model with zero tools
  despite an auto plan/delegation policy; auxiliary run carrying a tool fails explicitly before any
  model call), PromptComposerTest 11/11, InterruptibleTaskRepositoryTest 3/3.
- `pnpm exec vitest run` over 11 targeted files: **169/169 passed** — the two new integration files
  (`apps/api/src/team-chat-judge.integration.test.ts` acceptance #1,
  `packages/adapters/src/agentscope-auxiliary-isolation.integration.test.ts` acceptance #2/#3),
  existing chat-boundary regressions (`agentscope-consumers`, `turnpolicy-v2-agentscope`), judge
  unit tests (now 6: prompt render, decision parsing, usage persistence, scope labeling with the
  isolated per-call identity, silence on runtime failure, silence on timeout), auxiliary consumer
  suites (`auto-review`, `history-compaction`, `group-router`), `agentscope-runtime`,
  `team-chat-bridge`, `team-chat-startup`.
- Typechecks: `pnpm --filter @rakazo/adapter-kit check`, `--filter @rakazo/adapters check`,
  `--filter @rakazo/api check` all clean; `@rakazo/adapter-kit test` 9/9.

## Boundary notes

- The judge keeps its per-call temporary identity (`team-chat-judge:<uuid>` as both threadId and
  runId), empty history and empty backend tools, and never shares the chat session or lease
  (RuntimeServer/RuntimeEngine key non-chat scopes per run).
- Refusal path through the judge: a 422 surfaces as a thrown error inside `decide()`, which the
  judge logs and converts to `{ act: false }` — the existing silence-on-failure contract required
  by the task card. The refusal itself is asserted explicitly at the adapter/engine level and is
  never parsed as a decision result.
- No change to judge prompt wording, engagement rules, model selection, message delivery or UI.
  `flushBeforeCompact`, native memory writes and tool-result offload remain AG-02 scope.
