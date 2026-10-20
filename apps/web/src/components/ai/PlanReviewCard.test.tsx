// @vitest-environment jsdom

import type { InterventionView } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveIntervention = vi.hoisted(() => vi.fn());

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
  rpc: { threads: { resolveIntervention } },
}));

import { PlanReviewCard } from "./PlanReviewCard";

const target = { botId: "bot-1" } as never;

function reviewView(overrides: Partial<InterventionView> = {}): InterventionView {
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: `item-${index + 1}`,
    title: `Stage ${index + 1}`,
    status: "pending" as const,
  }));
  return {
    id: "intervention-plan",
    revision: 1,
    kind: "plan_review",
    status: "pending",
    spaceId: "space-1",
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    botId: "bot-1",
    messageId: "message-plan",
    createdAt: "2026-10-20T00:00:00.000Z",
    requestingActor: { botId: "bot-1" },
    planReview: {
      content: {
        planId: "plan:run-1",
        contentVersion: 2,
        revision: 4,
        goal: "Deliver the quarterly report",
        items,
        source: "plan_exit",
      },
    },
    presentation: { text: "Plan v2 is ready for your review." },
    ...overrides,
  } as InterventionView;
}

async function renderCard(
  view: InterventionView,
  props: Partial<Parameters<typeof PlanReviewCard>[0]> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settled: InterventionView[] = [];
  await act(async () => {
    root.render(
      <PlanReviewCard
        view={view}
        botName="Aria"
        target={target}
        onSettled={(next) => settled.push(next)}
        {...props}
      />,
    );
  });
  return { container, settled };
}

function click(container: HTMLElement, testId: string) {
  const node = container.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`missing ${testId}`);
  return act(async () => {
    (node as HTMLElement).click();
  });
}

beforeEach(() => {
  resolveIntervention.mockReset();
  resolveIntervention.mockResolvedValue({
    outcome: "accepted",
    intervention: reviewView({ status: "answered" }),
  });
});

describe("PlanReviewCard", () => {
  it("renders the projected version binding with the three fixed actions and no always-allow", async () => {
    const { container } = await renderCard(reviewView());
    const card = container.querySelector('[data-testid="plan-review-card"]')!;
    expect(card.getAttribute("data-plan-id")).toBe("plan:run-1");
    expect(card.getAttribute("data-content-version")).toBe("2");
    expect(container.textContent).toContain("Aria submitted a plan for your review");
    expect(container.textContent).toContain("Version v2");
    expect(container.textContent).toContain("Deliver the quarterly report");
    expect(container.textContent).toContain("Stage 1");
    expect(container.textContent).toContain("Stage 3");
    expect(container.querySelector('[data-testid="plan-review-approve"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="plan-review-request-changes"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="plan-review-reject"]')).toBeTruthy();
    expect(container.textContent).not.toMatch(/always allow/i);
  });

  it("collapses beyond eight items and expands on demand", async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `item-${index + 1}`,
      title: `Stage ${index + 1}`,
      status: "pending" as const,
    }));
    const view = reviewView();
    view.planReview!.content.items = items;
    const { container } = await renderCard(view);
    expect(container.querySelectorAll("[data-plan-item-id]").length).toBe(8);
    expect(container.textContent).toContain("Show all (2 more)");
    await click(container, "plan-review-show-all");
    expect(container.querySelectorAll("[data-plan-item-id]").length).toBe(10);
  });

  it("approves with an idempotent submission id", async () => {
    const { container, settled } = await renderCard(reviewView());
    await click(container, "plan-review-approve");
    expect(resolveIntervention).toHaveBeenCalledTimes(1);
    const call = resolveIntervention.mock.calls[0]![0];
    expect(call.answer).toBe("approve");
    expect(call.interventionId).toBe("intervention-plan");
    expect(call.clientSubmissionId.length).toBeGreaterThanOrEqual(8);
    expect(call.feedback).toBeUndefined();
    expect(settled).toHaveLength(1);
  });

  it("requires concrete feedback for request changes and submits it", async () => {
    const { container } = await renderCard(reviewView());
    await click(container, "plan-review-request-changes");
    const send = container.querySelector(
      '[data-testid="plan-review-send-feedback"]',
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const textarea = container.querySelector('[data-testid="plan-review-feedback"]');
    await act(async () => {
      const native = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!
        .set!;
      native.call(textarea, "Split stage 2 into review and sign-off");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container, "plan-review-send-feedback");
    expect(resolveIntervention).toHaveBeenCalledTimes(1);
    expect(resolveIntervention.mock.calls[0]![0]).toMatchObject({
      answer: "request_changes",
      feedback: "Split stage 2 into review and sign-off",
    });
  });

  it("rejects with an optional reason", async () => {
    const { container } = await renderCard(reviewView());
    await click(container, "plan-review-reject");
    await click(container, "plan-review-confirm-reject");
    expect(resolveIntervention).toHaveBeenCalledTimes(1);
    expect(resolveIntervention.mock.calls[0]![0].answer).toBe("reject");
    expect(resolveIntervention.mock.calls[0]![0].feedback).toBeUndefined();
  });

  it("shows the honest failure and keeps the card operable after a raced decision", async () => {
    resolveIntervention.mockRejectedValueOnce(
      new Error("This prompt is no longer awaiting an answer"),
    );
    let refreshed = 0;
    const { container } = await renderCard(reviewView(), {
      onRefresh: async () => {
        refreshed += 1;
      },
    });
    await click(container, "plan-review-approve");
    const alert = container.querySelector('[data-testid="plan-review-error"]')!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("no longer awaiting an answer");
    expect(refreshed).toBe(1);
    expect(container.querySelector('[data-testid="plan-review-approve"]')).toBeTruthy();
  });

  it("renders the terminal decision from the server projection without actions", async () => {
    const view = reviewView({ status: "answered" });
    view.planReview = {
      ...view.planReview!,
      decision: "request_changes",
      feedback: "Add a rollout stage",
    };
    const { container } = await renderCard(view);
    expect(container.querySelector('[data-testid="plan-review-approve"]')).toBeNull();
    const authority = container.querySelector('[data-testid="plan-review-authority"]')!;
    expect(authority.textContent).toContain("Changes requested");
    expect(authority.textContent).toContain("Add a rollout stage");
  });

  it("renders a rejection as rejected, not as a tool denial", async () => {
    const view = reviewView({ status: "answered" });
    view.planReview = { ...view.planReview!, decision: "reject" };
    const { container } = await renderCard(view);
    expect(container.textContent).toContain("Plan rejected");
    expect(container.textContent).not.toMatch(/denied/i);
  });
});
