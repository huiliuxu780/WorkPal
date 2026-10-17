import type { AvatarCharacter } from "@rakazo/contracts";
import { createElement, memo, type ReactNode } from "react";
import type { AvatarActivity } from "./activity-map.js";
import { avatarAssets, type SvgNode } from "./assets.generated.js";
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

const stateNames: Record<AvatarActivity, string> = {
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
  className?: string;
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
  className,
}: AgentAvatarProps) {
  const resolved: AvatarCharacter = character && character in avatarAssets.full ? character : "dot";
  const isCompact = size === 16;
  const label = `${name} · ${stateNames[activity]}`;
  const prop =
    activity === "working"
      ? avatarAssets.props.laptop
      : activity === "approval"
        ? avatarAssets.props.card
        : activity === "waiting"
          ? avatarAssets.props.question
          : activity === "failed"
            ? avatarAssets.xeyes[resolved]
            : null;
  return (
    <span
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
      tabIndex={ariaHidden ? undefined : 0}
      style={{ width: size, height: size }}
    >
      <span className="rakazo-agent-avatar-art" aria-hidden="true">
        {renderSvg(isCompact ? avatarAssets.compact[resolved] : avatarAssets.full[resolved])}
      </span>
      {!isCompact && prop ? (
        <span className="rakazo-agent-avatar-prop" aria-hidden="true">
          {renderSvg(prop)}
        </span>
      ) : null}
      {!isCompact && activity === "waiting" ? (
        <span className="rakazo-agent-avatar-prop rakazo-agent-avatar-prop-dark" aria-hidden="true">
          {renderSvg(avatarAssets.props["question-dark"])}
        </span>
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
