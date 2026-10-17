import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AvatarCatalogProvider } from "./agent-avatar/catalog.js";
import { BotAvatar, parseBotAvatar } from "./bot-avatar.js";

describe("BotAvatar compatibility entrypoint", () => {
  it("uses persisted character and state while uploaded images retain their bytes", () => {
    const html = renderToString(
      <AvatarCatalogProvider
        bots={[
          { id: "bot-a", name: "Maya", avatarMode: "character", avatarCharacter: "wave" },
          { id: "bot-b", name: "Image Bot", avatarMode: "upload", avatarCharacter: null },
        ]}
        states={[
          {
            botId: "bot-a",
            state: "approval",
            runId: "run-a",
            revision: 2,
            updatedAt: "2026-10-17T00:00:00Z",
          },
        ]}
        currentBotId="bot-a"
      >
        <BotAvatar color="#8B5CF6" identity="bot-a" size={28} status="idle" />
        <BotAvatar color="data:image/png;base64,abc" identity="bot-b" size={32} />
      </AvatarCatalogProvider>,
    );
    expect(html).toContain('data-character="wave"');
    expect(html).toContain('data-state="approval"');
    expect(html).toContain('data-size="32"');
    expect(html).toContain('aria-label="Maya · Needs approval"');
    expect(html).toContain('src="data:image/png;base64,abc"');
  });

  it("shows the server-owned state for uploaded avatars without a nested keyboard stop", () => {
    const html = renderToString(
      <AvatarCatalogProvider
        bots={[{ id: "uploaded", name: "Image Bot", avatarMode: "upload", avatarCharacter: null }]}
        states={[
          { botId: "uploaded", state: "approval", runId: "run-1", revision: 1, updatedAt: null },
        ]}
        currentBotId={null}
      >
        <button type="button">
          <BotAvatar color="data:image/png;base64,abc" identity="uploaded" size={24} />
          Image Bot
        </button>
      </AvatarCatalogProvider>,
    );
    expect(html).toContain('data-state="approval"');
    expect(html).toContain('aria-label="Image Bot · Needs approval"');
    expect(html).toContain('class="rakazo-agent-avatar-dot"');
    // Upload badges carry the same non-color shape cue as compact characters
    // (AV-00 acceptance addendum): approval = diamond.
    expect(html).toContain('data-point-shape="diamond"');
    expect(html).not.toContain('tabIndex="0"');
    expect(html).not.toContain('tabindex="0"');
  });

  it("keeps character avatars non-focusable when embedded in an existing button", () => {
    const html = renderToString(
      <button type="button">
        <BotAvatar color="#8B5CF6" identity="bot-a" size={24} />
        Bot A
      </button>,
    );
    expect(html).not.toContain('tabIndex="0"');
    expect(html).not.toContain('tabindex="0"');
  });

  it("uses a stable character when catalog data has not loaded", () => {
    const one = renderToString(<BotAvatar color="#8B5CF6" identity="bot-a" size={14} />);
    const two = renderToString(<BotAvatar color="#8B5CF6" identity="bot-a" size={14} />);
    expect(one).toBe(two);
    expect(one).toContain('data-size="16"');
    expect(one).toContain('data-state="idle"');
  });

  it("lets explicit character mode override a retained upload color", () => {
    const html = renderToString(
      <AvatarCatalogProvider
        bots={[{ id: "bot", name: "Maya", avatarMode: "character", avatarCharacter: "dot" }]}
        states={[]}
        currentBotId={null}
      >
        <BotAvatar color="data:image/png;base64,abc" identity="bot" size={24} />
      </AvatarCatalogProvider>,
    );
    expect(html).toContain('data-character="dot"');
    expect(html).not.toContain("<img");
  });

  it("never puts remote URLs into an img source", () => {
    expect(parseBotAvatar("https://evil.example/track.png").isImage).toBe(false);
    expect(
      renderToString(<BotAvatar color="https://evil.example/track.png" identity="bot" />),
    ).not.toContain("<img");
  });

  it.each([
    [16, 16],
    [20, 24],
    [28, 32],
    [36, 32],
    [148, 64],
  ])("normalizes %ipx to %ipx", (input, expected) => {
    expect(renderToString(<BotAvatar color="#fff" identity="bot" size={input} />)).toContain(
      `data-size="${expected}"`,
    );
  });
});
