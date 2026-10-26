import { t } from "@lingui/core/macro";
import { BotAvatar } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import type { PeerReceiptTarget } from "../../lib/peer-receipts";

const FALLBACK_BOT_COLOR = "#8a8880";

/**
 * One lightweight private-pair receipt between two messages. It is not a Card
 * Shell member and never exposes the exchanged body. Legacy receipts have no
 * locator, so they render as a non-openable record instead of falling back to a
 * generic Thread read.
 */
export function PeerReceiptRow({
  targets,
  botName,
  botColor,
  onOpen,
}: {
  targets: readonly PeerReceiptTarget[];
  botName: (botId: string) => string | undefined;
  botColor: (botId: string) => string | undefined;
  onOpen: (target: PeerReceiptTarget) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const nameOf = (target: PeerReceiptTarget) => botName(target.botId) ?? target.botName ?? t`Bot`;
  const colorOf = (target: PeerReceiptTarget) => botColor(target.botId) ?? FALLBACK_BOT_COLOR;

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setExpanded(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

  if (targets.length === 0) return null;

  if (targets.length === 1) {
    const target = targets[0]!;
    const failed = target.state === "failed" || target.state === "cancelled";
    const received = target.direction === "received";
    const openable = target.destination !== null && !failed;
    const name = nameOf(target);
    const label = failed
      ? t`Not sent to ${name}`
      : received
        ? t`Message from ${name}`
        : t`Messaged ${name}`;
    const content = (
      <>
        <BotAvatar color={colorOf(target)} identity={target.botId} size={22} />
        <span>{failed ? t`Not sent to` : received ? t`Message from` : t`Messaged`}</span>
        <strong className="font-semibold text-foreground/75" dir="auto">
          {name}
        </strong>
        {openable ? (
          <span aria-hidden="true" className="text-[13px] text-muted-foreground/60">
            ›
          </span>
        ) : null}
      </>
    );
    return (
      <div
        ref={rowRef}
        data-testid="peer-receipt-row"
        data-receipt-count="1"
        className="relative flex justify-center py-0.5"
      >
        {openable ? (
          <button
            type="button"
            aria-label={label}
            onClick={() => onOpen(target)}
            className="peer-receipt inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {content}
          </button>
        ) : (
          <span
            data-testid="peer-receipt-unavailable"
            role="note"
            aria-label={failed ? label : t`${label}. This earlier record cannot be opened.`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-muted-foreground/70"
          >
            {content}
          </span>
        )}
      </div>
    );
  }

  const failed = targets.every(
    (target) => target.state === "failed" || target.state === "cancelled",
  );
  const prefix = failed ? t`Not sent to` : t`Messaged`;
  return (
    <div
      ref={rowRef}
      data-testid="peer-receipt-row"
      data-receipt-count={targets.length}
      className="relative flex justify-center py-0.5"
    >
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={expanded}
        aria-label={t`Show the ${targets.length} Agents this message was sent to`}
        onClick={() => setExpanded((value) => !value)}
        className="peer-receipt inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{prefix}</span>
        <span className="flex items-center -space-x-1.5">
          {targets.slice(0, 3).map((target) => (
            <BotAvatar
              key={target.botId}
              color={colorOf(target)}
              identity={target.botId}
              size={22}
            />
          ))}
        </span>
        <strong className="font-semibold text-foreground/75">{t`${targets.length} Agents`}</strong>
        <span
          aria-hidden="true"
          className={`text-[12px] text-muted-foreground/60 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        >
          ⌄
        </span>
      </button>
      {expanded ? (
        <div
          role="menu"
          aria-label={t`Private chats`}
          className="absolute top-[calc(100%+4px)] left-1/2 z-20 w-[min(190px,calc(100vw-40px))] -translate-x-1/2 rounded-[14px] border border-border bg-background p-1.5 shadow-xl"
        >
          {targets.map((target) => {
            const targetFailed = target.state === "failed" || target.state === "cancelled";
            const openable = target.destination !== null && !targetFailed;
            const name = nameOf(target);
            return (
              <button
                key={target.key}
                type="button"
                role="menuitem"
                disabled={!openable}
                aria-label={openable ? t`Open the chat with ${name}` : t`${name} is unavailable`}
                onClick={() => {
                  if (!openable) return;
                  setExpanded(false);
                  onOpen(target);
                }}
                className="flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-start text-[12px] font-medium transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-55"
              >
                <BotAvatar color={colorOf(target)} identity={target.botId} size={24} />
                <span className="min-w-0 truncate" dir="auto">
                  {name}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
