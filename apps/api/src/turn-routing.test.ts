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
    usageRecord: { create: vi.fn().mockResolvedValue({ id: "usage-1" }) },
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
        yield {
          type: "usage",
          provider: "openai",
          model: "gpt-mini",
          inputTokens: 200,
          outputTokens: 30,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
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
    // Routing spend reaches the same usage accounting path as normal runs.
    expect(prisma.usageRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: "space-1",
        userId: "user-1",
        botId: "finance",
        provider: "openai",
        model: "gpt-mini",
        inputTokens: 200,
        outputTokens: 30,
      }),
    });
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

  it("replaces a stale lead deterministically by lowest bot id", async () => {
    const prisma = prismaMock({ leadBotId: "archived-lead" });
    const provider = createTurnRoutingProvider({
      prisma,
      secrets: {} as never,
      deploymentProvider: "openai",
      deploymentModel: "gpt-mini",
    });

    const routed = await provider.preRoute(baseInput());
    expect(routed?.ownerBotIds).toEqual(["coding"]);
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

describe("resolveTurnRoutingModel (ProductHarnessModelResolver)", () => {
  const leadBot = {
    id: "bot-lead",
    spaceId: "space-1",
    userId: "user-1",
    modelProvider: null,
    modelId: null,
  };

  it("parses PRODUCT_HARNESS_ROUTER_MODEL as provider/model", async () => {
    const { parseProductHarnessRouterModel } = await import("./turn-routing.js");
    expect(parseProductHarnessRouterModel("openai/gpt-mini")).toEqual({
      provider: "openai",
      id: "gpt-mini",
    });
    expect(parseProductHarnessRouterModel("gateway/openai/gpt")).toEqual({
      provider: "gateway",
      id: "openai/gpt",
    });
    expect(parseProductHarnessRouterModel("gpt-only")).toBeNull();
    expect(parseProductHarnessRouterModel("/id")).toBeNull();
    expect(parseProductHarnessRouterModel("provider/")).toBeNull();
    expect(parseProductHarnessRouterModel(undefined)).toBeNull();
    expect(parseProductHarnessRouterModel("")).toBeNull();
  });

  it("prefers the configured router model with its explicit key", async () => {
    const { resolveTurnRoutingModel } = await import("./turn-routing.js");
    const model = await resolveTurnRoutingModel(
      {
        prisma: prismaMock(),
        secrets: {} as never,
        deploymentProvider: "openai",
        deploymentModel: "gpt-mini",
        deploymentModelKey: "deployment-key",
        routerModel: "anthropic/claude-small",
        routerApiKey: "router-key",
      },
      leadBot,
    );
    expect(model).toEqual({ provider: "anthropic", id: "claude-small", apiKey: "router-key" });
  });

  it("uses the deployment key when the configured provider is the deployment provider", async () => {
    const { resolveTurnRoutingModel } = await import("./turn-routing.js");
    const model = await resolveTurnRoutingModel(
      {
        prisma: prismaMock(),
        secrets: {} as never,
        deploymentProvider: "openai",
        deploymentModel: "gpt-mini",
        deploymentModelKey: "deployment-key",
        routerModel: "openai/gpt-nano",
      },
      leadBot,
    );
    expect(model).toEqual({ provider: "openai", id: "gpt-nano", apiKey: "deployment-key" });
  });

  it("falls through an unusable configured model to the deployment default", async () => {
    const { resolveTurnRoutingModel } = await import("./turn-routing.js");
    const model = await resolveTurnRoutingModel(
      {
        prisma: prismaMock(),
        secrets: {} as never,
        deploymentProvider: "openai",
        deploymentModel: "gpt-mini",
        deploymentModelKey: "deployment-key",
        routerModel: "missing-provider/missing-model",
      },
      leadBot,
    );
    expect(model).toEqual({ provider: "openai", id: "gpt-mini", apiKey: "deployment-key" });
  });

  it("treats OAuth-backed models as unusable for routing", async () => {
    const { usableRouterModel } = await import("./turn-routing.js");
    expect(usableRouterModel(null)).toBeNull();
    expect(
      usableRouterModel({
        provider: "subscription",
        id: "claude",
        oauth: { credential: { accessToken: "x" } } as never,
      }),
    ).toBeNull();
    expect(usableRouterModel({ provider: "openai", id: "gpt-mini", apiKey: "k" })).toEqual({
      provider: "openai",
      id: "gpt-mini",
      apiKey: "k",
    });
  });

  it("resolves through the lead connection chain when nothing configured fits", async () => {
    const { resolveTurnRoutingModel } = await import("./turn-routing.js");
    const model = await resolveTurnRoutingModel(
      {
        prisma: prismaMock(),
        secrets: {} as never,
        deploymentProvider: "openai",
        deploymentModel: "gpt-mini",
        deploymentModelKey: undefined,
      },
      leadBot,
    );
    // Judge chain still resolves the deployment default (key comes from the
    // deployment provider match inside that path).
    expect(model).toEqual({ provider: "openai", id: "gpt-mini" });
  });
});
