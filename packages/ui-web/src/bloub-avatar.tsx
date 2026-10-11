import { memo, useEffect, useId, useRef, useState } from "react";
import {
  EXPRESSION_BY_ID,
  DEFAULT_EXPRESSION,
  type ExpressionId,
  type BotExpression,
} from "./bloub/expressions.js";
import { BotEngine } from "./bloub/engine.js";
import { RAYON } from "./bloub/repere.js";
import { SHAPE_BY_ID, DEFAULT_SHAPE, mixHex } from "./bloub/skins.js";
import type { StateId } from "./bloub/states.js";
import { bloubStaticFrame } from "./bloub/static.js";
import { addTicker } from "./bloub/ticker.js";
import { cn } from "./lib/utils.js";

export interface BloubAvatarProps {
  /** Ink color of the body; the site's default is encre (#0a0a0c). */
  color?: string;
  /** One of the eight vendored shape ids (see bloub/skins.ts). */
  shape?: string;
  /** One of the sixteen vendored expression ids (see bloub/expressions.ts). */
  expression?: string;
  /** The bot's live run status; drives thinking/waiting/alarm poses. */
  status?: string;
  size?: number;
  isWorking?: boolean;
  className?: string;
  /** Live engine playback (breath, blinks, status poses). */
  animated?: boolean;
}

/**
 * The avatar mirrors what the bot is actually doing — never a random reel:
 * working = thinking, queued = attentive, waiting for you = alarmed, done =
 * happy, failed = sad. Everything else rests on the chosen expression.
 */
function bloubStatusPose(status?: string): { state: StateId; expression?: ExpressionId } {
  switch (status) {
    case "running":
      return { state: "thinking" };
    case "queued":
    case "leased":
      return { state: "wide" };
    case "waiting_input":
    case "waiting_takeover":
      return { state: "alert" };
    case "failed":
      return { state: "idle", expression: "triste" };
    case "completed":
      return { state: "idle", expression: "heureux" };
    default:
      return { state: "idle" };
  }
}

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function readPaper(): string {
  if (typeof window === "undefined") return "#fafaf8";
  const value = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  return /^#[0-9a-fA-F]{3,6}$/.test(value) ? value : "#fafaf8";
}

const BLOUB_PAPER_LIGHT = "#fafaf8";
const BLOUB_INK_DARK = "#0a0a0c";
const EYE_MIN_LUMINANCE_GAP = 0.22;

function relativeLuminance(hex: string): number | undefined {
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return undefined;
  const digits = match[1]!;
  const full = digits.length === 3 ? digits.split("").map((c) => c + c).join("") : digits;
  const value = parseInt(full, 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((byte) => {
    const s = byte / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/**
 * Eyes are holes punched through the body and painted with the page paper.
 * Dark themes make paper and ink luminance indistinguishable, so the holes
 * vanish: when the gap collapses, paint them with the opposite pole of the
 * body's own luminance instead. (Light-theme behaviour is unchanged.)
 */
export function bloubEyeColor(paper: string, ink: string): string {
  const paperLum = relativeLuminance(paper);
  const inkLum = relativeLuminance(ink);
  if (paperLum === undefined || inkLum === undefined) return paper;
  if (Math.abs(paperLum - inkLum) >= EYE_MIN_LUMINANCE_GAP) return paper;
  return inkLum < 0.5 ? BLOUB_PAPER_LIGHT : BLOUB_INK_DARK;
}

function dotsMarkup(dots: ReturnType<BotEngine["sample"]>["dots"], ink: string, paper: string): string {
  return dots
    .map((dot) => {
      const fill = dot.color ?? (dot.depth === undefined ? ink : mixHex(paper, ink, dot.depth));
      const op = ` opacity="${dot.opacity.toFixed(3)}"`;
      if (dot.d) {
        return `<path d="${dot.d}" transform="translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})" fill="${fill}"${op}/>`;
      }
      return `<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="${dot.r.toFixed(2)}" fill="${fill}"${op}/>`;
    })
    .join("");
}

export const BloubAvatar = memo(function BloubAvatar({
  color = "#0a0a0c",
  shape = DEFAULT_SHAPE,
  expression = DEFAULT_EXPRESSION,
  status,
  size = 36,
  isWorking = false,
  className,
  animated = true,
}: BloubAvatarProps) {
  const uid = useId().replace(/[^a-zA-Z0-9-_]/g, "");
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [paper, setPaper] = useState(readPaper);

  const svgRef = useRef<SVGSVGElement>(null);
  const bodyRef = useRef<SVGPathElement>(null);
  const paperRef = useRef<SVGPathElement>(null);
  const maskBodyRef = useRef<SVGPathElement>(null);
  const eyeRefs = useRef<Array<SVGPathElement | null>>([null, null]);
  const notchRef = useRef<SVGCircleElement>(null);
  const bodyGroupRef = useRef<SVGGElement>(null);
  const dotsBehindRef = useRef<SVGGElement>(null);
  const dotsFrontRef = useRef<SVGGElement>(null);
  const arcsBackRef = useRef<SVGGElement>(null);
  const arcsFrontRef = useRef<SVGGElement>(null);
  const notifRef = useRef<SVGCircleElement>(null);
  const defsRef = useRef<SVGDefsElement>(null);
  const colorRef = useRef(color);
  colorRef.current = color;

  const sh = SHAPE_BY_ID.get(shape) ?? SHAPE_BY_ID.get(DEFAULT_SHAPE)!;
  const statusRef = useRef(status);
  statusRef.current = status;
  const exprRef = useRef(expression);
  exprRef.current = expression;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Theme flips change --background without a React re-render; track it so the
  // eye fallback (bloubEyeColor) re-evaluates against the new paper.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const observer = new MutationObserver(() => setPaper(readPaper()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  const live = animated && !reduced;

  useEffect(() => {
    if (!live) return;
    const engine = new BotEngine(
      RAYON,
      "idle",
      sh.radii,
      EXPRESSION_BY_ID.get(exprRef.current) ?? null,
    );
    let start = 0;
    let lastState = "idle";
    let lastExpr = exprRef.current;
    let paper = readPaper();
    const root = document.documentElement;
    const themeObserver = new MutationObserver(() => {
      paper = readPaper();
    });
    themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    const apply = (t: number) => {
      const target = bloubStatusPose(statusRef.current);
      if (target.state !== lastState) {
        engine.setState(target.state, t);
        lastState = target.state;
      }
      const restExpr = target.expression ?? exprRef.current;
      if (restExpr !== lastExpr) {
        engine.setExpression(EXPRESSION_BY_ID.get(restExpr) ?? null, t);
        lastExpr = restExpr;
      }
      const frame = engine.sample(t);
      const ink = colorRef.current;
      bodyRef.current?.setAttribute("d", frame.bodyPath);
      paperRef.current?.setAttribute("d", frame.bodyPath);
      maskBodyRef.current?.setAttribute("d", frame.bodyPath);
      bodyGroupRef.current?.setAttribute("opacity", frame.bodyAlpha.toFixed(3));
      for (let i = 0; i < 2; i += 1) {
        const node = eyeRefs.current[i];
        const eye = frame.eyes[i];
        if (!node) continue;
        if (eye) {
          node.setAttribute("d", eye.d);
          node.setAttribute("transform", eye.matrix);
          node.setAttribute("opacity", eye.alpha.toFixed(3));
        } else {
          node.setAttribute("d", "");
        }
      }
      if (notchRef.current) {
        if (frame.notch) {
          notchRef.current.setAttribute("cx", frame.notch.x.toFixed(2));
          notchRef.current.setAttribute("cy", frame.notch.y.toFixed(2));
          notchRef.current.setAttribute("r", frame.notch.r.toFixed(2));
          notchRef.current.removeAttribute("display");
        } else {
          notchRef.current.setAttribute("display", "none");
        }
      }
      if (dotsBehindRef.current) {
        dotsBehindRef.current.innerHTML = dotsMarkup(
          frame.dotsBehind ? frame.dots : [],
          ink,
          paper,
        );
      }
      if (dotsFrontRef.current) {
        dotsFrontRef.current.innerHTML = dotsMarkup(
          frame.dotsBehind ? [] : frame.dots,
          ink,
          paper,
        );
      }
      if (arcsBackRef.current && arcsFrontRef.current && defsRef.current) {
        arcsBackRef.current.innerHTML = frame.arcs
          .map(
            (arc) =>
              `<path d="${arc.back}" fill="none" stroke="url(#${uid}-a-${arc.id})" stroke-width="${arc.width.toFixed(2)}" stroke-linecap="round" opacity="${arc.opacity.toFixed(3)}"/>`,
          )
          .join("");
        arcsFrontRef.current.innerHTML = frame.arcs
          .map(
            (arc) =>
              `<path d="${arc.front}" fill="none" stroke="url(#${uid}-a-${arc.id})" stroke-width="${arc.width.toFixed(2)}" stroke-linecap="round" opacity="${arc.opacity.toFixed(3)}"/>`,
          )
          .join("");
        defsRef.current.innerHTML = frame.arcs
          .map(
            (arc) =>
              `<linearGradient id="${uid}-a-${arc.id}" gradientUnits="userSpaceOnUse" x1="${arc.grad.x1}" y1="${arc.grad.y1}" x2="${arc.grad.x2}" y2="${arc.grad.y2}">${arc.grad.stops
                .map((c, si) => `<stop offset="${(si / (arc.grad.stops.length - 1 || 1)).toFixed(3)}" stop-color="${c}"/>`)
                .join("")}</linearGradient>`,
          )
          .join("");
      }
      if (notifRef.current) {
        if (frame.notif) {
          notifRef.current.setAttribute("cx", frame.notif.x.toFixed(2));
          notifRef.current.setAttribute("cy", frame.notif.y.toFixed(2));
          notifRef.current.setAttribute("r", frame.notif.r.toFixed(2));
          notifRef.current.setAttribute("fill", ink);
          notifRef.current.removeAttribute("display");
        } else {
          notifRef.current.setAttribute("display", "none");
        }
      }
    };

    const stop = addTicker((nowSec) => {
      if (!start) start = nowSec;
      apply(nowSec - start);
    });
    return () => {
      stop();
      themeObserver.disconnect();
    };
  }, [live, sh, uid]);

  // Static frame for reduced motion, upload previews, and first paint.
  const frame = bloubStaticFrame(shape, expression);
  const eyeColor = bloubEyeColor(paper, color);
  return (
    <svg
      ref={svgRef}
      viewBox="-115 -115 230 230"
      aria-hidden="true"
      className={cn("rakazo-bloub-avatar overflow-visible select-none", className)}
      data-working={isWorking}
      data-shape={shape}
      data-expression={expression}
      data-animated={live ? "true" : "false"}
      style={{
        width: size,
        height: size,
        flex: "none",
        filter: isWorking
          ? `drop-shadow(0 0 ${Math.round(size * 0.16)}px ${color})`
          : "drop-shadow(0 2px 3px rgba(0,0,0,.34))",
      }}
    >
      {/* Gradient defs are rebuilt every frame via innerHTML — they must live
          in their own <defs>, separate from the React-rendered mask below. */}
      <defs ref={defsRef} />
      <defs>
        <mask
          id={`bloub-mask-${uid}`}
          maskUnits="userSpaceOnUse"
          x={-158}
          y={-158}
          width={316}
          height={316}
        >
          <path ref={maskBodyRef} d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, i) => (
            <path
              key={i}
              ref={(el) => {
                eyeRefs.current[i] = el;
              }}
              d={eye.d}
              transform={eye.matrix}
              opacity={eye.alpha}
              fill="#000"
            />
          ))}
          <circle ref={notchRef} r={0} fill="#000" display="none" />
        </mask>
      </defs>
      <g ref={arcsBackRef} />
      <g ref={dotsBehindRef} />
      <g ref={bodyGroupRef}>
        <path ref={paperRef} d={frame.bodyPath} style={{ fill: eyeColor }} />
        <g mask={`url(#bloub-mask-${uid})`}>
          <rect x={-158} y={-158} width={316} height={316} fill={color} />
        </g>
      </g>
      <g ref={dotsFrontRef} />
      <g ref={arcsFrontRef} />
      <circle ref={notifRef} r={0} display="none" />
    </svg>
  );
});
