// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./agent-avatar.js";
import { createAvatarDomRenderer } from "./dom-motion.js";
import { sample } from "./motion.js";

describe("frozen SVG layer motion", () => {
  it("keeps feet and paths untouched while moving the body, eyes and correct prop", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <AgentAvatar botId="bot" character="treble" name="Maya" size={24} activity="working" />,
    );
    const root = host.firstElementChild as HTMLElement;
    const foot = root.querySelector<SVGGElement>(".rakazo-agent-avatar-art #feet")!;
    const body = root.querySelector<SVGGElement>(".rakazo-agent-avatar-art #body")!;
    const footTransform = foot.getAttribute("transform");
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
    expect(foot.getAttribute("transform")).toBe(footTransform);
    expect(body.getAttribute("transform")).not.toBe(originalBody);
    expect([...root.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(
      originalPaths,
    );
    expect(root.querySelector<HTMLElement>('[data-avatar-prop="laptop"]')?.style.opacity).toBe("1");
    expect(root.querySelector<HTMLElement>('[data-avatar-prop="card"]')?.style.opacity).toBe("0");
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
});
