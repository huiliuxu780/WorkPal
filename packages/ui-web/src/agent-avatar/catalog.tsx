import type { AvatarCharacter, AvatarMode, BotAvatarState } from "@rakazo/contracts";
import { createContext, type ReactNode, useContext, useMemo } from "react";

export type AvatarCatalogBot = {
  id: string;
  name: string;
  avatarMode: AvatarMode;
  avatarCharacter: AvatarCharacter | null;
  avatarBodyColor?: import("@rakazo/contracts").AvatarBodyColor;
};

type AvatarCatalog = {
  bots: ReadonlyMap<string, AvatarCatalogBot>;
  states: ReadonlyMap<string, BotAvatarState>;
  currentBotId: string | null;
};

const Context = createContext<AvatarCatalog | null>(null);

export function AvatarCatalogProvider({
  bots,
  states,
  currentBotId,
  children,
}: {
  bots: readonly AvatarCatalogBot[];
  states: readonly BotAvatarState[];
  currentBotId: string | null;
  children: ReactNode;
}) {
  const value = useMemo<AvatarCatalog>(
    () => ({
      bots: new Map(bots.map((bot) => [bot.id, bot])),
      states: new Map(states.map((state) => [state.botId, state])),
      currentBotId,
    }),
    [bots, states, currentBotId],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAvatarCatalog(identity: string) {
  const catalog = useContext(Context);
  return {
    bot: catalog?.bots.get(identity),
    state: catalog?.states.get(identity),
    current: catalog?.currentBotId === identity,
  };
}
