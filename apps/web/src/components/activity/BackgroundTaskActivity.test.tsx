// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + String(values[i] ?? ""), ""),
}));

import type { ActivityItem } from "@rakazo/contracts";
import { BackgroundTaskActivity } from "./BackgroundTaskActivity";

function bg(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    id: "bg:task-1",
    runId: "run-1",
    botId: "bot-a",
    threadId: "thread-1",
    kind: "background",
    status: "running",
    title: "Working in background",
    ...overrides,
  };
}

describe("BackgroundTaskActivity", () => {
  it("offers cancel only while the task is running", () => {
    const running = renderToStaticMarkup(
      <BackgroundTaskActivity items={[bg({ taskId: "task-1" })]} onCancel={async () => {}} />,
    );
    expect(running).toContain('data-testid="background-task-cancel"');
    expect(running).toContain("Cancel");
    expect(running).toContain("Working in background");

    const done = renderToStaticMarkup(
      <BackgroundTaskActivity
        items={[bg({ status: "completed", title: "Background task completed", taskId: undefined })]}
        onCancel={async () => {}}
      />,
    );
    expect(done).not.toContain("background-task-cancel");
    expect(done).toContain("Background task completed");
  });

  it("survives without a cancel handler and shows short failure detail", () => {
    const html = renderToStaticMarkup(
      <BackgroundTaskActivity
        items={[
          bg({ status: "failed", title: "Background research failed", detail: "model unavailable" }),
        ]}
      />,
    );
    expect(html).toContain('data-status="failed"');
    expect(html).toContain("model unavailable");
    expect(html).not.toContain("Cancel");
  });

  it("renders nothing when there are no background tasks", () => {
    expect(renderToStaticMarkup(<BackgroundTaskActivity items={[]} />)).toBe("");
  });

  it("disables repeat cancellation while sending and reports an RPC failure", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let rejectRequest: (reason?: unknown) => void = () => {};
    const onCancel = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectRequest = reject;
    }));
    try {
      await act(async () => root.render(
        <BackgroundTaskActivity items={[bg({ taskId: "task-1" })]} onCancel={onCancel} />,
      ));
      const button = host.querySelector<HTMLButtonElement>("button")!;
      await act(async () => button.click());
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain("Stopping");
      await act(async () => button.click());
      expect(onCancel).toHaveBeenCalledTimes(1);
      await act(async () => rejectRequest(new Error("unavailable")));
      expect(button.disabled).toBe(false);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not stop");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
