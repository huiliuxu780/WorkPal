import { rm } from "node:fs/promises";
import path from "node:path";

// Remove recordings created by the retired Pi runtime when a product identity is deleted.
// New AgentScope Java session state is stored by the runtime service instead.
function legacyUserRoot(dataDir: string, userId: string): string {
  return path.join(path.resolve(dataDir), "pi-sessions", Buffer.from(userId).toString("base64url"));
}

export async function removeLegacyBotSessions(
  dataDir: string | undefined,
  userId: string | undefined,
  botId: string,
): Promise<void> {
  if (!dataDir) return;
  if (!userId) throw new Error("userId is required to remove legacy bot sessions");
  await rm(path.join(legacyUserRoot(dataDir, userId), Buffer.from(botId).toString("base64url")), {
    recursive: true,
    force: true,
  });
}

export async function removeLegacyUserSessions(
  dataDir: string | undefined,
  userId: string,
): Promise<void> {
  if (!dataDir) return;
  await rm(legacyUserRoot(dataDir, userId), { recursive: true, force: true });
}
