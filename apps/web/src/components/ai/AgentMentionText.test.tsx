// @vitest-environment jsdom

import type { MessageInline } from "@rakazo/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import { type MentionIdentity, MessageText } from "./AgentMentionText";

const mentions: MessageInline[] = [
  { kind: "bot_mention", botId: "bot-b", label: "Beta" },
  { kind: "text", text: " review this" },
];

const beta: MentionIdentity = { name: "Beta", color: "#3EC5A8", available: true };

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const rendered = (html: string) => html.replace(/<!-- -->/g, "");

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

describe("message mention rendering", () => {
  it("renders an accessible avatar-and-name link to the Bot's long-term chat", () => {
    const html = renderToString(
      <MessageText
        text="@Beta review this"
        inlines={mentions}
        resolveMention={() => beta}
        onOpenMention={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="agent-mention"');
    expect(html).toContain('data-mention-available="true"');
    expect(html).toContain('data-bot-id="bot-b"');
    expect(html).toContain('href="/app/bot-b"');
    expect(html).toContain('aria-label="Open chat with Beta"');
    expect(html).toContain("rakazo-agent-avatar");
    expect(rendered(html)).toContain("@Beta");
    expect(html).toContain("review this");
  });

  it("uses the current Bot name but keeps the stable Bot id after a rename", () => {
    const html = renderToString(
      <MessageText
        text="@Beta review this"
        inlines={mentions}
        resolveMention={() => ({ ...beta, name: "Beta Prime" })}
        onOpenMention={() => undefined}
      />,
    );

    expect(rendered(html)).toContain("@Beta Prime");
    expect(html).toContain('href="/app/bot-b"');
  });

  it("keeps an unavailable Bot readable without a link", () => {
    const html = renderToString(
      <MessageText
        text="@Beta review this"
        inlines={mentions}
        resolveMention={() => undefined}
        onOpenMention={() => undefined}
      />,
    );

    expect(html).toContain('data-mention-available="false"');
    expect(rendered(html)).toContain("@Beta");
    expect(html).not.toContain("href=");
  });

  it("never turns a legacy bare @name into a link", () => {
    const html = renderToString(
      <MessageText
        text="@Beta review this"
        resolveMention={() => beta}
        onOpenMention={() => undefined}
      />,
    );

    expect(html).not.toContain("agent-mention");
    expect(html).not.toContain('href="/app/bot-b"');
    expect(html).toContain("@Beta review this");
  });

  it("navigates on click without triggering a request or a tool", async () => {
    const onOpenMention = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const view = await renderUi(
      <MessageText
        text="@Beta review this"
        inlines={mentions}
        resolveMention={() => beta}
        onOpenMention={onOpenMention}
      />,
    );

    const link = view.querySelector<HTMLAnchorElement>('[data-testid="agent-mention"]');
    if (!link) throw new Error("mention link missing");
    expect(link.tagName).toBe("A");
    expect(link.tabIndex).toBe(0);

    await act(async () => {
      link.focus();
    });
    expect(document.activeElement).toBe(link);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenMention).toHaveBeenCalledTimes(1);
    expect(onOpenMention).toHaveBeenCalledWith("bot-b");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("leaves modified clicks to the browser's default navigation", async () => {
    const onOpenMention = vi.fn();
    const view = await renderUi(
      <MessageText
        text="@Beta review this"
        inlines={mentions}
        resolveMention={() => beta}
        onOpenMention={onOpenMention}
      />,
    );

    const link = view.querySelector<HTMLAnchorElement>('[data-testid="agent-mention"]');
    if (!link) throw new Error("mention link missing");
    await act(async () => {
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
    });

    expect(onOpenMention).not.toHaveBeenCalled();
  });
});
