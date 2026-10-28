import { t } from "@lingui/core/macro";
import type { AttentionQueueItem } from "@rakazo/contracts";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Bell, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestBrowserNotificationPermission } from "../lib/browser-notifications";
import { rpc } from "../lib/rpc";

/** 15s is the repository's cross-thread polling cadence (ActivityList). */
const POLL_MS = 15_000;
const SUMMARY_MAX = 140;

export function AttentionQueue({
  enabled,
  activeTarget,
  botNotificationsEnabled,
  refreshToken,
  onOpenItem,
  onItems,
}: {
  enabled: boolean;
  activeTarget: { botId?: string; groupId?: string } | null;
  botNotificationsEnabled: (botId: string | null) => boolean;
  /** Shell bumps this after a local decision settles. */
  refreshToken: number;
  onOpenItem: (item: AttentionQueueItem) => void;
  onItems: (items: AttentionQueueItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AttentionQueueItem[]>([]);
  const itemsRef = useRef<AttentionQueueItem[]>([]);
  itemsRef.current = items;
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const baseline = useRef<Set<string> | null>(null);
  const notified = useRef(new Set<string>());
  const requestSeq = useRef(0);
  const permissionRequested = useRef(false);
  const activeTargetRef = useRef(activeTarget);
  activeTargetRef.current = activeTarget;
  const notifyEnabledRef = useRef(botNotificationsEnabled);
  notifyEnabledRef.current = botNotificationsEnabled;
  const openItemRef = useRef(onOpenItem);
  openItemRef.current = onOpenItem;
  const onItemsRef = useRef(onItems);
  onItemsRef.current = onItems;

  const notifyNewItems = useCallback(
    (next: AttentionQueueItem[], options?: { complete?: boolean; silent?: boolean }) => {
      const keys = new Set(next.map(attentionKey));
      if (baseline.current === null) {
        baseline.current = keys;
        notified.current = new Set(keys);
        return;
      }
      if (options?.silent) {
        // Loading an older page is navigation, not new work.
        for (const key of keys) notified.current.add(key);
      }
      const fresh = options?.silent
        ? []
        : next.filter((item) => !notified.current.has(attentionKey(item)));
      for (const item of fresh) notified.current.add(attentionKey(item));
      // Only a complete snapshot can prove a row settled. A single page (or a
      // later page) must never prune keys from other pages, or the next poll
      // would replay every existing request as new.
      if (options?.complete) {
        for (const key of [...notified.current]) {
          if (!keys.has(key)) notified.current.delete(key);
        }
      }
      if (fresh.length === 0) return;
      if (typeof Notification === "undefined") return;
      const target = activeTargetRef.current;
      const foreground = (item: AttentionQueueItem) =>
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        ((item.conversationKind === "group" && target?.groupId === item.conversationId) ||
          (item.conversationKind === "direct" && target?.botId === item.conversationId));
      for (const item of fresh) {
        if (foreground(item)) continue;
        if (!notifyEnabledRef.current(item.source.botId ?? null)) continue;
        if (Notification.permission !== "granted") continue;
        try {
          const notification = new Notification(notificationTitle(item), {
            body: notificationBody(item),
            tag: item.interactionId,
          });
          notification.onclick = () => {
            window.focus();
            openItemRef.current(item);
            notification.close();
          };
        } catch {
          // A failed Notification must never break the queue.
        }
      }
    },
    [],
  );

  const load = useCallback(
    async (options?: { cursor?: string | null; append?: boolean }) => {
      // Poll, focus, refresh and load-more can overlap. Only the most recently
      // started request may write state: a slow response landing after a newer
      // one would resurrect requests the user already settled and notify them
      // again as new work.
      const seq = ++requestSeq.current;
      try {
        const page = await rpc.attention.list({
          limit: 50,
          ...(options?.cursor ? { cursor: options.cursor } : {}),
        });
        if (seq !== requestSeq.current) return;
        const base = options?.append ? itemsRef.current : [];
        const seen = new Set(base.map(attentionKey));
        const merged = [...base, ...page.items.filter((item) => !seen.has(attentionKey(item)))];
        itemsRef.current = merged;
        setItems(merged);
        setTotal(page.total);
        setNextCursor(page.nextCursor);
        setError(false);
        onItemsRef.current(merged);
        notifyNewItems(merged, {
          complete: !page.nextCursor,
          silent: Boolean(options?.append),
        });
      } catch {
        if (seq !== requestSeq.current) return;
        setError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [notifyNewItems],
  );
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await load({ cursor: nextCursor, append: true });
  }, [load, loadingMore, nextCursor]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      await load();
      if (cancelled) return;
      // Schedule the next poll only after this one settled: no overlap.
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, load, refreshToken, retryToken]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || permissionRequested.current) return;
    // Asking for permission stays behind the existing notification setting:
    // only once, when this Bot may notify and there is already pending work.
    if (items.length === 0 || typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    if (!items.some((item) => notifyEnabledRef.current(item.source.botId ?? null))) return;
    permissionRequested.current = true;
    void requestBrowserNotificationPermission();
  }, [enabled, items]);

  if (!enabled) return null;

  const countLabel = total > 99 ? "99+" : String(total);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="attention-entry"
        aria-expanded={open}
        aria-label={total > 0 ? t`Attention queue, ${total} pending` : t`Attention queue`}
        className="mb-1 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <Bell size={15} strokeWidth={1.8} aria-hidden="true" />
        <span className="flex-1 truncate">{t`Attention`}</span>
        {total > 0 ? (
          <span
            data-testid="attention-count"
            className="rounded-full bg-foreground px-1.5 py-0.5 text-[11px] leading-none text-background"
          >
            {countLabel}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={10}
        className="w-[min(360px,calc(100vw-24px))] gap-0 overflow-hidden p-0"
      >
        <section
          data-testid="attention-queue"
          aria-label={t`Attention queue`}
          className="flex max-h-[min(70vh,520px)] flex-col"
        >
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
            <span className="text-[13px] font-semibold text-foreground">{t`Attention queue`}</span>
            {total > 0 ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                {countLabel}
              </span>
            ) : null}
            <span className="ms-auto text-[11px] text-muted-foreground">
              {t`Only requests for you`}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {loading ? (
              <p className="px-2 py-3 text-[12.5px] text-muted-foreground">{t`Loading…`}</p>
            ) : error ? (
              <div className="px-2 py-3">
                <p className="text-[12.5px] text-destructive">{t`Couldn't load pending requests.`}</p>
                <button
                  type="button"
                  className="mt-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setLoading(true);
                    setRetryToken((value) => value + 1);
                  }}
                >
                  {t`Retry`}
                </button>
              </div>
            ) : items.length === 0 ? (
              <p
                data-testid="attention-empty"
                className="px-2 py-3 text-[12.5px] text-muted-foreground"
              >
                {t`Nothing needs you right now.`}
              </p>
            ) : (
              <ul className="flex flex-col">
                {items.map((item) => (
                  <li key={`${item.interactionId}:${item.revision}`}>
                    <button
                      type="button"
                      data-testid="attention-item"
                      data-interaction-id={item.interactionId}
                      data-kind={item.kind}
                      onClick={() => {
                        setOpen(false);
                        onOpenItem(item);
                      }}
                      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground"
                      >
                        {kindGlyph(item.kind)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-[13px] font-medium text-foreground"
                          dir="auto"
                        >
                          {summaryText(item)}
                        </span>
                        <span
                          className="mt-0.5 block truncate text-[11.5px] text-muted-foreground"
                          dir="auto"
                        >
                          {metaText(item)}
                        </span>
                      </span>
                      <ChevronRight
                        size={14}
                        aria-hidden="true"
                        className="mt-1 shrink-0 text-muted-foreground/70"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {nextCursor ? (
            <button
              type="button"
              data-testid="attention-load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className="border-t border-border px-3.5 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              {loadingMore
                ? t`Loading…`
                : t`Load more (${Math.max(total - items.length, 0)} remaining)`}
            </button>
          ) : null}
          <p className="border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
            {t`Opening a request only returns to its source card.`}
          </p>
        </section>
      </PopoverContent>
    </Popover>
  );
}

export function attentionKey(item: Pick<AttentionQueueItem, "interactionId" | "revision">) {
  return `${item.interactionId}:${item.revision}`;
}

function kindGlyph(kind: AttentionQueueItem["kind"]): string {
  if (kind === "action_approval") return "!";
  if (kind === "plan_review") return "▤";
  if (kind === "session_control") return "▣";
  return "?";
}

function kindLabel(kind: AttentionQueueItem["kind"]): string {
  if (kind === "action_approval") return t`Approval needed`;
  if (kind === "plan_review") return t`Plan review`;
  if (kind === "session_control") return t`Desktop handoff`;
  return t`Answer needed`;
}

function summaryText(item: AttentionQueueItem): string {
  const text = item.presentation.text.trim();
  return text.length > SUMMARY_MAX
    ? `${text.slice(0, SUMMARY_MAX - 1)}…`
    : text || kindLabel(item.kind);
}

function metaText(item: AttentionQueueItem): string {
  const parts = [kindLabel(item.kind), item.botName ?? t`Bot`, item.conversationName];
  if (item.taskTitle) parts.push(item.taskTitle);
  return parts.join(" · ");
}

function notificationTitle(item: AttentionQueueItem): string {
  const bot = item.botName ?? t`Bot`;
  if (item.kind === "action_approval") return t`${bot} needs your approval`;
  if (item.kind === "plan_review") return t`${bot} needs a plan decision`;
  if (item.kind === "session_control") return t`${bot} is waiting for you`;
  return t`${bot} needs your answer`;
}

function notificationBody(item: AttentionQueueItem): string {
  // System notifications carry a fixed sentence per kind: Bot-authored text
  // (presentation, tool arguments, file names, recipients) must never leave the
  // app through the OS notification surface.
  if (item.kind === "action_approval") {
    return t`An approval needs your decision. Open WorkPal to review.`;
  }
  if (item.kind === "plan_review") {
    return t`A plan needs your decision. Open WorkPal to review.`;
  }
  if (item.kind === "session_control") {
    return t`A desktop handoff needs you. Open WorkPal to review.`;
  }
  return t`A question is waiting for your answer. Open WorkPal to review.`;
}
