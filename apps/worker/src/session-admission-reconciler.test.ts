import { beforeEach, describe, expect, it, vi } from "vitest";

const { recoverExpiredSessionAdmissions, listAvailableSessionAdmissionHeads } = vi.hoisted(() => ({
  recoverExpiredSessionAdmissions: vi.fn(),
  listAvailableSessionAdmissionHeads: vi.fn(),
}));

vi.mock("@rakazo/db", () => ({
  recoverExpiredSessionAdmissions,
  listAvailableSessionAdmissionHeads,
}));

import { reconcileSessionAdmissions } from "./session-admission-reconciler.js";

describe("session admission reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      scheduled: 2,
    });
    expect(enqueue.mock.calls.map(([job]) => job.payload.runId)).toEqual(["run-a", "run-b"]);
    expect(enqueue.mock.calls.flat().some((job) => job?.payload?.runId === "expired-owner")).toBe(
      false,
    );
  });
});
