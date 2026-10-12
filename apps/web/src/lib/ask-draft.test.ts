import { describe, expect, it, vi } from "vitest";
import { askDraftKey, readAskDraft, writeAskDraft } from "./ask-draft";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() { return values.size; },
  };
}

describe("ask draft storage", () => {
  it("scopes an ordinary draft to its Run and message and clears on empty", () => {
    const session = storage();
    const key = askDraftKey("run-1", "message-1");
    writeAskDraft(session, key, "unfinished answer", false);
    expect(readAskDraft(session, key, false)).toBe("unfinished answer");
    expect(readAskDraft(session, askDraftKey("run-2", "message-1"), false)).toBe("");
    writeAskDraft(session, key, "", false);
    expect(readAskDraft(session, key, false)).toBe("");
  });

  it("never reads or writes a secret answer", () => {
    const session = storage();
    const key = askDraftKey("run-1", "secret-message");
    writeAskDraft(session, key, "private key", true);
    expect(readAskDraft(session, key, true)).toBe("");
    expect(session.setItem).not.toHaveBeenCalled();
    expect(session.getItem).not.toHaveBeenCalled();
  });
});
