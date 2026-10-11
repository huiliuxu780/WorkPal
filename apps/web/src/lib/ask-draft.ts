const PREFIX = "workpal:ask-draft:";

export function availableAskDraftStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function askDraftKey(runId: string, messageId: string): string {
  return `${PREFIX}${runId}:${messageId}`;
}

/** Secret answers are never read from or written to browser storage. */
export function readAskDraft(storage: Storage | null, key: string, secret: boolean): string {
  if (!storage || secret) return "";
  try {
    return storage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeAskDraft(
  storage: Storage | null,
  key: string,
  value: string,
  secret: boolean,
): void {
  if (!storage || secret) return;
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch {
    // Private browsing can deny storage. The in-memory draft still works.
  }
}
