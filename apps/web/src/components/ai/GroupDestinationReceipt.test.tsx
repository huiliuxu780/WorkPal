// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationReceiptBlock } from "@rakazo/contracts";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import { GroupDestinationReceipt } from "./GroupDestinationReceipt";

const block = (state: CollaborationReceiptBlock["state"]): CollaborationReceiptBlock => ({
  kind: "collaboration_receipt",
  target: { kind: "group", groupId: "group-1", threadId: "thread-1" },
  state,
  destination: {
    kind: "group_message",
    groupId: "group-1",
    threadId: "thread-1",
    messageId: "message-1",
  },
  display: { groupName: "Launch room", topic: "Risk review" },
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

describe("GroupDestinationReceipt", () => {
  it("renders the X-GROUP hierarchy with the persisted locator", () => {
    const html = renderToString(
      <GroupDestinationReceipt block={block("sent")} botName="Joy" onOpen={() => undefined} />,
    );
    expect(html).toContain('data-testid="group-destination-receipt"');
    expect(html).toContain('data-group-id="group-1"');
    expect(html).toContain('data-receipt-state="sent"');
    expect(html).toContain('data-destination-message-id="message-1"');
    expect(html).toContain("Joy has entered “Launch room”");
    expect(html).toContain("At the table");
    expect(html).toContain("Reading the discussion and taking over “Risk review”.");
    expect(html).toContain("Taken over · In progress");
    expect(html).toContain("Go to the room ↗");
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps the destination and shows the %s state",
    (state) => {
      const html = renderToString(
        <GroupDestinationReceipt block={block(state)} botName="Joy" onOpen={() => undefined} />,
      );
      expect(html).toContain(`data-receipt-state="${state}"`);
      expect(html).toContain('data-destination-message-id="message-1"');
      expect(html).toContain(
        state === "completed"
          ? "The result came from “Launch room”"
          : `Work in “Launch room” was ${state === "failed" ? "not completed" : "cancelled"}`,
      );
      expect(html).toContain("View the room ↗");
      expect(html).not.toContain("Taken over · In progress");
      for (const term of ["queued", "Run", "Task", "Thread", "attempt", "steering"]) {
        expect(html).not.toContain(term);
      }
    },
  );

  it("opens the exact persisted group message", () => {
    const onOpen = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <GroupDestinationReceipt block={block("sent")} botName="Joy" onOpen={onOpen} />,
      );
    });
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Open the message in Launch room");
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledWith({ groupId: "group-1", messageId: "message-1" });
  });
});
