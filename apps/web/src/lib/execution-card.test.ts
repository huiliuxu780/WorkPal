import { i18n } from "@lingui/core";
import type { ActivityItem, ExecutionSummary, InterventionView, Run } from "@rakazo/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));

import { buildExecutionCardModel, lifecycleRailFill, resultHasText } from "./execution-card";
import { deriveExecutionStatus } from "./execution-status";

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

const run = (status: Run["status"], waitKind: Run["waitKind"] = null) =>
  ({ id: "run-id-1", status, waitKind, error: null }) as Run;

function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    runId: "run-id-1",
    threadId: "thread-id-1",
    botId: "bot-id-1",
    rev: 4,
    status: "completed",
    trigger: "user",
    title: "Analyze this year's tickets",
    updatedAt: "2026-10-12T10:18:00.000Z",
    artifacts: [],
    entry: "execution",
    ...overrides,
  };
}

function intervention(overrides: Partial<InterventionView> = {}): InterventionView {
  return {
    id: "intervention-id-1",
    revision: 1,
    kind: "approval",
    status: "pending",
    spaceId: "space-id-1",
    threadId: "thread-id-1",
    runId: "run-id-1",
    attemptId: "attempt-id-1",
    botId: "bot-id-1",
    messageId: "message-id-1",
    createdAt: "2026-10-12T00:00:00.000Z",
    requestingActor: { botId: "bot-id-1" },
    presentation: { text: "Send the report to billing@example.com?" },
    ...overrides,
  };
}

const activity = (title: string, status: ActivityItem["status"] = "running"): ActivityItem =>
  ({
    id: `act-${title}`,
    runId: "run-id-1",
    botId: "bot-id-1",
    threadId: "thread-id-1",
    kind: "working",
    status,
    title,
  }) as ActivityItem;

function model(
  runState: Run | null,
  items: readonly ActivityItem[] = [],
  options: Parameters<typeof deriveExecutionStatus>[2] = {},
  input: Partial<Parameters<typeof buildExecutionCardModel>[0]> = {},
) {
  const status = deriveExecutionStatus(runState, items, options);
  return buildExecutionCardModel({
    status,
    expanded: false,
    canExpand: true,
    ...input,
  });
}

describe("buildExecutionCardModel status coverage", () => {
  it("maps queued with no fabricated metadata", () => {
    const card = model(run("queued"), [], {}, { summary: null });
    expect(card.status).toBe("unknown");
    expect(card.statusLabel).toBe("Execution queued");
    expect(card.live).toBe(true);
    expect(card.title).toBeNull();
    expect(card.aux).toBeNull();
    expect(card.metaParts).toEqual([]);
    expect(card.railFill).toBeNull();
    expect(card.action).toEqual({ verb: "View execution", act: "toggle" });
  });

  it("maps leased to the starting activity line", () => {
    const card = model(run("leased"));
    expect(card.status).toBe("working");
    expect(card.aux).toEqual({ kind: "activity", text: "Starting" });
    expect(card.action?.verb).toBe("View execution");
  });

  it("maps running to the latest safe activity line", () => {
    const card = model(run("running"), [activity("Checking ticket TK-19002")]);
    expect(card.status).toBe("working");
    expect(card.aux).toEqual({ kind: "activity", text: "Checking ticket TK-19002" });
  });

  it("maps waiting approval with the sanitized question first", () => {
    const card = model(
      run("waiting_input", "approval"),
      [],
      { pendingInterventionKinds: ["approval"] },
      {
        summary: summary({ status: "waiting_input", waitKind: "approval" }),
        pendingInterventions: [intervention()],
      },
    );
    expect(card.status).toBe("approval");
    expect(card.needsAttention).toBe(true);
    expect(card.aux).toEqual({
      kind: "intervention",
      text: "Send the report to billing@example.com?",
    });
    expect(card.action).toEqual({ verb: "Needs your attention", act: "attention" });
  });

  it("orders an approval ahead of an older input question", () => {
    const card = model(
      run("waiting_input", "approval"),
      [],
      { pendingInterventionKinds: ["input", "approval"] },
      {
        pendingInterventions: [
          intervention({
            id: "input-1",
            kind: "input",
            createdAt: "2026-10-11T00:00:00.000Z",
            presentation: { text: "Which city?" },
          }),
          intervention({
            id: "approval-1",
            createdAt: "2026-10-12T00:00:00.000Z",
            presentation: { text: "Send it now?" },
          }),
        ],
      },
    );
    expect(card.aux).toEqual({ kind: "intervention", text: "Send it now?" });
  });

  it("maps waiting input", () => {
    const card = model(
      run("waiting_input", "input"),
      [],
      { pendingInterventionKinds: ["input"] },
      {
        pendingInterventions: [
          intervention({ kind: "input", presentation: { text: "Which city?" } }),
        ],
      },
    );
    expect(card.status).toBe("need_input");
    expect(card.aux).toEqual({ kind: "intervention", text: "Which city?" });
  });

  it("maps waiting takeover without inventing an intervention line", () => {
    const card = model(run("waiting_takeover", "takeover"), [], {
      pendingInterventionKinds: [],
    });
    expect(card.status).toBe("takeover");
    expect(card.aux).toEqual({ kind: "activity", text: "Open the computer to take control" });
    expect(card.action).toEqual({ verb: "Needs your attention", act: "attention" });
  });

  it("maps completed with outcome, real metadata and the result verb", () => {
    const card = model(
      run("completed"),
      [],
      {},
      {
        summary: summary({
          outcome: "Found 3 anomalous tickets",
          completedAt: "2026-10-12T11:04:00.000Z",
          durationMs: 46 * 60_000 + 5_000,
          counts: { steps: 3, actions: 12, agents: 2, artifacts: 1 },
          artifacts: [{ id: "artifact-1", name: "report.md" }],
        }),
      },
    );
    expect(card.status).toBe("done");
    expect(card.aux).toEqual({ kind: "outcome", text: "Found 3 anomalous tickets" });
    expect(card.title).toBe("Analyze this year's tickets");
    expect(card.metaParts).toEqual([
      "3 steps",
      "12 actions",
      "2 collaborators",
      "1 artifact",
      "46m 05s",
    ]);
    expect(card.artifactsLine).toBe("Generated report.md");
    expect(card.when).not.toBeNull();
    expect(card.action).toEqual({ verb: "View result", act: "toggle" });
  });

  it("yields the outcome line to the expanded result section", () => {
    const card = model(
      run("completed"),
      [],
      {},
      {
        summary: summary({ outcome: "Found 3 anomalous tickets" }),
        expanded: true,
        hasResult: true,
      },
    );
    expect(card.aux).toBeNull();
    expect(card.action).toEqual({ verb: "Collapse", act: "toggle" });
  });

  it("suppresses the outcome line while the result bubble is on the page", () => {
    const card = model(
      run("completed"),
      [],
      {},
      { summary: summary({ outcome: "Found 3 anomalous tickets" }), resultOnPage: true },
    );
    expect(card.aux).toBeNull();
    const offPage = model(
      run("completed"),
      [],
      {},
      { summary: summary({ outcome: "Found 3 anomalous tickets" }), resultOnPage: false },
    );
    expect(offPage.aux).toEqual({ kind: "outcome", text: "Found 3 anomalous tickets" });
  });

  it("maps failed with the safe failure projection and no retry action", () => {
    const card = model(
      run("failed"),
      [],
      {},
      {
        summary: summary({ status: "failed", failure: "The billing service timed out" }),
        steps: [
          { order: 0, title: "Collect", status: "completed" },
          { order: 1, title: "Deploy", status: "failed" },
          { order: 2, title: "Report", status: "pending" },
        ] as never,
      },
    );
    expect(card.status).toBe("failed");
    expect(card.aux).toEqual({
      kind: "failure",
      text: "Step 2 · Deploy · The billing service timed out",
    });
    expect(card.action).toEqual({ verb: "View execution", act: "toggle" });
    expect(JSON.stringify(card)).not.toMatch(/retry/i);
  });

  it("maps cancelled without a result sentence", () => {
    const card = model(
      run("cancelled"),
      [],
      {},
      { summary: summary({ status: "cancelled", outcome: "stale outcome" }) },
    );
    expect(card.status).toBe("cancelled");
    expect(card.aux).toBeNull();
    expect(card.live).toBe(false);
    expect(card.action?.verb).toBe("View execution");
  });

  it("maps a confirmed background Run without a live tint", () => {
    const card = model(run("running"), [activity("Digesting inbox")], {
      confirmedRootBackground: true,
    });
    expect(card.status).toBe("background");
    expect(card.background).toBe(true);
    expect(card.live).toBe(false);
  });

  it("omits everything untrusted for unknown or incomplete fields", () => {
    const card = model(null, [], {}, { summary: null, canExpand: false });
    expect(card.status).toBe("unknown");
    expect(card.statusLabel).toBe("Status unknown");
    expect(card.title).toBeNull();
    expect(card.aux).toBeNull();
    expect(card.metaParts).toEqual([]);
    expect(card.when).toBeNull();
    expect(card.railFill).toBeNull();
    expect(card.action).toBeNull();
  });

  it("never renders zero counts, placeholders or percentages", () => {
    const card = model(
      run("completed"),
      [],
      {},
      { summary: summary({ counts: { steps: 0, actions: 0 } }) },
    );
    expect(card.metaParts).toEqual([]);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("%");
    expect(serialized).not.toContain("--");
  });

  it("keeps identifiers, credentials and raw errors out of the model", () => {
    const card = model(
      run("failed"),
      [],
      {},
      {
        summary: summary({ status: "failed", failure: "The billing service timed out" }),
        pendingInterventions: [
          intervention({
            presentation: {
              text: "Sign in to continue?",
              credential: {
                name: "Billing",
                origin: "https://billing.internal",
                authType: "login",
              } as never,
            },
          }),
        ],
      },
    );
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("run-id-1");
    expect(serialized).not.toContain("thread-id-1");
    expect(serialized).not.toContain("bot-id-1");
    expect(serialized).not.toContain("attempt-id-1");
    expect(serialized).not.toContain("billing.internal");
    expect(card.aux?.text).toBe("The billing service timed out");
  });
});

describe("lifecycleRailFill", () => {
  const steps = (statuses: string[]) =>
    statuses.map((status, order) => ({ order, title: `s${order}`, status })) as never;

  it("fills to the failed step", () => {
    expect(lifecycleRailFill("failed", steps(["completed", "failed", "pending"]), false)).toBe(
      2 / 3,
    );
  });
  it("stays base-only when a failed Run has no failed step", () => {
    expect(
      lifecycleRailFill("failed", steps(["completed", "running", "pending"]), false),
    ).toBeNull();
  });
  it("is full when done even if stale steps lag behind", () => {
    expect(lifecycleRailFill("done", steps(["completed", "pending"]), false)).toBe(1);
  });
  it("is full when done", () => {
    expect(lifecycleRailFill("done", steps(["completed", "completed"]), false)).toBe(1);
  });
  it("counts completed steps while running", () => {
    expect(lifecycleRailFill("working", steps(["completed", "running", "pending"]), false)).toBe(
      1 / 3,
    );
  });
  it("is null without steps or with a truncated list", () => {
    expect(lifecycleRailFill("working", [], false)).toBeNull();
    expect(lifecycleRailFill("working", undefined, false)).toBeNull();
    expect(lifecycleRailFill("working", steps(["completed", "running"]), true)).toBeNull();
  });
});

describe("resultHasText", () => {
  it("only accepts a real text block", () => {
    expect(resultHasText(undefined)).toBe(false);
    expect(
      resultHasText({ messageId: "m", blocks: [{ kind: "text", text: "  " }], truncated: false }),
    ).toBe(false);
    expect(
      resultHasText({ messageId: "m", blocks: [{ kind: "text", text: "done" }], truncated: false }),
    ).toBe(true);
  });
});

describe("actionOverride (Task Center navigation verbs)", () => {
  const base = { expanded: false, canExpand: false };

  it("replaces the computed action with the caller's navigation verb", () => {
    const model = buildExecutionCardModel({
      ...base,
      status: deriveExecutionStatus(run("completed"), []),
      summary: summary(),
      actionOverride: { verb: "View result", act: "navigate" },
    });
    expect(model.action).toEqual({ verb: "View result", act: "navigate" });
  });

  it("overrides the attention action for waiting Runs without touching the status", () => {
    const status = deriveExecutionStatus(run("waiting_input", "approval"), []);
    const model = buildExecutionCardModel({
      ...base,
      status,
      summary: summary({ status: "waiting_input", waitKind: "approval" }),
      actionOverride: { verb: "Handle now", act: "navigate" },
    });
    expect(model.action).toEqual({ verb: "Handle now", act: "navigate" });
    // The shared derivation still owns the state — no second matrix.
    expect(model.status).toBe("approval");
    expect(model.needsAttention).toBe(true);
  });

  it("renders no action when the override is null (unavailable item)", () => {
    const model = buildExecutionCardModel({
      ...base,
      status: deriveExecutionStatus(run("running"), []),
      summary: summary({ status: "running" }),
      actionOverride: null,
    });
    expect(model.action).toBeNull();
  });

  it("keeps the chat behavior untouched when no override is passed", () => {
    const model = buildExecutionCardModel({
      expanded: false,
      canExpand: true,
      status: deriveExecutionStatus(run("running"), []),
      summary: summary({ status: "running" }),
    });
    expect(model.action).toEqual({ verb: "View execution", act: "toggle" });
  });
});
