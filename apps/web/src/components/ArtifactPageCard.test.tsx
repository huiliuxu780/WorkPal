// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const getShare = vi.hoisted(() => vi.fn());

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => acc + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children?: ReactNode }) => children };
});
vi.mock("../lib/rpc", () => ({
  rpc: { share: { get: getShare }, artifacts: {} },
}));

import { ArtifactPageCard } from "./ArtifactPageCard";

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
  getShare.mockReset();
  getShare.mockResolvedValue({ spaceId: "space-1", familyId: "family-1", publicLink: null });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    void act(() => root.unmount());
    host.remove();
  }
  document.body.replaceChildren();
});

describe("ArtifactPageCard share entry", () => {
  it("keeps the share entry on a superseded page and notes the link opens the latest", async () => {
    const host = await render(
      <ArtifactPageCard
        target={{ botId: "bot-1" }}
        artifactId="artifact-1"
        name="Board"
        superseded
      />,
    );
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="page-share-trigger"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    await act(async () => await Promise.resolve());
    expect(getShare).toHaveBeenCalledWith({ botId: "bot-1", artifactId: "artifact-1" });
    expect(document.body.textContent).toContain("链指向当前已发布版本（开最新）。");
  });

  it("omits the latest-version note for the current card", async () => {
    const host = await render(
      <ArtifactPageCard target={{ botId: "bot-1" }} artifactId="artifact-2" name="Board" />,
    );
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="page-share-trigger"]');
    await act(async () => trigger?.click());
    await act(async () => await Promise.resolve());
    expect(document.body.textContent).not.toContain("链指向当前已发布版本（开最新）。");
  });
});
