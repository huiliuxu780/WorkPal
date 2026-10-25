# Agent verification

Rakazo separates deterministic execution regressions from real-model task quality.
A scripted response can prove that a tool call executes correctly; only a real
model can demonstrate that it chooses a useful action for a natural request.

| Layer | Real components | Stand-ins | Command |
| --- | --- | --- | --- |
| Unit gate | Product functions and contracts | Scripted agent, services, sandbox | `pnpm test:unit` |
| PostgreSQL gate | PostgreSQL 16, migrations, repositories | Scripted agent, services, sandbox | `pnpm test:postgres` |
| Existing broad tests | Product functions and contracts | Scripted agent, services, sandbox | `pnpm test` |
| Java runtime regressions | AgentScope HarnessAgent, model stream, Tool Bridge, Skill, Plan, subagent | Loopback model and tool endpoints | `pnpm test:agentscope` |
| Product journey | API, saved model connection, Postgres, executor, AgentScope Java | Model endpoint, sandbox, connectors | `pnpm test:integration` |
| Computer replay | AgentScope Java, browser tool handlers, page state | Model endpoint, browser and sandbox | `pnpm test:computer-replay` |
| Docker computer replay | AgentScope Java, supervisor, Chromium, page helper, downloads and files | Model endpoint, local fixture website | `pnpm test:computer-replay` |
| Agent quality | Product API, Postgres, executor, AgentScope Java, real model | Sandbox and connected services | `pnpm test:evals --live ...` |
| Vision acceptance | Product API, AgentScope Java, real vision model, Box or E2B desktop | Fixture website | `pnpm test:computer` |

`pnpm test` is the legacy broad Vitest run. It still includes every matched
file, skips database-gated suites without `VERIFY_DATABASE=1` and
`DATABASE_URL`, and is not a hermetic gate. Use `pnpm test:unit` for the unit
gate and the layered commands below for external environments.

## Tracked test inventory

`scripts/testing/test-inventory.mjs` enumerates the Git-tracked `*.test.ts`,
`*.test.tsx`, and `*.test.mjs` files and assigns each one at least one execution
entry:

| Category | Environment | Entry |
| --- | --- | --- |
| `unit-node` | Node, no external service | `pnpm test:unit` |
| `unit-jsdom` | Vitest jsdom, no browser process | `pnpm test:unit` |
| `postgres` | PostgreSQL 16 with migrations | `pnpm test:postgres` (`db-postgres` job) |
| `integration-harness` | PostgreSQL + app + JDK 21 | `pnpm test:integration --spec=<file>` |
| `agentscope-request` | JDK 21 AgentScope runtime | `agentscope` CI job |
| `computer-replay-java` | JDK 21 + Maven | direct `vitest run <file>` |
| `computer-replay-cli` | JDK 21 + Docker | `pnpm test:computer-replay` |
| `docker-manual` | Docker / Compose | explicit local command |
| `live-canary` | live provider credentials | `pnpm test:canary` |
| `live-computer` | live model and sandbox credentials | `pnpm test:computer` |
| `process` | local shells, scripts, or helper binaries | `pnpm test:process` |
| `node-test` | Node's built-in test runner | `pnpm test:ci-select`, `pnpm test:docs` |

A file without a rule defaults to unit only when it has no external suffix and
no external marker. `*.postgres.test.ts`, `*.integration.test.ts`,
`*.docker.test.ts`, `*.e2e.test.ts`, and `*.canary.test.ts` require an explicit
rule, as does any ordinary-looking file that reads `DATABASE_URL`,
`VERIFY_DATABASE`, `AGENTSCOPE_URL`, Testcontainers, live provider flags, or a
non-type `node:child_process` import. `*.test.mjs` uses Node's runner, so it
also requires an explicit rule. A file with more than one execution entry must
state why the duplicate entry is useful.

Ordinary-suffix exceptions are listed in the inventory rather than inferred from
the filename. `packages/testkit/src/computer-replay.test.ts` starts the Java
runtime and is not a unit test. `packages/db/src/delivery-records.test.ts`,
`packages/db/src/usage-stats.test.ts`, and the testkit messaging, mention-target,
and runs-list tests connect to PostgreSQL despite their plain names.

`node-test` files are not mixed into Vitest: selector and inventory tests run
through `pnpm test:ci-select`, and roundtable document verifiers run through
`pnpm test:docs`. The harness CI job runs both commands.

`pnpm test:inventory` fails on an unclassified tracked test, a rule whose file
was deleted, a rule whose marker no longer matches, a multi-entry classification
without a duplicate reason, a unit test that also claims an external category,
and an entry whose package script, CI job, harness suite list, or unit config
is missing. `pnpm test:unit` builds its include list from the same inventory, so
a new external test cannot silently join the hermetic unit gate.

To add a test:

1. Prefer a pure unit test with no external dependency; it needs no inventory
   rule and runs in `pnpm test:unit`.
2. If it needs PostgreSQL, Java, Docker, a browser, a process, or credentials,
   add an explicit rule in `scripts/testing/test-inventory.mjs` with markers,
   `reason`, and, when it has multiple entries, `duplicateReason`.
3. Run `pnpm test:inventory`; if it is a unit test, run `pnpm test:unit`.
4. For a new PostgreSQL file, run `pnpm test:postgres` against a migrated
   database. CI selects `db-postgres` from the same classification.

`pnpm lint` runs `biome check .`; the formatter and import sorting are part of
the gate. Five confirmed prototype paths and the precise pre-existing
formatter/import-sort debt list in `biome.json` are temporarily excluded; H3
owns closing those exclusions.

Default and PR tests never require paid inference. Docker topology and browser
replay have a manual workflow; hosted sandboxes and real-model quality runs
require an explicit local command. Scheduled CI does not start computer
sandboxes or request model or sandbox credentials.

## E2E failure evidence

The `web`, `agentscope`, `worker-chain`, and `visual-web` jobs upload
Playwright evidence when the job fails or is cancelled. The artifact name is
`playwright-<job>-<commit SHA>-<run attempt>`. It contains:

- `playwright-report/` — HTML report
- `apps/web/test-results/` — trace, screenshot, and video
- `test-report/` — harness summary when the run created one

Retention is 7 days. A missing directory warns and is skipped; that upload
does not turn a failed or cancelled job green. Traces, screenshots, and videos
are kept on failure (`retain-on-failure` / `only-on-failure` in
`apps/web/playwright.config.ts`). The HTML report is always written to
`playwright-report/`.

## Daily visual entry

There is one daily visual entry: the `visual-web` job in
`.github/workflows/ci.yml`. It runs on the existing `17 3 * * *` schedule and
on `workflow_dispatch` with `mode=visual`. It does not run on pull requests.

It runs only the scripted specs `ui-appearance.spec.ts` and
`settings-shell.spec.ts` (`pnpm test:e2e --runtime=scripted`). Those specs
capture the web screenshots. The job uploads `playwright-report/`,
`apps/web/test-results/`, and `test-report/` as
`daily-visual-<commit SHA>-<run attempt>`, retained for 14 days.

The same schedule still runs the existing full CI graph. `mode=visual` does
not. This entry does not run AgentScope, the worker chain, PostgreSQL suites,
computer replay, live evals, or hosted sandboxes. The old
`nightly-verification.yml` workflow called a missing `playwright.yml` and
never produced screenshots; it stays only until one successful manual
`mode=visual` run exists, then it is removed.

## Budget and execution-card races

`budget-acceptance.spec.ts` keeps the queue boundary and the final delivery
as separate assertions. While the failed routine Run owns a recovering chat
admission, the delivery Run may be `queued` or briefly `leased` by the
dispatch sweep, and no `delivery.sent` event exists. `running` or `completed`
at that point fails the boundary. `continueRun` on that terminal owner then
uses the production RT-26 proof. Only after that proof does the test require
the delivery Run to complete and the summary to be sent once.

`execution-card.spec.ts` waits for the ask card itself instead of reloading
when the region is briefly absent, and it acknowledges `resolveIntervention`
before expecting the answered echo. Paging waits for each
`threads/messages` response. It does not use a fixed sleep, and it does not
treat a disabled Loading button as the end of history.
Missing live credentials mean **not run**, not a passing model evaluation.

On 2026-10-08 a local acceptance used the existing encrypted WorkPal DashScope
`qwen3.8-flash` connection through the Java Harness runtime. Chat, one backend
tool call, Skill loading, Plan enter/write/exit with approval and a resumed Run,
and synchronous subagent delegation succeeded. The deterministic product and
Web suites remain separate evidence for API/Worker/UI routing. No credential
value or user data was written to the repository.

## Deterministic AgentScope tests

`packages/testkit/src/model-emulator.ts` serves a loopback OpenAI-compatible
stream through WorkPal's existing generic connection. The Java HarnessAgent and its state store run for real.
Each step validates the actual request before streaming a response, and tests
must assert that all expected steps were consumed without unexpected requests.
The next request must contain the tool result from real execution.

Java tests cover streaming, session resume and isolation, Tool Bridge callbacks,
Skill allow-lists, native Plan approval, subagent execution, cancellation and provider
construction. The Postgres journey verifies the persisted run, message and file
through the product boundary. It uses a local model fixture and does not establish
real-provider availability.

## Computer replay

The synthetic contacts-export scenario navigates a fixture page, observes the
computer, uses fresh element references to open an export dialog and download a
CSV, then reads the artifact. Independent checks require the exact CSV and one
export. Invalid or stale clicks and cancellation cannot create the artifact.

The emulator models page state; it does not advance just because another tool
was called. The Docker lane executes the same scenario against real Chromium
and the production supervisor/page-browser helper. It checks a real screenshot
and browser-created file. The generic compatible model fixture is text-only;
Text-only model image handling is checked explicitly. Vision interpretation is
covered by the separate real-model acceptance test.

```bash
pnpm sandbox:build
pnpm test:computer-replay
# Or use an already built image:
pnpm test:computer-replay --image=rakazo/computer:local
# If Docker has exhausted its automatic address pools, choose an unused subnet:
pnpm test:computer-replay --subnet=<unused-private-cidr>
```

Docker replay does not open Electron windows, use model credentials, or attach
to an existing browser. It owns and cleans up its test resources. It exercises
the runtime and computer boundary; it does not claim UI, approval, or database
executor coverage.

The repository also contains authored failure scenarios and a contacts-export recording
captured with Luna through OpenRouter against real Docker Chromium. Docker replay uses
the HTTP model emulator with AgentScope Java and resolves fresh page references. The
Docker test verifies one real export, the downloaded CSV and a screenshot. Separate
deterministic replay tests cover cancellation, a transient download failure, workspace
restoration, and an interrupted model stream after export without duplicating the export.
Separate Postgres integration tests verify that computer actions wait for
approval, execute the approved payload once, and have no effects after denial.

To capture another successful run manually:

```bash
# Requires OPENROUTER_API_KEY; incurs inference usage, with a local Docker sandbox.
pnpm test:computer-replay --image=rakazo/computer:local \
  --live --record=new-fixture.json
```

The recorder accepts only this synthetic contacts scenario. Its closed
vocabulary retains action names, known button labels and success/error outcomes;
it excludes model prose, raw responses, URLs, credentials, IDs, element refs and
screenshots. A new fixture is written only after both live execution and an
immediate offline replay produce the exact CSV and exactly one export. Failed
attempts print only the sanitized decisions and do not publish a fixture.

This records semantic browser actions, not coordinate or vision decisions.
Box currently lacks the page-browser capability used here, so this capture uses
local Docker. Box remains the default for the separate screenshot/coordinate
acceptance journey. One successful captured run demonstrates replay coverage;
it does not measure the live model's reliability.

## Live computer acceptance

Run a vision-capable model through OpenRouter against a real Box desktop:

```bash
COMPUTER_E2E_MODEL=openai/gpt-5.6-luna pnpm test:computer
# Run the same checks against E2B when provider-specific verification is needed:
COMPUTER_E2E_MODEL=openai/gpt-5.6-luna pnpm test:computer --sandbox e2b
```

Box is the default regardless of the application's sandbox setting. This opt-in
test requires `OPENROUTER_API_KEY` and the selected sandbox's credential
(`BOX_API_KEY` or `E2B_API_KEY`) and incurs inference and sandbox usage.
It checks visual observation, a real browser click,
terminal access and exact file contents. It then destroys the sandbox outside
the app and calls `computer/recover`, requiring a new sandbox with the saved
file restored. `computer/boot` returns the stored running state and does not
request recovery from an externally deleted sandbox.

Both providers run the same assertions. This journey does not cover PTY sessions
or multiple screens, which Box does not support. Provider conformance tests
remain separate. Live runs retain error logs to diagnose provider failures.

## Real-model quality

List the cases without inference:

```bash
pnpm test:evals --list
```

Run through a normal provider connection, referring to an existing credential
variable rather than placing a key on the command line:

```bash
pnpm test:evals --live --provider openrouter --model <model-id> \
  --api-key-env OPENROUTER_API_KEY --trials 3
```

`--connection <private-json-file>` also accepts the shared `models/connect`
shape, including a generic compatible endpoint. Never commit that file. Use
`--case <case-id>` to select a regression. Each run provisions isolated Postgres
and synthetic services; it does not use production application data. Each trial
uses fresh accounts and services. The runner disables its routines and cancels
its work before proceeding; cleanup failure leaves remaining trials not run.

Live evaluations run only through an explicit local CLI invocation. They are
not part of the daily visual entry or the scheduled full CI graph.

The September 2026 Luna/OpenRouter baseline passed all 15 cases over three
trials each (45/45) after correcting the harness. The initial run passed 41/45:
one shell command was falsely reported successful by the fake sandbox, and
three correct outcomes failed overly narrow wording checks. Regression tests
cover those fixes; the original report remains separate from the corrected run.

The suite covers artifacts and calculations, inbox grounding and injected
instructions, precise and read-only CRM operations, approval payloads, uncertain
writes, durable preferences, workspace memory isolation, saved taught playbooks,
GitHub release monitoring, and a Slack-to-Salesforce-and-Zendesk customer update.
The recorded baseline above covers the original 15 cases; the current 16-case
suite also verifies that a real model selects matching records across two local
service emulators and posts a grounded reply to the originating Slack-like DM.
It does not evaluate visual teaching or native mobile recording.

Keep compact scenario seeds, generators and grading criteria in this repository
so contract changes are reviewed together and failures reproduce from one
commit. Fixtures must be synthetic. If a future corpus is too large for the
repository, publish it as a versioned artifact pinned by immutable digest and
retain a small offline conformance fixture here. Do not import third-party eval
data unless its redistribution terms are explicit and compatible.

The eval sandbox executes file tools but returns an explicit error for model
shell commands instead of pretending to run them. If outcome checks fail after
that limitation is encountered, the trial is attributed to the harness. Confirm
shell-dependent outcomes in the real Docker or live computer lane. Release monitoring
checks a daily schedule and a newly introduced release; unchanged-release
notification deduplication is not covered by this suite.

Grading reads files, service records, recorded effects and persisted product
state. A model's claim of completion is not sufficient. Cases do not receive
repair prompts or coaching after a failure. Multi-turn setup and fresh-context
checks are explicit parts of the scenario.

Reports under `test-report/evals/` contain per-case success counts, first trial
success, autonomous success rate, latency, tool counts, criteria, redacted
traces, artifacts and redacted memory evidence. Tool and usage totals retain
records across conversation clearing; clearing history cannot reset a trial’s
tool budget. Unavailable token or cost measurements remain null.
Failures distinguish agent outcomes, product errors, provider failures,
harness failures and incomplete runs. Read the category and evidence before
attributing a red run to a prompt change. Several trials establish an initial
baseline, not a statistically precise reliability estimate.

The injection case checks the requested artifact and forbidden service effects.
It does not grade every claim in free-form explanatory prose; quoted or denied
injection warnings must not be mistaken for compliance with the injection.

Keep functional criteria deterministic. Add a model judge only for a quality
that cannot be graded directly, with a versioned rubric and human calibration.
Do not let a judge override forbidden effects or missing artifacts.

## Worktree resource isolation

`pnpm agent:doctor` prints the current worktree plan: a stable task id, ports,
Compose project, volume names, database name, data directory label, and lease
label. It also lists conflicts and stale leases. The task id comes from a
normalized worktree path or an explicit `--task` slug. Doctor output omits the
machine user name and absolute paths.

Ports that the API, Playwright, and Compose must know before they bind are
reserved by a locked lease. The operating system assigns the port while that
lock is held, so two worktrees do not probe the same port and then race to bind
it. `pnpm test:e2e` still starts a private Testcontainer unless
`WORKPAL_E2E_DATABASE_URL` names a local `workpal_e2e_` database that no other
active lease holds. Integration runs reject that external URL and keep
per-suite database clones.

Dev Compose reads `COMPOSE_PROJECT_NAME`, `API_HOST_PORT`, `WEB_HOST_PORT`,
`POSTGRES_HOST_PORT`, and `WORKPAL_COMPOSE_DATA_DIR`. Named volumes are
project-scoped. `pnpm agent:doctor --compose-down` removes only the current
project. After a crash, `pnpm agent:doctor` reports that lease as stale and
`pnpm agent:doctor --recover` clears only the current worktree's stale lease.
