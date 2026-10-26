import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { PairThreadMessage } from "@rakazo/contracts";
import {
  BotAvatar,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@rakazo/ui-web";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadPairPage, pairTranscript } from "../lib/peer-transcript";
import { formatRelativeTime } from "../lib/relative-time";

const PAGE_SIZE = 50;
const LOAD_OLDER_THRESHOLD_PX = 120;

/**
 * View-only transcript of the long-lived private pair between two Agents.
 * Reads only the narrow `threads.pairMessages` projection bound to the clicked
 * receipt and its message locator; there is no generic Thread query and no
 * write surface.
 */
export function PeerMessagesOverlay({
  botId,
  botName,
  botColor,
  peerBotId,
  peerBotName,
  peerBotColor,
  sourceReceiptMessageId,
  locator,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  sourceReceiptMessageId: string;
  locator: { kind: "pair_message"; pairThreadId: string; messageId: string };
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<readonly PairThreadMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const initialScrollRef = useRef(true);
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);
  const pairThreadId = locator.pairThreadId;
  const locatorMessageId = locator.messageId;

  useEffect(() => {
    const abort = new AbortController();
    setStatus("loading");
    setMessages([]);
    setOlderCursor(null);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    initialScrollRef.current = true;
    void loadPairPage(
      {
        sourceReceiptMessageId,
        locator: { kind: "pair_message", pairThreadId, messageId: locatorMessageId },
        limit: PAGE_SIZE,
      },
      { signal: abort.signal },
    )
      .then((page) => {
        if (abort.signal.aborted) return;
        setMessages(page.messages);
        setOlderCursor(page.olderCursor);
        setStatus("ready");
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setStatus("failed");
      });
    return () => abort.abort();
  }, [sourceReceiptMessageId, pairThreadId, locatorMessageId, reloadKey]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (initialScrollRef.current && status === "ready") {
      initialScrollRef.current = false;
      element.scrollTop = element.scrollHeight;
      return;
    }
    const restore = restoreScrollRef.current;
    if (!restore) return;
    restoreScrollRef.current = null;
    element.scrollTop = element.scrollHeight - restore.height + restore.top;
  }, [messages, status]);

  const loadOlder = useCallback(async () => {
    if (!olderCursor || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const element = scrollRef.current;
    restoreScrollRef.current = element
      ? { height: element.scrollHeight, top: element.scrollTop }
      : null;
    try {
      const page = await loadPairPage({
        sourceReceiptMessageId,
        locator: { kind: "pair_message", pairThreadId, messageId: locatorMessageId },
        before: olderCursor,
        limit: PAGE_SIZE,
      });
      setMessages((current) => [...page.messages, ...current]);
      setOlderCursor(page.olderCursor);
    } catch {
      // Keep the loaded window; the reader can retry by scrolling again.
      restoreScrollRef.current = null;
      } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [sourceReceiptMessageId, pairThreadId, locatorMessageId, olderCursor]);

  const transcript = useMemo(() => pairTranscript(messages), [messages]);
  const title = `${botName} · ${peerBotName}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="peer-conversation-view"
        showCloseButton={false}
        className="inset-0 top-0 left-0 grid h-dvh w-full max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 rounded-none bg-background p-0 text-foreground ring-0 sm:top-1/2 sm:left-1/2 sm:h-[min(900px,calc(100dvh-32px))] sm:w-[min(960px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[26px] sm:ring-1 sm:ring-border"
      >
        <header className="flex flex-col items-center gap-2 px-5 pt-4 pb-2 sm:pt-5">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <div
            data-testid="peer-identity-capsule"
            className="inline-flex min-h-10 items-center gap-2 rounded-full border border-border bg-background px-2 py-1 text-[13.5px] font-semibold shadow-sm sm:min-h-[42px] sm:gap-2.5 sm:px-3.5 sm:text-[14px]"
          >
            <BotAvatar color={botColor} identity={botId} size={28} />
            <span className="max-w-[36vw] truncate" dir="auto">
              {botName}
            </span>
            <span aria-hidden="true" className="font-normal text-muted-foreground/60">
              ↔
            </span>
            <BotAvatar color={peerBotColor} identity={peerBotId} size={28} />
            <span className="max-w-[36vw] truncate" dir="auto">
              {peerBotName}
            </span>
          </div>
          <DialogDescription className="text-center text-[12px] text-muted-foreground/75">
            <Trans>
              You can read this collaboration record, but you cannot speak in the chat between
              Agents.
            </Trans>
          </DialogDescription>
        </header>

        {status === "loading" ? (
          <div className="grid place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>Loading…</Trans>
          </div>
        ) : status === "failed" ? (
          <div className="grid place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <div className="flex flex-col items-center gap-3">
              <Trans>Could not load this chat.</Trans>
              <button
                type="button"
                onClick={() => setReloadKey((value) => value + 1)}
                className="rounded-full border border-border px-3.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trans>Reload</Trans>
              </button>
            </div>
          </div>
        ) : transcript.length === 0 ? (
          <div className="grid place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>No messages with {peerBotName} yet.</Trans>
          </div>
        ) : (
          <div
            ref={scrollRef}
            data-testid="peer-conversation-transcript"
            onScroll={(event) => {
              if (event.currentTarget.scrollTop <= LOAD_OLDER_THRESHOLD_PX) void loadOlder();
            }}
            className="rk-scroll min-h-0 overflow-y-auto px-5 py-4 sm:px-[max(36px,calc((100%-760px)/2))] sm:py-6"
          >
            <p className="mb-5 text-center text-[11px] text-muted-foreground/60">
              <Trans>
                This chat does not appear in your conversation list; {botName} and {peerBotName}{" "}
                will continue here next time they collaborate.
              </Trans>
            </p>
            {loadingOlder ? (
              <div
                className="pb-3 text-center text-[11.5px] text-muted-foreground/60"
                role="status"
              >
                <Trans>Loading earlier messages…</Trans>
              </div>
            ) : null}
            {transcript.map((entry) => {
              const sent = entry.direction === "sent";
              const author = sent ? botName : peerBotName;
              const authorColor = sent ? botColor : peerBotColor;
              const authorId = sent ? botId : peerBotId;
              return (
                <div
                  key={entry.id}
                  data-testid="peer-message"
                  data-direction={entry.direction}
                  className="mb-4 grid grid-cols-[30px_minmax(0,1fr)] gap-2.5"
                >
                  <BotAvatar color={authorColor} identity={authorId} size={30} />
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground/70">
                      <span className="font-medium" dir="auto">
                        {author}
                      </span>
                      <span>{formatRelativeTime(entry.createdAt)}</span>
                    </div>
                    <div
                      className="inline-block max-w-full rounded-[4px_14px_14px_14px] bg-muted px-3.5 py-2.5 text-[13.5px] leading-[1.5] text-foreground/90 sm:text-[14px]"
                      dir="auto"
                    >
                      <ChatMarkdown>{entry.text}</ChatMarkdown>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <footer className="flex items-end justify-center px-4 pt-3 pb-4 sm:min-h-[88px] sm:pt-4 sm:pb-5">
          <DialogClose
            render={
              <button
                type="button"
                className="h-10 rounded-full bg-muted px-6 text-[13.5px] font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-11"
              />
            }
          >
            <Trans>Close chat</Trans>
          </DialogClose>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
