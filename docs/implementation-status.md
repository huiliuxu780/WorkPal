# AgentScope migration status

This document distinguishes code paths, protocol tests, and live external verification. A saved setting or a rendered control is not counted as an implemented execution feature.

## Reuse map

Directly copied from Palpal, without a visual redesign:

- `apps/web`: login, navigation, bot list, durable chat, composer, settings, routines, Skills, MCP, artifacts, computer and activity views.
- `packages/ui-web`, `packages/ui-tokens`, `packages/chat-ui`: components, design tokens and event rendering.
- `packages/contracts`: the browser/API/event contract.

Reused from the Rakazo application backend:

- Better Auth users and sessions; user/space resource ownership.
- Bot configuration and one durable visible thread per bot.
- PostgreSQL messages, pagination, Tasks, Runs, Attempts and execution leases.
- Streaming events, cancellation, retries, approval continuation and steering messages.
- Files/artifacts, bot workspaces, browser/computer, terminal/shell and sandbox implementations.
- MCP discovery, assignment, OAuth, authorization and invocation.
- Routine scheduling/triggering and long-term memory providers.

New AgentScope boundary:

- `services/agentscope`: Python 3.11+ / AgentScope 2.0.9 execution service.
- `packages/adapters/src/agentscope-runtime.ts`: the only production `AgentRuntime`; there is no Pi fallback.
- A per-run authenticated callback bridge from AgentScope to the existing TypeScript tool executor.

## Implemented execution behavior

### Models and multimodal input

- API-key connections for OpenAI, OpenRouter, Anthropic, Gemini, xAI, DeepSeek, MiniMax, Moonshot, local/custom OpenAI-compatible endpoints and Alibaba Cloud Model Studio.
- Alibaba catalog entries are `qwen3.8-flash` and `qwen3.8-max`.
- Images from the current message and recent history cross the TypeScript/Python boundary as base64 multimodal blocks. Unsupported vision configurations continue to show the existing attachment warning rather than silently dropping the file.
- Subscription-model OAuth is explicitly unavailable in the model UI and rejected by the API/runtime. MCP OAuth remains supported because MCP credentials stay in the TypeScript connector layer.

### Tools, files, MCP and sandbox

- Tool name, JSON arguments and the provider's original call ID are preserved through AgentScope external execution.
- The bridge binds the callback to immutable backend `userId`, `spaceId`, `botId`, `threadId` and `runId`. Model arguments cannot select an identity, connector route or broader tool set.
- The TypeScript executor remains authoritative for allow-lists, action approval, connector assignment, resource ownership, timeouts, cancellation, effect idempotency and audit events.
- Existing file/artifact, browser, computer, shell/terminal and sandbox tools run through that executor. Text and PNG/JPEG results return to the model; file/artifact events and download references continue through the existing Web event contract.
- Approved MCP tools are discovered by the existing connector layer and exposed as ordinary AgentScope external tools. Discovery/invocation, MCP OAuth and approval are not reimplemented in Python.
- Tool called/progress/completed events are retained; approval or protected-input pauses terminate the current Python attempt without saving a half-completed AgentScope state.

### Skills and temporary subagents

- User/built-in/plugin Skill records are scoped in TypeScript and registered as AgentScope `Skill` objects. AgentScope's built-in Skill viewer reads full `SKILL.md` content only when needed.
- Explicit `@Skill` and `/Skill` invocation keeps the existing deterministic prompt expansion. Skill scripts use the same approved shell/file tools and sandbox, not arbitrary Python host execution.
- `run_subagent` starts a separate temporary AgentScope `Agent` inside the parent run. It has no durable chat, cannot recursively delegate, inherits only the parent's approved non-delegation tools, and may use another connected API-key model after backend-scoped resolution.
- Subagent progress, completion and failure use the existing `thread.subagent`/message-block UI path.

### State, memory and control flow

- PostgreSQL remains the complete, user-visible transcript. AgentScope snapshots only model-working state under `AGENTSCOPE_STATE_DIR`.
- Snapshot keys include user, space, bot and thread. Writes are atomic and revision-checked, so an older completion cannot overwrite newer state.
- Restore keeps durable AgentScope context/summary but rebuilds execution-local permission/tool/model configuration every run. Old state cannot restore obsolete credentials or permissions.
- AgentScope context compression is enabled. Application-compacted history and recalled memory are tagged and reconciled so they are not repeatedly injected into a restored snapshot.
- Existing memory providers still recall before a run and persist/update through backend-owned memory tools and completion hooks.
- Stop aborts the Python run and the backend tool signal. Same-thread concurrency is enforced by both the application lease and the Python service.
- Supplemental messages are claimed at run start and after tool-safe boundaries. Approval/protected-input continuation starts a fresh attempt from authoritative transcript/effect records; it does not replay a completed side effect.
- Scheduled routines use the same worker executor and AgentScope runtime as Web chat. A routine is a Run trigger, not a new user chat.
- On service restart, completed snapshots resume the next turn. An interrupted attempt is recovered by the existing lease/retry policy; non-idempotent effects are reconciled through `ExternalEffect` records rather than unconditionally replayed.

## Web binding

The copied UI is connected to the new runtime through its existing stable API/event layer:

- streaming messages, tool activity, Run status and errors;
- attachments, generated artifacts and downloads;
- Skills, MCP assignment/OAuth and model settings;
- stop, supplemental instructions, approval/protected input and takeover;
- routine runs and temporary subagent cards.

Unsupported model providers and subscription OAuth controls are disabled with a reason. They are not shown as successful configuration.

Frontend edit map:

- Navigation/bot list: `apps/web/src/pages/Shell.tsx` and `apps/web/src/pages/shell/`.
- Chat/composer/event cards: `apps/web/src/pages/Shell.tsx`, `apps/web/src/pages/shell/message-cards.tsx`, `apps/web/src/components/ai/`.
- Login: `apps/web/src/pages/Auth.tsx`.
- Model/MCP/settings: focused `*Settings*` pages and `McpServersOverlay.tsx`.
- API boundary: `apps/web/src/lib/rpc.ts`.
- Global styles/tokens: `apps/web/src/styles.css`, `packages/ui-tokens/src/`.

## Verification status

Verified in 22 Python tests with real AgentScope 2.0.9 and a local OpenAI-compatible protocol server (the model response itself is deterministic): all advertised API-key model constructors, model/tool/model loop, exact external call IDs, multimodal tool results, Skill on-demand reading, temporary AgentScope subagent, steering, approval pause, state restart, stale-write rejection and tenant isolation.

Verified in the TypeScript application suites: 2,426 adapter tests, 472 API tests and 394 Web tests passed. They cover callback authentication/trusted identity, MCP routing and approval, routine scheduling, file/artifact persistence, memory tools, approval replay/idempotency, and frontend/API event contracts. Full repository type checking and the Web production build also passed.

The AgentScope, API, worker and Web Compose images were built from this checkout in the fixed, independent `workpal` Compose project. PostgreSQL and AgentScope health checks passed, `/internal/health` on the verification port (`127.0.0.1:13100`) reported `runtime: agentscope`, the Web sign-in route returned 200 on `127.0.0.1:15173`, and the worker connected to the queue with the AgentScope composition root. The port overrides were used only because the untouched Palpal stack owns the default 3100/5173 ports.

Not claimed as externally verified:

- A paid Alibaba request is not recorded as passed. The key supplied in chat was deliberately not copied into shell commands, repository files or test logs, and the pre-existing encrypted local credential cannot be decrypted with the disposable verification `.env` encryption key. Enter the key through the product's encrypted model-connection UI after setting the intended persistent `ENCRYPTION_KEY`, then run a Web chat to close this external verification item.
- Third-party MCP servers, OAuth issuers and remote sandbox vendors require their own reachable endpoint/account. Local protocol and authorization paths are covered, but vendor availability is external.
- The monorepo-wide `pnpm test` is not recorded as green: 4,764 tests pass and 182 skip, while one copied test expects an omitted `.github/workflows/publish-playwright-report.yml`, one Compose firewall smoke is unavailable on this macOS host, and one Linux desktop cleanup assertion is host-specific. The migration-owned adapter/API/Web/Python suites above are green.

## Deliberate differences from Rakazo

- AgentScope is the sole business-agent implementation; Pi session/runtime code remains only as inherited compatibility/test code and is not selected by production composition roots.
- Model subscription OAuth is disabled because those credentials use provider-specific session protocols that AgentScope 2.0.9 does not implement. There is no token-to-API-key substitution.
- MCP stays in the application backend instead of being opened independently by Python. This preserves connector OAuth, assignments, SSRF policy, approvals and user/space isolation.
- Skill scripts execute through backend-approved sandbox tools. AgentScope receives Skill instructions but no unrestricted host filesystem authority.
- Temporary subagents are AgentScope agents within one parent Run, not durable Bots/Threads.
