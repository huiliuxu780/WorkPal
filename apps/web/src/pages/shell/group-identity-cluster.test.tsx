// @vitest-environment jsdom
/**
 * RT-22 AC32 regression net: the capsule and the right-panel header must render
 * the SAME real identity set (current user + every group Agent). Negative cases
 * pin the parts that would silently regress into fake or partial identity:
 * placeholder dots instead of the user, dropped Agents, or variant drift.
 */
import type { GroupMembers } from "@rakazo/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GroupIdentityCluster } from "./group-identity-cluster";

const CHARACTERS = ["dot", "treble", "wave", "bounce", "dot", "treble"] as const;
const COLORS = ["ink", "orange", "blue", "purple", "brown", "pink"] as const;

function members(agentCount: number, image: string | null = null): GroupMembers {
  return {
    groupId: "group-1",
    threadId: "thread-1",
    currentUser: {
      kind: "user",
      userId: "user-1",
      name: "Rivers",
      image,
      avatarStyle: "bloub",
    },
    agents: Array.from({ length: agentCount }, (_, index) => ({
      kind: "agent" as const,
      botId: `bot-${index}`,
      name: `Agent ${index}`,
      color: "#111111",
      avatarMode: "character" as const,
      avatarCharacter: CHARACTERS[index] ?? "dot",
      avatarBodyColor: COLORS[index] ?? "ink",
      status: "idle",
    })),
    agentCount,
    memberCount: agentCount + 1,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(members: GroupMembers, variant: "capsule" | "panel") {
  act(() => {
    root.render(<GroupIdentityCluster members={members} variant={variant} />);
  });
  const cluster = container.querySelector("[data-testid='group-identity-cluster']");
  if (!cluster) throw new Error("cluster missing");
  return cluster;
}

describe("GroupIdentityCluster", () => {
  it("renders one real avatar per Agent plus the current user", () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const cluster = render(members(count), "capsule");
      expect(cluster.querySelectorAll(".rakazo-agent-avatar")).toHaveLength(count);
      expect(cluster.textContent).toContain("R");
    }
  });

  it("uses the stored user image when present instead of an initial", () => {
    const cluster = render(members(2, "https://example.test/me.png"), "panel");
    const image = cluster.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://example.test/me.png");
    expect(cluster.textContent).not.toContain("R");
  });

  it("keeps capsule and panel identity identical for the same members", () => {
    const source = members(4);
    const capsule = render(source, "capsule");
    const panel = render(source, "panel");
    expect(panel.getAttribute("aria-label")).toBe(capsule.getAttribute("aria-label"));
    expect(panel.querySelectorAll(".rakazo-agent-avatar")).toHaveLength(
      capsule.querySelectorAll(".rakazo-agent-avatar").length,
    );
    expect(capsule.getAttribute("aria-label")).toBe("Rivers, Agent 0, Agent 1, Agent 2, Agent 3");
  });

  it("never renders more Agent avatars than the group member cap", () => {
    const overCap = {
      ...members(6),
      agents: [
        ...members(6).agents,
        {
          kind: "agent" as const,
          botId: "bot-overflow",
          name: "Overflow",
          color: "#111111",
          avatarMode: "character" as const,
          avatarCharacter: "dot" as const,
          avatarBodyColor: "ink" as const,
          status: "idle",
        },
      ],
    };
    const cluster = render(overCap, "capsule");
    expect(cluster.querySelectorAll(".rakazo-agent-avatar")).toHaveLength(6);
  });
});
