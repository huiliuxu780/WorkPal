import { t } from "@lingui/core/macro";
import type { CollaborationReceiptBlock } from "@rakazo/contracts";
import { cn } from "@rakazo/ui-web";

/** The persisted destination receipt shown in the source direct chat. */
export function GroupDestinationReceipt({
  block,
  botName,
  onOpen,
}: {
  block: CollaborationReceiptBlock;
  botName: string;
  onOpen: (input: { groupId: string; messageId: string }) => void;
}) {
  if (block.target.kind !== "group") return null;
  const groupName = block.display?.groupName ?? t`the target room`;
  const groupId = block.target.groupId;
  const destination =
    block.destination?.kind === "group_message" &&
    block.destination.groupId === groupId &&
    block.destination.threadId === block.target.threadId
      ? block.destination
      : null;

  const state = block.state;
  const topic = block.display?.topic ?? t`this work`;
  const title =
    state === "sent"
      ? t`${botName} has entered “${groupName}”`
      : state === "completed"
        ? t`The result came from “${groupName}”`
        : state === "failed"
          ? t`Work in “${groupName}” was not completed`
          : t`Work in “${groupName}” was cancelled`;
  const stateLabel =
    state === "sent"
      ? t`At the table`
      : state === "completed"
        ? t`Brought back`
        : state === "failed"
          ? t`Not completed`
          : t`Cancelled`;
  const body =
    state === "sent"
      ? t`Reading the discussion and taking over “${topic}”.`
      : state === "completed"
        ? t`The room keeps the full evidence, the discussion, and the follow-up work.`
        : state === "failed"
          ? t`This work was not completed. The room record can still be reviewed.`
          : t`This work was cancelled. The room record can still be reviewed.`;
  const meta =
    state === "sent"
      ? t`Taken over · In progress`
      : state === "completed"
        ? t`I reorganized it around your question`
        : state === "failed"
          ? t`The full record is still available`
          : t`The record is kept for review`;
  const linkLabel = state === "sent" ? t`Go to the room ↗` : t`View the room ↗`;

  return (
    <div
      data-testid="group-destination-receipt"
      data-group-id={groupId}
      data-receipt-state={state}
      data-destination-message-id={destination?.messageId}
      className="w-fit max-w-full min-w-0 [@media(hover:none)]:w-full"
    >
      <div className="min-w-0 rounded-[16px] border border-border bg-background px-3.5 py-3 text-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded-lg bg-foreground text-[12px] text-background"
          >
            #
          </span>
          <strong className="min-w-0 text-[14px] font-semibold leading-[1.35]" dir="auto">
            {title}
          </strong>
          <span
            className={cn(
              "ms-auto shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium",
              state === "failed"
                ? "bg-destructive/10 text-destructive"
                : state === "sent" || state === "completed"
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {stateLabel}
          </span>
        </div>
        <div className="mt-2 text-[14px] leading-[1.45] text-muted-foreground" dir="auto">
          {body}
        </div>
        <div className="mt-2.5 flex min-w-0 items-center justify-between gap-3 border-t border-border/70 pt-2.5 text-[12.5px] text-muted-foreground">
          <span className="min-w-0 wrap-anywhere" dir="auto">
            {meta}
          </span>
          {destination ? (
            <button
              type="button"
              onClick={() => onOpen({ groupId, messageId: destination.messageId })}
              className="shrink-0 rounded-full px-1.5 py-0.5 font-medium text-foreground/75 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t`Open the message in ${groupName}`}
            >
              {linkLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
