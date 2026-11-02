# GROUP-DM-GATE-01 baseline

- Date: 2026-11-02 (Asia/Shanghai)
- Baseline: `origin/main` @ `7457961b4018e18248732f8df2bb577ce5cb3b23` (`Merge pull request #165 from huiliuxu780/codex/share-01`, the merge of SHARE-01/01b)
- Branch: `codex/group-dm-gate-01`
- Checkout: repository root of `codex/group-dm-gate-01`
- #160 (`feat(web): deliver the four-shell interaction contract`) merge commit `4767b3c2a83ad76276a6b5b15c4db6e50f88b9f1` is an ancestor of the baseline.
- No uncommitted changes were carried into the branch: it was created from the clean `origin/main` above.

## Producer / gate symbols (G0)

All intervention pauses funnel through one producer:

- `packages/db/src/events.ts:1652` `pauseRunForInput` — the FS-F10 gate runs here **before** opening the transaction. It rejects an ordinary addressable `ask` block when the Run's execution Thread belongs to a standard (human) chat group (`groupId != null && group.kind === "standard"`). Approvals (`approvalEffectId`), plan reviews (`planReview`), budget confirmations (`budgetExceeded`) and manual-retry confirmations (`manualRetryEffectId`) are decisions with their own owner-only paths and stay allowed. Agent-pair collaboration Threads (`kind === "agent_pair"`) are not a human group conversation and are exempt.
- `packages/db/src/interventions.ts:1055` `GROUP_INPUT_REQUEST_REJECTED` — stable rejection code.
- `packages/db/src/interventions.ts:1057` `GroupInputRequestRejectedError` — carries `code`, `threadId`, `groupId`.
- Call sites in `packages/adapters/src/executor.ts`: runtime `ask` event (`pauseRunForInput` around the event loop), tool approval (`requestApproval`), manual-retry confirmation (`manualRetryUncertainAsk`), secret request, and plan review — every one goes through the same producer.
- Message-backed approvals that never pause the Run (MCP assignment `mcp_approval` blocks) are not `input_request`s and are unaffected.
- Consequential owner-only checks: `packages/db/src/interventions.ts:1070` `resolveInterventionInTransaction` (approval, credential secret, manual-retry review → `{ outcome: "rejected", reason: "forbidden" }`) and `packages/db/src/events.ts:813` `commitAnswerRunInput` (manual-retry choice ask → returns `null` for a non-owner).
- API mapping already exists: `apps/api/src/router.ts` maps `reason === "forbidden"` to `ORPCError("FORBIDDEN")`.
- Run-level retry (must stay): `apps/web/src/components/ai/ExecutionCard.tsx` + `apps/web/src/lib/execution-card.ts:93` `retryAction`.

## Local verification prerequisites

The local PostgreSQL server runs with `timezone = Asia/Shanghai`, while Prisma stores `timestamp` columns as UTC wall time. Lease-expiry comparisons use `clock_timestamp()`, so local e2e/postgres runs must force a UTC session (`PGOPTIONS='-c timezone=UTC'` for postgres tests, or a database created with `SET timezone TO 'UTC'` for e2e). CI uses UTC and does not need this. Without it, local runs fail with `StaleExecutionError: lease_expired`; this is an environment prerequisite, not a product defect.
