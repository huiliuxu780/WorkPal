// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { TaskCenterItem, TaskCenterPage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const taskCenterRpc = vi.hoisted(() => vi.fn());
const executionSnapshotRpc = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children?: ReactNode }) => children };
});
vi.mock("../../lib/rpc", () => ({
  rpc: {
    runs: {
      taskCenter: taskCenterRpc,
      executionSnapshot: executionSnapshotRpc,
    },
  },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));

import { clearTaskCenterNavIntent, peekTaskCenterNavIntent } from "../../lib/task-center";
import { TaskCenterView } from "./TaskCenterView";

i18n.load("en", {});
i18n.activate("en");

function item(
  runId: string,
  overrides: Partial<TaskCenterItem["summary"]> = {},
  target: TaskCenterItem["target"] = { kind: "bot", botId: `bot-${runId}` },
): TaskCenterItem {
  return {
    summary: {
      runId,
      threadId: `thread-${runId}`,
      botId: `bot-${runId}`,
      rev: 1,
      status: "running",
      trigger: "user",
      title: `Task ${runId}`,
      updatedAt: "2026-10-12T00:00:00.000Z",
      artifacts: [],
      entry: "execution",
      ...overrides,
    },
    target,
  };
}

function page(items: TaskCenterItem[], overrides: Partial<TaskCenterPage> = {}): TaskCenterPage {
  return {
    items,
    nextCursor: null,
    activeCount: items.filter((entry) => entry.summary.status !== "completed").length,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): a leftover default implementation from
  // a previous test would otherwise answer this test's requests.
  vi.resetAllMocks();
  clearTaskCenterNavIntent();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  // Unmount so focus/visibility listeners from earlier tests never consume
  // this test's mocked responses.
  await act(async () => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(<TaskCenterView />);
  });
}

const cards = () => container.querySelectorAll('article[data-testid="execution-card"]');
const verbOf = (index: number) => cards()[index]!.querySelector(".exc-entry")?.textContent ?? null;

describe("TaskCenterView", () => {
  it("renders the server list with the state-specific navigation verbs", async () => {
    taskCenterRpc.mockResolvedValue(
      page([
        item("wait", { status: "waiting_input", waitKind: "approval" }),
        item("work"),
        item("done", { status: "completed" }),
        item("bad", { status: "failed" }),
        item("off", { status: "cancelled" }),
      ]),
    );
    await mount();
    expect(cards()).toHaveLength(5);
    expect(verbOf(0)).toBe("Handle now");
    expect(verbOf(1)).toBe("Back to conversation");
    expect(verbOf(2)).toBe("View result");
    expect(verbOf(3)).toBe("View execution");
    expect(verbOf(4)).toBe("Back to conversation");
  });

  it("uses the existing background presentation for active root Runs on this trusted surface", async () => {
    taskCenterRpc.mockResolvedValue(
      page([item("work"), item("queue", { status: "queued" })], { activeCount: 2 }),
    );
    await mount();
    const running = cards()[0]!;
    expect(running.getAttribute("data-status")).toBe("background");
    expect(running.getAttribute("data-background")).toBe("1");
    expect(running.querySelector(".exc-status")!.textContent).toBe("Running in background");
    const queued = cards()[1]!;
    expect(queued.getAttribute("data-status")).toBe("background");
    expect(queued.querySelector(".exc-status")!.textContent).toBe("Background task");
    // Still no percentage or progress track anywhere.
    expect(container.innerHTML).not.toContain("%");
  });

  it("keeps waiting and terminal states on their own presentation (background never overrides them)", async () => {
    taskCenterRpc.mockResolvedValue(
      page([
        item("wait", { status: "waiting_input", waitKind: "approval" }),
        item("take", { status: "waiting_takeover", waitKind: "takeover" }),
        item("done", { status: "completed" }),
      ]),
    );
    await mount();
    expect(cards()[0]!.getAttribute("data-status")).toBe("approval");
    expect(cards()[0]!.hasAttribute("data-background")).toBe(false);
    expect(cards()[1]!.getAttribute("data-status")).toBe("takeover");
    expect(cards()[2]!.getAttribute("data-status")).toBe("done");
    expect(cards()[2]!.hasAttribute("data-background")).toBe(false);
  });

  it("renders the mobile Open navigation control and wires it to the sidebar", async () => {
    const onOpenNavigation = vi.fn();
    taskCenterRpc.mockResolvedValue(page([], { activeCount: 0 }));
    await act(async () => {
      root.render(<TaskCenterView onOpenNavigation={onOpenNavigation} />);
    });
    const button = container.querySelector(
      '[data-testid="task-center-open-navigation"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Open navigation");
    // Below md only — the desktop sidebar is always present.
    expect(button.className).toContain("md:hidden");
    await act(async () => {
      button.click();
    });
    expect(onOpenNavigation).toHaveBeenCalledTimes(1);
  });

  it("shows the authoritative subtitle and keeps terminals without active Runs", async () => {
    taskCenterRpc.mockResolvedValue(
      page([item("done", { status: "completed" })], { activeCount: 0 }),
    );
    await mount();
    expect(container.querySelector('[data-testid="task-center-subtitle"]')!.textContent).toBe(
      "No tasks running in background",
    );
    expect(cards()).toHaveLength(1);
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    taskCenterRpc.mockResolvedValue(page([item("a"), item("b")], { activeCount: 2 }));
    await mount();
    expect(container.querySelector('[data-testid="task-center-subtitle"]')!.textContent).toBe(
      "2 running in background",
    );
  });

  it("renders the honest empty state", async () => {
    taskCenterRpc.mockResolvedValue(page([], { activeCount: 0 }));
    await mount();
    const empty = container.querySelector('[data-testid="task-center-empty"]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("Nothing is running in the background");
    expect(cards()).toHaveLength(0);
  });

  it("never renders a percentage, a progress track or a guessed remainder", async () => {
    taskCenterRpc.mockResolvedValue(
      page([item("a"), item("done", { status: "completed" })], { activeCount: 1 }),
    );
    await mount();
    const html = container.innerHTML;
    expect(html).not.toContain("%");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(html).not.toMatch(/\bprocessed\b|\btotal\b/);
    // UX-01C acceptance 15: summary-only cards carry no rail, no a/b count
    // and no placeholder — the Task Center never derives Plan progress.
    expect(container.querySelector(".exc-rail")).toBeNull();
    expect(container.querySelector('[data-testid="execution-plan-count"]')).toBeNull();
    expect(html).not.toContain("--");
  });

  it("keeps raw ids out of the DOM while React keys may use them in memory", async () => {
    taskCenterRpc.mockResolvedValue(
      page([
        item(
          "run-secret-id",
          { title: "Quarterly report", threadId: "thread-secret" },
          {
            kind: "group",
            groupId: "group-secret-id",
          },
        ),
      ]),
    );
    await mount();
    const html = container.innerHTML;
    expect(html).not.toContain("data-run-id");
    expect(html).not.toContain("run-secret-id");
    expect(html).not.toContain("group-secret-id");
    expect(html).not.toContain("bot-run-secret-id");
    expect(html).not.toContain("thread-secret");
    // The safe server title still renders.
    expect(html).toContain("Quarterly report");
  });

  it("validates, stores the in-memory intent and navigates to the anchor deep link", async () => {
    executionSnapshotRpc.mockResolvedValue({});
    taskCenterRpc.mockResolvedValue(
      page([item("nav", { anchorMessageId: "msg-1", threadId: "thread-nav" })]),
    );
    await mount();
    await act(async () => {
      (cards()[0]!.querySelector(".exc-entry") as HTMLButtonElement).click();
    });
    expect(executionSnapshotRpc).toHaveBeenCalledWith({ botId: "bot-nav", runId: "nav" });
    expect(navigateMock).toHaveBeenCalledWith("/app/bot-nav?m=msg-1");
    expect(peekTaskCenterNavIntent()).toEqual({
      threadId: "thread-nav",
      runId: "nav",
      rev: 1,
      attention: false,
    });
  });

  it("routes group items to the group conversation and marks waiting intents", async () => {
    executionSnapshotRpc.mockResolvedValue({});
    taskCenterRpc.mockResolvedValue(
      page([
        item(
          "g1",
          { status: "waiting_input", waitKind: "approval", threadId: "thread-g" },
          { kind: "group", groupId: "group-9" },
        ),
      ]),
    );
    await mount();
    await act(async () => {
      (cards()[0]!.querySelector(".exc-entry") as HTMLButtonElement).click();
    });
    expect(executionSnapshotRpc).toHaveBeenCalledWith({ groupId: "group-9", runId: "g1" });
    expect(navigateMock).toHaveBeenCalledWith("/app/g/group-9");
    expect(peekTaskCenterNavIntent()?.attention).toBe(true);
  });

  it("shows stable unavailable feedback and never navigates for a lost Run", async () => {
    executionSnapshotRpc.mockRejectedValue(
      Object.assign(new Error("raw internal failure detail"), { code: "NOT_FOUND", status: 404 }),
    );
    taskCenterRpc.mockResolvedValue(page([item("gone")]));
    await mount();
    await act(async () => {
      (cards()[0]!.querySelector(".exc-entry") as HTMLButtonElement).click();
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(peekTaskCenterNavIntent()).toBeNull();
    expect(container.textContent).toContain("This task is no longer available.");
    // The raw error never surfaces.
    expect(container.textContent).not.toContain("NOT_FOUND");
    expect(container.textContent).not.toContain("raw internal failure detail");
    // No racing refresh: the stable feedback survives until the next natural
    // refresh, whose authoritative window drops the item.
    expect(taskCenterRpc).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      taskCenterRpc.mockResolvedValue(page([]));
      window.dispatchEvent(new Event("focus"));
    });
    expect(container.textContent).not.toContain("This task is no longer available.");
    expect(cards()).toHaveLength(0);
  });

  it("keeps a retryable notice for transient failures without marking the Run lost", async () => {
    executionSnapshotRpc.mockRejectedValue(new Error("network down"));
    taskCenterRpc.mockResolvedValue(page([item("flaky")]));
    await mount();
    await act(async () => {
      (cards()[0]!.querySelector(".exc-entry") as HTMLButtonElement).click();
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn't open this task. Try again.");
    expect(container.textContent).not.toContain("This task is no longer available.");
    expect(container.textContent).not.toContain("network down");
  });

  it("never lets a late out-of-order list response overwrite the newer one", async () => {
    // Request 1 (mount) is slow; request 2 (focus) resolves first and is
    // applied; when request 1 finally lands it must be discarded whole.
    let resolveSlow: ((value: TaskCenterPage) => void) | undefined;
    const slow = new Promise<TaskCenterPage>((resolve) => {
      resolveSlow = resolve;
    });
    taskCenterRpc
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce(page([item("fresh", { rev: 5 })], { activeCount: 1 }));
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(container.textContent).toContain("Task fresh");
    await act(async () => {
      resolveSlow!(page([item("stale-row", { rev: 1 })], { activeCount: 9 }));
    });
    expect(container.textContent).toContain("Task fresh");
    expect(container.textContent).not.toContain("stale-row");
    expect(container.querySelector('[data-testid="task-center-subtitle"]')!.textContent).toBe(
      "1 running in background",
    );
  });

  it("appends a load-more page without duplicating Runs", async () => {
    taskCenterRpc
      .mockResolvedValueOnce(page([item("a"), item("b")], { nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(page([item("b", { rev: 3 }), item("c")], { nextCursor: null }));
    await mount();
    expect(cards()).toHaveLength(2);
    await act(async () => {
      (container.querySelector('[data-testid="task-center-more"]') as HTMLButtonElement).click();
    });
    expect(cards()).toHaveLength(3);
    const titles = [...container.querySelectorAll(".exc-title")].map((node) => node.textContent);
    expect(titles).toEqual(["Task a", "Task b", "Task c"]);
    expect(container.querySelector('[data-testid="task-center-more"]')).toBeNull();
  });

  it("pages with the opaque cursor verbatim (never parsed client-side)", async () => {
    taskCenterRpc
      .mockResolvedValueOnce(page([item("a")], { nextCursor: "opaque-cursor-value" }))
      .mockResolvedValueOnce(page([], { nextCursor: null }));
    await mount();
    await act(async () => {
      (container.querySelector('[data-testid="task-center-more"]') as HTMLButtonElement).click();
    });
    expect(taskCenterRpc).toHaveBeenLastCalledWith({
      cursor: "opaque-cursor-value",
      limit: 30,
    });
  });
});
