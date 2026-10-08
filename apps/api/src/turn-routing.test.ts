import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createTurnRoutingProvider } from "./turn-routing.js";

const activeMembers = [
  {
    bot: {
      id: "finance",
      name: "Finance",
      title: "Budget owner",
      description: "spreadsheets",
      userId: "user-1",
      spaceId: "space-1",
      modelProvider: null,
      modelId: null,
    },
  },
  {
    bot: {
      id: "coding",
      name: "Coding",
      title: "Engineer",
      description: "software architecture",
      userId: "user-1",
      spaceId: "space-1",
      modelProvider: null,
      modelId: null,
    },
  },
];

function prismaMock(overrides: {
  leadBotId?: string | null;
  members?: typeof activeMembers;
  reply?: { role: string; botId: string | null } | null;
} = {}) {
  return {
    chatGroup: {
      findFirst: vi.fn().mockResolvedValue({
        id: "group-1",
        leadBotId: overrides.leadBotId === undefined ? "finance" : overrides.leadBotId,
        members: overrides.members ?? activeMembers,
      }),
    },
    message: { findFirst: vi.fn().mockResolvedValue(overrides.reply ?? null) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaClient;
}

function fakeRuntime(text: string | Error) {
  const requests: AgentRunRequest[] = [];
  const runtime = {
    describe: () => ({ capabilities: {} }),
    run(request: AgentRunRequest) {
      requests.push(request);
      return (async function* () {
        if (text instanceof Error) throw text;
        yield { type: "done", text };
      })();
    },
    abort: async () => {},
  } as unknown as AgentRuntime;
  return { runtime, requests };
}

const specialistAnswer =
  '{"ownerBotId":"coding","responseMode":"single","reasonCode":"specialist_match","confidence":"high"}';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    spaceId: "space-1",
    userId: "user-1",
    groupId: "group-1",
    threadId: "thread-1",
    text: "look at this please",
    explicitMentionIds: [],
    ...overrides,
  };
}

describe("createTurnRoutingProvider", () => {
  it("does not run the router for an explicitly mentioned turn", async () => {
    const prisma = prismaMock();
    const { runtime, requests } = fakeRuntime(specialistAnswer);
    const provider = createTurnRoutingProvider({
      prisma,
      runtime,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    await expect(
      provider.preRoute(baseInput({ text: "@Finance check the budget" })),
    ).resolves.toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("does not run the router for a reply-addressed turn", async () => {
    const prisma = prismaMock({ reply: { role: "bot", botId: "coding" } });
    const { runtime, requests } = fakeRuntime(specialistAnswer);
    const provider = createTurnRoutingProvider({
      prisma,
      runtime,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    await expect(
      provider.preRoute(baseInput({ replyToMessageId: "msg-9" })),
    ).resolves.toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("routes an unaddressed group turn to the router-selected specialist", async () => {
    const prisma = prismaMock();
    const { runtime, requests } = fakeRuntime(specialistAnswer);
    const provider = createTurnRoutingProvider({
      prisma,
      runtime,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    const routed = await provider.preRoute(baseInput({ text: "看看这套 API 架构合理吗" }));

    expect(routed).toEqual({
      routeKind: "group_router",
      ownerBotIds: ["coding"],
      responseMode: "single",
      reasonCode: "specialist_match",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.executionScope).toBe("turn-routing");
    expect(requests[0]?.prompt).toContain("id=finance");
  });

  it("falls back to the lead on router failure — never throws at the sender", async () => {
    const prisma = prismaMock();
    const { runtime } = fakeRuntime(new Error("model unavailable"));
    const provider = createTurnRoutingProvider({
      prisma,
      runtime,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    await expect(provider.preRoute(baseInput())).resolves.toEqual({
      routeKind: "fallback_lead",
      ownerBotIds: ["finance"],
      responseMode: "single",
      reasonCode: "fallback_lead",
    });
  });

  it("falls back to the lead when the router invents a non-member", async () => {
    const prisma = prismaMock();
    const { runtime } = fakeRuntime(
      '{"ownerBotId":"ghost-bot","responseMode":"single","reasonCode":"specialist_match","confidence":"high"}',
    );
    const provider = createTurnRoutingProvider({
      prisma,
      runtime,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    const routed = await provider.preRoute(baseInput());
    expect(routed?.routeKind).toBe("fallback_lead");
    expect(routed?.ownerBotIds).toEqual(["finance"]);
  });

  it("uses the lead deterministically without any runtime, at zero model cost", async () => {
    const prisma = prismaMock();
    const provider = createTurnRoutingProvider({
      prisma,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    await expect(provider.preRoute(baseInput())).resolves.toMatchObject({
      routeKind: "fallback_lead",
      ownerBotIds: ["finance"],
    });
  });

  it("deterministically replaces a stale lead with the first active member", async () => {
    const prisma = prismaMock({ leadBotId: "archived-lead" });
    const provider = createTurnRoutingProvider({
      prisma,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    const routed = await provider.preRoute(baseInput());
    expect(routed?.ownerBotIds).toEqual(["finance"]);
  });

  it("returns null for a group with no active members", async () => {
    const prisma = prismaMock({ members: [] });
    const provider = createTurnRoutingProvider({
      prisma,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    await expect(provider.preRoute(baseInput())).resolves.toBeNull();
  });
});
