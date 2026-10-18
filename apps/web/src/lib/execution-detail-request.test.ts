import { describe, expect, it } from "vitest";
import {
  beginDetailRequest,
  clearDetailRequest,
  detailRequestStatus,
  failDetailRequest,
  settleDetailRequest,
} from "./execution-detail-request";

/**
 * UX-01C acceptance 14 + review round P3: per-Run detail request state,
 * kept OUTSIDE the rev-versioned `ExecutionDetailCache` — an error is a
 * request fact, never a snapshot version. Every entry is stamped with the
 * summary revision it was requested against: a state whose rev no longer
 * matches the current projection reads as idle (a moved rev invalidates the
 * old error), and a late failure from a superseded request never rewrites
 * newer state.
 */
describe("execution detail request state", () => {
  it("defaults to idle and tracks per-Run transitions at one revision", () => {
    let map = {};
    expect(detailRequestStatus(map, "run-1", 5)).toBe("idle");
    map = beginDetailRequest(map, "run-1", 5);
    expect(detailRequestStatus(map, "run-1", 5)).toBe("loading");
    expect(detailRequestStatus(map, "run-2", 5)).toBe("idle");
    map = failDetailRequest(map, "run-1", 5);
    expect(detailRequestStatus(map, "run-1", 5)).toBe("error");
    map = beginDetailRequest(map, "run-1", 5);
    expect(detailRequestStatus(map, "run-1", 5)).toBe("loading");
    map = settleDetailRequest(map, "run-1", 5);
    expect(detailRequestStatus(map, "run-1", 5)).toBe("idle");
  });

  it("clears a previous error on success", () => {
    let map = failDetailRequest({}, "run-1", 5);
    map = beginDetailRequest(map, "run-1", 5);
    map = settleDetailRequest(map, "run-1", 5);
    expect(detailRequestStatus(map, "run-1", 5)).toBe("idle");
  });

  it("keeps other Runs untouched", () => {
    let map = failDetailRequest({}, "run-1", 5);
    map = beginDetailRequest(map, "run-2", 5);
    expect(detailRequestStatus(map, "run-1", 5)).toBe("error");
    expect(detailRequestStatus(map, "run-2", 5)).toBe("loading");
  });

  it("drops a single Run's state without touching the rest", () => {
    let map = failDetailRequest({}, "run-1", 5);
    map = failDetailRequest(map, "run-2", 5);
    map = clearDetailRequest(map, "run-1");
    expect(detailRequestStatus(map, "run-1", 5)).toBe("idle");
    expect(detailRequestStatus(map, "run-2", 5)).toBe("error");
  });

  it("is immutable per transition (callers can rely on identity checks)", () => {
    const map = {};
    expect(beginDetailRequest(map, "run-1", 5)).not.toBe(map);
    const loading = beginDetailRequest(map, "run-1", 5);
    expect(settleDetailRequest(loading, "run-2", 5)).toBe(loading);
    // A repeat begin at the same rev is a no-op; a stale fail is ignored.
    expect(beginDetailRequest(loading, "run-1", 5)).toBe(loading);
    expect(failDetailRequest(loading, "run-1", 4)).toBe(loading);
  });

  it("invalidates an old error when the summary revision moved on (P3 regression 1)", () => {
    let map = beginDetailRequest({}, "run-1", 5);
    map = failDetailRequest(map, "run-1", 5);
    expect(detailRequestStatus(map, "run-1", 5)).toBe("error");
    // The thread projection advanced: the rev-5 error describes a request
    // against a projection that no longer exists — it must read as idle.
    expect(detailRequestStatus(map, "run-1", 6)).toBe("idle");
    // And a fresh request at the new rev starts clean.
    map = beginDetailRequest(map, "run-1", 6);
    expect(detailRequestStatus(map, "run-1", 6)).toBe("loading");
  });

  it("a stale success never clears the newer revision's error (review round 2)", () => {
    // A@5 in flight → rev moves → B@6 in flight → B fails (error@6 shown) →
    // A's late SUCCESS must not delete the state it does not own.
    let map = beginDetailRequest({}, "run-1", 5);
    map = beginDetailRequest(map, "run-1", 6);
    map = failDetailRequest(map, "run-1", 6);
    expect(detailRequestStatus(map, "run-1", 6)).toBe("error");
    const afterStaleSuccess = settleDetailRequest(map, "run-1", 5);
    expect(afterStaleSuccess).toBe(map);
    expect(detailRequestStatus(afterStaleSuccess, "run-1", 6)).toBe("error");
  });

  it("a stale success never clears the newer request's loading state (review round 2)", () => {
    let map = beginDetailRequest({}, "run-1", 5);
    map = beginDetailRequest(map, "run-1", 6);
    const afterStaleSuccess = settleDetailRequest(map, "run-1", 5);
    expect(afterStaleSuccess).toBe(map);
    expect(detailRequestStatus(afterStaleSuccess, "run-1", 6)).toBe("loading");
    // The owning request still settles its own state.
    expect(detailRequestStatus(settleDetailRequest(map, "run-1", 6), "run-1", 6)).toBe("idle");
  });

  it("a late failure from a superseded request never rewrites newer state (P3 regression 2)", () => {
    // Request A starts at rev 5; the projection moves and request B starts
    // at rev 6 while A is still in flight.
    let map = beginDetailRequest({}, "run-1", 5);
    map = beginDetailRequest(map, "run-1", 6);
    expect(detailRequestStatus(map, "run-1", 6)).toBe("loading");
    // A's late failure arrives: it must NOT replace the rev-6 loading state.
    map = failDetailRequest(map, "run-1", 5);
    expect(detailRequestStatus(map, "run-1", 6)).toBe("loading");
    // A genuine rev-6 failure still surfaces.
    map = failDetailRequest(map, "run-1", 6);
    expect(detailRequestStatus(map, "run-1", 6)).toBe("error");
  });
});
