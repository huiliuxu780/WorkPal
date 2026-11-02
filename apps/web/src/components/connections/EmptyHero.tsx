import { Trans } from "@lingui/react/macro";
import { McpEntryCard } from "./McpEntryCard";

/**
 * Empty catalog: give value, a path (MCP) and a fallback, instead of one grey
 * line. Advanced stays collapsed below this; OpenAPI/GraphQL are not promoted.
 */
export function EmptyHero({
  configuredSources,
  mcpBusy,
  onOpenMcp,
}: {
  configuredSources: number;
  mcpBusy: boolean;
  onOpenMcp: () => void;
}) {
  return (
    <div
      data-testid="integrations-empty-hero"
      className="mx-auto flex max-w-[560px] flex-col items-center py-10 text-center"
    >
      <div className="flex items-center gap-2" aria-hidden="true">
        {["G", "S", "N"].map((letter) => (
          <span
            key={letter}
            className="grid size-10 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground"
          >
            {letter}
          </span>
        ))}
      </div>
      <h2 className="mt-5 text-[17px] leading-6 font-semibold text-foreground">
        <Trans>Connect your first app</Trans>
      </h2>
      <p className="mt-2 text-[13.5px] leading-6 text-muted-foreground">
        <Trans>
          Bots need tools to get work done. Connect an app and it can use those tools right in the
          chat — read mail, look up docs, send messages.
        </Trans>
      </p>
      <div className="mt-6 w-full text-start">
        <McpEntryCard
          configuredCount={configuredSources}
          busy={mcpBusy}
          compact
          onOpen={onOpenMcp}
        />
      </div>
      <p className="mt-4 text-[12px] leading-[18px] text-muted-foreground">
        <Trans>
          This deployment has no app catalog configured. Ask the server admin to enable one, or add
          a tool source under Advanced.
        </Trans>
      </p>
    </div>
  );
}
