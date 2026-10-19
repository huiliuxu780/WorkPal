# AG-04 delivery note: independent prompt files and unified assembly

Branch `codex/ag04-prompt-files`, created from the exact pushed AG-03 head `b5d3d51` (PR #74); initial PR base = `codex/ag03-scenario-contracts`, retargeted to `main` after AG-03 merged. Status: **done, merged** ([PR #75](https://github.com/huiliuxu780/WorkPal/pull/75), base=`main`) — merged, not deployed. Task card: [AG-04](./tasks/AG-04.md); segment index: [prompts/README.md](../prompts/README.md).

## What was delivered

The fixed bodies of P01–P14 are now independent, directly readable/editable Markdown files under the repository-root [`prompts/`](../prompts/README.md) tree — **71 segments**, ID = path without `.md`. Callers keep the typed conditional assembly and all dynamic content; Git is the version tracker; stable segment IDs serve source/test lookup only (no segment-version numbers, no prefix-recognition registry, no prompt frontend/version database/runtime switching, no wire-contract change).

**Loading (single source, two runtimes, no cwd dependency):**
- TS: `scripts/generate-prompt-texts.mjs` inlines the tree into `packages/core/src/prompt-texts.generated.ts` (pure constants — web-safe, no `fs`, works from any cwd and inside the app image which runs `tsx` over the repo tree). `renderPromptSegment` fills `{{key}}` placeholders in a **single pass**: dynamic values containing `{{...}}`, `${...}`, quotes, newlines or XML stay inert (unit-pinned with a hostile value; acceptance #5). CI fails when regeneration is not a no-op, so the generated file is never a second editing entry.
- Java: `PromptTexts` loads the same files as **jar classpath resources**; Maven packages `prompts/` via the `prompts.source.dir` property (default `${project.basedir}/../../prompts`); the runtime Dockerfile copies the tree into the image build and overrides the property. The jar never reads a developer checkout. The former `src/main/resources/platform-instructions.md` second copy is **deleted**.
- Text contract on both sides: segment value = file content minus exactly one trailing newline; all other bytes verbatim.

## P01–P14 index

Full family→file→caller→condition table: [prompts/README.md](../prompts/README.md). Registry wiring: `PROMPT_FAMILY_SEGMENTS` in [case-registry.ts](../packages/adapters/src/__fixtures__/scenarios/case-registry.ts) maps every family to its segment IDs; a unit test asserts all 71 segments exist, are non-empty, and are owned by exactly the family map (no orphans).

Rewired callers (fixed text removed from code): Java `PromptComposer` (platform, trust rules, turn-policy fragments, collaboration bodies) and `RuntimeEngine` (P11 helper declaration — seam-only, suspension unchanged); TS `executor.ts` (P03 operating blocks, voice/progress/silent/delivery guidance, plan/step instructions, P04 approval continuation, P14 replay-order/missing-args), `task-catalog.ts`, `auto-review.ts`, `group-router.ts`, `history-compaction.ts` (P07 prompt+instructions, P06 summary/recall wrappers), `memory-context.ts`, `result-delivery.ts`, `approval-effect.ts` (P14 refusals); core `messaging-prompts.ts`, `group-routing.ts`, `agent-skill.ts`; api `team-chat-judge.ts`, `router.ts` (bot-intro, hang-up). Deliberately NOT moved (documented in the README): dynamic content, structural tags/labels, tool schemas (business fields), third-party AgentScope context sections, small non-guidance error strings.

## Zero-diff evidence

1. **Pre-move baseline committed separately BEFORE any move** (`4241cc0`): `packages/testkit/src/prompt-files-baseline.integration.test.ts` captured 25 golden final requests through the real TS adapter → Java jar → local model fixture — all 12 production RunTrigger shapes, 4 auxiliary scopes, 3 collaboration roles + both outcome-resumption variants, approval-continuation resume, a two-request tool-execution round, typed memory/compaction/recall injections. Masking limited to enumerated unstable metadata (current-time timestamp; AgentScope-library environment lines; tool-schema key order from library map serialization); all WorkPal prompt text compared byte-for-byte as JSON strings.
2. **After every move batch** (A core, B Java, C+D adapters/api) the baseline suite re-ran with **zero drift**; final full-battery run green (below).
3. **Sabotage verification both directions** (acceptance: comparison must fail on a fixed-segment character change): `chat/bot-vs-subagent.md` +one word → regenerate → baseline RED at byte 3696 of `chat-owner-minimal` → restored → green + regeneration no-op; `policy/turn-policy-owner-opening.md` changed → `mvn package` → baseline RED at byte 2259 → restored + rebuilt → green.
4. AG-06 independence preserved: the trust-rules byte-identity suite (`agentscope-untrusted-content.integration.test.ts`) keeps its own literal expectation — extraction did not make tests and production self-proving.

## Packaging / loading verification

- `unzip -l agent-runtime-0.1.0.jar`: **71** `prompts/**.md` resources inside the shaded jar; 0 `platform-instructions.md` after `mvn clean package`.
- Java from packaged jar outside any repo: jar copied to `/tmp`, started with cwd `/` → health OK; all capture suites run the jar from a directory that contains no `prompts/` on disk, proving classpath-only loading.
- TS from non-repo cwd: `tsx` check script executed with cwd `/private/tmp` importing the generated module by absolute path → 71 segments load, render works.
- App image (`infra/compose/Dockerfile`) needs no change: it copies the whole repo tree and runs `tsx` from it, so `prompts/` and the generated constants ship as-is. Runtime image Dockerfile updated (COPY prompts/ + `-Dprompts.source.dir`); **local Docker builds are impossible on this host (Docker Hub blocked)** — the `agent-runtime-image` CI job builds the updated Dockerfile on the PR as the image-build evidence; recorded as an environment limitation, not skipped silently.
- Maven `mvn -B -f services/agent-runtime/pom.xml package` (JDK 21, full tests): green — `Copying 71 resources from ../../prompts`, all Java suites pass (DelegationSuspension 3, InterruptibleTaskRepository 3, CompactionBoundary 7, ToolResultEviction 4, MemoryCompactionPurge 10, UntrustedContentBoundary 2, PromptComposer 13, RunRequestPolicy 18, RuntimeIntegration etc.).

## Commands and results (local, 2026-10-19)

| Command | Result |
| --- | --- |
| `pnpm vitest run` — baseline + AG-03 three layers + judge + AG-01/02/06/07 baselines + executor/compaction/auto-review/group-router/messaging/judge-unit/approval-replay (16 files) | **283 passed / 0 failed** |
| PG suite `scenario-contract.postgres.test.ts` (colima PG, jar :8097, rebuilt) | **9 passed** (5.5s) |
| `tsc --noEmit` core/adapters/api/testkit | clean |
| `mvn -B package` (full Java tests) | green, 71 resources packaged |
| `node scripts/generate-prompt-texts.mjs && git diff --exit-code …generated.ts` | no-op |
| Sabotage TS / Java segment → baseline | RED at byte 3696 / RED at byte 2259 → restored GREEN |

## Acceptance mapping

1. P01–P14 file/renderer/call-point index → prompts/README.md + registry `PROMPT_FAMILY_SEGMENTS`. 2. Fixed bodies out of executor/PromptComposer → rewired caller list above. 3. Byte-identical final requests → baseline zero drift + sabotage red/green. 4. Approval resume / support-owner-handoff / channel privacy / silent reply / aux zero-tools / helper suspension unchanged → AG-03 suites green post-move (they pin each behavior). 5. Hostile dynamic values inert → `renderPromptSegment` unit + Java `Matcher.quoteReplacement` single pass. 6. AG-07 provenance + ME-00 purge → provenance integration + MemoryCompactionPurgeIntegrationTest green. 7. Any-cwd loading + real artifacts → verification section above. 8. Git diff readable; no frontend/version table/online config. 9. Zero-body-change final comparison; no wording changes mixed in (the only content-adjacent notes: the P05 catalog text's legacy "Pi runtime" mention stays verbatim — wording review is a separate decision, not a move).

## Remaining items

- After AG-03 (PR #74) merges: retarget this PR to `main` and confirm the diff is AG-04-only.
- Runtime image build evidence comes from the CI `agent-runtime-image` job on this PR (local Docker Hub blocked).
- AG-03 findings A/B (revoked-replay run failure + session poisoning) were open product decisions at AG-04 merge; AG-08 closes them without changing AG-04 prompt files.
- Real-model quality: **not evaluated** (unchanged from AG-03; offline contract evidence only).

## Merge closure (2026-10-19)

PR #75 merged normally as `b3ae7dc`; integrated main `b3ae7dc` passed all nine selected CI checks. AG-03 review fixes capture the actual hang-up prompt and constrain the reaction exception to its one read-path filter. AG-04 retained the selective CI graph and final-request baseline. Runtime-import loading of the app-owned prompt respects the adapters TypeScript compilation root. No deployment.
