import { describe, expect, it } from "vitest";

import {
  SLASH_ACTIONS,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "./composer-slash.js";

describe("serializeComposerPrompt", () => {
  it("returns draft when no skill or mentions", () => {
    expect(serializeComposerPrompt("  hello", null, [])).toBe("hello");
  });

  it("prefixes skill slash name alone", () => {
    expect(serializeComposerPrompt("", { name: "Daily standup" }, [])).toBe("/Daily standup");
  });

  it("keeps inline mentions in place after a skill", () => {
    expect(
      serializeComposerPrompt("@Research Writer check blockers", { name: "Daily standup" }, [
        { name: "Research Writer" },
      ]),
    ).toBe("/Daily standup\n@Research Writer check blockers");
  });

  it("does not move mentions ahead of the draft", () => {
    expect(serializeComposerPrompt("do X, @Beta do Y", null, [{ name: "Beta" }])).toBe(
      "do X, @Beta do Y",
    );
  });
});

describe("truncateSlashDescription", () => {
  it("leaves short text alone", () => {
    expect(truncateSlashDescription("short")).toBe("short");
  });

  it("truncates long text with an ellipsis", () => {
    const long = "a".repeat(80);
    expect(truncateSlashDescription(long, 20)).toBe(`${"a".repeat(19)}…`);
  });
});

describe("SLASH_ACTIONS", () => {
  it("exposes chat and account destinations", () => {
    expect(SLASH_ACTIONS.map((action) => action.id)).toEqual([
      "chat-settings",
      "settings-general",
      "settings-usage",
    ]);
  });
});
