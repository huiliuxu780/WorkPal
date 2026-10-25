# WorkPal

WorkPal is a Web-only persistent-agent platform built from the existing Palpal frontend and the reusable Rakazo application backend. [AgentScope Java Harness](https://github.com/agentscope-ai/agentscope-java) is the production agent runtime; identity, bots, durable threads, Runs, files, permissions, approvals, queues and browser event contracts remain in the application backend.

The source keeps Rakazo's Apache-2.0 license and internal `@rakazo/*` package names to minimize frontend churn and preserve an auditable upstream relationship. See [AgentScope migration status](docs/implementation-status.md) for the capability and verification matrix.

## Local development

Requirements: Node.js 24, pnpm 9, JDK 21, Maven 3.9, Docker Engine and Docker Compose.

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, DATABASE_URL, BETTER_AUTH_SECRET,
# ENCRYPTION_KEY, SANDBOX_SUPERVISOR_TOKEN and SCREEN_PROXY_SECRET.

pnpm install
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d

pnpm db:migrate
pnpm dev
```

Open <http://127.0.0.1:5173>. `pnpm dev` builds and starts the Java AgentScope service at `127.0.0.1:8090` alongside Web, API, worker and sandbox supervisor.

In Settings → Models, connect an API-key model. For Alibaba Cloud Model Studio select `qwen3.8-flash` or `qwen3.8-max`; the key is encrypted by the existing backend secret store. Do not put model keys in source files. Subscription-model OAuth is intentionally unavailable; MCP OAuth is configured separately in MCP settings.

Set `SANDBOX_PROVIDER=none` only when computer/shell/file execution is not needed. Keep the default Docker provider for the complete Web → worker → AgentScope → sandbox/file → Web path.

## Full Compose stack

After configuring `.env`:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml up --build
```

Open <http://127.0.0.1:5173>. Compose runs PostgreSQL, Web, API, worker, sandbox supervisor and the Java AgentScope service. The runtime is private to the Compose network; per-run bearer callbacks return to separate API/worker bridge ports.

The Compose project name is fixed to `workpal`, so its containers and PostgreSQL volume cannot collide with Palpal/Rakazo checkouts whose Compose directory has the same basename. Set `API_HOST_PORT` and `WEB_HOST_PORT` in `.env` if the default host ports are already occupied, and update the three public URLs to match.

To stop without deleting PostgreSQL data:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml down
```

Do not add `-v` unless deleting the database is intended.

## Verification

Fast, hermetic gates (no PostgreSQL, Java runtime, Docker, browser, or provider credentials):

```bash
pnpm lint
pnpm test:unit
pnpm test:inventory
pnpm test:ci-select
```

`pnpm lint` runs `biome check .` (lint, formatting, and import sorting). Five
confirmed prototype paths and a precise temporary list of pre-existing
formatter/import-sort debt are excluded in `biome.json`; H3 owns closing those
exclusions. Run `pnpm format` only for intentional reformatting.

`pnpm test:unit` runs the Node and jsdom files selected by the tracked-test
inventory in `scripts/testing/test-inventory.mjs`. PostgreSQL, integration
harness, Java replay, Docker, live-provider, and process tests are not in this
group. A unit setup file also removes database, runtime, sandbox, and provider
credentials before the run.

`pnpm test:inventory` fails when a tracked `*.test.ts(x)` file has no
classification, when a rule points at a file that is no longer tracked, when a
rule's marker stopped matching, or when a multi-entry test has no reason for the
duplicate entry.

Database and service layers:

```bash
DATABASE_URL=postgresql://... VERIFY_DATABASE=1 pnpm test:postgres
pnpm test:integration --spec=packages/testkit/src/journeys.test.ts
pnpm test:e2e --runtime=scripted --spec="settings-shell.spec.ts"
pnpm test:worker-chain
pnpm test:agentscope
```

`pnpm test:postgres` runs every PostgreSQL-classified file; CI executes the same
command in the `db-postgres` job. `pnpm test:integration` needs Testcontainers
and JDK 21 and starts the Java AgentScope runtime. `pnpm test:e2e` needs the
Playwright Chromium install (`pnpm --filter @rakazo/web exec playwright install
chromium`); when no container runtime is available, `WORKPAL_E2E_DATABASE_URL`
may point at a disposable local `workpal_e2e_*` database. The CI jobs and their
exact suite lists are documented in [docs/agent-verification.md](./docs/agent-verification.md).

Full type/build checks:

```bash
pnpm check
pnpm --filter @rakazo/web build
docker compose --env-file .env -f infra/compose/docker-compose.yml config --quiet
```

The AgentScope tests run the real Java HarnessAgent, tool loop, state store, Skill loader, Plan Mode and subagent against a local OpenAI-compatible protocol server. The TypeScript consumer integration uses the same Java service. These fixtures do not verify a paid provider.
