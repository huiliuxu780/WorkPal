# GROUP-DM-GATE-01 evidence report

- Date: 2026-11-02 (Asia/Shanghai)
- Baseline: `origin/main` @ `7457961b4018e18248732f8df2bb577ce5cb3b23` (merge of PR #165)
- Code head: `0b0ff7e3ac4c685c662b5c7ced85e34ee00a8a63` (all checks below were run against this commit)
- Branch: `codex/group-dm-gate-01` · worktree `/Users/rivers/Documents/WorkPal-worktrees/group-dm-gate-01`
- Scope: only the hard-gate items left partial/unrun in #160. No four-shell visuals, no payment, no display updating, no card width, no CONNECTIONS/BRAND.

## 0. Verdict

| Item | Verdict |
|---|---|
| GDG-01 producer rejects group addressable input | **PASS** |
| GDG-02 group ask renders guidance, nothing submittable | **PASS** |
| GDG-03 direct-chat ask stays answerable | **PASS** |
| GDG-04 group approval has no `always` | **PASS** |
| GDG-05 non-owner resolve → forbidden, no state advance | **PASS** |
| GDG-06 owner resolve → accepted | **PASS** |
| GDG-07 expired/uncertain honesty, no re-run | **PASS** |
| GDG-08 Run-level `retryAction` intact | **PASS** |

Stop line reached: the PR is opened for review and **not merged**. Nothing below is marked PASS from a text-only claim; every row points at a log, screenshot, unit test or PostgreSQL assertion that was executed in this worktree.

## 1. What changed

1. **Producer gate (FS-F10 / AC-18)** — `pauseRunForInput` (`packages/db/src/events.ts`) now rejects an ordinary addressable `ask` when the Run's own execution Thread is a standard chat group. It throws `GroupInputRequestRejectedError` with stable code `GROUP_INPUT_REQUEST_REJECTED` **before any write**; the Run fails with the error text, and no intervention/message is created. Approvals, plan reviews, budget and manual-retry confirmations are excluded because they are decisions, not addressable inputs; hidden agent-pair Threads are exempt.
2. **Owner-only decisions (FS-F14/F15 / AC-09/19)** — `resolveInterventionInTransaction` (`packages/db/src/interventions.ts`) now also treats a manual-retry review ask as owner-only, and `commitAnswerRunInput` (`packages/db/src/events.ts`) refuses a manual-retry choice answer from anyone but the Run owner. Approval/credential/manual-retry paths were already owner-scoped; the tests now prove the second account is rejected and that nothing advances.
3. **FS-F16 honesty** — `ActionApprovalCard` adds expired / cancelled / unconfirmed outcome notes; `InputRequestCard` explains that an expired or cancelled question is closed and must be asked again in a new message. Interaction/approval cards still have **no Retry / 重新执行** entry. `ExecutionCard` and `execution-card.ts` were not touched; Run-level Retry / View retry is preserved.
4. **i18n** — new honest-note msgids in `en` and `zh-CN`, plus `Effect expired` → 操作已过期, `Effect result unknown` → 操作结果未确认, `Ended` → 已结束. No "已作废" wording is used for uncertain/expired external effects.

## 2. Producer symbol and rejection code

- Gate: `packages/db/src/events.ts:1652` `pauseRunForInput` (checks `input.blocks` for `kind === "ask"` without `approvalEffectId` / `planReview`, then loads `thread.groupId` + `group.kind`).
- Error: `packages/db/src/interventions.ts:1057` `GroupInputRequestRejectedError`; code `packages/db/src/interventions.ts:1055` `GROUP_INPUT_REQUEST_REJECTED = "GROUP_INPUT_REQUEST_REJECTED"`.
- Message: `Group threads cannot open an addressable input request; ask in text instead.`
- All executor pause producers go through this function: runtime `ask` event, tool approval, manual-retry confirmation, secret request. Message-backed `mcp_approval` cards do not pause the Run and are not addressable inputs.

## 3. Dual-account construction

`packages/db/src/intervention.postgres.test.ts` creates **two users** in one Space (`id` owner, `otherUserId` non-owner; both real `user` rows). The owner creates the Run + external effect, then:

1. non-owner calls `resolveIntervention` → asserts `{ outcome: "rejected", reason: "forbidden" }` **and** intervention `pending`, external effect `intended`, Run `waiting_input` (no state advancement);
2. owner calls `resolveIntervention` → asserts `accepted`, approval decision/effect status advance, no secret leaks into the projection;
3. the manual-retry variant in `manual-retry.postgres.test.ts` asserts a foreign `answerRunInput` returns `false` and `reviewDecision` stays `null` before the owner succeeds.

The API already maps this reason to `ORPCError("FORBIDDEN")` in `apps/api/src/router.ts`, so the UI cannot "hide the button" in place of a server refusal.

## 4. AC matrix

| ID | How it was verified | Result | Evidence |
|---|---|---|---|
| **GDG-01** | PostgreSQL: group Thread ask → `GroupInputRequestRejectedError` + `GROUP_INPUT_REQUEST_REJECTED`, zero interventions/messages, Run still running; same ask in a DM pauses; group approval still pauses. Real chain: `group-chats.spec.ts` group mention of a Bot that asks now ends `failed`, no submit card; DB shows the two failed Runs with the gate error and zero interventions on group threads. | PASS | `checks/group-producer-approval.log`; `checks/e2e-group-chats.log` (1 passed); `checks/producer-group-failure.txt` |
| **GDG-02** | Real group page with the server-projection shape injected: an `input_request` renders the text question and "Open the direct chat with this Bot", **no** textarea, **no** `input-card-submit`; no @-me badge. | PASS | `screenshots/GDG-02-group-ask.png`; `e2e/card-ui-interactions.spec.ts` step in `checks/e2e-card-ui-interactions.log` (4 passed) |
| **GDG-03** | Direct chat, real scripted Run ("run 1 tracked steps then ask"): the same question renders an answerable `input_request` with textarea + submit. | PASS | `screenshots/GDG-03-dm-ask.png`; same e2e log |
| **GDG-04** | Group tool-approval card keeps Allow once / Deny and **drops** "Always allow this tool"; server data still carries `always` in the fixture, so the absence is the UI rule, not missing data. | PASS | `screenshots/GDG-04-group-approval.png`; same e2e log |
| **GDG-05** | Non-owner `resolveIntervention` → forbidden; intervention pending, effect intended, Run waiting_input; manual-retry non-owner answer → false and no decision. | PASS | `checks/non-owner-forbidden.log`; `checks/manual-retry-owner.log` |
| **GDG-06** | Owner `resolveIntervention` → accepted; approval decision and effect status advance (`approved`/`denied`); Run queued on allow. | PASS | `checks/non-owner-forbidden.log` |
| **GDG-07** | Expired approval: card has no Retry / 重新执行 and no decision buttons, shows "Effect expired" + honest note; uncertain effect shows "result … not confirmed"; expired input has no textarea/submit and explains the question is closed. | PASS | `screenshots/GDG-07-expired-no-rerun.png`; `checks/interaction-no-rerun.log`; `checks/e2e-card-ui-interactions.log` |
| **GDG-08** | `execution-card.test.ts` "adds Retry beside View reason…", "shows Retrying…", "offers View retry…" all pass; `ExecutionCard.tsx` / `execution-card.ts` are unmodified. | PASS | `checks/execution-card-retry.log` |

## 5. Commands and results

| Command | Result | Log |
|---|---|---|
| `pnpm --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/web check` | exit 0 | `checks/typecheck.log` |
| `pnpm exec vitest run apps/web/src/components/ai/interactions/InteractionCards.test.tsx apps/web/src/lib/execution-card.test.ts` | 84 passed | `checks/unit-cards.log` |
| `pnpm --filter @rakazo/web test` | 103 files / 817 tests passed | `checks/unit-web.log` |
| `pnpm --filter @rakazo/web build` | exit 0 | `checks/build.log` |
| `pnpm test:inventory` | 578 tracked files, 0 errors | `checks/inventory.log` |
| `PGOPTIONS='-c timezone=UTC' VERIFY_DATABASE=1 DATABASE_URL=<migrated disposable DB> pnpm test:postgres` | 57 files / 498 tests passed | `checks/postgres-group.log` |
| targeted intervention / manual-retry / card tests | passed (see logs) | `checks/postgres-targeted.log`, `checks/group-producer-approval.log`, `checks/non-owner-forbidden.log`, `checks/manual-retry-owner.log`, `checks/interaction-no-rerun.log`, `checks/execution-card-retry.log` |
| `pnpm test:e2e --runtime=scripted --spec='card-ui-interactions.spec.ts'` | 4 passed | `checks/e2e-card-ui-interactions.log` |
| `pnpm test:e2e --runtime=scripted --spec='group-chats.spec.ts'` | 1 passed | `checks/e2e-group-chats.log` |
| `pnpm test:e2e --runtime=scripted --spec='card-attention.spec.ts'` | 3 passed | `checks/e2e-card-attention.log` |
| `pnpm test:e2e --runtime=scripted --spec='group-membership.spec.ts'` | 3 passed | `checks/e2e-group-membership.log` |
| `pnpm test:e2e --runtime=scripted --spec='message-group.spec.ts'` | 1 passed | `checks/e2e-message-group.log` |

E2E was run against a disposable local PostgreSQL database created with `SET timezone TO 'UTC'` (`WORKPAL_E2E_DATABASE_URL` guard satisfied); logs are from the exact code in this branch. The full postgres suite requires a migrated base database (the disposable e2e DB is used here) and `PGOPTIONS='-c timezone=UTC'` on this machine because the local server's session timezone is Asia/Shanghai; CI uses UTC.

## 6. Regression coverage updated for the gate

- `apps/web/e2e/group-chats.spec.ts`: the old group-ask expectation became a producer-rejection assertion (Run failed, no intervention inputs, no question text) followed by a normal mention used only for the isolation checks.
- `apps/web/e2e/card-attention.spec.ts`: the N2 group item is now an owner-only tool approval (`approvalRules/set` + destination write) instead of a group ask, matching the gate.
- `apps/web/e2e/card-ui-interactions.spec.ts`: new group/DM/expired test (GDG-02/03/04/07).
- Unit: `InteractionCards.test.tsx` "explains expired and unconfirmed outcomes without offering a re-run".

## 7. Non-goals / untouched

- `apps/web/src/components/ai/ExecutionCard.tsx` and `apps/web/src/lib/execution-card.ts` were **not modified**; Run-level Retry / View retry semantics are unchanged.
- No payment two-step (AC-10), no display `updating` / projection reload (AC-16), no card width 662/704 (AC-02), no four-shell visual work, no ATTENTION/@-me badge, no `cards_unified_v2` default change.
- No CONNECTIONS / SHARE / REPORT / BRAND changes.

## 8. Honest limits

- GDG-02/04/07 render on the real group page with the server-projection interaction views injected at `/rpc/threads/get`, because the producer gate intentionally prevents a group Run from persisting such a pending row. GDG-01/03 use the real producer end to end. GDG-05/06 are PostgreSQL-level, with the API mapping verified in `router.ts`.
- No screen recording was captured for the group flow; the required screenshots plus the e2e log are provided. The page snapshots and assertions are in the Playwright log.
