# Contributing to Rakazo

Thanks for helping improve Rakazo. Keep changes focused and testable.

## Run locally

Follow the [source checkout setup](README.md#local-development-source-checkout) for prerequisites,
required secrets, and startup commands.

## Checks before you open a PR

| Command | When to run |
| --- | --- |
| `pnpm test:unit` | Hermetic units selected by the tracked inventory (`vitest.unit.config.ts`). No PostgreSQL, JDK, Docker, or provider keys. Runs in the CI `harness` job. |
| `pnpm test:postgres` | Every inventory entry classified `postgres`, run serially. Needs a reachable PostgreSQL in `DATABASE_URL`; never point it at a production database. |
| `pnpm test:process` | Process-level inventory entries (standalone Worker and CLI chains), run serially. |
| `pnpm test:inventory` | Inventory completeness gate: fails when a tracked test file has no entrypoint. |
| `pnpm test:docs` | Documentation verifiers in `docs/roundtable/*.test.mjs`. |
| `pnpm test` | Default. Units, properties, and in-process contracts. Scripted runtime, fake sandbox, in-memory wakeup — no live connector or model-provider calls. |
| `pnpm test:integration` | Postgres via Testcontainers: product journeys, authorization, executor lifecycle, Graphile / LISTEN/NOTIFY. Needs Docker. |
| `pnpm test:e2e` | Playwright against the emulated API. Needs Docker. |
| `pnpm test:worker-chain` | Standalone-Worker production chain (WK-01): separate `apps/worker` process claims Graphile jobs from the API, executes via the Java AgentScope runtime and the local model fixture, proactively delivers Routine over-budget results through the durable outbox exactly once, recovers a pre-delivery crash and a mid-run lease loss, and proves cross-Space isolation. Needs Java 21; Postgres via Testcontainers or `WORKPAL_E2E_DATABASE_URL`. |
| `pnpm test:topology` | Local product-path smoke: Docker computer + Graphile worker recovery. Needs Docker. Not PR CI. |
| `pnpm test:canary` | Live provider canaries. Needs keys. Not PR CI. |
| `pnpm test:agentscope` | Java HarnessAgent against a local HTTP model fixture: streaming, tool bridge, skills, plans, subagents and cancellation. No keys. |
| `pnpm test:computer-replay` | AgentScope Java and Docker Chromium against a local model fixture. Needs the computer image; no keys. |
| `pnpm test:evals --list` | List agent-quality cases. Add `--live` and a model connection to measure repeated real-model task success. |
| `pnpm test:computer` | Real vision model + E2B desktop. Needs keys; see [computer verification](docs/computer-runtime.md#verification). Not PR CI. |
| `pnpm check` | TypeScript (`tsc`) across the monorepo. |
| `pnpm lint` | Biome lint and format check. |

CI selects jobs from the changed-file set (docs / web / backend / AgentScope / worker-chain / runtime image) and always reports a `CI result` check. Feature-branch pushes do not start a second copy of the PR run. Full verification is `workflow_dispatch` `mode=full` and a daily schedule. Path map, job names, and how to add a rule: [docs/ci01-selective-checks.md](docs/ci01-selective-checks.md). Local selector tests: `pnpm test:ci-select`.

## Adding a UI language

This is a web-only product; `apps/` contains `api`, `web`, and `worker`. The web UI uses Lingui
catalogs. To add a locale, register it in
`apps/web/lingui.config.ts`, `apps/web/src/lib/ui-locale.ts`, and
`apps/web/src/lib/i18n.ts`, then run `pnpm --filter @rakazo/web intl:extract`, fill the new
`apps/web/src/locales/<locale>/messages.po` catalog, and validate it with
`pnpm --filter @rakazo/web intl:compile`. Keep message IDs, placeholders, JSX markers, and
ICU plural branches intact; do not commit generated `*.js`/`*.mjs` catalog files. Update the
locale unit tests and a UI E2E scenario for each supported surface.

See [agent verification](docs/agent-verification.md) for the distinction between
deterministic execution tests, computer replay, and real-model quality evals.

## Optional live-provider checks

The default Playwright suite uses the fake sandbox. To run the same scripted-agent suite against
real computers, set the matching `E2B_API_KEY`, `DAYTONA_API_KEY`, or `BOX_API_KEY` and choose a provider:

```bash
pnpm test:e2e --sandbox=e2b
pnpm test:e2e --sandbox=daytona
pnpm test:e2e --sandbox=box
```

These runs provision real machines and destroy them after the suite. Automatic runs use `fake`.
For the separate real-model desktop acceptance test, see
[computer verification](docs/computer-runtime.md#verification).

## Secrets and configuration

- **Never** commit `.env` files or secrets.
- **Never** paste API keys, tokens, or passwords in issues or PRs.
- Use placeholders in examples (`your-openrouter-key`, etc.).

The product path is **AgentScope Java + Docker + Graphile**. Emulator settings (`AGENT_RUNTIME=scripted`, `SANDBOX_PROVIDER=fake`, `WAKEUP_DRIVER=memory`) are for tests only.

**Integrations** can use [Composio](https://composio.dev/) or Pipedream Connect as optional managed
app catalogs. Users can also install HTTPS MCP servers (including Treg) and bounded OpenAPI tool
sources. Connector tests must stay deterministic and offline. Never put connector credentials in
capability config, fixtures, logs, or snapshots; use the encrypted secret store and fake placeholders.

## Pull requests

One delivery unit per branch and PR; drive sub-tasks with commits instead of opening a PR per
step. Target `main` and fill in [.github/pull_request_template.md](.github/pull_request_template.md):
task card, the commands you actually ran with their results, real runtime evidence, red/green logs
for bug fixes, risk, documentation writeback, and the UI prototype reference or an explicit
"no UI change" declaration.

Review judges the **final** head SHA. A green run on an older commit does not substitute for it,
and a required check that never ran is not a pass. Delivery and acceptance rules live in
[AGENTS.md](AGENTS.md) and [docs/development-workflow.md](docs/development-workflow.md).

## Repository hygiene gate

`pnpm repo:hygiene` rejects tracked `.env*` credential files, paths under restricted directories,
worktrees nested inside the repository, and unexpectedly large additions. Frozen prototypes,
generated assets, and test fixtures pass through an explicit allowlist rather than one global size
threshold. CI runs the same check, so a clone without any hook installed is still blocked.

`pnpm hooks:install` adds the optional local reminder hook. The hook is a convenience and never
the gate.

## Contact

| Address | Use for |
| --- | --- |
| [security@rakazo.com](mailto:security@rakazo.com) | Vulnerabilities only — see [SECURITY.md](SECURITY.md) |
| [support@rakazo.com](mailto:support@rakazo.com) | User and support questions |
| [elie@rakazo.com](mailto:elie@rakazo.com) | Maintainer |
