#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

pnpm --filter @rakazo/db check
pnpm --filter @rakazo/adapters check
pnpm --filter @rakazo/api check

pnpm exec vitest run \
  packages/db/src/task-instructions.test.ts \
  packages/core/src/execution-snapshot.test.ts \
  packages/adapters/src/executor.test.ts \
  apps/api/src/router.test.ts

if [[ "${VERIFY_DATABASE:-}" != "1" || -z "${DATABASE_URL:-}" ]]; then
  echo "RT-14 PostgreSQL verification requires VERIFY_DATABASE=1 and DATABASE_URL." >&2
  exit 2
fi

pnpm --filter @rakazo/db exec vitest run --root ../.. \
  packages/db/src/task-instructions.postgres.test.ts \
  packages/db/src/manual-retry.postgres.test.ts \
  packages/db/src/intervention.postgres.test.ts \
  packages/db/src/origin-intervention.postgres.test.ts

pnpm check
git diff --check
