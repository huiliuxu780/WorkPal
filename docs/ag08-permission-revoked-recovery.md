# AG-08 delivery note: revoked pending-tool recovery

Branch `codex/ag05-tool-visibility-recovery`, worktree `WorkPal-ag05`, continuous after the AG-05 commit group (`56b8d0c`, `89b95a4`). Shared PR with AG-05. Task card: [AG-08](./tasks/AG-08.md). AgentScope 2.0.3 remains the only production executor. Native helper delegation stays production-suspended. Not deployed.

This slice closes AG-03 findings A/B. It does not add an executor, change session generation, delete PostgreSQL history, or wipe the AgentScope working context.

**真实模型抗注入质量未评估** — captures use the local OpenAI-compatible protocol fixture plus the Composio emulator. They prove construction, typed refusal, effect/Run lifecycle, provider-side-effect absence, and a usable next Run.

## Frozen outcomes (this card)

For “user approved → permission revoked → pending tool call not yet sent to the provider”:

| Record | Result |
| --- | --- |
| Original external effect | `denied`, `result = { executed: false, reason: permission_revoked, source: policy }` |
| Original approval audit | `approval.resolved` stays `{ decision: "approved" }` — policy refusal is not a user deny |
| Current Run | `failed` / `error = permission_revoked` after a user-visible explanation |
| Next ordinary Run | same Thread, same generation, reaches the model, `completed`, does not replay the refused call |
| Re-authorization | a new Run under current permissions executes the new attempt exactly once; the old denied effect is unchanged |

Already-sent unknown outcomes stay on the existing uncertain path. This table applies only to the not-yet-sent pending call.

## Unique authority

Visibility (AG-05 `liveTools` / `ModelCallInput.tools`) is not execution. Execution authority is WorkPal:

1. `ToolBridgeClient.execute` always POSTs the authenticated bridge, including names that have left the live allow-list.
2. Adapter `/v1/tool-executions` re-reads `currentTools` on every foreground POST before lookup, then for a missing live tool still calls `executeTool` so `applyTool` can settle, then always returns HTTP 200 `{ status: "error", code: "permission_revoked", executed: false }`. A successful `executeTool` return for a missing tool is ignored.
3. `applyTool` refuses a connector name missing from live `connectorTools` **before** replay path/resource validation. Bound installed/MCP/Pipedream approvals have a `resourceId`; without a live route, `approvalReplayResourceError` would otherwise report a different-resource mismatch and leave the effect `approved`. Matching FIFO entries are taken, then `denyRevokedPermissionEffects` writes `approved`/`intended` rows for that run+kind to `denied` with the typed result. It does not emit a forged `approval.resolved=denied`. Wrong-tool-first still returns replay-order.
4. Java `resultBlock` maps `status: "error"` to `ToolResultState.ERROR` paired with the original `tool_call_id`, so `pendingToolCalls` is empty for the next Run on the same session.
5. When that denial settled at least one effect, Java `done` still carries the model explanation; the executor finalizes `failed` / `permission_revoked` **and** persists those explanation blocks.

## Evidence

### Before (AG-03 pin)

`S09-C3` on AG-03/AG-05: resume threw `IllegalArgumentException: Tool is not allowed for this run` in `ToolBridgeClient.execute` before any bridge POST. The Run failed, the effect stayed `approved`, the model never saw a tool result, and the next same-thread Run re-entered `resumeTools` with the dangling `ToolUseBlock` and failed with zero model HTTP.

Red reproduction on this head, before the implementation: `PermissionRevokedResumeIntegrationTest` failed at `ToolBridgeClient.execute:65` ← `RuntimeEngine.resumeTools:763`.

### After — Java session (real jar, protocol fixture)

`PermissionRevokedResumeIntegrationTest`: pause `flip_tool` → resume with `keep_tool` only → next Run on the same bot/thread/generation.

| Probe | Result |
| --- | --- |
| Resume terminal event | `done` (pending call consumed; Java does not throw) |
| Second model request | tool result contains `permission_revoked` / `not allowed`; `flip_tool` absent from `tools` |
| Bridge POSTs | 2 (`flip_tool` paused, then `flip_tool` refused). Third Run keeps that count |
| Next Run | additional model HTTP, `done`, no `flip_tool` replay |

### After — production chain (PostgreSQL + jar + Composio emulator)

`S09-C3 permission change before resume` (colima PG `127.0.0.1:5433` database `workpal_ag05_scenario`, jar on `:8097`):

| Probe | Result |
| --- | --- |
| Provider | `composio.executions` empty through revoke, resume, two follow-up sends |
| Effect | same id, `denied`, `{ executed: false, reason: permission_revoked }` |
| Approval | one `approval.resolved` with `decision: "approved"` |
| Run | `failed`, `error = permission_revoked`, `taskId` kept |
| Explanation | last bot message on that Run matches `/revoked\|not executed/i` |
| Next two ordinary Runs | different `runId`, same `threadId`, `completed`, Gmail absent, no replay |
| Re-auth | new connection + new send + new approval executes **once**; old effect stays denied; new effect `completed` |

## Verification log (local, 2026-10-19, macOS arm64, JDK 21 Homebrew, pnpm 9)

| Command | Result |
| --- | --- |
| `mvn -B -f services/agent-runtime/pom.xml package` | **BUILD SUCCESS**, Tests run: **88**, Failures: 0 (includes `PermissionRevokedResumeIntegrationTest` 1/1 and `ToolVisibilityRefreshIntegrationTest` 4/4) |
| `pnpm --filter @rakazo/adapters/@rakazo/db/@rakazo/testkit check` | clean |
| `pnpm test:ci-select` | **49 passed / 0 failed** |
| Adapter/db unit: `agentscope-runtime`, `approval-effect`, `executor`, `executor-approval-replay`, `executor-effect-idempotency`, `events` | **158 + 57** passed |
| PR #78 P1 unit | `agentscope-runtime.test.ts` 21/21, `executor-readonly-approval.test.ts` 41/41, `pnpm --filter @rakazo/adapters check` clean | Foreground execute re-reads live tools without a second surface fetch (stale alpha 200 error, live beta 200 ok). Approved bound `resourceId` tool whose connector left `connectorTools` is `denied` / `permission_revoked`, not different-resource; Run finalizes `failed`. |
| CI agentscope unit vitest line | **77 passed / 0 failed** (4 files) |
| CI agentscope integration vitest line (JDK 21) | **53 passed / 0 failed** (9 files), including tool-visibility 3/3, scenario-contract integration 20/20, prompt-files baseline 1/1, aux/untrusted/provenance/judge |
| `VERIFY_DATABASE=1` scenario-contract postgres (colima PG 5433, jar `:8097`) | **10 passed / 0 failed** (9.2s), including converted S09-C3 with re-auth |

Local `pnpm test:integration --spec=scenario-contract.postgres.test.ts` still cannot start Testcontainers against colima's non-default docker socket. CI's `agentscope` job runs that harness on Ubuntu Docker; the numbers above are the same suite against real PostgreSQL + the packaged jar.

## Intentional differences vs AG-03 / AG-05

- AG-03 pinned findings A/B as current behavior. This card replaces those pins with the frozen table; the old throw is gone.
- AG-05 visibility is unchanged: revoked tools leave `ModelCallInput.tools`. Execution now POSTs the missing name so WorkPal can settle. The AG-05 stale-alpha unit assertion moved from HTTP 403 to HTTP 200 `{ status: "error", executed: false }`. A mock `executeTool` success for a missing tool is not treated as execution.
- AG-04 prompt files and golden final-request bytes are unchanged.
- Helper stays production-suspended. Auxiliary scopes stay empty.

## Remaining / boundaries

- Already-sent unknown provider outcomes stay on the existing uncertain/manual-confirm path (MR-01 owns retry identity).
- MR-01 intersection: executor `applyTool` / live allow-list only. The MR-01 worktree was not operated.
- Real-model quality/injection resistance: **未评估**.
- Not deployed.
