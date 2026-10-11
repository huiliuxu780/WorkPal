import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ""), ""),
}));

import type { RunPlanRevision } from "@rakazo/contracts";
import { RunPlanDisclosure } from "./RunPlanDisclosure";

describe("RunPlanDisclosure", () => {
  it("shows a published Plan's goal and reported statuses, and collapses after the Run", () => {
    const plan: RunPlanRevision = {
      planId: "plan:run-1",
      runId: "run-1",
      sourceMessageId: "message-1",
      revisionId: "plan:run-1:2",
      revision: 2,
      goal: "Check and deliver",
      items: [
        { id: "check", title: "Check source", status: "completed" },
        { id: "deliver", title: "Deliver result", status: "active" },
      ],
      changeReason: "Source reviewed",
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const live = renderToStaticMarkup(<RunPlanDisclosure plan={plan} live />);
    expect(live).toContain('data-slot="plan"');
    expect(live).toContain("Check and deliver");
    expect(live).toContain("1/2 done");
    expect(live).toContain('data-plan-status="active"');
    expect(live).toContain("Plan updated");
    expect(live).toContain(" open");
    expect(renderToStaticMarkup(<RunPlanDisclosure plan={plan} live={false} />)).not.toContain(
      " open",
    );
  });
});
