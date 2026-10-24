# RT-08 public delegation UI: implementation and evidence

## Scope and contract audit

RT-08 is a Web-only read projection. It does not change routing, task creation, Run creation, retries, cancellation, feature gates, or AgentScope execution.

The task brief points to `apps/api/src/thread-target.ts` for the public collaboration write shape. That file owns user-originated group sends and typed mention routing. The atomic public `message_bot` write is actually in `packages/adapters/src/bot-messages.ts`:

- the source message has `botId`, the source `runId`, and a `bot_message_sent` block with structured `toBotId`, stored `toBotName`, and body text;
- the target wake message has the independent target `runId` and a `bot_message_received.returnToMessageId` that identifies the exact source message;
- the same transaction creates the target Task and Run and writes `thread.collaboration.requested` with both Run IDs.

Those persisted fields are sufficient for RT-08. No backend or shared-contract change was needed.

## Display projection

`apps/web/src/lib/public-collaboration.ts` builds a read-only projection from persisted Messages plus Run/execution/activity facts.

1. It pairs an outbound and target wake message only through `returnToMessageId`. It never parses bare `@` text and never guesses by text equality or time.
2. The visual merge key is `(sourceRunId, senderBotId)`, with strict semantic adjacency. The target wake message that belongs to a delivery is treated as the transport half of that item. Any ordinary message, different source Run, or different sender closes the visual group.
3. Every visual row retains its own `messageId`, `targetBotId`, `targetRunId`, body, and status. The merged card has no aggregate success state.
4. A bounded history page can temporarily contain an outbound without its paired wake message. That outbound is withheld until the exact pair is available instead of falling through to the private receipt/pair-UI renderer.

The projection changes presentation only. The underlying Message, Task, and Run records are not rewritten or coalesced. `Shell.tsx` also preserves execution anchors for every hidden transport/merged Message ID, so execution history is not detached by the visual merge.

## Identity, status, and interaction

- Sender and target identity are keyed by Bot ID. Current accessible names and existing avatar colors win over stored names, so rename does not change identity.
- A deleted or inaccessible target uses the stored name and stable avatar fallback without an `href` or navigation callback.
- Each target status is derived independently from its target Run ID. Supported states are `queued`, `running`, `completed`, `failed`, and `cancelled`; no percentage is synthesized.
- A target response is rendered only when its real Message appears in the transcript. The delegation component does not synthesize an acknowledgement.
- Target mentions reuse the RT-07 mention component and its normal direct-chat navigation. Status entries use native `details`/`summary`; both mention and status controls are keyboard reachable.
- Public delegation rendering never calls `onOpenPeerMessages`, so it cannot open the private pair overlay.
- The existing group transcript layout and design tokens remain in place. Wrapping and a bounded card width keep identity and failure details visible at 390 px.

## Test evidence

The targeted unit and transcript tests cover:

- one public target;
- adjacent same-source/same-sender visual merging;
- different source Run and different sender separation;
- an ordinary message breaking adjacency;
- independent completed/failed target states;
- confirmation appearing only after a real target Message;
- keyboard focus, current name after rename, and deleted/inaccessible fallback;
- narrow wrapping and the absence of the private receipt/pair path.

`apps/web/e2e/group-chats.spec.ts` exercises the persisted public Message/Run shape in a real group transcript, verifies queued state, keyboard status disclosure, 390 px bounds, mention keyboard navigation, and that navigation does not open pair UI. The same spec was corrected to preserve typed mention chips when appending text; using `fill()` after mention selection had removed the structured Bot identity and contradicted the RT-07/RT-10 contract.

Local verification on 2026-10-23:

| Check | Result |
| --- | --- |
| `pnpm --filter @rakazo/core check` | passed |
| `pnpm --filter @rakazo/web check` | passed |
| targeted Vitest (3 files, 33 tests) | passed |
| `pnpm --filter @rakazo/web build` | passed |
| `pnpm test:e2e --spec=group-chats.spec.ts` | passed, Chromium 1/1 |
| `pnpm check` | passed, 18/18 tasks |
| `git diff --check` | passed |

The Playwright run emits `public-delegation-mobile.png` below `apps/web/test-results/`. Test output is ignored and is not committed.
