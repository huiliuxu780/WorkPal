import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

function handlerFor(cardsUnifiedV2: boolean | undefined) {
  const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;
  const deps = {
    prisma,
    cardsUnifiedV2,
    env: {
      agentRuntime: "scripted",
      defaultProvider: undefined,
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "s".repeat(32),
    },
  } as unknown as RouterDeps;
  return new RPCHandler(createRouter(deps));
}

async function call(handler: RPCHandler<ReturnType<typeof createRouter>>, procedure: string) {
  const { response } = await handler.handle(
    new Request(`http://127.0.0.1/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  return response;
}

describe("attention.list gate", () => {
  it("fails explicitly instead of returning an empty page while unified cards are off", async () => {
    const response = await call(handlerFor(false), "attention/list");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("unified cards");
  });

  it("keeps the queue unavailable when the gate is not configured", async () => {
    const response = await call(handlerFor(undefined), "attention/list");
    expect(response.status).toBe(403);
  });
});
