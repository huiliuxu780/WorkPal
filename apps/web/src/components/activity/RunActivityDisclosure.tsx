import { Plural } from "@lingui/react/macro";
import type { ActivityItem } from "@rakazo/contracts";
import { foldAdjacentTools, windowActivity } from "@rakazo/core";
import { ActivityRows } from "./ActivityRows";

/**
 * Phase 4 inline run activity (§23/§24): the disclosure interaction mirrors
 * ToolActivityDisclosure — open while live, folded to a "Done · N actions"
 * summary when finished, and a manual collapse during a run holds because
 * React only rewrites `open` when the prop changes (the `key` swap remounts
 * on the live→done transition).
 *
 * The rows here EXCLUDE tool calls and handoffs when rendered inline: tool
 * steps already live in the ToolActivityDisclosure card and a handoff has its
 * conversation-visible marker block (§22: one event, one visual).
 */

export const LIVE_ACTIVITY_WINDOW = 6;

function formatDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) return null;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function RunActivityDisclosure({
  items,
  live,
  actionCount,
  durationMs,
  showAvatars = false,
  botColors,
}: {
  items: readonly ActivityItem[];
  live: boolean;
  /** Total actions including folded tool calls (summary line). */
  actionCount?: number;
  durationMs?: number;
  showAvatars?: boolean;
  botColors?: Readonly<Record<string, string>>;
}) {
  const folded = foldAdjacentTools(items);
  const { visible, hiddenCount } = live
    ? windowActivity(folded, LIVE_ACTIVITY_WINDOW)
    : { visible: [...folded], hiddenCount: 0 };
  // Match the existing steps-card semantics: counts are tool CALLS, so a
  // folded "Reading file ×3" row contributes three actions.
  const actions =
    actionCount ?? folded.reduce((total, item) => total + (item.count ?? 1), 0);
  const duration = formatDuration(durationMs);
  if (!live && actions === 0) return null;
  return (
    <details
      key={live ? "working" : "actions"}
      open={live}
      data-testid="run-activity"
      data-live={live || undefined}
      className="group"
    >
      <summary
        className={`flex min-h-6 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          live ? "text-foreground/75" : "text-muted-foreground"
        }`}
      >
        {live ? (
          <Plural value={actions} one="Working… · # action" other="Working… · # actions" />
        ) : (
          <>
            <Plural value={actions} one="Done · # action" other="Done · # actions" />
            {duration ? ` · ${duration}` : null}
          </>
        )}
      </summary>
      <div className="ms-[7px] mt-0.5 border-s border-border ps-3">
        {hiddenCount > 0 ? (
          <div className="pb-1 text-xs text-muted-foreground" data-testid="activity-earlier">
            <Plural value={hiddenCount} one="+# earlier" other="+# earlier" />
          </div>
        ) : null}
        <ActivityRows items={visible} showAvatars={showAvatars} botColors={botColors} />
      </div>
    </details>
  );
}
