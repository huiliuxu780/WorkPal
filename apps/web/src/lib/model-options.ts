import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { useEffect, useMemo, useState } from "react";
import { rpc } from "./rpc";

export function modelOptionKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}

export function parseModelOptionKey(key: string) {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 2) };
}

export interface ConnectedModelOption {
  key: string;
  provider: string;
  modelId: string;
  label: string;
  /** Model display name without the provider prefix, for compact triggers. */
  modelLabel: string;
}

/**
 * Every (provider, model) pair reachable from the space's connected model
 * credentials, expanding catalog providers to all their models. Shared by the
 * bot panel, the create-bot dialog, and the top-bar quick switcher.
 */
export function useConnectedModelOptions(): {
  options: ConnectedModelOption[];
  credentials: ModelCredential[];
  catalog: ModelCatalogEntry[];
  ready: boolean;
} {
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([rpc.models.credentials(), rpc.models.list()])
      .then(([nextCredentials, nextCatalog]) => {
        if (cancelled) return;
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo<ConnectedModelOption[]>(() => {
    const connected: ConnectedModelOption[] = [];
    const seen = new Set<string>();
    for (const credential of credentials) {
      const providerModels = catalog.filter(
        (entry) =>
          entry.provider === credential.provider &&
          !entry.placeholder &&
          entry.runtimeAvailable !== false,
      );
      const credentialInCatalog = Boolean(
        credential.modelId && providerModels.some((entry) => entry.id === credential.modelId),
      );
      // Catalog providers expand to every model for that connection. Free-form
      // credentials (model id not in the catalog) stay a single connected pair.
      const pairs =
        credential.modelId && !credentialInCatalog
          ? [
              {
                key: modelOptionKey(credential.provider, credential.modelId),
                provider: credential.provider,
                modelId: credential.modelId,
                label: `${credential.label} · ${credential.modelId}`,
                modelLabel: credential.modelId,
              },
            ]
          : providerModels.map((entry) => ({
              key: modelOptionKey(entry.provider, entry.id),
              provider: entry.provider,
              modelId: entry.id,
              label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
              modelLabel: entry.label,
            }));
      for (const option of pairs) {
        if (seen.has(option.key)) continue;
        seen.add(option.key);
        connected.push(option);
      }
    }
    return connected;
  }, [credentials, catalog]);

  return { options, credentials, catalog, ready };
}

export function modelLabelFor(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string | null | undefined,
): string {
  if (!provider || !modelId) return "";
  const entry = catalog.find((item) => item.provider === provider && item.id === modelId);
  return entry
    ? `${entry.providerName ?? entry.provider} · ${entry.label}`
    : `${provider} · ${modelId}`;
}
