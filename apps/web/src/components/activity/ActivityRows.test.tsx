import type { ActivityItem } from "@rakazo/contracts";
import { AvatarCatalogProvider } from "@rakazo/ui-web";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActivityRows } from "./ActivityRows";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));

const item: ActivityItem = {
  id: "act-1",
  botId: "bot-1",
  threadId: "th-1",
  kind: "handoff",
  status: "running",
  title: "Handoff to Rex",
  actor: { botId: "bot-1", name: "Rex" },
};

describe("ActivityRows avatars", () => {
  it("resolves the persisted avatar and live state by bot id, not display name", () => {
    const html = renderToStaticMarkup(
      <AvatarCatalogProvider
        bots={[{ id: "bot-1", name: "Rex", avatarMode: "character", avatarCharacter: "wave" }]}
        states={[{ botId: "bot-1", state: "working", runId: null, revision: 1, updatedAt: null }]}
        currentBotId={null}
      >
        <ActivityRows items={[item]} showAvatars />
      </AvatarCatalogProvider>,
    );
    // The catalog is keyed by bot id; a display-name identity misses it and
    // degrades to a name-hashed fallback character labeled "Bot · Idle".
    expect(html).toContain('data-bot-id="bot-1"');
    expect(html).toContain('data-state="working"');
    expect(html).toContain('data-character="wave"');
    expect(html).toContain('aria-label="Rex · Working"');
  });
});
