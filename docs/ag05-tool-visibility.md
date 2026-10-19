# AG-05 delivery note: live tool visibility on every model call

Branch `codex/ag05-tool-visibility-recovery`, worktree `WorkPal-ag05`, base `main @ a39b25d` (PR #77 task-card merge). Status: **implementation complete on the shared AG-05/AG-08 branch** — not yet pushed; AG-08 continues on this head without an intermediate PR. Task card: [AG-05](./tasks/AG-05.md). AgentScope 2.0.3 remains the only production executor. Native helper delegation stays production-suspended. Not deployed.

Work ran in a dedicated git worktree because the primary checkout is occupied by the parallel MR-01 line. Nothing from MR-01's uncommitted work entered this branch. The only executor/tool-contract intersection is the live allow-list plus `currentTools` callback; MR-01 retry/schema/RPC/UI modules were not touched.

**真实模型抗注入质量未评估** — every capture below uses a local OpenAI-compatible protocol fixture. The tests prove construction, visibility, execution refusal, and side-effect absence. They do not measure a model's compliance under adversarial text.

## What was proven first (red capability)

Locked AgentScope 2.0.3 can refresh the **model-visible** tool set on every provider HTTP call inside one Run:

- `Toolkit.removeTool` / `registerAgentTool` mutate the live toolkit (`allowToolDeletion` defaults true).
- `MiddlewareBase.onModelCall` runs immediately before `model.stream()`. `ModelCallInput.tools()` is the list the OpenAI-compatible client actually sends.
- `Toolkit.getToolSchemas(Collection)` only filters **grouped** tools; ungrouped registered tools are always included. Production therefore filters `toolkit.getToolSchemas()` itself against the live allow-list.

A backend denial, or a refresh that only takes effect on the next Run / `sessionGeneration` change, does **not** satisfy this card.

## Contract

| Piece | Behavior |
| --- | --- |
| Refresh point | `ToolSurfaceRefresh` middleware, `order() = Integer.MAX_VALUE` (innermost around the model HTTP so later Harness middleware cannot restore a stale snapshot) |
| Backend → runtime | Sibling POST `/v1/tool-surface` `{ runId }` → `{ tools: [{ name, description, inputSchema, readOnly }] }`. Zero new `RunRequest` fields. URL derived from `/v1/tool-executions`. |
| Ownership | Per-Run `ActiveBridgeRun` + per-Run `currentTools`. Two Bots/Threads/users never share a live surface. |
| Visibility | `ModelCallInput.tools` = native policy-gated harness tools ∪ current backend allow-list. Name **and** schema come from the live surface. |
| Execution | Revoked `BackendSchemaTool`s stay registered so a hallucinated call reaches WorkPal's refusal instead of crashing inside AgentScope. `ToolBridgeClient.allows(name)` filters model-visible tools. Missing-name `/v1/tool-executions` calls still POST (AG-08) and return HTTP 200 `{ status: "error", executed: false }`. Executor `applyTool` refuses connector names missing from the refreshed `connectorTools` map. |
| Fail-closed | Malformed, missing, or HTTP-failed surface fetch keeps the previous allow-list. The adapter `currentTools` catch and executor `loadLiveRunTools` catch do the same. A transport blip cannot enlarge or shrink authorization. |
| Native tools | Plan / skill stay TurnPolicy-gated. Auxiliary scopes stay empty. `run_subagent` is never re-registered. Helper remains production-suspended. |
| Prompt | AG-04 files and the composed system message are **unchanged**. Live capability is the tool schema list on the final model request; AG-04 segments do not enumerate connector tool names. |

AG-08 owns pending-call consumption after a revoked-tool refusal, effect/`permission_revoked` lifecycle, and the next-Run session deadlock (AG-03 findings A/B). Delivery: [ag08-permission-revoked-recovery.md](./ag08-permission-revoked-recovery.md).

## Production changes

Java:

- `ToolSurfaceRefresh.java` (new) — per-call surface refresh, re-register live backend tools, keep revoked backend tools, filter `ModelCallInput.tools`.
- `ToolBridgeClient.java` — `liveTools` starts as the request snapshot; `refreshSurface()` POSTs the sibling URL; `allows()` uses the live set for visibility. `execute()` always POSTs; AG-08 converted the former allow-list throw into a typed tool-error result from WorkPal.
- `RuntimeEngine.java` — install the middleware before `enablePlanMode`.

TypeScript:

- `adapter-kit` `AgentRunRequest.currentTools?: () => Promise<ConnectorTool[]>`.
- `agentscope-runtime.ts` — `/v1/tool-surface` handler; register the bridge when `currentTools` is present even if the start-of-run `tools` array is empty.
- `executor.ts` — `loadLiveRunTools` re-reads connections, re-discovers connector tools, updates `context.connectedConnections` / `connectorTools`; `currentTools` is wired for non-scripted runs; `applyTool` refuses connector names missing from the live map.

CI:

- `agentscope` vitest line adds `agentscope-tool-visibility.integration.test.ts`.
- `JAVA_WORKER_FILES` includes `ToolSurfaceRefresh.java` so a later surface-only change still selects `worker-chain`.

## Evidence layers

| Layer | File | Proves |
| --- | --- | --- |
| Java + real jar + fixture | `ToolVisibilityRefreshIntegrationTest.java` (4) | Same-Run 3-call available→revoke→reauth with schema change; hallucinated revoked tool refused, provider HTTP=0; two concurrent runs isolated; 500 keep-previous fail-closed |
| TS adapter unit | `agentscope-runtime.test.ts` (+1) | `/v1/tool-surface` alpha→beta; stale alpha HTTP 200 `{ status: "error", executed: false }` (AG-08); live beta 200; two runs do not mix |
| TS adapter → jar → fixture | `agentscope-tool-visibility.integration.test.ts` (3) | Same-Run 3 rounds with `currentTools`; hallucinated revoke with zero `flip_tool` provider execution; `team-chat-judge` tools strictly `[]` |
| Production PG chain | `scenario-contract.postgres.test.ts` (+1) | Same Run, Gmail connected → revoke mid-run → restore; three captured model requests; keep-tool `runtime_current_time` still executes; zero Gmail provider executions |
| AG-03/AG-04 regression | scenario-contract unit + jar integration + prompt-files baseline + aux/untrusted/provenance/judge | Start-of-run tool sets, prompt bytes, auxiliary emptiness, helper suspension unchanged. Intentional difference vs AG-03: later model calls in the **same** Run now see the live surface. S09-C3 recovery is AG-08. |

Captured same-Run journey (Java and TS fixture, identical shape):

1. Model request 1 tools include `keep_tool` + `flip_tool` (v1 schema, no `mode`).
2. Surface drops `flip_tool`. Request 2 tools = `keep_tool` only.
3. Surface restores `flip_tool` with v2 schema (`mode`). Request 3 includes `flip_tool` and the new schema. The restored call executes once with `{ mode: "restored" }`.

Hallucinated `flip_tool` after revoke: next model request omits it; the bridge POST (AG-08) returns a typed error and is not a provider execution; the refusal is observable. No fake success.

## Verification log (local, 2026-10-19, macOS arm64, JDK 21 Homebrew 21.0.12.1, pnpm 9)

| Command | Result |
| --- | --- |
| `mvn -B -f services/agent-runtime/pom.xml package` | **BUILD SUCCESS**, Tests run: **87**, Failures: 0 (includes `ToolVisibilityRefreshIntegrationTest` 4/4). Total time 16.9s |
| `pnpm --filter @rakazo/adapter-kit/@rakazo/adapters/@rakazo/testkit check` | clean |
| `pnpm test:ci-select` | **49 passed / 0 failed** |
| `pnpm exec vitest run` — 11 files: `agentscope-runtime.test.ts`, `scenario-contract.test.ts`, plus the agentscope CI vitest line (consumers, turnpolicy-v2, aux, untrusted, provenance, tool-visibility, scenario-contract integration, prompt-files baseline, team-chat-judge) | **109 passed / 0 failed** (13.0s) |
| `VERIFY_DATABASE=1 … pnpm vitest run packages/testkit/src/scenario-contract.postgres.test.ts` (colima PG 5433 `workpal_ag05_scenario`, jar on :8097) | **10 passed / 0 failed** (8.7s), including the new AG-05 same-run Gmail revoke/restore journey and the still-pinned S09-C3 A/B findings |

Local `pnpm test:integration --spec=scenario-contract.postgres.test.ts` could not start Testcontainers (`Could not find a working container runtime strategy`: colima socket is `~/.colima/default/docker.sock`, not `/var/run/docker.sock`). CI's `agentscope` job runs that harness on Ubuntu Docker; the local evidence above is the same suite against real PostgreSQL + the packaged jar.

## Intentional differences vs AG-03 / AG-04

- AG-03 recorded per-Run assembly as fact. AG-05 changes the **second and later** model requests of a Run when the live surface changes. First-request frozen literals in the AG-03 registry stay the start-of-run contract.
- AG-04 golden final-request bytes are unchanged (no prompt-file edit). Capability announcement is the live `tools` array on the wire.
- S09-C3 findings A/B are closed by AG-08 ([ag08-permission-revoked-recovery.md](./ag08-permission-revoked-recovery.md)).

## Remaining / boundaries

- AG-08 on this same branch: consume the pending tool call, typed `permission_revoked` effect/Run outcomes, usable next Run, keep PostgreSQL history and the legitimate working context. See [ag08-permission-revoked-recovery.md](./ag08-permission-revoked-recovery.md).
- MR-01 intersection: executor `currentTools` / live allow-list only. Do not operate the MR-01 worktree.
- Helper re-enable remains hard-gated on an upstream AgentScope fix (AG-02).
- Real-model quality/injection resistance: **未评估**.
- Not deployed.
