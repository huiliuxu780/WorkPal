import { i18n } from "@lingui/core";
import type { ActivityItem, Run } from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ""), ""),
}));
import { ExecutionActivity } from "./ExecutionActivity";

beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("ExecutionActivity", () => {
  it("shows one current line and folds recent records", () => {
    const run = { id: "run", status: "running" } as Run;
    const items = [
      { id: "earlier", runId: "run", status: "completed", kind: "working", title: "Checked files", botId: "bot", threadId: "thread" },
      { id: "now", runId: "run", status: "running", kind: "working", title: "Checking tests", botId: "bot", threadId: "thread" },
    ] as ActivityItem[];
    const html = renderToStaticMarkup(<ExecutionActivity run={run} items={items} />);
    expect(html).toContain("Checking tests");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("hidden");
    expect(html).toContain("Checked files");
  });
});
