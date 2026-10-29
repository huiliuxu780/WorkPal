import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PeerReceiptTarget } from "../../lib/peer-receipts";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import { PeerReceiptRow } from "./PeerReceiptRow";

const target = (overrides: Partial<PeerReceiptTarget> = {}): PeerReceiptTarget => ({
  key: "m1:0:bot-blue",
  botId: "bot-blue",
  botName: "Blue",
  state: "sent",
  destination: null,
  sourceReceiptMessageId: "m1",
  direction: "sent",
  ...overrides,
});

describe("PeerReceiptRow", () => {
  it("renders one lightweight row and opens the bound pair", () => {
    const html = renderToString(
      <PeerReceiptRow
        targets={[
          target({
            destination: { kind: "pair_message", pairThreadId: "pair-1", messageId: "msg-1" },
          }),
        ]}
        botName={() => "Blue"}
        botColor={() => "#08AEEA"}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="peer-receipt-row"');
    expect(html).toContain('data-receipt-count="1"');
    expect(html).toContain('aria-label="Messaged Blue"');
    expect(html).toContain("rakazo-agent-avatar");
    expect(html).not.toContain("peer-receipt-unavailable");
  });

  it("renders a legacy receipt without a locator as non-openable", () => {
    const html = renderToString(
      <PeerReceiptRow
        targets={[target()]}
        botName={() => "Blue"}
        botColor={() => "#08AEEA"}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="peer-receipt-unavailable"');
    expect(html).not.toContain("<button");
  });

  it("renders a compact multi-target toggle instead of three rows", () => {
    const html = renderToString(
      <PeerReceiptRow
        targets={[
          target({
            key: "m1:0:bot-blue",
            botId: "bot-blue",
            destination: { kind: "pair_message", pairThreadId: "p1", messageId: "m1" },
          }),
          target({
            key: "m1:1:bot-red",
            botId: "bot-red",
            destination: { kind: "pair_message", pairThreadId: "p2", messageId: "m2" },
          }),
        ]}
        botName={(botId) => (botId === "bot-blue" ? "Blue" : "Red")}
        botColor={() => "#08AEEA"}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-receipt-count="2"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("2 Agents");
    expect(html).not.toContain('data-testid="peer-receipt-target"');
  });
});
