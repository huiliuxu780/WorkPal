// @vitest-environment jsdom
import { BotAvatar } from "@rakazo/ui-web";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvatarRuntime } from "./avatar-runtime";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listArchived: vi.fn(),
  avatarStates: vi.fn(),
}));

vi.mock("./rpc", () => ({
  rpc: {
    bots: {
      list: mocks.list,
      listArchived: mocks.listArchived,
      avatarStates: mocks.avatarStates,
    },
  },
}));

describe("AvatarRuntime polling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.list.mockResolvedValue([
      { id: "bot-1", name: "Rex", avatarMode: "character", avatarCharacter: "wave" },
    ]);
    mocks.listArchived.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("lands avatar states when every poll outlives the 2s interval", async () => {
    // Sustained latency above the polling interval: in an unserialized poller
    // every response arrives after the next tick bumped the sequence, so no
    // response is ever accepted and the avatar stays stale indefinitely.
    let revision = 0;
    mocks.avatarStates.mockImplementation(
      () =>
        new Promise((resolve) => {
          revision += 1;
          const current = revision;
          setTimeout(
            () =>
              resolve([
                {
                  botId: "bot-1",
                  state: "working",
                  runId: null,
                  revision: current,
                  updatedAt: null,
                },
              ]),
            2500,
          );
        }),
    );

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/app/bot-1"]}>
          <AvatarRuntime enabled>
            <BotAvatar color="#8B5CF6" identity="bot-1" size={24} />
          </AvatarRuntime>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    const avatar = container.querySelector(".rakazo-agent-avatar");
    expect(avatar?.getAttribute("data-bot-id")).toBe("bot-1");
    expect(avatar?.getAttribute("data-state")).toBe("working");
  });
});
