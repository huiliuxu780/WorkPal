import { describe, expect, it } from "vitest";
import {
  clearExecutionNavIntent,
  peekExecutionNavIntent,
  setExecutionNavIntent,
} from "./execution-nav";

describe("execution nav intent", () => {
  it("hands an intent through module memory until cleared", () => {
    clearExecutionNavIntent();
    expect(peekExecutionNavIntent()).toBeNull();
    const intent = { threadId: "t-1", runId: "run-1", rev: 3, attention: true };
    setExecutionNavIntent(intent);
    expect(peekExecutionNavIntent()).toEqual(intent);
    clearExecutionNavIntent();
    expect(peekExecutionNavIntent()).toBeNull();
  });
});
