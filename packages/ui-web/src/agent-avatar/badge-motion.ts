import { type RefObject, useEffect, useId } from "react";
import { avatarDirector } from "./director.js";

/** Compact/upload badges share the same page-wide slots as full SVG motion. */
export function useAvatarBadgeMotion(
  root: RefObject<HTMLSpanElement | null>,
  enabled: boolean,
  botId: string,
  current: boolean,
) {
  const instanceKey = useId();
  useEffect(() => {
    const element = root.current;
    if (!enabled || !element) return;
    const unregister = avatarDirector().register({
      instanceKey,
      botId,
      character: "dot",
      state: "working",
      current,
      render: (presentation) => {
        element.dataset.motion = presentation.moving ? "moving" : "still";
      },
    });
    return () => {
      unregister();
      delete element.dataset.motion;
    };
  }, [root, enabled, botId, current, instanceKey]);
}
