// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BloubAvatar } from "./bloub-avatar.js";

let rafQueue: FrameRequestCallback[] = [];
let root: Root | null = null;

function pump(timestampMs: number): void {
  const callbacks = rafQueue.splice(0);
  for (const cb of callbacks) cb(timestampMs);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  vi.unstubAllGlobals();
});

describe("BloubAvatar animation", () => {
  it("updates the body path every ticker frame when animated", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<BloubAvatar color="#0a0a0c" size={32} />);
    });
    const maskBody = container.querySelector("svg.rakazo-bloub-avatar mask path") as SVGPathElement;
    const initial = maskBody.getAttribute("d");
    expect(initial).toBeTruthy();

    act(() => pump(16));
    act(() => pump(1016));
    act(() => pump(4016));
    const after = maskBody.getAttribute("d");
    expect(after).toBeTruthy();
    expect(after).not.toBe(initial);

    // Jump into the orbit/comet stretch: arc gradients rebuild the gradient
    // <defs> every frame and must never wipe the React-rendered mask.
    act(() => pump(26000));
    const mask = container.querySelector("svg.rakazo-bloub-avatar mask");
    expect(mask).toBeTruthy();
    expect(mask?.querySelector("path")?.getAttribute("d") || "").not.toBe("");
    expect(container.querySelector("svg.rakazo-bloub-avatar rect[fill='#0a0a0c']")).toBeTruthy();
  });

  it("stays on the static frame when animated is false", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<BloubAvatar color="#0a0a0c" size={32} animated={false} />);
    });
    const maskBody = container.querySelector("svg.rakazo-bloub-avatar mask path") as SVGPathElement;
    const before = maskBody.getAttribute("d");
    act(() => pump(1000));
    expect(rafQueue).toHaveLength(0);
    expect(maskBody.getAttribute("d")).toBe(before);
  });
});
