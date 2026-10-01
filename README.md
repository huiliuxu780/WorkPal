# WorkPal

WorkPal is a Web-only persistent-agent platform built from the existing Palpal frontend and the reusable Rakazo application backend. Python [AgentScope](https://github.com/agentscope-ai/agentscope) is the only production agent executor; identity, bots, durable threads, Runs, files, permissions, approvals, queues and browser event contracts remain in the application backend.

The source keeps Rakazo's Apache-2.0 license and internal `@rakazo/*` package names to minimize frontend churn and preserve an auditable upstream relationship. See [AgentScope migration status](docs/implementation-status.md) for the capability and verification matrix.

## Local development

Requirements: Node.js 24, pnpm 9, Python 3.11+, [uv](https://docs.astral.sh/uv/), Docker Engine and Docker Compose.

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, DATABASE_URL, BETTER_AUTH_SECRET,
# ENCRYPTION_KEY, SANDBOX_SUPERVISOR_TOKEN and SCREEN_PROXY_SECRET.

pnpm install
uv sync --project services/agentscope

docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d

pnpm db:migrate
pnpm dev
```

Open <http://127.0.0.1:5173>. `pnpm dev` starts Web, API, worker, sandbox supervisor and the AgentScope service at `127.0.0.1:8090`.

In Settings → Models, connect an API-key model. For Alibaba Cloud Model Studio select `qwen3.8-flash` or `qwen3.8-max`; the key is encrypted by the existing backend secret store. Do not put model keys in source files. Subscription-model OAuth is intentionally unavailable; MCP OAuth is configured separately in MCP settings.

Set `SANDBOX_PROVIDER=none` only when computer/shell/file execution is not needed. Keep the default Docker provider for the complete Web → worker → AgentScope → sandbox/file → Web path.

## Full Compose stack

After configuring `.env`:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up --build
```

Open <http://127.0.0.1:5173>. Compose runs PostgreSQL, Web, API, worker, sandbox supervisor and AgentScope. The Python service is private to the Compose network; per-run bearer callbacks return to separate API/worker bridge ports.

To stop without deleting PostgreSQL data:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml down
```

Do not add `-v` unless deleting the database is intended.

## Verification

```bash
pnpm check
pnpm --filter @rakazo/web build
pnpm exec vitest run packages/adapters/src apps/api/src apps/web/src
pnpm test:agentscope
docker compose --env-file .env -f infra/compose/docker-compose.yml config --quiet
```

The AgentScope tests run the real AgentScope agent, tool loop, state store, Skill viewer and subagent against a local OpenAI-compatible protocol server. That proves the integration without representing a paid-provider response as a live vendor test.
