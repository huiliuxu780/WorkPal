# Gate-leak A/B for the harness batch split (`7e46357`)

## What had to be proven

CI went red at head `ebd3153` (run
[40524098700](https://github.com/huiliuxu780/WorkPal/actions/runs/40524098700),
web job `122258909243`): the selected spec union mixed card-gated specs with
legacy specs, one harness process enabled `CARDS_UNIFIED_V2_ENABLED` for all of
them, and `login-card.spec.ts` plus `onboarding-conversation.spec.ts` failed on
the legacy surfaces they assert.

Commit `7e46357` splits an exact-name spec list into a gate-off batch and a
gate-on batch, each with its own API/Web/DB lifecycle. A unit test
(`packages/testkit/src/cli/e2e-spec-selection.test.ts`) pins the split, but the
claim that matters is behavioural: **the same real E2E batch fails before the
split and passes after it.**

The CI pair alone does not prove that, because `ebd3153 → 7e46357` also contains
`df78a01` (application changes). So the split was isolated locally: identical
application code in every run, only the two harness files differ.

## Runs

All three used the exact spec union CI selected for `ebd3153`, passed as one
`--spec` argument, with `--runtime=scripted` and a fresh disposable
`workpal_e2e_*` database per run.

| Run | Harness | Database | Result |
| --- | --- | --- | --- |
| A | `harness.ts` + `e2e-spec-selection.ts` from `df78a01` (pre-split; `grep -c splitGateBatches` → 0) | `workpal_e2e_gateab_a` | EXIT=1 — one process, 22 tests: **3 failed / 19 passed**. `login-card.spec.ts` (no `secret-ask-card`) and `onboarding-conversation.spec.ts` (no legacy Slack "Connected") are the gate leak; `group-membership.spec.ts:129` is the separate read-once race |
| B | as committed at `7e46357` (`git diff --stat HEAD -- packages/testkit/` empty) | `workpal_e2e_gateab_b` | gate-off batch **8 passed**; gate-on batch 13 passed / 1 failed — the only remaining failure is `group-membership.spec.ts:129`, i.e. the leak is gone |
| C | as committed at `7e46357`, plus the membership effect-status poll | `workpal_e2e_gateab_c` | **EXIT=0** — gate-off 8 passed, gate-on 14 passed (22/22) |

Logs: [`A-mixed-batch-red.txt`](./A-mixed-batch-red.txt),
[`B-split-batches.txt`](./B-split-batches.txt),
[`C-split-batches-green.txt`](./C-split-batches-green.txt).

The `group-membership.spec.ts:129` failure in A and B is documented with its
database evidence in
[`../membership-effect-race/README.md`](../membership-effect-race/README.md): the
row reached `completed` 1.9 s after the single read, so the product behaviour was
correct and the assertion was racing it.

## CI corroboration (same union, real runners)

| Head | Run / web job | Batches | Outcome |
| --- | --- | --- | --- |
| `ebd3153` (pre-split) | 40524098700 / 122258909243 | one process, 22 tests | failure — `login-card.spec.ts:4` and `onboarding-conversation.spec.ts:8` |
| `7e46357` (post-split) | 40526573873 / 122269823955 | gate-off 5 specs → 8 passed; gate-on 5 specs → 14 passed | success, whole run green |

The post-split CI log shows the harness printing `E2E: gate-off batch` and
`E2E: gate-on batch` and re-invoking itself with the two exact-name sublists,
which is the same behaviour runs B and C reproduced locally.

## Reproduce

```sh
# A: pre-split harness, identical application code
git checkout df78a01 -- packages/testkit/src/cli/harness.ts \
                        packages/testkit/src/cli/e2e-spec-selection.ts
export WORKPAL_E2E_DATABASE_URL="<root DATABASE_URL, database name workpal_e2e_...>"
pnpm test:e2e --runtime=scripted --spec="card-attention.spec.ts|ui-appearance.spec.ts|settings-shell.spec.ts|card-ui-interactions.spec.ts|peer-messages.spec.ts|group-membership.spec.ts|card-display-content.spec.ts|onboarding-conversation.spec.ts|onboarding-model-auto-skip.spec.ts|login-card.spec.ts"

# B/C: restore the committed harness and repeat
git checkout HEAD -- packages/testkit/src/cli/harness.ts \
                     packages/testkit/src/cli/e2e-spec-selection.ts
```

Versions: node v22.23.3, pnpm 9.15.0, Playwright (repository-pinned), git HEAD
`7e463570f5f86ee9e792a65b509ee41fe4a8c13e`. Full local logs were not committed
(they contain the E2E server's request logs); each excerpt records the line
numbers it was taken from and the run's exit code.
