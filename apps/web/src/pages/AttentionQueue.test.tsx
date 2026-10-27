// @vitest-environment jsdom

import type { AttentionQueueItem } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { attention: { list } } }));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: React.ReactNode }) => children,
}));

import { AttentionQueue } from "./AttentionQueue";

const ISO = "2026-10-27T10:00:00.000Z";

function item(overrides: Partial<AttentionQueueItem> = {}): AttentionQueueItem {
  return {
    stableId: "i-1",
    interactionId: "i-1",
    revision: 1,
    kind: "input_request",
    status: "pending",
    attentionAt: ISO,
    expiresAt: null,
    source: {
      spaceId: "space-1",
      threadId: "thread-1",
      messageId: "message-1",
      runId: "run-1",
      botId: "bot-1",
    },
    presentation: { text: "Which city should I use?" },
    botName: "Scout",
    conversationKind: "direct",
    conversationId: "bot-1",
    conversationName: "Scout",
    taskTitle: "Plan the launch",
    ...overrides,
  };
}

type Rendered = { host: HTMLElement; root: ReturnType<typeof createRoot> };
const rendered: Rendered[] = [];

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  rendered.push({ host, root });
  await act(async () => root.render(node));
  return host;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static instances: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  list.mockReset();
  FakeNotification.permission = "granted";
  FakeNotification.instances = [];
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
});

afterEach(() => {
  for (const { host, root } of rendered.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AttentionQueue", () => {
  it("renders nothing and does not query while the card gate is off", async () => {
    const host = await render(
      <AttentionQueue
        enabled={false}
        activeTarget={null}
        botNotificationsEnabled={() => true}
        refreshToken={0}
        onOpenItem={() => undefined}
        onItems={() => undefined}
      />,
    );
    expect(host.textContent).toBe("");
    expect(list).not.toHaveBeenCalled();
  });

  it("loads the queue, establishes a baseline, and notifies only new revisions", async () => {
    list.mockResolvedValue({ items: [item()], total: 1, nextCursor: null });
    const onOpenItem = vi.fn();
    const onItems = vi.fn();
    const host = await render(
      <AttentionQueue
        enabled
        activeTarget={{ botId: "other-bot" }}
        botNotificationsEnabled={() => true}
        refreshToken={0}
        onOpenItem={onOpenItem}
        onItems={onItems}
      />,
    );
    await flush();
    expect(host.querySelector('[data-testid="attention-count"]')?.textContent).toBe("1");
    expect(onItems).toHaveBeenCalledWith([item()]);
    // The first load is the baseline: old pending work never pops a notification.
    expect(FakeNotification.instances).toHaveLength(0);

    const second = item({
      interactionId: "i-2",
      stableId: "i-2",
      taskTitle: null,
      presentation: { text: "Ship the release?" },
    });
    list.mockResolvedValue({ items: [item(), second], total: 2, nextCursor: null });
    await act(async () => {
      host.ownerDocument.defaultView!.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.title).toContain("Scout");
    expect(FakeNotification.instances[0]?.options?.body).toContain("Ship the release?");
    expect(FakeNotification.instances[0]?.options?.body).not.toContain("Which city");

    // Same revision again: no duplicate notification.
    await act(async () => {
      host.ownerDocument.defaultView!.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(FakeNotification.instances).toHaveLength(1);

    // Clicking the notification returns to the source interaction.
    FakeNotification.instances[0]?.onclick?.();
    expect(onOpenItem).toHaveBeenCalledWith(second);
  });

  it("suppresses a notification for the source thread in the foreground", async () => {
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    const host = await render(
      <AttentionQueue
        enabled
        activeTarget={{ botId: "bot-1" }}
        botNotificationsEnabled={() => true}
        refreshToken={0}
        onOpenItem={() => undefined}
        onItems={() => undefined}
      />,
    );
    await flush();
    list.mockResolvedValue({
      items: [item({ interactionId: "i-3", stableId: "i-3" })],
      total: 1,
      nextCursor: null,
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      host.ownerDocument.defaultView!.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("opens a row without submitting any decision", async () => {
    const onOpenItem = vi.fn();
    list.mockResolvedValue({ items: [item()], total: 1, nextCursor: null });
    const host = await render(
      <AttentionQueue
        enabled
        activeTarget={null}
        botNotificationsEnabled={() => true}
        refreshToken={0}
        onOpenItem={onOpenItem}
        onItems={() => undefined}
      />,
    );
    await flush();
    const trigger = host.querySelector('[data-testid="attention-entry"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    const row = document.querySelector('[data-testid="attention-item"]') as HTMLButtonElement;
    expect(row.textContent).toContain("Which city should I use?");
    expect(row.textContent).toContain("Scout");
    expect(row.textContent).not.toContain("run-1");
    await act(async () => row.click());
    expect(onOpenItem).toHaveBeenCalledWith(item());
  });

  it("shows the empty and error states", async () => {
    list.mockResolvedValueOnce({ items: [], total: 0, nextCursor: null });
    const host = await render(
      <AttentionQueue
        enabled
        activeTarget={null}
        botNotificationsEnabled={() => true}
        refreshToken={0}
        onOpenItem={() => undefined}
        onItems={() => undefined}
      />,
    );
    await flush();
    expect(host.querySelector('[data-testid="attention-empty"]')).toBeNull();
    await act(async () =>
      (host.querySelector('[data-testid="attention-entry"]') as HTMLButtonElement).click(),
    );
    expect(document.querySelector('[data-testid="attention-empty"]')?.textContent).toContain(
      "Nothing needs you",
    );

    list.mockRejectedValue(new Error("boom"));
    const retryHost = await render(
      <AttentionQueue
        enabled
        activeTarget={null}
        botNotificationsEnabled={() => true}
        refreshToken={1}
        onOpenItem={() => undefined}
        onItems={() => undefined}
      />,
    );
    await flush();
    await act(async () =>
      (retryHost.querySelector('[data-testid="attention-entry"]') as HTMLButtonElement).click(),
    );
    expect(document.body.textContent).toContain("Couldn't load pending requests.");
  });
});
