// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children?: ReactNode }) => children };
});

import { TaskCenterNavEntry } from "./TaskCenterNavEntry";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

async function render(props: { count: number | null; current?: boolean; onSelect?: () => void }) {
  await act(async () => {
    root.render(
      <TaskCenterNavEntry
        count={props.count}
        current={props.current}
        onSelect={props.onSelect ?? (() => undefined)}
      />,
    );
  });
  return container.querySelector('[data-testid="task-center-entry"]') as HTMLElement;
}

describe("TaskCenterNavEntry", () => {
  it("shows the server count with tabular numerals", async () => {
    const entry = await render({ count: 12 });
    const badge = entry.querySelector('[data-testid="task-center-count"]') as HTMLElement;
    expect(badge.textContent).toBe("12");
    expect(badge.className).toContain("tabular-nums");
    expect(badge.className).toContain("text-foreground");
  });

  it("omits the badge entirely at zero — no empty pill, no guessed number", async () => {
    const entry = await render({ count: 0 });
    expect(entry.querySelector('[data-testid="task-center-count"]')).toBeNull();
    expect(entry.textContent).toBe("Background tasks");
  });

  it("omits the badge while the count is unknown", async () => {
    const entry = await render({ count: null });
    expect(entry.querySelector('[data-testid="task-center-count"]')).toBeNull();
  });

  it("uses aria-current only on the Task Center route", async () => {
    const here = await render({ count: 1, current: true });
    expect(here.getAttribute("aria-current")).toBe("page");
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const elsewhere = await render({ count: 1 });
    expect(elsewhere.hasAttribute("aria-current")).toBe(false);
  });

  it("fires the navigation callback", async () => {
    const onSelect = vi.fn();
    const entry = await render({ count: 2, onSelect });
    await act(async () => {
      entry.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
