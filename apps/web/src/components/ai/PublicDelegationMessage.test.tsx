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
  senderBotId: "bot-sender",
  senderFallbackName: "Sender stored",
  firstMessageId: "out-1",
  messageIds: ["out-1", "in-1", "out-2", "in-2"],
  deliveries: [
    {
      messageId: "out-1",
      targetBotId: "bot-blue",
      targetFallbackName: "Blue stored",
      targetRunId: "target-blue",
      body: "Check the performance baseline.",
      intent: "request",
      trace: "sent",
    },
    {
      messageId: "out-2",
      targetBotId: "bot-orange",
      targetFallbackName: "Orange stored",
      targetRunId: "target-orange",
      body: "Draft two first-screen options.",
      intent: "request",
      trace: "sent",
    },
  ],
};

const identities: Record<string, { name: string; color: string }> = {
  "bot-sender": { name: "Joy Prime", color: "#5B8DEF" },
  "bot-blue": { name: "Blue Prime", color: "#3EC5A8" },
  "bot-orange": { name: "Orange Prime", color: "#F2994A" },
};

const resolveBot = (botId: string) => {
  const identity = identities[botId];
  return identity ? { ...identity, available: true } : undefined;
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const uncommented = (html: string) => html.replace(/<!-- -->/g, "");

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
  it("renders the real sender, structured mention links, and the natural body", () => {
    const html = uncommented(
      renderToString(
        <PublicDelegationMessage group={group} resolveBot={resolveBot} onOpenMention={() => {}} />,
      ),
    );

    expect(html).toContain('data-testid="public-delegation"');
    expect(html).toContain("Joy Prime");
    expect(html).toContain("@Blue Prime");
    expect(html).toContain('href="/app/bot-blue"');
    expect(html).toContain('data-bot-id="bot-blue"');
    expect(html).toContain("Check the performance baseline.");
    expect(html).toContain("@Orange Prime");
    expect(html).toContain("Draft two first-screen options.");
    expect(html).toContain("Assigned to Blue Prime");
    expect(html).toContain("Assigned to Orange Prime");
  });

  it("keeps every merged delivery on its own target Run and shows no execution state", () => {
    const html = renderToString(
      <PublicDelegationMessage group={group} resolveBot={resolveBot} onOpenMention={() => {}} />,
    );
    const targets = [...html.matchAll(/data-testid="public-delegation-target"/g)];

    expect(targets).toHaveLength(2);
    expect(html).toContain('data-target-run-id="target-blue"');
    expect(html).toContain('data-target-run-id="target-orange"');
    for (const internal of ["data-status", "Queued", "Running", "Completed", "Attempt", "Run "]) {
      expect(html).not.toContain(internal);
    }
  });

  it("renders a red not-sent line for a delivery without a target record", () => {
    const failed: PublicDelegationGroup = {
      ...group,
      deliveries: [
        {
          messageId: "out-lost",
          targetBotId: "bot-gone",
          targetFallbackName: "Gone stored",
          body: "Review the evidence.",
          intent: "request",
          trace: "failed",
        },
      ],
    };
    const html = uncommented(
      renderToString(
        <PublicDelegationMessage
          group={failed}
          resolveBot={() => undefined}
          onOpenMention={() => {}}
        />,
      ),
    );

    expect(html).toContain("Not sent to Gone stored");
    expect(html).toContain("text-destructive");
    expect(html).toContain('data-mention-available="false"');
    expect(html).not.toContain('href="/app/bot-gone"');
    expect(html).not.toContain("Assigned to");
    // The sender record has no paired wake message, so the stored name is the
    // only sender identity available.
    expect(html).toContain("Sender stored");
  });

  it("does not label a result return as an assignment", () => {
    const result: PublicDelegationGroup = {
      ...group,
      deliveries: [
        {
          messageId: "out-result",
          targetBotId: "bot-sender",
          targetFallbackName: "Joy",
          targetRunId: "target-result",
          body: "The baseline finished.",
          intent: "result",
          trace: "sent",
        },
      ],
    };
    const html = renderToString(
      <PublicDelegationMessage group={result} resolveBot={resolveBot} onOpenMention={() => {}} />,
    );

    expect(html).toContain("The baseline finished.");
    expect(html).not.toContain("Assigned to");
  });

  it("keeps mentions keyboard reachable and navigates to the Bot chat, not the pair view", async () => {
    const onOpenMention = vi.fn();
    const view = await renderUi(
      <PublicDelegationMessage
        group={group}
        resolveBot={resolveBot}
        onOpenMention={onOpenMention}
      />,
    );
    const mentions = [...view.querySelectorAll<HTMLAnchorElement>('[data-testid="agent-mention"]')];

    expect(mentions).toHaveLength(2);
    for (const mention of mentions) {
      await act(async () => mention.focus());
      expect(document.activeElement).toBe(mention);
    }
    await act(async () => {
      mentions[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenMention).toHaveBeenCalledTimes(1);
    expect(onOpenMention).toHaveBeenCalledWith("bot-blue");
    expect(view.querySelector('[data-testid="peer-receipt-chip"]')).toBeNull();
  });

  it("wraps long bodies and names instead of widening the bubble", () => {
    const long: PublicDelegationGroup = {
      ...group,
      deliveries: [
        {
          ...group.deliveries[0]!,
          body: "x".repeat(400),
        },
      ],
    };
    const html = renderToString(
      <PublicDelegationMessage group={long} resolveBot={resolveBot} onOpenMention={() => {}} />,
    );

    expect(html).toContain("max-w-full");
    expect(html).toContain("wrap-anywhere");
    expect(html).toContain("min-w-0");
    expect(html).not.toContain("overflow-x");
  });
});
