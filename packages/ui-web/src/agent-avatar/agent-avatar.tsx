import type { AvatarCharacter } from "@rakazo/contracts";
import { createElement, memo, type ReactNode, useEffect, useId, useRef } from "react";
import type { AvatarActivity } from "./activity-map.js";
import { avatarAssets, type SvgNode } from "./assets.generated.js";
import { avatarDirector } from "./director.js";
import { createAvatarDomRenderer } from "./dom-motion.js";
import "./agent-avatar.css";

export type AgentAvatarSize = 16 | 24 | 32 | 64;
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
  const resolved: AvatarCharacter = character && character in avatarAssets.full ? character : "dot";
  const isCompact = size === 16;
  const label = `${name} · ${avatarStateNames[activity]}`;
  const root = useRef<HTMLSpanElement>(null);
  const instanceKey = useId();
  const priorProgressToken = useRef(progressToken);
  useEffect(() => {
    if (isCompact || !root.current) return;
    const director = avatarDirector();
    const renderer = createAvatarDomRenderer(root.current);
    const unregister = director.register({
      instanceKey,
      botId,
      character: resolved,
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
  }, [instanceKey, botId, resolved, isCompact]);
  useEffect(() => {
    if (isCompact) return;
    avatarDirector().update(instanceKey, { state: activity });
  }, [instanceKey, isCompact, activity]);
  useEffect(() => {
    if (isCompact) return;
    avatarDirector().update(instanceKey, { current });
  }, [instanceKey, isCompact, current]);
  useEffect(() => {
    if (priorProgressToken.current === progressToken) return;
    priorProgressToken.current = progressToken;
    if (isCompact || progressToken == null || activity !== "working") return;
    const director = avatarDirector();
    director.progress(instanceKey);
    director.pulse(instanceKey);
  }, [instanceKey, isCompact, progressToken, activity]);
  return (
    <span
      ref={root}
      className={`rakazo-agent-avatar${className ? ` ${className}` : ""}`}
      data-bot-id={botId}
      data-character={resolved}
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
      <span className="rakazo-agent-avatar-art" aria-hidden="true">
        {renderSvg(isCompact ? avatarAssets.compact[resolved] : avatarAssets.full[resolved])}
      </span>
      {!isCompact ? (
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
              {renderSvg(avatarAssets.props[kind])}
            </span>
          ))}
          <span
            className="rakazo-agent-avatar-prop rakazo-agent-avatar-xeyes"
            data-avatar-prop="xeyes"
            aria-hidden="true"
            style={{ opacity: activity === "failed" ? 1 : 0 }}
          >
            {renderSvg(avatarAssets.xeyes[resolved])}
          </span>
        </>
      ) : null}
      {isCompact && activity !== "idle" ? (
        <span
          className="rakazo-agent-avatar-dot"
          data-point-shape={AVATAR_POINT_SHAPES[activity]}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
});
