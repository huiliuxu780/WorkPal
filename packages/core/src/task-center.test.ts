import type { RunStatus } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  compareTaskCenterRuns,
  decodeTaskCenterCursor,
  encodeTaskCenterCursor,
  type TaskCenterCursor,
  type TaskCenterSortFacts,
  taskCenterAfterPosition,
  taskCenterPriority,
} from "./task-center.js";

const facts = (runId: string, status: RunStatus, sortTimeMs: number): TaskCenterSortFacts => ({
  runId,
  status,
  sortTimeMs,
});

describe("taskCenterPriority", () => {
  it("groups waiting first, then running/leased, queued, failed, completed, cancelled", () => {
    expect(taskCenterPriority("waiting_input")).toBe(1);
    expect(taskCenterPriority("waiting_takeover")).toBe(1);
    expect(taskCenterPriority("running")).toBe(2);
    expect(taskCenterPriority("leased")).toBe(2);
    expect(taskCenterPriority("queued")).toBe(3);
    expect(taskCenterPriority("failed")).toBe(4);
    expect(taskCenterPriority("completed")).toBe(5);
    expect(taskCenterPriority("cancelled")).toBe(6);
  });
});

describe("compareTaskCenterRuns", () => {
  it("lets the group beat recency", () => {
    const waiting = facts("run-w", "waiting_input", 1_000);
    const running = facts("run-r", "running", 9_000);
    expect(compareTaskCenterRuns(waiting, running)).toBeLessThan(0);
    expect(compareTaskCenterRuns(running, waiting)).toBeGreaterThan(0);
  });

  it("orders terminal buckets failed < completed < cancelled regardless of time", () => {
    const failed = facts("run-f", "failed", 1_000);
    const completed = facts("run-c", "completed", 9_000);
    const cancelled = facts("run-x", "cancelled", 99_000);
    const sorted = [cancelled, completed, failed].sort(compareTaskCenterRuns);
    expect(sorted.map((item) => item.runId)).toEqual(["run-f", "run-c", "run-x"]);
  });

  it("sorts within a group by updatedAt descending", () => {
    const older = facts("run-a", "running", 1_000);
    const newer = facts("run-b", "running", 2_000);
    expect(compareTaskCenterRuns(older, newer)).toBeGreaterThan(0);
  });

  it("uses runId as a stable, direction-consistent tie breaker", () => {
    const a = facts("run-a", "queued", 5_000);
    const b = facts("run-b", "queued", 5_000);
    expect(compareTaskCenterRuns(a, b)).toBeGreaterThan(0); // "run-b" first (id desc)
    expect(compareTaskCenterRuns(b, a)).toBeLessThan(0);
    expect(compareTaskCenterRuns(a, a)).toBe(0);
    const order1 = [a, b].sort(compareTaskCenterRuns).map((item) => item.runId);
    const order2 = [b, a].sort(compareTaskCenterRuns).map((item) => item.runId);
    expect(order1).toEqual(order2);
  });
});

describe("task center cursor", () => {
  const cursor: TaskCenterCursor = { v: 1, sp: "space-1", us: "user-1", p: 5, t: 123, r: "run-9" };

  it("round-trips through the opaque encoding", () => {
    expect(decodeTaskCenterCursor(encodeTaskCenterCursor(cursor))).toEqual(cursor);
  });

  it("is opaque base64url without padding", () => {
    const encoded = encodeTaskCenterCursor(cursor);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded.length).toBeGreaterThanOrEqual(16);
  });

  it("strictly rejects foreign shapes, key sets and versions", () => {
    expect(decodeTaskCenterCursor(undefined)).toBeNull();
    expect(decodeTaskCenterCursor("")).toBeNull();
    expect(decodeTaskCenterCursor("not-base64!!")).toBeNull();
    expect(decodeTaskCenterCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(decodeTaskCenterCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
    // A future layout version is rejected, never reinterpreted.
    expect(
      decodeTaskCenterCursor(
        Buffer.from(JSON.stringify({ ...cursor, v: 2 })).toString("base64url"),
      ),
    ).toBeNull();
    // Extra or missing keys are rejected.
    expect(
      decodeTaskCenterCursor(
        Buffer.from(JSON.stringify({ ...cursor, extra: 1 })).toString("base64url"),
      ),
    ).toBeNull();
    const { r: _r, ...missing } = cursor;
    expect(
      decodeTaskCenterCursor(Buffer.from(JSON.stringify(missing)).toString("base64url")),
    ).toBeNull();
    // Non-integer / negative positions are rejected.
    expect(
      decodeTaskCenterCursor(
        Buffer.from(JSON.stringify({ ...cursor, t: -1 })).toString("base64url"),
      ),
    ).toBeNull();
    expect(
      decodeTaskCenterCursor(
        Buffer.from(JSON.stringify({ ...cursor, p: 1.5 })).toString("base64url"),
      ),
    ).toBeNull();
    // Empty actor bindings are rejected.
    expect(
      decodeTaskCenterCursor(
        Buffer.from(JSON.stringify({ ...cursor, sp: "" })).toString("base64url"),
      ),
    ).toBeNull();
  });
});

describe("taskCenterAfterPosition", () => {
  const cursor = { p: 5, t: 2_000, r: "run-m" };

  it("accepts later groups and later positions within the group", () => {
    expect(taskCenterAfterPosition(facts("run-x", "cancelled", 9_999), cursor)).toBe(true);
    expect(taskCenterAfterPosition(facts("run-a", "completed", 1_999), cursor)).toBe(true);
    expect(taskCenterAfterPosition(facts("run-a", "completed", 2_000), cursor)).toBe(true); // id < run-m
  });

  it("rejects earlier groups and earlier positions within the group", () => {
    expect(taskCenterAfterPosition(facts("run-z", "running", 0), cursor)).toBe(false);
    expect(taskCenterAfterPosition(facts("run-z", "completed", 2_001), cursor)).toBe(false);
    expect(taskCenterAfterPosition(facts("run-z", "completed", 2_000), cursor)).toBe(false); // id > run-m
    expect(taskCenterAfterPosition(facts("run-m", "completed", 2_000), cursor)).toBe(false); // the cursor item itself
  });
});
