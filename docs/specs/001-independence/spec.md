# SPEC-001 — WorkPal Independence Migration

Status: Ready for implementation planning  
Architecture dependency: `docs/architecture/workpal-architecture.md`  
Date: 2026-10-07

## 1. Objective

Convert the current repository from an inherited/fork-oriented codebase into an independently named and governed WorkPal codebase **without changing product behavior**.

This spec is deliberately narrow.

It is not the Agent Policy refactor, Execution Router, Group Router, Runtime Resolver, Batch redesign, or production-scaling work.

The outcome of SPEC-001 is an independent WorkPal baseline from which later specs can evolve safely.

## 2. Success condition

After this migration:

- WorkPal is the only active product/architecture name in product-facing and current engineering documentation.
- internal package namespaces are owned by WorkPal;
- environment and deployment naming is WorkPal-owned;
- the repository no longer documents an upstream synchronization strategy as part of active development;
- required third-party license/attribution obligations remain intact;
- runtime behavior is unchanged;
- API behavior is unchanged unless a rename is strictly internal/non-breaking;
- database semantics are unchanged;
- AgentScope behavior is unchanged.

## 3. Non-goals

SPEC-001 must not:

- redesign the UI;
- redesign Agent/Bot semantics;
- rename database tables solely for aesthetics;
- introduce Execution Router;
- introduce Planned or Durable Harness;
- change group routing;
- change AgentScope runtime behavior;
- migrate Python to Java;
- change memory behavior;
- change Skill semantics;
- change MCP/approval behavior;
- introduce Qoder/A2A;
- delete working inherited modules only because their origin is historical;
- perform opportunistic refactors unrelated to independence.

## 4. Current repository facts that matter

The current repository still contains historical identifiers in active implementation and documentation.

Known examples include:

- package imports using `@rakazo/*`;
- `docs/fork-baseline.md`;
- `docs/upstream-sync.md`;
- runtime strings/comments referring to historical naming;
- sandbox paths such as `/home/rakazo`;
- compatibility comments and messages inherited from the original codebase.

The migration must be evidence-driven: run repository-wide scans rather than assuming the list above is complete.

## 5. Source-of-truth rule

During SPEC-001:

1. `docs/architecture/workpal-architecture.md` is the architecture authority.
2. This spec is the implementation authority for independence migration.
3. Existing docs such as `fork-baseline.md` and `upstream-sync.md` are historical input, not future architecture authority.
4. Required third-party license notices override branding cleanup where legally required.

## 6. Migration categories

### 6.1 Product-visible branding

Scan and migrate product-visible references:

- page titles;
- UI copy;
- login/onboarding copy;
- settings labels;
- favicon/manifest metadata where relevant;
- README current-state language;
- VISION current-state language;
- Docker/container names visible to operators;
- CLI/help output;
- errors or status strings intended for users/operators.

Target active product name: **WorkPal**.

Do not modify third-party license attribution.

### 6.2 Package namespace

Migrate owned workspace packages from historical namespace to WorkPal-owned namespace.

Target pattern:

```text
@workpal/*
```

Expected workspace areas to inspect include:

```text
apps/api
apps/web
apps/worker

packages/adapter-kit
packages/adapters
packages/auth
packages/chat-ui
packages/contracts
packages/core
packages/db
packages/logging
packages/memory
packages/testkit
packages/ui-tokens
packages/ui-web

infra/sandboxes/supervisor
```

Requirements:

- package `name` fields are updated consistently;
- all workspace imports are updated;
- tsconfig/build aliases are updated;
- tests/fixtures that assert package names are updated only when they intentionally assert the old identifier;
- lockfile/workspace metadata is regenerated using the repository's normal package-manager flow;
- no temporary duplicate old/new package namespace should survive after the migration completes.

### 6.3 Environment variables

Run a complete scan for environment variables containing historical naming.

For WorkPal-owned variables, target:

```text
WORKPAL_*
```

Do not rename third-party provider variables such as official OpenAI/Anthropic/GitHub/etc. environment names.

For each renamed environment variable:

- update `.env.example`;
- update readers;
- update tests;
- update Docker/Compose;
- update self-host docs;
- update deployment examples.

Compatibility aliases should be avoided unless changing the variable immediately would break a documented external deployment contract. If an alias is necessary, it must have an explicit removal date/spec.

### 6.4 Docker / Compose / deployment identity

Inspect:

- compose service/container names;
- Docker image names/tags;
- volume/network names;
- healthcheck labels;
- deployment documentation;
- sandbox supervisor identity;
- host directories;
- operator-facing commands.

Owned names should become WorkPal names.

Do not break external provider conventions.

### 6.5 Filesystem paths

Historical local/sandbox paths such as:

```text
/home/rakazo
/home/rakazo/workspace
/home/rakazo/.config
```

must be inventoried before replacement.

This is not a blind string replacement.

For each persistent path decide:

1. ephemeral runtime path: rename directly if safe;
2. persisted user/sandbox path: design migration or compatibility mount;
3. test fixture only: update fixture;
4. third-party path/reference: leave unchanged.

No path rename may silently orphan persisted user data.

### 6.6 Documentation

Create an explicit separation:

#### Active WorkPal docs

Describe current/future WorkPal architecture only.

#### Historical docs

`docs/fork-baseline.md` and `docs/upstream-sync.md` must not remain active architecture guidance.

Preferred handling:

- move them under `docs/history/`, or
- prepend a strong historical/deprecated banner if moving creates unnecessary link breakage.

They must state that WorkPal no longer follows an upstream synchronization strategy.

### 6.7 Comments and source strings

Repository-wide scan historical names and classify each occurrence:

```text
A. product-owned active identifier       -> rename
B. active source comment                 -> rewrite in WorkPal terminology
C. compatibility/migration reference     -> keep only when technically required
D. license/copyright attribution         -> preserve
E. historical documentation              -> archive/deprecate
F. external URL/package/protocol name     -> preserve if factually required
```

Do not run a global replace without classification.

## 7. Database migration policy

SPEC-001 does **not** rename core database tables such as `Bot` merely to match future terminology.

Database renames have high migration cost and no immediate independence benefit.

Allowed database changes in SPEC-001:

- none by default;
- only changes required to remove an active product namespace that affects correctness or externally visible data.

Any database schema migration discovered during implementation requires a separate review before execution.

## 8. API compatibility policy

SPEC-001 should not redesign API contracts.

Internal TypeScript import/package names may change.

Public/current API routes should remain stable unless the route itself exposes obsolete product branding. If such routes exist:

- inventory them;
- propose migration separately;
- prefer compatibility before removal.

Do not combine API redesign with namespace migration.

## 9. Git/upstream policy

After SPEC-001:

- WorkPal does not document or depend on an upstream merge workflow;
- no active architecture decision requires compatibility with upstream implementation choices;
- external projects may be researched as references, not treated as authoritative source trees.

Local developer Git remotes are outside application code and cannot be reliably enforced by repository contents. Repository documentation must not instruct future developers to synchronize upstream.

## 10. License and attribution

Do not delete required open-source attribution.

Before deleting or rewriting any LICENSE/NOTICE attribution:

- identify the license requirement;
- preserve required copyright notices;
- preserve required license text;
- record third-party origins in `THIRD_PARTY_NOTICES` if appropriate.

Product branding cleanup is not a license-cleanup task.

## 11. Proposed PR breakdown

### PR 001-A — Authority docs and product-visible branding

Scope:

- add WorkPal architecture source of truth;
- add SPEC-001;
- update current README/VISION product identity;
- identify/archive obsolete fork/upstream guidance;
- remove visible obsolete branding where behavior is unaffected.

No package namespace migration yet.

### PR 001-B — Workspace package namespace

Scope:

```text
@historical/*
 ->
@workpal/*
```

Update package manifests, imports, build references, tests and lockfile.

No business logic changes.

### PR 001-C — Environment and deployment naming

Scope:

- WorkPal-owned env vars;
- Docker/Compose;
- container/image names;
- operational docs.

No AgentScope behavior changes.

### PR 001-D — Filesystem/path migration

Scope:

- classify historical runtime paths;
- migrate safe ephemeral paths;
- add explicit compatibility/migration behavior for persisted paths where needed;
- tests for preservation.

### PR 001-E — Residual audit

Run scans and classify every remaining historical reference.

Every remaining occurrence must be one of:

- legal attribution;
- archived history;
- required compatibility;
- external factual reference.

No unexplained active historical product identifier remains.

## 12. Required repository scans

Before implementation and again before completion, scan at minimum for:

```text
Rakazo
rakazo
@rakazo/
RAKAZO_
/home/rakazo
fork
upstream
```

The words `fork` and `upstream` are context-sensitive; they are not automatically errors.

Also inspect:

- package.json files;
- pnpm lock/workspace config;
- TypeScript path aliases;
- Dockerfiles;
- compose files;
- `.env.example`;
- CI workflows;
- shell scripts;
- docs;
- test snapshots/fixtures;
- Python strings;
- sandbox images/supervisor config.

## 13. Testing requirements

Every PR must preserve the repository's existing test baseline.

Minimum checks:

- workspace install/lockfile consistency;
- TypeScript compile/typecheck;
- unit tests for affected packages;
- API tests;
- Worker tests;
- AgentScope Python tests when a change touches runtime-facing strings/contracts;
- web build;
- existing E2E smoke tests relevant to renamed UI/config.

For pure rename commits, failures caused by stale expected strings must be updated only after confirming behavior is unchanged.

## 14. Rollback strategy

Each PR should remain independently revertible.

Do not mix:

- namespace migration;
- runtime behavior change;
- database redesign;
- execution routing;
- group routing.

Path migrations that touch persisted data need a reversible migration plan before merge.

## 15. Definition of Done

SPEC-001 is done when:

- active product documentation calls the product WorkPal;
- active package namespaces are WorkPal-owned;
- active WorkPal-owned env/deployment identifiers are WorkPal-owned;
- obsolete upstream-sync guidance is archived/deprecated;
- required third-party attribution remains;
- no unexplained active historical brand references remain;
- no persistent data path is silently orphaned;
- all existing behavior-critical tests pass;
- AgentScope runtime behavior is unchanged;
- product API semantics are unchanged;
- the next development spec can work from an independent WorkPal baseline.

## 16. Explicit handoff to SPEC-002

SPEC-001 must not begin the Prompt/Agent Policy redesign.

After SPEC-001 completes, the next architecture implementation spec is:

```text
SPEC-002 — Agent Policy & Prompt Architecture
```

Its job will be to extract the current effective system-prompt construction out of the large executor while preserving behavior before changing policy.
