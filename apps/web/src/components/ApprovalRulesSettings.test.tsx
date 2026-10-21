// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rulesList = vi.hoisted(() => vi.fn());
const rulesSet = vi.hoisted(() => vi.fn());
const rulesRemove = vi.hoisted(() => vi.fn());
const autoReviewGet = vi.hoisted(() => vi.fn());
const autoReviewSet = vi.hoisted(() => vi.fn());

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return { Trans: ({ children }: { children?: ReactNode }) => children };
});
vi.mock("../lib/rpc", () => ({
  rpc: {
    approvalRules: { list: rulesList, set: rulesSet, remove: rulesRemove },
    autoReview: { get: autoReviewGet, set: autoReviewSet },
  },
}));

import { ApprovalRulesSettings } from "./ApprovalRulesSettings";

i18n.load("en", {});
i18n.activate("en");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) => (element.textContent ?? "").trim() === label,
  );
  expect(found).toBeTruthy();
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  rulesList.mockReset();
  rulesSet.mockReset();
  rulesRemove.mockReset();
  autoReviewGet.mockReset();
  autoReviewSet.mockReset();
  rulesList.mockResolvedValue([]);
  autoReviewGet.mockResolvedValue({ enabled: false, checkerAvailable: true });
  autoReviewSet.mockResolvedValue({ enabled: true, checkerAvailable: true });
  rulesSet.mockImplementation(async (input: { matchValue: string; effect: string; matchKind: string }) => ({
    id: `rule-${input.matchValue}`,
    effect: input.effect,
    matchKind: input.matchKind,
    matchValue: input.matchValue,
    createdAt: new Date().toISOString(),
  }));
  rulesRemove.mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ApprovalRulesSettings", () => {
  it("shows one review switch, plain rules and no technical presets", async () => {
    rulesList.mockResolvedValue([
      {
        id: "r1",
        effect: "require_approval",
        matchKind: "category",
        matchValue: "email",
        createdAt: "",
      },
    ]);
    act(() => {
      root.render(<ApprovalRulesSettings />);
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Action review");
    expect(text).toContain("Applies to all your Bots in this Space.");
    expect(text).toContain("Sending email");
    expect(text).toContain("Ask me first");
    expect(text).not.toContain("Flag unexpected actions");
    expect(text).not.toContain("Ask before sending external email");
    expect(container.querySelectorAll('[role="switch"]').length).toBe(1);
  });

  it("adds a natural-language rule through the existing approvalRules chain", async () => {
    act(() => {
      root.render(<ApprovalRulesSettings />);
    });
    await flush();
    await click(button("Add rule"));
    const input = container.querySelector("input[dir='auto']") as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "emailing someone outside the Space");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Always allow"));
    await click(button("Save rule"));
    expect(rulesSet).toHaveBeenCalledWith({
      effect: "always_allow",
      matchKind: "category",
      matchValue: "emailing someone outside the Space",
    });
    expect(container.textContent).toContain("emailing someone outside the Space");
  });

  it("keeps typed input when saving fails", async () => {
    rulesSet.mockRejectedValueOnce(new Error("network down"));
    act(() => {
      root.render(<ApprovalRulesSettings />);
    });
    await flush();
    await click(button("Add rule"));
    const input = container.querySelector("input[dir='auto']") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "booking spend");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save rule"));
    await flush();
    expect(container.textContent).toContain("network down");
    const kept = container.querySelector("input[dir='auto']") as HTMLInputElement;
    expect(kept.value).toBe("booking spend");
  });

  it("edits and deletes rules without a second rule system", async () => {
    rulesList.mockResolvedValue([
      {
        id: "r1",
        effect: "always_allow",
        matchKind: "category",
        matchValue: "posting updates",
        createdAt: "",
      },
    ]);
    act(() => {
      root.render(<ApprovalRulesSettings />);
    });
    await flush();
    await click(container.querySelector('button[aria-label^="Edit"]') as HTMLButtonElement);
    const input = container.querySelector("input[dir='auto']") as HTMLInputElement;
    expect(input.value).toBe("posting updates");
    await click(button("Cancel"));
    await click(container.querySelector('button[aria-label^="Delete"]') as HTMLButtonElement);
    expect(rulesRemove).toHaveBeenCalledWith({ id: "r1" });
  });

  it("editing a rule to a new phrase replaces it server-side, not just locally", async () => {
    rulesList.mockResolvedValue([
      {
        id: "r1",
        effect: "require_approval",
        matchKind: "category",
        matchValue: "posting updates",
        createdAt: "",
      },
    ]);
    act(() => {
      root.render(<ApprovalRulesSettings />);
    });
    await flush();
    await click(container.querySelector('button[aria-label^="Edit"]') as HTMLButtonElement);
    const input = container.querySelector("input[dir='auto']") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "posting external updates");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save rule"));
    await flush();
    // The keyed upsert created a NEW row; the edited rule must be removed
    // server-side too, or a refresh would resurrect it beside the new one.
    expect(rulesSet).toHaveBeenCalledWith({
      effect: "require_approval",
      matchKind: "category",
      matchValue: "posting external updates",
    });
    expect(rulesRemove).toHaveBeenCalledWith({ id: "r1" });
    const text = container.textContent ?? "";
    expect(text).toContain("posting external updates");
    expect(text.replace("posting external updates", "")).not.toContain("posting updates");
  });

  it("a failed edit save never removes the existing rule", async () => {
    rulesList.mockResolvedValue([
      {
        id: "r1",
        effect: "require_approval",
        matchKind: "category",
        matchValue: "posting updates",
        createdAt: "",
      },
    ]);
    rulesSet.mockRejectedValueOnce(new Error("network down"));
    act(() => {
      root.render(<ApprovalRulesSettings />);
    });
    await flush();
    await click(container.querySelector('button[aria-label^="Edit"]') as HTMLButtonElement);
    const input = container.querySelector("input[dir='auto']") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "posting external updates");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save rule"));
    await flush();
    expect(rulesRemove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("network down");
    // The rule being edited is still listed, and the typed phrase is kept.
    expect(container.textContent).toContain("posting updates");
    const kept = container.querySelector("input[dir='auto']") as HTMLInputElement;
    expect(kept.value).toBe("posting external updates");
  });
});
