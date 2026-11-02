import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRight, Plug } from "lucide-react";

/**
 * Full-width entry into the existing MCP setup form. The subtitle is either a
 * newcomer sentence or a current-state count, never both.
 */
export function McpEntryCard({
  configuredCount,
  busy,
  compact = false,
  onOpen,
}: {
  configuredCount: number;
  busy: boolean;
  compact?: boolean;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const description =
    configuredCount > 0
      ? t`${configuredCount} tool sources configured`
      : compact
        ? t`Connect remote MCP tools and data sources`
        : t`Connect remote MCP tools and data sources, or add a self-hosted server`;
  return (
    <button
      type="button"
      data-testid="integrations-mcp-entry"
      disabled={busy}
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left ring-1 ring-border transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-foreground">
        <Plug size={18} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] leading-5 font-medium text-foreground">
          <Trans>Browse MCP servers</Trans>
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
