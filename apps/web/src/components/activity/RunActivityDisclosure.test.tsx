// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Macros compile away in the app build; tests run the source directly.
vi.mock("@lingui/react/macro", () => ({
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ""), ""),
}));

import type { ActivityItem } from "@rakazo/contracts";
import { RunActivityDisclosure } from "./RunActivityDisclosure";

function item(overrides: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    botId: "bot-a",
    threadId: "thread-1",
    kind: "working",
    status: "running",
    title: "Working",
    ...overrides,
  };
}

const FORBIDDEN = [
  "plan_enter",
  "plan_write",
  "plan_exit",
  "agent_spawn",
  "agent_send",
  "task_output",
  "task_cancel",
  "message_bot",
  "handoff_to_bot",
  "run_subagent",
  "thread.collaboration",
  "thread.turn",
  "bot_message",
];

describe("RunActivityDisclosure", () => {
  it("is open while live and shows the working summary", () => {
    const html = renderToStaticMarkup(
      <RunActivityDisclosure
        items={[item({ id: "plan:run-1", kind: "planning", title: "Planning" })]}
        live
        actionCount={4}
      />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("open");
    expect(html).toContain("Working… · 4 actions");
    expect(html).toContain("Planning");
  });

  it("collapses to a Done summary with duration when finished", () => {
    const html = renderToStaticMarkup(
      <RunActivityDisclosure
        items={[
          item({ id: "a", kind: "delegation", status: "completed", title: "Asked Finance for help" }),
          item({ id: "b", kind: "delegation", status: "completed", title: "Finance returned a result" }),
          item({ id: "c", kind: "completed", status: "completed", title: "Completed" }),
        ]}
        live={false}
        actionCount={3}
        durationMs={41_000}
      />,
    );
    expect(html).not.toContain(" open");
    expect(html).toContain("Done · 3 actions · 41s");
  });

  it("folds repeated tool rows into a count", () => {
    const tools = [1, 2, 3].map((n) =>
      item({
        id: `tool:run-1:t${n}`,
        kind: "tool" as const,
        status: "completed" as const,
        title: "Reading file",
      }),
    );
    const html = renderToStaticMarkup(<RunActivityDisclosure items={tools} live={false} />);
    expect(html).toContain("Reading file ×3");
    expect(html).toContain("Done · 3 actions");
  });

  it("windows long live runs and keeps actionable rows visible", () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      item({ id: `d${i}`, kind: "delegation" as const, status: "completed" as const, title: `Step ${i}` }),
    );
    items.push(
      item({ id: "wait", kind: "waiting_input", status: "waiting", title: "Waiting for your answer" }),
    );
    const html = renderToStaticMarkup(<RunActivityDisclosure items={items} live />);
    expect(html).toContain("Waiting for your answer");
    expect(html).toMatch(/\+\d+ earlier/);
  });

  it("never leaks runtime internals into user-visible text", () => {
    const html = renderToStaticMarkup(
      <RunActivityDisclosure
        items={[
          item({ id: "plan:run-1", kind: "planning", title: "Planning" }),
          item({ id: "collab:run-2", kind: "delegation", title: "Asked Finance for help" }),
          item({ id: "bg:1", kind: "background", title: "Working in background" }),
        ]}
        live
      />,
    );
    for (const forbidden of FORBIDDEN) {
      expect(html, `${forbidden} must not appear`).not.toContain(forbidden);
    }
  });

  it("renders nothing for a finished run without actions", () => {
    const html = renderToStaticMarkup(<RunActivityDisclosure items={[]} live={false} />);
    expect(html).toBe("");
  });
});
