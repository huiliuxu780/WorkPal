# SPEC-001 Acceptance Checklist

Use this checklist during PR review. A box should only be checked with repository evidence.

## A. Architecture authority

- [ ] `docs/architecture/workpal-architecture.md` exists and is referenced as the current architecture authority.
- [ ] Active docs do not treat a historical upstream project as WorkPal's architecture authority.
- [ ] Independence is defined as product/architecture ownership, not deletion of legal attribution.

## B. Branding

- [ ] Current README uses WorkPal as the active product name.
- [ ] Current VISION uses WorkPal as the active product name.
- [ ] UI-visible active branding is WorkPal.
- [ ] Operator-visible WorkPal-owned service/container names are WorkPal.
- [ ] Required legal attribution remains untouched.

## C. Package namespace

- [ ] All owned workspace package manifests use the WorkPal namespace.
- [ ] Workspace imports use the WorkPal namespace.
- [ ] TypeScript/build aliases use the WorkPal namespace.
- [ ] Lockfile is consistent.
- [ ] No active old package namespace remains except documented compatibility/history/legal cases.

## D. Environment and deployment

- [ ] WorkPal-owned environment variables use `WORKPAL_*` where migration is safe.
- [ ] `.env.example` is updated.
- [ ] Compose/Docker config is updated.
- [ ] Self-host docs are updated.
- [ ] Any temporary compatibility alias is explicitly documented with a removal plan.

## E. Filesystem paths

- [ ] Every historical product-owned filesystem path is classified.
- [ ] Ephemeral paths are safely renamed.
- [ ] Persisted paths have a migration/compatibility strategy.
- [ ] No persisted workspace/home data becomes unreachable after upgrade.
- [ ] Path migration has tests where risk exists.

## F. Historical docs

- [ ] `docs/fork-baseline.md` is archived or clearly marked historical/deprecated.
- [ ] `docs/upstream-sync.md` is archived or clearly marked historical/deprecated.
- [ ] Active docs do not instruct developers to keep WorkPal synchronized with an upstream product.

## G. Residual scan

Search:

```text
Rakazo
rakazo
@rakazo/
RAKAZO_
/home/rakazo
```

For each remaining occurrence:

- [ ] legal attribution; or
- [ ] archived historical material; or
- [ ] explicit compatibility logic; or
- [ ] external factual reference.

No unexplained active occurrence remains.

## H. Behavior preservation

- [ ] No database domain redesign was introduced.
- [ ] No Execution Router was introduced.
- [ ] No Group Router redesign was introduced.
- [ ] No AgentScope runtime behavior was intentionally changed.
- [ ] No memory/skill ownership change was introduced.
- [ ] No API redesign was bundled into the rename.

## I. Verification

- [ ] package install / lockfile verification passes.
- [ ] TypeScript typecheck passes.
- [ ] affected unit tests pass.
- [ ] API tests pass.
- [ ] Worker tests pass.
- [ ] AgentScope tests pass if runtime-facing code was touched.
- [ ] web build passes.
- [ ] relevant E2E smoke tests pass.

## J. Final review question

A reviewer should be able to answer **yes** to both:

1. Could WorkPal now evolve without consulting an upstream product's architecture or merge history?
2. Did this migration avoid changing how the Agent product actually behaves?

If either answer is no, SPEC-001 is not complete.
