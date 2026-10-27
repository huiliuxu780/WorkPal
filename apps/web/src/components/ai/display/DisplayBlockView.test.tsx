// @vitest-environment jsdom

import type { DisplayBlock } from "@rakazo/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const getArtifact = vi.hoisted(() => vi.fn());

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children?: ReactNode }) => children };
});
vi.mock("../../../lib/rpc", () => ({
  rpc: { artifacts: { get: getArtifact } },
}));

import { DisplayBlockList, DisplayBlockView } from "./DisplayBlockView";

const target = { botId: "bot-1" };
const mounted: Array<{ root: Root; host: HTMLElement }> = [];

async function render(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  return host;
}

beforeEach(() => {
  getArtifact.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:artifact");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

describe("DisplayBlockView", () => {
  it("renders markdown and keeps it read-only", async () => {
    const host = await render(
      <DisplayBlockView
        block={{ kind: "markdown", blockId: "m:0:text", text: "## Weekly summary\n\nBody" }}
        target={target}
      />,
    );
    expect(host.querySelector('[data-testid="display-block"]')?.getAttribute("data-kind")).toBe(
      "markdown",
    );
    expect(host.textContent).toContain("Weekly summary");
    expect(host.querySelector("button")?.textContent).not.toBe("Approve");
  });

  it("renders a structured table with columns and rows", async () => {
    const block: Extract<DisplayBlock, { kind: "table" }> = {
      kind: "table",
      blockId: "m:1:table",
      columns: [
        { id: "name", label: "Name" },
        { id: "count", label: "Count" },
      ],
      rows: [
        ["Alpha", "2"],
        ["Beta", "1"],
      ],
    };
    const host = await render(<DisplayBlockView block={block} target={target} />);
    expect(host.textContent).toContain("Alpha");
    expect(host.textContent).toContain("Count");
  });

  it("fails closed for an unreadable chart", async () => {
    const host = await render(
      <DisplayBlockView
        block={{ kind: "chart", blockId: "m:2:chart", name: "Trend", spec: null, data: [] }}
        target={target}
      />,
    );
    expect(host.textContent).toContain("This chart data cannot be displayed.");
  });

  it("renders a collection without action controls", async () => {
    const host = await render(
      <DisplayBlockView
        block={{
          kind: "collection",
          blockId: "m:3:card",
          title: "Release",
          items: [
            { id: "a", label: "Owner", value: "Ada", detail: null },
            { id: "b", label: "Status", value: "Ready", detail: "Friday" },
          ],
        }}
        target={target}
      />,
    );
    expect(host.textContent).toContain("Owner");
    expect(host.textContent).toContain("Ada");
    expect(host.querySelector("button")).toBeNull();
  });

  it("renders a file media card and keeps HTML behind the sandbox", async () => {
    const fileHost = await render(
      <DisplayBlockView
        block={{
          kind: "media",
          blockId: "m:4:file",
          mediaKind: "file",
          artifactId: "a-1",
          name: "brief.pdf",
          mimeType: "application/pdf",
          size: 2048,
        }}
        target={target}
      />,
    );
    expect(fileHost.textContent).toContain("brief.pdf");

    getArtifact.mockResolvedValue({
      contentBase64: btoa("<h1>Report</h1>"),
      mimeType: "text/html",
    });
    const htmlHost = await render(
      <DisplayBlockView
        block={{
          kind: "html",
          blockId: "m:5:file",
          artifactId: "a-2",
          title: "Report",
          sandboxed: true,
        }}
        target={target}
      />,
    );
    await act(async () =>
      [...htmlHost.querySelectorAll("button")]
        .find((button) => button.textContent === "Open report")
        ?.click(),
    );
    await act(async () => await Promise.resolve());
    expect(htmlHost.textContent).toContain("Report");
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("renders task status and a page entry", async () => {
    const statusHost = await render(
      <DisplayBlockView
        block={{
          kind: "task_status",
          blockId: "m:6:subagent",
          status: "completed",
          title: "Researcher",
          summary: "Found three sources.",
          source: { threadId: "t-1", messageId: "m", runId: "run-1" },
        }}
        target={target}
      />,
    );
    expect(statusHost.textContent).toContain("Completed");
    expect(statusHost.textContent).toContain("Researcher");

    const pageHost = await render(
      <DisplayBlockView
        block={{
          kind: "page",
          blockId: "m:7:file",
          pageId: "a-3",
          title: "Brief",
          available: true,
        }}
        target={target}
      />,
    );
    expect(pageHost.querySelector("a")?.getAttribute("href")).toBe("/app/artifacts/a-3");
  });

  it("renders voice duration and transcript without faking audio", async () => {
    const host = await render(
      <DisplayBlockView
        block={{
          kind: "voice",
          blockId: "m:8:voice",
          artifactId: null,
          durationMs: 14_000,
          transcript: "Hello\nGoodbye",
        }}
        target={target}
      />,
    );
    expect(host.textContent).toContain("0:14");
    expect(host.textContent).toContain("Audio is not recorded for this call.");
    expect(host.textContent).toContain("Goodbye");
  });

  it("uses a chart companion table rather than duplicating it", async () => {
    const chart: DisplayBlock = {
      kind: "chart",
      blockId: "m:9:chart",
      name: "Trend",
      spec: { mark: "line" },
      data: [{ x: 1, y: 2 }],
    };
    const table: DisplayBlock = {
      kind: "table",
      blockId: "m:9:chart:table",
      columns: [
        { id: "x", label: "x" },
        { id: "y", label: "y" },
      ],
      rows: [["1", "2"]],
    };
    const host = await render(<DisplayBlockList blocks={[chart, table]} target={target} />);
    expect(host.querySelectorAll('[data-testid="display-block"]')).toHaveLength(1);
    expect(host.querySelector('[data-kind="chart"]')).not.toBeNull();
  });
});
