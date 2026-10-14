// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & React.ComponentProps<"button">) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
  Toggle: ({
    children,
    onPressedChange,
    pressed: _pressed,
    variant: _variant,
    ...props
  }: {
    children: ReactNode;
    onPressedChange?: () => void;
    pressed?: boolean;
    variant?: string;
  } & React.ComponentProps<"button">) => (
    <button type="button" onClick={() => onPressedChange?.()} {...props}>
      {children}
    </button>
  ),
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));

vi.mock("../components/ApprovalRulesSettings", () => ({ ApprovalRulesSettings: () => null }));
vi.mock("../components/ai/primitives", () => ({ SuccessPop: () => null }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: () => null,
}));
vi.mock("../components/DesktopUpdates", () => ({ DesktopUpdateSection: () => null }));
vi.mock("../components/SoftwareUpdateSection", () => ({ SoftwareUpdateSection: () => null }));
vi.mock("../lib/auth", () => ({ authClient: { changePassword: vi.fn() } }));
vi.mock("../lib/i18n", () => ({
  getActiveUiLocale: () => "en",
  setUiLocale: (locale: string) => Promise.resolve(locale),
}));
vi.mock("../lib/ui-appearance", () => ({
  getUiAppearancePreference: () => "system",
  setUiAppearance: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ Link: ({ children }: { children: ReactNode }) => children }));

import type { UsageSummary } from "@rakazo/contracts";
import { UsageSettingsPanel } from "./AccountSettingsOverlay";

const usage: UsageSummary = {
  calls: 3,
  inputTokens: 1_000,
  outputTokens: 500,
  cacheReadTokens: 200,
  cacheWriteTokens: 50,
  byModel: [
    {
      provider: "openai-compatible",
      model: "fixture-large",
      calls: 2,
      inputTokens: 800,
      outputTokens: 400,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
    },
    {
      provider: "openai-compatible",
      model: "fixture-small",
      calls: 1,
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ],
};

afterEach(() => {
  document.body.innerHTML = "";
});

async function renderPanel(props: {
  usage?: UsageSummary | null;
  range?: "all" | "7d" | "30d";
  loading?: boolean;
  error?: boolean;
  onRangeChange?: (range: "all" | "7d" | "30d") => void;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<UsageSettingsPanel {...props} />);
  });
  return { container, root };
}

it("shows per-model call and token counts without any run or cost framing", async () => {
  const { container, root } = await renderPanel({ usage });
  try {
    const text = container.textContent ?? "";
    // The old misleading "runs" label is gone; calls are model-call records.
    expect(text).not.toMatch(/\bruns\b/);
    expect(text).toContain("3 model calls");
    expect(text).toContain("1000 input tokens");
    expect(text).toContain("500 output tokens");
    // Cache tokens are visible but explicitly separate from the totals.
    const cache = container.querySelector('[data-testid="usage-cache"]')?.textContent ?? "";
    expect(cache).toContain("200 read");
    expect(cache).toContain("50 write");
    expect(cache).toContain("never added to the input or output totals");
    expect(text).not.toContain("$");
    expect(text.toLowerCase()).not.toContain("cost");
    expect(text.toLowerCase()).not.toContain("spend");

    const rows = container.querySelectorAll('[data-testid="usage-model-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("openai-compatible · fixture-large");
    expect(rows[0]?.textContent).toContain("2");
    expect(rows[1]?.textContent).toContain("openai-compatible · fixture-small");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("offers all/7d/30d ranges and reports range changes upward", async () => {
  const onRangeChange = vi.fn();
  const { container, root } = await renderPanel({ usage, range: "all", onRangeChange });
  try {
    const all = container.querySelector('[data-testid="usage-range-all"]');
    const week = container.querySelector('[data-testid="usage-range-7d"]');
    const month = container.querySelector('[data-testid="usage-range-30d"]');
    expect(all?.getAttribute("aria-pressed")).toBe("true");
    expect(week?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      (week as HTMLButtonElement).click();
    });
    expect(onRangeChange).toHaveBeenCalledWith("7d");
    await act(async () => {
      (month as HTMLButtonElement).click();
    });
    expect(onRangeChange).toHaveBeenCalledWith("30d");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("shows a loading indicator instead of mixing stale numbers with a new range", async () => {
  const { container, root } = await renderPanel({ usage, range: "30d", loading: true });
  try {
    expect(container.querySelector('[data-testid="usage-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="usage-totals"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="usage-model-row"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="usage-range-30d"]')?.getAttribute("aria-pressed")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("reports a failed load instead of keeping stale numbers under the new range", async () => {
  const { container, root } = await renderPanel({ usage: null, range: "7d", error: true });
  try {
    expect(container.querySelector('[data-testid="usage-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="usage-totals"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("states an empty range honestly instead of showing zeroed models", async () => {
  const { container, root } = await renderPanel({
    usage: { ...usage, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: [] },
    range: "7d",
  });
  try {
    expect(container.textContent).toContain("No model usage in this range.");
    expect(container.querySelectorAll('[data-testid="usage-model-row"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
