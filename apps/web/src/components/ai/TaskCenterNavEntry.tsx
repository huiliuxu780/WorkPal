import { Trans } from "@lingui/react/macro";
import { Rows2 } from "lucide-react";

/**
 * Sidebar entry for the Task Center (后台任务). Follows the existing sidebar
 * row idiom (lucide icon at 15px/1.8, foreground-contrast text, sidebar-accent
 * selection) without restructuring the sidebar. The count is the server's
 * authoritative `activeCount`; zero renders no badge at all — never an empty
 * pill, never a guessed number.
 */
export function TaskCenterNavEntry({
  count,
  current,
  onSelect,
}: {
  /** Server activeCount; null while unknown (badge omitted, never guessed). */
  count: number | null;
  /** True on the Task Center route itself. */
  current?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="task-center-entry"
      onClick={onSelect}
      aria-current={current ? "page" : undefined}
      className={`flex min-h-10 w-full items-center gap-3 rounded-[15px] px-3 py-2 text-[13px] text-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring ${
        current ? "bg-sidebar-accent font-semibold" : ""
      }`}
    >
      <Rows2 size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-start">
        <Trans>Background tasks</Trans>
      </span>
      {count != null && count > 0 ? (
        <span
          data-testid="task-center-count"
          className="text-[12px] leading-4 text-foreground tabular-nums"
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
