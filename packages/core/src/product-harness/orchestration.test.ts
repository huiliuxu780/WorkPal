import { describe, expect, it } from "vitest";
import {
  buildRunOrchestration,
  parseRunOrchestration,
} from "./orchestration.js";

describe("buildRunOrchestration", () => {
  it("records the v1 decision for a routed specialist turn", () => {
    expect(
      buildRunOrchestration({
        kind: "group_router",
        ownerBotId: "coding",
        responseMode: "single",
        reasonCode: "specialist_match",
      }),
    ).toEqual({
      version: "v1",
      routing: { kind: "group_router", reasonCode: "specialist_match" },
      ownership: { mode: "owner", ownerBotId: "coding" },
      responseMode: "single",
    });
  });

  it("omits the reason code for deterministic routing", () => {
    const snapshot = buildRunOrchestration({
      kind: "explicit_mention",
      ownerBotId: "finance",
      responseMode: "single",
      reasonCode: null,
    });
    expect(snapshot.routing).toEqual({ kind: "explicit_mention" });
  });
});

describe("parseRunOrchestration", () => {
  it("round-trips a built snapshot", () => {
    const built = buildRunOrchestration({
      kind: "group_router",
      ownerBotId: "coding",
      responseMode: "single",
      reasonCode: "generalist_match",
    });
    expect(parseRunOrchestration(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it("rejects absent, malformed or unknown-version values", () => {
    expect(parseRunOrchestration(null)).toBeNull();
    expect(parseRunOrchestration(undefined)).toBeNull();
    expect(parseRunOrchestration("v1")).toBeNull();
    expect(parseRunOrchestration([])).toBeNull();
    expect(parseRunOrchestration({ version: "v2", routing: { kind: "direct" } })).toBeNull();
    expect(
      parseRunOrchestration({
        version: "v1",
        routing: { kind: "wild-west" },
        ownership: { mode: "owner", ownerBotId: "a" },
        responseMode: "single",
      }),
    ).toBeNull();
    expect(
      parseRunOrchestration({
        version: "v1",
        routing: { kind: "direct" },
        ownership: { mode: "sneaky", ownerBotId: "a" },
        responseMode: "single",
      }),
    ).toBeNull();
    expect(
      parseRunOrchestration({
        version: "v1",
        routing: { kind: "direct" },
        ownership: { mode: "owner", ownerBotId: "" },
        responseMode: "single",
      }),
    ).toBeNull();
  });

  it("drops an unknown reason code but keeps the rest of the decision", () => {
    const parsed = parseRunOrchestration({
      version: "v1",
      routing: { kind: "group_router", reasonCode: "because-i-said-so" },
      ownership: { mode: "owner", ownerBotId: "coding" },
      responseMode: "single",
    });
    expect(parsed).toEqual({
      version: "v1",
      routing: { kind: "group_router" },
      ownership: { mode: "owner", ownerBotId: "coding" },
      responseMode: "single",
    });
  });
});
