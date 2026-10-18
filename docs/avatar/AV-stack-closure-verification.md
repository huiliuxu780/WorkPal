# Avatar stack closure verification

Date: 2026-10-18 (UTC+8)  
Stack head: `codex/av05-avatar-change-history @ 355d133`  
Runtime: Node 24.21.0, pnpm 9.15.0, local disposable PostgreSQL, scripted E2E runtime

This record makes the reported `612 / 15 / 6` result independently reproducible from the repository. The AV-05 head contains the stacked AV-00 through AV-04 changes, so these commands exercise the final combined avatar tree before the stack is reconciled with the newer `main`.

## Results

### Web and UI unit tests: 612/612

```bash
pnpm exec vitest run packages/ui-web/src apps/web/src
```

Result: 87 test files passed, 612 tests passed, 0 failed.

### Avatar PostgreSQL tests: 15/15

After `pnpm --filter @rakazo/db generate`, run against a local disposable PostgreSQL connection:

```bash
VERIFY_DATABASE=1 DATABASE_URL=<local-disposable-postgres-url> \
  pnpm exec vitest run \
  packages/db/src/repos-avatar.postgres.test.ts \
  packages/db/src/avatar-activity.postgres.test.ts \
  packages/db/src/avatar-changes.postgres.test.ts \
  packages/db/src/avatar-migration.postgres.test.ts
```

Result: 4 test files passed, 15 tests passed, 0 failed. The per-file counts are 3 assignment, 3 activity projection/acknowledgement, 8 change-history/Undo, and 1 legacy migration test. Each file uses its own database cloned from the migrated template and drops the clone afterward.

### Focused Avatar E2E: 6/6

The Playwright file filter was first checked with `--list`; it selected exactly six tests in five files: Bot-requested change, group avatar, reduced motion, two Studio cases, and character silhouettes.

```bash
WORKPAL_E2E_DATABASE_URL=<local-disposable-workpal_e2e-database-url> \
  pnpm test:e2e \
  '--spec=avatar-(bot-change|group|motion|studio|style)\.spec\.ts'
```

Result: 6 passed in 48.2 seconds. The harness migrated a fresh database and ran the production Web/API wiring with the deterministic scripted runtime; this does not measure real-model willingness to follow a Bot avatar-change request.

## Collection false starts

- The first PostgreSQL invocation ran before Prisma client generation and failed during module collection with 0 tests. After the required generation step, the same four files passed 15/15.
- The first E2E filter, `--spec=avatar-`, was too broad for Playwright path matching and collected an unrelated legacy `browser-auth.spec.ts`, which failed import resolution before any Avatar test ran. The explicit five-file regex above was verified with `--list` and then passed 6/6.

Neither false start executed a failing Avatar assertion.

## Boundary

The broad `group-chats.spec.ts` is not included in the six-test Avatar closure set. [AV-05-implementation.md](./AV-05-implementation.md) records its two separate baseline differences: obsolete selectors and a scripted transcript that expects two mentioned Bots to answer while the current fixture answered one. The focused `avatar-group.spec.ts` passed here. This record does not claim the broad group suite is green.
