import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
} from "@rakazo/contracts";
import {
  abortableDelay,
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  isFeaturedCatalogItem,
  matchesConnectionCatalogQuery,
} from "@rakazo/core";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectionDetail } from "../components/connections/ConnectionDetail";
import type { ConnectionState } from "../components/connections/ConnectionStatus";
import { ConnectorTile } from "../components/connections/ConnectorTile";
import { EmptyHero } from "../components/connections/EmptyHero";
import { McpEntryCard } from "../components/connections/McpEntryCard";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { optionalCatalogFeedProbe } from "../lib/optional-catalog-feed";
import { rpc } from "../lib/rpc";

type SourceKind = "treg" | "executor" | "mcp" | "api" | "graphql";

type ConnectionTool = { name: string; description: string };

function itemKey(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
  return `${item.connectorId}:${item.slug}`;
}

function markConnected(
  items: ConnectionCatalogItem[],
  connectorId: string,
  slug: string,
  connected: boolean,
) {
  return items.map((entry) =>
    entry.connectorId === connectorId && entry.slug === slug ? { ...entry, connected } : entry,
  );
}

function activeAccounts(
  connections: Connection[],
  item: Pick<ConnectionCatalogItem, "connectorId" | "slug">,
) {
  return connections.filter(
    (row) =>
      row.connectorId === item.connectorId &&
      row.provider === item.slug &&
      (row.status === "connected" || row.status === "pending"),
  );
}

function nextAccountLabel(itemName: string, existingCount: number) {
  return existingCount <= 0 ? itemName : `${itemName} ${existingCount + 1}`;
}

function chipClassName(active: boolean): string {
  return `inline-flex h-[30px] items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors ${
    active
      ? "bg-foreground text-background"
      : "bg-muted text-muted-foreground hover:text-foreground"
  }`;
}

function chipCountClassName(active: boolean): string {
  return `text-[11.5px] font-normal ${active ? "text-background/80" : "text-muted-foreground/70"}`;
}
export function PluginsOverlay({
  onClose,
  onOpenMcp,
  activeBotId,
}: {
  onClose: () => void;
  onOpenMcp?: () => void;
  activeBotId?: string;
}) {
  const { t } = useLingui();
  const [setupOpen, setSetupOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<CapabilityInstall[]>([]);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("bearer");
  const [authName, setAuthName] = useState("x-api-key");
  const [pending, setPending] = useState<string | null>(null);
  const [chip, setChip] = useState<"all" | "connected">("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  const [catalogFeedEnabled, setCatalogFeedEnabled] = useState(false);
  const [catalogFeedQuery, setCatalogFeedQuery] = useState("");
  const [catalogFeedResults, setCatalogFeedResults] = useState<IntegrationCatalogResult[]>([]);
  const [catalogFeedError, setCatalogFeedError] = useState<string | null>(null);
  const [catalogFeedPending, setCatalogFeedPending] = useState(false);
  const [catalogFeedSearched, setCatalogFeedSearched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailKey, setDetailKey] = useState<{ connectorId: string; slug: string } | null>(null);
  const [tools, setTools] = useState<ConnectionTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [toolsTick, setToolsTick] = useState(0);
  const connectionAttempt = useRef<AbortController | null>(null);

  async function refresh() {
    const [items, installs, rows, catalogFeed] = await Promise.all([
      rpc.connections.catalog({}),
      rpc.capabilities.list(),
      rpc.connections.list(),
      optionalCatalogFeedProbe(rpc.capabilities.catalogSearch({ query: "" })),
    ]);
    setCatalog(items);
    setConnections(rows);
    setLabelDrafts((current) => {
      const next: Record<string, string> = {};
      for (const row of rows) {
        if (row.status === "connected" || row.status === "pending") {
          next[row.id] = current[row.id] ?? row.displayName;
        }
      }
      return next;
    });
    setSources(
      installs.filter(
        (install) => install.kind === "mcp" || install.kind === "api" || install.kind === "graphql",
      ),
    );
    setCatalogFeedEnabled(catalogFeed.enabled);
    return items;
  }

  async function loadCatalog() {
    setLoadError(null);
    setLoading(true);
    try {
      await refresh();
    } catch {
      setLoadError(t`Could not load integrations`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
    return () => connectionAttempt.current?.abort();
  }, []);

  const detailItem = useMemo(() => {
    if (!detailKey) return null;
    return (
      catalog.find(
        (entry) => entry.connectorId === detailKey.connectorId && entry.slug === detailKey.slug,
      ) ?? null
    );
  }, [catalog, detailKey]);

  useEffect(() => {
    if (!detailKey) {
      setTools([]);
      setToolsLoading(false);
      return;
    }
    let cancelled = false;
    setToolsLoading(true);
    void rpc.connections
      .tools({ connectorId: detailKey.connectorId, provider: detailKey.slug })
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      })
      .finally(() => {
        if (!cancelled) setToolsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailKey, toolsTick]);

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const searching = Boolean(query.trim());

  function openDetail(item: ConnectionCatalogItem) {
    setActionError(null);
    setToolsOpen(true);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    setDetailKey(null);
    setTools([]);
  }

  function itemConnected(item: ConnectionCatalogItem) {
    return (
      item.connected || activeAccounts(connections, item).some((row) => row.status === "connected")
    );
  }

  function connectedAccounts(item: ConnectionCatalogItem) {
    return activeAccounts(connections, item).filter((row) => row.status === "connected");
  }

  function failedAccounts(item: ConnectionCatalogItem) {
    return connections.filter(
      (row) =>
        row.connectorId === item.connectorId &&
        row.provider === item.slug &&
        row.status === "error",
    );
  }

  function itemState(item: ConnectionCatalogItem): ConnectionState | "idle" {
    if (itemConnected(item)) return "connected";
    if (activeAccounts(connections, item).some((row) => row.status === "pending")) return "pending";
    if (failedAccounts(item).length > 0) return "failed";
    return "idle";
  }

  function itemActive(item: ConnectionCatalogItem) {
    const state = itemState(item);
    return state === "connected" || state === "pending";
  }

  const activeItems = useMemo(
    () => catalog.filter((item) => itemActive(item)),
    [catalog, connections],
  );
  const recommendedTiles = useMemo(
    () => featuredTiles.filter((tile) => tile.missing || !tile.item || !itemActive(tile.item)),
    [featuredTiles, connections],
  );
  const allItems = useMemo(
    () => catalog.filter((item) => !isFeaturedCatalogItem(item) && !itemActive(item)),
    [catalog, connections],
  );
  const visibleAll = allItems.slice(0, visibleCount);
  const searchMatches = useMemo(() => {
    const matches = catalog.filter((item) => matchesConnectionCatalogQuery(item, query));
    return chip === "connected" ? matches.filter((item) => itemActive(item)) : matches;
  }, [catalog, query, chip, connections]);
  const visibleSearch = searchMatches.slice(0, visibleCount);

  async function notifyAppConnected(item: ConnectionCatalogItem) {
    if (!activeBotId) return;
    await rpc.onboarding
      .appConnected({ botId: activeBotId, provider: item.slug, connectorId: item.connectorId })
      .catch(() => undefined);
  }

  function setItemConnected(item: ConnectionCatalogItem, connected: boolean) {
    setCatalog((prev) => markConnected(prev, item.connectorId, item.slug, connected));
  }

  async function connect(item: ConnectionCatalogItem) {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setActionError(null);
    const key = itemKey(item);
    setPending(key);
    try {
      const existing = activeAccounts(connections, item).filter(
        (row) => row.status === "connected",
      );
      const started = await rpc.connections.begin({
        connectorId: item.connectorId,
        provider: item.slug,
        displayName: nextAccountLabel(item.name, existing.length),
      });
      if (started.authorizationUrl)
        window.open(started.authorizationUrl, "rakazo-plugin-connect", "noopener,noreferrer");
      if (item.noAuth && !started.authorizationUrl) {
        if (controller.signal.aborted) return;
        setItemConnected(item, true);
        void notifyAppConnected(item);
        await refresh().catch(() => undefined);
        setToolsTick((tick) => tick + 1);
        return;
      }
      for (let i = 0; i < 45; i += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc.connections
          .complete({ connectionId: started.connectionId })
          .catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          setItemConnected(item, true);
          void notifyAppConnected(item);
          await refresh().catch(() => undefined);
          setToolsTick((tick) => tick + 1);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (controller.signal.aborted) return;
      setActionError(
        t`Connection to ${item.name} is still pending. You can close this and check again.`,
      );
      await refresh().catch(() => undefined);
    } catch (err) {
      if (controller.signal.aborted) return;
      setActionError(err instanceof Error ? err.message : t`Could not connect`);
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setPending(null);
      }
    }
  }

  async function revokeAccount(row: Connection, item: ConnectionCatalogItem) {
    setActionError(null);
    setPending(row.id);
    try {
      await rpc.connections.revoke({ connectionId: row.id });
      const remaining = activeAccounts(connections, item).filter((entry) => entry.id !== row.id);
      if (remaining.every((entry) => entry.status !== "connected")) {
        setItemConnected(item, false);
      }
      await refresh().catch(() => undefined);
      setToolsTick((tick) => tick + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t`Could not revoke connection`);
    } finally {
      setPending(null);
    }
  }

  async function uninstall(item: ConnectionCatalogItem) {
    const matches = activeAccounts(connections, item);
    if (matches.length === 0) {
      setItemConnected(item, false);
      closeDetail();
      return;
    }
    setActionError(null);
    setPending(`uninstall:${itemKey(item)}`);
    try {
      for (const row of matches) {
        await rpc.connections.revoke({ connectionId: row.id });
      }
      setItemConnected(item, false);
      await refresh().catch(() => undefined);
      closeDetail();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t`Could not revoke connection`);
      await refresh().catch(() => undefined);
    } finally {
      setPending(null);
    }
  }

  async function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    if (!displayName || displayName === row.displayName) return;
    setPending(`rename:${row.id}`);
    setActionError(null);
    try {
      const updated = await rpc.connections.rename({ connectionId: row.id, displayName });
      setConnections((current) =>
        current.map((entry) =>
          entry.id === row.id ? { ...entry, displayName: updated.displayName } : entry,
        ),
      );
      setLabelDrafts((current) => ({ ...current, [row.id]: updated.displayName }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t`Could not rename connection`);
    } finally {
      setPending(null);
    }
  }

  function beginSource(kind: SourceKind) {
    setSourceKind(kind);
    setSourceError(null);
    setSourceHint(null);
    setSourceName(kind === "treg" ? "Treg" : kind === "executor" ? "Executor" : "");
    setSourceUrl(kind === "treg" ? "https://treg.to/mcp/" : "");
    setCredential("");
    setAuthType(kind === "treg" || kind === "executor" ? "bearer" : "none");
    setAuthName("x-api-key");
  }

  async function searchCatalogFeed() {
    setCatalogFeedError(null);
    setCatalogFeedPending(true);
    setCatalogFeedSearched(false);
    setCatalogFeedResults([]);
    try {
      const response = await rpc.capabilities.catalogSearch({ query: catalogFeedQuery });
      setCatalogFeedResults(response.results);
      setCatalogFeedSearched(true);
    } catch (err) {
      setCatalogFeedError(err instanceof Error ? err.message : t`Could not search catalog`);
    } finally {
      setCatalogFeedPending(false);
    }
  }

  function beginCatalogSurface(
    result: IntegrationCatalogResult,
    surface: IntegrationCatalogSurface,
  ) {
    if (!surface.source || (surface.kind !== "mcp" && surface.kind !== "openapi")) return;
    setSourceKind(surface.kind === "mcp" ? "mcp" : "api");
    setSourceName(result.name);
    setSourceUrl(surface.source);
    setCredential("");
    setAuthType(surface.auth?.type ?? "none");
    setAuthName(surface.auth?.headerName ?? "x-api-key");
    setSourceHint(surface.auth?.note ?? null);
    setSourceError(null);
  }

  async function installSource() {
    if (!sourceKind) return;
    setSourceError(null);
    setPending("install-source");
    try {
      const auth = {
        type: authType,
        ...(authType === "header" ? { name: authName.trim() } : {}),
      };
      await rpc.capabilities.install({
        kind: sourceKind === "treg" || sourceKind === "executor" ? "mcp" : sourceKind,
        name:
          sourceName.trim() ||
          (sourceKind === "treg"
            ? "Treg"
            : sourceKind === "executor"
              ? "Executor"
              : sourceKind === "graphql"
                ? "GraphQL"
                : "Custom connector"),
        source: sourceUrl.trim(),
        credential: credential.trim() || undefined,
        config:
          sourceKind === "treg"
            ? { preset: "treg", auth: { type: "bearer" } }
            : sourceKind === "api"
              ? { openApi: true, auth }
              : sourceKind === "graphql"
                ? { auth }
                : {
                    preset: "custom",
                    auth: sourceKind === "executor" ? { type: "bearer" } : auth,
                  },
      });
      setCredential("");
      setSourceKind(null);
      await refresh();
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : t`Could not install connector`);
    } finally {
      setPending(null);
    }
  }

  async function removeSource(install: CapabilityInstall) {
    setPending(install.id);
    setSourceError(null);
    try {
      await rpc.capabilities.remove({ id: install.id });
      setSources((current) => current.filter((source) => source.id !== install.id));
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : t`Could not remove connector`);
    } finally {
      setPending(null);
    }
  }

  function renderTile(item: ConnectionCatalogItem) {
    const state = itemState(item);
    return (
      <ConnectorTile
        key={itemKey(item)}
        item={item}
        state={state}
        accountCount={connectedAccounts(item).length}
        pending={pending === itemKey(item)}
        onAdd={() => void connect(item)}
        onOpen={() => openDetail(item)}
      />
    );
  }

  function renderMissingTile(tile: { id: string; label: string }) {
    return (
      <ConnectorTile
        key={tile.id}
        item={{
          connectorId: "",
          slug: tile.id,
          name: tile.label,
          logo: null,
          connected: false,
          noAuth: false,
        }}
        state="missing"
        accountCount={0}
        pending={false}
        onAdd={() => undefined}
        onOpen={() => undefined}
      />
    );
  }

  function renderShowMore(shown: number, total: number) {
    if (shown >= total) return null;
    return (
      <div className="mt-4 flex justify-center">
        <Button
          type="button"
          variant="secondary"
          className="rounded-full"
          size="sm"
          onClick={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
        >
          <Trans>Show more</Trans>
        </Button>
      </div>
    );
  }

  const detailState = detailItem ? itemState(detailItem) : "idle";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-2xl text-foreground">
            <Trans>Integrations</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>

        {!detailItem && !loading && !loadError && catalog.length > 0 ? (
          <div className="px-8 pt-4">
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
              aria-label={t`Search apps`}
              placeholder={t`Search apps`}
              className="h-11 rounded-xl px-4 md:text-[15px]"
            />
            <div className="mt-3 flex gap-1" data-testid="integrations-chips">
              <button
                type="button"
                data-testid="integrations-filter-all"
                aria-pressed={chip === "all"}
                onClick={() => {
                  setChip("all");
                  setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
                }}
                className={chipClassName(chip === "all")}
              >
                <Trans>All apps</Trans>
                <span className={chipCountClassName(chip === "all")}>{catalog.length}</span>
              </button>
              <button
                type="button"
                data-testid="integrations-filter-connected"
                aria-pressed={chip === "connected"}
                onClick={() => {
                  setChip("connected");
                  setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
                }}
                className={chipClassName(chip === "connected")}
              >
                <Trans>Connected</Trans>
                <span className={chipCountClassName(chip === "connected")}>
                  {activeItems.length}
                </span>
              </button>
            </div>
          </div>
        ) : null}

        <div id="integration-list" className="rk-scroll flex-1 overflow-y-auto px-8 py-6">
          {setupOpen ? (
            <div className="mb-6">
              <IntegrationSetup
                botId={activeBotId}
                onDone={() => {
                  setSetupOpen(false);
                  void refresh().catch(() => setLoadError(t`Could not load integrations`));
                }}
              />
            </div>
          ) : null}
          {actionError ? <p className="mb-4 text-sm text-destructive">{actionError}</p> : null}

          {detailItem ? (
            <ConnectionDetail
              item={detailItem}
              state={detailState === "idle" ? "connected" : detailState}
              accounts={activeAccounts(connections, detailItem)}
              tools={tools}
              toolsLoading={toolsLoading}
              toolsOpen={toolsOpen}
              labelDrafts={labelDrafts}
              pending={pending}
              uninstalling={pending === `uninstall:${itemKey(detailItem)}`}
              adding={pending === itemKey(detailItem)}
              onBack={closeDetail}
              onUninstall={() => void uninstall(detailItem)}
              onAddAccount={() => void connect(detailItem)}
              onLabelChange={(rowId, value) =>
                setLabelDrafts((current) => ({ ...current, [rowId]: value }))
              }
              onRename={(row) => void renameAccount(row)}
              onRemove={(row) => void revokeAccount(row, detailItem)}
              onToggleTools={() => setToolsOpen((open) => !open)}
            />
          ) : loadError ? (
            <div
              role="alert"
              data-testid="integrations-load-error"
              className="max-w-[560px] rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
            >
              <p>{loadError}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void loadCatalog()}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : loading ? (
            <p className="text-muted-foreground/80">
              <Trans>Loading integrations…</Trans>
            </p>
          ) : catalog.length === 0 ? (
            <EmptyHero
              configuredSources={sources.length}
              mcpBusy={setupOpen}
              onOpenMcp={() => setSetupOpen(true)}
            />
          ) : searching || chip === "connected" ? (
            visibleSearch.length > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {visibleSearch.map((item) => renderTile(item))}
                </div>
                {renderShowMore(visibleSearch.length, searchMatches.length)}
              </>
            ) : (
              <p className="text-muted-foreground/80">
                {chip === "connected" && !searching ? (
                  <Trans>No connected apps yet.</Trans>
                ) : (
                  <Trans>No apps match your search.</Trans>
                )}
              </p>
            )
          ) : (
            <>
              {activeItems.length > 0 ? (
                <section className="mb-6" data-testid="integrations-connected-section">
                  <div className="mb-2 text-[12.5px] font-medium text-muted-foreground">
                    <Trans>Connected</Trans> · {activeItems.length}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {activeItems.map((item) => renderTile(item))}
                  </div>
                </section>
              ) : null}

              {recommendedTiles.length > 0 ? (
                <section className="mb-6">
                  <div className="mb-2 text-[12.5px] font-medium text-muted-foreground">
                    <Trans>Recommended</Trans>
                  </div>
                  <div className="grid grid-cols-2 gap-2" data-testid="featured-connectors">
                    {recommendedTiles.map((tile) =>
                      tile.item && !tile.missing ? renderTile(tile.item) : renderMissingTile(tile),
                    )}
                  </div>
                </section>
              ) : null}

              <div className="mb-6">
                <McpEntryCard
                  configuredCount={sources.length}
                  busy={setupOpen}
                  onOpen={() => setSetupOpen(true)}
                />
              </div>

              {allItems.length > 0 ? (
                <section data-testid="integrations-all-apps">
                  <div className="mb-2 text-[12.5px] font-medium text-muted-foreground">
                    <Trans>All apps</Trans>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {visibleAll.map((item) => renderTile(item))}
                  </div>
                  {renderShowMore(visibleAll.length, allItems.length)}
                </section>
              ) : null}
            </>
          )}

          <details
            data-testid="integrations-advanced"
            className="group mt-8"
            onToggle={(event) => {
              if (!(event.currentTarget as HTMLDetailsElement).open) {
                setSourceKind(null);
                setSourceError(null);
                setSourceHint(null);
                setSourceName("");
                setSourceUrl("");
                setCredential("");
                setAuthType("none");
                setAuthName("x-api-key");
              }
            }}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
              <span className="text-muted-foreground">
                <Trans>Advanced</Trans>
              </span>
              <span aria-hidden="true" className="transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>

            <div className="mt-4 space-y-4">
              {catalogFeedEnabled ? (
                <Card data-testid="integrations-catalog-feed">
                  <CardHeader>
                    <CardTitle>
                      <Trans>Search by domain</Trans>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void searchCatalogFeed();
                      }}
                    >
                      <Input
                        value={catalogFeedQuery}
                        disabled={catalogFeedPending}
                        onChange={(event) => {
                          setCatalogFeedQuery(event.target.value);
                          setCatalogFeedResults([]);
                          setCatalogFeedError(null);
                          setCatalogFeedSearched(false);
                        }}
                        placeholder="github.com"
                        aria-label={t`Integration domain`}
                      />
                      <Button
                        type="submit"
                        variant="secondary"
                        className="rounded-full"
                        size="sm"
                        disabled={!catalogFeedQuery.trim() || catalogFeedPending}
                      >
                        {catalogFeedPending ? <Trans>Searching…</Trans> : <Trans>Search</Trans>}
                      </Button>
                    </form>
                    {catalogFeedError ? (
                      <p className="text-sm text-destructive">{catalogFeedError}</p>
                    ) : null}
                    {catalogFeedSearched &&
                    !catalogFeedPending &&
                    catalogFeedResults.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        <Trans>No results</Trans>
                      </p>
                    ) : null}
                    {catalogFeedResults.map((result) => (
                      <div
                        key={`${result.domain}:${result.name}:${result.pageUrl ?? ""}`}
                        className="rounded-xl border border-border/70 p-3"
                      >
                        <div className="font-medium text-foreground">
                          {result.pageUrl ? (
                            <a
                              href={result.pageUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                            >
                              {result.name}
                            </a>
                          ) : (
                            result.name
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">{result.domain}</div>
                        {result.description ? (
                          <p className="mt-2 text-sm leading-5 text-muted-foreground">
                            {result.description}
                          </p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {result.surfaces.map((surface) => {
                            const canAdd =
                              Boolean(surface.source) &&
                              (surface.kind === "mcp" || surface.kind === "openapi");
                            return (
                              <Button
                                key={`${result.domain}:${surface.slug}`}
                                type="button"
                                variant="secondary"
                                className="rounded-full"
                                size="sm"
                                disabled={!canAdd}
                                title={canAdd ? undefined : t`Manual setup required`}
                                onClick={() => beginCatalogSurface(result, surface)}
                              >
                                {surface.kind.toUpperCase()} · {canAdd ? t`Add` : t`Manual`}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ) : null}

              <div data-testid="integrations-advanced-add" className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  onClick={() => beginSource("mcp")}
                >
                  <Trans>Add MCP server</Trans>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  onClick={() => beginSource("api")}
                >
                  <Trans>Add OpenAPI</Trans>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  onClick={() => beginSource("graphql")}
                >
                  <Trans>Add GraphQL</Trans>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  onClick={() => beginSource("executor")}
                >
                  <Trans>Add Executor</Trans>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  onClick={() => beginSource("treg")}
                >
                  <Trans>Add Treg</Trans>
                </Button>
              </div>

              {sourceError ? <p className="text-sm text-destructive">{sourceError}</p> : null}

              {sourceKind ? (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {sourceKind === "treg" ? (
                        <Trans>Connect Treg</Trans>
                      ) : sourceKind === "executor" ? (
                        <Trans>Connect Executor</Trans>
                      ) : sourceKind === "mcp" ? (
                        <Trans>Add remote MCP server</Trans>
                      ) : sourceKind === "graphql" ? (
                        <Trans>Add GraphQL endpoint</Trans>
                      ) : (
                        <Trans>Import OpenAPI JSON</Trans>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Input
                      value={sourceName}
                      onChange={(event) => setSourceName(event.target.value)}
                      placeholder={t`Display name`}
                    />
                    {sourceKind !== "treg" ? (
                      <Input
                        value={sourceUrl}
                        onChange={(event) => setSourceUrl(event.target.value)}
                        placeholder={
                          sourceKind === "mcp"
                            ? "https://example.com/mcp"
                            : sourceKind === "executor"
                              ? "https://executor.example/mcp"
                              : sourceKind === "graphql"
                                ? "https://example.com/graphql"
                                : "https://example.com/openapi.json"
                        }
                      />
                    ) : null}
                    {sourceKind !== "treg" && sourceKind !== "executor" ? (
                      <NativeSelect
                        className="w-full"
                        aria-label={t`Authentication method`}
                        value={authType}
                        onChange={(event) => setAuthType(event.target.value as typeof authType)}
                      >
                        <NativeSelectOption value="none">
                          <Trans>No authentication</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="bearer">
                          <Trans>Bearer token</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="header">
                          <Trans>API key header</Trans>
                        </NativeSelectOption>
                      </NativeSelect>
                    ) : null}
                    {authType === "header" && sourceKind !== "treg" && sourceKind !== "executor" ? (
                      <Input
                        value={authName}
                        onChange={(event) => setAuthName(event.target.value)}
                        placeholder={t`Header name`}
                      />
                    ) : null}
                    {sourceKind === "treg" || sourceKind === "executor" || authType !== "none" ? (
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={credential}
                        onChange={(event) => setCredential(event.target.value)}
                        placeholder={
                          sourceKind === "treg"
                            ? t`Treg token`
                            : sourceKind === "executor"
                              ? t`Executor token`
                              : t`Credential`
                        }
                      />
                    ) : null}
                    <p className="text-xs leading-5 text-muted-foreground">
                      <Trans>Credentials are encrypted and never sent to the model.</Trans>
                    </p>
                    {sourceHint ? (
                      <p className="text-xs leading-5 text-muted-foreground">{sourceHint}</p>
                    ) : null}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        className="rounded-full"
                        size="sm"
                        disabled={pending === "install-source"}
                        onClick={() => void installSource()}
                      >
                        {pending === "install-source" ? (
                          <Trans>Verifying…</Trans>
                        ) : (
                          <Trans>Verify and add</Trans>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="rounded-full"
                        size="sm"
                        onClick={() => setSourceKind(null)}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              <div>
                <div className="mb-3 text-sm font-medium text-foreground/75">
                  <Trans>Tool sources</Trans>
                </div>
                {sources.length === 0 && !sourceKind ? (
                  <p className="text-muted-foreground/80">
                    <Trans>No MCP or API tool sources installed yet.</Trans>
                  </p>
                ) : null}
                {sources.map((source) => (
                  <div key={source.id} className="flex items-center gap-4 rounded-xl px-3 py-2.5">
                    <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-accent font-semibold uppercase text-foreground">
                      {source.kind === "mcp" ? "M" : source.kind === "graphql" ? "G" : "A"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15.5px] font-medium text-foreground">{source.name}</div>
                      <div className="truncate text-[13.5px] text-muted-foreground/70">
                        {source.kind.toUpperCase()} · {source.source} ·{" "}
                        {source.secretConfigured ? (
                          <Trans>credential saved</Trans>
                        ) : (
                          <Trans>no auth</Trans>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      disabled={pending === source.id}
                      onClick={() => void removeSource(source)}
                    >
                      {pending === source.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
                    </Button>
                  </div>
                ))}
                {onOpenMcp ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="mt-2 px-0 text-muted-foreground"
                    onClick={onOpenMcp}
                  >
                    <Trans>Manage MCP servers</Trans>
                  </Button>
                ) : null}
              </div>
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}
