# Rakazo Fork Baseline

This document freezes the upstream starting point for the long-lived fork. It describes observed
code and verified behavior at the baseline commit; it is not a claim that every upstream feature
or deployment topology has been independently production-certified.

## Upstream

```text
Repository: https://github.com/elie222/rakazo
Commit:     410950d9b11cfee484db7e96b168226c7b139859
Date:       2026-09-30T12:48:33-04:00
Subject:    Show optional tool activity in chats (#1102)
```

All comparisons with “original Rakazo” in the first fork phase use this commit, rather than a
moving `upstream/main`.

## Remotes and branches

```text
origin:   https://github.com/huiliuxu780/rakazo.git
upstream: https://github.com/elie222/rakazo.git

upstream/main
      |
      v
origin/main
      |
      v
develop
      |
      +-- chore/fork-baseline
      +-- feature/*
      +-- fix/*
      +-- refactor/*
```

`main` is an upstream mirror and must not receive product work directly. Integration happens on
`develop`; topic branches start from `develop`.

## Repository map

```text
apps/
  api/       Hono/oRPC API composition root and HTTP boundary
  worker/    Graphile Worker process and background job bootstrap
  web/       React/Vite product client
  desktop/   Electron client
  mobile/    Expo client
  www/       public marketing site
packages/
  adapter-kit/  runtime, sandbox, model and job interfaces/types
  adapters/     executor, Pi runtime, providers, tools and infrastructure adapters
  auth/         Better Auth setup
  chat-ui/      shared chat presentation components
  contracts/    domain schemas, RPC contract and event schemas
  core/         provider-neutral domain rules and state transitions
  db/           Prisma schema, repositories and transactional events
  memory/       memory provider integration
  ui-tokens/    shared visual tokens
  ui-web/       shared web UI components
  logging/      structured logging and tracing
  testkit/      integration/E2E/topology harnesses
infra/
  compose/      source, image and production Compose topologies
  sandboxes/    computer image, desktop provider and supervisor
  systemd/      service deployment assets
  updater/      deployment updater
docs/           architecture, operations and release documentation
```

## Current architecture

### Interactive execution

```text
apps/web/src/pages/Shell.tsx
        | oRPC over /rpc
        v
packages/contracts/src/rpc.ts
        |
        v
apps/api/src/router.ts + apps/api/src/thread-target.ts
        |
        | transaction creates Message + Task + Run
        v
packages/db/src/events.ts
        |
        | run.continue job
        v
apps/worker/src/index.ts
        |
        v
packages/adapters/src/background-job-handlers.ts
        |
        v
packages/adapters/src/executor.ts
        |
        v
packages/adapter-kit/src/interfaces.ts (AgentRuntime)
        |
        v
packages/adapters/src/pi-runtime.ts (PiAgentRuntime)
        |
        +-- model resolution/streaming
        +-- tool execution delegated through Executor callbacks
        +-- computer/sandbox provider
```

The API and Worker both compose the same executor/runtime stack in `apps/api/src/index.ts` and
`apps/worker/src/index.ts`. With the normal `WAKEUP_DRIVER=graphile`, Worker consumes the jobs. With
the in-memory driver, API can host the same background handlers; therefore “Routine always goes
through a separate Worker process” is not universally true.

### Routine execution

```text
Routine (database configuration, not a workflow graph)
  -> Graphile schedule / webhook / GitHub / message trigger / test run
  -> Task + Run
  -> run.continue
  -> Executor.continueRun
  -> AgentRuntime.run
```

Important paths:

- Routine schema and input contracts: `packages/contracts/src/domain.ts`
- Routine RPC surface: `packages/contracts/src/rpc.ts`
- Routine API implementation and test-run creation: `apps/api/src/router.ts`
- Scheduled wakeup and run creation: `packages/adapters/src/executor.ts`
- Job mapping: `packages/adapters/src/background-job-handlers.ts`
- Web editor and schedule UI: `apps/web/src/pages/RoutineEditor.tsx` and
  `apps/web/src/pages/RoutineSchedule.tsx`

### Computer execution

```text
Executor
  -> SandboxProvider interface
  -> provider factory / lifecycle coordinator
  -> sandbox supervisor
  -> per-computer container or remote provider
  -> browser + desktop + terminal + files
```

The provider contract is in `packages/adapter-kit/src/interfaces.ts`. Lifecycle/control logic lives
in `packages/adapters/src/computer-lifecycle.ts`, `computer-control.ts`, `computer-idle.ts` and the
sandbox provider modules. The local control plane is `infra/sandboxes/supervisor/src/index.ts`; the
local GUI/browser image is `infra/sandboxes/computer/`. The principal web surfaces are
`apps/web/src/components/computer/ComputerWorkspace.tsx`, `TerminalApp.tsx`, `FilesApp.tsx` and the
computer panel in `apps/web/src/pages/Shell.tsx`.

## Core domains

### Bot

- Definition/contract: `packages/contracts/src/domain.ts` (`BotSchema`, create/update inputs).
- Database: `packages/db/prisma/schema.prisma` (`model Bot`).
- Persistence/API: `packages/db/src/repos.ts` (`createBot`) and `apps/api/src/router.ts` (`bots`).
- Frontend: creation/settings/navigation in `apps/web/src/pages/Shell.tsx` and
  `apps/web/src/pages/shell/bot-panel.tsx`.
- Relationships: long-lived entity owned by a user/space; has one primary visible Thread, many
  Routines, TaughtSkills, model/thinking configuration, memory settings/documents and a team or
  dedicated Computer. Agent Skills are space/user-level catalog entries selected for a bot, not a
  simple `Bot -> AgentSkill` ownership relation.
- Lifecycle: create atomically provisions the bot, primary Thread, browser profile and initial
  memory document, then assigns the applicable Computer; it can later be archived/deleted.

### Thread

- Definition/contract: thread snapshots/messages in `packages/contracts/src/domain.ts` and
  `packages/contracts/src/events.ts`; RPC in `packages/contracts/src/rpc.ts`.
- Database: `packages/db/prisma/schema.prisma` (`model Thread`, `model Message`).
- API: `apps/api/src/router.ts`, `apps/api/src/thread-target.ts`, and `apps/api/src/bot-thread.ts`.
- Frontend: `apps/web/src/pages/Shell.tsx`, with event application in
  `apps/web/src/lib/thread-events.ts` and shared rendering in `packages/chat-ui/`.
- Relationship: the ordinary bot experience is one Bot -> one long-lived visible Thread -> many
  Messages/Tasks/Runs. Thread is not Run. The Thread model also supports group and external
  conversations, so “every Thread belongs one-to-one to a Bot” would be too broad.
- Lifecycle: created with the Bot, accumulated across runs, and deleted/archived with its owner.

### Run

- Definition/contract: `RunSchema` in `packages/contracts/src/domain.ts`, statuses in
  `packages/contracts/src/ids.ts`, runtime events in `packages/adapter-kit/src/types.ts`, and run RPC
  listings in `packages/contracts/src/rpc.ts`.
- Database: `packages/db/prisma/schema.prisma` (`model Task`, `model Run`).
- State rules: `packages/core/src/run-state.ts`.
- Creation: `packages/db/src/events.ts` atomically writes a user Message, Task and Run when the
  thread is idle; an active thread instead receives steering input. Routines create their own
  Task/Run with a routine trigger.
- Start/continuation: `run.continue` is published and consumed by
  `packages/adapters/src/background-job-handlers.ts`, then leased and executed by
  `packages/adapters/src/executor.ts`.
- Persistence: status, lease, checkpoint, attempts, usage and emitted events are persisted in
  PostgreSQL rather than held only in the runtime process.
- Abort: `apps/api/src/thread-target.ts` marks active runs cancelled, emits cancellation, removes
  progress and releases computer work. The worker observes the cancellation/lease loss and aborts
  its execution context; this is not a direct browser-to-runtime abort call.
- Resume: queued/waiting or expired leased/running rows can be claimed again; the Executor passes
  the persisted checkpoint and input choice/takeover state into the runtime.
- Frontend: thread activity in `apps/web/src/pages/Shell.tsx`; cross-space run listing is backed by
  `packages/contracts/src/runs.ts` and the `runs` router.

Statuses at this baseline are `queued`, `leased`, `running`, `waiting_input`, `waiting_takeover`,
`completed`, `failed`, and `cancelled`.

### Routine

- Definition/contract: `RoutineSchema` and inputs in `packages/contracts/src/domain.ts`; RPC in
  `packages/contracts/src/rpc.ts`.
- Database: `packages/db/prisma/schema.prisma` (`model Routine`).
- API: `apps/api/src/router.ts` (`routines`), webhook handling in `apps/api/src/webhook.ts`, GitHub
  handling in `apps/api/src/github-webhook.ts`, and inbound messaging in
  `apps/api/src/messaging-inbound.ts`.
- Frontend: `apps/web/src/pages/RoutineEditor.tsx`, `RoutineSchedule.tsx`, and the routine panel in
  `apps/web/src/pages/Shell.tsx`.
- Semantics: a Routine is a persistent trigger + prompt configuration. It is not a DAG, workflow
  engine, batch plan, or independent runtime.
- Triggers: cron schedules (with timezone), webhook, GitHub and supported message sources.
- Lifecycle: create/update/delete/enable; schedule wakeup or external trigger creates a Task/Run;
  test run uses the same run pipeline with trigger `routine` but does not wait for the next trigger.

### Skill

There are two deliberately different concepts:

1. `TaughtSkill`: a per-Bot recorded/drafted/saved demonstration/playbook. Database model
   `TaughtSkill`; contract in `packages/contracts/src/domain.ts`; orchestration in
   `apps/api/src/taught-skills.ts`; UI under `apps/web/src/components/teach/` and `Shell.tsx`.
2. `AgentSkill`: a Claude Agent Skills-style `SKILL.md` recipe shared across assistants, sourced
   from user, builtin or plugin catalogs. Database model `AgentSkill` for persisted entries;
   parsing/rules in `packages/core/src/agent-skill.ts`; API in `apps/api/src/agent-skills.ts`;
   frontend catalog in `apps/web/src/pages/KnowledgeSection.tsx`.

Runtime tool implementations and builtin skill material are under `packages/adapters/src/`. These
must not be collapsed into one model merely because the UI uses the word “skill”.

### Computer

- Definition/contract: computer status and update schemas in `packages/contracts/src/domain.ts` and
  command events in `packages/contracts/src/events.ts`; RPC in `packages/contracts/src/rpc.ts`.
- Database: `packages/db/prisma/schema.prisma` (`model Computer`, `ComputerUpdate`, and
  `ComputerExecutionLease`).
- API: `apps/api/src/router.ts` (`computer`) and computer proxy/control modules in `apps/api/src/`.
- Provider boundary: `SandboxProvider` in `packages/adapter-kit/src/interfaces.ts` covers provision,
  prepare, execution, screen, terminal, input, observation/action, files, workspace, snapshot,
  stop and destroy.
- Relationships: Bots attach to a shared Team Computer or a dedicated Computer. Execution leases
  serialize/coordinate work; browser profiles and data directories survive individual Runs.
- Lifecycle: provision/prepare -> run or interactive screen -> idle/sleep/maintenance -> replace,
  reset, stop or destroy. Providers include local Docker and optional remote/local alternatives.

## Runtime boundary

```text
Rakazo product/API/Worker
          |
          v
Executor
packages/adapters/src/executor.ts
          |
          v
AgentRuntime interface + run/event/checkpoint types
packages/adapter-kit/src/interfaces.ts
packages/adapter-kit/src/types.ts
          |
          v
AgentScopeRuntime
packages/adapters/src/agentscope-runtime.ts
          |
          v
AgentScope Java HarnessAgent
services/agent-runtime/
```

`AgentRuntime.run(request, context)` receives prompt/history/model/tool callbacks, emits a typed
stream of text/progress/tool/ask/takeover/usage/checkpoint/subagent/done events, and supports
`abort(runId)`. The Executor owns database leases, idempotency/effects, tool execution, computer
acquisition, checkpoint persistence, notifications and final state transitions. AgentScope Java owns the
session and tool loop. The TypeScript adapter maps Java streaming events to the neutral product types.

If a future runtime is introduced, prefer a new implementation beside `agentscope-runtime.ts`, bind it in
the API/Worker composition roots, and add adapter conformance tests. Changes may be needed in
`packages/adapters` and, only if the abstraction is insufficient, narrowly in `adapter-kit`.
Contracts, Prisma models, Executor semantics, Routine semantics, Web/API payloads and Computer
providers should remain unchanged unless a separately justified product requirement proves the
existing interface cannot express it.

## Scope classification

### A. Must understand now

- `apps/web`, `apps/api`, `apps/worker`
- `packages/contracts`, `core`, `db`, `adapter-kit`, `adapters`
- authentication and encrypted credential flow
- Graphile Worker scheduling and leases
- computer lifecycle and sandbox supervisor
- source and production Compose topologies

### B. Treat as black boxes for the first product phase

- Electron packaging/updater internals
- Expo/mobile release machinery
- voice providers and call transport
- individual cloud sandbox providers
- managed integrations/providers not used by the initial product
- marketing site and most release automation

Black box means “preserve interfaces and tests”, not “safe to ignore operationally”.

### C. Possible later disable/removal candidates — no decision yet

- unused managed integration catalogs
- unused cloud computer providers
- voice, mobile, desktop or marketing surfaces outside the chosen launch scope
- provider-specific UI that the fork deliberately does not offer

Removal has migration, support, security and upstream-merge costs. Measure actual product scope and
usage before deciding; do not delete these modules during the baseline phase.

## Local development commands

Follow the upstream source-checkout path:

```bash
cp .env.example .env
# Fill independent random values for POSTGRES_PASSWORD, BETTER_AUTH_SECRET,
# ENCRYPTION_KEY, SCREEN_PROXY_SECRET and SANDBOX_SUPERVISOR_TOKEN.

docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d

pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

Required baseline toolchain: a supported Node release from root `package.json` (tested with Node
24), pnpm 9, Docker Engine, Docker Compose and Docker Buildx. Open
`http://127.0.0.1:5173`.

For no-key smoke tests only, `AGENT_RUNTIME=scripted` exercises the full API -> Worker -> Run ->
Computer pipeline with deterministic responses. This is not a substitute for Java Harness/model verification.

## Production / Docker commands

Source Compose verification:

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  up -d --build
```

The default source Compose uses `AGENT_RUNTIME=agentscope` with the Java Harness service. Published-image installation,
single-VM production hardening, TLS, backups and upgrade commands are maintained in
`docs/self-host.md`; do not infer production readiness from a successful local Compose boot alone.

## Historical baseline verification (before Java migration)

Verified on 2026-10-01:

- dependency install and Prisma generation succeeded;
- all 89 database migrations applied to PostgreSQL 16;
- `pnpm check`: 22/22 tasks passed;
- `pnpm lint`: exited successfully with 19 warnings and 4 informational findings;
- `pnpm test`: 448 files passed, 3 failed, 28 skipped; 5,539 tests passed, 3 failed, 182 skipped;
- `pnpm test:integration`: all 19 suite files and 138 tests passed with Testcontainers Ryuk disabled
  for the local Colima environment;
- `pnpm test:e2e`: 158 tests ran; 153 passed, 4 failed and 1 was skipped;
- source stack started Web, API, Worker and sandbox supervisor;
- the former `pnpm test:pi` suite passed 2 files and 10 offline Pi/runtime tests;
- source Compose built all application/supervisor/computer images, started the full stack, reported
  PostgreSQL healthy, and returned HTTP 200 from Web and API `/health`;
- UI/API smoke covered signup, sign-in, Bot creation/open, persistent Thread, message send, Run
  completion, Routine editor/create/test-run and a running local Computer;
- Graphile Worker logged successful `run.continue` consumption;
- after a full app-service restart, the Bot, Thread and messages remained present.

The smoke runtime was `scripted` because no external model credential was required. These results
predate the Java migration and do not verify the current AgentScope Harness path.

## Known issues and observations

These were observed, not fixed:

1. `packages/testkit/src/compose-installer-smoke.test.ts` fails on the stock macOS Bash 3.2 because
   `infra/compose/restrict-computer-egress.sh` uses `mapfile`; its `--print` smoke emits no rules.
2. `packages/core/src/node/desktop-runtime.test.ts` has a stable macOS failure in a Linux lifecycle
   case because `flock` is unavailable and that case does not stub it.
3. `infra/sandboxes/supervisor/src/computer-spec.test.ts` had one timing failure (“slow failure
   looked successful”) in the full suite, then passed in isolation; treat it as a flaky timing
   signal, not a confirmed product defect.
4. On the first local Computer-backed Run, Team Computer folder preparation failed once; Graphile
   retried and the second attempt completed. Investigate repeatability before changing lifecycle
   code.
5. The first `pnpm sandbox:build` used Docker's legacy builder, left `TARGETARCH` empty and failed.
   Installing/enabling Buildx made the unchanged upstream command succeed. The README names Docker
   but does not explicitly call out this modern CLI plugin dependency.
6. Immediately after `pnpm dev`, Vite can accept traffic before API port 3100 is listening, causing
   transient proxy `ECONNREFUSED` messages; the UI recovered once API started.
7. The default Testcontainers Ryuk sidecar could not mount the macOS Colima socket path inside the
   Colima VM. With `TESTCONTAINERS_RYUK_DISABLED=true`, the repository harness performed its own
   cleanup and all 19 integration suites passed. This is a local runner compatibility constraint,
   not evidence that the integration tests themselves failed.
8. Full Playwright E2E had four failures: two message-quote interaction cases
   (`message-quote.spec.ts:150` and `:381`), the logout/draft-clear assertion
   (`auth-lifecycle.spec.ts:30`), and the send-button focus assertion (`golden.spec.ts:330`). The
   other 153 cases passed and one golden context-menu case was skipped. The test harness also
   reported five intentionally failed scripted agent Runs used by failure-path scenarios; those are
   distinct from the four Playwright test failures. A targeted rerun made both message-quote cases
   pass, while the auth and focus cases failed again; the evidence therefore points to two flaky
   interaction tests plus two repeatable baseline failures, not four equally stable defects.

The upstream README itself labels Rakazo beta. “Production-grade” should therefore be treated as a
target and an engineering hypothesis, not as a verified fact. A local smoke does not validate load,
backup restore, disaster recovery, multi-worker contention, provider quotas or public-host security.

## Do-not-touch-yet

- Runtime replacement, Executor redesign or runtime event semantic changes
- Prisma core models and Bot/Thread/Run/Routine meanings
- new workflow, task or batch-execution abstractions
- UI redesign, design-system rewrite or branding sweep
- provider, voice, mobile, desktop or integration deletion
- repository-wide rename, formatting or lint autofix
- opportunistic fixes for the baseline findings above

Before every future change, classify it as either an upstream capability modification or a fork-only
capability. Prefer new fork-owned modules for the latter and keep UI, product logic, runtime,
computer and persistence coupled only through the existing contracts and application boundaries.
