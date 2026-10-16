# AG-07 delivery: typed message provenance

Branch: `codex/ag07-message-provenance` (from merged ME-00 `8d263ad`). PR and final gate results are recorded in the roadmap row.

## Baseline audit and corrections

The code confirmed three distinct counterexamples to treating `role=user` as proof of a human author: Bot-to-Bot inbound messages use `role=user`; webhooks and group-channel fanout also use `role=user`; existing PostgreSQL rows have no author/source proof. AG-06's Java runtime additionally identified the three run-scoped application contexts by matching their body prefixes, so an ordinary message could impersonate one and be deleted on refresh. The new Java fixture proves that exact false-prefix case.

One task-card premise was too broad: a production search of `message.create`, `createMany` and `upsert` under `apps/` and `packages/` found **one** direct Prisma `message.create`, inside `createThreadMessageInTransaction`. Other modules call that function; there is no second direct production writer to migrate. The task-card instruction to audit it was still necessary, since all callers needed classification.

## Database contract and entry inventory

`Message.originKind` is a non-null string defaulting to `unknown`; `Message.authorUserId` is nullable. The migration adds columns without changing existing message IDs, blocks, sequence numbers, roles or thread membership. Every old row gets `unknown` and `NULL`, including rows whose role says `user`. The string catalog in `packages/contracts/src/message-provenance.ts` is `human_web`, `human_messaging`, `messaging_external`, `webhook`, `automation`, `bot`, `system`, `unknown`. `automation` is reserved for an automation-authored **message**; current Routine runs keep their prompt in Task/Run and do not create an input Message. Their model replies are `bot` messages. A future automation-message writer must label it explicitly.

The central writer defaults missing provenance to `unknown`/`NULL` and rejects human origins without a nonempty authenticated author or nonhuman origins with an author claim, before advancing the message sequence. The API derives the two fields from `Actor` or verified integration identity; the client/model text is never spread into them. The Web message DTO explicitly maps its existing fields, so the two storage fields do not appear in the Web conversation response.

| Production entry | Trusted identity / original role and trigger | Stored provenance | Evidence |
| --- | --- | --- | --- |
| Web send, follow-up, reaction, group turn | authenticated `Actor`, `role=user`, user/follow-up Run | `human_web`, `authorUserId=Actor.userId` | `thread-target.test.ts`, `router.test.ts`; forged client fields test |
| Direct messaging | provider event resolved through a stored MessagingIdentity, `role=user`, `trigger=messaging` | `human_messaging`, mapped user ID | `messaging-inbound.test.ts` |
| Group/TeamChat delivery and peer mirror | provider channel participant, owner ID is not the author; `role=user`, `trigger=messaging` | `messaging_external`, null author | `messaging-inbound.test.ts`, `messaging-delivery.test.ts`, TeamChat call-site audit |
| Webhook, GitHub delivery, messaging-triggered Routine | verified inbound route, `role=user`, `trigger=webhook` | `webhook`, null author | `webhook.test.ts`, messaging Routine tests |
| Bot collaboration / connected agent | authenticated source Run and target roster, inbound `role=user`, sender `role=bot`, recipient `trigger=bot_message` | `bot`, null author on both sides | `bot-messages.test.ts`, connected-agent call-site audit |
| Model reply, progress and terminal output; Routine and delivery Run output | authorized worker Run, `role=bot`, Run retains its trigger | `bot`, null author | executor and events completion paths; Java/worker integration |
| Intervention/wait/ack, call marker, onboarding, invite and child-creation notes | application-generated `role=system` or `role=bot` | `system`, null author | `events.test.ts`, router/onboarding/child-bot call-site audit |
| New or legacy caller without verified classification | no asserted author | `unknown`, null author | `messages.test.ts`, migration fixture |

Source is an entry-path claim, not content trust. In particular, a provider webhook payload may be false even when its delivery was authenticated. `userId` on a Run often denotes its owner and is **not** automatically a message author.

## Run-history wire and lifecycle

The backend sends a separate `provenance` object on history entries:

```json
{"id":"db-message-id","role":"user","content":"...","provenance":{"kind":"message","originKind":"human_web","authorUserId":"user-id"}}
{"role":"user","content":"...","provenance":{"kind":"application","contextKind":"compacted_summary","generation":0,"revision":"49"}}
{"role":"user","content":"...","provenance":{"kind":"application","contextKind":"semantic_recall","generation":0}}
{"role":"user","content":"...","provenance":{"kind":"application","contextKind":"durable_memory","generation":0}}
```

`history=null` means no history information; an empty but non-null history clears persisted run-scoped application context. Old entries without provenance remain `unknown` and cannot claim a human author or application-context identity. Java validates the kind, catalog, ID/role/generation combination and author/origin consistency. The model's final request still contains ordinary role/content; it never receives the backend provenance object.

Java marks each application context `Msg` with a stable `workpal_application_context:<kind>` name, which AgentScope persists and restores. Refresh removes only messages with that trusted name, then adds the current typed set. A normal message carrying the exact old prefix remains a normal message. A one-time sidecar migration reseeds old unmarked sessions from the current trusted history window when a typed request first arrives; it does not infer identity from old body text. ME-00's durable-memory fingerprint and native-summary rebuild remain active. A second fingerprint invalidates a native summary that might have folded an earlier application summary or semantic recall, while an initial addition after a no-context summary preserves that existing summary. Changed summaries/recall may therefore cost one extra native summary call; this is the price of removing stale folded context without editing model-written summary text.

The application-level compactor keeps sequence coverage intact and substitutes a fixed placeholder for typed `system` message bodies. It retains unknown legacy rows conservatively. Thread Clear continues deleting messages and advancing generation, which changes the AgentScope session key and makes previous native state unreachable.

## Verification and limits

The migration was applied to a temporary PostgreSQL 16 table with two legacy rows: IDs, ordering, roles and JSON content were unchanged; both rows read `unknown`/`NULL`. A separate fresh PostgreSQL 16 database applied all 109 repository migrations; the second `prisma migrate deploy` reported no pending migrations. Java, TypeScript, real TS adapter → Java jar → loopback model fixture, and production-entry tests are the automated gates. See the roadmap row for final counts and the PR.

Final local gates on JDK 21 and repository pnpm 9.15.0:

- `mvn package`: **83/83** Java tests, including ME-00 native-summary update/deletion/rebuild, application-summary replacement after native compaction, typed false-prefix retention, null versus empty history, old-session migration, and Thread Clear generation isolation.
- Six real TS adapter → Java jar → loopback model fixture suites: **28/28**. The provenance suite confirms that a forged ordinary message survives typed memory update and clear while no provenance object reaches the model request.
- Ten affected API/DB/adapter unit suites: **435/435**; extra executor/DB/page tests: **104/104** (some suites overlap). Contracts, adapter-kit, DB, adapters, API, Web and testkit type checks passed.
- The PostgreSQL offline product journey: **3/3**, including new DB assertions for authenticated Web input (`human_web` + actor ID), model output (`bot` + null author), and unchanged Web DTO. The temporary PostgreSQL migration check also verified two legacy rows and a 109-migration fresh install followed by a no-op rerun.

The first parallel run of the six integration suites had one `409 Session already has an active run` in the pre-existing consumer concurrency test. That test passed alone and all **28/28** passed on the next full run. The failure was not reproduced; no provenance conclusion relies on that first run. The offline suite initially needed Colima's `DOCKER_HOST` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` set to its host and in-container socket paths; it passed once configured.

The deterministic fixture proves wire delivery, persisted refresh, false-prefix containment and schema enforcement. It does not prove that a live model will resist every injection. Provenance does not grant a tool permission. ME-01's future fact deletion must still account for quoted/repeated facts in ordinary conversation and for every new read path; AG-07 does not provide semantic forgetting.
