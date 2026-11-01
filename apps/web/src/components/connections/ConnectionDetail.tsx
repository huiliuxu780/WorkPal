import { Trans, useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { humanizeToolName } from "@rakazo/core";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@rakazo/ui-web";
import { ChevronDown, ChevronLeft, ChevronUp, Plus, Wrench } from "lucide-react";
import { type ConnectionState, ConnectionStatus } from "./ConnectionStatus";
import { ConnectorLogo } from "./ConnectorTile";

type ConnectionTool = { name: string; description: string };

function accountState(status: Connection["status"]): ConnectionState {
  return status === "connected" ? "connected" : status === "pending" ? "pending" : "failed";
}

export function ConnectionDetail({
  item,
  state,
  accounts,
  tools,
  toolsLoading,
  toolsOpen,
  labelDrafts,
  pending,
  uninstalling,
  adding,
  onBack,
  onUninstall,
  onAddAccount,
  onLabelChange,
  onRename,
  onRemove,
  onToggleTools,
}: {
  item: ConnectionCatalogItem;
  state: ConnectionState;
  accounts: Connection[];
  tools: ConnectionTool[];
  toolsLoading: boolean;
  toolsOpen: boolean;
  labelDrafts: Record<string, string>;
  pending: string | null;
  uninstalling: boolean;
  adding: boolean;
  onBack: () => void;
  onUninstall: () => void;
  onAddAccount: () => void;
  onLabelChange: (rowId: string, value: string) => void;
  onRename: (row: Connection) => void;
  onRemove: (row: Connection) => void;
  onToggleTools: () => void;
}) {
  const { t } = useLingui();
  const toolCount = tools.length;
  return (
    <div data-testid="connection-detail" className="max-w-[720px] space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t`Back`}
            onClick={onBack}
          >
            <ChevronLeft />
          </Button>
          <ConnectorLogo name={item.name} logo={item.logo} />
          <div className="truncate text-[17px] leading-6 font-medium text-foreground">
            {item.name}
          </div>
          <ConnectionStatus state={state} className="ms-1" />
        </div>
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          size="sm"
          disabled={uninstalling || adding}
          onClick={onUninstall}
        >
          {uninstalling ? <Trans>Removing…</Trans> : <Trans>Uninstall</Trans>}
        </Button>
      </div>

      <Card data-testid="connection-accounts">
        <CardHeader>
          <CardTitle>
            <Trans>Accounts</Trans>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {accounts.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-[13px] font-semibold text-foreground"
              >
                {(labelDrafts[row.id] ?? row.displayName)[0] ?? "?"}
              </span>
              <Input
                value={labelDrafts[row.id] ?? row.displayName}
                aria-label={t`Account label`}
                className="h-9 min-w-0 flex-1 rounded-lg px-3 text-[13px]"
                onChange={(event) => onLabelChange(row.id, event.target.value)}
                onBlur={() => onRename(row)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              <ConnectionStatus state={accountState(row.status)} />
              <Button
                type="button"
                variant="ghost"
                className="h-9 shrink-0 rounded-full px-2 text-[12px]"
                size="sm"
                disabled={pending === row.id || uninstalling}
                onClick={() => onRemove(row)}
              >
                {pending === row.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            className="mt-1 rounded-full"
            size="sm"
            disabled={adding || uninstalling}
            onClick={onAddAccount}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {adding ? <Trans>Adding…</Trans> : <Trans>Add another</Trans>}
          </Button>
        </CardContent>
      </Card>

      <Card data-testid="connection-tools">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left"
          onClick={onToggleTools}
          aria-expanded={toolsOpen}
        >
          <span className="text-base font-medium text-foreground">
            {toolsLoading ? (
              <Trans>Tools</Trans>
            ) : toolCount === 1 ? (
              t`1 tool`
            ) : (
              t`${toolCount} tools`
            )}
          </span>
          {toolsOpen ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>
        {toolsOpen ? (
          <CardContent className="border-t border-border pt-3">
            {toolsLoading ? (
              <p className="text-sm text-muted-foreground">
                <Trans>Loading tools…</Trans>
              </p>
            ) : tools.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No tools available.</Trans>
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {tools.map((tool) => (
                  <li
                    key={tool.name}
                    className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/50"
                  >
                    <Wrench
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] leading-[18px] font-medium text-foreground">
                        {humanizeToolName(tool.name)}
                      </div>
                      {tool.description ? (
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-4 text-muted-foreground">
                          {tool.description}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
