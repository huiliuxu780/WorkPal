# CI-01: selective checks

Status: `in-progress` on `codex/ci01-selective-checks`. Baseline: `main @ c2dfea4` (2026-10-19). Not merged. Not deployed.

This is the maintenance note for the selector. The task card is [CI-01.md](./tasks/CI-01.md). Path rules live in `scripts/ci/select-checks.mjs` only.

## Before / after job graph

**Before** (every `push` and every `pull_request`, no path filter):

```
web-and-backend   adapters/api/worker/web check, web build, 3 vitest files
agentscope        mvn package + AgentScope TS/PG/E2E + worker-chain (~5 min lease)
agent-runtime-image   docker build; GHCR push on main
```

Wall clock on `main` push `39185685190` (merge of #63): web-and-backend 52s, agentscope 936s, image 71s, **15m40s** overall. A typical PR update ran this twice (push + pull_request).

**After:**

```
select-checks     classify the PR or push range; print selected jobs and why
docs              relative-link check only (no pnpm, no DB, no image)
web               UI typecheck, web unit tests, web build, focused scripted E2E
backend          TS checks/unit tests for adapters/api/worker/core/…
runtime-jar       one `mvn package` for this SHA; artifact agent-runtime-jar-<sha>
agentscope        previous runtime integrations/PG/E2E, using that jar (no worker-chain)
worker-chain      previous `pnpm test:worker-chain` with AGENT_RUNTIME_SKIP_BUILD=1
agent-runtime-image   unchanged build; push only on in-scope main
CI result         always runs; selected jobs must be success
```

Feature-branch `push` no longer starts CI. PR `opened` / `synchronize` / `reopened` / `ready_for_review` starts one selective run. Same PR number cancels the previous run. `main` push, `schedule`, and `workflow_dispatch` use unique concurrency groups and are not cancelled by PR updates.

Daily `17 3 * * *` and `workflow_dispatch` `mode=full` run the same job graph as a full selection. They do not reuse `.github/workflows/nightly-verification.yml` (that screenshot workflow still references a missing `playwright.yml`; CI-01 does not claim to have fixed it).

## Path map

| Path pattern | Consumer | Jobs |
| --- | --- | --- |
| `docs/**`, root markdown (`README.md`, `AGENTS.md`, …), `.github/ISSUE_TEMPLATE/**` | humans only | `docs` |
| `apps/web/**`, `packages/ui-web/**`, `packages/ui-tokens/**`, `packages/chat-ui/**` | Web UI | `web` (+ focused E2E) |
| `packages/core/src/avatar-*`, `bot-avatar-*`, composer/markdown helpers | Web UI | `web` |
| `apps/api/**`, `packages/adapters/**` (default), `packages/adapter-kit/**`, `packages/auth/**`, `packages/memory/**`, `packages/logging/**`, `packages/testkit/**` | API / AgentScope request path | `backend`, `agentscope`, `runtime-jar` |
| `prompts/**`, `services/agent-runtime/**` (prompt/resources) | runtime source | `agentscope`, `agent-runtime-image`, `runtime-jar` |
| `RuntimeEngine.java`, `RuntimeServer.java`, `pom.xml`, `Dockerfile`, lease/outbox TS, `apps/worker/**` | Worker execution / recovery | `backend`, `worker-chain`, `runtime-jar` (Java also `agentscope` + image) |
| `packages/contracts/**`, `pnpm-lock.yaml`, `package.json`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.github/workflows/**`, `scripts/ci/**` | global | **full** |
| `packages/db/prisma/**` | every process | **full** |
| unclassified source | unknown consumer | **full** (add a rule; do not default to zero tests) |

Unions are additive. Renames/deletes classify both old and new paths. SVG/PNG follow the consumer (`packages/ui-web` → web, `docs/` → docs). A file whose path contains the word `agentscope` is **not** classified by that substring; `docs/notes-about-agentscope.md` is docs.

Focused web E2E (scripted runtime, `WAKEUP_DRIVER=memory`, no Worker process):

- default: `ui-appearance.spec.ts|settings-shell.spec.ts`
- avatar packages: avatar-* specs
- execution/task-center UI: `execution-card.spec.ts|task-center.spec.ts`

## How to add a path

1. Add a rule near the top of `scripts/ci/select-checks.mjs` (`classifyPath`). First match wins.
2. Add a case in `scripts/ci/select-checks.test.mjs`.
3. Run `pnpm test:ci-select`.
4. If the new path is shared by UI and execution, union the jobs. If it is a global contract/lockfile/CI file, return full.

Force full without a path rule: `workflow_dispatch` with `mode=full`, or the daily schedule.

## How to read a run

1. Open the workflow run. `select-checks` writes a job summary: compare SHAs, selected/skipped jobs, and why.
2. `CI result` is the fixed check name. It fails if a **selected** job failed, skipped, or cancelled, or if `select-checks` itself failed. Unselected jobs may stay skipped.
3. Do not treat a skipped `agentscope` on a docs PR as a missing required check unless an admin later makes `agentscope` required. This repository had **no** branch protection and **no** rulesets on 2026-10-19 (`main @ c2dfea4`).

### Job names (old → new)

| Before | After |
| --- | --- |
| `web-and-backend` | `web` and/or `backend` |
| `agentscope` | `agentscope` (no worker-chain) + optional `worker-chain` + `runtime-jar` |
| `agent-runtime-image` | same name |
| *(none)* | `select-checks`, `docs`, `CI result` |

This PR does not change GitHub protection settings. If required checks are added later, require `CI result` and drop the old `web-and-backend` name.

## GHCR

`agent-runtime-image` still builds with the existing Dockerfile. `push` is `github.event_name == 'push' && github.ref == 'refs/heads/main'`. Pull requests, docs-only main, schedule, and `workflow_dispatch` do not publish. No production deploy step was added.

## Local checks

```bash
pnpm test:ci-select
node scripts/ci/select-checks.mjs --files README.md apps/web/src/App.tsx
node scripts/ci/check-docs.mjs --all
```

## Evidence

Baseline (before, already on `main`):

| Kind | Run | Selected | Duration |
| --- | --- | --- | --- |
| main push, full legacy graph | https://github.com/huiliuxu780/WorkPal/actions/runs/39185685190 | web-and-backend 52s, agentscope 936s (includes worker-chain), image 71s | 15m40s |
| docs PR #66 push+PR duplicate | https://github.com/huiliuxu780/WorkPal/actions/runs/39187519571 (push, 15m16s) and https://github.com/huiliuxu780/WorkPal/actions/runs/39187524220 (pull_request) | same three jobs twice | ~15m each |

After (real GitHub runs on 2026-10-19). Temporary proof PRs targeted this implementation branch so the diff was only the sample file, not the CI rewrite.

| Kind | Selected jobs | Run URL | Duration |
| --- | --- | --- | --- |
| This PR #67 (CI files → full) | all jobs + `CI result`; only `pull_request` (no feature-branch `push` clone). First attempt hit a pre-existing `budget-acceptance.spec.ts` flake; **failed-job rerun green**. | https://github.com/huiliuxu780/WorkPal/actions/runs/39190007263 | rerun 5m28s after flake; full `workflow_dispatch` below is the clean all-green wall clock |
| docs-only proof #68 | `docs`, `CI result`. Skipped web/backend/agentscope/worker-chain/image/runtime-jar. Compare `7a6b5c6` → `5eeb7c9`, file `docs/privacy.md`. | https://github.com/huiliuxu780/WorkPal/actions/runs/39189580308 | 28s |
| pure UI proof #69 | `web`, `CI result`. 666 web unit tests + focused E2E `settings-shell` + `ui-appearance` (3 passed). Worker/AgentScope/image skipped. | https://github.com/huiliuxu780/WorkPal/actions/runs/39190009372 | 2m34s |
| runtime / `prompts/*.md` proof #70 | `agentscope`, `agent-runtime-image`, `runtime-jar`, `CI result`. `worker-chain` skipped. Prompt markdown was not classified as docs. | https://github.com/huiliuxu780/WorkPal/actions/runs/39189588261 | 5m48s |
| Worker proof #71 | `backend`, `worker-chain`, `runtime-jar`, `CI result`. `agentscope` and image skipped. `worker-chain` job 9m34s (lease wait kept). Used `agent-runtime-jar-<sha>` from this commit. | https://github.com/huiliuxu780/WorkPal/actions/runs/39191111946 | 10m32s |
| selected-job failure proof #72 | `docs` failed on a broken relative link; unselected jobs skipped; `CI result` failed with `selected job docs was failure`. | https://github.com/huiliuxu780/WorkPal/actions/runs/39189599439 | 31s |
| `workflow_dispatch` `mode=full` | every job including `docs`, `web`, `backend`, `runtime-jar`, `agentscope`, `worker-chain`, `agent-runtime-image`, `CI result` | https://github.com/huiliuxu780/WorkPal/actions/runs/39190028868 | 10m41s |

Duplicate push/PR: implementation and proof branches produced **only** `pull_request` (plus the intentional `workflow_dispatch`). No `push` workflow on those branches.

GHCR: image jobs on PRs and on `workflow_dispatch` built without login/push. Publish remains `event_name == push && ref == refs/heads/main`.

Temporary proof PRs #68–#72 are closed after this note. They must not merge to `main`.

Admin follow-up: none required for protection (none configured). Optional later: make `CI result` the required check.

## What this change does not do

- Does not shorten or skip the five-minute worker lease recovery.
- Does not delete or weaken product tests.
- Does not fix the screenshot nightly workflow.
- Does not deploy.
