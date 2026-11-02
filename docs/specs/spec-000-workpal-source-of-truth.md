# SPEC-000 — WorkPal Source of Truth Cleanup

Status: **Ready for implementation**

Parent architecture: `docs/specs/workpal-product-harness-v1.4.md`

## 1. Goal

Make the repository express one unambiguous product truth:

> WorkPal is the product and orchestration layer. AgentScope is the only production Agent runtime. Rakazo is historical upstream/source material, not the product identity or current architecture authority.

This phase changes documentation and product-facing naming only where needed to remove contradictory guidance. It does **not** redesign runtime behavior.

## 2. Why this is Phase 0

Today a Coding Agent can read mutually conflicting instructions:

- `VISION.md` still defines Rakazo as the product.
- `README.md` describes WorkPal as built from Rakazo and intentionally retaining Rakazo identity.
- `AGENTS.md` still tells contributors to use Rakazo-named packages as if they define product architecture.
- `docs/fork-baseline.md` and `docs/upstream-sync.md` describe a long-lived Rakazo fork workflow.
- the new Product Harness spec defines WorkPal as an independent product harness with AgentScope as runtime.

Until this is corrected, later implementation specs can be interpreted against the wrong architecture.

## 3. Non-goals

Do not do any of the following in SPEC-000:

- no Router implementation;
- no Group Harness implementation;
- no database schema changes;
- no runtime behavior changes;
- no AgentScope behavior changes;
- no mass package rename from `@rakazo/*`;
- no broad directory moves;
- no dependency upgrades;
- no UI redesign;
- no deletion or rewriting of legally required Apache-2.0 attribution.

## 4. Files to change

### 4.1 `VISION.md`

Replace the current Rakazo-centered product vision with WorkPal product truth.

The rewritten file must state:

- WorkPal is a Web-first persistent Agent workspace/product.
- WorkPal owns Product Harness responsibilities: identity, long-lived threads, orchestration, routing, permissions, approvals, group collaboration, durable task/run state and observability.
- AgentScope is the only production Agent runtime.
- a Bot/Agent is a persistent identity, not a disposable prompt preset.
- Thread is conversation state; Run is execution state; Task/Run are not user-visible replacement conversations.
- Group chat uses a shared Thread while each Agent keeps isolated runtime state.
- WorkPal may reuse historical upstream implementation but upstream does not define current product direction.
- implementation details must defer to current WorkPal specs when old docs conflict.

Remove product statements that define Rakazo as the current product.

### 4.2 `README.md`

Rewrite the opening architecture description.

Required opening meaning:

```text
WorkPal is a Web-first persistent-agent platform.
The WorkPal application backend owns product state and orchestration.
Python AgentScope is the only production Agent executor.
```

Keep useful local-development, Compose and verification instructions when still accurate.

Remove or rewrite product-facing statements such as:

- "built from ... Rakazo application backend" as the current product identity;
- "preserve an auditable upstream relationship" as a top-level product goal;
- instructions that imply Rakazo defines future architecture.

It is acceptable to keep a short **Historical provenance** note near the end:

```text
Parts of WorkPal originated from Apache-2.0 upstream code. Required license and attribution are preserved. Historical provenance does not define current product architecture.
```

Do not remove Apache-2.0 notices.

### 4.3 `AGENTS.md`

Turn this into the concise repository rule file a Coding Agent should trust first.

It must include these invariants:

1. WorkPal product specs are authoritative for product direction.
2. AgentScope is the only production Agent runtime.
3. application backend owns auth, authorization, Agent/Bot, Thread, Message, Task/Run, routing, approvals, resources, concurrency, audit and recovery.
4. Thread != Run.
5. group shared Thread != shared AgentScope state.
6. Product Harness decisions belong outside AgentScope.
7. unimplemented behavior must fail/disable rather than simulate success.
8. do not expose or broaden credentials/resources from model output.
9. preserve existing frontend contracts unless an implementation spec explicitly changes them.
10. changes must follow the active implementation spec and avoid unrelated refactors.

Package names such as `@rakazo/*` may remain temporarily. Clarify that they are legacy technical namespaces and not architecture authority.

### 4.4 `docs/fork-baseline.md`

Do **not** delete it.

Add a prominent header:

```text
HISTORICAL REFERENCE ONLY
This document records the original code baseline. It is not current WorkPal product architecture and must not override VISION.md, AGENTS.md or docs/specs/.
```

Do not spend time rewriting the historical body.

### 4.5 `docs/upstream-sync.md`

This file currently encodes a fork workflow that no longer matches the intended product-development model.

For SPEC-000:

- mark it **Historical / maintenance-only**;
- state that upstream sync is optional code archaeology/maintenance, not product-direction synchronization;
- current WorkPal specs win on semantic conflicts;
- never merge upstream changes merely to preserve parity;
- any future upstream import must be cherry-picked/reimplemented intentionally at bounded interfaces.

Do not implement a new sync automation in this phase.

### 4.6 Product Harness architecture spec

Ensure this exists and is linked from the authority chain:

`docs/specs/workpal-product-harness-v1.4.md`

`VISION.md` should link conceptually to it as the current architecture baseline.

## 5. Authority order

After SPEC-000 the repository guidance order is:

```text
1. active Implementation Spec
2. docs/specs/workpal-product-harness-v1.4.md
3. VISION.md
4. AGENTS.md
5. implementation/operations docs
6. historical upstream/fork docs
```

When two sources conflict, the higher item wins.

Implementation Specs may refine architecture for their bounded change but must not silently overturn the parent Product Harness spec.

## 6. Naming policy

### Product-facing naming

New product-facing copy must use **WorkPal**.

Do not introduce new Rakazo-branded UI, docs headings, architecture terms, or user-facing strings.

### Internal technical namespaces

Existing `@rakazo/*` package names may remain in SPEC-000.

Reason:

- package names are not user-visible product identity;
- mass renaming creates a large low-value diff;
- it increases merge, import and test risk;
- package renaming can be handled later as a bounded mechanical migration if it has real maintenance value.

Do not add new packages under `@rakazo/*` unless an existing workspace convention requires it.

## 7. Legal attribution policy

WorkPal independence does not mean erasing upstream legal attribution.

Preserve:

- `LICENSE`;
- any legally required copyright notices;
- NOTICE files if present/required;
- attribution required by imported Apache-2.0 source.

Product branding and legal provenance are separate concerns.

## 8. Implementation method

The Coding Agent should:

1. read:
   - `docs/specs/workpal-product-harness-v1.4.md`
   - `VISION.md`
   - `README.md`
   - `AGENTS.md`
   - `docs/fork-baseline.md`
   - `docs/upstream-sync.md`
2. edit only the bounded documentation files unless a product-facing Rakazo string is directly referenced by them and clearly contradictory;
3. preserve accurate setup commands;
4. avoid speculative architecture additions beyond the parent spec;
5. run repository text searches for contradictory product claims;
6. report remaining Rakazo references by category:
   - legal attribution;
   - legacy package namespace;
   - historical documentation;
   - accidental product-facing reference.

Only the last category must be zero for SPEC-000 acceptance.

## 9. Required search/audit

At minimum search the repository for:

```text
Rakazo
@rakazo/
upstream
fork
PiAgentRuntime
Pi runtime
production runtime
```

Classify matches instead of blindly replacing them.

Do not replace:

- legal text;
- historical baseline content;
- package imports;
- migration history;
- tests that intentionally validate legacy compatibility.

Do replace or annotate:

- current product identity;
- current architecture guidance;
- contributor instructions that conflict with AgentScope-only production execution;
- current operational instructions that claim upstream parity is a goal.

## 10. Acceptance criteria

SPEC-000 passes when all are true:

- `VISION.md` defines WorkPal, not Rakazo.
- `README.md` defines AgentScope as the only production Agent executor.
- `AGENTS.md` defines WorkPal Product Harness boundaries.
- old fork/upstream docs are visibly historical and cannot reasonably be mistaken for current architecture authority.
- the Product Harness v1.4 spec is discoverable from repository guidance.
- no product-facing current documentation says Rakazo is the product.
- no product-facing current documentation says Pi is an allowed production runtime.
- Apache-2.0 attribution remains intact.
- no business/runtime/database behavior changed.
- the normal documentation-adjacent verification still passes.

## 11. Verification

Run at least:

```bash
git diff --check

grep -Rni --exclude-dir=.git "Rakazo" README.md VISION.md AGENTS.md docs | head -200
grep -Rni --exclude-dir=.git "PiAgentRuntime\|Pi runtime" README.md VISION.md AGENTS.md docs | head -200

pnpm check
```

If `pnpm check` fails for a pre-existing unrelated reason, record the exact failure and prove the documentation-only diff did not introduce it.

## 12. Deliverable

One focused commit, suggested message:

```text
docs: establish WorkPal architecture source of truth
```

The implementation report must include:

- files changed;
- contradictory claims removed;
- remaining Rakazo references classified by allowed category;
- verification results;
- confirmation that no runtime/database behavior changed.
