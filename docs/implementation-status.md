# AgentScope Java runtime status

**AgentScope Java Harness migration: COMPLETE**

WorkPal's production agent executor is `services/agent-runtime`, built on AgentScope Java HarnessAgent 2.0.3. The Node adapter in `packages/adapters/src/agentscope-runtime.ts` keeps the existing private HTTP/NDJSON boundary. The API and worker continue to own identity, product permissions, approvals, tools, durable conversations, Tasks, Runs, files and audit records. PostgreSQL remains the complete chat transcript; AgentScope's state store and workspace hold only model-working state.

## Implemented boundary

- `POST /v1/runs`, `DELETE /v1/runs/{runId}`, `DELETE /v1/background-tasks/{taskId}` and `GET /health` are implemented by the Java service. A run uses backend-supplied user, space, bot and thread identity; auxiliary review and history-compaction scopes get separate session keys.
- HarnessAgent owns model streaming, tool loop, context compaction, Skill loading, Plan Mode and native subagents. WorkPal tools use AgentScope external execution. Foreground tool calls use a per-run bearer; native background tasks register their own one-hour bearer bound to task, agent, child session, parent Run, user, space, bot, thread and read-only tool allow-list. Every background tool call checks the product task row, membership, bot, thread generation, connector status and existing executor permission/approval/idempotency path.
- Permission rules are replaced from the current backend tool list on every run, including session resume. Native `plan_exit` requests approval. Default Web, memory and session tools are filtered out of the model-visible catalog; memory writing hooks are disabled.
- The model configuration is supplied per run. API-key providers use native AgentScope adapters where available and official OpenAI-compatible endpoints elsewhere. Subscription OAuth is rejected by the runtime.
- Typed AgentScope events map to the existing WorkPal text, progress, tool, usage, ask, subagent and completion events. The adapter rejects incomplete or malformed streams.
- `pnpm dev` builds and starts Java with the Web stack. Source Compose builds the Java service. CI compiles and tests it with JDK 21.
- Native `WorkspaceTaskRepository` owns background execution, persistent task records, cancellation and pending deliveries. The WorkPal projection stores task identity, status, heartbeat and redacted result; terminal events and chat activity are persisted after the parent HTTP stream closes. The next main Run reads the native pending delivery and injects a `system-reminder`, then marks it delivered after successful reasoning. A new main Run can proceed while a child remains active. Cancellation interrupts the local supplier and rejects later backend tool calls.

## Verification

`pnpm test:agentscope` runs Java tests using a local OpenAI-compatible SSE fixture. These cover streaming, durable session resume, Tool Bridge callbacks, Skill loading and isolation, native Plan approval and resume, synchronous subagents, and background lifecycle cases A–D: parent completion before child tool call, a concurrent new main Run, next-turn delivery, and cancellation. `packages/adapters/src/agentscope-runtime.test.ts` checks task bearer scope and revocation. `packages/adapters/src/agentscope-consumers.integration.test.ts` exercises TypeScript approval and compaction consumers through HTTP and the Java service while a chat tool is active. `apps/web/e2e/agentscope-product.spec.ts` exercises Web → API → Worker → Java → model fixture → allowed Skill → backend file tool → Web, native Plan approval and resume, and synchronous subagent result return.

An authenticated local acceptance run used the configured DashScope `qwen3.8-flash` connection: ordinary chat, backend tool call, Skill loading, Plan approval and resume, and synchronous native subagent all succeeded. A separate paid-model Web → API → Worker → Java run verified chat and a `write_file` call whose file contents were read back. The key was read from the existing encrypted WorkPal credential and was not committed. During a temporary verifier's first attempt, legacy plaintext parsing echoed a test credential in local command error output; it did not enter the Git repository or CI logs.

Restart semantics: local model/tool operations in progress are not resumed by AgentScope 2.0.3. A Java instance change or sustained loss of health fails active WorkPal projections; a Worker loss is detected after two minutes without a task heartbeat. Native task records remain on disk for honest inspection and the next main turn. Task credentials expire after one hour; long-running children must fail rather than gain an indefinite bearer. Background `agent_send(timeout_seconds=0)` is rejected because its native response omits the child session needed for task-bound authorization. Third-party MCP, OAuth and remote sandbox vendors require their own reachable endpoints and credentials.

The migration branch is pushed as PR #2. GitHub Actions on the branch and PR passed TypeScript/Web checks, Java tests, integration and Web E2E tests, and Docker image build. The next phase is WorkPal Product Harness: Intent and complexity routing, automatic Plan, Drill, Agent routing, and group-chat speaking policy.

## Product Harness Phase 1 — Response Owner: COMPLETE

Every group user turn now resolves to exactly one response owner (or an
intentional multi when the user explicitly addresses several bots). Precedence
is deterministic: explicit mention > reply target > @everyone/separate-answer
wording > the Group Router (the single isolated model call, run only for an
otherwise unaddressed group turn, as a stateless `turn-routing` auxiliary
execution with no tools/skills/history and a fresh per-run session key) > the
group `leadBotId`. The implicit `members[0]` wake is removed from send and
follow-up paths; a group now stores `leadBotId`, which self-heals when it is no
longer an active member. Each routed Run carries an immutable
`orchestration` snapshot (routing, ownership, response mode) that retries reuse
verbatim; every resolved turn emits a `thread.turn.routed` thread event. No
`TurnDecision` table was added. This phase did not touch execution strategy or
UI. Follow-up turns that resolve to multiple owners collapse to a single
previous owner/lead and persist `responseMode: "single"` truthfully.

## Product Harness Phase 2 — Turn Policy: COMPLETE

Phase 2 adds the internal per-Run execution policy (`TurnPolicy`) that says how
the owning Agent may act this turn (interactive, planning, delegation,
background, ownership) without any user-facing mode selector. It is derived
deterministically from the Run trigger and its orchestration snapshot, stored
in the same `orchestration` JSON `execution` block, sent to the Java runtime on
`RunRequest.turnPolicy`, and enforced at the real runtime boundary: the native
plan/subagent tool surface is hidden per policy, the helper budget and
background permission are enforced in the spawn repository (a hard count and
throw, not a prompt), and helpers keep only read-only backend tools. Plan,
Subagent and Background remain AgentScope-owned; Phase 2 adds no new engine.

## Product Harness Phase 3 — Persistent Bot Collaboration: COMPLETE

Four concepts are now frozen and runtime-enforced: the Response Owner answers
the user; a Support Bot does delegated partial work and returns it;
`message_bot` delegates without moving ownership; `handoff_to_bot` transfers
stage ownership. Every collaboration Run persists an immutable
`orchestration.collaboration` lineage (`role`, `source`, `fromBotId`,
`parentRunId`, `handoffDepth`, `messageHop`); retries reuse it verbatim.

- Support runs carry the support TurnPolicy snapshot (planning disabled,
  background off) and the `<collaboration-context>` support identity derived
  from the snapshot — never guessed from prompts. Their results return to the
  requester automatically through the existing outcome-return path, and the
  outcome-return hop restores the REQUESTER's persisted role and execution
  policy: an owner resumes as owner, a nested support requester stays
  support (message_bot never moves ownership in either direction).
- Handoff runs record `source: handoff` with `handoffDepth + 1`, emit
  `thread.turn.handed_off`, and the originating run's final-answer suppression
  is unchanged. `MAX_HANDOFF_DEPTH = 2` is a hard product-layer tool error;
  bouncing a stage back to its sender is rejected unless the user posted a new
  instruction after the handoff.
- `thread.collaboration.requested` / `thread.collaboration.result` events give
  Phase 4 structured, chain-of-thought-free activity data.
- Anti-loop rules: a run woken by a result/status cannot ack its waker with
  fyi/status; identical message repeats within one run are refused; fyi may
  stay silent; `BOT_MESSAGE_MAX_HOPS = 6` remains the outer bound.
- Tool availability: support bots keep `message_bot` but never see
  `handoff_to_bot`; handoff stays group-only; helpers vs message_bot vs
  handoff selection rules live in the platform instructions.

Phase status: Phase 1 (who answers) COMPLETE, Phase 2 (how the owner may
execute) COMPLETE, Phase 3 (how persistent agents collaborate) COMPLETE.
Next: Phase 4 — Activity / UX projection of routing, planning, drill and
collaboration events.
