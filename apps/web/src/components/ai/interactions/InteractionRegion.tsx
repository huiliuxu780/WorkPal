import { t } from "@lingui/core/macro";
import { compareInteractionViewsForDisplay, type InteractionView } from "@rakazo/contracts";
import type { ArtifactTarget } from "../../../lib/artifact-open";
import { ActionApprovalCard } from "./ActionApprovalCard";
import { InputRequestCard } from "./InputRequestCard";
import { PlanReviewInteractionCard } from "./PlanReviewInteractionCard";
import { SessionControlCard } from "./SessionControlCard";

export function interactionCardsForDisplay(
  interactions: readonly InteractionView[],
): InteractionView[] {
  return interactions
    .filter((view) => view.kind !== "session_control")
    .sort(compareInteractionViewsForDisplay);
}

export function sessionControlsForDisplay(
  interactions: readonly InteractionView[],
): Array<Extract<InteractionView, { kind: "session_control" }>> {
  return interactions
    .filter(
      (view): view is Extract<InteractionView, { kind: "session_control" }> =>
        view.kind === "session_control",
    )
    .sort((left, right) =>
      left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
    );
}

export function InteractionRegion({
  interactions,
  target,
  botNameOf,
  conversationName,
  groupNameOf,
  onRefresh,
  onOpenComputer,
}: {
  interactions: readonly InteractionView[];
  target: ArtifactTarget;
  botNameOf?: (botId: string) => string | undefined;
  conversationName?: string;
  groupNameOf?: (groupId: string) => string | undefined;
  onRefresh?: () => Promise<void>;
  onOpenComputer?: (botId: string) => void;
}) {
  const cards = interactionCardsForDisplay(interactions);
  const sessionControls = sessionControlsForDisplay(interactions);
  if (cards.length === 0 && sessionControls.length === 0) return null;
  return (
    <section
      aria-label={t`Needs your attention`}
      data-testid="intervention-region"
      data-surface="interaction-v2"
      className="flex flex-col gap-2 py-1"
    >
      {cards.map((view) => {
        const shared = {
          target,
          botName: view.source.botId ? botNameOf?.(view.source.botId) : undefined,
          conversationName,
          onRefresh,
        };
        if (view.kind === "plan_review") {
          return <PlanReviewInteractionCard key={view.interactionId} view={view} {...shared} />;
        }
        if (view.kind === "input_request") {
          return <InputRequestCard key={view.interactionId} view={view} {...shared} />;
        }
        if (view.kind === "action_approval") {
          return (
            <ActionApprovalCard
              key={view.interactionId}
              view={view}
              {...shared}
              groupNameOf={groupNameOf}
            />
          );
        }
        return null;
      })}
      {sessionControls.length > 0 ? (
        <div
          data-testid="session-control-region"
          className="flex flex-col gap-2 border-t border-border/60 pt-2"
        >
          {sessionControls.map((view) => (
            <SessionControlCard
              key={view.interactionId}
              view={view}
              botName={botNameOf?.(view.botId)}
              conversationName={conversationName}
              onOpenComputer={onOpenComputer}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
