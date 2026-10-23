// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicDelegationGroup } from "../../lib/public-collaboration";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import { PublicDelegationMessage } from "./PublicDelegationMessage";

const group: PublicDelegationGroup = {
  sourceRunId: "source-run",
  senderBotId: "bot-a",
  senderFallbackName: "Alpha old",
  firstMessageId: "out-1",
  messageIds: ["out-1", "in-1", "out-2", "in-2"],
  deliveries: [
    {
      messageId: "out-1",
      targetBotId: "bot-b",
      targetFallbackName: "Beta old",
      targetRunId: "target-complete",
      text: "Review the accessibility pass.",
      status: { kind: "completed" },
    },
    {
      messageId: "out-2",
      targetBotId: "bot-c",
      targetFallbackName: "Gamma old",
      targetRunId: "target-failed",
      text: "Check the narrow layout.",
      status: { kind: "failed", detail: "Permission denied" },
    },
  ],
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function renderUi(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
  return container;
}

describe("PublicDelegationMessage", () => {
  it("renders the real sender, target bodies, and independent mixed states", () => {
    const html = renderToString(
      <PublicDelegationMessage
        group={group}
        resolveBot={(botId) => ({
          name: { "bot-a": "Alpha", "bot-b": "Beta", "bot-c": "Gamma" }[botId],
          color: "#3EC5A8",
          available: true,
        })}
        onOpenMention={() => undefined}
      />,
    );

    expect(html).toContain("Alpha");
    expect(html).toContain("Review the accessibility pass.");
    expect(html).toContain("Check the narrow layout.");
    expect(html).toContain('data-status="completed"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('data-target-run-id="target-complete"');
    expect(html).toContain('data-target-run-id="target-failed"');
    expect(html).not.toContain("100%");
  });

  it("uses current names with stable ids and leaves unavailable targets unlinked", () => {
    const html = renderToString(
      <PublicDelegationMessage
        group={group}
        resolveBot={(botId) => {
          if (botId === "bot-a") return { name: "Alpha Prime", available: true };
          if (botId === "bot-b") return { name: "Beta Prime", available: true };
          return undefined;
        }}
        onOpenMention={() => undefined}
      />,
    ).replace(/<!-- -->/g, "");

    expect(html).toContain("Alpha Prime");
    expect(html).toContain("@Beta Prime");
    expect(html).toContain('href="/app/bot-b"');
    expect(html).toContain('data-bot-id="bot-b"');
    expect(html).toContain("@Gamma old");
    expect(html).toContain('data-mention-available="false"');
    expect(html).not.toContain('href="/app/bot-c"');
  });

  it("keeps every mention and status entry keyboard reachable", async () => {
    const onOpenMention = vi.fn();
    const view = await renderUi(
      <PublicDelegationMessage
        group={group}
        resolveBot={(botId) => ({ name: botId, available: true })}
        onOpenMention={onOpenMention}
      />,
    );
    const mentions = [...view.querySelectorAll<HTMLAnchorElement>('[data-testid="agent-mention"]')];
    const statuses = [
      ...view.querySelectorAll<HTMLElement>('[data-testid="public-delegation-status"]'),
    ];

    expect(mentions).toHaveLength(2);
    expect(statuses).toHaveLength(2);
    for (const element of [...mentions, ...statuses]) {
      await act(async () => element.focus());
      expect(document.activeElement).toBe(element);
    }
    await act(async () => {
      mentions[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenMention).toHaveBeenCalledWith("bot-b");
  });

  it("wraps identities and failures instead of clipping them on narrow layouts", () => {
    const html = renderToString(
      <PublicDelegationMessage
        group={group}
        resolveBot={() => undefined}
        onOpenMention={() => undefined}
      />,
    );

    expect(html).toContain("max-w-[min(560px,94%)]");
    expect(html).toContain("flex-wrap");
    expect(html).toContain("wrap-anywhere");
    expect(html).toContain("Permission denied");
  });
});
