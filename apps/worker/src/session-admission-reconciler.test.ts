import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recoverExpiredSessionAdmissions,
  listAvailableSessionAdmissionHeads,
  releaseCancelledSessionsThatNeverStarted,
  listTerminalSessionsToRecover,
} = vi.hoisted(() => ({
  recoverExpiredSessionAdmissions: vi.fn(),
  listAvailableSessionAdmissionHeads: vi.fn(),
  releaseCancelledSessionsThatNeverStarted: vi.fn(),
  listTerminalSessionsToRecover: vi.fn(),
}));

vi.mock("@rakazo/db", () => ({
  recoverExpiredSessionAdmissions,
  listAvailableSessionAdmissionHeads,
  releaseCancelledSessionsThatNeverStarted,
  listTerminalSessionsToRecover,
}));

import { reconcileSessionAdmissions } from "./session-admission-reconciler.js";

describe("session admission reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseCancelledSessionsThatNeverStarted.mockResolvedValue([]);
    listTerminalSessionsToRecover.mockResolvedValue([]);
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
      recoveryDispatched: 0,
      scheduled: 2,
    });
    expect(enqueue.mock.calls.map(([job]) => job.payload.runId)).toEqual(["run-a", "run-b"]);
    expect(enqueue.mock.calls.flat().some((job) => job?.payload?.runId === "expired-owner")).toBe(
      false,
    );
  });

  it("frees a session the runtime never entered and wakes its successor", async () => {
    releaseCancelledSessionsThatNeverStarted.mockResolvedValue([
      { sessionKey: "never-started", nextRunId: "queued-after-stop" },
      { sessionKey: "never-started-idle", nextRunId: null },
    ]);
    listAvailableSessionAdmissionHeads.mockResolvedValue([
      { sessionKey: "never-started", runId: "queued-after-stop" },
    ]);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(reconcileSessionAdmissions({} as never, { enqueue } as never)).resolves.toEqual({
      recovered: 0,
      released: 2,
      recoveryDispatched: 0,
      scheduled: 1,
    });
    // The same successor is reachable from both the release and the head scan;
    // it must be enqueued exactly once.
    expect(enqueue.mock.calls.map(([job]) => job.payload.runId)).toEqual(["queued-after-stop"]);
  });

  it("re-dispatches terminal owners whose runtime session still needs proof", async () => {
    listTerminalSessionsToRecover.mockResolvedValue([
      { sessionKey: "started-and-aborted", runId: "cancelled-owner" },
      { sessionKey: "failed-unproven", runId: "failed-owner" },
    ]);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(reconcileSessionAdmissions({} as never, { enqueue } as never)).resolves.toEqual({
      recovered: 0,
      released: 0,
      recoveryDispatched: 2,
      scheduled: 0,
    });
    // The owner Run is re-driven so the RT-26 hook can obtain the proof; the
    // reconciler itself must not release the session.
    expect(enqueue.mock.calls.map(([job]) => job.payload.runId)).toEqual([
      "cancelled-owner",
      "failed-owner",
    ]);
  });

  it("classifies before parking and scanning heads", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await reconcileSessionAdmissions({} as never, { enqueue } as never);
    expect(releaseCancelledSessionsThatNeverStarted).toHaveBeenCalledBefore(
      recoverExpiredSessionAdmissions,
    );
    expect(listTerminalSessionsToRecover).toHaveBeenCalledBefore(recoverExpiredSessionAdmissions);
    expect(recoverExpiredSessionAdmissions).toHaveBeenCalledBefore(
      listAvailableSessionAdmissionHeads,
    );
  });
});
