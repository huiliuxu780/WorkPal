import type { AvatarBodyColor, AvatarCharacter } from "@rakazo/contracts";
import { createElement, memo, type ReactNode, useEffect, useId, useRef } from "react";
import type { AvatarActivity } from "./activity-map.js";
import { type AvatarTier, avatarAnchors, avatarAssets, type SvgNode } from "./assets.generated.js";
import { avatarDirector } from "./director.js";
import { createAvatarDomRenderer } from "./dom-motion.js";
import { sample } from "./motion.js";
import "./agent-avatar.css";

export type AgentAvatarSize = 16 | 18 | 24 | 32 | 35 | 58 | 64;
export type AvatarSurface = "background" | "card" | "sidebar" | "secondary" | "chat-user";

function renderSvg(node: SvgNode, key = "root"): ReactNode {
  return createElement(
    node.tag,
    { ...node.attrs, key },
    ...node.children.map((child, index) => renderSvg(child, `${key}-${index}`)),
  );
}

export const avatarStateNames: Record<AvatarActivity, string> = {
  idle: "Idle",
  working: "Working",
  approval: "Needs approval",
  waiting: "Waiting for you",
  failed: "Error",
};

export type AvatarPointShape = "circle" | "diamond" | "ring" | "alert";

/**
 * Non-color cue for the 16px state point (AV-00 acceptance addendum 2026-10-18):
 * hue is never the only channel. Shape CSS keys only off `data-point-shape`.
 */
export const AVATAR_POINT_SHAPES: Record<Exclude<AvatarActivity, "idle">, AvatarPointShape> = {
  working: "circle",
  approval: "diamond",
  waiting: "ring",
  failed: "alert",
};

export interface AgentAvatarProps {
  botId: string;
  character: AvatarCharacter | null | undefined;
  bodyColor?: AvatarBodyColor;
  name: string;
  size: AgentAvatarSize;
  activity: AvatarActivity;
  surface?: AvatarSurface;
  /** Use when the nearby text already supplies the Bot name and state. */
  ariaHidden?: boolean;
  /** Embedded avatars inherit keyboard focus from their parent control. */
  focusable?: boolean;
  className?: string;
  /** Current conversation wins only among avatars with the same state. */
  current?: boolean;
  /** Change this value for a new progress event; repeated values do not pulse. */
  progressToken?: string | number | null;
}

/** Frozen paths are compiled to React SVG nodes, without an HTML parser or runtime fetch. */
export const AgentAvatar = memo(function AgentAvatar({
  botId,
  character,
  bodyColor = "ink",
  name,
  size,
  activity,
  surface = "background",
  ariaHidden = false,
  focusable = true,
  className,
  current = false,
  progressToken,
}: AgentAvatarProps) {
  const resolved: AvatarCharacter =
    character && character in avatarAssets.characters ? character : "dot";
  const isCompact = size === 16;
  const isStill = size <= 18;
  const tier: AvatarTier = isCompact ? "compact" : size === 18 ? "XS" : size >= 58 ? "L" : "S";
  const role = ({ dot: "1-dot", treble: "2-treble", wave: "3-wave", bounce: "4-bounce" } as const)[
    resolved
  ];
  const anchor = avatarAnchors.anchors[role][tier === "compact" ? "XS" : tier];
  const propTier = tier === "L" ? "L" : "S";
  function positionedProp(kind: "laptop" | "card" | "question" | "question-dark") {
    const svg =
      kind === "laptop" ? avatarAssets.laptops[bodyColor][propTier] : avatarAssets.props[kind];
    const point = kind === "laptop" ? anchor.laptop : anchor.card;
    const scale = anchor.fit.s * (kind === "laptop" ? 1.35 * anchor.laptop.scale : 1);
    return (
      <svg viewBox="0 0 100 100">
        <g transform={`translate(${point.x} ${point.y}) scale(${scale})`}>
          {svg.children.map((node, i) => renderSvg(node, String(i)))}
        </g>
      </svg>
    );
  }
  const label = `${name} · ${avatarStateNames[activity]}`;
  const root = useRef<HTMLSpanElement>(null);
  const instanceKey = useId();
  const priorProgressToken = useRef(progressToken);
  const priorActivity = useRef(activity);
  useEffect(() => {
    if (isCompact || !root.current) return;
    if (isStill) {
      const renderer = createAvatarDomRenderer(root.current);
      renderer({
        frame: sample("idle", 0, 0, { character: resolved, static: true }),
        state: activity,
        outgoingState: null,
        outgoingScale: 0,
        moving: false,
      });
      return () => renderer.restore();
    }
    const director = avatarDirector();
    const renderer = createAvatarDomRenderer(root.current);
    const unregister = director.register({
      instanceKey,
      botId,
      character: resolved,
      size,
      state: activity,
      current,
      render: renderer,
    });
    return () => {
      unregister();
      // Characters can share base layer transforms, so React never rewrites
      // those attributes on an identity change; restoring them here keeps the
      // next renderer from capturing animated values as its base (PR #53 P2).
      renderer.restore();
    };
    // Registration is tied to the displayed identity and SVG, not every activity update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceKey, botId, resolved, bodyColor, tier, isCompact, isStill]);
  useEffect(() => {
    if (isStill || priorActivity.current === activity) return;
    priorActivity.current = activity;
    avatarDirector().update(instanceKey, { state: activity });
  }, [instanceKey, isStill, activity]);
  useEffect(() => {
    if (isStill) return;
    avatarDirector().update(instanceKey, { current });
  }, [instanceKey, isStill, current]);
  useEffect(() => {
    if (priorProgressToken.current === progressToken) return;
    priorProgressToken.current = progressToken;
    if (isStill || progressToken == null || activity !== "working") return;
    const director = avatarDirector();
    director.progress(instanceKey);
    director.pulse(instanceKey);
  }, [instanceKey, isStill, progressToken, activity]);
  return (
    <span
      ref={root}
      className={`rakazo-agent-avatar${className ? ` ${className}` : ""}`}
      data-bot-id={botId}
      data-character={resolved}
      data-strong-ring={
        (activity === "approval" && (bodyColor === "orange" || bodyColor === "brown")) ||
        (activity === "waiting" && bodyColor === "blue") ||
        (activity === "failed" && bodyColor === "pink")
          ? "true"
          : undefined
      }
      data-body-color={bodyColor}
      data-tier={tier}
      data-state={activity}
      data-size={size}
      data-surface={surface}
      role="img"
      aria-hidden={ariaHidden || undefined}
      aria-label={ariaHidden ? undefined : label}
      aria-live={
        !ariaHidden && ["approval", "waiting", "failed"].includes(activity) ? "polite" : undefined
      }
      title={ariaHidden ? undefined : label}
      tabIndex={ariaHidden || !focusable ? undefined : 0}
      style={{ width: size, height: size }}
    >
      {!isStill ? (
        <span className="rakazo-agent-avatar-prop rakazo-agent-avatar-shadow" aria-hidden="true">
          <svg viewBox="0 0 100 100">
            <ellipse
              cx={anchor.shadow.cx}
              cy={anchor.shadow.cy}
              rx={anchor.shadow.rx}
              ry={anchor.shadow.ry}
            />
          </svg>
        </span>
      ) : null}
      <span className="rakazo-agent-avatar-art" aria-hidden="true">
        {renderSvg(avatarAssets.characters[resolved][bodyColor][tier])}
      </span>
      {!isStill ? (
        <>
          {(["laptop", "card", "question", "question-dark"] as const).map((kind) => (
            <span
              key={kind}
              className={`rakazo-agent-avatar-prop${kind === "question-dark" ? " rakazo-agent-avatar-prop-dark" : ""}`}
              data-avatar-prop={kind}
              aria-hidden="true"
              style={{
                opacity:
                  activity ===
                  (
                    {
                      laptop: "working",
                      card: "approval",
                      question: "waiting",
                      "question-dark": "waiting",
                    } as const
                  )[kind]
                    ? 1
                    : 0,
              }}
            >
              {positionedProp(kind)}
            </span>
          ))}
          <span
            className="rakazo-agent-avatar-prop rakazo-agent-avatar-xeyes"
            data-avatar-prop="xeyes"
            aria-hidden="true"
            style={{ opacity: activity === "failed" ? 1 : 0 }}
          >
            {renderSvg(avatarAssets.xeyes[resolved][bodyColor][propTier])}
          </span>
        </>
      ) : null}
      {(isCompact || surface === "sidebar") && activity !== "idle" ? (
        <span
          className="rakazo-agent-avatar-dot"
          data-point-shape={AVATAR_POINT_SHAPES[activity]}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
});
