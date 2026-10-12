import { describe, expect, it } from "vitest";
import { ProductEventPayloadSchemas, ProductEventSchema } from "./events.js";

describe("Product Event v2 contract", () => {
  it("parses each new event payload and rejects an incomplete approval resolution", () => {
    const valid = {
      "run.retried": { attempt: 2, reason: "transient_unavailable" },
      "budget.exceeded": { reason: "tool_calls", limit: 20 },
      "delivery.created": { deliveryId: "delivery-1", sourceRunId: "run-1" },
      "delivery.sent": { deliveryId: "delivery-1", messageId: "message-1" },
      "delivery.failed": { deliveryId: "delivery-1", reason: "thread_cleared" },
      "approval.requested": { approvalEffectId: "effect-1" },
      "approval.resolved": { approvalEffectId: "effect-1", decision: "approved" },
    } as const;
    for (const type of Object.keys(valid) as Array<keyof typeof valid>) {
      expect(ProductEventPayloadSchemas[type].safeParse(valid[type]).success).toBe(true);
    }
    expect(
      ProductEventPayloadSchemas["approval.resolved"].safeParse({
        approvalEffectId: "effect-1",
      }).success,
    ).toBe(false);
  });

  it("keeps legacy event JSON readable without envelope fields", () => {
    expect(
      ProductEventSchema.parse({
        id: "event-1",
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 1,
        type: "run.started",
        createdAt: "2026-10-12T00:00:00.000Z",
        payload: {},
      }),
    ).toMatchObject({ id: "event-1", type: "run.started" });
  });
});
