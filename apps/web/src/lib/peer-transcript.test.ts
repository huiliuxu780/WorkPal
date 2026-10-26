import type { PairThreadMessage, PairThreadMessagePage } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPairPage, pairTranscript } from "./peer-transcript";
import { rpc } from "./rpc";

vi.mock("./rpc", () => ({
  rpc: { threads: { pairMessages: vi.fn(), messages: vi.fn() } },
}));

const pairMessages = vi.mocked(rpc.threads.pairMessages);

const locator = {
  kind: "pair_message" as const,
  pairThreadId: "pair-1",
  messageId: "m-receipt",
};

function page(): PairThreadMessagePage {
  return {
    pairThreadId: "pair-1",
    messages: [],
    totalCount: 0,
    hasMore: false,
    olderCursor: null,
    target: null,
  };
}

function message(
  id: string,
  blocks: PairThreadMessage["blocks"],
  role: PairThreadMessage["role"] = "bot",
  createdAt = "2026-10-25T10:00:00.000Z",
): PairThreadMessage {
  return { id, role, blocks, createdAt };
}

describe("loadPairPage", () => {
  beforeEach(() => {
    pairMessages.mockReset();
    pairMessages.mockResolvedValue(page());
  });

  it("reads through the narrow pair RPC with the receipt and locator", async () => {
    await loadPairPage({
      sourceReceiptMessageId: "m-receipt",
      locator,
      limit: 20,
    });

    expect(pairMessages).toHaveBeenCalledTimes(1);
    expect(pairMessages).toHaveBeenCalledWith(
      {
        sourceReceiptMessageId: "m-receipt",
        locator,
        limit: 20,
      },
      undefined,
    );
    expect(rpc.threads.messages).not.toHaveBeenCalled();
  });

  it("forwards the older cursor and abort signal, never a generic page read", async () => {
    const controller = new AbortController();

    await loadPairPage(
      {
        sourceReceiptMessageId: "m-receipt",
        locator,
        before: "m-oldest",
      },
      { signal: controller.signal },
    );

    const [input, options] = pairMessages.mock.calls[0]!;
    expect(input).toEqual({
      sourceReceiptMessageId: "m-receipt",
      locator,
      before: "m-oldest",
      limit: 50,
    });
    expect(input).not.toHaveProperty("includePeerRuns");
    expect(options).toEqual({ signal: controller.signal });
    expect(rpc.threads.messages).not.toHaveBeenCalled();
  });
});

describe("pairTranscript", () => {
  it("keeps sent and received bodies in order with their timestamps", () => {
    const entries = pairTranscript([
      message(
        "m-out",
        [{ kind: "bot_message_sent", toBotId: "b-2", toBotName: "Analyst", text: "chart q3" }],
        "bot",
        "2026-10-25T10:00:00.000Z",
      ),
      message(
        "m-in",
        [
          {
            kind: "bot_message_received",
            fromBotId: "b-2",
            fromBotName: "Analyst",
            text: "done",
          },
        ],
        "bot",
        "2026-10-25T10:01:00.000Z",
      ),
    ]);

    expect(entries).toEqual([
      {
        id: "m-out",
        direction: "sent",
        text: "chart q3",
        createdAt: "2026-10-25T10:00:00.000Z",
      },
      {
        id: "m-in",
        direction: "received",
        text: "done",
        createdAt: "2026-10-25T10:01:00.000Z",
      },
    ]);
  });

  it("drops the recipient wake copy when its outbound message is loaded", () => {
    const entries = pairTranscript([
      message("m-out", [
        { kind: "bot_message_sent", toBotId: "b-2", toBotName: "Analyst", text: "chart q3" },
      ]),
      message("m-wake", [
        {
          kind: "bot_message_received",
          fromBotId: "b-1",
          fromBotName: "Writer",
          text: "chart q3",
          returnToMessageId: "m-out",
        },
      ]),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["m-out"]);
  });

  it("still renders a legacy-only wake copy once", () => {
    const entries = pairTranscript([
      message("m-wake", [
        {
          kind: "bot_message_received",
          fromBotId: "b-1",
          fromBotName: "Writer",
          text: "chart q3",
          returnToMessageId: "m-not-on-page",
        },
      ]),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe("received");
  });

  it("hides empty bodies and keeps a user text direction as received", () => {
    const entries = pairTranscript([
      message("m-empty", [
        { kind: "bot_message_sent", toBotId: "b-2", toBotName: "Analyst", text: "   " },
      ]),
      message("m-text", [{ kind: "text", text: "hello" }], "user"),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ id: "m-text", direction: "received", text: "hello" }),
    ]);
  });
});
