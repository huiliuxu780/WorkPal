import { i18n } from "@lingui/core";
import type { ActivityItem, Run } from "@rakazo/contracts";
import { useId, useState } from "react";
import { ActivityRows } from "../activity/ActivityRows";
import { selectExecutionActivity } from "../../lib/execution-activity";

export function ExecutionActivity({
  run,
  items,
  showAvatars = false,
  botColors,
}: {
  run: Run | null;
  items: readonly ActivityItem[];
  showAvatars?: boolean;
  botColors?: Readonly<Record<string, string>>;
}) {
  const [recentExpanded, setRecentExpanded] = useState(false);
  const recentId = useId();
  const view = selectExecutionActivity(run, items);
  if (!view.primary && !view.note && view.recent.length === 0) return null;
  return (
    <section data-slot="activity" className="ms-1 my-2 min-w-0 text-[13px] text-foreground/85">
      <h3 className="py-1 text-xs font-medium text-muted-foreground">{i18n._("Current activity")}</h3>
      {view.primary ? <p dir="auto" className="min-w-0 leading-5">{view.primary}</p> : null}
      {view.note ? <p dir="auto" className="text-xs leading-5 text-muted-foreground">{view.note}</p> : null}
      {view.recent.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={recentExpanded}
            aria-controls={recentId}
            onClick={() => setRecentExpanded((value) => !value)}
            className="min-h-11 rounded-md text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {recentExpanded ? i18n._("Hide recent activity") : i18n._("View recent activity")}
          </button>
          <div id={recentId} hidden={!recentExpanded} inert={!recentExpanded} className="pb-2">
            {view.hiddenCount > 0 ? (
              <p className="pb-1 text-xs text-muted-foreground">
                {i18n._("Earlier activities are not shown")}: {view.hiddenCount}
              </p>
            ) : null}
            <ActivityRows items={view.recent} showAvatars={showAvatars} botColors={botColors} />
          </div>
        </>
      ) : null}
    </section>
  );
}
