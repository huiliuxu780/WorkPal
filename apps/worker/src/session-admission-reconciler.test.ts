import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recoverExpiredSessionAdmissions,
  listAvailableSessionAdmissionHeads,
  releaseCancelledSessionsThatNeverStarted,
  listCancelledSessionsToRecover,
} = vi.hoisted(() => ({
  recoverExpiredSessionAdmissions: vi.fn(),
  listAvailableSessionAdmissionHeads: vi.fn(),
  releaseCancelledSessionsThatNeverStarted: vi.fn(),
  listCancelledSessionsToRecover: vi.fn(),
}));

vi.mock("@rakazo/db", () => ({
  recoverExpiredSessionAdmissions,
  listAvailableSessionAdmissionHeads,
  releaseCancelledSessionsThatNeverStarted,
  listCancelledSessionsToRecover,
}));

import { reconcileSessionAdmissions } from "./session-admission-reconciler.js";

describe("session admission reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseCancelledSessionsThatNeverStarted.mockResolvedValue([]);
    listCancelledSessionsToRecover.mockResolvedValue([]);
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

  it("re-dispatches a cancelled owner whose runtime started instead of releasing it", async () => {
    listCancelledSessionsToRecover.mockResolvedValue([
      { sessionKey: "started-and-aborted", runId: "cancelled-owner" },
    ]);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(reconcileSessionAdmissions({} as never, { enqueue } as never)).resolves.toEqual({
      recovered: 0,
      released: 0,
      recoveryDispatched: 1,
      scheduled: 0,
    });
    // The owner Run is re-driven so the RT-26 hook can obtain the proof; the
    // reconciler itself must not release the session.
    expect(enqueue.mock.calls.map(([job]) => job.payload.runId)).toEqual(["cancelled-owner"]);
  });

  it("classifies before parking and scanning heads", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await reconcileSessionAdmissions({} as never, { enqueue } as never);
    expect(releaseCancelledSessionsThatNeverStarted).toHaveBeenCalledBefore(
      recoverExpiredSessionAdmissions,
    );
    expect(listCancelledSessionsToRecover).toHaveBeenCalledBefore(recoverExpiredSessionAdmissions);
    expect(recoverExpiredSessionAdmissions).toHaveBeenCalledBefore(
      listAvailableSessionAdmissionHeads,
    );
  });
});
