# WorkPal

WorkPal is a Web-only persistent-agent platform built from the existing Palpal frontend and the reusable application backend in [Rakazo](https://github.com/elie222/rakazo). The application backend remains responsible for identity, authorization, bots, one durable thread per bot, messages, runs, concurrency, files, and event fan-out. Python [AgentScope](https://github.com/agentscope-ai/agentscope) is the only production agent executor.

The repository keeps Rakazo's Apache-2.0 license and internal `@rakazo/*` package names to minimize frontend churn and preserve an auditable upstream relationship.

## Current runnable slice

- Existing React/Vite frontend, including login, bot list, bot creation, chat, settings, and shared UI packages.
- Better Auth, PostgreSQL/Prisma persistence, durable bot threads, paginated messages, Task/Run records, streaming events, cancellation, and same-thread execution leases.
- A TypeScript `AgentRuntime` adapter that sends one run to the trusted Python service over NDJSON.
- AgentScope 2.0.9 model execution, streaming text and usage, context compression, atomic state snapshots, restart recovery, and a backend-approved `runtime_current_time` tool.
- OpenAI, OpenRouter, local, and custom OpenAI-compatible API-key connections. Unsupported provider/OAuth/image paths fail explicitly; they do not fall back to Pi or simulate success.

See [implementation status](docs/implementation-status.md) for the exact reuse map and disabled follow-up work.

## Local development

Prerequisites: Node.js 24 (or a version accepted by `package.json`), pnpm 9, Python 3.11+, [uv](https://docs.astral.sh/uv/), Docker Engine, and Docker Compose.

```bash
cp .env.example .env
# Fill POSTGRES_PASSWORD, DATABASE_URL, BETTER_AUTH_SECRET,
# ENCRYPTION_KEY, SANDBOX_SUPERVISOR_TOKEN, and SCREEN_PROXY_SECRET.

pnpm install
uv sync --project services/agentscope

docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d

pnpm db:migrate
pnpm dev
```

Open <http://127.0.0.1:5173>. `pnpm dev` starts the Web/API/worker stack and the AgentScope service at `127.0.0.1:8090`.

For the smallest first chat, set `SANDBOX_PROVIDER=none`, create an account, connect an OpenAI-compatible API-key model in Settings, create a bot, and send a message. Ask the bot to use its clock tool to exercise the full model → AgentScope → tool → stream → persisted-message path.

## Full Compose stack

After configuring `.env`:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up --build
```

The Compose network runs `web`, `api`, `worker`, PostgreSQL, the sandbox supervisor, and a separate `agentscope` service. Agent model credentials are brokered by the application backend and may only be sent to loopback or the private Compose service name.

## Verification

```bash
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web build
pnpm --filter @rakazo/adapters check
pnpm --filter @rakazo/api check
pnpm --filter @rakazo/worker check
pnpm exec vitest run packages/adapters/src/agentscope-runtime.test.ts apps/api/src/env.test.ts
pnpm test:agentscope
```

The Python test uses a local OpenAI-compatible model emulator while running the real AgentScope agent/tool/state loop. It proves protocol behavior without claiming a paid external model call.
