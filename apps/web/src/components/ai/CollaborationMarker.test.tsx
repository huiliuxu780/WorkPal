import { AvatarCatalogProvider } from "@rakazo/ui-web";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveBotGlyph, CollaborationMarker } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a left-aligned peer event with its avatar and full label", () => {
    const html = renderToString(
      <CollaborationMarker
        ariaLabel="Message from Research"
        color="#14B8A6"
        identity="research"
        label="Message from Research"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain('class="flex justify-start"');
    expect(html).toContain('class="inline-flex max-w-full');
    expect(html).toContain('class="truncate"');
    // BotAvatar delegates to the durable AgentAvatar surface.
    expect(html).toContain("rakazo-agent-avatar");
    expect(html).toContain('data-bot-id="research"');
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
  });

  it("renders the active bot glyph from the server-owned avatar state", () => {
    const html = renderToString(
      <AvatarCatalogProvider
        bots={[{ id: "research", name: "Research", avatarMode: "character", avatarCharacter: "dot" }]}
        states={[
          { botId: "research", state: "working", runId: null, revision: 1, updatedAt: null },
        ]}
        currentBotId={null}
      >
        <ActiveBotGlyph
          bots={[{ botId: "research", color: "#14B8A6", status: "running" }]}
          label="Research is working"
        />
      </AvatarCatalogProvider>,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("rakazo-group-avatar");
    expect(html).toContain('data-state="working"');
  });
});
