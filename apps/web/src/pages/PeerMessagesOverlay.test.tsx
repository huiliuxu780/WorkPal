// @vitest-environment jsdom

import type { PairThreadMessage, PairThreadMessagePage } from "@rakazo/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const mocks = vi.hoisted(() => ({ pairMessages: vi.fn() }));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../lib/rpc", () => ({
  rpc: { threads: { pairMessages: mocks.pairMessages, messages: vi.fn() } },
}));

import { PeerMessagesOverlay } from "./PeerMessagesOverlay";

const locator = {
  kind: "pair_message" as const,
  pairThreadId: "pair-1",
  messageId: "m-receipt",
};

function message(id: string, blocks: PairThreadMessage["blocks"]): PairThreadMessage {
  return { id, role: "bot", blocks, createdAt: "2026-10-25T10:00:00.000Z" };
}

function page(
  messages: PairThreadMessage[],
  overrides: Partial<PairThreadMessagePage> = {},
): PairThreadMessagePage {
  return {
    pairThreadId: "pair-1",
    messages,
    totalCount: messages.length,
    hasMore: false,
    olderCursor: null,
    target: null,
    ...overrides,
  };
}

const sent = message("m-sent", [
  { kind: "bot_message_sent", toBotId: "bot-2", toBotName: "Analyst", text: "SENT-BODY" },
]);
const received = message("m-received", [
  {
    kind: "bot_message_received",
    fromBotId: "bot-2",
    fromBotName: "Analyst",
    text: "RECEIVED-BODY",
  },
]);

let roots: Array<{ root: Root; host: HTMLDivElement }> = [];

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderOverlay(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(
      <PeerMessagesOverlay
        botId="bot-1"
        botName="Writer"
        botColor="#08AEEA"
        peerBotId="bot-2"
        peerBotName="Analyst"
        peerBotColor="#14B8A6"
        sourceReceiptMessageId="m-receipt"
        locator={locator}
        onClose={() => undefined}
      />,
    );
  });
  await flush();
  return host;
}

beforeEach(() => {
  mocks.pairMessages.mockReset();
});

afterEach(async () => {
  for (const { root, host } of roots) {
    await act(async () => root.unmount());
    host.remove();
  }
  roots = [];
  document.body.innerHTML = "";
});

describe("PeerMessagesOverlay", () => {
  it("reads only the narrow pair RPC and renders a read-only transcript", async () => {
    mocks.pairMessages.mockResolvedValue(page([sent, received]));
    await renderOverlay();

    expect(mocks.pairMessages).toHaveBeenCalledTimes(1);
    expect(mocks.pairMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceReceiptMessageId: "m-receipt",
        locator,
        limit: 50,
      }),
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(document.body.textContent).toContain("Writer · Analyst");
    expect(document.body.textContent).toContain("SENT-BODY");
    expect(document.body.textContent).toContain("RECEIVED-BODY");
    expect(document.body.textContent).toContain("cannot speak in the chat between Agents");
    expect(document.querySelectorAll('[data-testid="peer-message"]')).toHaveLength(2);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="peer-message"]')];
    expect(rows[0]?.getAttribute("data-direction")).toBe("sent");
    expect(rows[0]?.getAttribute("data-author-id")).toBe("bot-1");
    expect(rows[0]?.className).toContain("flex-row-reverse");
    expect(rows[0]?.textContent).toContain("Writer");
    expect(rows[0]?.querySelector(".rakazo-agent-avatar")).not.toBeNull();
    expect(rows[1]?.getAttribute("data-direction")).toBe("received");
    expect(rows[1]?.getAttribute("data-author-id")).toBe("bot-2");
    expect(rows[1]?.className).not.toContain("flex-row-reverse");
    expect(rows[1]?.textContent).toContain("Analyst");
    expect(rows[1]?.querySelector(".rakazo-agent-avatar")).not.toBeNull();
    expect(document.querySelector("input, textarea")).toBeNull();
    expect(document.body.textContent).not.toContain("Send");
    expect(document.body.textContent).toContain("Close chat");
  });

  it("shows the other Bot's reply on the received side", async () => {
    mocks.pairMessages.mockResolvedValue(
      page([
        message("m-reply", [
          { kind: "bot_message_sent", toBotId: "bot-1", toBotName: "Writer", text: "REPLY-BODY" },
        ]),
      ]),
    );
    await renderOverlay();

    const row = document.querySelector<HTMLElement>('[data-testid="peer-message"]');
    expect(row?.getAttribute("data-direction")).toBe("received");
    expect(row?.getAttribute("data-author-id")).toBe("bot-2");
    expect(row?.textContent).toContain("Analyst");
    expect(row?.className).not.toContain("flex-row-reverse");
  });

  it("renders the recipient wake copy once", async () => {
    mocks.pairMessages.mockResolvedValue(
      page([
        sent,
        message("m-wake", [
          {
            kind: "bot_message_received",
            fromBotId: "bot-1",
            fromBotName: "Writer",
            text: "SENT-BODY",
            returnToMessageId: "m-sent",
          },
        ]),
      ]),
    );
    await renderOverlay();

    expect(document.querySelectorAll('[data-testid="peer-message"]')).toHaveLength(1);
  });

  it("pages older messages with the server cursor instead of refetching the first page", async () => {
    mocks.pairMessages.mockResolvedValueOnce(
      page([received], { hasMore: true, olderCursor: "m-oldest", totalCount: 2 }),
    );
    mocks.pairMessages.mockResolvedValueOnce(page([sent], { totalCount: 2 }));
    await renderOverlay();

    const transcript = document.querySelector('[data-testid="peer-conversation-transcript"]');
    expect(transcript).not.toBeNull();
    await act(async () => {
      transcript!.scrollTop = 0;
      transcript!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await flush();

    expect(mocks.pairMessages).toHaveBeenCalledTimes(2);
    expect(mocks.pairMessages.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        sourceReceiptMessageId: "m-receipt",
        locator,
        before: "m-oldest",
        limit: 50,
      }),
    );
    expect(document.body.textContent).toContain("SENT-BODY");
    expect(document.body.textContent).toContain("RECEIVED-BODY");
  });

  it("offers only Reload on failure and recovers on retry", async () => {
    mocks.pairMessages.mockRejectedValueOnce(new Error("denied"));
    mocks.pairMessages.mockResolvedValueOnce(page([sent]));
    await renderOverlay();

    expect(document.body.textContent).toContain("Could not load this chat.");
    expect(document.querySelectorAll("button")).toHaveLength(2);
    const reload = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Reload"),
    );
    await act(async () => reload?.click());
    await flush();

    expect(document.body.textContent).toContain("SENT-BODY");
    expect(document.body.textContent).not.toContain("Could not load this chat.");
  });
});
