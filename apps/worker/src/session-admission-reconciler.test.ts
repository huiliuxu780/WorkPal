import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recoverExpiredSessionAdmissions,
  listAvailableSessionAdmissionHeads,
  releaseSessionAdmissionsWithTerminalOwner,
} = vi.hoisted(() => ({
  recoverExpiredSessionAdmissions: vi.fn(),
  listAvailableSessionAdmissionHeads: vi.fn(),
  releaseSessionAdmissionsWithTerminalOwner: vi.fn(),
}));

vi.mock("@rakazo/db", () => ({
  recoverExpiredSessionAdmissions,
  listAvailableSessionAdmissionHeads,
  releaseSessionAdmissionsWithTerminalOwner,
}));

import { reconcileSessionAdmissions } from "./session-admission-reconciler.js";

describe("session admission reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseSessionAdmissionsWithTerminalOwner.mockResolvedValue([]);
    recoverExpiredSessionAdmissions.mockResolvedValue([]);
    listAvailableSessionAdmissionHeads.mockResolvedValue([]);
  });

  it("parks expired owners and only wakes already-available FIFO heads", async () => {
    recoverExpiredSessionAdmissions.mockResolvedValue([
      { sessionKey: "recovering-session", runId: "expired-owner" },
    ]);
    listAvailableSessionAdmissionHeads.mockResolvedValue([
      { sessionKey: "available-a", runId: "run-a" },
      { sessionKey: "available-b", runId: "run-b" },
    ]);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(reconcileSessionAdmissions({} as never, { enqueue } as never)).resolves.toEqual({
      recovered: 1,
      released: 0,
      scheduled: 2,
    });
    expect(enqueue.mock.calls.map(([job]) => job.payload.runId)).toEqual(["run-a", "run-b"]);
    expect(enqueue.mock.calls.flat().some((job) => job?.payload?.runId === "expired-owner")).toBe(
      false,
    );
  });

  it("wakes the successor of a session freed from a terminal owner", async () => {
    releaseSessionAdmissionsWithTerminalOwner.mockResolvedValue([
      { sessionKey: "stopped-session", nextRunId: "queued-after-stop" },
      { sessionKey: "finished-session", nextRunId: null },
    ]);
    listAvailableSessionAdmissionHeads.mockResolvedValue([
      { sessionKey: "stopped-session", runId: "queued-after-stop" },
    ]);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(reconcileSessionAdmissions({} as never, { enqueue } as never)).resolves.toEqual({
      recovered: 0,
      released: 2,
      scheduled: 1,
    });
    // The same successor is reachable from both the release and the head scan;
    // it must be enqueued exactly once.
    expect(enqueue.mock.calls.map(([job]) => job.payload.runId)).toEqual(["queued-after-stop"]);
  });

  it("releases terminal owners before parking anything on expiry", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await reconcileSessionAdmissions({} as never, { enqueue } as never);
    expect(releaseSessionAdmissionsWithTerminalOwner).toHaveBeenCalledBefore(
      recoverExpiredSessionAdmissions,
    );
    expect(recoverExpiredSessionAdmissions).toHaveBeenCalledBefore(
      listAvailableSessionAdmissionHeads,
    );
  });
});
