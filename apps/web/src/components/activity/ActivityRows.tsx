import { t } from "@lingui/core/macro";
import type { ActivityItem } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";

/**
 * Phase 4 activity rows (§25/§26/§41): one muted line per product-semantic
 * item — icon plus text, never color alone, never runtime internals. Avatars
 * only appear for collaboration rows in shared (group) contexts.
 */

const STATUS_GLYPH: Record<ActivityItem["status"], string> = {
  pending: "◷",
  running: "◷",
  waiting: "!",
  completed: "✓",
  failed: "×",
  cancelled: "–",
};

function statusWord(status: ActivityItem["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return t`Working`;
    case "waiting":
      return t`Waiting`;
    case "completed":
      return t`Done`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
  }
}

export function ActivityRows({
  items,
  showAvatars = false,
  botColors,
}: {
  items: readonly ActivityItem[];
  showAvatars?: boolean;
  botColors?: Readonly<Record<string, string>>;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="activity-rows">
      {items.map((item) => {
        const actor = showAvatars ? (item.actor ?? item.target) : undefined;
        return (
          <li
            key={item.id}
            className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground"
            data-activity-kind={item.kind}
            data-activity-status={item.status}
          >
            {actor?.botId ? (
              <BotAvatar
                color={botColors?.[actor.botId] ?? "#8a8a8e"}
                identity={actor.name ?? actor.botId}
                size={18}
              />
            ) : (
              <span
                aria-hidden
                className={
                  item.status === "running"
                    ? "w-4 shrink-0 text-center text-warning"
                    : item.status === "failed"
                      ? "w-4 shrink-0 text-center text-destructive"
                      : "w-4 shrink-0 text-center"
                }
              >
                {STATUS_GLYPH[item.status]}
              </span>
            )}
            <span dir="auto" className="truncate">
              {item.title}
              {item.count && item.count > 1 ? ` ×${item.count}` : ""}
            </span>
            <span className="sr-only">{statusWord(item.status)}</span>
            {item.detail ? (
              <span dir="auto" className="truncate text-xs opacity-70">
                {item.detail}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
