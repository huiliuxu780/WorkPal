import { type Bot, type BotAvatarState } from "@rakazo/contracts";
import { AvatarCatalogProvider } from "@rakazo/ui-web";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { rpc } from "./rpc";

/** The API read model, not local Run status strings, owns avatar state. */
export function AvatarRuntime({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const location = useLocation();
  const [bots, setBots] = useState<Bot[]>([]);
  const [states, setStates] = useState<BotAvatarState[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let botRequest = 0;
    let stateRequest = 0;
    let botInFlight = false;
    let stateInFlight = false;
    // Polls are serialized: a tick while a request is in flight is skipped.
    // Without this, latency above the interval bumps the sequence on every
    // tick and each response is discarded as stale before it can land.
    const refreshBots = async () => {
      if (botInFlight) return;
      botInFlight = true;
      const request = ++botRequest;
      try {
        const [current, archived] = await Promise.all([rpc.bots.list(), rpc.bots.listArchived()]);
        if (active && request === botRequest) setBots([...current, ...archived]);
      } catch {
        /* The existing shell owns the user-facing connection error. */
      } finally {
        botInFlight = false;
      }
    };
    const refreshStates = async () => {
      if (stateInFlight) return;
      stateInFlight = true;
      const request = ++stateRequest;
      try {
        const next = await rpc.bots.avatarStates();
        if (active && request === stateRequest) setStates(next);
      } catch {
        /* Keep the last confirmed server state until connectivity returns. */
      } finally {
        stateInFlight = false;
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshBots();
      void refreshStates();
    };
    refreshVisible();
    const stateTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshStates();
    }, 2000);
    const botTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshBots();
    }, 15000);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("workpal:avatar-refresh", refreshVisible);
    return () => {
      active = false;
      window.clearInterval(stateTimer);
      window.clearInterval(botTimer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("workpal:avatar-refresh", refreshVisible);
    };
  }, [enabled, location.pathname]);
  const match = /^\/app\/([^/]+)$/.exec(location.pathname);
  const currentBotId =
    match && !["tasks", "artifacts"].includes(match[1]!) ? decodeURIComponent(match[1]!) : null;
  return (
    <AvatarCatalogProvider bots={bots} states={states} currentBotId={currentBotId}>
      {children}
    </AvatarCatalogProvider>
  );
}
