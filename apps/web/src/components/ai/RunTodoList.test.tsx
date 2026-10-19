// @vitest-environment jsdom
/**
 * UX-01C acceptance 16/17: the legacy Todo fallback ("事项清单").
 * It renders only inside an already-legal execution surface whose expanded
 * data has neither Plan nor Steps, uses the approved copy, never shows the
 * words "Todo"/"待办" or any count/fraction, and orders rows deterministically.
 */
import { i18n } from "@lingui/core";
import type { RunTodoSnapshot } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ""), ""),
}));

import { RunTodoList } from "./RunTodoList";

const ISO = "2026-08-16T00:00:00.000Z";

function todo(overrides: Partial<RunTodoSnapshot> = {}): RunTodoSnapshot {
  return {
    todoId: "t1",
    runId: "run-1",
    sourceMessageId: null,
    revision: 1,
    order: 0,
    title: "Prepare the release notes",
    status: "pending",
    linkedStepId: null,
    reason: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("RunTodoList (legacy fallback)", () => {
  it("renders the approved preamble and never the words Todo/待办", () => {
    const html = renderToStaticMarkup(<RunTodoList todos={[todo()]} />);
    expect(html).toContain('data-slot="todos"');
    expect(html).toContain("This run has no plan. These were the working items at the time.");
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).not.toMatch(/todo/i);
    expect(text).not.toContain("待办");
  });

  it("shows no count, fraction or progress anywhere", () => {
    const html = renderToStaticMarkup(
      <RunTodoList todos={[todo(), todo({ todoId: "t2", order: 1 })]} />,
    );
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(html).not.toContain("progressbar");
    // Two items must not leak a "2 items" style count either.
    expect(text).not.toMatch(/\b2\b/);
  });

  it("orders rows by order then todoId and keeps status labels", () => {
    const html = renderToStaticMarkup(
      <RunTodoList
        todos={[
          todo({ todoId: "b", order: 1, title: "Third item", status: "active" }),
          todo({ todoId: "a", order: 1, title: "Second item", status: "resolved" }),
          todo({ todoId: "c", order: 0, title: "First item", status: "deferred" }),
        ]}
      />,
    );
    const first = html.indexOf("First item");
    const second = html.indexOf("Second item");
    const third = html.indexOf("Third item");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    expect(html).toContain('data-todo-status="deferred"');
    expect(html).toContain("In progress");
    expect(html).toContain("Resolved");
    expect(html).toContain("Deferred");
  });

  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(<RunTodoList todos={[]} />)).toBe("");
  });

  it("keeps a row reason as secondary text", () => {
    const html = renderToStaticMarkup(
      <RunTodoList todos={[todo({ status: "deferred", reason: "Waiting on access" })]} />,
    );
    expect(html).toContain("Waiting on access");
  });
});
