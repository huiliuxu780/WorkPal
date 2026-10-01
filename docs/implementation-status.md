# Implementation status

## Directly copied from Palpal

- `apps/web`: all existing pages and components; no redesign was introduced.
- `packages/ui-web`, `packages/ui-tokens`, `packages/chat-ui`: component library, design tokens, chat rendering, and AI activity UI.
- `packages/contracts`: the existing oRPC and stream event contract used by the frontend.

Frontend edit map:

- Navigation and bot list: `apps/web/src/pages/Shell.tsx` and its sibling page components.
- Chat transcript and composer: `apps/web/src/pages/Shell.tsx` and `apps/web/src/components/ai/`.
- Login: `apps/web/src/pages/Auth.tsx`.
- Settings: `apps/web/src/pages/SettingsOverlay.tsx` plus the focused `*Settings*` overlays.
- API boundary: `apps/web/src/lib/rpc.ts`; backend compatibility work belongs here instead of being scattered across pages.
- Global Web styles: `apps/web/src/styles.css`; semantic product tokens: `packages/ui-tokens/src/`.

## Reused application backend

- Better Auth user/session handling.
- Bot configuration and one durable visible thread per bot.
- Message storage, history windows and compaction metadata.
- Task, Run, Attempt and execution-lease records.
- Streaming thread events, cancellation, retries and same-bot concurrency control.
- Artifact, file, secret and resource ownership checks.
- PostgreSQL/Prisma schema and Graphile worker execution.

This is intentionally not rewritten in Python. Replacing it would add migration risk without improving the AgentScope boundary.

## Newly implemented

- `services/agentscope`: a Python 3.11+ AgentScope 2.0.9 service.
- `packages/adapters/src/agentscope-runtime.ts`: the only production `AgentRuntime` selected by API and worker composition roots.
- NDJSON event translation for text, usage, tool lifecycle, completion and errors.
- Separate AgentScope state snapshots under `AGENTSCOPE_STATE_DIR`; the complete user-visible transcript remains in PostgreSQL.
- Atomic state replacement and restart restoration.
- Run cancellation and a second same-thread concurrency guard in the Python service.
- A real backend-approved, read-only clock tool used by the AgentScope reasoning/action loop.
- One-command local startup and a separate Compose service.

## Boundary and current limitations

The application backend validates and owns the request, credentials, permissions, tool catalog and durable business records. AgentScope receives only the selected model credential, compact model context, system instructions and approved tool schemas. It cannot add credentials or expand resource scope.

The first delivery slice deliberately registers only `runtime_current_time`. Generic backend tool callbacks, native AgentScope Skills loaders, MCP clients, computer/sandbox tools, attachments/images, OAuth subscription credentials, subagents and automatic routines are not implemented in the AgentScope adapter yet. Those paths fail or remain unavailable; there is no Pi fallback and no fake tool result.

The copied frontend still contains settings screens for some of those future capabilities. Treating configuration UI as equivalent to execution would be misleading, so production enablement should wait until each capability has an AgentScope adapter and an end-to-end verification test.

## Next delivery order

1. Run-scoped authenticated callback channel from AgentScope to the TypeScript tool executor.
2. File and sandbox tools with existing resource checks and tool-result rendering.
3. Native AgentScope Skills and MCP registration from backend-approved records.
4. Attachments and multimodal input.
5. Long-term memory provider integration beyond current durable thread state.
6. Scheduled tasks and subagents after the base callback, stop and recovery paths remain stable.
