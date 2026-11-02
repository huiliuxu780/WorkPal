import { Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { Button, cn, Spinner } from "@rakazo/ui-web";
import { type ConnectionState, ConnectionStatus } from "./ConnectionStatus";

export function ConnectorLogo({
  name,
  logo,
  className,
}: {
  name: string;
  logo?: string | null;
  className?: string;
}) {
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn("h-9 w-9 shrink-0 rounded-xl bg-accent object-contain", className)}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground",
        className,
      )}
    >
      {name[0]}
    </div>
  );
}

/** Catalog tile: logo + name + optional one-line description + status/action. */
export function ConnectorTile({
  item,
  state,
  accountCount,
  pending,
  onAdd,
  onOpen,
}: {
  item: ConnectionCatalogItem;
  state: ConnectionState | "idle" | "missing";
  accountCount: number;
  pending: boolean;
  onAdd: () => void;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const missing = state === "missing";
  const openable = state === "connected" || state === "pending";
  const main = (
    <>
      <ConnectorLogo name={item.name} logo={item.logo} />
      <span className="min-w-0 flex-1 text-start">
        <span className="block truncate text-[13.5px] leading-5 font-medium text-foreground">
          {item.name}
        </span>
        {missing ? (
          <span className="mt-0.5 block truncate text-[12.5px] leading-4 text-muted-foreground">
            <Trans>Not in the plugin catalog</Trans>
          </span>
        ) : item.description ? (
          <span
            data-testid="connection-tile-description"
            className="mt-0.5 block truncate text-[12.5px] leading-4 text-muted-foreground"
          >
            {item.description}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <div
      data-testid={state === "connected" ? `connection-tile-${item.slug.toLowerCase()}` : undefined}
      className={cn(
        "flex min-h-[52px] min-w-0 items-center gap-3 rounded-xl px-2.5 py-2",
        missing && "opacity-70",
      )}
    >
      {openable ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={onOpen}
        >
          {main}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{main}</div>
      )}

      {state === "connected" ? (
        <ConnectionStatus state="connected" accountCount={accountCount} />
      ) : state === "pending" ? (
        <ConnectionStatus state="pending" />
      ) : state === "failed" ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <ConnectionStatus state="failed" />
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="xs"
            disabled={pending}
            onClick={onAdd}
          >
            {pending ? <Spinner className="size-3" /> : <Trans>Add</Trans>}
          </Button>
        </span>
      ) : missing ? null : (
        <Button
          type="button"
          variant="secondary"
          className="rounded-full"
          size="sm"
          disabled={pending}
          onClick={onAdd}
        >
          {pending ? (
            <>
              <Spinner className="size-3" />
              <Trans>Adding…</Trans>
            </>
          ) : (
            t`Add`
          )}
        </Button>
      )}
    </div>
  );
}
