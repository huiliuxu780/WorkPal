# prompts/ — fixed prompt segment tree (AG-04)

The **single editing surface** for WorkPal's fixed prompt text. One Markdown file per segment; the segment ID is its path without `.md` (e.g. `policy/turn-policy-owner-opening`). Families P01–P14 map to the [prompt inventory](../docs/agent-prompt-inventory.md); scenarios and per-case segment usage live in the [case registry](../packages/adapters/src/__fixtures__/scenarios/case-registry.ts) (`PROMPT_FAMILY_SEGMENTS`) and the [scenario matrix](../docs/agent-scenario-matrix.md).

## Text contract

- A segment's value is the file content **minus exactly one trailing newline**; every other byte is verbatim. Files must end with exactly one `\n` and no trailing blank line (the generator enforces this; LF only).
- Placeholders are `{{key}}` tokens, filled by typed callers in a **single pass** (`renderPromptSegment` in TS, `PromptTexts.render` in Java). Inserted dynamic values are never re-scanned: a value containing `{{...}}`, `${...}`, quotes, newlines or XML stays inert data. No template language, conditionals or nesting exists by design.
- **Loading**: TS inlines this tree at build time into `packages/core/src/prompt-texts.generated.ts` via `node scripts/generate-prompt-texts.mjs` (committed; CI fails when regeneration is not a no-op — the generated file is never a second editing entry). Java loads the same files as classpath resources packaged by Maven (`prompts.source.dir` in `services/agent-runtime/pom.xml`; the runtime Dockerfile copies this tree into the image build). Neither runtime reads a developer checkout or depends on cwd.
- **Zero-diff guarantee**: every change here must keep the final model requests byte-identical unless the change is the point. The pre-move golden baseline (`packages/testkit/src/__fixtures__/prompt-baseline/`, 25 shapes) runs in CI; an intentional wording change requires regenerating the baseline **in the same PR with the diff reviewed**, and the AG-06 trust-rules bytes additionally stay pinned by their own independent literal test.

## Changing a prompt: workflow

1. Find the segment: table below (family → files → caller), or grep this tree, or start from a scenario row in the matrix and its registry case (`PROMPT_FAMILY_SEGMENTS` maps families to IDs).
2. Edit the `.md` file. Run `node scripts/generate-prompt-texts.mjs` (TS callers) — Java picks files up at `mvn package`.
3. See the change as a Git diff of this tree; run the baseline suite — an intentional change shows up as exactly your edit inside the affected goldens; anything else is a regression.
4. Affected-scenario review: the registry lists which cases include/exclude each family; run `packages/adapters/src/scenario-contract.test.ts` and `.integration.test.ts`.

## Index

| Area / family | Files (segment IDs) | Caller(s) | Condition |
| --- | --- | --- | --- |
| **platform/** — P01 (+AG-06) | `platform/platform`; `platform/content-trust-rules` | Java `PromptComposer.compose` | Every run; trust rules byte-fixed (AG-06) |
| **policy/** — P02 | `turn-policy-auxiliary`; `turn-policy-owner-opening`; `turn-policy-support-opening`; `turn-policy-noninteractive`; `turn-policy-planning-auto`; `turn-policy-planning-disabled`; `turn-policy-delegation-suspended`; `turn-policy-delegation-disabled` | Java `PromptComposer.turnPolicySection` | aux scopes → auxiliary; chat → owner/support opening + noninteractive (unattended) + planning + delegation variant |
| **collaboration/** — P02 | `owner`; `owner-resumption`; `support` ({{from}}); `support-resumption`; `handoff-owner` ({{from}}); `handoff-owner-resumption-append` | Java `PromptComposer.collaborationContextSection` | chat only; role × receivingOutcome from typed lineage |
| **chat/** — P01/P03/P04 | `bot-intro`; `hang-up`; `voice-call`; `progress-long-work`; `routine-silent-reply` ({{noResponse}}); `delivery-reply`; `task-catalog`; `plan-instruction`; `step-instruction`; `operating-browser-page`; `operating-core`; `operating-mail`; `bot-vs-subagent`; `create-space`; `spawn-bot`; `update-bot`; `run-subagent-suspended`; `archive-bot`; `render-plot`; `add-mcp-server`; `never-print-secrets`; `untrusted-content-closing` | `apps/api/src/router.ts` (intro/hang-up task text); `packages/adapters/src/executor.ts` (`userTurnInstructions`, guidance, plan/step) | per-trigger and per-capability conditionals stay in the typed callers |
| **skills/** — P05 | `catalog-header`; `catalog-footer`; `taught-skills-trailer`; `plugin-line-prefer`; `plugin-line-none` | `packages/core/src/agent-skill.ts`; executor skill/plugin lines | only when skills/plugins/taught skills exist; rosters stay dynamic |
| **context/** — P06/P07 | `historical-context-bridge`; `durable-memory-preamble`; `recalled-memory-preamble`; `compacted-summary-header` ({{product}},{{seq}}); `compacted-previous-header` ({{product}}); `compacted-new-messages-label` | executor history assembly; `memory-context.ts`; `history-compaction.ts` | fences/tags stay in code; injection carries typed provenance (AG-07) |
| **approval/** — P04 | `continuation-intro` ({{product}}); `continuation-rules` | executor `buildApprovalContinuation` | only with approved effects awaiting replay |
| **retry/** — P04 | `manual-retry-context` ({{originalTask}}, {{operationSection}}) | `renderManualRetryPrompt` in `packages/core/src/manual-retry-prompt.ts`, wrapped onto the retry Run's `AgentRunRequest.prompt` | only when `Run.retryOfRunId` is set. `Task.prompt` stays the original user task. Listed `retryOperationId` values are backend-assigned; the executor strips the reserved arg before persist/send |
| **auxiliary/** — P07–P09/P13 | `history-compaction`; `auto-review`; `auto-review-prompt`; `group-router`; `group-router-prompt`; `group-router-lead` ({{leadBotId}}); `group-router-no-lead`; `group-router-output`; `team-chat-judge` | `history-compaction.ts`; `auto-review.ts`; `group-routing.ts` + `group-router.ts`; `apps/api/src/team-chat-judge.ts` | one dedicated execution scope each; zero tools/history enforced by Java |
| **messaging/** — P12 | `dm-surface-note`; `channel-privacy` | `packages/core/src/messaging-prompts.ts` via executor | messaging identity / channel run |
| **delivery/** — P10 | `delivery-instructions`; `hidden-completed` ({{count}}); `hidden-failed` ({{count}}) | `result-delivery.ts` `buildDeliveryPrompt` | delivery Runs only |
| **feedback/** — P14 | `replay-different-resource` ({{tool}}); `replay-direct-required` ({{tool}}); `replay-order` ({{nextTool}},{{tool}}); `replay-missing-args` ({{tool}}) | `approval-effect.ts`; executor replay guards | approval-replay refusals |
| **helper/** — P11 | `helper-declaration`; `helper-inline-agents` | Java `RuntimeEngine` subagent declaration | **production-suspended (AG-02)** — reachable only through the in-JVM test seam |

## What deliberately does NOT live here

- **Dynamic content**: task/prompt bodies, bot names/instructions, current time (`formatCurrentTimeInstruction`), tool/skill/connector rosters, conversation history, memory document bodies, delivery result details. They come from their typed sources at call time and are inserted whole.
- **Structural wrappers**: XML-style tags (`<platform>`, `<turn-policy>`, `<durable_memory>` …), JSON schema labels, small connective labels (`Completed:`, `Name:`) — assembly stays in `PromptComposer`/callers so structure remains typed code.
- **Business fields**: tool names/descriptions/schemas come from `builtin-tools.ts` and connector discovery; prompt text must not be edited to change a tool contract.
- **Third-party internal text**: the AgentScope library appends its own context sections (AgentStateStore/Workspace/Available Skills blocks) to the system message at runtime. That wording belongs to the library and is **not** copied into this repo; the baseline suite masks only its machine/time-dependent lines (enumerated in the suite header).
- **Small error strings** outside the approval-replay family stay in code (not 成片 fixed guidance); they are documented in the inventory's P14 row.
