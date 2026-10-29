// @vitest-environment jsdom
/**
 * RT-22 regression net for the single group-panel read path: the capsule and
 * right panel may only consume the frozen GroupPanelQueries port, failures must
 * surface as errors (never as invented identity or files), and artifact paging
 * must carry the server cursor.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GroupPanelState, useGroupPanel } from "./use-group-panel";

const rpcMocks = vi.hoisted(() => ({
  membersList: vi.fn(),
  routinesList: vi.fn(),
  artifactsList: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({
  rpc: {
    groups: {
      members: { list: rpcMocks.membersList },
      routines: { list: rpcMocks.routinesList },
      artifacts: { list: rpcMocks.artifactsList },
    },
  },
}));

const MEMBERS = {
  groupId: "group-1",
  threadId: "thread-1",
  currentUser: {
    kind: "user",
    userId: "user-1",
    name: "Rivers",
    image: null,
    avatarStyle: "bloub",
  },
  agents: [],
  agentCount: 2,
  memberCount: 3,
};

let captured: GroupPanelState | null = null;
let container: HTMLDivElement;
let root: Root;

function Probe({ groupId }: { groupId: string | null }) {
  captured = useGroupPanel(groupId);
  return null;
}

beforeEach(() => {
  captured = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  rpcMocks.membersList.mockReset();
  rpcMocks.routinesList.mockReset();
  rpcMocks.artifactsList.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(groupId: string | null) {
  act(() => {
    root.render(<Probe groupId={groupId} />);
  });
}

async function flush() {
  await act(async () => {});
}

describe("useGroupPanel", () => {
  it("reads members, routines and artifacts only through the group port", async () => {
    rpcMocks.membersList.mockResolvedValue(MEMBERS);
    rpcMocks.routinesList.mockResolvedValue([]);
    rpcMocks.artifactsList.mockResolvedValue({ items: [], nextCursor: null });
    render("group-1");
    await flush();
    expect(rpcMocks.membersList).toHaveBeenCalledWith({ groupId: "group-1" });
    expect(rpcMocks.routinesList).toHaveBeenCalledWith({ groupId: "group-1" });
    expect(rpcMocks.artifactsList).toHaveBeenCalledWith({ groupId: "group-1", limit: 30 });
    expect(captured?.members).toEqual(MEMBERS);
    expect(captured?.membersError).toBeNull();
  });

  it("does not call the port without a group", async () => {
    render(null);
    await flush();
    expect(rpcMocks.membersList).not.toHaveBeenCalled();
    expect(rpcMocks.artifactsList).not.toHaveBeenCalled();
  });

  it("surfaces a members failure instead of inventing identity", async () => {
    rpcMocks.membersList.mockRejectedValue(new Error("boom"));
    rpcMocks.routinesList.mockResolvedValue([]);
    rpcMocks.artifactsList.mockResolvedValue({ items: [], nextCursor: null });
    render("group-1");
    await flush();
    expect(captured?.members).toBeNull();
    expect(captured?.membersError).toBe("boom");
  });

  it("appends the next artifact page with the server cursor", async () => {
    rpcMocks.membersList.mockResolvedValue(MEMBERS);
    rpcMocks.routinesList.mockResolvedValue([]);
    rpcMocks.artifactsList
      .mockResolvedValueOnce({ items: [{ id: "a1" }], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ items: [{ id: "a2" }], nextCursor: null });
    render("group-1");
    await flush();
    await act(async () => {
      await captured?.loadMoreArtifacts();
    });
    expect(rpcMocks.artifactsList).toHaveBeenLastCalledWith({
      groupId: "group-1",
      cursor: "cursor-1",
      limit: 30,
    });
    expect(captured?.artifacts.map((item) => item.id)).toEqual(["a1", "a2"]);
    expect(captured?.nextCursor).toBeNull();
  });
});
