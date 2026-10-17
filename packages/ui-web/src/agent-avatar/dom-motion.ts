import type { AvatarActivity } from "./activity-map.js";
import type { MotionPresentation } from "./director.js";
import { BODY_FOOT } from "./geometry.js";

const propForState: Partial<Record<AvatarActivity, string>> = {
  working: "laptop",
  approval: "card",
  waiting: "question",
};

/** Mutate only wrapper transforms; frozen path data and the feet never change. */
export type AvatarDomRenderer = ((presentation: MotionPresentation) => void) & {
  /**
   * Put every mutated attribute and inline style back to its captured base.
   * The registration effect must call this on cleanup: when botId/character
   * change without a remount, React does not rewrite transforms shared by two
   * characters, and the next renderer would capture the animated value as its
   * "original" and compound transforms from there (PR #53 review P2).
   */
  restore(): void;
};

export function createAvatarDomRenderer(root: HTMLElement): AvatarDomRenderer {
  const art = root.querySelector<SVGSVGElement>(".rakazo-agent-avatar-art svg");
  if (!art) return Object.assign(() => {}, { restore: () => {} });
  const layers = new Map<
    string,
    { node: SVGGElement; original: string; originalOpacity: string | null }
  >();
  for (const name of ["body", "eyewhite", "pupilL", "pupilR", "symbol"]) {
    const node = art.querySelector<SVGGElement>(`g[id="${name}"]`);
    if (node)
      layers.set(name, {
        node,
        original: node.getAttribute("transform") ?? "",
        originalOpacity: node.getAttribute("opacity"),
      });
  }
  const props = [...root.querySelectorAll<HTMLElement>("[data-avatar-prop]")];
  const character = root.dataset.character ?? "dot";
  const symbolPivot: Record<string, [number, number]> = {
    dot: [86.13, 33.58],
    treble: [38.125, 33.4375],
    wave: [53.3, 28.63],
    bounce: [84.94, 19.44],
  };
  const [pivotX, pivotY] = symbolPivot[character] ?? symbolPivot.dot!;
  const apply = (name: string, prefix: string, opacity?: number) => {
    const layer = layers.get(name);
    if (!layer) return;
    layer.node.setAttribute("transform", `${prefix} ${layer.original}`);
    if (opacity !== undefined) layer.node.setAttribute("opacity", String(opacity));
  };
  const render = (presentation: MotionPresentation) => {
    const { frame, state, outgoingState, outgoingScale } = presentation;
    const { tx, ty, sx, sy, rot } = frame.body;
    const foot = BODY_FOOT;
    const body = `translate(${tx} ${ty}) translate(${foot.x} ${foot.y}) rotate(${rot}) scale(${sx} ${sy}) translate(${-foot.x} ${-foot.y})`;
    const blink = `translate(50 54) scale(${frame.eyes.scale} ${frame.eyes.scale * frame.eyes.blink}) translate(-50 -54)`;
    const symbol = `translate(${frame.symbol.tx} ${frame.symbol.ty}) translate(${pivotX} ${pivotY}) rotate(${frame.symbol.rot}) translate(${-pivotX} ${-pivotY})`;
    apply("body", body);
    apply("eyewhite", `${body} ${blink}`);
    for (const pupil of ["pupilL", "pupilR"]) {
      apply(
        pupil,
        `${body} ${blink} translate(${frame.pupils.tx} ${frame.pupils.ty})`,
        frame.pupils.opacity,
      );
    }
    apply("symbol", `${body} ${symbol}`);

    const activeProp = propForState[state];
    const outgoingProp = outgoingState ? propForState[outgoingState] : undefined;
    for (const node of props) {
      const kind = node.dataset.avatarProp;
      if (kind === "xeyes") {
        node.style.opacity = String(frame.xeyes.opacity);
        node.style.transform = `translate(${(tx / 100) * root.clientWidth}px, ${(ty / 100) * root.clientHeight}px) rotate(${rot}deg) scale(${sx}, ${sy})`;
        continue;
      }
      const selected =
        kind === activeProp || (kind === "question-dark" && activeProp === "question");
      const leaving =
        kind === outgoingProp || (kind === "question-dark" && outgoingProp === "question");
      const scale = selected ? frame.prop.scale : leaving ? outgoingScale : 0;
      node.style.opacity = String(scale > 0 ? 1 : 0);
      node.style.transform = `translateY(${(frame.prop.ty / 100) * root.clientHeight}px) rotate(${frame.prop.rot}deg) scale(${scale})`;
      if (kind === "laptop") {
        const glow = node.querySelector<SVGElement>("#glow");
        const cursor = node.querySelector<SVGElement>("#cursor");
        if (glow) glow.style.opacity = String(frame.glow);
        if (cursor) cursor.style.opacity = String(frame.cursor);
      }
    }
    root.dataset.motionReady = "true";
  };
  return Object.assign(render, {
    restore() {
      for (const { node, original, originalOpacity } of layers.values()) {
        node.setAttribute("transform", original);
        if (originalOpacity === null) node.removeAttribute("opacity");
        else node.setAttribute("opacity", originalOpacity);
      }
      for (const node of props) {
        node.style.opacity = "";
        node.style.transform = "";
        const glow = node.querySelector<SVGElement>("#glow");
        const cursor = node.querySelector<SVGElement>("#cursor");
        if (glow) glow.style.opacity = "";
        if (cursor) cursor.style.opacity = "";
      }
      delete root.dataset.motionReady;
    },
  });
}
