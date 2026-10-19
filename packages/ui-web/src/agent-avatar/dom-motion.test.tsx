// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./agent-avatar.js";
import type { MotionPresentation } from "./director.js";
import { createAvatarDomRenderer } from "./dom-motion.js";
import { sample } from "./motion.js";

describe("frozen SVG layer motion", () => {
  it("keeps frozen paths untouched while moving the body, eyes and correct prop", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <AgentAvatar botId="bot" character="treble" name="Maya" size={24} activity="working" />,
    );
    const root = host.firstElementChild as HTMLElement;
    expect(root.querySelector(".rakazo-agent-avatar-art #feet")).toBeNull();
    const body = root.querySelector<SVGGElement>(".rakazo-agent-avatar-art #body")!;
    const originalBody = body.getAttribute("transform");
    const originalPaths = [...root.querySelectorAll("path")].map((path) => path.getAttribute("d"));
    const render = createAvatarDomRenderer(root);
    render({
      frame: sample("working", 60, 0.4, { character: "treble" }),
      state: "working",
      outgoingState: null,
      outgoingScale: 0,
      moving: true,
    });
    expect(body.getAttribute("transform")).not.toBe(originalBody);
    expect([...root.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(
      originalPaths,
    );
    expect(root.querySelector<HTMLElement>('[data-avatar-prop="laptop"]')?.style.opacity).toBe("1");
    expect(root.querySelector<HTMLElement>('[data-avatar-prop="card"]')?.style.opacity).toBe("0");
    render({frame: sample("failed", 350, 0.4, {character: "treble"}), state: "failed", outgoingState: null, outgoingScale: 0, moving: true});
    const cross = root.querySelector<SVGGElement>('[data-avatar-prop="xeyes"] #xL')!;
    expect(cross.getAttribute("transform")).toContain("scale(");
    expect(cross.getAttribute("transform")).not.toContain("scale(1)");
    render({
      frame: sample("failed", 1300, 0.4, { character: "treble" }),
      state: "failed",
      outgoingState: "working",
      outgoingScale: 0,
      moving: false,
    });
    expect(root.querySelector<HTMLElement>('[data-avatar-prop="xeyes"]')?.style.opacity).toBe("1");
    expect(
      root.querySelector<SVGGElement>(".rakazo-agent-avatar-art #pupilL")?.getAttribute("opacity"),
    ).toBe("0");
  });

  it("restores frozen attributes on cleanup so re-registration cannot compound transforms", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <AgentAvatar botId="bot" character="dot" name="Maya" size={24} activity="working" />,
    );
    const root = host.firstElementChild as HTMLElement;
    const body = root.querySelector<SVGGElement>(".rakazo-agent-avatar-art #body")!;
    const pupil = root.querySelector<SVGGElement>(".rakazo-agent-avatar-art #pupilL")!;
    const laptop = root.querySelector<HTMLElement>('[data-avatar-prop="laptop"]')!;
    const baseBody = body.getAttribute("transform");
    const basePupilOpacity = pupil.getAttribute("opacity");
    const presentation: MotionPresentation = {
      frame: sample("working", 60, 0.4, { character: "dot" }),
      state: "working",
      outgoingState: null,
      outgoingScale: 0,
      moving: true,
    };
    const first = createAvatarDomRenderer(root);
    first(presentation);
    const afterFirst = body.getAttribute("transform");
    expect(afterFirst).not.toBe(baseBody);
    expect(laptop.style.opacity).toBe("1");
    expect(root.dataset.motionReady).toBe("true");
    // PR #53 review P2: when botId/character change without a remount, the
    // registration effect re-runs over the same SVG nodes. Two characters can
    // share one base body transform, so React never rewrites the attribute and
    // a new renderer would capture the mutated value as "original" — every
    // frame compounds and the avatar stays distorted.
    first.restore();
    expect(body.getAttribute("transform")).toBe(baseBody);
    expect(pupil.getAttribute("opacity")).toBe(basePupilOpacity);
    expect(laptop.style.opacity).toBe("");
    expect(root.dataset.motionReady).toBeUndefined();
    const second = createAvatarDomRenderer(root);
    second(presentation);
    expect(body.getAttribute("transform")).toBe(afterFirst);
  });
});
